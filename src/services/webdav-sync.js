/**
 * WebDAV 同步服务
 * 提供与 WebDAV 服务器的数据同步功能
 *
 * v2 格式：聊天紀錄分檔存儲，按需下載
 * - cerebr.json 只存 manifest（chatIndex metadata，無 messages）
 * - chats/{id}.json 存完整聊天（含 messages + base64 圖片）
 */

import { storageAdapter, syncStorageAdapter } from '../utils/storage-adapter.js';
import { encrypt, decrypt, isEncrypted, encryptPasswordForStorage, decryptPasswordFromStorage, isEncryptedPassword } from '../utils/crypto.js';

// WebDAV 配置键
const WEBDAV_CONFIG_KEY = 'webdav_config';
const WEBDAV_LAST_SYNC_KEY = 'webdav_last_sync';
const WEBDAV_REMOTE_ETAG_KEY = 'webdav_remote_etag';
const WEBDAV_LOCAL_HASH_KEY = 'webdav_local_hash';
const WEBDAV_LAST_SYNC_TIMESTAMP_KEY = 'webdav_last_sync_timestamp';
const WEBDAV_DELETED_CHAT_IDS_KEY = 'webdav_deleted_chat_ids';
const WEBDAV_CACHED_MANIFEST_KEY = 'webdav_cached_manifest';
const CHATS_KEY = 'cerebr_chats';

// HTTP 状态码常量
const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    MULTI_STATUS: 207,
    MOVED_PERMANENTLY: 301,
    UNAUTHORIZED: 401,
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
 * 計算聊天的 djb2 hash（用於變更偵測）
 */
