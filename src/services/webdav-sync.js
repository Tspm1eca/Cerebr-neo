/**
 * WebDAV 同步服務
 * 提供與 WebDAV 伺服器的數據同步功能
 */

import { storageAdapter, syncStorageAdapter } from '../utils/storage-adapter.js';
import { encrypt, decrypt, isEncrypted } from '../utils/crypto.js';

// WebDAV 配置鍵
const WEBDAV_CONFIG_KEY = 'webdav_config';
const WEBDAV_LAST_SYNC_KEY = 'webdav_last_sync';
const WEBDAV_REMOTE_ETAG_KEY = 'webdav_remote_etag';
const WEBDAV_LOCAL_HASH_KEY = 'webdav_local_hash';
const WEBDAV_LAST_SYNC_TIMESTAMP_KEY = 'webdav_last_sync_timestamp';
const CHATS_KEY = 'cerebr_chats';

// HTTP 狀態碼常量
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

// 默認請求超時時間（毫秒）
const DEFAULT_TIMEOUT = 30000;

// 默認配置
const DEFAULT_CONFIG = {
    serverUrl: '',
    username: '',
    password: '',
    syncPath: '/cerebr-sync/',
    enabled: false,
    syncApiConfig: false, // 是否同步 API 配置
    encryptApiKeys: false, // 是否加密 API Keys
    encryptionPassword: '' // 加密密碼（僅存儲在本地，不同步）
};

