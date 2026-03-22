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

const DEFAULT_CLIENT_CONFIG = {
    serverUrl: '',
    username: '',
    password: '',
    syncPath: '/Cerebr-neo'
};

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
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeTombstoneRecord(tombstone) {
    if (!tombstone?.id) return null;

    const deletedAt = normalizeTimestampToIso(tombstone.deletedAt);
    if (!deletedAt) return null;

    const normalized = {
        id: tombstone.id,
        deletedAt
    };
    const fileDeletedAt = normalizeTimestampToIso(tombstone.fileDeletedAt);
    if (fileDeletedAt) {
        normalized.fileDeletedAt = fileDeletedAt;
    }
    return normalized;
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

    const leftFileDeletedAt = normalizeTimestampToIso(left.fileDeletedAt);
    const rightFileDeletedAt = normalizeTimestampToIso(right.fileDeletedAt);
    let fileDeletedAt = leftFileDeletedAt || rightFileDeletedAt || null;
    if (leftFileDeletedAt && rightFileDeletedAt) {
        fileDeletedAt = leftFileDeletedAt >= rightFileDeletedAt ? leftFileDeletedAt : rightFileDeletedAt;
    }

    return {
        id: right.id || left.id,
        deletedAt: right.deletedAt || left.deletedAt,
        ...(fileDeletedAt ? { fileDeletedAt } : {})
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

        const doDownload = async () => {
            const response = await this.fetchWithTimeout(url, {
                method: 'GET',
                headers: this.getAuthHeaders()
            });

            if (response.status === HTTP_STATUS.NOT_FOUND) {
                return { data: null, etag: null };
            }

            if (response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                const error = new Error(t('webdav.downloadFailedStatus', { status: response.status }));
                error.status = response.status;
                throw error;
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
        };

        try {
            return await this.withDirectoryRetry(doDownload, '下载数据', filename);
        } catch (error) {
            if (error.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                return { data: null, etag: null };
            }
            throw error;
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

        const doGetETag = async () => {
            const response = await this.fetchWithTimeout(url, {
                method: 'HEAD',
                headers: this.getAuthHeaders()
            });

            if (response.status === HTTP_STATUS.NOT_FOUND) {
                return null;
            }

            if (response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                const error = new Error(t('webdav.etagFailedStatus', { status: response.status }));
                error.status = response.status;
                throw error;
            }

            if (!response.ok) {
                const error = new Error(t('webdav.etagFailedStatus', { status: response.status }));
                error.status = response.status;
                throw error;
            }

            return response.headers.get('ETag') || response.headers.get('Last-Modified') || null;
        };

        try {
            return await this.withDirectoryRetry(doGetETag, '获取 ETag', filename);
        } catch (error) {
            if (error.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                return null;
            }
            throw error;
        }
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
    for (const entry of initialChatIndex) {
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

    const normalizedTombstones = cleanTombstones(tombstones, Number.POSITIVE_INFINITY);
    const confirmedDeletedIds = new Set();
    if (normalizedTombstones.length > 0) {
        const deleteTasks = normalizedTombstones
            .filter((tombstone) => !tombstone.fileDeletedAt)
            .map((tombstone) => async () => {
            try {
                await client.deleteFile(`${CHAT_DIRECTORY}/${tombstone.id}.json`);
                confirmedDeletedIds.add(tombstone.id);
            } catch (error) {
                console.warn(`[WebDAV] 刪除聊天檔案 ${tombstone.id} 失敗:`, error);
            }
        });
        await runWorkerQueue(deleteTasks, uploadConcurrency);
    }

    const persistedTombstones = normalizedTombstones.map((tombstone) => {
        if (!confirmedDeletedIds.has(tombstone.id) || tombstone.fileDeletedAt) {
            return tombstone;
        }
        return {
            ...tombstone,
            fileDeletedAt: timestamp
        };
    });

    const deletedIds = new Set(persistedTombstones.map((tombstone) => tombstone.id));
    const manifestChatIndex = chatIndex.filter((entry) => entry?.id && !deletedIds.has(entry.id));

    const manifest = {
        version: 2,
        timestamp,
        chatIndex: manifestChatIndex,
        deletedChatIds: persistedTombstones
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