function computeChatHash(chat) {
    const jsonString = JSON.stringify({
        id: chat.id,
        title: chat.title,
        messages: chat.messages,
        webpageUrls: chat.webpageUrls
    });
    let hash = 5381;
    for (let i = 0; i < jsonString.length; i++) {
        hash = ((hash << 5) + hash) + jsonString.charCodeAt(i);
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
}

/**
 * 從完整聊天物件建立 chatIndex entry（metadata only）
 */
function buildChatIndexEntry(chat) {
    return {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt || chat.createdAt || new Date().toISOString(),
        webpageUrls: chat.webpageUrls || [],
        messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
        hash: computeChatHash(chat)
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
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.syncInProgress = false;
    }

    /**
     * 更新配置
     */
    updateConfig(config) {
        this.config = { ...this.config, ...config };
    }

    /**
     * 获取完整的 WebDAV URL
     */
    getFullUrl(path = '') {
        let baseUrl = this.config.serverUrl.replace(/\/+$/, '');
        let syncPath = this.config.syncPath.replace(/^\/+/, '').replace(/\/+$/, '');
        return `${baseUrl}/${syncPath}/${path}`.replace(/\/+$/, '');
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
    async withDirectoryRetry(operation, operationName) {
        try {
            return await operation();
        } catch (error) {
            if (error.status === HTTP_STATUS.FAILED_DEPENDENCY || error.status === HTTP_STATUS.CONFLICT) {
                console.warn(`[WebDAV] ${operationName} 遇到目录问题，尝试创建后重试`);
                await this.createDirectory();
                return await operation();
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
        try {
            const response = await this.fetchWithTimeout(this.getFullUrl(), {
                method: 'MKCOL',
                headers: this.getAuthHeaders()
            });

            if (response.status === HTTP_STATUS.CREATED) {
                return { created: true, error: null };
            }

            if (response.status === HTTP_STATUS.METHOD_NOT_ALLOWED || response.status === HTTP_STATUS.MOVED_PERMANENTLY) {
                return { created: false, error: null };
            }

            if (response.status === HTTP_STATUS.CONFLICT || response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                const parentCreated = await this.createParentDirectories();
                if (parentCreated) {
                    return await this.createDirectory();
                }
                return { created: false, error: '无法创建父目录' };
            }

            return { created: false, error: `HTTP ${response.status}` };
        } catch (error) {
            return { created: false, error: error.message };
        }
    }

    /**
     * 递归创建父目录
     */
    async createParentDirectories() {
        const baseUrl = this.config.serverUrl.replace(/\/+$/, '');
        const syncPath = this.config.syncPath.replace(/^\/+/, '').replace(/\/+$/, '');
        const parts = syncPath.split('/').filter(Boolean);

        let currentPath = '';
        for (const part of parts) {
            currentPath += '/' + part;
            const url = `${baseUrl}${currentPath}`;

            try {
                const response = await this.fetchWithTimeout(url, {
                    method: 'MKCOL',
                    headers: this.getAuthHeaders()
                });

                if (response.status !== HTTP_STATUS.CREATED && response.status !== HTTP_STATUS.METHOD_NOT_ALLOWED &&
                    response.status !== HTTP_STATUS.MOVED_PERMANENTLY && response.status !== HTTP_STATUS.CONFLICT) {
                    if (response.status !== HTTP_STATUS.FAILED_DEPENDENCY) {
                        console.warn(`[WebDAV] 创建目录 ${currentPath} 失败: HTTP ${response.status}`);
                        return false;
                    }
                }
            } catch (error) {
                console.error(`[WebDAV] 创建目录 ${currentPath} 异常:`, error);
                return false;
            }
        }
        return true;
    }

    async createDirectoryAtPath(relativePath) {
        const baseUrl = this.config.serverUrl.replace(/\/+$/, '');
        const syncPath = this.config.syncPath.replace(/^\/+/, '').replace(/\/+$/, '');
        const childPath = relativePath.replace(/^\/+/, '').replace(/\/+$/, '');
        const fullPath = [syncPath, childPath].filter(Boolean).join('/');

        if (!fullPath) {
            return { created: false, error: null };
        }

        const parts = fullPath.split('/').filter(Boolean);
        let currentPath = '';

        for (const part of parts) {
            currentPath += '/' + part;
            const url = `${baseUrl}${currentPath}`;
            const response = await this.fetchWithTimeout(url, {
                method: 'MKCOL',
                headers: this.getAuthHeaders()
            });

            if (
                response.status !== HTTP_STATUS.CREATED &&
                response.status !== HTTP_STATUS.METHOD_NOT_ALLOWED &&
                response.status !== HTTP_STATUS.MOVED_PERMANENTLY &&
                response.status !== HTTP_STATUS.CONFLICT &&
                response.status !== HTTP_STATUS.FAILED_DEPENDENCY
            ) {
                return { created: false, error: `HTTP ${response.status}` };
            }
        }

        return { created: true, error: null };
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
                throw new Error(`上传失败: HTTP ${response.status}`);
            }

            const etag = response.headers.get('ETag') || response.headers.get('Last-Modified') || null;
            return { success: true, etag };
        };

        return await this.withDirectoryRetry(doUpload, '上传数据');
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
                throw new Error(`下载失败: HTTP ${response.status}`);
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
            return await this.withDirectoryRetry(doDownload, '下载数据');
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
                throw new Error(`获取 ETag 失败: HTTP ${response.status}`);
            }

            return response.headers.get('ETag') || response.headers.get('Last-Modified') || null;
        };

        try {
            return await this.withDirectoryRetry(doGetETag, '获取 ETag');
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
    }

    /**
     * 清除本地数据缓存
     */
    clearCache() {
        this._cachedLocalData = null;
        this._cachedLocalHash = null;
        this._cacheTimestamp = 0;
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

            this.client = new WebDAVClient(this.config);
        } catch (error) {
            console.error('加载 WebDAV 配置失败:', error);
        }
    }

    /**
     * 保存配置
     */
    async saveConfig(config) {
        this.config = { ...this.config, ...config };

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
     * @param {Object} options - 选项
     * @param {string} options.cachedHash - 已计算的本地 hash（可选）
     */
    async syncToRemote(options = {}) {
        if (!this.config.enabled) {
            throw new Error('WebDAV未启用');
        }

        if (this.client.syncInProgress) {
            throw new Error('同步正在进行中');
        }

        this.client.syncInProgress = true;
        this.notifyListeners('sync-start', { direction: 'upload' });

        try {
            const { data: localData, hash: localHash } = await this.getLocalSyncData();

            if (!localData) {
                throw new Error('无法获取本地数据');
            }

            const chats = localData.chats || [];

            // 過濾掉 _remoteOnly 佔位聊天（尚未下載完整內容，不應上傳）
            const localChats = chats.filter(c => !c._remoteOnly);

            // 載入上次的 manifest 以比對哪些聊天有變動
            const previousManifest = await this.loadCachedManifest();
            const previousChatHashes = new Map(
                (previousManifest?.chatIndex || []).map(e => [e.id, e.hash])
            );

            // 保留遠端已有但本地尚未下載的聊天索引
            const remoteOnlyEntries = (previousManifest?.chatIndex || [])
                .filter(entry => chats.some(c => c.id === entry.id && c._remoteOnly));

            // 建立 chatIndex 並找出變動的聊天
            const chatIndex = [];
            const changedChats = [];

            for (const chat of localChats) {
                const entry = buildChatIndexEntry(chat);
                chatIndex.push(entry);

                if (entry.hash !== previousChatHashes.get(chat.id)) {
                    changedChats.push(chat);
                }
            }

            // 將 _remoteOnly 聊天的索引也保留在 manifest 中
            for (const entry of remoteOnlyEntries) {
                if (!chatIndex.some(e => e.id === entry.id)) {
                    chatIndex.push(entry);
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
            const tombstones = cleanTombstones(await this.loadDeletedChatIds());
            if (tombstones.length > 0) {
                const deleteTasks = tombstones.map(tombstone => async () => {
                    try {
                        await this.client.deleteFile(`${CHAT_DIRECTORY}/${tombstone.id}.json`);
                    } catch (e) {
                        console.warn(`[WebDAV] 刪除聊天檔案 ${tombstone.id} 失敗:`, e);
                    }
                });
                await runWithConcurrency(deleteTasks, UPLOAD_CONCURRENCY);
            }

            // 建立 manifest
            const manifest = {
                version: 2,
                timestamp: new Date().toISOString(),
                chatIndex,
                deletedChatIds: tombstones,
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

            // 快取 manifest
            await this.saveCachedManifest(manifest);

            // 儲存已清理的 tombstone
            await this.saveDeletedChatIds(tombstones);

            // 儲存 ETag
            let newETag = uploadResult.etag;
            if (!newETag) {
                try {
                    newETag = await this.client.getRemoteETag('cerebr.json');
                } catch (etagError) {
                    console.warn('[WebDAV] 获取上传后 ETag 失败:', etagError);
                }
            }
            if (newETag) {
                await syncStorageAdapter.set({ [WEBDAV_REMOTE_ETAG_KEY]: newETag });
            }

            // 儲存本地 Hash
            const hashToSave = options.cachedHash || localHash;
            if (hashToSave) {
                try {
                    await syncStorageAdapter.set({ [WEBDAV_LOCAL_HASH_KEY]: hashToSave });
                } catch (hashError) {
                    console.warn('[WebDAV] 储存本地 Hash 失败:', hashError);
                }
            }

            // 記錄同步時間
            const lastSync = new Date().toISOString();
            await syncStorageAdapter.set({
                [WEBDAV_LAST_SYNC_KEY]: lastSync,
                [WEBDAV_LAST_SYNC_TIMESTAMP_KEY]: manifest.timestamp
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

        if (this.client.syncInProgress) {
            throw new Error('同步正在进行中');
        }

        this.client.syncInProgress = true;
        this.notifyListeners('sync-start', { direction: 'download' });

        try {
            // 下載 manifest
            const downloadResult = await this.client.downloadData('cerebr.json');
            const syncData = downloadResult.data;
            const downloadETag = downloadResult.etag;

            if (!syncData) {
                throw new Error('远端没有同步数据');
            }

            if (!Array.isArray(syncData.chatIndex)) {
                throw new Error('同步数据格式错误');
            }

            // 載入本地聊天以進行比對
            const localChatsResult = await storageAdapter.get(CHATS_KEY);
            const localChats = localChatsResult[CHATS_KEY] || [];
            const localChatMap = new Map(localChats.map(c => [c.id, c]));

            // 處理 tombstone 刪除
            const deletedIds = new Set(
                (syncData.deletedChatIds || []).map(t => t.id)
            );

            // 建立合併後的聊天列表
            const mergedChats = [];
            const currentChatId = options.currentChatId || null;
            const remoteEntryIds = new Set();

            for (const entry of syncData.chatIndex) {
                if (deletedIds.has(entry.id)) continue;
                remoteEntryIds.add(entry.id);

                const localChat = localChatMap.get(entry.id);
                const hasLocalFull = localChat && !localChat._remoteOnly;
                const hashMatch = hasLocalFull && computeChatHash(localChat) === entry.hash;

                // hash 相同，保留本地版本
                if (hashMatch) {
                    mergedChats.push(localChat);
                    continue;
                }

                // 需要遠端資料：當前聊天立刻下載，其他建立空殼
                if (entry.id === currentChatId) {
                    try {
                        const chatResult = await this.client.downloadData(
                            `${CHAT_DIRECTORY}/${entry.id}.json`
                        );
                        if (chatResult.data) {
                            mergedChats.push(chatResult.data);
                            continue;
                        }
                    } catch (e) {
                        console.warn(`[WebDAV] 下載當前聊天 ${entry.id} 失敗:`, e);
                    }
                    // 下載失敗 fallback：有本地資料用本地，否則空殼
                    mergedChats.push(hasLocalFull ? localChat : buildRemoteOnlyStub(entry));
                } else {
                    mergedChats.push(buildRemoteOnlyStub(entry));
                }
            }

            // 保留本地獨有的聊天（遠端 chatIndex 中不存在且未被刪除）
            for (const localChat of localChats) {
                if (!remoteEntryIds.has(localChat.id) && !deletedIds.has(localChat.id) && !localChat._remoteOnly) {
                    mergedChats.push(localChat);
                }
            }

            // 儲存合併後的聊天到本地
            await storageAdapter.set({ [CHATS_KEY]: mergedChats });

            // 恢復快速選項
            let quickChatOptionsSynced = false;
            if (syncData.quickChatOptions && Array.isArray(syncData.quickChatOptions)) {
                await syncStorageAdapter.set({ quickChatOptions: syncData.quickChatOptions });
                quickChatOptionsSynced = true;
            }

            // 同步 API 配置
            let apiConfigSynced = false;
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

                await syncStorageAdapter.set({
                    apiConfigs: apiSettings.apiConfigs || [],
                    selectedConfigIndex: apiSettings.selectedConfigIndex ?? 0,
                    searchProvider: apiSettings.searchProvider || 'tavily',
                    tavilyApiKey: apiSettings.tavilyApiKey || '',
                    tavilyApiUrl: apiSettings.tavilyApiUrl || '',
                    exaApiKey: apiSettings.exaApiKey || '',
                    exaApiUrl: apiSettings.exaApiUrl || ''
                });
                apiConfigSynced = true;
            }

            // 快取 manifest
            await this.saveCachedManifest(syncData);

            // 清除本地數據快取
            this.clearCache();

            // 儲存 ETag
            let newETag = downloadETag;
            if (!newETag) {
                try {
                    newETag = await this.client.getRemoteETag('cerebr.json');
                } catch (etagError) {
                    console.warn('[WebDAV] 获取下载后 ETag 失败:', etagError);
                }
            }
            if (newETag) {
                await syncStorageAdapter.set({ [WEBDAV_REMOTE_ETAG_KEY]: newETag });
            }

            // 計算並儲存本地 Hash
            try {
                const localHash = await this.calculateLocalHash(true);
                if (localHash) {
                    await syncStorageAdapter.set({ [WEBDAV_LOCAL_HASH_KEY]: localHash });
                }
            } catch (hashError) {
                console.warn('[WebDAV] 储存本地 Hash 失败:', hashError);
            }

            // 記錄同步時間
            const lastSync = new Date().toISOString();
            await syncStorageAdapter.set({
                [WEBDAV_LAST_SYNC_KEY]: lastSync,
                [WEBDAV_LAST_SYNC_TIMESTAMP_KEY]: syncData.timestamp || lastSync
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
            if (remoteOnlyCount > 0) {
                message += `（${remoteOnlyCount} 个待按需加载）`;
            }
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
     * hash 基於 chatIndex + quickChatOptions + apiSettings（不含 messages，速度更快）
     */
    async getLocalSyncData(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && this._cachedLocalData && this._cachedLocalHash && (now - this._cacheTimestamp) < 5000) {
            return { data: this._cachedLocalData, hash: this._cachedLocalHash };
        }

        try {
            const result = await storageAdapter.get(CHATS_KEY);
            const chats = result[CHATS_KEY] || [];

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

            // hash 基於 chatIndex（不含 messages）以加速計算
            const chatIndexForHash = chats
                .filter(c => !c._remoteOnly)
                .map(c => buildChatIndexEntry(c));
            const hashSource = JSON.stringify({
                chatIndex: chatIndexForHash,
                quickChatOptions,
                apiSettings: syncData.apiSettings
            });

            let hash = 5381;
            for (let i = 0; i < hashSource.length; i++) {
                hash = ((hash << 5) + hash) + hashSource.charCodeAt(i);
                hash = hash & hash;
            }
            const hashString = Math.abs(hash).toString(16);

            this._cachedLocalData = syncData;
            this._cachedLocalHash = hashString;
            this._cacheTimestamp = now;

            return { data: syncData, hash: hashString };
        } catch (error) {
            console.error('[WebDAV] 获取本地同步数据失败:', error);
            return { data: null, hash: null };
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
     * 检查同步状态 - 使用 ETag 和本地 Hash 实现双向检测
     */
    async checkSyncStatus() {
        try {
            if (!this.client) {
                return { needsSync: true, direction: 'upload', reason: '客户端未初始化', cachedHash: null };
            }

            const now = Date.now();
            if (this._lastCheckSyncResult && (now - this._lastCheckSyncTime) < CHECK_SYNC_THROTTLE_MS) {
                const currentLocalHash = await this.calculateLocalHash();
                const hashResult = await syncStorageAdapter.get(WEBDAV_LOCAL_HASH_KEY);
                const lastLocalHash = hashResult[WEBDAV_LOCAL_HASH_KEY];
                const localChanged = currentLocalHash !== lastLocalHash;

                if (!localChanged && !this._lastCheckSyncResult.needsSync) {
                    return { needsSync: false, direction: null, reason: '节流期间：本地和远端均无变化', cachedHash: currentLocalHash };
                }
                if (localChanged) {
                    return { needsSync: true, direction: 'upload', reason: '节流期间：本地有新变更，需要上传', cachedHash: currentLocalHash };
                }
                return { ...this._lastCheckSyncResult, cachedHash: currentLocalHash };
            }

            const currentLocalHash = await this.calculateLocalHash();
            const hashResult = await syncStorageAdapter.get(WEBDAV_LOCAL_HASH_KEY);
            const lastLocalHash = hashResult[WEBDAV_LOCAL_HASH_KEY];
            const localChanged = currentLocalHash !== lastLocalHash;

            const remoteETag = await this.client.getRemoteETag('cerebr.json');
            const etagResult = await syncStorageAdapter.get(WEBDAV_REMOTE_ETAG_KEY);
            const lastRemoteETag = etagResult[WEBDAV_REMOTE_ETAG_KEY];
            const remoteChanged = remoteETag !== null && remoteETag !== lastRemoteETag;

            this._lastCheckSyncTime = Date.now();

            if (remoteETag === null) {
                const result = { needsSync: true, direction: 'upload', reason: '远端文件不存在，需要上传', cachedHash: currentLocalHash };
                this._lastCheckSyncResult = result;
                return result;
            }

            if (!lastRemoteETag || !lastLocalHash) {
                const result = { needsSync: true, direction: 'download', reason: '首次同步检查，需要建立基准', cachedHash: currentLocalHash };
                this._lastCheckSyncResult = result;
                return result;
            }

            if (!localChanged && !remoteChanged) {
                const result = { needsSync: false, direction: null, reason: '本地和远端均无变化', cachedHash: currentLocalHash };
                this._lastCheckSyncResult = result;
                return result;
            }

            if (localChanged && !remoteChanged) {
                const result = { needsSync: true, direction: 'upload', reason: '本地有新变更，需要上传', cachedHash: currentLocalHash };
                this._lastCheckSyncResult = result;
                return result;
            }

            if (!localChanged && remoteChanged) {
                const result = { needsSync: true, direction: 'download', reason: '远端有新变更，需要下载', cachedHash: currentLocalHash };
                this._lastCheckSyncResult = result;
                return result;
            }

            const result = { needsSync: true, direction: 'conflict', reason: '本地和远端都有变更，需要比较时间戳', cachedHash: currentLocalHash };
            this._lastCheckSyncResult = result;
            return result;

        } catch (error) {
            console.error('[WebDAV] 同步检查失败:', error);
            return { needsSync: true, direction: 'upload', reason: `检查失败: ${error.message}`, cachedHash: null };
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

        try {
            const status = await this.checkSyncStatus();

            if (!status.needsSync) {
                return { synced: false, direction: null, result: null, error: null, conflict: null };
            }

            let direction = status.direction;
            const cachedHash = status.cachedHash;

            if (direction === 'conflict') {
                const conflictInfo = await this.getConflictInfo();

                if (options.onConflict && typeof options.onConflict === 'function') {
                    const shouldShowDialog = await options.onConflict(conflictInfo);

                    if (shouldShowDialog) {
                        return {
                            synced: false,
                            direction: 'conflict',
                            result: null,
                            error: null,
                            conflict: conflictInfo
                        };
                    } else {
                        direction = conflictInfo.recommendation;
                    }
                } else {
                    direction = conflictInfo.recommendation;
                }
            }

            if (direction === 'upload') {
                const result = await this.syncToRemote({ cachedHash });
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

        const now = Date.now();
        if ((now - this._lastSyncOnCloseTime) < SYNC_ON_CLOSE_THROTTLE_MS) {
            console.log('[WebDAV] syncOnClose 节流：距离上次同步不到 ' + (SYNC_ON_CLOSE_THROTTLE_MS / 1000) + ' 秒，跳过');
            return { synced: false, result: null, error: null };
        }

        try {
            const status = await this.checkSyncStatus();

            if (status.needsSync && (status.direction === 'upload' || status.direction === 'conflict')) {
                const result = await this.syncToRemote({ cachedHash: status.cachedHash });
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