/**
 * WebDAV 客戶端類
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
     * 獲取完整的 WebDAV URL
     */
    getFullUrl(path = '') {
        let baseUrl = this.config.serverUrl.replace(/\/+$/, '');
        let syncPath = this.config.syncPath.replace(/^\/+/, '').replace(/\/+$/, '');
        return `${baseUrl}/${syncPath}/${path}`.replace(/\/+$/, '');
    }

    /**
     * 獲取認證頭
     */
    getAuthHeaders() {
        const credentials = btoa(`${this.config.username}:${this.config.password}`);
        return {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest' // 防止瀏覽器彈出認證對話框
        };
    }

    /**
     * 帶超時的 fetch 請求
     * @param {string} url - 請求 URL
     * @param {Object} options - fetch 選項
     * @param {number} timeout - 超時時間（毫秒），默認 30000
     * @returns {Promise<Response>}
     */
    async fetchWithTimeout(url, options, timeout = DEFAULT_TIMEOUT) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        // 添加 credentials: 'omit' 防止瀏覽器自動處理認證並彈出對話框
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
                throw new Error(`請求超時（${timeout / 1000}秒）`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * 帶目錄重試的操作包裝器
     * @param {Function} operation - 要執行的操作
     * @param {string} operationName - 操作名稱（用於日誌）
     * @returns {Promise<any>}
     */
    async withDirectoryRetry(operation, operationName) {
        try {
            return await operation();
        } catch (error) {
            if (error.status === HTTP_STATUS.FAILED_DEPENDENCY || error.status === HTTP_STATUS.CONFLICT) {
                console.warn(`[WebDAV] ${operationName} 遇到目錄問題，嘗試創建後重試`);
                await this.createDirectory();
                return await operation();
            }
            throw error;
        }
    }

    /**
     * 測試連接
     */
    async testConnection() {
        if (!this.config.serverUrl || !this.config.username) {
            throw new Error('請填寫伺服器地址和用戶名');
        }

        try {
            // 嘗試 PROPFIND 請求來測試連接
            const response = await this.fetchWithTimeout(this.getFullUrl(), {
                method: 'PROPFIND',
                headers: {
                    ...this.getAuthHeaders(),
                    'Depth': '0'
                }
            });

            if (response.status === HTTP_STATUS.NOT_FOUND) {
                // 目錄不存在，嘗試創建
                const result = await this.createDirectory();
                if (result.error) {
                    throw new Error(`同步路徑不存在且創建失敗: ${result.error}`);
                }
                // 成功創建，返回普通的連接成功訊息（不特別提示已創建目錄）
                return { success: true, message: '連接成功' };
            }

            if (response.status === HTTP_STATUS.MULTI_STATUS || response.status === HTTP_STATUS.OK) {
                return { success: true, message: '連接成功' };
            }

            if (response.status === HTTP_STATUS.UNAUTHORIZED) {
                throw new Error('認證失敗，請檢查用戶名和密碼');
            }

            throw new Error(`連接失敗: HTTP ${response.status}`);
        } catch (error) {
            if (error.message.includes('Failed to fetch')) {
                throw new Error('無法連接到伺服器，請檢查地址是否正確');
            }
            throw error;
        }
    }

    /**
     * 創建同步目錄（支援多層路徑）
     * @returns {Promise<{created: boolean, error: string|null}>}
     */
    async createDirectory() {
        try {
            const response = await this.fetchWithTimeout(this.getFullUrl(), {
                method: 'MKCOL',
                headers: this.getAuthHeaders()
            });

            if (response.status === HTTP_STATUS.CREATED) {
                // 成功創建
                return { created: true, error: null };
            }

            if (response.status === HTTP_STATUS.METHOD_NOT_ALLOWED || response.status === HTTP_STATUS.MOVED_PERMANENTLY) {
                // 405: 目錄已存在
                // 301: 某些 WebDAV 伺服器對已存在目錄的回應
                return { created: false, error: null };
            }

            if (response.status === HTTP_STATUS.CONFLICT || response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                // 409 Conflict: 父目錄不存在，需要遞迴創建
                // 424 Failed Dependency: 某些 WebDAV 伺服器在父目錄不存在時返回此狀態碼
                const parentCreated = await this.createParentDirectories();
                if (parentCreated) {
                    // 重試創建目標目錄
                    return await this.createDirectory();
                }
                return { created: false, error: '無法創建父目錄' };
            }

            return { created: false, error: `HTTP ${response.status}` };
        } catch (error) {
            return { created: false, error: error.message };
        }
    }

    /**
     * 遞迴創建父目錄
     * @returns {Promise<boolean>} 是否成功創建所有父目錄
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

                // 201: 創建成功, 405/301: 已存在
                // 注意：某些伺服器可能返回 409 或 424，這裡我們繼續嘗試下一層
                if (response.status !== HTTP_STATUS.CREATED && response.status !== HTTP_STATUS.METHOD_NOT_ALLOWED &&
                    response.status !== HTTP_STATUS.MOVED_PERMANENTLY && response.status !== HTTP_STATUS.CONFLICT) {
                    // 424 表示依賴失敗，可能是更深層的父目錄問題，繼續嘗試
                    if (response.status !== HTTP_STATUS.FAILED_DEPENDENCY) {
                        console.warn(`[WebDAV] 創建目錄 ${currentPath} 失敗: HTTP ${response.status}`);
                        return false;
                    }
                }
            } catch (error) {
                console.error(`[WebDAV] 創建目錄 ${currentPath} 異常:`, error);
                return false;
            }
        }
        return true;
    }

    /**
     * 上傳數據到 WebDAV
     * @param {string} filename - 文件名
     * @param {Object} data - 要上傳的數據
     */
    async uploadData(filename, data) {
        const url = this.getFullUrl(filename);

        const doUpload = async () => {
            const response = await this.fetchWithTimeout(url, {
                method: 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(data)
            });

            // 處理 424 Failed Dependency 或 409 Conflict - 目錄可能不存在
            if (response.status === HTTP_STATUS.FAILED_DEPENDENCY || response.status === HTTP_STATUS.CONFLICT) {
                const error = new Error(`上傳失敗: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            if (!response.ok && response.status !== HTTP_STATUS.CREATED && response.status !== HTTP_STATUS.NO_CONTENT) {
                throw new Error(`上傳失敗: HTTP ${response.status}`);
            }

            return true;
        };

        return await this.withDirectoryRetry(doUpload, '上傳數據');
    }

    /**
     * 從 WebDAV 下載數據
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

            // 處理 424 Failed Dependency - 目錄可能不存在
            if (response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                const error = new Error(`下載失敗: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            if (!response.ok) {
                throw new Error(`下載失敗: HTTP ${response.status}`);
            }

            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                throw new Error('數據格式錯誤');
            }
        };

        try {
            return await this.withDirectoryRetry(doDownload, '下載數據');
        } catch (error) {
            // 如果重試後仍然是目錄問題，返回 null（文件不存在）
            if (error.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                return null;
            }
            throw error;
        }
    }

    /**
     * 刪除 WebDAV 上的文件
     */
    async deleteFile(filename) {
        const url = this.getFullUrl(filename);
        const response = await this.fetchWithTimeout(url, {
            method: 'DELETE',
            headers: this.getAuthHeaders()
        });

        if (!response.ok && response.status !== HTTP_STATUS.NOT_FOUND) {
            throw new Error(`刪除失敗: HTTP ${response.status}`);
        }

        return true;
    }

    /**
     * 獲取遠端文件的 ETag（輕量級 HEAD 請求）
     * @param {string} filename - 文件名
     * @returns {Promise<string|null>} ETag 或 Last-Modified 值，文件不存在時返回 null
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

            // 處理 424 Failed Dependency - 目錄可能不存在
            if (response.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                const error = new Error(`獲取 ETag 失敗: HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }

            if (!response.ok) {
                throw new Error(`獲取 ETag 失敗: HTTP ${response.status}`);
            }

            // 優先使用 ETag，若無則使用 Last-Modified
            return response.headers.get('ETag') || response.headers.get('Last-Modified') || null;
        };

        try {
            return await this.withDirectoryRetry(doGetETag, '獲取 ETag');
        } catch (error) {
            // 如果重試後仍然是目錄問題，返回 null（文件不存在）
            if (error.status === HTTP_STATUS.FAILED_DEPENDENCY) {
                return null;
            }
            throw error;
        }
    }

    /**
     * 獲取遠端文件列表
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
            throw new Error(`獲取文件列表失敗: HTTP ${response.status}`);
        }

        const text = await response.text();
        // 解析 WebDAV XML 響應
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
        // 快取：用於避免重複計算
        this._cachedLocalData = null;
        this._cachedLocalHash = null;
        this._cacheTimestamp = 0;
    }

    /**
     * 清除本地數據快取
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
     * 加載配置
     */
    async loadConfig() {
        try {
            const result = await syncStorageAdapter.get(WEBDAV_CONFIG_KEY);
            if (result[WEBDAV_CONFIG_KEY]) {
                this.config = { ...DEFAULT_CONFIG, ...result[WEBDAV_CONFIG_KEY] };
            }

            // 從本地存儲加載加密密碼（不同步）
            const passwordResult = await storageAdapter.get('webdav_encryption_password');
            if (passwordResult.webdav_encryption_password) {
                this.config.encryptionPassword = passwordResult.webdav_encryption_password;
            }

            this.client = new WebDAVClient(this.config);
        } catch (error) {
            console.error('加載 WebDAV 配置失敗:', error);
        }
    }

    /**
     * 保存配置
     * 注意：加密密碼不會同步到雲端，僅保存在本地
     */
    async saveConfig(config) {
        this.config = { ...this.config, ...config };

        // 創建一個不包含加密密碼的配置副本用於同步存儲
        // 加密密碼僅保存在本地，不同步到其他設備
        const configForSync = { ...this.config };
        delete configForSync.encryptionPassword;

        await syncStorageAdapter.set({ [WEBDAV_CONFIG_KEY]: configForSync });

        // 加密密碼單獨保存到本地存儲
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
     * 獲取當前配置
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * 測試連接
     */
    async testConnection() {
        if (!this.client) {
            this.client = new WebDAVClient(this.config);
        }
        return await this.client.testConnection();
    }

    /**
     * 執行同步 - 上傳本地數據到遠端
     * @param {Object} options - 選項
     * @param {string} options.cachedHash - 已計算的本地 hash（可選，避免重複計算）
     */
    async syncToRemote(options = {}) {
        if (!this.config.enabled) {
            throw new Error('WebDAV未啟用');
        }

        if (this.client.syncInProgress) {
            throw new Error('同步正在進行中');
        }

        this.client.syncInProgress = true;
        this.notifyListeners('sync-start', { direction: 'upload' });

        try {
            // 使用快取的本地數據，避免重複讀取和序列化
            const { data: localData, hash: localHash } = await this.getLocalSyncData();

            if (!localData) {
                throw new Error('無法獲取本地數據');
            }

            // 創建同步數據包（添加版本和時間戳）
            let syncData = {
                version: 1,
                timestamp: new Date().toISOString(),
                ...localData
            };

            // 如果啟用了加密且有 API 設置，則加密 API 配置
            if (this.config.encryptApiKeys && this.config.encryptionPassword && syncData.apiSettings) {
                try {
                    const encryptedApiSettings = await encrypt(syncData.apiSettings, this.config.encryptionPassword);
                    syncData.apiSettings = encryptedApiSettings;
                    syncData.apiSettingsEncrypted = true;
                    console.log('[WebDAV] API 配置已加密');
                } catch (encryptError) {
                    console.error('[WebDAV] 加密 API 配置失敗:', encryptError);
                    throw new Error('加密 API 配置失敗: ' + encryptError.message);
                }
            }

            // 上傳到 WebDAV
            await this.client.uploadData('cerebr.json', syncData);

            // 獲取並儲存新的 ETag（用於下次同步檢查）
            try {
                const newETag = await this.client.getRemoteETag('cerebr.json');
                if (newETag) {
                    await syncStorageAdapter.set({ [WEBDAV_REMOTE_ETAG_KEY]: newETag });
                }
            } catch (etagError) {
                console.warn('[WebDAV] 獲取上傳後 ETag 失敗:', etagError);
            }

            // 使用已計算的 hash 或快取的 hash，避免重複計算
            const hashToSave = options.cachedHash || localHash;
            if (hashToSave) {
                try {
                    await syncStorageAdapter.set({ [WEBDAV_LOCAL_HASH_KEY]: hashToSave });
                } catch (hashError) {
                    console.warn('[WebDAV] 儲存本地 Hash 失敗:', hashError);
                }
            }

            // 記錄最後同步時間和時間戳
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

            let message = `已上傳 ${chats.length} 個對話`;
            if (this.config.syncApiConfig) {
                message += '（含 API 配置）';
            }

            // 清除快取，因為同步完成後數據狀態已確定
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
     * 從遠端下載數據到本地
     */
    async syncFromRemote() {
        if (!this.config.enabled) {
            throw new Error('WebDAV 未啟用');
        }

        if (this.client.syncInProgress) {
            throw new Error('同步正在進行中');
        }

        this.client.syncInProgress = true;
        this.notifyListeners('sync-start', { direction: 'download' });

        try {
            // 從 WebDAV 下載數據
            const syncData = await this.client.downloadData('cerebr.json');

            if (!syncData) {
                throw new Error('遠端沒有同步數據');
            }

            if (!syncData.chats || !Array.isArray(syncData.chats)) {
                throw new Error('同步數據格式錯誤');
            }

            // 保存聊天數據到本地
            await storageAdapter.set({ [CHATS_KEY]: syncData.chats });

            // 恢復快速選項數據（默認同步）
            let quickChatOptionsSynced = false;
            if (syncData.quickChatOptions && Array.isArray(syncData.quickChatOptions)) {
                await syncStorageAdapter.set({ quickChatOptions: syncData.quickChatOptions });
                quickChatOptionsSynced = true;
            }

            // 如果啟用了同步 API 配置，且遠端數據包含 API 設置，則同步
            let apiConfigSynced = false;
            if (this.config.syncApiConfig && syncData.apiSettings) {
                let apiSettings = syncData.apiSettings;

                // 檢查 API 設置是否已加密
                if (syncData.apiSettingsEncrypted && isEncrypted(apiSettings)) {
                    // 需要解密
                    if (!this.config.encryptionPassword) {
                        throw new Error('遠端 API 配置已加密，請設置解密密碼');
                    }
                    try {
                        apiSettings = await decrypt(apiSettings, this.config.encryptionPassword);
                        console.log('[WebDAV] API 配置已解密');
                    } catch (decryptError) {
                        throw new Error('解密API配置失敗<br>密碼錯誤或數據已損壞');
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

            // 清除快取，因為本地數據已更新
            this.clearCache();

            // 獲取並儲存新的 ETag（用於下次同步檢查）
            try {
                const newETag = await this.client.getRemoteETag('cerebr.json');
                if (newETag) {
                    await syncStorageAdapter.set({ [WEBDAV_REMOTE_ETAG_KEY]: newETag });
                }
            } catch (etagError) {
                console.warn('[WebDAV] 獲取下載後 ETag 失敗:', etagError);
            }

            // 計算並儲存本地 Hash（下載後本地數據已更新，強制重新計算）
            try {
                const localHash = await this.calculateLocalHash(true);
                if (localHash) {
                    await syncStorageAdapter.set({ [WEBDAV_LOCAL_HASH_KEY]: localHash });
                }
            } catch (hashError) {
                console.warn('[WebDAV] 儲存本地 Hash 失敗:', hashError);
            }

            // 記錄最後同步時間和遠端時間戳
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

            let message = `已下載 ${syncData.chats.length} 個對話`;
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
     * 獲取最後同步時間
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
     * 獲取本地同步數據（帶快取）
     * @param {boolean} forceRefresh - 是否強制刷新快取
     * @returns {Promise<Object>} { data: Object, hash: string }
     */
    async getLocalSyncData(forceRefresh = false) {
        // 檢查快取是否有效（5秒內的快取視為有效）
        const now = Date.now();
        if (!forceRefresh && this._cachedLocalData && this._cachedLocalHash && (now - this._cacheTimestamp) < 5000) {
            return { data: this._cachedLocalData, hash: this._cachedLocalHash };
        }

        try {
            // 獲取本地聊天數據
            const result = await storageAdapter.get(CHATS_KEY);
            const chats = result[CHATS_KEY] || [];

            // 獲取快速選項數據
            const quickChatResult = await syncStorageAdapter.get('quickChatOptions');
            const quickChatOptions = quickChatResult.quickChatOptions || [];

            // 創建同步數據對象
            const syncData = {
                chats: chats,
                quickChatOptions: quickChatOptions
            };

            // 如果啟用了同步 API 配置，也包含在數據中
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

            // 計算 hash（使用 djb2 算法）
            const jsonString = JSON.stringify(syncData);
            let hash = 5381;
            for (let i = 0; i < jsonString.length; i++) {
                hash = ((hash << 5) + hash) + jsonString.charCodeAt(i);
                hash = hash & hash; // 轉換為 32 位整數
            }
            const hashString = Math.abs(hash).toString(16);

            // 更新快取
            this._cachedLocalData = syncData;
            this._cachedLocalHash = hashString;
            this._cacheTimestamp = now;

            return { data: syncData, hash: hashString };
        } catch (error) {
            console.error('[WebDAV] 獲取本地同步數據失敗:', error);
            return { data: null, hash: null };
        }
    }

    /**
     * 計算本地數據的 Hash（使用簡單的字符串 hash）
     * @param {boolean} forceRefresh - 是否強制刷新快取
     * @returns {Promise<string>} 本地數據的 hash 值
     */
    async calculateLocalHash(forceRefresh = false) {
        const { hash } = await this.getLocalSyncData(forceRefresh);
        return hash;
    }

    /**
     * 檢查同步狀態 - 使用 ETag 和本地 Hash 實現雙向檢測
     * @returns {Promise<Object>} { needsSync: boolean, direction: 'upload'|'download'|'conflict'|null, reason: string, cachedHash: string|null }
     */
    async checkSyncStatus() {
        try {
            if (!this.client) {
                return { needsSync: true, direction: 'upload', reason: '客戶端未初始化', cachedHash: null };
            }

            // 1. 計算當前本地數據的 hash（使用快取）
            const currentLocalHash = await this.calculateLocalHash();

            // 2. 獲取上次同步時儲存的本地 hash
            const hashResult = await syncStorageAdapter.get(WEBDAV_LOCAL_HASH_KEY);
            const lastLocalHash = hashResult[WEBDAV_LOCAL_HASH_KEY];

            // 3. 檢測本地是否有變更
            const localChanged = currentLocalHash !== lastLocalHash;

            // 4. 獲取遠端 ETag（輕量級 HEAD 請求）
            const remoteETag = await this.client.getRemoteETag('cerebr.json');

            // 5. 獲取上次同步時儲存的 ETag
            const etagResult = await syncStorageAdapter.get(WEBDAV_REMOTE_ETAG_KEY);
            const lastRemoteETag = etagResult[WEBDAV_REMOTE_ETAG_KEY];

            // 6. 檢測遠端是否有變更
            const remoteChanged = remoteETag !== null && remoteETag !== lastRemoteETag;

            // 7. 如果遠端文件不存在，需要上傳
            if (remoteETag === null) {
                return { needsSync: true, direction: 'upload', reason: '遠端文件不存在，需要上傳', cachedHash: currentLocalHash };
            }

            // 8. 如果沒有上次的記錄，執行同步以建立基準
            if (!lastRemoteETag || !lastLocalHash) {
                return { needsSync: true, direction: 'download', reason: '首次同步檢查，需要建立基準', cachedHash: currentLocalHash };
            }

            // 9. 根據變更情況決定同步方向
            if (!localChanged && !remoteChanged) {
                return { needsSync: false, direction: null, reason: '本地和遠端均無變化', cachedHash: currentLocalHash };
            }

            if (localChanged && !remoteChanged) {
                return { needsSync: true, direction: 'upload', reason: '本地有新變更，需要上傳', cachedHash: currentLocalHash };
            }

            if (!localChanged && remoteChanged) {
                return { needsSync: true, direction: 'download', reason: '遠端有新變更，需要下載', cachedHash: currentLocalHash };
            }

            // 10. 雙方都有變更 - 使用時間戳優先策略
            return { needsSync: true, direction: 'conflict', reason: '本地和遠端都有變更，需要比較時間戳', cachedHash: currentLocalHash };

        } catch (error) {
            console.error('[WebDAV] 同步檢查失敗:', error);
            // 檢查失敗時，保守起見執行上傳
            return { needsSync: true, direction: 'upload', reason: `檢查失敗: ${error.message}`, cachedHash: null };
        }
    }

    /**
     * 獲取衝突信息 - 返回本地和遠端的時間戳信息供用戶選擇
     * @returns {Promise<Object>} { localTimestamp, remoteTimestamp, recommendation, remoteEncrypted }
     */
    async getConflictInfo() {
        try {
            // 獲取本地最後同步時間戳
            const localResult = await syncStorageAdapter.get(WEBDAV_LAST_SYNC_TIMESTAMP_KEY);
            const localTimestamp = localResult[WEBDAV_LAST_SYNC_TIMESTAMP_KEY];

            // 獲取遠端數據的時間戳
            const remoteData = await this.client.downloadData('cerebr.json');
            const remoteTimestamp = remoteData?.timestamp;
            const remoteEncrypted = remoteData?.apiSettingsEncrypted || false;

            // 計算推薦方向
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
            console.error('[WebDAV] 獲取衝突信息失敗:', error);
            return {
                localTimestamp: null,
                remoteTimestamp: null,
                recommendation: 'upload',
                remoteEncrypted: false
            };
        }
    }

    /**
     * 解決衝突 - 使用時間戳優先策略（自動模式）
     * @returns {Promise<string>} 'upload' 或 'download'
     */
    async resolveConflict() {
        const conflictInfo = await this.getConflictInfo();
        return conflictInfo.recommendation;
    }

    /**
     * 插件開啟時執行同步（使用 ETag 和 Hash 預檢查優化，支援雙向同步）
     * @param {Object} options - 選項
     * @param {Function} options.onConflict - 衝突時的回調函數，返回 Promise<'upload'|'download'>
     * @returns {Promise<Object>} 同步結果 { synced: boolean, direction: string|null, result: Object|null, error: string|null, conflict: Object|null }
     */
    async syncOnOpen(options = {}) {
        if (!this.config.enabled) {
            return { synced: false, direction: null, result: null, error: null, conflict: null };
        }

        try {
            // 先執行輕量級檢查（會快取 hash）
            const status = await this.checkSyncStatus();

            if (!status.needsSync) {
                return { synced: false, direction: null, result: null, error: null, conflict: null };
            }

            let direction = status.direction;
            const cachedHash = status.cachedHash;

            // 如果是衝突，檢查是否有用戶選擇回調
            if (direction === 'conflict') {
                const conflictInfo = await this.getConflictInfo();

                if (options.onConflict && typeof options.onConflict === 'function') {
                    // 返回衝突信息，讓調用者處理
                    return {
                        synced: false,
                        direction: 'conflict',
                        result: null,
                        error: null,
                        conflict: conflictInfo
                    };
                } else {
                    // 沒有回調，使用自動解決
                    direction = conflictInfo.recommendation;
                }
            }

            // 根據方向執行同步，傳遞快取的 hash
            if (direction === 'upload') {
                const result = await this.syncToRemote({ cachedHash });
                return { synced: true, direction: 'upload', result, error: null, conflict: null };
            } else if (direction === 'download') {
                const result = await this.syncFromRemote();
                // 如果需要重新載入，通知監聯器
                if (result.needsReload) {
                    this.notifyListeners('sync-reload-required', { reason: '開啟同步下載了新數據' });
                }
                return { synced: true, direction: 'download', result, error: null, conflict: null };
            }

            return { synced: false, direction: null, result: null, error: null, conflict: null };
        } catch (error) {
            console.error('[WebDAV] 開啟同步失敗:', error);
            return { synced: false, direction: null, result: null, error: error.message, conflict: null };
        }
    }

    /**
     * 插件關閉時執行同步（僅上傳本地數據到遠端）
     * @returns {Promise<Object>} 同步結果 { synced: boolean, result: Object|null, error: string|null }
     */
    async syncOnClose() {
        if (!this.config.enabled) {
            return { synced: false, result: null, error: null };
        }

        try {
            // 檢查本地是否有變更（會快取 hash）
            const status = await this.checkSyncStatus();

            // 只有當本地有變更時才上傳，傳遞快取的 hash
            if (status.needsSync && (status.direction === 'upload' || status.direction === 'conflict')) {
                const result = await this.syncToRemote({ cachedHash: status.cachedHash });
                return { synced: true, result, error: null };
            }

            return { synced: false, result: null, error: null };
        } catch (error) {
            console.error('[WebDAV] 關閉同步失敗:', error);
            return { synced: false, result: null, error: error.message };
        }
    }

    /**
     * 添加事件監聽器
     */
    addListener(callback) {
        this.listeners.add(callback);
    }

    /**
     * 移除事件監聽器
     */
    removeListener(callback) {
        this.listeners.delete(callback);
    }

    /**
     * 通知所有監聽器
     */
    notifyListeners(event, data) {
        this.listeners.forEach(callback => {
            try {
                callback(event, data);
            } catch (error) {
                console.error('WebDAV 事件監聽器錯誤:', error);
            }
        });
    }
}

// 創建並導出單例實例
export const webdavSyncManager = new WebDAVSyncManager();

// 導出類以供測試
export { WebDAVClient, WebDAVSyncManager };
