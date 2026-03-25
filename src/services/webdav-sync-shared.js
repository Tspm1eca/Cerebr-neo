import { computeChatHash } from '../utils/chat-hash.js';
import { t } from '../utils/i18n.js';

export const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    MULTI_STATUS: 207,
    MOVED_PERMANENTLY: 301,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    CONFLICT: 409,
    FAILED_DEPENDENCY: 424,
    NOT_IMPLEMENTED: 501
};

export const DEFAULT_TIMEOUT = 30000;
export const CHAT_DIRECTORY = 'chats';
export const UPLOAD_CONCURRENCY = 5;
export const DEFAULT_METADATA_SYNC_STATE = Object.freeze({
    quickChatOptions: Object.freeze({
        baseHash: null,
        lastSyncedAt: null,
        modifiedAt: null
    }),
    apiSettings: Object.freeze({
        baseHash: null,
        lastSyncedAt: null,
        modifiedAt: null
    })
});

const DIRTY_CHAT_IDS_KEY = 'cerebr_dirty_chat_ids';
const CHAT_INDEX_KEY = 'cerebr_chat_index';
const CHAT_KEY_PREFIX = 'cerebr_chat_';
const WEBDAV_DELETED_CHAT_IDS_KEY = 'webdav_deleted_chat_ids';
const WEBDAV_CACHED_MANIFEST_KEY = 'webdav_cached_manifest';
const WEBDAV_LOCAL_CHAT_HASHES_KEY = 'webdav_local_chat_hashes';
const WEBDAV_LOCAL_DATA_DIRTY_KEY = 'webdav_local_data_dirty';
const WEBDAV_KNOWN_DIRS_KEY = 'webdav_known_directories';
const WEBDAV_METADATA_SYNC_STATE_KEY = 'webdav_metadata_sync_state';
const WEBDAV_REMOTE_ETAG_KEY = 'webdav_remote_etag';
const WEBDAV_LOCAL_HASH_KEY = 'webdav_local_hash';
const WEBDAV_LAST_SYNC_KEY = 'webdav_last_sync';
const WEBDAV_LAST_SYNC_TIMESTAMP_KEY = 'webdav_last_sync_timestamp';
export const WEBDAV_SYNC_LOCK_NAME = 'webdav_sync_lock';
export const WEBDAV_SYNC_ERROR_CODE_BUSY = 'WEBDAV_SYNC_BUSY';

const DEFAULT_CLIENT_CONFIG = {
    serverUrl: '',
    username: '',
    password: '',
    syncPath: '/Cerebr-neo'
};

function createWebDAVSyncError(message, { code = null } = {}) {
    const error = new Error(message);
    if (code) {
        error.code = code;
    }
    return error;
}

export async function acquireWebDAVSyncLock() {
    const locksApi = globalThis.navigator?.locks;
    if (!locksApi?.request) {
        throw new Error('Web Locks API is unavailable');
    }

    return new Promise((resolve, reject) => {
        locksApi.request(
            WEBDAV_SYNC_LOCK_NAME,
            { mode: 'exclusive', ifAvailable: true },
            (lock) => {
                if (!lock) {
                    resolve(null);
                    return;
                }

                return new Promise((unlock) => {
                    let released = false;
                    resolve({
                        async release() {
                            if (released) {
                                return;
                            }
                            released = true;
                            unlock();
                        }
                    });
                });
            }
        ).catch(reject);
    });
}

export function createWebDAVSyncBusyError(message = t('webdav.syncInProgress')) {
    return createWebDAVSyncError(message, { code: WEBDAV_SYNC_ERROR_CODE_BUSY });
}

export function isWebDAVSyncBusyError(error) {
    return error?.code === WEBDAV_SYNC_ERROR_CODE_BUSY;
}

export async function releaseWebDAVSyncLock(lockHandle, logLabel = '[WebDAV]') {
    if (!lockHandle?.release) {
        return;
    }

    try {
        await lockHandle.release();
    } catch (error) {
        console.warn(`${logLabel} 釋放同步鎖失敗:`, error);
    }
}

export async function withWebDAVSyncLock(task, { onBusy = null, logLabel = '[WebDAV]' } = {}) {
    const lockHandle = await acquireWebDAVSyncLock();
    if (!lockHandle) {
        if (typeof onBusy === 'function') {
            return await onBusy();
        }
        throw createWebDAVSyncBusyError();
    }

    try {
        return await task(lockHandle);
    } finally {
        await releaseWebDAVSyncLock(lockHandle, logLabel);
    }
}

async function runWorkerQueue(tasks, concurrency) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < tasks.length) {
            const currentIndex = index++;
            results[currentIndex] = await tasks[currentIndex]();
        }
    }

    const workers = Array.from(
        { length: Math.min(concurrency, tasks.length) },
        () => worker()
    );
    await Promise.all(workers);
    return results;
}

function upsertChatIndexEntry(chatIndex, entry) {
    if (!entry?.id) return;
    const clonedEntry = { ...entry };
    const existingIndex = chatIndex.findIndex((item) => item.id === clonedEntry.id);
    if (existingIndex >= 0) {
        chatIndex[existingIndex] = clonedEntry;
    } else {
        chatIndex.push(clonedEntry);
    }
}

function compareChatIndexEntries(left, right) {
    const leftCreatedMs = Date.parse(left?.createdAt || '');
    const rightCreatedMs = Date.parse(right?.createdAt || '');
    const leftHasCreatedAt = Number.isFinite(leftCreatedMs);
    const rightHasCreatedAt = Number.isFinite(rightCreatedMs);

    if (leftHasCreatedAt && rightHasCreatedAt && leftCreatedMs !== rightCreatedMs) {
        return leftCreatedMs - rightCreatedMs;
    }
    if (leftHasCreatedAt !== rightHasCreatedAt) {
        return leftHasCreatedAt ? -1 : 1;
    }

    return String(left?.id || '').localeCompare(String(right?.id || ''));
}

