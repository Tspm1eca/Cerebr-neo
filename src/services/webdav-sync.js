/**
 * WebDAV 同步服务
 * 提供与 WebDAV 服务器的数据同步功能
 *
 * v2 格式：聊天紀錄分檔存儲，按需下載
 * - cerebr.json 只存 manifest（chatIndex metadata，無 messages）
 * - chats/{id}.json 存完整聊天（含 messages + base64 圖片）
 */

import { storageAdapter, syncStorageAdapter, setSyncMode } from '../utils/storage-adapter.js';
import { encrypt, decrypt, isEncrypted, encryptPasswordForStorage, decryptPasswordFromStorage, isEncryptedPassword } from '../utils/crypto.js';
import { chatManager } from '../utils/chat-manager.js';
import { computeChatHash } from '../utils/chat-hash.js';

// WebDAV 配置键
const WEBDAV_CONFIG_KEY = 'webdav_config';
const WEBDAV_LAST_SYNC_KEY = 'webdav_last_sync';
const WEBDAV_REMOTE_ETAG_KEY = 'webdav_remote_etag';
const WEBDAV_LOCAL_HASH_KEY = 'webdav_local_hash';
const WEBDAV_LAST_SYNC_TIMESTAMP_KEY = 'webdav_last_sync_timestamp';
const WEBDAV_DELETED_CHAT_IDS_KEY = 'webdav_deleted_chat_ids';
const WEBDAV_CACHED_MANIFEST_KEY = 'webdav_cached_manifest';
const WEBDAV_LOCAL_CHAT_HASHES_KEY = 'webdav_local_chat_hashes';
const WEBDAV_KNOWN_DIRS_KEY = 'webdav_known_directories';
// 跨分頁節流：共享 checkSyncStatus 的時間戳和結果（存儲在 chrome.storage.local）
const WEBDAV_CROSS_TAB_CHECK_TIME_KEY = 'webdav_cross_tab_check_time';
const WEBDAV_CROSS_TAB_CHECK_RESULT_KEY = 'webdav_cross_tab_check_result';

// HTTP 状态码常量
const HTTP_STATUS = {
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
    FAILED_DEPENDENCY: 424
};

// 默认请求超时时间（毫秒）
const DEFAULT_TIMEOUT = 30000;

// 默认配置
const DEFAULT_CONFIG = {
    serverUrl: '',
    username: '',
    password: '',
    syncPath: '/Cerebr-neo',
    enabled: false,
    syncApiConfig: false, // 是否同步 API 配置
    encryptApiKeys: false, // 是否加密 API Keys
    encryptionPassword: '' // 加密密码（仅存储在本地，不同步）
};

// 聊天目錄常量
const CHAT_DIRECTORY = 'chats';
const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const UPLOAD_CONCURRENCY = 5; // 並行上傳數量

// ========== Helper Functions ==========

/**
 * 從完整聊天物件建立 chatIndex entry（metadata only）
 * @param {Object} chat - 聊天物件
 * @param {string|null} precomputedHash - 預先計算的 hash（可選，避免重複計算）
 */
function buildChatIndexEntry(chat, precomputedHash = null) {
    return {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt || chat.createdAt || new Date().toISOString(),
        webpageUrls: chat.webpageUrls || [],
        messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
        hash: precomputedHash || computeChatHash(chat)
    };
}

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
        _remoteOnly: true
    };
}

/**
 * 清理過期的 tombstone
 */
function cleanTombstones(tombstones, maxAgeMs = TOMBSTONE_MAX_AGE_MS) {
    const cutoff = Date.now() - maxAgeMs;
    return tombstones.filter(t => new Date(t.deletedAt).getTime() > cutoff);
}

/**
 * 並行執行任務，限制並發數
 */
