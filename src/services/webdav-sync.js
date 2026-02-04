/**
 * WebDAV 同步服务
 * 提供与 WebDAV 服务器的数据同步功能
 */

import { storageAdapter, syncStorageAdapter } from '../utils/storage-adapter.js';
import { encrypt, decrypt, isEncrypted } from '../utils/crypto.js';

// WebDAV 配置键
const WEBDAV_CONFIG_KEY = 'webdav_config';
const WEBDAV_LAST_SYNC_KEY = 'webdav_last_sync';
const WEBDAV_REMOTE_ETAG_KEY = 'webdav_remote_etag';
const WEBDAV_LOCAL_HASH_KEY = 'webdav_local_hash';
const WEBDAV_LAST_SYNC_TIMESTAMP_KEY = 'webdav_last_sync_timestamp';
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
    syncPath: '/cerebr-sync/',
    enabled: false,
    syncApiConfig: false, // 是否同步 API 配置
    encryptApiKeys: false, // 是否加密 API Keys
    encryptionPassword: '' // 加密密码（仅存储在本地，不同步）
};

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
     * @param {string} url - 请求 URL
     * @param {Object} options - fetch 选项
     * @param {number} timeout - 超时时间（毫秒），默认 30000
     * @returns {Promise<Response>}
     */
    async fetchWithTimeout(url, options, timeout = DEFAULT_TIMEOUT) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        // 添加 credentials: 'omit' 防止浏览器自动处理认证并弹出对话框
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
     * @param {Function} operation - 要执行的操作
     * @param {string} operationName - 操作名称（用于日志）
     * @returns {Promise<any>}
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
            // 尝试 PROPFIND 请求来测试连接
            const response = await this.fetchWithTimeout(this.getFullUrl(), {
                method: 'PROPFIND',
                headers: {
                    ...this.getAuthHeaders(),
                    'Depth': '0'
                }
            });

            if (response.status === HTTP_STATUS.NOT_FOUND) {
                // 目录不存在，尝试创建
                const result = await this.createDirectory();
                if (result.error) {
                    throw new Error(`同步路径不存在且创建失败: ${result.error}`);
                }
                // 成功创建，返回普通的连接成功消息（不特别提示已创建目录）
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
     * @returns {Promise<{created: boolean, error: string|null}>}
     */
    async createDirectory() {
        try {
            const response = await this.fetchWithTimeout(this.getFullUrl(), {
                method: 'MKCOL',
                headers: this.getAuthHeaders()
            });

            if (response.status === HTTP_STATUS.CREATED) {
                // 成功创建
                return { created: true, error: null };
            }

            if (response.status === HTTP_STATUS.METHOD_NOT_ALLOWED || response.status === HTTP_STATUS.MOVED_PERMANENTLY) {
                // 405: 目录已存在
                // 301: 某些 WebDAV 服务器对已存在目录的回应
                return { created: false, error: null };
            }

            if (response.status === HTTP_STATUS.CONFLICT || response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                // 409 Conflict: 父目录不存在，需要递归创建
                // 424 Failed Dependency: 某些 WebDAV 服务器在父目录不存在时返回此状态码
                const parentCreated = await this.createParentDirectories();
                if (parentCreated) {
                    // 重试创建目标目录
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
     * @returns {Promise<boolean>} 是否成功创建所有父目录
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

                // 201: 创建成功, 405/301: 已存在
                // 注意：某些服务器可能返回 409 或 424，这里我们继续尝试下一层
                if (response.status !== HTTP_STATUS.CREATED && response.status !== HTTP_STATUS.METHOD_NOT_ALLOWED &&
                    response.status !== HTTP_STATUS.MOVED_PERMANENTLY && response.status !== HTTP_STATUS.CONFLICT) {
                    // 424 表示依赖失败，可能是更深层的父目录问题，继续尝试
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

    /**
     * 上传数据到 WebDAV
     * @param {string} filename - 文件名
     * @param {Object} data - 要上传的数据
     */
    async uploadData(filename, data) {
        const url = this.getFullUrl(filename);

        const doUpload = async () => {
            const response = await this.fetchWithTimeout(url, {
                method: 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(data)
            });

            // 处理 424 Failed Dependency 或 409 Conflict - 目录可能不存在
            if (response.status === HTTP_STATUS.FAILED_DEPENDENCY || response.status === HTTP_STATUS.CONFLICT) {
                const error = new Error(`上传失败: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            if (!response.ok && response.status !== HTTP_STATUS.CREATED && response.status !== HTTP_STATUS.NO_CONTENT) {
                throw new Error(`上传失败: HTTP ${response.status}`);
            }

            return true;
        };

        return await this.withDirectoryRetry(doUpload, '上传数据');
    }

    /**
     * 从 WebDAV 下载数据
     * @param {string} filename - 文件名
     */
    async downloadData(filename) {
        const url = this.getFullUrl(filename);

        const doDownload = async () => {
            const response = await this.fetchWithTimeout(url, {
                method: 'GET',
                headers: this.getAuthHeaders()
            });

            if (response.status === HTTP_STATUS.NOT_FOUND) {
                return null; // 文件不存在
            }

            // 处理 424 Failed Dependency - 目录可能不存在
            if (response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                const error = new Error(`下载失败: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            if (!response.ok) {
                throw new Error(`下载失败: HTTP ${response.status}`);
            }

            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                throw new Error('数据格式错误');
            }
        };

        try {
            return await this.withDirectoryRetry(doDownload, '下载数据');
        } catch (error) {
            // 如果重试后仍然是目录问题，返回 null（文件不存在）
            if (error.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                return null;
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
     * @param {string} filename - 文件名
     * @returns {Promise<string|null>} ETag 或 Last-Modified 值，文件不存在时返回 null
     */
    async getRemoteETag(filename) {
        const url = this.getFullUrl(filename);

        const doGetETag = async () => {
            const response = await this.fetchWithTimeout(url, {
                method: 'HEAD',
                headers: this.getAuthHeaders()
            });

            if (response.status === HTTP_STATUS.NOT_FOUND) {
                return null; // 文件不存在
            }

            // 处理 424 Failed Dependency - 目录可能不存在
            if (response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                const error = new Error(`获取 ETag 失败: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            if (!response.ok) {
                throw new Error(`获取 ETag 失败: HTTP ${response.status}`);
            }

            // 优先使用 ETag，若无则使用 Last-Modified
            return response.headers.get('ETag') || response.headers.get('Last-Modified') || null;
        };

        try {
            return await this.withDirectoryRetry(doGetETag, '获取 ETag');
        } catch (error) {
            // 如果重试后仍然是目录问题，返回 null（文件不存在）
            if (error.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                return null;
            }
            throw error;
        }
    }

    /**
     * 获取远端文件列表
     */
    async listFiles() {
        const response = await this.fetchWithTimeout(this.getFullUrl(), {
            method: 'PROPFIND',
            headers: {
                ...this.getAuthHeaders(),
                'Depth': '1'
            }
        });

        if (!response.ok && response.status !== HTTP_STATUS.MULTI_STATUS) {
            throw new Error(`获取文件列表失败: HTTP ${response.status}`);
        }

        const text = await response.text();
        // 解析 WebDAV XML 响应
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/xml');
        const responses = doc.getElementsByTagNameNS('DAV:', 'response');

        const files = [];
        for (let i = 0; i < responses.length; i++) {
            const href = responses[i].getElementsByTagNameNS('DAV:', 'href')[0];
            if (href) {
                const path = decodeURIComponent(href.textContent);
                const filename = path.split('/').filter(Boolean).pop();
                if (filename && filename.endsWith('.json')) {
                    files.push(filename);
                }
            }
        }

        return files;
    }
}

/**
 * WebDAV 同步管理器
 */
class WebDAVSyncManager {
    constructor() {
        this.client = null;
        this.config = { ...DEFAULT_CONFIG };
        this.listeners = new Set();
        // 缓存：用于避免重复计算
        this._cachedLocalData = null;
        this._cachedLocalHash = null;
        this._cacheTimestamp = 0;
    }

    /**
     * 清除本地数据缓存
     */
    clearCache() {
        this._cachedLocalData = null;
        this._cachedLocalHash = null;
        this._cacheTimestamp = 0;
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
                this.config.encryptionPassword = passwordResult.webdav_encryption_password;
            }

            this.client = new WebDAVClient(this.config);
        } catch (error) {
            console.error('加载 WebDAV 配置失败:', error);
        }
    }

    /**
     * 保存配置
     * 注意：加密密码不会同步到云端，仅保存在本地
     */
    async saveConfig(config) {
        this.config = { ...this.config, ...config };

        // 创建一个不包含加密密码的配置副本用于同步存储
        // 加密密码仅保存在本地，不同步到其他设备
        const configForSync = { ...this.config };
        delete configForSync.encryptionPassword;

        await syncStorageAdapter.set({ [WEBDAV_CONFIG_KEY]: configForSync });

        // 加密密码单独保存到本地存储
        if (config.encryptionPassword !== undefined) {
            await storageAdapter.set({ webdav_encryption_password: config.encryptionPassword });
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
     * 执行同步 - 上传本地数据到远端
     * @param {Object} options - 选项
     * @param {string} options.cachedHash - 已计算的本地 hash（可选，避免重复计算）
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
            // 使用缓存的本地数据，避免重复读取和序列化
            const { data: localData, hash: localHash } = await this.getLocalSyncData();

            if (!localData) {
                throw new Error('无法获取本地数据');
            }

            // 创建同步数据包（添加版本和时间戳）
            let syncData = {
                version: 1,
                timestamp: new Date().toISOString(),
                ...localData
            };

            // 如果启用了加密且有 API 设置，则加密 API 配置
            if (this.config.encryptApiKeys && this.config.encryptionPassword && syncData.apiSettings) {
                try {
                    const encryptedApiSettings = await encrypt(syncData.apiSettings, this.config.encryptionPassword);
                    syncData.apiSettings = encryptedApiSettings;
                    syncData.apiSettingsEncrypted = true;
                    console.log('[WebDAV] API 配置已加密');
                } catch (encryptError) {
                    console.error('[WebDAV] 加密 API 配置失败:', encryptError);
                    throw new Error('加密 API 配置失败: ' + encryptError.message);
                }
            }

            // 上传到 WebDAV
            await this.client.uploadData('cerebr.json', syncData);

            // 获取并储存新的 ETag（用于下次同步检查）
            try {
                const newETag = await this.client.getRemoteETag('cerebr.json');
                if (newETag) {
                    await syncStorageAdapter.set({ [WEBDAV_REMOTE_ETAG_KEY]: newETag });
                }
            } catch (etagError) {
                console.warn('[WebDAV] 获取上传后 ETag 失败:', etagError);
            }

            // 使用已计算的 hash 或缓存的 hash，避免重复计算
            const hashToSave = options.cachedHash || localHash;
            if (hashToSave) {
                try {
                    await syncStorageAdapter.set({ [WEBDAV_LOCAL_HASH_KEY]: hashToSave });
                } catch (hashError) {
                    console.warn('[WebDAV] 储存本地 Hash 失败:', hashError);
                }
            }

            // 记录最后同步时间和时间戳
            const lastSync = new Date().toISOString();
            await syncStorageAdapter.set({
                [WEBDAV_LAST_SYNC_KEY]: lastSync,
                [WEBDAV_LAST_SYNC_TIMESTAMP_KEY]: syncData.timestamp
            });

            const chats = localData.chats || [];
            this.notifyListeners('sync-complete', {
                direction: 'upload',
                timestamp: lastSync,
                chatCount: chats.length,
                includesApiConfig: this.config.syncApiConfig
            });

            let message = `已上传 ${chats.length} 个对话`;
            if (this.config.syncApiConfig) {
                message += '（含 API 配置）';
            }

            // 清除缓存，因为同步完成后数据状态已确定
            this.clearCache();

            return { success: true, message, timestamp: lastSync };
        } catch (error) {
            this.notifyListeners('sync-error', { direction: 'upload', error: error.message });
            throw error;
        } finally {
            this.client.syncInProgress = false;
        }
    }

    /**
     * 从远端下载数据到本地
     */
    async syncFromRemote() {
        if (!this.config.enabled) {
            throw new Error('WebDAV 未启用');
        }

        if (this.client.syncInProgress) {
            throw new Error('同步正在进行中');
        }

        this.client.syncInProgress = true;
        this.notifyListeners('sync-start', { direction: 'download' });

        try {
            // 从 WebDAV 下载数据
            const syncData = await this.client.downloadData('cerebr.json');

            if (!syncData) {
                throw new Error('远端没有同步数据');
            }

            if (!syncData.chats || !Array.isArray(syncData.chats)) {
                throw new Error('同步数据格式错误');
            }

            // 保存聊天数据到本地
            await storageAdapter.set({ [CHATS_KEY]: syncData.chats });

            // 恢复快速选项数据（默认同步）
            let quickChatOptionsSynced = false;
            if (syncData.quickChatOptions && Array.isArray(syncData.quickChatOptions)) {
                await syncStorageAdapter.set({ quickChatOptions: syncData.quickChatOptions });
                quickChatOptionsSynced = true;
            }

            // 如果启用了同步 API 配置，且远端数据包含 API 设置，则同步
            let apiConfigSynced = false;
            if (this.config.syncApiConfig && syncData.apiSettings) {
                let apiSettings = syncData.apiSettings;

                // 检查 API 设置是否已加密
                if (syncData.apiSettingsEncrypted && isEncrypted(apiSettings)) {
                    // 需要解密
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

            // 清除缓存，因为本地数据已更新
            this.clearCache();

            // 获取并储存新的 ETag（用于下次同步检查）
            try {
                const newETag = await this.client.getRemoteETag('cerebr.json');
                if (newETag) {
                    await syncStorageAdapter.set({ [WEBDAV_REMOTE_ETAG_KEY]: newETag });
                }
            } catch (etagError) {
                console.warn('[WebDAV] 获取下载后 ETag 失败:', etagError);
            }

            // 计算并储存本地 Hash（下载后本地数据已更新，强制重新计算）
            try {
                const localHash = await this.calculateLocalHash(true);
                if (localHash) {
                    await syncStorageAdapter.set({ [WEBDAV_LOCAL_HASH_KEY]: localHash });
                }
            } catch (hashError) {
                console.warn('[WebDAV] 储存本地 Hash 失败:', hashError);
            }

            // 记录最后同步时间和远端时间戳
            const lastSync = new Date().toISOString();
            await syncStorageAdapter.set({
                [WEBDAV_LAST_SYNC_KEY]: lastSync,
                [WEBDAV_LAST_SYNC_TIMESTAMP_KEY]: syncData.timestamp || lastSync
            });

            this.notifyListeners('sync-complete', {
                direction: 'download',
                timestamp: lastSync,
                chatCount: syncData.chats.length,
                apiConfigSynced
            });

            let message = `已下载 ${syncData.chats.length} 个对话`;
            if (apiConfigSynced) {
                message += '（含 API 配置）';
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
     * @param {boolean} forceRefresh - 是否强制刷新缓存
     * @returns {Promise<Object>} { data: Object, hash: string }
     */
    async getLocalSyncData(forceRefresh = false) {
        // 检查缓存是否有效（5秒内的缓存视为有效）
        const now = Date.now();
        if (!forceRefresh && this._cachedLocalData && this._cachedLocalHash && (now - this._cacheTimestamp) < 5000) {
            return { data: this._cachedLocalData, hash: this._cachedLocalHash };
        }

        try {
            // 获取本地聊天数据
            const result = await storageAdapter.get(CHATS_KEY);
            const chats = result[CHATS_KEY] || [];

            // 获取快速选项数据
            const quickChatResult = await syncStorageAdapter.get('quickChatOptions');
            const quickChatOptions = quickChatResult.quickChatOptions || [];

            // 创建同步数据对象
            const syncData = {
                chats: chats,
                quickChatOptions: quickChatOptions
            };

            // 如果启用了同步 API 配置，也包含在数据中
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

            // 计算 hash（使用 djb2 算法）
            const jsonString = JSON.stringify(syncData);
            let hash = 5381;
            for (let i = 0; i < jsonString.length; i++) {
                hash = ((hash << 5) + hash) + jsonString.charCodeAt(i);
                hash = hash & hash; // 转换为 32 位整数
            }
            const hashString = Math.abs(hash).toString(16);

            // 更新缓存
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
     * 计算本地数据的 Hash（使用简单的字符串 hash）
     * @param {boolean} forceRefresh - 是否强制刷新缓存
     * @returns {Promise<string>} 本地数据的 hash 值
     */
    async calculateLocalHash(forceRefresh = false) {
        const { hash } = await this.getLocalSyncData(forceRefresh);
        return hash;
    }

    /**
     * 检查同步状态 - 使用 ETag 和本地 Hash 实现双向检测
     * @returns {Promise<Object>} { needsSync: boolean, direction: 'upload'|'download'|'conflict'|null, reason: string, cachedHash: string|null }
     */
    async checkSyncStatus() {
        try {
            if (!this.client) {
                return { needsSync: true, direction: 'upload', reason: '客户端未初始化', cachedHash: null };
            }

            // 1. 计算当前本地数据的 hash（使用缓存）
            const currentLocalHash = await this.calculateLocalHash();

            // 2. 获取上次同步时储存的本地 hash
            const hashResult = await syncStorageAdapter.get(WEBDAV_LOCAL_HASH_KEY);
            const lastLocalHash = hashResult[WEBDAV_LOCAL_HASH_KEY];

            // 3. 检测本地是否有变更
            const localChanged = currentLocalHash !== lastLocalHash;

            // 4. 获取远端 ETag（轻量级 HEAD 请求）
            const remoteETag = await this.client.getRemoteETag('cerebr.json');

            // 5. 获取上次同步时储存的 ETag
            const etagResult = await syncStorageAdapter.get(WEBDAV_REMOTE_ETAG_KEY);
            const lastRemoteETag = etagResult[WEBDAV_REMOTE_ETAG_KEY];

            // 6. 检测远端是否有变更
            const remoteChanged = remoteETag !== null && remoteETag !== lastRemoteETag;

            // 7. 如果远端文件不存在，需要上传
            if (remoteETag === null) {
                return { needsSync: true, direction: 'upload', reason: '远端文件不存在，需要上传', cachedHash: currentLocalHash };
            }

            // 8. 如果没有上次的记录，执行同步以建立基准
            if (!lastRemoteETag || !lastLocalHash) {
                return { needsSync: true, direction: 'download', reason: '首次同步检查，需要建立基准', cachedHash: currentLocalHash };
            }

            // 9. 根据变更情况决定同步方向
            if (!localChanged && !remoteChanged) {
                return { needsSync: false, direction: null, reason: '本地和远端均无变化', cachedHash: currentLocalHash };
            }

            if (localChanged && !remoteChanged) {
                return { needsSync: true, direction: 'upload', reason: '本地有新变更，需要上传', cachedHash: currentLocalHash };
            }

            if (!localChanged && remoteChanged) {
                return { needsSync: true, direction: 'download', reason: '远端有新变更，需要下载', cachedHash: currentLocalHash };
            }

            // 10. 双方都有变更 - 使用时间戳优先策略
            return { needsSync: true, direction: 'conflict', reason: '本地和远端都有变更，需要比较时间戳', cachedHash: currentLocalHash };

        } catch (error) {
            console.error('[WebDAV] 同步检查失败:', error);
            // 检查失败时，保守起见执行上传
            return { needsSync: true, direction: 'upload', reason: `检查失败: ${error.message}`, cachedHash: null };
        }
    }

    /**
     * 获取冲突信息 - 返回本地和远端的时间戳信息供用户选择
     * @returns {Promise<Object>} { localTimestamp, remoteTimestamp, recommendation, remoteEncrypted }
     */
    async getConflictInfo() {
        try {
            // 获取本地最后同步时间戳
            const localResult = await syncStorageAdapter.get(WEBDAV_LAST_SYNC_TIMESTAMP_KEY);
            const localTimestamp = localResult[WEBDAV_LAST_SYNC_TIMESTAMP_KEY];

            // 获取远端数据的时间戳
            const remoteData = await this.client.downloadData('cerebr.json');
            const remoteTimestamp = remoteData?.timestamp;
            const remoteEncrypted = remoteData?.apiSettingsEncrypted || false;

            // 计算推荐方向
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
     * 解决冲突 - 使用时间戳优先策略（自动模式）
     * @returns {Promise<string>} 'upload' 或 'download'
     */
    async resolveConflict() {
        const conflictInfo = await this.getConflictInfo();
        return conflictInfo.recommendation;
    }

    /**
     * 插件开启时执行同步（使用 ETag 和 Hash 预检查优化，支持双向同步）
     * @param {Object} options - 选项
     * @param {Function} options.onConflict - 冲突时的回调函数，返回 Promise<'upload'|'download'>
     * @returns {Promise<Object>} 同步结果 { synced: boolean, direction: string|null, result: Object|null, error: string|null, conflict: Object|null }
     */
    async syncOnOpen(options = {}) {
        if (!this.config.enabled) {
            return { synced: false, direction: null, result: null, error: null, conflict: null };
        }

        try {
            // 先执行轻量级检查（会缓存 hash）
            const status = await this.checkSyncStatus();

            if (!status.needsSync) {
                return { synced: false, direction: null, result: null, error: null, conflict: null };
            }

            let direction = status.direction;
            const cachedHash = status.cachedHash;

            // 如果是冲突，检查是否有用户选择回调
            if (direction === 'conflict') {
                const conflictInfo = await this.getConflictInfo();

                if (options.onConflict && typeof options.onConflict === 'function') {
                    // 返回冲突信息，让调用者处理
                    return {
                        synced: false,
                        direction: 'conflict',
                        result: null,
                        error: null,
                        conflict: conflictInfo
                    };
                } else {
                    // 没有回调，使用自动解决
                    direction = conflictInfo.recommendation;
                }
            }

            // 根据方向执行同步，传递缓存的 hash
            if (direction === 'upload') {
                const result = await this.syncToRemote({ cachedHash });
                return { synced: true, direction: 'upload', result, error: null, conflict: null };
            } else if (direction === 'download') {
                const result = await this.syncFromRemote();
                // 如果需要重新载入，通知监联器
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
     * 插件关闭时执行同步（仅上传本地数据到远端）
     * @returns {Promise<Object>} 同步结果 { synced: boolean, result: Object|null, error: string|null }
     */
    async syncOnClose() {
        if (!this.config.enabled) {
            return { synced: false, result: null, error: null };
        }

        try {
            // 检查本地是否有变更（会缓存 hash）
            const status = await this.checkSyncStatus();

            // 只有当本地有变更时才上传，传递缓存的 hash
            if (status.needsSync && (status.direction === 'upload' || status.direction === 'conflict')) {
                const result = await this.syncToRemote({ cachedHash: status.cachedHash });
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