export function sortChatIndexEntries(chatIndex) {
    return (Array.isArray(chatIndex) ? [...chatIndex] : [])
        .filter(entry => entry?.id)
        .sort(compareChatIndexEntries);
}

export function stripWebDAVMetadata(chat) {
    if (!chat) return chat;
    const sanitizedChat = { ...chat };
    delete sanitizedChat._remoteOnly;
    delete sanitizedChat._webdavHydrated;
    delete sanitizedChat._webdavHash;
    delete sanitizedChat._webdavMessageCount;
    return sanitizedChat;
}

export async function runWithConcurrency(tasks, concurrency) {
    return runWorkerQueue(tasks, concurrency);
}

function normalizeTimestampToIso(value) {
    const parsed = normalizeTimestampToMs(value);
    if (parsed === null) return null;
    try {
        return new Date(parsed).toISOString();
    } catch {
        return null;
    }
}

function normalizeTimestampToMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (value instanceof Date) {
        const parsed = value.getTime();
        return Number.isFinite(parsed) ? parsed : null;
    }
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCompactTimestampToIso(value) {
    if (typeof value !== 'string' || !/^[0-9a-z]{6,}$/i.test(value)) {
        return null;
    }
    const parsed = Number.parseInt(value, 36);
    if (!Number.isFinite(parsed)) {
        return null;
    }
    try {
        return new Date(parsed).toISOString();
    } catch {
        return null;
    }
}

function normalizeDeletedAtToIso(value) {
    return normalizeTimestampToIso(value) || normalizeCompactTimestampToIso(value);
}

function serializeDeletedAtToCompact(value) {
    const parsed = normalizeTimestampToMs(value);
    return parsed !== null ? parsed.toString(36) : null;
}

function parseCompactTombstoneRecord(tombstone) {
    if (typeof tombstone !== 'string') return null;

    const separatorIndex = tombstone.lastIndexOf('|');
    if (separatorIndex <= 0 || separatorIndex >= (tombstone.length - 1)) {
        return null;
    }

    const id = tombstone.slice(0, separatorIndex);
    const deletedAt = normalizeCompactTimestampToIso(tombstone.slice(separatorIndex + 1));
    if (!id || !deletedAt) {
        return null;
    }

    return { id, deletedAt };
}

function normalizeTombstoneRecord(tombstone) {
    if (typeof tombstone === 'string') {
        return parseCompactTombstoneRecord(tombstone);
    }
    if (!tombstone?.id) return null;

    const deletedAt = normalizeDeletedAtToIso(tombstone.deletedAt);
    if (!deletedAt) return null;

    return {
        id: tombstone.id,
        deletedAt
    };
}

export function mergeTombstoneRecords(left, right) {
    if (!left) return right ? { ...right } : null;
    if (!right) return left ? { ...left } : null;

    const leftDeletedMs = Date.parse(left.deletedAt || '');
    const rightDeletedMs = Date.parse(right.deletedAt || '');
    if (Number.isFinite(leftDeletedMs) && Number.isFinite(rightDeletedMs)) {
        if (rightDeletedMs > leftDeletedMs) {
            return { ...right };
        }
        if (rightDeletedMs < leftDeletedMs) {
            return { ...left };
        }
    }

    return {
        id: right.id || left.id,
        deletedAt: right.deletedAt || left.deletedAt
    };
}

export function cleanTombstones(tombstones, maxAgeMs) {
    const cutoff = Number.isFinite(maxAgeMs)
        ? (Date.now() - maxAgeMs)
        : Number.NEGATIVE_INFINITY;
    const deduped = new Map();

    for (const rawTombstone of (Array.isArray(tombstones) ? tombstones : [])) {
        const normalized = normalizeTombstoneRecord(rawTombstone);
        if (!normalized) continue;

        const deletedAtMs = Date.parse(normalized.deletedAt);
        if (!Number.isFinite(deletedAtMs) || deletedAtMs <= cutoff) {
            continue;
        }

        const existing = deduped.get(normalized.id);
        deduped.set(normalized.id, mergeTombstoneRecords(existing, normalized));
    }

    return [...deduped.values()].sort((left, right) => {
        const leftMs = Date.parse(left.deletedAt || '');
        const rightMs = Date.parse(right.deletedAt || '');
        if (leftMs !== rightMs) {
            return leftMs - rightMs;
        }
        return String(left.id).localeCompare(String(right.id));
    });
}

function serializeTombstoneRecord(tombstone) {
    const normalized = normalizeTombstoneRecord(tombstone);
    if (!normalized) return null;

    const compactDeletedAt = serializeDeletedAtToCompact(normalized.deletedAt);
    if (!compactDeletedAt) return null;

    return `${normalized.id}|${compactDeletedAt}`;
}

function serializeTombstones(tombstones) {
    return cleanTombstones(tombstones, Number.POSITIVE_INFINITY)
        .map((tombstone) => serializeTombstoneRecord(tombstone))
        .filter(Boolean);
}

export function createDefaultMetadataSyncState() {
    return {
        quickChatOptions: { ...DEFAULT_METADATA_SYNC_STATE.quickChatOptions },
        apiSettings: { ...DEFAULT_METADATA_SYNC_STATE.apiSettings }
    };
}

