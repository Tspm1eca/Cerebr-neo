/**
 * WebDAV 同步服务
 * 提供与 WebDAV 服务器的数据同步功能
 *
 * v2 格式：聊天紀錄分檔存儲，按需下載
 * - cerebr.json 只存 manifest（chatIndex metadata，無 messages）
 * - chats/{id}.json 存完整聊天（含 messages + base64 圖片）
 */

import {
    storageAdapter,
    sessionStorageAdapter,
    syncStorageAdapter,
    setSyncMode,
    isExtensionEnvironment,
    SYNC_MODE_FLAG_KEY
} from '../utils/storage-adapter.js';
import { encrypt, decrypt, encryptPasswordForStorage, decryptPasswordFromStorage, isEncryptedPassword } from '../utils/crypto.js';
import { chatManager } from '../utils/chat-manager.js';
import { computeChatHash } from '../utils/chat-hash.js';
import { t } from '../utils/i18n.js';
import {
    hasStoredActiveStreams
} from '../utils/active-streams.js';
import {
    API_SETTINGS_BOOTSTRAP_DIRTY_REASON,
    API_SETTINGS_REMOTE_RETRY_DIRTY_REASON,
    API_SETTINGS_STORAGE_KEYS,
    API_SETTINGS_SYNC_CONFIG_DIRTY_REASON,
    CHAT_DIRECTORY as SHARED_CHAT_DIRECTORY,
    UPLOAD_CONCURRENCY as SHARED_UPLOAD_CONCURRENCY,
    buildApiSettingsStoragePayload,
    buildApiSettingsRemoteRetryContext,
    buildManifestUploadPlan,
    buildHashedChatIndexEntry,
    buildUploadMetadataPayload,
    WebDAVClient as SharedWebDAVClient,
    buildSyncedMetadataSyncState,
    cleanTombstones as sharedCleanTombstones,
    computeOverallHash as computeSharedOverallHash,
    createWebDAVSyncBusyError,
    computeStructuredHash,
    createDefaultMetadataSyncState,
    getManifestDeletedChatIds,
    hasSyncedMetadataBaseline,
    isWebDAVSyncBusyError,
    normalizeSyncableApiSettings,
    normalizeMetadataSyncState,
    persistStorageBackedSyncState,
    resolveApiSettingsSyncPlan,
    resolveManifestApiSettings,
    shouldAttemptApiSettingsRemoteRetry,
    runWithConcurrency as sharedRunWithConcurrency,
    uploadManifestSnapshot,
    withWebDAVSyncLock
} from './webdav-sync-shared.js';

// WebDAV 配置键
const WEBDAV_CONFIG_KEY = 'webdav_config';
const WEBDAV_LAST_SYNC_KEY = 'webdav_last_sync';
const WEBDAV_REMOTE_ETAG_KEY = 'webdav_remote_etag';
const WEBDAV_LOCAL_HASH_KEY = 'webdav_local_hash';
const WEBDAV_DELETED_CHAT_IDS_KEY = 'webdav_deleted_chat_ids';
const WEBDAV_CACHED_MANIFEST_KEY = 'webdav_cached_manifest';
const WEBDAV_LOCAL_CHAT_HASHES_KEY = 'webdav_local_chat_hashes';
const WEBDAV_KNOWN_DIRS_KEY = 'webdav_known_directories';
const WEBDAV_METADATA_SYNC_STATE_KEY = 'webdav_metadata_sync_state';
// 跨分頁節流：共享 checkSyncStatus 的時間戳和結果（存儲在 chrome.storage.local）
const WEBDAV_CROSS_TAB_CHECK_TIME_KEY = 'webdav_cross_tab_check_time';
const WEBDAV_CROSS_TAB_CHECK_RESULT_KEY = 'webdav_cross_tab_check_result';
const WEBDAV_LOCAL_DATA_DIRTY_KEY = 'webdav_local_data_dirty';
const WEBDAV_ORPHAN_CLEANUP_PENDING_KEY = 'webdav_orphan_cleanup_pending';
const WEBDAV_ORPHAN_CLEANUP_LAST_SCAN_AT_KEY = 'webdav_orphan_cleanup_last_scan_at';
const WEBDAV_ORPHAN_CLEANUP_LOCK_KEY = 'webdav_orphan_cleanup_lock';

const ORPHAN_CLEANUP_DEFAULT_COOLDOWN_MS = 10 * 24 * 60 * 60 * 1000;

// 默认配置
const DEFAULT_CONFIG = {
    serverUrl: '',
    username: '',
    password: '',
    syncPath: '/Cerebr-neo',
    enabled: false,
    syncApiConfig: false, // 是否同步 API 配置
    encryptApiKeys: false, // 是否加密 API Keys
    encryptionPassword: '', // 加密密码（仅存储在本地，不同步）
    orphanCleanupEnabled: true,
    orphanCleanupCooldownMs: ORPHAN_CLEANUP_DEFAULT_COOLDOWN_MS,
    orphanCleanupMaxDeletesPerRun: 20,
    orphanCleanupDeleteConcurrency: 2
};

const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const ORPHAN_CLEANUP_LOCK_TTL_MS = 5 * 60 * 1000; // 5 分鐘

function toPositiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.floor(parsed);
}

function parseTimestampMs(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : null;
}

// ========== Helper Functions ==========

/**
 * 從 chatIndex entry 建立 _remoteOnly 空殼聊天
 */
function buildRemoteOnlyStub(entry) {
    return {
        id: entry.id,
        title: entry.title,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        webpageUrls: entry.webpageUrls || [],
        messages: [],
        _remoteOnly: true,
        _webdavHash: entry.hash || null,
        _webdavMessageCount: Number.isFinite(entry.messageCount) ? entry.messageCount : 0
    };
}

function getHydratedChatSyncState(chat, precomputedHash = null) {
    if (!chat?._webdavHydrated) {
        return { isRemoteCache: false, hash: precomputedHash };
    }

    const currentHash = precomputedHash || computeChatHash(chat);
    return {
        isRemoteCache: currentHash === (chat._webdavHash || null),
        hash: currentHash
    };
}

function isRemoteCacheChat(chat, precomputedHash = null) {
    if (chat?._remoteOnly) return true;
    if (!chat?._webdavHydrated) return false;
    return getHydratedChatSyncState(chat, precomputedHash).isRemoteCache;
}

function buildHydratedRemoteChat(chat, entry) {
    return {
        ...chat,
        _remoteOnly: false,
        _webdavHydrated: true,
        _webdavHash: entry.hash || null,
        _webdavMessageCount: Number.isFinite(entry.messageCount)
            ? entry.messageCount
            : (Array.isArray(chat.messages) ? chat.messages.length : 0)
    };
}

/**
 * WebDAV 同步管理器
 */
// checkSyncStatus 最小间隔（毫秒）- 60 秒内不重复向远端发 HEAD 请求
const CHECK_SYNC_THROTTLE_MS = 60000;