async function runWithConcurrency(tasks, concurrency) {
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

/**
 * WebDAV 客户端类
 */
class WebDAVClient {
    constructor(config, knownDirectories = []) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.syncInProgress = false;
        // 目錄存在性快取：避免每次同步都重複發送 MKCOL 請求
        this._knownDirectories = new Set(knownDirectories);
    }

    /**
     * 正規化的同步路徑（去除前後斜線）
     */
    get _normalizedSyncPath() {
        return this.config.syncPath.replace(/^\/+/, '').replace(/\/+$/, '');
    }

    /**
     * 正規化的伺服器 URL（去除尾斜線）
     */
    get _baseUrl() {
        return this.config.serverUrl.replace(/\/+$/, '');
    }

    /**
     * 更新配置
     */
    updateConfig(config) {
        const pathChanged =
            (config.serverUrl !== undefined && config.serverUrl !== this.config.serverUrl) ||
            (config.syncPath !== undefined && config.syncPath !== this.config.syncPath);
        this.config = { ...this.config, ...config };
        if (pathChanged) this._knownDirectories.clear();
    }

    /**
     * 获取完整的 WebDAV URL
     */
    getFullUrl(path = '') {
        return `${this._baseUrl}/${this._normalizedSyncPath}/${path}`.replace(/\/+$/, '');
    }

    /**
     * 获取认证头
     */
    getAuthHeaders() {
        const credentials = btoa(`${this.config.username}:${this.config.password}`);
        return {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest' // 防止浏览器弹出认证对话框
        };
    }

    /**
     * 带超时的 fetch 请求
     */
    async fetchWithTimeout(url, options, timeout = DEFAULT_TIMEOUT) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const fetchOptions = {
            ...options,
            signal: controller.signal,
            credentials: 'omit'
        };

        try {
            const response = await fetch(url, fetchOptions);
            return response;
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(`请求超时（${timeout / 1000}秒）`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * 带目录重试的操作包装器
     */
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
                // 根據檔案路徑重建完整目錄結構（含子目錄如 chats/）
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

    /**
     * 测试连接
     */
    async testConnection() {
        if (!this.config.serverUrl || !this.config.username) {
            throw new Error('请填写服务器地址和用户名');
        }

        try {
            const response = await this.fetchWithTimeout(this.getFullUrl(), {
                method: 'PROPFIND',
                headers: {
                    ...this.getAuthHeaders(),
                    'Depth': '0'
                }
            });

            if (response.status === HTTP_STATUS.NOT_FOUND) {
                const result = await this.createDirectory();
                if (result.error) {
                    throw new Error(`同步路径不存在且创建失败: ${result.error}`);
                }
                return { success: true, message: '连接成功' };
            }

            if (response.status === HTTP_STATUS.MULTI_STATUS || response.status === HTTP_STATUS.OK) {
                // 連接成功，將根同步目錄標記為已知存在
                const syncPath = this._normalizedSyncPath;
                if (syncPath) this._knownDirectories.add(syncPath);
                return { success: true, message: '连接成功' };
            }

            if (response.status === HTTP_STATUS.UNAUTHORIZED) {
                throw new Error('认证失败，请检查用户名和密码');
            }

            throw new Error(`连接失败: HTTP ${response.status}`);
        } catch (error) {
            if (error.message.includes('Failed to fetch')) {
                throw new Error('无法连接到服务器，请检查地址是否正确');
            }
            throw error;
        }
    }

    /**
     * 创建同步目录（支持多层路径）
     */
    async createDirectory() {
        const syncPath = this._normalizedSyncPath;

        // 若根同步目錄已在快取中，跳過
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
                    return { created: false, error: '无法创建父目录' };
                }
                // createParentDirectories 已建立整條路徑（含 syncPath 本身）
                return { created: true, error: null };
            }

            return { created: false, error: `HTTP ${response.status}` };
        } catch (error) {
            return { created: false, error: error.message };
        }
    }

    /**
     * 確保指定路徑的所有目錄層級都存在（共用核心邏輯）
     * @param {string} normalizedPath - 正規化路徑（不含前後斜線，如 'Cerebr-neo/chats'）
     * @returns {Promise<{created: boolean, error: string|null}>}
     */
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

    /**
     * 递归创建父目录
     */
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

    /**
     * 從成功的檔案操作反推祖先目錄存在，回填 _knownDirectories 快取
     * @param {string} relativePath - 相對於 syncPath 的檔案路徑（如 'cerebr.json' 或 'chats/abc.json'）
     */
    _markAncestorDirectoriesKnown(relativePath) {
        const syncPath = this._normalizedSyncPath;
        if (!syncPath) return;

        const fullPath = relativePath ? `${syncPath}/${relativePath}` : syncPath;
        const parts = fullPath.split('/').filter(Boolean);
        if (relativePath) parts.pop(); // 移除檔名，只保留目錄層級

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

    /**
     * 上传数据到 WebDAV
     */
    async uploadData(filename, data) {
        const url = this.getFullUrl(filename);

        const doUpload = async () => {
            const response = await this.fetchWithTimeout(url, {
                method: 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(data)
            });

            if (response.status === HTTP_STATUS.FAILED_DEPENDENCY || response.status === HTTP_STATUS.CONFLICT) {
                const error = new Error(`上传失败: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            if (!response.ok && response.status !== HTTP_STATUS.CREATED && response.status !== HTTP_STATUS.NO_CONTENT) {
                const error = new Error(`上传失败: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            const etag = response.headers.get('ETag') || response.headers.get('Last-Modified') || null;
            return { success: true, etag };
        };

        return await this.withDirectoryRetry(doUpload, '上传数据', filename);
    }

    /**
     * 从 WebDAV 下载数据
     */
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
                const error = new Error(`下载失败: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            if (!response.ok) {
                const error = new Error(`下载失败: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            const etag = response.headers.get('ETag') || response.headers.get('Last-Modified') || null;

            const text = await response.text();
            try {
                return { data: JSON.parse(text), etag };
            } catch (e) {
                throw new Error('数据格式错误');
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

    /**
     * 删除 WebDAV 上的文件
     */
    async deleteFile(filename) {
        const url = this.getFullUrl(filename);
        const response = await this.fetchWithTimeout(url, {
            method: 'DELETE',
            headers: this.getAuthHeaders()
        });

        if (!response.ok && response.status !== HTTP_STATUS.NOT_FOUND) {
            throw new Error(`删除失败: HTTP ${response.status}`);
        }

        return true;
    }

    /**
     * 获取远端文件的 ETag（轻量级 HEAD 请求）
     */
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
                const error = new Error(`获取 ETag 失败: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            if (!response.ok) {
                const error = new Error(`获取 ETag 失败: HTTP ${response.status}`);
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

/**
 * WebDAV 同步管理器
 */
// checkSyncStatus 最小间隔（毫秒）- 60 秒内不重复向远端发 HEAD 请求
const CHECK_SYNC_THROTTLE_MS = 60000;

// syncOnClose 最小间隔（毫秒）- 30 秒内不重复执行关闭同步
const SYNC_ON_CLOSE_THROTTLE_MS = 30000;

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
        // 节流：syncOnClose 上次执行时间
        this._lastSyncOnCloseTime = 0;
        // 標記：啟動後是否已完成首次 hash fallback 檢查
        this._initialHashCheckDone = false;
    }

    /**
     * 加密已启用但缺少密码
     */
    _isEncryptionIncomplete() {
        return this.config.encryptApiKeys && !this.config.encryptionPassword;
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

    /**
     * 清除本地数据缓存
     */
    clearCache() {
        this._cachedLocalData = null;
        this._cachedLocalHash = null;
        this._cachedChatIndex = null;
        this._cachedLocalChatHashes = null;
        this._cacheTimestamp = 0;
        // 清除跨分頁節流快取
        storageAdapter.remove([WEBDAV_CROSS_TAB_CHECK_TIME_KEY, WEBDAV_CROSS_TAB_CHECK_RESULT_KEY]).catch(() => {});
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
    async _batchSavePostSyncState({ manifest, localChatHashes, tombstones = null, etag, localHash, lastSync, remoteTimestamp }) {
        // 合併所有 local storage 寫入（1 次 IPC）
        const localData = {
            [WEBDAV_CACHED_MANIFEST_KEY]: manifest,
            [WEBDAV_LOCAL_CHAT_HASHES_KEY]: Object.fromEntries(localChatHashes)
        };
        if (tombstones !== null) {
            localData[WEBDAV_DELETED_CHAT_IDS_KEY] = tombstones;
        }
        // 目錄快取為加速用途，失敗不影響同步正確性
        try {
            localData[WEBDAV_KNOWN_DIRS_KEY] = this.client ? [...this.client._knownDirectories] : [];
        } catch (e) {
            console.warn('[WebDAV] 序列化目錄快取失敗:', e);
        }

        // 合併所有 sync storage 寫入（1 次 IPC）
        const syncData = {
            [WEBDAV_REMOTE_ETAG_KEY]: etag,
            [WEBDAV_LOCAL_HASH_KEY]: localHash,
            [WEBDAV_LAST_SYNC_KEY]: lastSync,
            [WEBDAV_LAST_SYNC_TIMESTAMP_KEY]: remoteTimestamp
        };

        // 並行寫入（2 次 IPC 同時發出，只需等待較慢的一個）
        await Promise.all([
            storageAdapter.set(localData),
            syncStorageAdapter.set(syncData)
        ]);
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

    async saveCachedManifest(manifest) {
        try {
            await storageAdapter.set({ [WEBDAV_CACHED_MANIFEST_KEY]: manifest });
        } catch (e) {
            console.warn('[WebDAV] 快取 manifest 失敗:', e);
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

    // ========== Tombstone 管理 ==========

    async loadDeletedChatIds() {
        try {
            const result = await storageAdapter.get(WEBDAV_DELETED_CHAT_IDS_KEY);
            return result[WEBDAV_DELETED_CHAT_IDS_KEY] || [];
        } catch {
            return [];
        }
    }

    async saveDeletedChatIds(tombstones) {
        await storageAdapter.set({ [WEBDAV_DELETED_CHAT_IDS_KEY]: tombstones });
    }

    async addDeletedChatId(chatId) {
        const tombstones = await this.loadDeletedChatIds();
        if (!tombstones.some(t => t.id === chatId)) {
            tombstones.push({ id: chatId, deletedAt: new Date().toISOString() });
            await this.saveDeletedChatIds(tombstones);
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
            return null;
        }

        try {
            const result = await this.client.downloadData(`${CHAT_DIRECTORY}/${chatId}.json`);
            return result.data || null;
        } catch (error) {
            console.error(`[WebDAV] 下載聊天 ${chatId} 失敗:`, error);
            return null;
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
            const result = await syncStorageAdapter.get(WEBDAV_CONFIG_KEY);
            if (result[WEBDAV_CONFIG_KEY]) {
                this.config = { ...DEFAULT_CONFIG, ...result[WEBDAV_CONFIG_KEY] };
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
            this.client = new WebDAVClient(this.config, await this._loadKnownDirectories());
        } catch (error) {
            console.error('加载 WebDAV 配置失败:', error);
        }
    }

    /**
     * 保存配置
     */
    async saveConfig(config) {
        const prevEnabled = this.config.enabled;
        const prevServerUrl = this.config.serverUrl;
        const prevSyncPath = this.config.syncPath;
        this.config = { ...this.config, ...config };

        // WebDAV 啟用狀態變更時切換 sync 模式
        const newEnabled = this.config.enabled;
        if (newEnabled !== prevEnabled) {
            await setSyncMode(newEnabled);
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
            this.client = new WebDAVClient(this.config);
        }

        // 路徑變更時清除持久化的目錄快取
        const pathChanged =
            (config.serverUrl !== undefined && config.serverUrl !== prevServerUrl) ||
            (config.syncPath !== undefined && config.syncPath !== prevSyncPath);
        if (pathChanged) {
            storageAdapter.set({ [WEBDAV_KNOWN_DIRS_KEY]: [] }).catch(() => {});
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
            this.client = new WebDAVClient(this.config);
        }
        return await this.client.testConnection();
    }

    /**
     * 执行同步 - 上传本地数据到远端（v2 格式：分檔上傳）
     */
    async syncToRemote(options = {}) {
        if (!this.config.enabled) {
            throw new Error('WebDAV未启用');
        }

        if (this._isEncryptionIncomplete()) {
            throw new Error('加密已启用但未设置加密密码');
        }

        if (this.client.syncInProgress) {
            throw new Error('同步正在进行中');
        }

        this.client.syncInProgress = true;
        this.notifyListeners('sync-start', { direction: 'upload' });

        try {
            // 快照當前 dirty IDs，同步完成後只清除這些（保留同步期間新增的）
            const dirtySnapshot = new Set(chatManager.getDirtyChatIds());

            const { data: localData, hash: localHash, chatIndex: prebuiltChatIndex, localChatHashes } =
                await this.getLocalSyncData();

            if (!localData) {
                throw new Error('无法获取本地数据');
            }

            const chats = localData.chats || [];

            // 載入上次的 manifest 以比對哪些聊天有變動
            const previousManifest = await this.loadCachedManifest();
            const previousChatHashes = new Map(
                (previousManifest?.chatIndex || []).map(e => [e.id, e.hash])
            );

            // 保留遠端已有但本地尚未下載的聊天索引
            const remoteOnlyEntries = (previousManifest?.chatIndex || [])
                .filter(entry => chats.some(c => c.id === entry.id && c._remoteOnly));

            // 直接使用 getLocalSyncData 已建立的 chatIndex（消除重複計算）
            const chatIndex = [...prebuiltChatIndex];
            const changedChats = [];

            for (const entry of prebuiltChatIndex) {
                if (entry.hash !== previousChatHashes.get(entry.id)) {
                    const chat = chats.find(c => c.id === entry.id);
                    if (chat) changedChats.push(chat);
                }
            }

            // 將 _remoteOnly 聊天的索引也保留在 manifest 中
            for (const entry of remoteOnlyEntries) {
                if (!chatIndex.some(e => e.id === entry.id)) {
                    chatIndex.push(entry);
                }
            }

            // 處理刪除的聊天
            const tombstones = cleanTombstones(await this.loadDeletedChatIds());

            // 短路：無變更的聊天、無 tombstone、且 overall hash 未改變 → 跳過上傳
            if (changedChats.length === 0 && tombstones.length === 0) {
                const hashResult = await syncStorageAdapter.get(WEBDAV_LOCAL_HASH_KEY);
                const lastLocalHash = hashResult[WEBDAV_LOCAL_HASH_KEY];
                if (localHash === lastLocalHash) {
                    chatManager.clearDirtyChatIds(dirtySnapshot);
                    this.clearCache();
                    this._lastCheckSyncResult = null;
                    const lastSync = new Date().toISOString();
                    this.notifyListeners('sync-complete', {
                        direction: 'upload',
                        timestamp: lastSync,
                        chatCount: chatIndex.length,
                        changedChatCount: 0,
                        includesApiConfig: false
                    });
                    return { success: true, message: '数据无变更', timestamp: lastSync };
                }
            }

            // 確保 chats/ 目錄存在
            if (changedChats.length > 0) {
                const dirResult = await this.client.createDirectoryAtPath(CHAT_DIRECTORY);
                if (dirResult?.error) {
                    throw new Error(`创建聊天目录失败: ${dirResult.error}`);
                }
            }

            // 並行上傳變動的聊天
            if (changedChats.length > 0) {
                const uploadTasks = changedChats.map(chat => async () => {
                    await this.client.uploadData(`${CHAT_DIRECTORY}/${chat.id}.json`, chat);
                });
                await runWithConcurrency(uploadTasks, UPLOAD_CONCURRENCY);
            }

            // 處理刪除的聊天（並行刪除）
            const failedTombstones = new Set();
            if (tombstones.length > 0) {
                const deleteTasks = tombstones.map(tombstone => async () => {
                    try {
                        await this.client.deleteFile(`${CHAT_DIRECTORY}/${tombstone.id}.json`);
                    } catch (e) {
                        failedTombstones.add(tombstone.id);
                        console.warn(`[WebDAV] 刪除聊天檔案 ${tombstone.id} 失敗:`, e);
                    }
                });
                await runWithConcurrency(deleteTasks, UPLOAD_CONCURRENCY);
            }

            // 只保留刪除失敗的 tombstone，成功刪除（含 404）的不再保留
            const remainingTombstones = tombstones.filter(t => failedTombstones.has(t.id));

            // 建立 manifest
            const manifest = {
                version: 2,
                timestamp: new Date().toISOString(),
                chatIndex,
                deletedChatIds: remainingTombstones,
                quickChatOptions: localData.quickChatOptions || []
            };

            // API 設置加密
            if (this.config.syncApiConfig && localData.apiSettings) {
                manifest.apiSettings = localData.apiSettings;
                if (this.config.encryptApiKeys && this.config.encryptionPassword) {
                    try {
                        manifest.apiSettings = await encrypt(localData.apiSettings, this.config.encryptionPassword);
                        manifest.apiSettingsEncrypted = true;
                        console.log('[WebDAV] API 配置已加密');
                    } catch (encryptError) {
                        console.error('[WebDAV] 加密 API 配置失败:', encryptError);
                        throw new Error('加密 API 配置失败: ' + encryptError.message);
                    }
                }
            }

            // 上傳 manifest
            const uploadResult = await this.client.uploadData('cerebr.json', manifest);

            // 清除同步開始時快照的 dirty flags（保留同步期間新增的，fire-and-forget）
            chatManager.clearDirtyChatIds(dirtySnapshot);

            // 一次性批次儲存所有同步狀態（合併 6 次序列 IPC → 2 次並行 IPC）
            const newETag = uploadResult.etag;
            const lastSync = new Date().toISOString();
            await this._batchSavePostSyncState({
                manifest,
                localChatHashes,
                tombstones: remainingTombstones,
                etag: newETag || `__needs_refresh_${Date.now()}`,
                localHash,
                lastSync,
                remoteTimestamp: manifest.timestamp
            });

            this.notifyListeners('sync-complete', {
                direction: 'upload',
                timestamp: lastSync,
                chatCount: chatIndex.length,
                changedChatCount: changedChats.length,
                includesApiConfig: this.config.syncApiConfig
            });

            let message = `已上传 ${chatIndex.length} 个对话`;
            if (changedChats.length < chatIndex.length) {
                message += `（${changedChats.length} 个有变更）`;
            }
            if (this.config.syncApiConfig) {
                message += '<br>（含 API 配置）';
            }

            this.clearCache();
            this._lastCheckSyncResult = null;

            return { success: true, message, timestamp: lastSync };
        } catch (error) {
            this.notifyListeners('sync-error', { direction: 'upload', error: error.message });
            throw error;
        } finally {
            this.client.syncInProgress = false;
        }
    }

    /**
     * 从远端下载数据到本地（v2 格式：只下載 manifest，聊天按需載入）
     * @param {Object} options - 选项
     * @param {string} options.currentChatId - 當前聊天 ID（會立刻下載）
     */
    async syncFromRemote(options = {}) {
        if (!this.config.enabled) {
            throw new Error('WebDAV 未启用');
        }

        if (this._isEncryptionIncomplete()) {
            throw new Error('加密已启用但未设置加密密码');
        }

        if (this.client.syncInProgress) {
            throw new Error('同步正在进行中');
        }

        this.client.syncInProgress = true;
        this.notifyListeners('sync-start', { direction: 'download' });

        try {
            // 快照當前 dirty IDs，同步完成後只清除這些（保留同步期間新增的）
            const dirtySnapshot = new Set(chatManager.getDirtyChatIds());

            const currentChatId = options.currentChatId || null;

            // 並行下載 manifest 和當前聊天（省一次 HTTP 往返）
            const downloadPromises = [
                this.client.downloadData('cerebr.json')
            ];
            if (currentChatId) {
                downloadPromises.push(
                    this.client.downloadData(`${CHAT_DIRECTORY}/${currentChatId}.json`).catch(() => null)
                );
            } else {
                downloadPromises.push(Promise.resolve(null));
            }

            const [downloadResult, prefetchedCurrentChat] = await Promise.all(downloadPromises);
            const syncData = downloadResult.data;
            const downloadETag = downloadResult.etag;

            if (!syncData) {
                throw new Error('远端没有同步数据');
            }

            if (!Array.isArray(syncData.chatIndex)) {
                throw new Error('同步数据格式错误');
            }

            // 載入本地聊天以進行比對（從 ChatManager 記憶體讀取，無 I/O）
            const localChats = chatManager.getAllChatsArray();
            const localChatMap = new Map(localChats.map(c => [c.id, c]));

            // 載入 per-chat hash table（用查表取代重新計算 hash）
            const localChatHashes = await this.loadLocalChatHashes();

            // 處理 tombstone 刪除
            const deletedIds = new Set(
                (syncData.deletedChatIds || []).map(t => t.id)
            );

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
                // 用 stored hash 比對（不重新計算），比原來更正確：
                // stored hash 代表上次同步狀態，若 remote hash 相同代表遠端沒變，保留本地版本
                const storedHash = localChatHashes.get(entry.id);
                const hashMatch = hasLocalFull && storedHash && storedHash === entry.hash;

                // hash 相同，保留本地版本
                if (hashMatch) {
                    mergedChats.push(localChat);
                    updatedHashes.set(entry.id, entry.hash);
                    continue;
                }

                // 需要遠端資料：當前聊天使用預先下載的結果，其他建立空殼
                if (entry.id === currentChatId) {
                    const prefetchedData = prefetchedCurrentChat?.data;
                    if (prefetchedData) {
                        mergedChats.push(prefetchedData);
                        dirtyIds.add(entry.id);
                        updatedHashes.set(entry.id, entry.hash);
                        continue;
                    }
                    // 預先下載失敗 fallback：有本地資料用本地，否則空殼
                    if (hasLocalFull) {
                        mergedChats.push(localChat);
                        updatedHashes.set(entry.id, computeChatHash(localChat));
                    } else {
                        mergedChats.push(buildRemoteOnlyStub(entry));
                        updatedHashes.set(entry.id, entry.hash);
                    }
                } else {
                    mergedChats.push(buildRemoteOnlyStub(entry));
                    updatedHashes.set(entry.id, entry.hash);
                }
            }

            // 保留本地獨有的聊天（遠端 chatIndex 中不存在且未被刪除）
            for (const localChat of localChats) {
                if (!remoteEntryIds.has(localChat.id) && !deletedIds.has(localChat.id) && !localChat._remoteOnly) {
                    mergedChats.push(localChat);
                }
            }

            // 清理 hash table 中已刪除但不在 chatIndex 中的聊天（邊際情況：遠端已移除的 tombstone）
            for (const id of deletedIds) {
                updatedHashes.delete(id);
            }

            // 構建合併後的 chatIndex（供 overall hash 計算，排除 _remoteOnly 空殼）
            const mergedChatIndex = mergedChats
                .filter(c => !c._remoteOnly)
                .map(c => buildChatIndexEntry(c, updatedHashes.get(c.id)));

            // 儲存合併後的聊天到本地（per-chat key-value 格式）
            await chatManager.replaceAllChats(mergedChats, dirtyIds);

            // 恢復快速選項
            const effectiveQuickChatOptions = (syncData.quickChatOptions && Array.isArray(syncData.quickChatOptions))
                ? syncData.quickChatOptions : [];
            let quickChatOptionsSynced = false;
            if (effectiveQuickChatOptions.length > 0) {
                await syncStorageAdapter.set({ quickChatOptions: effectiveQuickChatOptions });
                quickChatOptionsSynced = true;
            }

            // 同步 API 配置
            let apiConfigSynced = false;
            let effectiveApiSettings = undefined;
            if (this.config.syncApiConfig && syncData.apiSettings) {
                let apiSettings = syncData.apiSettings;

                if (syncData.apiSettingsEncrypted && isEncrypted(apiSettings)) {
                    if (!this.config.encryptionPassword) {
                        throw new Error('远端 API 配置已加密，请设置解密密码');
                    }
                    try {
                        apiSettings = await decrypt(apiSettings, this.config.encryptionPassword);
                        console.log('[WebDAV] API 配置已解密');
                    } catch (decryptError) {
                        throw new Error('解密API配置失败<br>密码错误或数据已损坏');
                    }
                }

                effectiveApiSettings = this._normalizeApiSettings(apiSettings);
                await syncStorageAdapter.set(effectiveApiSettings);
                apiConfigSynced = true;
            }

            // 清除同步開始時快照的 dirty flags（保留同步期間新增的，fire-and-forget）
            chatManager.clearDirtyChatIds(dirtySnapshot);

            // 清除本地數據快取
            this.clearCache();

            // 直接計算 post-sync overall hash（使用記憶體中的 mergedChatIndex，避免冗餘 I/O）
            let postSyncApiSettings = effectiveApiSettings;
            if (this.config.syncApiConfig && !postSyncApiSettings) {
                // 遠端無 API settings，讀取本地現有設定（1 次 storage 讀取）
                const apiConfigResult = await syncStorageAdapter.get([
                    'apiConfigs', 'selectedConfigIndex', 'searchProvider',
                    'tavilyApiKey', 'tavilyApiUrl', 'exaApiKey', 'exaApiUrl'
                ]);
                postSyncApiSettings = this._normalizeApiSettings(apiConfigResult);
            }
            const localHash = this._computeOverallHash(mergedChatIndex, effectiveQuickChatOptions, postSyncApiSettings);

            // 一次性批次儲存所有同步狀態（合併 5 次序列 IPC → 2 次並行 IPC）
            const lastSync = new Date().toISOString();
            await this._batchSavePostSyncState({
                manifest: syncData,
                localChatHashes: updatedHashes,
                etag: downloadETag || `__needs_refresh_${Date.now()}`,
                localHash,
                lastSync,
                remoteTimestamp: syncData.timestamp || lastSync
            });

            const remoteOnlyCount = mergedChats.filter(c => c._remoteOnly).length;
            this.notifyListeners('sync-complete', {
                direction: 'download',
                timestamp: lastSync,
                chatCount: syncData.chatIndex.length,
                remoteOnlyCount,
                apiConfigSynced
            });

            let message = `已下载 ${syncData.chatIndex.length} 个对话索引`;
            if (apiConfigSynced) {
                message += '<br>（含 API 配置）';
            }

            return {
                success: true,
                message,
                timestamp: lastSync,
                needsReload: true,
                apiConfigSynced
            };
        } catch (error) {
            this.notifyListeners('sync-error', { direction: 'download', error: error.message });
            throw error;
        } finally {
            this.client.syncInProgress = false;
        }
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
            throw new Error('WebDAV 未启用');
        }

        if (this.client.syncInProgress) {
            throw new Error('同步正在进行中');
        }

        this.client.syncInProgress = true;
        this.notifyListeners('sync-start', { direction: 'merge' });

        try {
            // 1. 快照當前 dirty IDs
            const dirtySnapshot = new Set(chatManager.getDirtyChatIds());
            const currentChatId = options.currentChatId || null;

            // 2. 並行下載 remote manifest + prefetch currentChat
            const [downloadResult, prefetchedCurrentChat] = await Promise.all([
                this.client.downloadData('cerebr.json'),
                currentChatId
                    ? this.client.downloadData(`${CHAT_DIRECTORY}/${currentChatId}.json`).catch(() => null)
                    : Promise.resolve(null)
            ]);
            const remoteManifest = downloadResult.data;
            const downloadETag = downloadResult.etag;

            if (!remoteManifest || !Array.isArray(remoteManifest.chatIndex)) {
                throw new Error('远端同步数据格式错误');
            }

            // 3. 取得本地資料、chatIndex
            const { data: localData, chatIndex: localChatIndex } =
                await this.getLocalSyncData();

            if (!localData) {
                throw new Error('无法获取本地数据');
            }

            const localChats = localData.chats || [];
            const localChatMap = new Map(localChats.map(c => [c.id, c]));
            const localIndexMap = new Map(localChatIndex.map(e => [e.id, e]));

            // 4. 取得 baseHashes（上次同步時的狀態）
            const baseHashes = await this.loadLocalChatHashes();

            // 5. 合併 tombstones（本地 + 遠端取聯集，by id 去重保留較新的 deletedAt）
            const localTombstones = cleanTombstones(await this.loadDeletedChatIds());
            const remoteTombstones = cleanTombstones(remoteManifest.deletedChatIds || []);
            const tombstoneMap = new Map();
            for (const t of localTombstones) {
                tombstoneMap.set(t.id, t);
            }
            for (const t of remoteTombstones) {
                const existing = tombstoneMap.get(t.id);
                if (!existing || new Date(t.deletedAt) > new Date(existing.deletedAt)) {
                    tombstoneMap.set(t.id, t);
                }
            }
            const mergedTombstones = [...tombstoneMap.values()];
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
            const mergedChatIndex = [];
            const chatsToUpload = [];   // 需要上傳的本地聊天
            let downloadCount = 0;
            let conflictCount = 0;

            // 取得遠端聊天（優先用 prefetch，否則建 stub）並追蹤需寫入的 ID
            const dirtyIds = new Set();
            const pickRemoteChat = (entry) => {
                if (entry.id === currentChatId && prefetchedCurrentChat?.data) {
                    dirtyIds.add(entry.id);
                    return prefetchedCurrentChat.data;
                }
                return buildRemoteOnlyStub(entry);
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
                        mergedChatIndex.push(localEntry);
                        chatsToUpload.push(localChat);
                    }
                } else if (!localEntry && remoteEntry) {
                    // 僅遠端有 → 下載 stub（currentChat 用 prefetch）
                    mergedChats.push(pickRemoteChat(remoteEntry));
                    mergedChatIndex.push(remoteEntry);
                    downloadCount++;
                } else if (localEntry && remoteEntry) {
                    // 兩邊都有 → 三方比對
                    if (baseHash === localHash && baseHash === remoteHash) {
                        // (a) 無變更，保留本地
                        if (hasLocalFull) {
                            mergedChats.push(localChat);
                        } else {
                            mergedChats.push(buildRemoteOnlyStub(remoteEntry));
                        }
                        mergedChatIndex.push(localEntry);
                    } else if (baseHash !== localHash && baseHash === remoteHash) {
                        // (b) 僅本地改 → 上傳
                        if (hasLocalFull) {
                            mergedChats.push(localChat);
                            mergedChatIndex.push(localEntry);
                            chatsToUpload.push(localChat);
                        } else {
                            mergedChats.push(buildRemoteOnlyStub(remoteEntry));
                            mergedChatIndex.push(remoteEntry);
                        }
                    } else if (baseHash === localHash && baseHash !== remoteHash) {
                        // (c) 僅遠端改 → 下載 stub
                        mergedChats.push(pickRemoteChat(remoteEntry));
                        mergedChatIndex.push(remoteEntry);
                        downloadCount++;
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
                                mergedChatIndex.push(localEntry);
                                chatsToUpload.push(localChat);
                            } else {
                                mergedChats.push(buildRemoteOnlyStub(remoteEntry));
                                mergedChatIndex.push(remoteEntry);
                            }
                        } else {
                            // 遠端較新 → 下載 stub
                            mergedChats.push(pickRemoteChat(remoteEntry));
                            mergedChatIndex.push(remoteEntry);
                            downloadCount++;
                        }
                    }
                }
            }

            // 7. 確保 chats/ 目錄存在
            if (chatsToUpload.length > 0) {
                const dirResult = await this.client.createDirectoryAtPath(CHAT_DIRECTORY);
                if (dirResult?.error) {
                    throw new Error(`创建聊天目录失败: ${dirResult.error}`);
                }
            }

            // 8. 並行上傳有變更的本地對話
            if (chatsToUpload.length > 0) {
                const uploadTasks = chatsToUpload.map(chat => async () => {
                    await this.client.uploadData(`${CHAT_DIRECTORY}/${chat.id}.json`, chat);
                });
                await runWithConcurrency(uploadTasks, UPLOAD_CONCURRENCY);
            }

            // 9. 並行刪除本地 tombstone 對應的遠端檔案
            const failedTombstones = new Set();
            if (mergedTombstones.length > 0) {
                const deleteTasks = mergedTombstones.map(tombstone => async () => {
                    try {
                        await this.client.deleteFile(`${CHAT_DIRECTORY}/${tombstone.id}.json`);
                    } catch (e) {
                        failedTombstones.add(tombstone.id);
                        console.warn(`[WebDAV] 刪除聊天檔案 ${tombstone.id} 失敗:`, e);
                    }
                });
                await runWithConcurrency(deleteTasks, UPLOAD_CONCURRENCY);
            }
            const remainingTombstones = mergedTombstones.filter(t => failedTombstones.has(t.id));

            // 10. 建構合併後的 manifest
            const manifest = {
                version: 2,
                timestamp: new Date().toISOString(),
                chatIndex: mergedChatIndex,
                deletedChatIds: remainingTombstones,
                quickChatOptions: localData.quickChatOptions || []
            };

            // API 設置（使用本地版本）
            if (this.config.syncApiConfig && localData.apiSettings) {
                manifest.apiSettings = localData.apiSettings;
                if (this.config.encryptApiKeys && this.config.encryptionPassword) {
                    try {
                        manifest.apiSettings = await encrypt(localData.apiSettings, this.config.encryptionPassword);
                        manifest.apiSettingsEncrypted = true;
                    } catch (encryptError) {
                        console.error('[WebDAV] 加密 API 配置失败:', encryptError);
                        throw new Error('加密 API 配置失败: ' + encryptError.message);
                    }
                }
            }

            // 11. 上傳 manifest
            const uploadResult = await this.client.uploadData('cerebr.json', manifest);

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
            for (const entry of mergedChatIndex) {
                updatedHashes.set(entry.id, entry.hash);
            }

            // 直接計算 post-sync overall hash（零 I/O：使用記憶體中的 mergedChatIndex）
            const localHash = this._computeOverallHash(
                mergedChatIndex,
                localData.quickChatOptions || [],
                localData.apiSettings
            );

            // 一次性批次儲存所有同步狀態（合併 7 次序列 IPC → 2 次並行 IPC）
            const newETag = uploadResult.etag || downloadETag;
            const lastSync = new Date().toISOString();
            await this._batchSavePostSyncState({
                manifest,
                localChatHashes: updatedHashes,
                tombstones: remainingTombstones,
                etag: newETag || `__needs_refresh_${Date.now()}`,
                localHash,
                lastSync,
                remoteTimestamp: manifest.timestamp
            });

            this.notifyListeners('sync-complete', {
                direction: 'merge',
                timestamp: lastSync,
                chatCount: mergedChatIndex.length,
                uploadCount: chatsToUpload.length,
                downloadCount,
                conflictCount
            });

            const message = `智能合并：${chatsToUpload.length} 个上传，${downloadCount} 个下载` +
                (conflictCount > 0 ? `，${conflictCount} 个冲突自动解决` : '');

            return {
                success: true,
                message,
                timestamp: lastSync,
                needsReload: downloadCount > 0,
                uploadCount: chatsToUpload.length,
                downloadCount,
                conflictCount
            };
        } catch (error) {
            this.notifyListeners('sync-error', { direction: 'merge', error: error.message });
            throw error;
        } finally {
            this.client.syncInProgress = false;
        }
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
            const quickChatOptions = quickChatResult.quickChatOptions || [];

            const syncData = {
                chats: chats,
                quickChatOptions: quickChatOptions
            };

            if (this.config.syncApiConfig) {
                const apiConfigResult = await syncStorageAdapter.get([
                    'apiConfigs',
                    'selectedConfigIndex',
                    'searchProvider',
                    'tavilyApiKey',
                    'tavilyApiUrl',
                    'exaApiKey',
                    'exaApiUrl'
                ]);
                syncData.apiSettings = {
                    apiConfigs: apiConfigResult.apiConfigs || [],
                    selectedConfigIndex: apiConfigResult.selectedConfigIndex ?? 0,
                    searchProvider: apiConfigResult.searchProvider || 'tavily',
                    tavilyApiKey: apiConfigResult.tavilyApiKey || '',
                    tavilyApiUrl: apiConfigResult.tavilyApiUrl || '',
                    exaApiKey: apiConfigResult.exaApiKey || '',
                    exaApiUrl: apiConfigResult.exaApiUrl || ''
                };
            }

            // 使用 dirty flag + hash table 避免全量 hash
            const localChatHashes = await this.loadLocalChatHashes();
            const dirtyChatIds = chatManager.getDirtyChatIds();
            let hashTableDirty = false;

            const chatIndexForHash = [];
            for (const chat of chats) {
                if (chat._remoteOnly) continue;

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

                chatIndexForHash.push(buildChatIndexEntry(chat, hash));
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
     * 將原始 API settings 正規化為統一結構（含預設值）
     */
    _normalizeApiSettings(raw) {
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

    /**
     * 從已有的 chatIndex 直接計算 overall hash（純計算，無 I/O）
     * 計算邏輯與 getLocalSyncData() 中的 overall hash 完全一致
     */
    _computeOverallHash(chatIndex, quickChatOptions, apiSettings) {
        const hashSource = JSON.stringify({
            chatIndex,
            quickChatOptions,
            apiSettings
        });
        let hash = 5381;
        for (let i = 0; i < hashSource.length; i++) {
            hash = ((hash << 5) + hash) + hashSource.charCodeAt(i);
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16);
    }

    /**
     * 检查同步状态 - 使用 dirty flag 短路 + ETag 双向检测
     */
    async checkSyncStatus() {
        try {
            if (!this.client) {
                return { needsSync: true, direction: 'upload', reason: '客户端未初始化' };
            }

            // 使用 dirty flag 快速判斷本地是否有變更（零 hash 計算）
            const dirtyChatIds = chatManager.getDirtyChatIds();
            const hasDirtyChats = dirtyChatIds.size > 0;

            const now = Date.now();

            // 跨分頁節流：檢查 chrome.storage.local 中的共享時間戳
            // 當多個分頁同時開啟時，只有第一個分頁會發 HEAD 請求，其餘分頁使用快取結果
            let throttled = this._lastCheckSyncResult && (now - this._lastCheckSyncTime) < CHECK_SYNC_THROTTLE_MS;
            if (!throttled) {
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
                if (hasDirtyChats) {
                    return { needsSync: true, direction: 'upload', reason: '节流期间：本地有新变更，需要上传' };
                }
                if (!this._lastCheckSyncResult.needsSync) {
                    return { needsSync: false, direction: null, reason: '节流期间：本地和远端均无变化' };
                }
                return { ...this._lastCheckSyncResult };
            }

            // dirty flag 為主要判斷，overall hash 為 fallback（僅啟動後首次檢查，處理重啟後 dirty 遺失的邊際情況）
            let localChanged = hasDirtyChats;
            const needHashFallback = !this._initialHashCheckDone;
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
            return { needsSync: true, direction: 'upload', reason: `检查失败: ${error.message}` };
        }
    }

    /**
     * 获取冲突信息
     */
    async getConflictInfo() {
        try {
            const localResult = await syncStorageAdapter.get(WEBDAV_LAST_SYNC_TIMESTAMP_KEY);
            const localTimestamp = localResult[WEBDAV_LAST_SYNC_TIMESTAMP_KEY];

            const downloadResult = await this.client.downloadData('cerebr.json');
            const remoteData = downloadResult.data;
            const remoteTimestamp = remoteData?.timestamp;
            const remoteEncrypted = remoteData?.apiSettingsEncrypted || false;

            let recommendation = 'upload';
            if (!localTimestamp && remoteTimestamp) {
                recommendation = 'download';
            } else if (localTimestamp && remoteTimestamp) {
                const localTime = new Date(localTimestamp).getTime();
                const remoteTime = new Date(remoteTimestamp).getTime();
                recommendation = localTime >= remoteTime ? 'upload' : 'download';
            }

            return {
                localTimestamp,
                remoteTimestamp,
                recommendation,
                remoteEncrypted
            };
        } catch (error) {
            console.error('[WebDAV] 获取冲突信息失败:', error);
            return {
                localTimestamp: null,
                remoteTimestamp: null,
                recommendation: 'upload',
                remoteEncrypted: false
            };
        }
    }

    /**
     * 解决冲突
     */
    async resolveConflict() {
        const conflictInfo = await this.getConflictInfo();
        return conflictInfo.recommendation;
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

        try {
            const status = await this.checkSyncStatus();

            if (!status.needsSync) {
                return { synced: false, direction: null, result: null, error: null, conflict: null };
            }

            let direction = status.direction;

            if (direction === 'conflict') {
                const result = await this.bidirectionalSync({
                    currentChatId: options.currentChatId
                });
                if (result.needsReload) {
                    this.notifyListeners('sync-reload-required', { reason: '智能合并下载了新数据' });
                }
                return { synced: true, direction: 'merge', result, error: null, conflict: null };
            }

            if (direction === 'upload') {
                const result = await this.syncToRemote();
                return { synced: true, direction: 'upload', result, error: null, conflict: null };
            } else if (direction === 'download') {
                const result = await this.syncFromRemote({
                    currentChatId: options.currentChatId
                });
                if (result.needsReload) {
                    this.notifyListeners('sync-reload-required', { reason: '开启同步下载了新数据' });
                }
                return { synced: true, direction: 'download', result, error: null, conflict: null };
            }

            return { synced: false, direction: null, result: null, error: null, conflict: null };
        } catch (error) {
            console.error('[WebDAV] 开启同步失败:', error);
            return { synced: false, direction: null, result: null, error: error.message, conflict: null };
        }
    }

    /**
     * 插件关闭时执行同步（仅上传）
     */
    async syncOnClose() {
        if (!this.config.enabled) {
            return { synced: false, result: null, error: null };
        }

        // 加密已启用但未设置密码时，跳过自动同步
        if (this._isEncryptionIncomplete()) {
            console.log('[WebDAV] syncOnClose 跳过：加密已启用但未设置加密密码');
            return { synced: false, result: null, error: null };
        }

        const now = Date.now();
        if ((now - this._lastSyncOnCloseTime) < SYNC_ON_CLOSE_THROTTLE_MS) {
            console.log('[WebDAV] syncOnClose 节流：距离上次同步不到 ' + (SYNC_ON_CLOSE_THROTTLE_MS / 1000) + ' 秒，跳过');
            return { synced: false, result: null, error: null };
        }

        // 短路：有 dirty chats 直接上傳，跳過 checkSyncStatus 的遠端 HEAD 請求
        const hasDirtyChats = chatManager.getDirtyChatIds().size > 0;
        if (hasDirtyChats) {
            try {
                const result = await this.syncToRemote();
                this._lastSyncOnCloseTime = Date.now();
                this._lastCheckSyncResult = null;
                return { synced: true, result, error: null };
            } catch (error) {
                console.error('[WebDAV] 关闭同步失败:', error);
                return { synced: false, result: null, error: error.message };
            }
        }

        // 無 dirty chats：完整檢查（處理重啟後 hash fallback 等邊際情況）
        try {
            const status = await this.checkSyncStatus();

            if (status.needsSync && (status.direction === 'upload' || status.direction === 'conflict')) {
                const result = await this.syncToRemote();
                this._lastSyncOnCloseTime = Date.now();
                this._lastCheckSyncResult = null;
                return { synced: true, result, error: null };
            }

            return { synced: false, result: null, error: null };
        } catch (error) {
            console.error('[WebDAV] 关闭同步失败:', error);
            return { synced: false, result: null, error: error.message };
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
export { WebDAVClient, WebDAVSyncManager };