export function normalizeMetadataSyncState(rawState) {
    const nextState = createDefaultMetadataSyncState();
    if (rawState?.quickChatOptions && typeof rawState.quickChatOptions === 'object') {
        nextState.quickChatOptions = {
            ...nextState.quickChatOptions,
            ...rawState.quickChatOptions
        };
    }
    if (rawState?.apiSettings && typeof rawState.apiSettings === 'object') {
        nextState.apiSettings = {
            ...nextState.apiSettings,
            ...rawState.apiSettings
        };
    }
    return nextState;
}

export function computeStructuredHash(value) {
    const hashSource = JSON.stringify(value === undefined ? null : value);
    let hash = 5381;
    for (let i = 0; i < hashSource.length; i++) {
        hash = ((hash << 5) + hash) + hashSource.charCodeAt(i);
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
}

export function normalizeApiSettings(raw = {}) {
    return {
        apiConfigs: raw.apiConfigs || [],
        selectedConfigIndex: raw.selectedConfigIndex ?? 0,
        searchProvider: raw.searchProvider || 'tavily',
        tavilyApiKey: raw.tavilyApiKey || '',
        tavilyApiUrl: raw.tavilyApiUrl || '',
        exaApiKey: raw.exaApiKey || '',
        exaApiUrl: raw.exaApiUrl || ''
    };
}

export function buildHashedChatIndexEntry(source, hash) {
    if (!source?.id || hash == null) return null;
    return {
        id: source.id,
        title: source.title,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt || source.createdAt || new Date().toISOString(),
        webpageUrls: source.webpageUrls || [],
        messageCount: Number.isFinite(source.messageCount)
            ? source.messageCount
            : (Array.isArray(source.messages) ? source.messages.length : 0),
        hash
    };
}

export function buildLocalHashChatIndex(storedChatIndex, hashTable) {
    const entries = (Array.isArray(storedChatIndex) ? storedChatIndex : [])
        .filter(entry => entry?.id && !entry._remoteOnly && !entry._webdavHydrated)
        .map(entry => buildHashedChatIndexEntry(entry, hashTable.get(entry.id)))
        .filter(Boolean);
    return sortChatIndexEntries(entries);
}

export function buildManifestUploadPlan({
    initialChatIndex = [],
    candidateChatIndex = [],
    previousManifest = null,
    tombstones = [],
    tombstoneMaxAgeMs = Number.POSITIVE_INFINITY,
    localHash = null,
    lastLocalHash = null,
    getChatById = null
}) {
    const plannedChatIndex = [];
    for (const entry of initialChatIndex) {
        upsertChatIndexEntry(plannedChatIndex, entry);
    }

    const previousChatHashes = new Map(
        (previousManifest?.chatIndex || []).map(entry => [entry.id, entry.hash])
    );
    const uploadItems = [];
    for (const entry of candidateChatIndex) {
        if (!entry?.id) continue;
        if (entry.hash === previousChatHashes.get(entry.id)) continue;

        const chat = typeof getChatById === 'function'
            ? getChatById(entry.id)
            : null;
        if (!chat) continue;

        uploadItems.push({ chat, entry });
    }

    const normalizedTombstones = cleanTombstones(tombstones, tombstoneMaxAgeMs);
    const previousTombstones = cleanTombstones(getManifestDeletedChatIds(previousManifest), tombstoneMaxAgeMs);
    const tombstonesChanged =
        computeTombstoneHash(normalizedTombstones) !== computeTombstoneHash(previousTombstones);
    const hashesMatch = localHash !== null && localHash === lastLocalHash;

    return {
        initialChatIndex: sortChatIndexEntries(plannedChatIndex),
        uploadItems,
        tombstones: normalizedTombstones,
        tombstonesChanged,
        noChanges: uploadItems.length === 0 && hashesMatch && !tombstonesChanged
    };
}

export function getManifestDeletedChatIds(manifest) {
    return Array.isArray(manifest?.deletedChatIds) ? manifest.deletedChatIds : [];
}

export function computeOverallHash(chatIndex, quickChatOptions, apiSettings) {
    return computeStructuredHash({
        chatIndex: sortChatIndexEntries(chatIndex),
        quickChatOptions,
        apiSettings
    });
}

export function computeTombstoneHash(tombstones) {
    return computeStructuredHash(cleanTombstones(tombstones, Number.POSITIVE_INFINITY));
}

export function buildSyncedMetadataSyncState({
    quickChatOptions,
    quickChatOptionsUpdatedAt = null,
    apiSettings,
    apiSettingsUpdatedAt = null
}) {
    return {
        quickChatOptions: {
            baseHash: computeStructuredHash(Array.isArray(quickChatOptions) ? quickChatOptions : []),
            lastSyncedAt: quickChatOptionsUpdatedAt || null,
            modifiedAt: null
        },
        apiSettings: {
            baseHash: apiSettings === undefined ? null : computeStructuredHash(apiSettings),
            lastSyncedAt: apiSettings === undefined ? null : (apiSettingsUpdatedAt || null),
            modifiedAt: null
        }
    };
}

export async function buildUploadMetadataPayload({
    metadataSyncState = null,
    previousManifest = null,
    quickChatOptions,
    apiSettings,
    syncApiConfig = false,
    encryptApiKeys = false,
    encryptionPassword = '',
    encryptValue = null,
    now = new Date().toISOString()
}) {
    const normalizedState = normalizeMetadataSyncState(metadataSyncState);
    const quickChatOptionsForManifest = Array.isArray(quickChatOptions) ? quickChatOptions : [];
    const quickChatOptionsUpdatedAt = normalizedState.quickChatOptions.modifiedAt ||
        normalizedState.quickChatOptions.lastSyncedAt ||
        previousManifest?.quickChatOptionsUpdatedAt ||
        previousManifest?.timestamp ||
        now;

    let manifestApiSettings = undefined;
    let manifestApiSettingsEncrypted = false;
    let apiSettingsUpdatedAt = null;

    if (syncApiConfig && apiSettings !== undefined) {
        manifestApiSettings = apiSettings;
        apiSettingsUpdatedAt = normalizedState.apiSettings.modifiedAt ||
            normalizedState.apiSettings.lastSyncedAt ||
            previousManifest?.apiSettingsUpdatedAt ||
            previousManifest?.timestamp ||
            now;

        if (encryptApiKeys) {
            if (!encryptionPassword) {
                throw new Error(t('webdav.encryptionPasswordMissing'));
            }
            if (typeof encryptValue !== 'function') {
                throw new Error('WebDAV upload metadata encryption is unavailable');
            }
            manifestApiSettings = await encryptValue(apiSettings, encryptionPassword);
            manifestApiSettingsEncrypted = true;
        }
    }

    return {
        quickChatOptionsForManifest,
        quickChatOptionsUpdatedAt,
        manifestApiSettings,
        manifestApiSettingsEncrypted,
        apiSettingsUpdatedAt
    };
}

export class WebDAVClient {
    constructor(config, knownDirectories = []) {
        this.config = { ...DEFAULT_CLIENT_CONFIG, ...config };
        this.syncInProgress = false;
        this._knownDirectories = new Set(knownDirectories);
    }

    get _normalizedSyncPath() {
        return this.config.syncPath.replace(/^\/+/, '').replace(/\/+$/, '');
    }

    get _baseUrl() {
        return this.config.serverUrl.replace(/\/+$/, '');
    }

    updateConfig(config) {
        const pathChanged =
            (config.serverUrl !== undefined && config.serverUrl !== this.config.serverUrl) ||
            (config.syncPath !== undefined && config.syncPath !== this.config.syncPath);
        this.config = { ...this.config, ...config };
        if (pathChanged) this._knownDirectories.clear();
    }

    getFullUrl(path = '') {
        return `${this._baseUrl}/${this._normalizedSyncPath}/${path}`.replace(/\/+$/, '');
    }

    getAuthHeaders() {
        const credentials = btoa(`${this.config.username}:${this.config.password}`);
        return {
            Authorization: `Basic ${credentials}`,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
        };
    }

    async fetchWithTimeout(url, options, timeout = DEFAULT_TIMEOUT) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const fetchOptions = {
            ...options,
            signal: controller.signal,
            credentials: 'omit'
        };

        try {
            return await fetch(url, fetchOptions);
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(t('webdav.requestTimeout', { seconds: timeout / 1000 }));
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async withDirectoryRetry(operation, operationName, filename = null) {
        try {
            const result = await operation();
            if (filename) this._markAncestorDirectoriesKnown(filename);
            return result;
        } catch (error) {
            if (error.status === HTTP_STATUS.FAILED_DEPENDENCY ||
                error.status === HTTP_STATUS.CONFLICT ||
                error.status === HTTP_STATUS.FORBIDDEN ||
                error.status === HTTP_STATUS.NOT_FOUND) {
                console.warn(`[WebDAV] ${operationName} 遇到目录问题 (HTTP ${error.status})，清除目錄快取並尝试创建后重试`);
                this._knownDirectories.clear();
                if (filename && filename.includes('/')) {
                    const dirPart = filename.split('/').slice(0, -1).join('/');
                    const fullDirPath = [this._normalizedSyncPath, dirPart].filter(Boolean).join('/');
                    await this._ensureDirectoriesExist(fullDirPath);
                } else {
                    await this.createDirectory();
                }
                const result = await operation();
                if (filename) this._markAncestorDirectoriesKnown(filename);
                return result;
            }
            throw error;
        }
    }

    async testConnection() {
        if (!this.config.serverUrl || !this.config.username) {
            throw new Error(t('webdav.serverUrlUsernameRequired'));
        }

        try {
            const response = await this.fetchWithTimeout(this.getFullUrl(), {
                method: 'PROPFIND',
                headers: {
                    ...this.getAuthHeaders(),
                    Depth: '0'
                }
            });

            if (response.status === HTTP_STATUS.NOT_FOUND) {
                const result = await this.createDirectory();
                if (result.error) {
                    throw new Error(t('webdav.syncPathCreateFailed', { error: result.error }));
                }
                return { success: true, message: t('webdav.connectionSuccess') };
            }

            if (response.status === HTTP_STATUS.MULTI_STATUS || response.status === HTTP_STATUS.OK) {
                const syncPath = this._normalizedSyncPath;
                if (syncPath) this._knownDirectories.add(syncPath);
                return { success: true, message: t('webdav.connectionSuccess') };
            }

            if (response.status === HTTP_STATUS.UNAUTHORIZED) {
                throw new Error(t('webdav.authFailed'));
            }

            throw new Error(t('webdav.connectionFailedStatus', { status: response.status }));
        } catch (error) {
            if (error.message.includes('Failed to fetch')) {
                throw new Error(t('webdav.cannotReachServer'));
            }
            throw error;
        }
    }

    async createDirectory() {
        const syncPath = this._normalizedSyncPath;

        if (syncPath && this._knownDirectories.has(syncPath)) {
            return { created: false, error: null };
        }

        try {
            const response = await this.fetchWithTimeout(this.getFullUrl() + '/', {
                method: 'MKCOL',
                headers: this.getAuthHeaders()
            });

            if (response.status === HTTP_STATUS.CREATED) {
                if (syncPath) this._knownDirectories.add(syncPath);
                return { created: true, error: null };
            }

            if (response.status === HTTP_STATUS.METHOD_NOT_ALLOWED || response.status === HTTP_STATUS.MOVED_PERMANENTLY) {
                if (syncPath) this._knownDirectories.add(syncPath);
                return { created: false, error: null };
            }

            if (response.status === HTTP_STATUS.CONFLICT || response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                const parentCreated = await this.createParentDirectories();
                if (!parentCreated) {
                    return { created: false, error: t('webdav.createParentDirFailed') };
                }
                return { created: true, error: null };
            }

            return { created: false, error: `HTTP ${response.status}` };
        } catch (error) {
            return { created: false, error: error.message };
        }
    }

    async _ensureDirectoriesExist(normalizedPath) {
        if (!normalizedPath) {
            return { created: false, error: null };
        }

        if (this._knownDirectories.has(normalizedPath)) {
            return { created: false, error: null };
        }

        const baseUrl = this._baseUrl;
        const parts = normalizedPath.split('/').filter(Boolean);
        let currentPath = '';

        for (const part of parts) {
            currentPath += '/' + part;
            const pathKey = currentPath.slice(1);

            if (this._knownDirectories.has(pathKey)) {
                continue;
            }

            const response = await this.fetchWithTimeout(`${baseUrl}${currentPath}/`, {
                method: 'MKCOL',
                headers: this.getAuthHeaders()
            });

            if (response.status === HTTP_STATUS.CREATED ||
                response.status === HTTP_STATUS.METHOD_NOT_ALLOWED ||
                response.status === HTTP_STATUS.MOVED_PERMANENTLY) {
                this._knownDirectories.add(pathKey);
            } else if (response.status !== HTTP_STATUS.CONFLICT &&
                response.status !== HTTP_STATUS.FAILED_DEPENDENCY) {
                return { created: false, error: `创建目录 ${currentPath} 失败: HTTP ${response.status}` };
            }
        }

        return { created: true, error: null };
    }

    async createParentDirectories() {
        try {
            const result = await this._ensureDirectoriesExist(this._normalizedSyncPath);
            if (result.error) {
                console.warn(`[WebDAV] ${result.error}`);
            }
            return !result.error;
        } catch (error) {
            console.error('[WebDAV] 创建父目录异常:', error);
            return false;
        }
    }

    _markAncestorDirectoriesKnown(relativePath) {
        const syncPath = this._normalizedSyncPath;
        if (!syncPath) return;

        const fullPath = relativePath ? `${syncPath}/${relativePath}` : syncPath;
        const parts = fullPath.split('/').filter(Boolean);
        if (relativePath) parts.pop();

        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            this._knownDirectories.add(current);
        }
    }

    async createDirectoryAtPath(relativePath) {
        const childPath = relativePath.replace(/^\/+/, '').replace(/\/+$/, '');
        const fullPath = [this._normalizedSyncPath, childPath].filter(Boolean).join('/');
        return await this._ensureDirectoriesExist(fullPath);
    }

    async uploadData(filename, data) {
        const url = this.getFullUrl(filename);

        const doUpload = async () => {
            const response = await this.fetchWithTimeout(url, {
                method: 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(data)
            });

            if (response.status === HTTP_STATUS.FAILED_DEPENDENCY || response.status === HTTP_STATUS.CONFLICT) {
                const error = new Error(t('webdav.uploadFailedStatus', { status: response.status }));
                error.status = response.status;
                throw error;
            }

            if (!response.ok && response.status !== HTTP_STATUS.CREATED && response.status !== HTTP_STATUS.NO_CONTENT) {
                const error = new Error(t('webdav.uploadFailedStatus', { status: response.status }));
                error.status = response.status;
                throw error;
            }

            const etag = response.headers.get('ETag') || response.headers.get('Last-Modified') || null;
            return { success: true, etag };
        };

        return await this.withDirectoryRetry(doUpload, '上传数据', filename);
    }

    async downloadData(filename) {
        const url = this.getFullUrl(filename);
        const response = await this.fetchWithTimeout(url, {
            method: 'GET',
            headers: this.getAuthHeaders()
        });

        if (response.status === HTTP_STATUS.NOT_FOUND ||
            response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
            return { data: null, etag: null };
        }

        if (!response.ok) {
            const error = new Error(t('webdav.downloadFailedStatus', { status: response.status }));
            error.status = response.status;
            throw error;
        }

        const etag = response.headers.get('ETag') || response.headers.get('Last-Modified') || null;
        const text = await response.text();
        try {
            return { data: JSON.parse(text), etag };
        } catch {
            throw new Error(t('webdav.dataFormatError'));
        }
    }

    async deleteFile(filename) {
        const url = this.getFullUrl(filename);
        const response = await this.fetchWithTimeout(url, {
            method: 'DELETE',
            headers: this.getAuthHeaders()
        });

        if (!response.ok && response.status !== HTTP_STATUS.NOT_FOUND) {
            throw new Error(t('webdav.deleteFailed', { status: response.status }));
        }

        return true;
    }

    async listJsonFilesInDirectory(directoryPath) {
        const normalizedDirectory = directoryPath.replace(/^\/+/, '').replace(/\/+$/, '');
        const directoryUrl = `${this.getFullUrl(normalizedDirectory)}/`;
        const response = await this.fetchWithTimeout(directoryUrl, {
            method: 'PROPFIND',
            headers: {
                ...this.getAuthHeaders(),
                Depth: '1'
            }
        });

        if (response.status === HTTP_STATUS.NOT_FOUND) {
            return [];
        }

        if (response.status === HTTP_STATUS.METHOD_NOT_ALLOWED ||
            response.status === HTTP_STATUS.NOT_IMPLEMENTED) {
            const unsupportedError = new Error(`[WebDAV] PROPFIND 不支援 (HTTP ${response.status})`);
            unsupportedError.status = response.status;
            unsupportedError.code = 'PROPFIND_UNSUPPORTED';
            throw unsupportedError;
        }

        if (response.status !== HTTP_STATUS.MULTI_STATUS && response.status !== HTTP_STATUS.OK) {
            const statusError = new Error(`[WebDAV] 列舉目錄失敗: HTTP ${response.status}`);
            statusError.status = response.status;
            throw statusError;
        }

        const xmlText = await response.text();
        return this._extractJsonFileIdsFromPropfind(xmlText, directoryUrl);
    }

    _extractJsonFileIdsFromPropfind(xmlText, directoryUrl) {
        const hrefPattern = /<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi;
        const directoryPathname = decodeURIComponent(new URL(directoryUrl).pathname).replace(/\/+$/, '/');
        const ids = new Set();
        let match;

        while ((match = hrefPattern.exec(xmlText)) !== null) {
            const rawHref = match[1].trim().replace(/&amp;/g, '&');
            if (!rawHref) continue;

            let pathname;
            try {
                pathname = decodeURIComponent(new URL(rawHref, directoryUrl).pathname);
            } catch {
                continue;
            }

            if (!pathname.startsWith(directoryPathname)) continue;

            const relativePath = pathname.slice(directoryPathname.length);
            if (!relativePath || relativePath.endsWith('/')) continue;
            if (relativePath.includes('/')) continue;
            if (!relativePath.toLowerCase().endsWith('.json')) continue;

            ids.add(relativePath.slice(0, -5));
        }

        return [...ids];
    }

    async getRemoteETag(filename) {
        const url = this.getFullUrl(filename);
        const response = await this.fetchWithTimeout(url, {
            method: 'HEAD',
            headers: this.getAuthHeaders()
        });

        if (response.status === HTTP_STATUS.NOT_FOUND ||
            response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
            return null;
        }

        if (!response.ok) {
            const error = new Error(t('webdav.etagFailedStatus', { status: response.status }));
            error.status = response.status;
            throw error;
        }

        return response.headers.get('ETag') || response.headers.get('Last-Modified') || null;
    }
}

export async function uploadManifestSnapshot({
    client,
    initialChatIndex = [],
    uploadItems = [],
    tombstones = [],
    quickChatOptions,
    quickChatOptionsUpdatedAt = null,
    apiSettings,
    apiSettingsEncrypted = false,
    apiSettingsUpdatedAt = null,
    uploadConcurrency = UPLOAD_CONCURRENCY,
    timestamp = new Date().toISOString()
}) {
    const chatIndex = [];
    for (const entry of sortChatIndexEntries(initialChatIndex)) {
        upsertChatIndexEntry(chatIndex, entry);
    }

    if (uploadItems.length > 0) {
        const dirResult = await client.createDirectoryAtPath(CHAT_DIRECTORY);
        if (dirResult?.error) {
            throw new Error(`创建聊天目录失败: ${dirResult.error}`);
        }

        const uploadTasks = uploadItems.map(({ chat, entry }) => async () => {
            await client.uploadData(`${CHAT_DIRECTORY}/${chat.id}.json`, stripWebDAVMetadata(chat));
            upsertChatIndexEntry(chatIndex, entry);
        });
        await runWorkerQueue(uploadTasks, uploadConcurrency);
    }

    // 先更新 manifest，再交由後續 cleanup 清理孤兒聊天檔，
    // 可避免「遠端聊天檔已刪除，但 manifest 尚未寫成功」的破壞性中間態。
    const persistedTombstones = cleanTombstones(tombstones, Number.POSITIVE_INFINITY);
    const deletedIds = new Set(persistedTombstones.map((tombstone) => tombstone.id));
    const manifestChatIndex = sortChatIndexEntries(
        chatIndex.filter((entry) => entry?.id && !deletedIds.has(entry.id))
    );

    const manifest = {
        version: 2,
        timestamp,
        chatIndex: manifestChatIndex,
        deletedChatIds: serializeTombstones(persistedTombstones)
    };

    if (Array.isArray(quickChatOptions)) {
        manifest.quickChatOptions = quickChatOptions;
        if (quickChatOptionsUpdatedAt) {
            manifest.quickChatOptionsUpdatedAt = quickChatOptionsUpdatedAt;
        }
    }

    if (apiSettings !== undefined) {
        manifest.apiSettings = apiSettings;
        if (apiSettingsUpdatedAt) {
            manifest.apiSettingsUpdatedAt = apiSettingsUpdatedAt;
        }
        if (apiSettingsEncrypted) {
            manifest.apiSettingsEncrypted = true;
        }
    }

    const uploadResult = await client.uploadData('cerebr.json', manifest);
    return {
        manifest,
        uploadResult,
        persistedTombstones,
        uploadedIds: uploadItems.map(({ chat }) => chat.id)
    };
}

export async function persistStorageBackedSyncState({
    localStorageArea,
    syncStorageArea,
    manifest,
    localChatHashes,
    tombstones = null,
    etag,
    localHash,
    lastSync,
    remoteTimestamp,
    metadataSyncState = null,
    syncStorageData = null,
    knownDirectories = null
}) {
    const localData = {
        [WEBDAV_CACHED_MANIFEST_KEY]: manifest,
        [WEBDAV_LOCAL_CHAT_HASHES_KEY]: Object.fromEntries(localChatHashes)
    };
    if (tombstones !== null) {
        localData[WEBDAV_DELETED_CHAT_IDS_KEY] = tombstones;
    }
    if (metadataSyncState !== null) {
        localData[WEBDAV_METADATA_SYNC_STATE_KEY] = metadataSyncState;
    }
    if (knownDirectories !== null) {
        localData[WEBDAV_KNOWN_DIRS_KEY] = knownDirectories;
    }

    const syncData = {
        [WEBDAV_REMOTE_ETAG_KEY]: etag,
        [WEBDAV_LOCAL_HASH_KEY]: localHash,
        [WEBDAV_LAST_SYNC_KEY]: lastSync,
        [WEBDAV_LAST_SYNC_TIMESTAMP_KEY]: remoteTimestamp
    };
    if (syncStorageData && typeof syncStorageData === 'object') {
        Object.assign(syncData, syncStorageData);
    }

    await Promise.all([
        localStorageArea.set(localData),
        syncStorageArea.set(syncData)
    ]);
}

export async function performStorageBackedCloseSyncUpload({
    config,
    client: providedClient = null,
    localStorageArea,
    syncStorageArea,
    encryptValue = null,
    tombstoneMaxAgeMs = Number.POSITIVE_INFINITY,
    uploadConcurrency = UPLOAD_CONCURRENCY
}) {
    if (!config?.enabled) {
        return { skipped: true, reason: 'disabled' };
    }

    const dirtyState = await localStorageArea.get([
        DIRTY_CHAT_IDS_KEY,
        WEBDAV_DELETED_CHAT_IDS_KEY,
        WEBDAV_LOCAL_DATA_DIRTY_KEY
    ]);
    const dirtyIds = Array.isArray(dirtyState[DIRTY_CHAT_IDS_KEY])
        ? dirtyState[DIRTY_CHAT_IDS_KEY]
        : [];
    const tombstones = Array.isArray(dirtyState[WEBDAV_DELETED_CHAT_IDS_KEY])
        ? dirtyState[WEBDAV_DELETED_CHAT_IDS_KEY]
        : [];
    const localDataDirty = Boolean(dirtyState[WEBDAV_LOCAL_DATA_DIRTY_KEY]);

    const chatKeys = dirtyIds.map(id => `${CHAT_KEY_PREFIX}${id}`);
    const localSnapshot = await localStorageArea.get([
        ...chatKeys,
        CHAT_INDEX_KEY,
        WEBDAV_CACHED_MANIFEST_KEY,
        WEBDAV_LOCAL_CHAT_HASHES_KEY,
        WEBDAV_KNOWN_DIRS_KEY,
        WEBDAV_METADATA_SYNC_STATE_KEY
    ]);

    const cachedManifest = localSnapshot[WEBDAV_CACHED_MANIFEST_KEY];
    const metadataSyncState = normalizeMetadataSyncState(localSnapshot[WEBDAV_METADATA_SYNC_STATE_KEY]);
    const hashTable = new Map(Object.entries(localSnapshot[WEBDAV_LOCAL_CHAT_HASHES_KEY] || {}));
    const storedChatIndex = Array.isArray(localSnapshot[CHAT_INDEX_KEY])
        ? localSnapshot[CHAT_INDEX_KEY]
        : [];
    const missingHashIds = storedChatIndex
        .filter(entry => entry?.id && !entry._remoteOnly && !entry._webdavHydrated && !hashTable.has(entry.id))
        .map(entry => entry.id);

    if (missingHashIds.length > 0) {
        const missingChats = await localStorageArea.get(missingHashIds.map(id => `${CHAT_KEY_PREFIX}${id}`));
        for (const id of missingHashIds) {
            const chat = missingChats[`${CHAT_KEY_PREFIX}${id}`];
            if (!chat || chat._remoteOnly || chat._webdavHydrated) continue;
            hashTable.set(id, computeChatHash(chat));
        }
    }

    const syncMetadata = await syncStorageArea.get([
        'quickChatOptions',
        'apiConfigs',
        'selectedConfigIndex',
        'searchProvider',
        'tavilyApiKey',
        'tavilyApiUrl',
        'exaApiKey',
        'exaApiUrl'
    ]);
    const quickChatOptions = Array.isArray(syncMetadata.quickChatOptions)
        ? syncMetadata.quickChatOptions
        : undefined;
    const quickChatOptionsForHash = Array.isArray(quickChatOptions) ? quickChatOptions : [];
    const apiSettingsForHash = config.syncApiConfig ? normalizeApiSettings(syncMetadata) : undefined;

    const knownDirectories = Array.isArray(localSnapshot[WEBDAV_KNOWN_DIRS_KEY])
        ? localSnapshot[WEBDAV_KNOWN_DIRS_KEY]
        : [];
    const client = providedClient || new WebDAVClient(config, knownDirectories);
    client.updateConfig(config);

    const candidateChatIndex = [];
    for (const id of dirtyIds) {
        const chat = localSnapshot[`${CHAT_KEY_PREFIX}${id}`];
        if (!chat || chat._remoteOnly || chat._webdavHydrated) continue;

        const hash = computeChatHash(chat);
        hashTable.set(id, hash);
        const entry = buildHashedChatIndexEntry(chat, hash);
        if (!entry) continue;
        candidateChatIndex.push(entry);
    }

    const localHashChatIndex = buildLocalHashChatIndex(storedChatIndex, hashTable);
    const localHash = computeOverallHash(localHashChatIndex, quickChatOptionsForHash, apiSettingsForHash);
    const hashResult = await syncStorageArea.get(WEBDAV_LOCAL_HASH_KEY);
    const lastLocalHash = hashResult[WEBDAV_LOCAL_HASH_KEY];
    const baseChatIndex = Array.isArray(cachedManifest?.chatIndex) && cachedManifest.chatIndex.length > 0
        ? cachedManifest.chatIndex
        : localHashChatIndex;
    const {
        initialChatIndex,
        uploadItems: plannedUploadItems,
        tombstones: tombstonesForUpload,
        tombstonesChanged,
        noChanges
    } = buildManifestUploadPlan({
        initialChatIndex: baseChatIndex,
        candidateChatIndex,
        previousManifest: cachedManifest,
        tombstones,
        tombstoneMaxAgeMs,
        localHash,
        lastLocalHash,
        getChatById: (chatId) => {
            const chat = localSnapshot[`${CHAT_KEY_PREFIX}${chatId}`];
            return (!chat || chat._remoteOnly || chat._webdavHydrated) ? null : chat;
        }
    });
    if (dirtyIds.length === 0 && !localDataDirty && !tombstonesChanged) {
        return { skipped: true, reason: 'no-changes' };
    }

    if (noChanges) {
        const currentDirtyResult = await localStorageArea.get(DIRTY_CHAT_IDS_KEY);
        const currentDirty = Array.isArray(currentDirtyResult[DIRTY_CHAT_IDS_KEY])
            ? currentDirtyResult[DIRTY_CHAT_IDS_KEY]
            : [];
        const processedDirtyIds = new Set(dirtyIds);
        const clearedDirtyIds = currentDirty.filter(id => processedDirtyIds.has(id));
        const remainingDirtyIds = currentDirty.filter(id => !processedDirtyIds.has(id));
        const lastSync = new Date().toISOString();

        await Promise.all([
            localStorageArea.set({
                [DIRTY_CHAT_IDS_KEY]: remainingDirtyIds,
                [WEBDAV_LOCAL_DATA_DIRTY_KEY]: null
            }),
            syncStorageArea.set({
                [WEBDAV_LAST_SYNC_KEY]: lastSync
            })
        ]);

        return {
            skipped: false,
            noChanges: true,
            client,
            uploadedIds: [],
            clearedDirtyIds,
            persistedTombstones: tombstonesForUpload,
            localDataDirty,
            lastSync,
            chatCount: initialChatIndex.length
        };
    }

    let quickChatOptionsForManifest;
    let quickChatOptionsUpdatedAt;
    let manifestApiSettings;
    let manifestApiSettingsEncrypted = false;
    let apiSettingsUpdatedAt = null;

    try {
        ({
            quickChatOptionsForManifest,
            quickChatOptionsUpdatedAt,
            manifestApiSettings,
            manifestApiSettingsEncrypted,
            apiSettingsUpdatedAt
        } = await buildUploadMetadataPayload({
            metadataSyncState,
            previousManifest: cachedManifest,
            quickChatOptions,
            apiSettings: apiSettingsForHash,
            syncApiConfig: config.syncApiConfig,
            encryptApiKeys: config.encryptApiKeys,
            encryptionPassword: config.encryptionPassword,
            encryptValue
        }));
    } catch (encryptError) {
        if (config.syncApiConfig && apiSettingsForHash && config.encryptApiKeys) {
            throw new Error(t('webdav.encryptApiConfigFailed', { error: encryptError.message }));
        }
        throw encryptError;
    }

    const { manifest, uploadResult, persistedTombstones, uploadedIds } = await uploadManifestSnapshot({
        client,
        initialChatIndex,
        uploadItems: plannedUploadItems,
        tombstones: tombstonesForUpload,
        quickChatOptions: quickChatOptionsForManifest,
        quickChatOptionsUpdatedAt,
        apiSettings: manifestApiSettings,
        apiSettingsEncrypted: manifestApiSettingsEncrypted,
        apiSettingsUpdatedAt,
        uploadConcurrency
    });

    const currentDirtyResult = await localStorageArea.get(DIRTY_CHAT_IDS_KEY);
    const currentDirty = Array.isArray(currentDirtyResult[DIRTY_CHAT_IDS_KEY])
        ? currentDirtyResult[DIRTY_CHAT_IDS_KEY]
        : [];
    const uploadedSet = new Set(uploadedIds);
    const clearedDirtyIds = currentDirty.filter(id => uploadedSet.has(id));
    const remainingDirtyIds = currentDirty.filter(id => !uploadedSet.has(id));
    const nextMetadataSyncState = buildSyncedMetadataSyncState({
        quickChatOptions: quickChatOptionsForHash,
        quickChatOptionsUpdatedAt: manifest.quickChatOptionsUpdatedAt || quickChatOptionsUpdatedAt || manifest.timestamp,
        apiSettings: config.syncApiConfig ? apiSettingsForHash : undefined,
        apiSettingsUpdatedAt: config.syncApiConfig
            ? (manifest.apiSettingsUpdatedAt || apiSettingsUpdatedAt || manifest.timestamp)
            : null
    });

    await persistStorageBackedSyncState({
        localStorageArea,
        syncStorageArea,
        manifest,
        localChatHashes: hashTable,
        tombstones: persistedTombstones,
        etag: uploadResult.etag || `__needs_refresh_${Date.now()}`,
        localHash,
        lastSync: manifest.timestamp,
        remoteTimestamp: manifest.timestamp,
        metadataSyncState: nextMetadataSyncState,
        knownDirectories: [...client._knownDirectories]
    });
    await localStorageArea.set({
        [DIRTY_CHAT_IDS_KEY]: remainingDirtyIds,
        [WEBDAV_LOCAL_DATA_DIRTY_KEY]: null
    });

    return {
        skipped: false,
        noChanges: false,
        client,
        manifest,
        uploadResult,
        uploadedIds,
        clearedDirtyIds,
        persistedTombstones,
        localDataDirty
    };
}