class WebDAVSyncManager {
    constructor() {
        this.client = null;
        this.config = { ...DEFAULT_CONFIG };
        this.listeners = new Set();
        // 缓存：用于避免重复计算
        this._cachedLocalData = null;
        this._cachedLocalHash = null;
        this._cacheTimestamp = 0;
        // 节流：checkSyncStatus 上次执行时间和缓存结果
        this._lastCheckSyncTime = 0;
        this._lastCheckSyncResult = null;
        // 標記：啟動後是否已完成首次 hash fallback 檢查
        this._initialHashCheckDone = false;
        this._orphanCleanupOwnerId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    /**
     * 加密已启用但缺少密码
     */
    _isEncryptionIncomplete() {
        return this.config.encryptApiKeys && !this.config.encryptionPassword;
    }

    _didApiSyncConfigChange(previousConfig = {}, nextConfig = {}) {
        const syncStateChanged = previousConfig.syncApiConfig !== nextConfig.syncApiConfig;
        const syncApiEnabled = Boolean(previousConfig.syncApiConfig || nextConfig.syncApiConfig);
        if (!syncApiEnabled) {
            return syncStateChanged;
        }

        const encryptionModeChanged = previousConfig.encryptApiKeys !== nextConfig.encryptApiKeys;
        const encryptionPasswordChanged = Boolean(nextConfig.encryptApiKeys) &&
            previousConfig.encryptionPassword !== nextConfig.encryptionPassword;

        return syncStateChanged || encryptionModeChanged || encryptionPasswordChanged;
    }

    /**
     * 保存 checkSyncStatus 結果到記憶體快取及跨分頁共享存儲
     * @param {Object} result - checkSyncStatus 結果
     */
    _cacheCheckResult(result) {
        this._lastCheckSyncTime = Date.now();
        this._lastCheckSyncResult = result;
        // 非同步寫入 chrome.storage.local，不阻塞返回
        storageAdapter.set({
            [WEBDAV_CROSS_TAB_CHECK_TIME_KEY]: this._lastCheckSyncTime,
            [WEBDAV_CROSS_TAB_CHECK_RESULT_KEY]: result
        }).catch(() => {});
        return result;
    }

    async _runSyncOperation(direction, operation) {
        if (!this.client) {
            throw new Error(t('webdav.notEnabled'));
        }

        if (this.client.syncInProgress) {
            throw createWebDAVSyncBusyError();
        }

        return withWebDAVSyncLock(async () => {
            this.client.syncInProgress = true;
            this.notifyListeners('sync-start', { direction });

            try {
                return await operation();
            } finally {
                this.client.syncInProgress = false;
            }
        }, { logLabel: '[WebDAV]' });
    }

    _finalizeSyncOnOpenResult(syncResult) {
        if (!syncResult?.error && syncResult?.direction !== 'unknown' && syncResult?.direction !== 'busy') {
            this.runOrphanCleanupOnOpen().catch((error) => {
                console.warn('[WebDAV] 開啟時 orphan cleanup 執行失敗:', error);
            });
        }
        return syncResult;
    }

    /**
     * 清除本地数据缓存
     */
    clearCache() {
        this._cachedLocalData = null;
        this._cachedLocalHash = null;
        this._cachedChatIndex = null;
        this._cachedLocalChatHashes = null;
        this._cacheTimestamp = 0;
        this._lastCheckSyncTime = 0;
        this._lastCheckSyncResult = null;
        // 清除跨分頁節流快取
        storageAdapter.remove([WEBDAV_CROSS_TAB_CHECK_TIME_KEY, WEBDAV_CROSS_TAB_CHECK_RESULT_KEY]).catch(() => {});
    }

    async markLocalDataDirty(reason = 'local-update', details = null) {
        this.clearCache();
        this._initialHashCheckDone = false;
        const dirtyDetails = (details && typeof details === 'object') ? details : {};
        const dirtyMarker = {
            at: new Date().toISOString(),
            reason,
            ...dirtyDetails
        };
        await Promise.all([
            storageAdapter.set({
                [WEBDAV_LOCAL_DATA_DIRTY_KEY]: dirtyMarker
            }),
            this._markMetadataDirty(reason, dirtyMarker.at)
        ]);
    }

    async clearLocalDataDirty() {
        await storageAdapter.remove([WEBDAV_LOCAL_DATA_DIRTY_KEY]);
    }

    async getLocalDataDirtyMarker() {
        const result = await storageAdapter.get(WEBDAV_LOCAL_DATA_DIRTY_KEY);
        return result[WEBDAV_LOCAL_DATA_DIRTY_KEY] || null;
    }

    async hasLocalDataDirty() {
        return Boolean(await this.getLocalDataDirtyMarker());
    }

    async hasActiveStreams() {
        try {
            return await hasStoredActiveStreams(sessionStorageAdapter);
        } catch {
            return false;
        }
    }

    _hasApiSettingsSyncBaseline(metadataSyncState) {
        return hasSyncedMetadataBaseline(metadataSyncState?.apiSettings);
    }

    _resolveApiSettingsSyncPlan({
        dirtyMarker = null,
        metadataSyncState = null,
        manifest = null,
        localApiSettings = undefined
    } = {}) {
        return resolveApiSettingsSyncPlan({
            syncApiConfig: this.config.syncApiConfig,
            dirtyMarker,
            metadataSyncState,
            manifest,
            localApiSettings
        });
    }

    _normalizeSyncableApiSettings(raw) {
        return normalizeSyncableApiSettings(raw);
    }

    _buildApiSettingsRemoteRetryContext(dirtyMarker = null, {
        remoteEtag = undefined,
        preserveExistingRetryContext = false
    } = {}) {
        return buildApiSettingsRemoteRetryContext({
            dirtyMarker,
            encryptionPassword: this.config.encryptionPassword,
            remoteEtag,
            preserveExistingRetryContext
        });
    }

    _shouldAttemptApiSettingsRemoteRetry(dirtyMarker, {
        remoteEtag = null,
        allowManualRetry = false
    } = {}) {
        return shouldAttemptApiSettingsRemoteRetry(dirtyMarker, {
            encryptionPassword: this.config.encryptionPassword,
            remoteEtag,
            allowManualRetry
        });
    }

    async _loadStoredApiSettings() {
        const apiConfigResult = await syncStorageAdapter.get(API_SETTINGS_STORAGE_KEYS);
        return this._normalizeSyncableApiSettings(apiConfigResult);
    }

    async loadMetadataSyncState() {
        try {
            const result = await storageAdapter.get(WEBDAV_METADATA_SYNC_STATE_KEY);
            return normalizeMetadataSyncState(result[WEBDAV_METADATA_SYNC_STATE_KEY]);
        } catch {
            return createDefaultMetadataSyncState();
        }
    }

    async _markMetadataDirty(reason, modifiedAt) {
        const shouldTouchQuickChat = reason === 'quick-chat-options';
        const shouldTouchApiSettings = reason === 'api-config' || reason === 'search-settings';
        if (!shouldTouchQuickChat && !shouldTouchApiSettings) {
            return;
        }

        const nextState = await this.loadMetadataSyncState();
        if (shouldTouchQuickChat) {
            nextState.quickChatOptions.modifiedAt = modifiedAt;
        }
        if (shouldTouchApiSettings) {
            nextState.apiSettings.modifiedAt = modifiedAt;
        }
        await storageAdapter.set({ [WEBDAV_METADATA_SYNC_STATE_KEY]: nextState });
    }

    // ========== 目錄快取持久化 ==========

    async _loadKnownDirectories() {
        try {
            const result = await storageAdapter.get(WEBDAV_KNOWN_DIRS_KEY);
            return result[WEBDAV_KNOWN_DIRS_KEY] || [];
        } catch {
            return [];
        }
    }

    /**
     * 批次儲存同步完成後的所有狀態（合併 I/O，並行寫入 local 和 sync storage）
     * 將原本 6~7 次序列 IPC 合併為 2 次並行 IPC
     */
    async _batchSavePostSyncState({
        manifest,
        localChatHashes,
        tombstones = null,
        etag,
        localHash,
        lastSync,
        metadataSyncState = null,
        syncStorageData = null
    }) {
        let knownDirectories = [];
        try {
            knownDirectories = this.client ? [...this.client._knownDirectories] : [];
        } catch (e) {
            console.warn('[WebDAV] 序列化目錄快取失敗:', e);
        }
        await persistStorageBackedSyncState({
            localStorageArea: storageAdapter,
            syncStorageArea: syncStorageAdapter,
            manifest,
            localChatHashes,
            tombstones,
            etag,
            localHash,
            lastSync,
            metadataSyncState,
            syncStorageData,
            knownDirectories
        });
    }

    // ========== Manifest 快取 ==========

    async loadCachedManifest() {
        try {
            const result = await storageAdapter.get(WEBDAV_CACHED_MANIFEST_KEY);
            return result[WEBDAV_CACHED_MANIFEST_KEY] || null;
        } catch {
            return null;
        }
    }

    // ========== Per-Chat Hash Table ==========

    async loadLocalChatHashes() {
        try {
            const result = await storageAdapter.get(WEBDAV_LOCAL_CHAT_HASHES_KEY);
            const obj = result[WEBDAV_LOCAL_CHAT_HASHES_KEY];
            return obj ? new Map(Object.entries(obj)) : new Map();
        } catch {
            return new Map();
        }
    }

    async saveLocalChatHashes(hashMap) {
        try {
            await storageAdapter.set({
                [WEBDAV_LOCAL_CHAT_HASHES_KEY]: Object.fromEntries(hashMap)
            });
        } catch (e) {
            console.warn('[WebDAV] 儲存 local chat hashes 失敗:', e);
        }
    }

    _normalizeQuickChatOptions(options) {
        return Array.isArray(options) ? options : [];
    }

    _hashMetadataValue(value) {
        return computeStructuredHash(value === undefined ? null : value);
    }

    _pickNewerMetadataSource(localModifiedAt, remoteUpdatedAt) {
        const localMs = parseTimestampMs(localModifiedAt);
        const remoteMs = parseTimestampMs(remoteUpdatedAt);

        if (localMs !== null && remoteMs !== null) {
            return localMs >= remoteMs ? 'local' : 'remote';
        }
        if (localMs !== null) return 'local';
        if (remoteMs !== null) return 'remote';
        return 'remote';
    }

    _mergeMetadataValue({
        localValue,
        remoteValue,
        baseHash = null,
        localModifiedAt = null,
        remoteUpdatedAt = null,
        normalize = (value) => value
    }) {
        const normalizedLocal = normalize(localValue);
        const normalizedRemote = normalize(remoteValue);
        const localHash = this._hashMetadataValue(normalizedLocal);
        const remoteHash = this._hashMetadataValue(normalizedRemote);

        if (localHash === remoteHash) {
            return {
                value: normalizedLocal,
                source: 'same',
                updatedAt: remoteUpdatedAt || localModifiedAt || null,
                conflictResolved: false
            };
        }

        const localChanged = baseHash ? localHash !== baseHash : true;
        const remoteChanged = baseHash ? remoteHash !== baseHash : true;

        if (localChanged && !remoteChanged) {
            return {
                value: normalizedLocal,
                source: 'local',
                updatedAt: localModifiedAt || new Date().toISOString(),
                conflictResolved: false
            };
        }

        if (!localChanged && remoteChanged) {
            return {
                value: normalizedRemote,
                source: 'remote',
                updatedAt: remoteUpdatedAt || new Date().toISOString(),
                conflictResolved: false
            };
        }

        const winner = this._pickNewerMetadataSource(localModifiedAt, remoteUpdatedAt);
        if (winner === 'local') {
            return {
                value: normalizedLocal,
                source: 'local',
                updatedAt: localModifiedAt || new Date().toISOString(),
                conflictResolved: true
            };
        }

        return {
            value: normalizedRemote,
            source: 'remote',
            updatedAt: remoteUpdatedAt || new Date().toISOString(),
            conflictResolved: true
        };
    }

    // ========== Tombstone 管理 ==========

    async loadDeletedChatIds() {
        try {
            const result = await storageAdapter.get(WEBDAV_DELETED_CHAT_IDS_KEY);
            return sharedCleanTombstones(result[WEBDAV_DELETED_CHAT_IDS_KEY] || [], Number.POSITIVE_INFINITY);
        } catch {
            return [];
        }
    }

    async saveDeletedChatIds(tombstones) {
        await storageAdapter.set({
            [WEBDAV_DELETED_CHAT_IDS_KEY]: sharedCleanTombstones(tombstones, Number.POSITIVE_INFINITY)
        });
    }

    async addDeletedChatId(chatId) {
        await this.addDeletedChatIds([chatId]);
    }

    async addDeletedChatIds(chatIds) {
        const normalizedChatIds = [...new Set((Array.isArray(chatIds) ? chatIds : [chatIds]).filter(Boolean))];
        if (normalizedChatIds.length === 0) {
            return;
        }

        const tombstones = await this.loadDeletedChatIds();
        const tombstoneMap = new Map(
            tombstones
                .filter((tombstone) => tombstone?.id)
                .map((tombstone) => [tombstone.id, tombstone])
        );
        let changed = false;
        const deletedAt = new Date().toISOString();

        for (const chatId of normalizedChatIds) {
            if (tombstoneMap.has(chatId)) {
                continue;
            }
            tombstoneMap.set(chatId, { id: chatId, deletedAt });
            changed = true;
        }

        if (changed) {
            await this.saveDeletedChatIds([...tombstoneMap.values()]);
        }
    }

    async markOrphanCleanupPending() {
        try {
            await storageAdapter.set({ [WEBDAV_ORPHAN_CLEANUP_PENDING_KEY]: true });
        } catch (error) {
            console.warn('[WebDAV] 設定 orphan cleanup pending 失敗:', error);
        }
    }

    _getOrphanCleanupRuntimeConfig() {
        return {
            enabled: this.config.orphanCleanupEnabled !== false,
            cooldownMs: toPositiveInt(this.config.orphanCleanupCooldownMs, ORPHAN_CLEANUP_DEFAULT_COOLDOWN_MS),
            maxDeletesPerRun: toPositiveInt(this.config.orphanCleanupMaxDeletesPerRun, 20),
            deleteConcurrency: toPositiveInt(this.config.orphanCleanupDeleteConcurrency, 2)
        };
    }

    async _tryAcquireOrphanCleanupLock() {
        const now = Date.now();
        const lockResult = await storageAdapter.get(WEBDAV_ORPHAN_CLEANUP_LOCK_KEY);
        const existingLock = lockResult[WEBDAV_ORPHAN_CLEANUP_LOCK_KEY];
        const existingValid = existingLock &&
            typeof existingLock.expiresAt === 'number' &&
            existingLock.expiresAt > now;

        if (existingValid && existingLock.owner !== this._orphanCleanupOwnerId) {
            return false;
        }

        const nextLock = {
            owner: this._orphanCleanupOwnerId,
            expiresAt: now + ORPHAN_CLEANUP_LOCK_TTL_MS
        };
        await storageAdapter.set({ [WEBDAV_ORPHAN_CLEANUP_LOCK_KEY]: nextLock });

        const verify = await storageAdapter.get(WEBDAV_ORPHAN_CLEANUP_LOCK_KEY);
        return verify[WEBDAV_ORPHAN_CLEANUP_LOCK_KEY]?.owner === this._orphanCleanupOwnerId;
    }

    async _releaseOrphanCleanupLock() {
        try {
            const lockResult = await storageAdapter.get(WEBDAV_ORPHAN_CLEANUP_LOCK_KEY);
            const lock = lockResult[WEBDAV_ORPHAN_CLEANUP_LOCK_KEY];
            if (lock?.owner === this._orphanCleanupOwnerId) {
                await storageAdapter.remove([WEBDAV_ORPHAN_CLEANUP_LOCK_KEY]);
            }
        } catch (error) {
            console.warn('[WebDAV] 釋放 orphan cleanup lock 失敗:', error);
        }
    }

    async _runOrphanCleanupIfNeeded(latestManifest = null, options = {}) {
        if (!this.client) return;

        const { forceScan = false } = options;
        const runtimeConfig = this._getOrphanCleanupRuntimeConfig();
        if (!runtimeConfig.enabled) {
            return;
        }

        let lockAcquired = false;

        try {
            const stateResult = await storageAdapter.get([
                WEBDAV_ORPHAN_CLEANUP_PENDING_KEY,
                WEBDAV_ORPHAN_CLEANUP_LAST_SCAN_AT_KEY
            ]);
            const pending = stateResult[WEBDAV_ORPHAN_CLEANUP_PENDING_KEY] === true;
            if (!pending && !forceScan) {
                return;
            }

            const now = Date.now();
            const lastScanRaw = stateResult[WEBDAV_ORPHAN_CLEANUP_LAST_SCAN_AT_KEY];
            const lastScanMs = Date.parse(lastScanRaw || '');
            // 已明確標記 pending 的刪除應儘快處理；cooldown 只節流例行掃描。
            if (!pending && Number.isFinite(lastScanMs) && (now - lastScanMs) < runtimeConfig.cooldownMs) {
                return;
            }

            lockAcquired = await this._tryAcquireOrphanCleanupLock();
            if (!lockAcquired) {
                return;
            }

            const manifest = (latestManifest && Array.isArray(latestManifest.chatIndex))
                ? latestManifest
                : await this.loadCachedManifest();
            if (!manifest || !Array.isArray(manifest.chatIndex)) {
                console.warn('[WebDAV] orphan cleanup 略過：manifest 不可用');
                return;
            }

            // 只有仍存在於 manifest.chatIndex 的聊天檔應被保留。
            // tombstone 的用途是阻止已刪除聊天被其他裝置重新合併回來，
            // 不應該再阻止對應的 /chats/{id}.json 被清理掉。
            const keepSet = new Set(manifest.chatIndex.map(entry => entry.id));

            const remoteChatIds = await this.client.listJsonFilesInDirectory(SHARED_CHAT_DIRECTORY);
            const orphanIds = remoteChatIds.filter(chatId => !keepSet.has(chatId));
            const lastScanAtIso = new Date().toISOString();

            if (orphanIds.length === 0) {
                await storageAdapter.set({
                    [WEBDAV_ORPHAN_CLEANUP_PENDING_KEY]: false,
                    [WEBDAV_ORPHAN_CLEANUP_LAST_SCAN_AT_KEY]: lastScanAtIso
                });
                return;
            }

            const deleteTargets = orphanIds.slice(0, runtimeConfig.maxDeletesPerRun);
            const failedDeletes = new Set();
            const deleteTasks = deleteTargets.map(chatId => async () => {
                try {
                    await this.client.deleteFile(`${SHARED_CHAT_DIRECTORY}/${chatId}.json`);
                } catch (error) {
                    failedDeletes.add(chatId);
                    console.warn(`[WebDAV] orphan cleanup 刪除 ${chatId}.json 失敗:`, error);
                }
            });
            await sharedRunWithConcurrency(deleteTasks, runtimeConfig.deleteConcurrency);

            const hasMoreOrphans = orphanIds.length > deleteTargets.length;
            const hasFailedDeletes = failedDeletes.size > 0;
            await storageAdapter.set({
                [WEBDAV_ORPHAN_CLEANUP_PENDING_KEY]: hasMoreOrphans || hasFailedDeletes,
                [WEBDAV_ORPHAN_CLEANUP_LAST_SCAN_AT_KEY]: lastScanAtIso
            });
        } catch (error) {
            if (error?.code === 'PROPFIND_UNSUPPORTED') {
                console.warn('[WebDAV] orphan cleanup 略過：伺服器不支援 PROPFIND，已清除 pending');
                await storageAdapter.set({
                    [WEBDAV_ORPHAN_CLEANUP_PENDING_KEY]: false,
                    [WEBDAV_ORPHAN_CLEANUP_LAST_SCAN_AT_KEY]: new Date().toISOString()
                }).catch(() => {});
                return;
            }
            console.warn('[WebDAV] orphan cleanup 執行失敗，保留 pending 供下次重試:', error);
            await storageAdapter.set({ [WEBDAV_ORPHAN_CLEANUP_PENDING_KEY]: true }).catch(() => {});
        } finally {
            if (lockAcquired) {
                await this._releaseOrphanCleanupLock();
            }
        }
    }

    // ========== 按需下載單一聊天 ==========

    /**
     * 從 WebDAV 下載單一聊天檔案
     * @param {string} chatId - 聊天 ID
     * @returns {Promise<Object|null>} 聊天資料或 null
     */
    async downloadChatFile(chatId) {
        if (!this.config.enabled || !this.client) {
            return {
                ok: false,
                data: null,
                error: new Error(t('chat.remoteLoadFailed', { error: t('webdav.notEnabled') }))
            };
        }

        try {
            const result = await this.client.downloadData(`${SHARED_CHAT_DIRECTORY}/${chatId}.json`);
            if (!result.data) {
                return {
                    ok: false,
                    data: null,
                    error: new Error(t('chat.remoteLoadFailed', { error: t('webdav.remoteChatMissing') }))
                };
            }
            return {
                ok: true,
                data: result.data,
                error: null
            };
        } catch (error) {
            console.error(`[WebDAV] 下載聊天 ${chatId} 失敗:`, error);
            return {
                ok: false,
                data: null,
                error: new Error(t('chat.remoteLoadFailed', { error: error.message }))
            };
        }
    }

    /**
     * 初始化同步管理器
     */
    async initialize() {
        await this.loadConfig();
    }

    /**
     * 加载配置
     */
    async loadConfig() {
        try {
            if (isExtensionEnvironment) {
                // 同時讀取 local/sync 的配置，避免舊版本遺留造成模式與配置不一致
                const [flagResult, localResult, syncResult] = await Promise.all([
                    chrome.storage.local.get(SYNC_MODE_FLAG_KEY),
                    chrome.storage.local.get(WEBDAV_CONFIG_KEY),
                    chrome.storage.sync.get(WEBDAV_CONFIG_KEY)
                ]);
                const storedUseLocal = flagResult[SYNC_MODE_FLAG_KEY] === true;
                const localConfig = localResult[WEBDAV_CONFIG_KEY];
                const syncConfig = syncResult[WEBDAV_CONFIG_KEY];
                const preferredConfig = storedUseLocal ? (localConfig || syncConfig) : (syncConfig || localConfig);
                if (preferredConfig) {
                    this.config = { ...DEFAULT_CONFIG, ...preferredConfig };
                }

                const desiredUseLocal = this.config.enabled === true;
                if (storedUseLocal !== desiredUseLocal) {
                    console.warn(`[WebDAV] 检测到同步模式不一致：enabled=${this.config.enabled}, flag=${storedUseLocal}; 正在自动修复`);
                    await setSyncMode(desiredUseLocal, { cleanupSource: false, verifyAfterCopy: true });
                }
            } else {
                const result = await syncStorageAdapter.get(WEBDAV_CONFIG_KEY);
                if (result[WEBDAV_CONFIG_KEY]) {
                    this.config = { ...DEFAULT_CONFIG, ...result[WEBDAV_CONFIG_KEY] };
                }
            }

            // 从本地存储加载加密密码（不同步）
            const passwordResult = await storageAdapter.get('webdav_encryption_password');
            if (passwordResult.webdav_encryption_password) {
                const storedPassword = passwordResult.webdav_encryption_password;

                if (isEncryptedPassword(storedPassword)) {
                    try {
                        this.config.encryptionPassword = await decryptPasswordFromStorage(storedPassword);
                        console.log('[WebDAV] 加密密码已从加密存储中加载');
                    } catch (decryptError) {
                        console.error('[WebDAV] 解密加密密码失败:', decryptError);
                        this.config.encryptionPassword = '';
                    }
                } else {
                    console.warn('[WebDAV] 检测到明文存储的加密密码，建议重新设置');
                    this.config.encryptionPassword = storedPassword;
                }
            }

            // 從 storage 載入持久化的目錄快取，避免每次 session 重複 MKCOL
            this.client = new SharedWebDAVClient(this.config, await this._loadKnownDirectories());
        } catch (error) {
            console.error('加载 WebDAV 配置失败:', error);
        }
    }

    /**
     * 保存配置
     */
    async saveConfig(config) {
        const previousConfig = { ...this.config };
        const prevEnabled = this.config.enabled;
        const prevServerUrl = this.config.serverUrl;
        const prevSyncPath = this.config.syncPath;
        this.config = { ...this.config, ...config };

        // WebDAV 啟用狀態變更時切換 sync 模式
        const newEnabled = this.config.enabled;
        if (newEnabled !== prevEnabled) {
            await setSyncMode(newEnabled, { cleanupSource: false, verifyAfterCopy: true });
            console.log(`[WebDAV] Sync storage ${newEnabled ? '已切換至 local（Chrome Sync 已禁用）' : '已恢復 Chrome Sync'}`);
        }

        const configForSync = { ...this.config };
        delete configForSync.encryptionPassword;

        await syncStorageAdapter.set({ [WEBDAV_CONFIG_KEY]: configForSync });

        if (config.encryptionPassword !== undefined) {
            if (config.encryptionPassword && config.encryptionPassword.length > 0) {
                try {
                    const encryptedPassword = await encryptPasswordForStorage(config.encryptionPassword);
                    await storageAdapter.set({ webdav_encryption_password: encryptedPassword });
                    console.log('[WebDAV] 加密密码已加密存储');
                } catch (encryptError) {
                    console.error('[WebDAV] 加密存储密码失败:', encryptError);
                    await storageAdapter.set({ webdav_encryption_password: config.encryptionPassword });
                }
            } else {
                await storageAdapter.set({ webdav_encryption_password: '' });
            }
        }

        if (this.client) {
            this.client.updateConfig(this.config);
        } else {
            this.client = new SharedWebDAVClient(this.config);
        }

        // 路徑變更時清除持久化的目錄快取
        const pathChanged =
            (config.serverUrl !== undefined && config.serverUrl !== prevServerUrl) ||
            (config.syncPath !== undefined && config.syncPath !== prevSyncPath);
        if (pathChanged) {
            storageAdapter.set({ [WEBDAV_KNOWN_DIRS_KEY]: [] }).catch(() => {});
        }

        if (this._didApiSyncConfigChange(previousConfig, this.config)) {
            let shouldMarkDirty = false;
            let dirtyReason = API_SETTINGS_SYNC_CONFIG_DIRTY_REASON;

            const [dirtyMarker, metadataSyncState, cachedManifest, apiConfigResult] = await Promise.all([
                this.getLocalDataDirtyMarker(),
                this.loadMetadataSyncState(),
                this.loadCachedManifest(),
                syncStorageAdapter.get(API_SETTINGS_STORAGE_KEYS)
            ]);

            if (!this.config.syncApiConfig) {
                shouldMarkDirty = previousConfig.syncApiConfig &&
                    Boolean(cachedManifest?.apiSettings !== undefined || this._hasApiSettingsSyncBaseline(metadataSyncState));
            } else {
                const apiSettingsPlan = this._resolveApiSettingsSyncPlan({
                    dirtyMarker,
                    metadataSyncState,
                    manifest: cachedManifest,
                    localApiSettings: apiConfigResult
                });

                if (apiSettingsPlan.shouldRetryRemotePull) {
                    shouldMarkDirty = true;
                    dirtyReason = API_SETTINGS_REMOTE_RETRY_DIRTY_REASON;
                } else if (!this._hasApiSettingsSyncBaseline(metadataSyncState)) {
                    if (apiSettingsPlan.bootstrapSource === 'remote' ||
                        apiSettingsPlan.bootstrapSource === 'local') {
                        shouldMarkDirty = true;
                        dirtyReason = API_SETTINGS_BOOTSTRAP_DIRTY_REASON;
                    }
                } else if (apiSettingsPlan.hasLocalApiSettings || apiSettingsPlan.hasRemoteApiSettings) {
                    shouldMarkDirty = true;
                }
            }

            if (shouldMarkDirty) {
                await this.markLocalDataDirty(
                    dirtyReason,
                    dirtyReason === API_SETTINGS_REMOTE_RETRY_DIRTY_REASON
                        ? this._buildApiSettingsRemoteRetryContext(dirtyMarker, {
                            preserveExistingRetryContext: true
                        })
                        : null
                );
            }
        }
    }

    /**
     * 获取当前配置
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * 测试连接
     */
    async testConnection() {
        if (!this.client) {
            this.client = new SharedWebDAVClient(this.config);
        }
        return await this.client.testConnection();
    }

    /**
     * 执行同步 - 上传本地数据到远端（v2 格式：分檔上傳）
     */
    async syncToRemote(options = {}) {
        if (!this.config.enabled) {
            throw new Error(t('webdav.notEnabled'));
        }

        if (this._isEncryptionIncomplete()) {
            throw new Error(t('webdav.encryptionPasswordMissing'));
        }

        return this._runSyncOperation('upload', async () => {
            try {
            // 快照當前 dirty IDs，同步完成後只清除這些（保留同步期間新增的）
            const dirtySnapshot = new Set(chatManager.getDirtyChatIds());
            const dirtyMarker = await this.getLocalDataDirtyMarker();
            const hasDirtyLocalData = Boolean(dirtyMarker);

            const { data: localData, hash: localHash, chatIndex: prebuiltChatIndex, localChatHashes } =
                await this.getLocalSyncData();

            if (!localData) {
                throw new Error(t('webdav.localDataUnavailable'));
            }

            const chats = localData.chats || [];
            const localChatMap = new Map(
                chats
                    .filter(chat => chat?.id && !isRemoteCacheChat(chat))
                    .map(chat => [chat.id, chat])
            );

            // 載入上次的 manifest 以比對哪些聊天有變動
            const previousManifest = await this.loadCachedManifest();

            // 保留遠端已有但本地尚未下載的聊天索引
            const remoteOnlyEntries = (previousManifest?.chatIndex || [])
                .filter(entry => chats.some(c => c.id === entry.id && isRemoteCacheChat(c)));
            const hashResult = await syncStorageAdapter.get(WEBDAV_LOCAL_HASH_KEY);
            const lastLocalHash = hashResult[WEBDAV_LOCAL_HASH_KEY];
            const {
                initialChatIndex,
                uploadItems,
                tombstones,
                tombstonesChanged,
                noChanges
            } = buildManifestUploadPlan({
                initialChatIndex: [...prebuiltChatIndex, ...remoteOnlyEntries],
                candidateChatIndex: prebuiltChatIndex,
                previousManifest,
                tombstones: await this.loadDeletedChatIds(),
                tombstoneMaxAgeMs: TOMBSTONE_MAX_AGE_MS,
                localHash,
                lastLocalHash,
                getChatById: (chatId) => localChatMap.get(chatId) || null
            });
            const metadataSyncState = await this.loadMetadataSyncState();
            const apiSettingsPlan = this._resolveApiSettingsSyncPlan({
                dirtyMarker,
                metadataSyncState,
                manifest: previousManifest,
                localApiSettings: localData.apiSettings
            });
            let preserveRemoteApiSettingsDuringUpload =
                apiSettingsPlan.shouldBootstrapFromRemote ||
                apiSettingsPlan.shouldRetryRemotePull;
            const hasPendingMetadataChanges = Boolean(metadataSyncState.quickChatOptions.modifiedAt) ||
                apiSettingsPlan.hasPendingMetadataChanges;

            if (preserveRemoteApiSettingsDuringUpload &&
                uploadItems.length === 0 &&
                !tombstonesChanged &&
                !hasPendingMetadataChanges) {
                chatManager.clearDirtyChatIds(dirtySnapshot);
                return { success: true, message: t('webdav.noChanges'), timestamp: null };
            }

            // 短路：聊天/metadata/tombstone 均無變更 → 跳過上傳
            if (noChanges && !hasPendingMetadataChanges) {
                chatManager.clearDirtyChatIds(dirtySnapshot);
                if (hasDirtyLocalData && !preserveRemoteApiSettingsDuringUpload) {
                    await this.clearLocalDataDirty();
                }
                const lastSync = new Date().toISOString();
                await syncStorageAdapter.set({
                    [WEBDAV_LAST_SYNC_KEY]: lastSync
                });
                this.clearCache();
                this.notifyListeners('sync-complete', {
                    direction: 'upload',
                    timestamp: lastSync,
                    chatCount: initialChatIndex.length,
                    changedChatCount: 0,
                    includesApiConfig: false
                });
                return { success: true, message: t('webdav.noChanges'), timestamp: lastSync };
            }

            let quickChatOptionsForManifest;
            let quickChatOptionsUpdatedAt;
            let manifestApiSettings;
            let manifestApiSettingsEncrypted = false;
            let apiSettingsUpdatedAt = null;
            let apiConfigAttentionRequired = false;
            let apiConfigWarningMessage = null;
            let shouldKeepRemoteApiRetry = apiSettingsPlan.shouldRetryRemotePull;
            try {
                ({
                    quickChatOptionsForManifest,
                    quickChatOptionsUpdatedAt,
                    manifestApiSettings,
                    manifestApiSettingsEncrypted,
                    apiSettingsUpdatedAt
                } = await buildUploadMetadataPayload({
                    metadataSyncState,
                    previousManifest,
                    quickChatOptions: localData.quickChatOptions,
                    apiSettings: localData.apiSettings,
                    syncApiConfig: this.config.syncApiConfig,
                    encryptApiKeys: this.config.encryptApiKeys,
                    encryptionPassword: this.config.encryptionPassword,
                    encryptValue: encrypt,
                    forceWriteApiSettings: apiSettingsPlan.shouldForceWriteLocalApiSettings
                }));
                if (this.config.syncApiConfig &&
                    previousManifest?.apiSettings !== undefined &&
                    (apiSettingsPlan.hasPendingLocalApiSettingsChange ||
                        apiSettingsPlan.shouldForceWriteLocalApiSettings)) {
                    const resolvedRemoteApiSettings = await resolveManifestApiSettings(previousManifest, {
                        decryptValue: decrypt,
                        encryptionPassword: this.config.encryptionPassword,
                        suppressDecryptError: true
                    });

                    if (resolvedRemoteApiSettings.decryptError) {
                        apiConfigAttentionRequired = true;
                        apiConfigWarningMessage = resolvedRemoteApiSettings.decryptError.message;
                        shouldKeepRemoteApiRetry = true;
                        preserveRemoteApiSettingsDuringUpload = true;
                    }
                }
                if (preserveRemoteApiSettingsDuringUpload && previousManifest?.apiSettings !== undefined) {
                    manifestApiSettings = previousManifest.apiSettings;
                    manifestApiSettingsEncrypted = Boolean(previousManifest.apiSettingsEncrypted);
                    apiSettingsUpdatedAt = previousManifest.apiSettingsUpdatedAt ||
                        previousManifest.timestamp ||
                        metadataSyncState.apiSettings.lastSyncedAt ||
                        null;
                }
                if (manifestApiSettingsEncrypted) {
                    console.log('[WebDAV] API 配置已加密');
                }
            } catch (encryptError) {
                if (this.config.syncApiConfig && localData.apiSettings && this.config.encryptApiKeys) {
                    console.error('[WebDAV] 加密 API 配置失败:', encryptError);
                    throw new Error(t('webdav.encryptApiConfigFailed', { error: encryptError.message }));
                }
                throw encryptError;
            }

            const { manifest, uploadResult, persistedTombstones } = await uploadManifestSnapshot({
                client: this.client,
                initialChatIndex,
                uploadItems,
                tombstones,
                quickChatOptions: quickChatOptionsForManifest,
                quickChatOptionsUpdatedAt,
                apiSettings: manifestApiSettings,
                apiSettingsEncrypted: manifestApiSettingsEncrypted,
                apiSettingsUpdatedAt,
                uploadConcurrency: SHARED_UPLOAD_CONCURRENCY
            });

            // 清除同步開始時快照的 dirty flags（保留同步期間新增的，fire-and-forget）
            chatManager.clearDirtyChatIds(dirtySnapshot);

            // 一次性批次儲存所有同步狀態（合併 6 次序列 IPC → 2 次並行 IPC）
            const newETag = uploadResult.etag;
            const lastSync = new Date().toISOString();
            const syncedMetadataState = buildSyncedMetadataSyncState({
                quickChatOptions: quickChatOptionsForManifest,
                quickChatOptionsUpdatedAt: manifest.quickChatOptionsUpdatedAt || quickChatOptionsUpdatedAt || manifest.timestamp,
                apiSettings: this.config.syncApiConfig ? localData.apiSettings : undefined,
                apiSettingsUpdatedAt: this.config.syncApiConfig
                    ? (manifest.apiSettingsUpdatedAt || apiSettingsUpdatedAt || manifest.timestamp)
                    : null
            });
            if (preserveRemoteApiSettingsDuringUpload) {
                syncedMetadataState.apiSettings = metadataSyncState.apiSettings;
            }
            await this._batchSavePostSyncState({
                manifest,
                localChatHashes,
                tombstones: persistedTombstones,
                etag: newETag || `__needs_refresh_${Date.now()}`,
                localHash,
                lastSync,
                metadataSyncState: syncedMetadataState
            });
            if (shouldKeepRemoteApiRetry) {
                await this.markLocalDataDirty(
                    API_SETTINGS_REMOTE_RETRY_DIRTY_REASON,
                    this._buildApiSettingsRemoteRetryContext(dirtyMarker, {
                        remoteEtag: newETag || null
                    })
                );
            } else if (!preserveRemoteApiSettingsDuringUpload) {
                await this.clearLocalDataDirty();
            }
            await this._runOrphanCleanupIfNeeded(manifest);

            this.notifyListeners('sync-complete', {
                direction: 'upload',
                timestamp: lastSync,
                chatCount: manifest.chatIndex.length,
                changedChatCount: uploadItems.length,
                includesApiConfig: this.config.syncApiConfig && !preserveRemoteApiSettingsDuringUpload,
                apiConfigAttentionRequired
            });

            let message = `已上传 ${manifest.chatIndex.length} 个对话`;
            if (uploadItems.length < manifest.chatIndex.length) {
                message += `（${uploadItems.length} 个有变更）`;
            }
            if (this.config.syncApiConfig && !preserveRemoteApiSettingsDuringUpload) {
                message += '<br>（含 API 配置）';
            }
            if (apiConfigAttentionRequired) {
                message += '<br>（远端 API 配置暂未套用，待提供正确密码后重试）';
            }

            this.clearCache();

            return {
                success: true,
                message,
                timestamp: lastSync,
                apiConfigAttentionRequired,
                apiConfigWarningMessage
            };
        } catch (error) {
            this.notifyListeners('sync-error', { direction: 'upload', error: error.message });
            throw error;
        }
        });
    }

    async runOrphanCleanupOnOpen() {
        if (!this.config.enabled || !this.client) {
            return { skipped: true, reason: 'disabled' };
        }

        await this._runOrphanCleanupIfNeeded(null, { forceScan: true });
        return { skipped: false };
    }

    /**
     * 从远端下载数据到本地（v2 格式：只下載 manifest，聊天按需載入）
     * @param {Object} options - 选项
     * @param {string} options.currentChatId - 當前聊天 ID（會立刻下載）
     */
    async syncFromRemote(options = {}) {
        if (!this.config.enabled) {
            throw new Error(t('webdav.notEnabled'));
        }

        if (this._isEncryptionIncomplete()) {
            throw new Error(t('webdav.encryptionPasswordMissing'));
        }

        return this._runSyncOperation('download', async () => {
            try {
            // 快照當前 dirty IDs，同步完成後只清除這些（保留同步期間新增的）
            const dirtySnapshot = new Set(chatManager.getDirtyChatIds());

            const currentChatId = options.currentChatId || null;
            let currentRemoteChatRequest = null;
            const loadCurrentRemoteChat = async () => {
                if (!currentChatId) {
                    return { data: null, etag: null, error: null };
                }
                if (!currentRemoteChatRequest) {
                    currentRemoteChatRequest = this.client
                        .downloadData(`${SHARED_CHAT_DIRECTORY}/${currentChatId}.json`)
                        .catch((error) => {
                            console.warn(`[WebDAV] 当前聊天 ${currentChatId} 下载失敗:`, error);
                            return { data: null, etag: null, error };
                        });
                }
                return await currentRemoteChatRequest;
            };

            const downloadResult = await this.client.downloadData('cerebr.json');
            const syncData = downloadResult.data;
            const downloadETag = downloadResult.etag;

            if (!syncData) {
                throw new Error(t('webdav.remoteDataMissing'));
            }

            if (!Array.isArray(syncData.chatIndex)) {
                throw new Error(t('webdav.syncDataInvalid'));
            }

            // 載入本地聊天以進行比對（從 ChatManager 記憶體讀取，無 I/O）
            const localChats = chatManager.getAllChatsArray();
            const localChatMap = new Map(localChats.map(c => [c.id, c]));
            const localQuickChatResult = await syncStorageAdapter.get('quickChatOptions');
            const localQuickChatOptions = this._normalizeQuickChatOptions(localQuickChatResult.quickChatOptions);
            const localApiSettings = this.config.syncApiConfig
                ? await this._loadStoredApiSettings()
                : undefined;
            const dirtyMarker = await this.getLocalDataDirtyMarker();
            const metadataSyncState = await this.loadMetadataSyncState();
            const apiSettingsPlan = this._resolveApiSettingsSyncPlan({
                dirtyMarker,
                metadataSyncState,
                manifest: syncData,
                localApiSettings
            });

            // 載入 per-chat hash table（用查表取代重新計算 hash）
            const localChatHashes = await this.loadLocalChatHashes();

            // 處理 tombstone 刪除
            const remoteTombstones = sharedCleanTombstones(getManifestDeletedChatIds(syncData), TOMBSTONE_MAX_AGE_MS);
            const deletedIds = new Set(remoteTombstones.map((tombstone) => tombstone.id));

            // 建立合併後的聊天列表
            const mergedChats = [];
            const dirtyIds = new Set();
            const updatedHashes = new Map(localChatHashes);
            const remoteEntryIds = new Set();

            for (const entry of syncData.chatIndex) {
                if (deletedIds.has(entry.id)) {
                    updatedHashes.delete(entry.id);
                    continue;
                }
                remoteEntryIds.add(entry.id);

                const localChat = localChatMap.get(entry.id);
                const hasLocalFull = localChat && !localChat._remoteOnly;
                const hydratedState = localChat?._webdavHydrated
                    ? getHydratedChatSyncState(localChat)
                    : null;
                // 用 stored hash 比對（不重新計算），比原來更正確：
                // stored hash 代表上次同步狀態，若 remote hash 相同代表遠端沒變，保留本地版本
                const storedHash = localChatHashes.get(entry.id);
                const hashMatch = hasLocalFull && (
                    hydratedState
                        ? hydratedState.isRemoteCache && hydratedState.hash === entry.hash
                        : (storedHash && storedHash === entry.hash)
                );

                // hash 相同，保留本地版本
                if (hashMatch) {
                    mergedChats.push(localChat);
                    updatedHashes.set(entry.id, entry.hash);
                    continue;
                }

                // 需要遠端資料：當前聊天才抓正文，其他聊天先建立空殼
                if (entry.id === currentChatId) {
                    const currentRemoteChat = await loadCurrentRemoteChat();
                    if (currentRemoteChat.data) {
                        mergedChats.push(buildHydratedRemoteChat(currentRemoteChat.data, entry));
                        dirtyIds.add(entry.id);
                        updatedHashes.set(entry.id, entry.hash);
                        continue;
                    }
                    if (currentRemoteChat.error) {
                        throw new Error(`当前聊天 ${entry.id} 远端数据下载失败，已中止本次同步：${currentRemoteChat.error.message}`);
                    }
                    throw new Error(`当前聊天 ${entry.id} 远端数据缺失，已中止本次同步`);
                }

                mergedChats.push(buildRemoteOnlyStub(entry));
                updatedHashes.set(entry.id, entry.hash);
            }

            // 保留本地獨有的聊天（遠端 chatIndex 中不存在且未被刪除）
            for (const localChat of localChats) {
                if (!remoteEntryIds.has(localChat.id) && !deletedIds.has(localChat.id) && !isRemoteCacheChat(localChat)) {
                    mergedChats.push(localChat);
                }
            }

            // 清理 hash table 中已刪除但不在 chatIndex 中的聊天（邊際情況：遠端已移除的 tombstone）
            for (const id of deletedIds) {
                updatedHashes.delete(id);
            }

            // 構建合併後的 chatIndex（供 overall hash 計算，排除 _remoteOnly 空殼）
            const mergedChatIndex = mergedChats
                .filter(c => !isRemoteCacheChat(c))
                .map(c => buildHashedChatIndexEntry(c, updatedHashes.get(c.id)));

            // 儲存合併後的聊天到本地（per-chat key-value 格式）
            await chatManager.replaceAllChats(mergedChats, dirtyIds);

            // 恢復快速選項
            const hasRemoteQuickChatOptions = Array.isArray(syncData.quickChatOptions);
            const effectiveQuickChatOptions = hasRemoteQuickChatOptions
                ? syncData.quickChatOptions
                : localQuickChatOptions;

            // 同步 API 配置
            let apiConfigSynced = false;
            let apiConfigAttentionRequired = false;
            let apiConfigWarningMessage = null;
            let effectiveApiSettings = undefined;
            let shouldKeepRemoteApiRetry = false;
            const syncMetadataUpdates = {};
            if (hasRemoteQuickChatOptions) {
                syncMetadataUpdates.quickChatOptions = effectiveQuickChatOptions;
            }
            if (this.config.syncApiConfig && apiSettingsPlan.shouldBootstrapFromLocal) {
                effectiveApiSettings = localApiSettings;
            } else if (this.config.syncApiConfig) {
                const resolvedRemoteApiSettings = await resolveManifestApiSettings(syncData, {
                    decryptValue: decrypt,
                    encryptionPassword: this.config.encryptionPassword,
                    suppressDecryptError: true
                });

                if (resolvedRemoteApiSettings.decryptError) {
                    effectiveApiSettings = localApiSettings;
                    apiConfigAttentionRequired = true;
                    apiConfigWarningMessage = resolvedRemoteApiSettings.decryptError.message;
                    shouldKeepRemoteApiRetry = syncData.apiSettings !== undefined;
                } else {
                    effectiveApiSettings = resolvedRemoteApiSettings.value;
                    Object.assign(syncMetadataUpdates, buildApiSettingsStoragePayload(effectiveApiSettings));
                    apiConfigSynced = true;
                }
            }

            // 清除同步開始時快照的 dirty flags（保留同步期間新增的，fire-and-forget）
            chatManager.clearDirtyChatIds(dirtySnapshot);

            // 清除本地數據快取
            this.clearCache();

            // 直接計算 post-sync overall hash（使用記憶體中的 mergedChatIndex，避免冗餘 I/O）
            const postSyncApiSettings = effectiveApiSettings;
            const localHash = this._computeOverallHash(mergedChatIndex, effectiveQuickChatOptions, postSyncApiSettings);

            // 一次性批次儲存所有同步狀態（合併 5 次序列 IPC → 2 次並行 IPC）
            const lastSync = new Date().toISOString();
            const syncedMetadataState = buildSyncedMetadataSyncState({
                quickChatOptions: effectiveQuickChatOptions,
                quickChatOptionsUpdatedAt: hasRemoteQuickChatOptions
                    ? (syncData.quickChatOptionsUpdatedAt || syncData.timestamp || lastSync)
                    : metadataSyncState.quickChatOptions.lastSyncedAt,
                apiSettings: this.config.syncApiConfig ? postSyncApiSettings : undefined,
                apiSettingsUpdatedAt: apiConfigSynced
                    ? (syncData.apiSettingsUpdatedAt || syncData.timestamp || lastSync)
                    : (this.config.syncApiConfig ? metadataSyncState.apiSettings.lastSyncedAt : null)
            });
            const shouldPreservePendingApiBootstrap = apiSettingsPlan.shouldBootstrapFromLocal;
            if (apiConfigAttentionRequired || shouldPreservePendingApiBootstrap || shouldKeepRemoteApiRetry) {
                syncedMetadataState.apiSettings = metadataSyncState.apiSettings;
            }
            await this._batchSavePostSyncState({
                manifest: syncData,
                localChatHashes: updatedHashes,
                tombstones: remoteTombstones,
                etag: downloadETag || `__needs_refresh_${Date.now()}`,
                localHash,
                lastSync,
                metadataSyncState: syncedMetadataState,
                syncStorageData: Object.keys(syncMetadataUpdates).length > 0 ? syncMetadataUpdates : null
            });
            if (shouldKeepRemoteApiRetry) {
                await this.markLocalDataDirty(
                    API_SETTINGS_REMOTE_RETRY_DIRTY_REASON,
                    this._buildApiSettingsRemoteRetryContext(dirtyMarker, {
                        remoteEtag: downloadETag || null
                    })
                );
            } else if (!shouldPreservePendingApiBootstrap) {
                await this.clearLocalDataDirty();
            }

            const remoteOnlyCount = mergedChats.filter(c => c._remoteOnly).length;
            this.notifyListeners('sync-complete', {
                direction: 'download',
                timestamp: lastSync,
                chatCount: syncData.chatIndex.length,
                remoteOnlyCount,
                apiConfigSynced,
                apiConfigAttentionRequired
            });

            let message = `已下载 ${syncData.chatIndex.length} 个对话索引`;
            if (apiConfigSynced) {
                message += '<br>（含 API 配置）';
            } else if (apiConfigAttentionRequired) {
                message += '<br>（远端 API 配置暂未套用，待提供正确密码后重试）';
            }

            return {
                success: true,
                message,
                timestamp: lastSync,
                needsReload: true,
                apiConfigSynced,
                apiConfigAttentionRequired,
                apiConfigWarningMessage
            };
        } catch (error) {
            this.notifyListeners('sync-error', { direction: 'download', error: error.message });
            throw error;
        }
        });
    }

    /**
     * 雙向智能合併同步
     * 當本地和遠端都有變更（衝突）時，按 per-chat hash 做三方比對自動合併
     * @param {Object} options
     * @param {string} options.currentChatId - 當前聊天 ID（會立刻下載）
     * @returns {Promise<Object>} { success, message, needsReload, uploadCount, downloadCount, conflictCount }
     */
    async bidirectionalSync(options = {}) {
        if (!this.config.enabled) {
            throw new Error(t('webdav.notEnabled'));
        }

        return this._runSyncOperation('merge', async () => {
            try {
            // 1. 快照當前 dirty IDs
            const dirtySnapshot = new Set(chatManager.getDirtyChatIds());
            const dirtyMarker = await this.getLocalDataDirtyMarker();
            const currentChatId = options.currentChatId || null;
            let currentRemoteChatRequest = null;
            const loadCurrentRemoteChat = async () => {
                if (!currentChatId) {
                    return { data: null, etag: null, error: null };
                }
                if (!currentRemoteChatRequest) {
                    currentRemoteChatRequest = this.client
                        .downloadData(`${SHARED_CHAT_DIRECTORY}/${currentChatId}.json`)
                        .catch((error) => {
                            console.warn(`[WebDAV] 当前聊天 ${currentChatId} 下载失敗:`, error);
                            return { data: null, etag: null, error };
                        });
                }
                return await currentRemoteChatRequest;
            };

            // 2. 下載 remote manifest（當前聊天正文改為真正需要時再抓）
            const downloadResult = await this.client.downloadData('cerebr.json');
            const remoteManifest = downloadResult.data;
            const downloadETag = downloadResult.etag;

            if (!remoteManifest || !Array.isArray(remoteManifest.chatIndex)) {
                throw new Error(t('webdav.remoteSyncDataInvalid'));
            }

            // 3. 取得本地資料、chatIndex
            const { data: localData, chatIndex: localChatIndex } =
                await this.getLocalSyncData();

            if (!localData) {
                throw new Error(t('webdav.localDataUnavailable'));
            }

            const localChats = localData.chats || [];
            const localChatMap = new Map(localChats.map(c => [c.id, c]));
            const localIndexMap = new Map(localChatIndex.map(e => [e.id, e]));

            // 4. 取得 baseHashes（上次同步時的狀態）
            const baseHashes = await this.loadLocalChatHashes();
            const metadataSyncState = await this.loadMetadataSyncState();
            const localQuickChatOptions = this._normalizeQuickChatOptions(localData.quickChatOptions);
            const remoteQuickChatOptions = this._normalizeQuickChatOptions(remoteManifest.quickChatOptions);
            const quickChatMerge = this._mergeMetadataValue({
                localValue: localQuickChatOptions,
                remoteValue: remoteQuickChatOptions,
                baseHash: metadataSyncState.quickChatOptions.baseHash,
                localModifiedAt: metadataSyncState.quickChatOptions.modifiedAt,
                remoteUpdatedAt: remoteManifest.quickChatOptionsUpdatedAt || remoteManifest.timestamp,
                normalize: (value) => this._normalizeQuickChatOptions(value)
            });
            let effectiveApiSettings = undefined;
            let apiConfigAttentionRequired = false;
            let apiConfigWarningMessage = null;
            let apiSettingsMerge = {
                value: undefined,
                source: 'disabled',
                updatedAt: null,
                conflictResolved: false
            };
            let manifestApiSettings = undefined;
            let manifestApiSettingsEncrypted = false;
            let manifestApiSettingsUpdatedAt = null;
            let shouldKeepRemoteApiRetry = false;
            if (this.config.syncApiConfig) {
                const localApiSettings = this._normalizeSyncableApiSettings(localData.apiSettings);
                const apiSettingsPlan = this._resolveApiSettingsSyncPlan({
                    dirtyMarker,
                    metadataSyncState,
                    manifest: remoteManifest,
                    localApiSettings
                });

                if (apiSettingsPlan.shouldBootstrapFromLocal) {
                    apiSettingsMerge = {
                        value: localApiSettings,
                        source: 'local',
                        updatedAt: metadataSyncState.apiSettings.modifiedAt ||
                            new Date().toISOString(),
                        conflictResolved: false
                    };
                    effectiveApiSettings = localApiSettings;
                } else {
                    const resolvedRemoteApiSettings = await resolveManifestApiSettings(remoteManifest, {
                        decryptValue: decrypt,
                        encryptionPassword: this.config.encryptionPassword,
                        suppressDecryptError: true
                    });

                    if (resolvedRemoteApiSettings.decryptError) {
                        effectiveApiSettings = localApiSettings;
                        apiConfigAttentionRequired = true;
                        apiConfigWarningMessage = resolvedRemoteApiSettings.decryptError.message;
                        shouldKeepRemoteApiRetry = remoteManifest.apiSettings !== undefined;
                        apiSettingsMerge = {
                            value: localApiSettings,
                            source: 'preserve-remote',
                            updatedAt: remoteManifest.apiSettingsUpdatedAt ||
                                remoteManifest.timestamp ||
                                metadataSyncState.apiSettings.lastSyncedAt ||
                                null,
                            conflictResolved: false
                        };
                        manifestApiSettings = remoteManifest.apiSettings;
                        manifestApiSettingsEncrypted = Boolean(remoteManifest.apiSettingsEncrypted);
                        manifestApiSettingsUpdatedAt = remoteManifest.apiSettingsUpdatedAt || remoteManifest.timestamp || null;
                    } else if (apiSettingsPlan.shouldBootstrapFromRemote) {
                        apiSettingsMerge = {
                            value: resolvedRemoteApiSettings.value,
                            source: 'remote',
                            updatedAt: remoteManifest.apiSettingsUpdatedAt ||
                                remoteManifest.timestamp ||
                                new Date().toISOString(),
                            conflictResolved: false
                        };
                        effectiveApiSettings = resolvedRemoteApiSettings.value;
                    } else {
                        apiSettingsMerge = this._mergeMetadataValue({
                            localValue: localApiSettings,
                            remoteValue: resolvedRemoteApiSettings.value,
                            baseHash: metadataSyncState.apiSettings.baseHash,
                            localModifiedAt: metadataSyncState.apiSettings.modifiedAt,
                            remoteUpdatedAt: remoteManifest.apiSettingsUpdatedAt || remoteManifest.timestamp,
                            normalize: (value) => value === undefined ? undefined : this._normalizeSyncableApiSettings(value)
                        });
                        effectiveApiSettings = apiSettingsMerge.value;
                    }
                }
            }

            // 5. 合併 tombstones（本地 + 遠端取聯集，by id 去重保留較新的 deletedAt）
            const localTombstones = sharedCleanTombstones(await this.loadDeletedChatIds(), TOMBSTONE_MAX_AGE_MS);
            const remoteTombstones = sharedCleanTombstones(getManifestDeletedChatIds(remoteManifest), TOMBSTONE_MAX_AGE_MS);
            const mergedTombstones = sharedCleanTombstones(
                [...localTombstones, ...remoteTombstones],
                TOMBSTONE_MAX_AGE_MS
            );
            const deletedIds = new Set(mergedTombstones.map(t => t.id));

            // 6. 遍歷所有 chatId（本地 ∪ 遠端），分類處理
            const remoteChatIndexMap = new Map(
                remoteManifest.chatIndex.map(e => [e.id, e])
            );
            const allChatIds = new Set([
                ...localChatIndex.map(e => e.id),
                ...remoteManifest.chatIndex.map(e => e.id)
            ]);

            const mergedChats = [];
            const manifestChatIndex = [];
            const uploadItems = [];
            let downloadCount = 0;
            let conflictCount = 0;

            // 取得遠端聊天：僅當前聊天在必要時抓正文，其餘建立 stub
            const dirtyIds = new Set();
            const pickRemoteChat = async (entry) => {
                if (entry.id === currentChatId) {
                    const currentRemoteChat = await loadCurrentRemoteChat();
                    if (currentRemoteChat.data) {
                        dirtyIds.add(entry.id);
                        return {
                            chat: buildHydratedRemoteChat(currentRemoteChat.data, entry),
                            manifestEntry: entry,
                            downloaded: true
                        };
                    }
                    if (currentRemoteChat.error) {
                        throw new Error(`当前聊天 ${entry.id} 远端数据下载失败，已中止本次同步：${currentRemoteChat.error.message}`);
                    }
                    throw new Error(`当前聊天 ${entry.id} 远端数据缺失，已中止本次同步`);
                }

                return {
                    chat: buildRemoteOnlyStub(entry),
                    manifestEntry: entry,
                    downloaded: true
                };
            };

            for (const chatId of allChatIds) {
                if (deletedIds.has(chatId)) continue;

                const localEntry = localIndexMap.get(chatId);
                const remoteEntry = remoteChatIndexMap.get(chatId);
                const localChat = localChatMap.get(chatId);
                const hasLocalFull = localChat && !localChat._remoteOnly;

                const baseHash = baseHashes.get(chatId);
                const localHash = localEntry?.hash || null;
                const remoteHash = remoteEntry?.hash || null;

                if (localEntry && !remoteEntry) {
                    // 僅本地有 → 上傳
                    if (hasLocalFull) {
                        mergedChats.push(localChat);
                        manifestChatIndex.push(localEntry);
                        uploadItems.push({ chat: localChat, entry: localEntry });
                    }
                } else if (!localEntry && remoteEntry) {
                    // 僅遠端有 → 下載 stub（currentChat 真正需要時才抓正文）
                    const remoteSelection = await pickRemoteChat(remoteEntry);
                    mergedChats.push(remoteSelection.chat);
                    manifestChatIndex.push(remoteSelection.manifestEntry);
                    if (remoteSelection.downloaded) {
                        downloadCount++;
                    }
                } else if (localEntry && remoteEntry) {
                    // 兩邊都有 → 三方比對
                    if (baseHash === localHash && baseHash === remoteHash) {
                        // (a) 無變更，保留本地
                        if (hasLocalFull) {
                            mergedChats.push(localChat);
                        } else {
                            mergedChats.push(buildRemoteOnlyStub(remoteEntry));
                        }
                        manifestChatIndex.push(localEntry);
                    } else if (baseHash !== localHash && baseHash === remoteHash) {
                        // (b) 僅本地改 → 上傳
                        if (hasLocalFull) {
                            mergedChats.push(localChat);
                            manifestChatIndex.push(localEntry);
                            uploadItems.push({ chat: localChat, entry: localEntry });
                        } else {
                            mergedChats.push(buildRemoteOnlyStub(remoteEntry));
                            manifestChatIndex.push(remoteEntry);
                        }
                    } else if (baseHash === localHash && baseHash !== remoteHash) {
                        // (c) 僅遠端改 → 下載 stub
                        const remoteSelection = await pickRemoteChat(remoteEntry);
                        mergedChats.push(remoteSelection.chat);
                        manifestChatIndex.push(remoteSelection.manifestEntry);
                        if (remoteSelection.downloaded) {
                            downloadCount++;
                        }
                    } else {
                        // (d) 兩邊都改 或 (e) baseHash 不存在 → updatedAt 較新者勝出
                        const localUpdatedAt = localEntry.updatedAt || '';
                        const remoteUpdatedAt = remoteEntry.updatedAt || '';
                        const localNewer = localUpdatedAt >= remoteUpdatedAt;

                        conflictCount++;
                        if (localNewer) {
                            // 本地較新 → 上傳
                            if (hasLocalFull) {
                                mergedChats.push(localChat);
                                manifestChatIndex.push(localEntry);
                                uploadItems.push({ chat: localChat, entry: localEntry });
                            } else {
                                mergedChats.push(buildRemoteOnlyStub(remoteEntry));
                                manifestChatIndex.push(remoteEntry);
                            }
                        } else {
                            // 遠端較新 → 下載 stub
                            const remoteSelection = await pickRemoteChat(remoteEntry);
                            mergedChats.push(remoteSelection.chat);
                            manifestChatIndex.push(remoteSelection.manifestEntry);
                            if (remoteSelection.downloaded) {
                                downloadCount++;
                            }
                        }
                    }
                }
            }

            if (quickChatMerge.conflictResolved) {
                conflictCount++;
            }
            if (apiSettingsMerge.conflictResolved) {
                conflictCount++;
            }

            let quickChatOptionsSynced = false;
            const syncMetadataUpdates = {};
            if (quickChatMerge.source === 'remote') {
                syncMetadataUpdates.quickChatOptions = quickChatMerge.value;
                quickChatOptionsSynced = true;
            }

            let apiConfigSynced = false;
            if (this.config.syncApiConfig && apiSettingsMerge.source === 'remote') {
                Object.assign(syncMetadataUpdates, buildApiSettingsStoragePayload(effectiveApiSettings));
                apiConfigSynced = true;
            }

            if (this.config.syncApiConfig &&
                manifestApiSettings === undefined &&
                apiSettingsMerge.source !== 'disabled' &&
                apiSettingsMerge.source !== 'preserve-remote') {
                manifestApiSettings = effectiveApiSettings;
                manifestApiSettingsUpdatedAt = apiSettingsMerge.updatedAt;
                if (manifestApiSettings !== undefined && this.config.encryptApiKeys && this.config.encryptionPassword) {
                    try {
                        manifestApiSettings = await encrypt(effectiveApiSettings, this.config.encryptionPassword);
                        manifestApiSettingsEncrypted = true;
                    } catch (encryptError) {
                        console.error('[WebDAV] 加密 API 配置失败:', encryptError);
                        throw new Error(t('webdav.encryptApiConfigFailed', { error: encryptError.message }));
                    }
                }
            }

            const { manifest, uploadResult, persistedTombstones } = await uploadManifestSnapshot({
                client: this.client,
                initialChatIndex: manifestChatIndex,
                uploadItems,
                tombstones: mergedTombstones,
                quickChatOptions: quickChatMerge.value,
                quickChatOptionsUpdatedAt: quickChatMerge.updatedAt,
                apiSettings: manifestApiSettings,
                apiSettingsEncrypted: manifestApiSettingsEncrypted,
                apiSettingsUpdatedAt: this.config.syncApiConfig
                    ? (manifestApiSettingsUpdatedAt || apiSettingsMerge.updatedAt)
                    : null,
                uploadConcurrency: SHARED_UPLOAD_CONCURRENCY
            });

            // 12. 更新本地狀態
            // 儲存合併後的聊天到本地（關鍵數據寫入，須先完成）
            await chatManager.replaceAllChats(mergedChats, dirtyIds);

            // 清除同步開始時快照的 dirty flags（fire-and-forget）
            chatManager.clearDirtyChatIds(dirtySnapshot);

            // 清除本地數據快取
            this.clearCache();
            this._lastCheckSyncResult = null;

            // 使用合併後的 index hash 建立 hash table
            const updatedHashes = new Map();
            for (const entry of manifest.chatIndex) {
                updatedHashes.set(entry.id, entry.hash);
            }

            const localHashChatIndex = mergedChats
                .filter((chat) => !isRemoteCacheChat(chat))
                .map((chat) => buildHashedChatIndexEntry(chat, updatedHashes.get(chat.id)));

            // 直接計算 post-sync overall hash（零 I/O：使用記憶體中的 localHashChatIndex）
            const localHash = this._computeOverallHash(
                localHashChatIndex,
                quickChatMerge.value,
                effectiveApiSettings
            );

            // 一次性批次儲存所有同步狀態（合併 7 次序列 IPC → 2 次並行 IPC）
            const newETag = uploadResult.etag || downloadETag;
            const lastSync = new Date().toISOString();
            const syncedMetadataState = buildSyncedMetadataSyncState({
                quickChatOptions: quickChatMerge.value,
                quickChatOptionsUpdatedAt: manifest.quickChatOptionsUpdatedAt || quickChatMerge.updatedAt || manifest.timestamp,
                apiSettings: this.config.syncApiConfig ? effectiveApiSettings : undefined,
                apiSettingsUpdatedAt: this.config.syncApiConfig
                    ? (manifest.apiSettingsUpdatedAt || apiSettingsMerge.updatedAt || manifest.timestamp)
                    : null
            });
            if ((apiConfigAttentionRequired && apiSettingsMerge.source === 'preserve-remote') ||
                shouldKeepRemoteApiRetry) {
                syncedMetadataState.apiSettings = metadataSyncState.apiSettings;
            }
            await this._batchSavePostSyncState({
                manifest,
                localChatHashes: updatedHashes,
                tombstones: persistedTombstones,
                etag: newETag || `__needs_refresh_${Date.now()}`,
                localHash,
                lastSync,
                metadataSyncState: syncedMetadataState,
                syncStorageData: Object.keys(syncMetadataUpdates).length > 0 ? syncMetadataUpdates : null
            });
            if (shouldKeepRemoteApiRetry) {
                await this.markLocalDataDirty(
                    API_SETTINGS_REMOTE_RETRY_DIRTY_REASON,
                    this._buildApiSettingsRemoteRetryContext(dirtyMarker, {
                        remoteEtag: newETag || null
                    })
                );
            } else {
                await this.clearLocalDataDirty();
            }
            await this._runOrphanCleanupIfNeeded(manifest);

            this.notifyListeners('sync-complete', {
                direction: 'merge',
                timestamp: lastSync,
                chatCount: manifest.chatIndex.length,
                uploadCount: uploadItems.length,
                downloadCount,
                conflictCount,
                quickChatOptionsSynced,
                apiConfigSynced,
                apiConfigAttentionRequired
            });

            const message = `智能合并：${uploadItems.length} 个上传，${downloadCount} 个下载` +
                (conflictCount > 0 ? `，${conflictCount} 个冲突自动解决` : '') +
                (apiConfigAttentionRequired ? '；远端 API 配置暂未套用，待提供正确密码后重试' : '');

            return {
                success: true,
                message,
                timestamp: lastSync,
                needsReload: downloadCount > 0,
                uploadCount: uploadItems.length,
                downloadCount,
                conflictCount,
                apiConfigAttentionRequired,
                apiConfigWarningMessage
            };
        } catch (error) {
            this.notifyListeners('sync-error', { direction: 'merge', error: error.message });
            throw error;
        }
        });
    }

    /**
     * 获取最后同步时间
     */
    async getLastSyncTime() {
        try {
            const result = await syncStorageAdapter.get(WEBDAV_LAST_SYNC_KEY);
            return result[WEBDAV_LAST_SYNC_KEY] || null;
        } catch (error) {
            return null;
        }
    }

    /**
     * 获取本地同步数据（带缓存）
     * 使用 dirty flag + per-chat hash table 避免全量 hash 計算
     * 回傳 chatIndex 和 localChatHashes 供 syncToRemote 直接使用，消除重複計算
     */
    async getLocalSyncData(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && this._cachedLocalData && this._cachedLocalHash && (now - this._cacheTimestamp) < 5000) {
            return {
                data: this._cachedLocalData,
                hash: this._cachedLocalHash,
                chatIndex: this._cachedChatIndex,
                localChatHashes: this._cachedLocalChatHashes
            };
        }

        try {
            const chats = chatManager.getAllChatsArray();

            const quickChatResult = await syncStorageAdapter.get('quickChatOptions');
            const hasStoredQuickChatOptions = Array.isArray(quickChatResult.quickChatOptions);
            const quickChatOptions = hasStoredQuickChatOptions ? quickChatResult.quickChatOptions : [];

            const syncData = {
                chats: chats
            };
            if (hasStoredQuickChatOptions) {
                syncData.quickChatOptions = quickChatResult.quickChatOptions;
            }

            if (this.config.syncApiConfig) {
                const apiConfigResult = await syncStorageAdapter.get(API_SETTINGS_STORAGE_KEYS);
                syncData.apiSettings = this._normalizeSyncableApiSettings(apiConfigResult);
            }

            // 使用 dirty flag + hash table 避免全量 hash
            const localChatHashes = await this.loadLocalChatHashes();
            const dirtyChatIds = chatManager.getDirtyChatIds();
            let hashTableDirty = false;

            const chatIndexForHash = [];
            for (const chat of chats) {
                if (chat._remoteOnly) continue;

                if (chat._webdavHydrated) {
                    const hydratedState = getHydratedChatSyncState(chat);
                    if (hydratedState.isRemoteCache) {
                        continue;
                    }

                    const previousHash = localChatHashes.get(chat.id);
                    if (previousHash !== hydratedState.hash) {
                        localChatHashes.set(chat.id, hydratedState.hash);
                        hashTableDirty = true;
                    }

                    chatIndexForHash.push(buildHashedChatIndexEntry(chat, hydratedState.hash));
                    continue;
                }

                let hash;
                if (dirtyChatIds.has(chat.id)) {
                    // dirty：重新計算 hash
                    hash = computeChatHash(chat);
                    localChatHashes.set(chat.id, hash);
                    hashTableDirty = true;
                } else {
                    // 非 dirty：從 hash table 取（無則 fallback 計算）
                    hash = localChatHashes.get(chat.id);
                    if (!hash) {
                        hash = computeChatHash(chat);
                        localChatHashes.set(chat.id, hash);
                        hashTableDirty = true;
                    }
                }

                chatIndexForHash.push(buildHashedChatIndexEntry(chat, hash));
            }

            // 清理 hash table 中已不存在的聊天
            const currentChatIds = new Set(chats.map(c => c.id));
            for (const id of localChatHashes.keys()) {
                if (!currentChatIds.has(id)) {
                    localChatHashes.delete(id);
                    hashTableDirty = true;
                }
            }

            // 若 hash table 有變動，立即持久化（避免重啟後遺失中間計算結果）
            if (hashTableDirty) {
                this.saveLocalChatHashes(localChatHashes);
            }

            // overall hash 基於 chatIndex（輕量：只含短 hash 字串）
            const hashString = this._computeOverallHash(chatIndexForHash, quickChatOptions, syncData.apiSettings);

            this._cachedLocalData = syncData;
            this._cachedLocalHash = hashString;
            this._cachedChatIndex = chatIndexForHash;
            this._cachedLocalChatHashes = localChatHashes;
            this._cacheTimestamp = now;

            return { data: syncData, hash: hashString, chatIndex: chatIndexForHash, localChatHashes };
        } catch (error) {
            console.error('[WebDAV] 获取本地同步数据失败:', error);
            return { data: null, hash: null, chatIndex: [], localChatHashes: new Map() };
        }
    }

    /**
     * 计算本地数据的 Hash
     */
    async calculateLocalHash(forceRefresh = false) {
        const { hash } = await this.getLocalSyncData(forceRefresh);
        return hash;
    }

    /**
     * 從已有的 chatIndex 直接計算 overall hash（純計算，無 I/O）
     * 計算邏輯與 getLocalSyncData() 中的 overall hash 完全一致
     */
    _computeOverallHash(chatIndex, quickChatOptions, apiSettings) {
        return computeSharedOverallHash(chatIndex, quickChatOptions, apiSettings);
    }

    /**
     * 检查同步状态 - 使用 dirty flag 短路 + ETag 双向检测
     */
    async checkSyncStatus(options = {}) {
        try {
            const { forceFresh = false, allowRemoteRetry = false } = options;
            if (!this.client) {
                return {
                    needsSync: false,
                    direction: 'unknown',
                    reason: t('webdav.syncStatusUnknown'),
                    error: null
                };
            }

            // 使用 dirty flag 快速判斷本地是否有變更（零 hash 計算）
            const dirtyChatIds = chatManager.getDirtyChatIds();
            const hasDirtyChats = dirtyChatIds.size > 0;
            const dirtyMarker = await this.getLocalDataDirtyMarker();
            let apiSettingsPlan = null;
            let shouldRetryApiWithoutRemoteCheck = false;
            if (this.config.syncApiConfig && dirtyMarker) {
                const [metadataSyncState, cachedManifest, apiConfigResult] = await Promise.all([
                    this.loadMetadataSyncState(),
                    this.loadCachedManifest(),
                    syncStorageAdapter.get(API_SETTINGS_STORAGE_KEYS)
                ]);
                apiSettingsPlan = this._resolveApiSettingsSyncPlan({
                    dirtyMarker,
                    metadataSyncState,
                    manifest: cachedManifest,
                    localApiSettings: apiConfigResult
                });
                shouldRetryApiWithoutRemoteCheck = apiSettingsPlan.shouldRetryRemotePull &&
                    this._shouldAttemptApiSettingsRemoteRetry(dirtyMarker, {
                        allowManualRetry: allowRemoteRetry
                    });
            }

            const suppressRetryOnlyDirtyMarker = Boolean(
                apiSettingsPlan?.shouldRetryRemotePull &&
                !shouldRetryApiWithoutRemoteCheck
            );
            const hasDirtyLocalData = Boolean(dirtyMarker) && !suppressRetryOnlyDirtyMarker;
            const hasPendingLocalChanges = hasDirtyChats || hasDirtyLocalData;

            const shouldForceApiConflictWithoutRemoteCheck =
                !hasDirtyChats &&
                shouldRetryApiWithoutRemoteCheck &&
                apiSettingsPlan?.hasPendingLocalApiSettingsChange;
            const shouldForceApiDownloadWithoutRemoteCheck =
                !hasDirtyChats &&
                (apiSettingsPlan?.shouldBootstrapFromRemote ||
                    (shouldRetryApiWithoutRemoteCheck && !apiSettingsPlan?.hasPendingLocalApiSettingsChange));

            const now = Date.now();

            // 跨分頁節流：檢查 chrome.storage.local 中的共享時間戳
            // 當多個分頁同時開啟時，只有第一個分頁會發 HEAD 請求，其餘分頁使用快取結果
            let throttled = !forceFresh && this._lastCheckSyncResult && (now - this._lastCheckSyncTime) < CHECK_SYNC_THROTTLE_MS;
            if (!forceFresh && !throttled) {
                try {
                    const shared = await storageAdapter.get([WEBDAV_CROSS_TAB_CHECK_TIME_KEY, WEBDAV_CROSS_TAB_CHECK_RESULT_KEY]);
                    const sharedTime = shared[WEBDAV_CROSS_TAB_CHECK_TIME_KEY];
                    const sharedResult = shared[WEBDAV_CROSS_TAB_CHECK_RESULT_KEY];
                    if (sharedResult && sharedTime && (now - sharedTime) < CHECK_SYNC_THROTTLE_MS) {
                        // 其他分頁已在節流窗口內檢查過，同步本地快取
                        this._lastCheckSyncTime = sharedTime;
                        this._lastCheckSyncResult = sharedResult;
                        throttled = true;
                    }
                } catch (_e) { /* storage 讀取失敗時不阻塞，走原有邏輯 */ }
            }

            if (throttled) {
                if (this._lastCheckSyncResult.direction === 'unknown') {
                    return { ...this._lastCheckSyncResult };
                }
                if (shouldForceApiConflictWithoutRemoteCheck) {
                    return {
                        needsSync: true,
                        direction: 'conflict',
                        reason: 'API 配置待重新比对，本地与远端都需要重新判定'
                    };
                }
                if (shouldForceApiDownloadWithoutRemoteCheck) {
                    return {
                        needsSync: true,
                        direction: 'download',
                        reason: 'API 配置待重新拉取远端状态'
                    };
                }
                if (hasPendingLocalChanges && this._lastCheckSyncResult.needsSync) {
                    if (this._lastCheckSyncResult.direction === 'download' ||
                        this._lastCheckSyncResult.direction === 'conflict') {
                        return {
                            needsSync: true,
                            direction: 'conflict',
                            reason: '节流期间：远端已知有变化，本地也有新变更，需要双向合并'
                        };
                    }
                    return { needsSync: true, direction: 'upload', reason: '节流期间：本地有新变更，需要上传' };
                }
                if (hasPendingLocalChanges) {
                    return { needsSync: true, direction: 'upload', reason: '节流期间：本地有新变更，需要上传' };
                }
                if (!this._lastCheckSyncResult.needsSync) {
                    return { needsSync: false, direction: null, reason: '节流期间：本地和远端均无变化' };
                }
                return { ...this._lastCheckSyncResult };
            }

            // dirty flag 為主要判斷，overall hash 為 fallback（僅啟動後首次檢查，處理重啟後 dirty 遺失的邊際情況）
            let localChanged = hasPendingLocalChanges;
            const needHashFallback = !this._initialHashCheckDone && !suppressRetryOnlyDirtyMarker;
            this._initialHashCheckDone = true;
            if (!localChanged && needHashFallback) {
                const currentLocalHash = await this.calculateLocalHash();
                const hashResult = await syncStorageAdapter.get(WEBDAV_LOCAL_HASH_KEY);
                const lastLocalHash = hashResult[WEBDAV_LOCAL_HASH_KEY];
                localChanged = currentLocalHash !== lastLocalHash;
            }

            const remoteETag = await this.client.getRemoteETag('cerebr.json');
            const etagResult = await syncStorageAdapter.get(WEBDAV_REMOTE_ETAG_KEY);
            const lastRemoteETag = etagResult[WEBDAV_REMOTE_ETAG_KEY];
            let remoteChanged = remoteETag !== null && remoteETag !== lastRemoteETag;

            // 處理上次同步後伺服器未回傳 ETag 的情況：
            // __needs_refresh_ 標記代表「我剛同步過」，ETag 不匹配不算遠端變更
            // 更新 stored ETag 為實際值，供後續比對
            if (remoteChanged && lastRemoteETag && lastRemoteETag.startsWith('__needs_refresh_') && remoteETag) {
                await syncStorageAdapter.set({ [WEBDAV_REMOTE_ETAG_KEY]: remoteETag });
                remoteChanged = false;
            }

            if (remoteETag === null) {
                // 遠端 manifest 不存在（目錄被刪除或首次使用），清除本地快取的 manifest
                // 確保 syncToRemote 將所有聊天視為新增，重新上傳全部聊天檔案
                await storageAdapter.remove([WEBDAV_CACHED_MANIFEST_KEY]);
                return this._cacheCheckResult({ needsSync: true, direction: 'upload', reason: '远端文件不存在，需要上传' });
            }

            if (!lastRemoteETag) {
                return this._cacheCheckResult({ needsSync: true, direction: 'download', reason: '首次同步检查，需要建立基准' });
            }

            const shouldRetryApiNow = apiSettingsPlan?.shouldRetryRemotePull &&
                this._shouldAttemptApiSettingsRemoteRetry(dirtyMarker, {
                    remoteEtag: remoteETag,
                    allowManualRetry: allowRemoteRetry
                });
            const shouldForceApiConflict =
                !hasDirtyChats &&
                shouldRetryApiNow &&
                apiSettingsPlan?.hasPendingLocalApiSettingsChange;
            const shouldForceApiDownload =
                !hasDirtyChats &&
                (apiSettingsPlan?.shouldBootstrapFromRemote ||
                    (shouldRetryApiNow && !apiSettingsPlan?.hasPendingLocalApiSettingsChange));

            if (shouldForceApiConflict) {
                return this._cacheCheckResult({
                    needsSync: true,
                    direction: 'conflict',
                    reason: 'API 配置待重新比对，本地与远端都需要重新判定'
                });
            }
            if (shouldForceApiDownload) {
                return this._cacheCheckResult({
                    needsSync: true,
                    direction: 'download',
                    reason: 'API 同步配置已更新，需先下载远端 API 配置建立基线'
                });
            }

            if (!localChanged && !remoteChanged) {
                return this._cacheCheckResult({ needsSync: false, direction: null, reason: '本地和远端均无变化' });
            }

            if (localChanged && !remoteChanged) {
                return this._cacheCheckResult({ needsSync: true, direction: 'upload', reason: '本地有新变更，需要上传' });
            }

            if (!localChanged && remoteChanged) {
                return this._cacheCheckResult({ needsSync: true, direction: 'download', reason: '远端有新变更，需要下载' });
            }

            return this._cacheCheckResult({ needsSync: true, direction: 'conflict', reason: '本地和远端都有变更，需要比较时间戳' });

        } catch (error) {
            console.error('[WebDAV] 同步检查失败:', error);
            return this._cacheCheckResult({
                needsSync: false,
                direction: 'unknown',
                reason: t('webdav.syncStatusCheckFailed', { error: error.message }),
                error: error.message
            });
        }
    }

    /**
     * 插件开启时执行同步
     */
    async syncOnOpen(options = {}) {
        if (!this.config.enabled) {
            return { synced: false, direction: null, result: null, error: null, conflict: null };
        }

        // 加密已启用但未设置密码时，跳过自动同步
        if (this._isEncryptionIncomplete()) {
            console.log('[WebDAV] syncOnOpen 跳过：加密已启用但未设置加密密码');
            return { synced: false, direction: null, result: null, error: null, conflict: null };
        }

        if (await this.hasActiveStreams()) {
            console.log('[WebDAV] syncOnOpen 延後：仍有分頁正在生成回覆');
            return { synced: false, direction: 'deferred', result: null, error: null, conflict: null };
        }

        try {
            const status = await this.checkSyncStatus();

            if (status.direction === 'unknown') {
                console.warn('[WebDAV] syncOnOpen 跳過：', status.reason);
                return this._finalizeSyncOnOpenResult({
                    synced: false,
                    direction: 'unknown',
                    result: null,
                    error: status.error || status.reason || t('webdav.syncStatusUnknown'),
                    conflict: null
                });
            }

            if (!status.needsSync) {
                return this._finalizeSyncOnOpenResult({
                    synced: false,
                    direction: null,
                    result: null,
                    error: null,
                    conflict: null
                });
            }

            let direction = status.direction;

            if (direction === 'conflict') {
                const result = await this.bidirectionalSync({
                    currentChatId: options.currentChatId
                });
                if (result.needsReload) {
                    this.notifyListeners('sync-reload-required', { reason: '智能合并下载了新数据' });
                }
                return this._finalizeSyncOnOpenResult({
                    synced: true,
                    direction: 'merge',
                    result,
                    error: null,
                    conflict: null
                });
            }

            if (direction === 'upload') {
                const result = await this.syncToRemote();
                return this._finalizeSyncOnOpenResult({
                    synced: true,
                    direction: 'upload',
                    result,
                    error: null,
                    conflict: null
                });
            } else if (direction === 'download') {
                const result = await this.syncFromRemote({
                    currentChatId: options.currentChatId
                });
                if (result.needsReload) {
                    this.notifyListeners('sync-reload-required', { reason: '开启同步下载了新数据' });
                }
                return this._finalizeSyncOnOpenResult({
                    synced: true,
                    direction: 'download',
                    result,
                    error: null,
                    conflict: null
                });
            }

            return this._finalizeSyncOnOpenResult({
                synced: false,
                direction: null,
                result: null,
                error: null,
                conflict: null
            });
        } catch (error) {
            if (isWebDAVSyncBusyError(error)) {
                console.log('[WebDAV] syncOnOpen 跳過：已有其他面板正在同步');
                return this._finalizeSyncOnOpenResult({
                    synced: false,
                    direction: 'busy',
                    result: null,
                    error: null,
                    conflict: null
                });
            }
            console.error('[WebDAV] 开启同步失败:', error);
            return this._finalizeSyncOnOpenResult({
                synced: false,
                direction: null,
                result: null,
                error: error.message,
                conflict: null
            });
        }
    }

    /**
     * 添加事件监听器
     */
    addListener(callback) {
        this.listeners.add(callback);
    }

    /**
     * 移除事件监听器
     */
    removeListener(callback) {
        this.listeners.delete(callback);
    }

    /**
     * 通知所有监听器
     */
    notifyListeners(event, data) {
        this.listeners.forEach(callback => {
            try {
                callback(event, data);
            } catch (error) {
                console.error('WebDAV 事件监听器错误:', error);
            }
        });
    }
}

// 创建并导出单例实例
export const webdavSyncManager = new WebDAVSyncManager();

// 导出类以供测试
export { SharedWebDAVClient as WebDAVClient, WebDAVSyncManager };
