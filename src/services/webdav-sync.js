/**
 * WebDAV 同步服務
 * 提供與 WebDAV 伺服器的數據同步功能
 */

import { storageAdapter, syncStorageAdapter } from '../utils/storage-adapter.js';

// WebDAV 配置鍵
const WEBDAV_CONFIG_KEY = 'webdav_config';
const WEBDAV_LAST_SYNC_KEY = 'webdav_last_sync';
const WEBDAV_REMOTE_ETAG_KEY = 'webdav_remote_etag';
const WEBDAV_LOCAL_HASH_KEY = 'webdav_local_hash';
const WEBDAV_LAST_SYNC_TIMESTAMP_KEY = 'webdav_last_sync_timestamp';
const CHATS_KEY = 'cerebr_chats';

// 默認配置
const DEFAULT_CONFIG = {
    serverUrl: '',
    username: '',
    password: '',
    syncPath: '/cerebr-sync/',
    enabled: false,
    syncApiConfig: false // 是否同步 API 配置
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
            'Content-Type': 'application/json'
        };
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
            const response = await fetch(this.getFullUrl(), {
                method: 'PROPFIND',
                headers: {
                    ...this.getAuthHeaders(),
                    'Depth': '0'
                }
            });

            if (response.status === 404) {
                // 目錄不存在，嘗試創建
                const result = await this.createDirectory();
                if (result.error) {
                    throw new Error(`同步路徑不存在且創建失敗: ${result.error}`);
                }
                // 成功創建，返回普通的連接成功訊息（不特別提示已創建目錄）
                return { success: true, message: '連接成功' };
            }

            if (response.status === 207 || response.status === 200) {
                return { success: true, message: '連接成功' };
            }

            if (response.status === 401) {
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
            const response = await fetch(this.getFullUrl(), {
                method: 'MKCOL',
                headers: this.getAuthHeaders()
            });

            if (response.status === 201) {
                // 成功創建
                return { created: true, error: null };
            }

            if (response.status === 405 || response.status === 301) {
                // 405: 目錄已存在
                // 301: 某些 WebDAV 伺服器對已存在目錄的回應
                return { created: false, error: null };
            }

            if (response.status === 409 || response.status === 424) {
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
                const response = await fetch(url, {
                    method: 'MKCOL',
                    headers: this.getAuthHeaders()
                });

                // 201: 創建成功, 405/301: 已存在
                // 注意：某些伺服器可能返回 409 或 424，這裡我們繼續嘗試下一層
                if (response.status !== 201 && response.status !== 405 &&
                    response.status !== 301 && response.status !== 409) {
                    // 424 表示依賴失敗，可能是更深層的父目錄問題，繼續嘗試
                    if (response.status !== 424) {
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
     * @param {boolean} isRetry - 是否為重試請求（內部使用）
     */
    async uploadData(filename, data, isRetry = false) {
        const url = this.getFullUrl(filename);
        let response = await fetch(url, {
            method: 'PUT',
            headers: this.getAuthHeaders(),
            body: JSON.stringify(data)
        });

        // 處理 424 Failed Dependency 或 409 Conflict - 目錄可能不存在
        if ((response.status === 424 || response.status === 409) && !isRetry) {
            console.warn(`[WebDAV] 上傳遇到 HTTP ${response.status}，嘗試創建目錄後重試`);
            const dirResult = await this.createDirectory();
            if (!dirResult.error) {
                // 重試上傳（標記為重試以避免無限循環）
                return await this.uploadData(filename, data, true);
            } else {
                throw new Error(`上傳失敗: 無法創建目錄 - ${dirResult.error}`);
            }
        }

        if (!response.ok && response.status !== 201 && response.status !== 204) {
            throw new Error(`上傳失敗: HTTP ${response.status}`);
        }

        return true;
    }

    /**
     * 從 WebDAV 下載數據
     * @param {string} filename - 文件名
     * @param {boolean} isRetry - 是否為重試請求（內部使用）
     */
    async downloadData(filename, isRetry = false) {
        const url = this.getFullUrl(filename);
        const response = await fetch(url, {
            method: 'GET',
            headers: this.getAuthHeaders()
        });

        if (response.status === 404) {
            return null; // 文件不存在
        }

        // 處理 424 Failed Dependency - 目錄可能不存在
        // 當用戶初次配置 WebDAV 但未點擊「測試連接」就直接下載時會觸發
        if (response.status === 424 && !isRetry) {
            console.warn(`[WebDAV] 下載遇到 HTTP 424，嘗試創建目錄後重試`);
            const dirResult = await this.createDirectory();
            if (!dirResult.error) {
                // 重試下載（標記為重試以避免無限循環）
                return await this.downloadData(filename, true);
            }
            // 目錄創建成功但文件仍不存在，返回 null
            return null;
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
    }

    /**
     * 刪除 WebDAV 上的文件
     */
    async deleteFile(filename) {
        const url = this.getFullUrl(filename);
        const response = await fetch(url, {
            method: 'DELETE',
            headers: this.getAuthHeaders()
        });

        if (!response.ok && response.status !== 404) {
            throw new Error(`刪除失敗: HTTP ${response.status}`);
        }

        return true;
    }

    /**
     * 獲取遠端文件的 ETag（輕量級 HEAD 請求）
     * @param {string} filename - 文件名
     * @param {boolean} isRetry - 是否為重試請求（內部使用）
     * @returns {Promise<string|null>} ETag 或 Last-Modified 值，文件不存在時返回 null
     */
    async getRemoteETag(filename, isRetry = false) {
        const url = this.getFullUrl(filename);
        const response = await fetch(url, {
            method: 'HEAD',
            headers: this.getAuthHeaders()
        });

        if (response.status === 404) {
            return null; // 文件不存在
        }

        // 處理 424 Failed Dependency - 目錄可能不存在
        // 當用戶初次配置 WebDAV 但未點擊「測試連接」就刷新頁面，下次開啟時會觸發
        if (response.status === 424 && !isRetry) {
            console.warn(`[WebDAV] 獲取 ETag 遇到 HTTP 424，嘗試創建目錄後重試`);
            const dirResult = await this.createDirectory();
            if (!dirResult.error) {
                // 重試獲取 ETag（標記為重試以避免無限循環）
                return await this.getRemoteETag(filename, true);
            }
            // 目錄創建成功但文件仍不存在，返回 null
            return null;
        }

        if (!response.ok) {
            throw new Error(`獲取 ETag 失敗: HTTP ${response.status}`);
        }

        // 優先使用 ETag，若無則使用 Last-Modified
        return response.headers.get('ETag') || response.headers.get('Last-Modified') || null;
    }

    /**
     * 獲取遠端文件列表
     */
    async listFiles() {
        const response = await fetch(this.getFullUrl(), {
            method: 'PROPFIND',
            headers: {
                ...this.getAuthHeaders(),
                'Depth': '1'
            }
        });

        if (!response.ok && response.status !== 207) {
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
            this.client = new WebDAVClient(this.config);
        } catch (error) {
            console.error('加載 WebDAV 配置失敗:', error);
        }
    }

    /**
     * 保存配置
     */
    async saveConfig(config) {
        this.config = { ...this.config, ...config };
        await syncStorageAdapter.set({ [WEBDAV_CONFIG_KEY]: this.config });

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
     */
    async syncToRemote() {
        if (!this.config.enabled) {
            throw new Error('WebDAV未啟用');
        }

        if (this.client.syncInProgress) {
            throw new Error('同步正在進行中');
        }

        this.client.syncInProgress = true;
        this.notifyListeners('sync-start', { direction: 'upload' });

        try {
            // 獲取本地聊天數據
            const result = await storageAdapter.get(CHATS_KEY);
            const chats = result[CHATS_KEY] || [];

            // 獲取快速選項數據（默認同步）
            const quickChatResult = await syncStorageAdapter.get('quickChatOptions');
            const quickChatOptions = quickChatResult.quickChatOptions || [];

            // 創建同步數據包
            const syncData = {
                version: 1,
                timestamp: new Date().toISOString(),
                chats: chats,
                quickChatOptions: quickChatOptions
            };

            // 如果啟用了同步 API 配置，則包含 API 相關設置
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

            // 計算並儲存本地 Hash（用於下次同步檢查）
            try {
                const localHash = await this.calculateLocalHash();
                if (localHash) {
                    await syncStorageAdapter.set({ [WEBDAV_LOCAL_HASH_KEY]: localHash });
                }
            } catch (hashError) {
                console.warn('[WebDAV] 儲存本地 Hash 失敗:', hashError);
            }

            // 記錄最後同步時間和時間戳
            const lastSync = new Date().toISOString();
            await syncStorageAdapter.set({
                [WEBDAV_LAST_SYNC_KEY]: lastSync,
                [WEBDAV_LAST_SYNC_TIMESTAMP_KEY]: syncData.timestamp
            });

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
                const apiSettings = syncData.apiSettings;
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

            // 獲取並儲存新的 ETag（用於下次同步檢查）
            try {
                const newETag = await this.client.getRemoteETag('cerebr.json');
                if (newETag) {
                    await syncStorageAdapter.set({ [WEBDAV_REMOTE_ETAG_KEY]: newETag });
                }
            } catch (etagError) {
                console.warn('[WebDAV] 獲取下載後 ETag 失敗:', etagError);
            }

            // 計算並儲存本地 Hash（下載後本地數據已更新，需要重新計算）
            try {
                const localHash = await this.calculateLocalHash();
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
     * 計算本地數據的 Hash（使用簡單的字符串 hash）
     * @returns {Promise<string>} 本地數據的 hash 值
     */
    async calculateLocalHash() {
        try {
            // 獲取本地聊天數據
            const result = await storageAdapter.get(CHATS_KEY);
            const chats = result[CHATS_KEY] || [];

            // 獲取快速選項數據
            const quickChatResult = await syncStorageAdapter.get('quickChatOptions');
            const quickChatOptions = quickChatResult.quickChatOptions || [];

            // 創建用於 hash 的數據對象（不包含 timestamp）
            const dataForHash = {
                chats: chats,
                quickChatOptions: quickChatOptions
            };

            // 如果啟用了同步 API 配置，也包含在 hash 計算中
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
                dataForHash.apiSettings = {
                    apiConfigs: apiConfigResult.apiConfigs || [],
                    selectedConfigIndex: apiConfigResult.selectedConfigIndex ?? 0,
                    searchProvider: apiConfigResult.searchProvider || 'tavily',
                    tavilyApiKey: apiConfigResult.tavilyApiKey || '',
                    tavilyApiUrl: apiConfigResult.tavilyApiUrl || '',
                    exaApiKey: apiConfigResult.exaApiKey || '',
                    exaApiUrl: apiConfigResult.exaApiUrl || ''
                };
            }

            // 使用簡單的字符串 hash（djb2 算法）
            const jsonString = JSON.stringify(dataForHash);
            let hash = 5381;
            for (let i = 0; i < jsonString.length; i++) {
                hash = ((hash << 5) + hash) + jsonString.charCodeAt(i);
                hash = hash & hash; // 轉換為 32 位整數
            }
            return Math.abs(hash).toString(16);
        } catch (error) {
            console.error('[WebDAV] 計算本地 hash 失敗:', error);
            return null;
        }
    }

    /**
     * 檢查同步狀態 - 使用 ETag 和本地 Hash 實現雙向檢測
     * @returns {Promise<Object>} { needsSync: boolean, direction: 'upload'|'download'|'conflict'|null, reason: string }
     */
    async checkSyncStatus() {
        try {
            if (!this.client) {
                return { needsSync: true, direction: 'upload', reason: '客戶端未初始化' };
            }

            // 1. 計算當前本地數據的 hash
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
                return { needsSync: true, direction: 'upload', reason: '遠端文件不存在，需要上傳' };
            }

            // 8. 如果沒有上次的記錄，執行同步以建立基準
            if (!lastRemoteETag || !lastLocalHash) {
                return { needsSync: true, direction: 'download', reason: '首次同步檢查，需要建立基準' };
            }

            // 9. 根據變更情況決定同步方向
            if (!localChanged && !remoteChanged) {
                return { needsSync: false, direction: null, reason: '本地和遠端均無變化' };
            }

            if (localChanged && !remoteChanged) {
                return { needsSync: true, direction: 'upload', reason: '本地有新變更，需要上傳' };
            }

            if (!localChanged && remoteChanged) {
                return { needsSync: true, direction: 'download', reason: '遠端有新變更，需要下載' };
            }

            // 10. 雙方都有變更 - 使用時間戳優先策略
            return { needsSync: true, direction: 'conflict', reason: '本地和遠端都有變更，需要比較時間戳' };

        } catch (error) {
            console.error('[WebDAV] 同步檢查失敗:', error);
            // 檢查失敗時，保守起見執行上傳
            return { needsSync: true, direction: 'upload', reason: `檢查失敗: ${error.message}` };
        }
    }

    /**
     * 解決衝突 - 使用時間戳優先策略
     * @returns {Promise<string>} 'upload' 或 'download'
     */
    async resolveConflict() {
        try {
            // 獲取本地最後同步時間戳
            const localResult = await syncStorageAdapter.get(WEBDAV_LAST_SYNC_TIMESTAMP_KEY);
            const localTimestamp = localResult[WEBDAV_LAST_SYNC_TIMESTAMP_KEY];

            // 獲取遠端數據的時間戳
            const remoteData = await this.client.downloadData('cerebr.json');
            const remoteTimestamp = remoteData?.timestamp;

            if (!localTimestamp && !remoteTimestamp) {
                // 都沒有時間戳，默認上傳
                console.log('[WebDAV] 衝突解決：無時間戳記錄，默認上傳');
                return 'upload';
            }

            if (!localTimestamp) {
                // 本地沒有時間戳，使用遠端
                console.log('[WebDAV] 衝突解決：本地無時間戳，下載遠端');
                return 'download';
            }

            if (!remoteTimestamp) {
                // 遠端沒有時間戳，使用本地
                console.log('[WebDAV] 衝突解決：遠端無時間戳，上傳本地');
                return 'upload';
            }

            // 比較時間戳
            const localTime = new Date(localTimestamp).getTime();
            const remoteTime = new Date(remoteTimestamp).getTime();

            if (localTime >= remoteTime) {
                console.log(`[WebDAV] 衝突解決：本地較新 (${localTimestamp} >= ${remoteTimestamp})，上傳`);
                return 'upload';
            } else {
                console.log(`[WebDAV] 衝突解決：遠端較新 (${remoteTimestamp} > ${localTimestamp})，下載`);
                return 'download';
            }
        } catch (error) {
            console.error('[WebDAV] 衝突解決失敗:', error);
            // 失敗時默認上傳
            return 'upload';
        }
    }

    /**
     * 插件開啟時執行同步（使用 ETag 和 Hash 預檢查優化，支援雙向同步）
     * @returns {Promise<Object>} 同步結果 { synced: boolean, direction: string|null, result: Object|null, error: string|null }
     */
    async syncOnOpen() {
        if (!this.config.enabled) {
            console.log('[WebDAV] 開啟同步：WebDAV 未啟用');
            return { synced: false, direction: null, result: null, error: null };
        }

        try {
            // 先執行輕量級檢查
            const status = await this.checkSyncStatus();

            if (!status.needsSync) {
                console.log('[WebDAV] 開啟同步檢查：無需同步 -', status.reason);
                return { synced: false, direction: null, result: null, error: null };
            }

            console.log('[WebDAV] 開啟同步檢查：需要同步 -', status.reason);

            let direction = status.direction;

            // 如果是衝突，使用時間戳優先策略解決
            if (direction === 'conflict') {
                direction = await this.resolveConflict();
                console.log('[WebDAV] 衝突已解決，同步方向:', direction);
            }

            // 根據方向執行同步
            if (direction === 'upload') {
                const result = await this.syncToRemote();
                console.log('[WebDAV] 開啟同步完成：已上傳到遠端');
                return { synced: true, direction: 'upload', result, error: null };
            } else if (direction === 'download') {
                const result = await this.syncFromRemote();
                console.log('[WebDAV] 開啟同步完成：已從遠端下載');
                // 如果需要重新載入，通知監聽器
                if (result.needsReload) {
                    this.notifyListeners('sync-reload-required', { reason: '開啟同步下載了新數據' });
                }
                return { synced: true, direction: 'download', result, error: null };
            }

            return { synced: false, direction: null, result: null, error: null };
        } catch (error) {
            console.error('[WebDAV] 開啟同步失敗:', error);
            return { synced: false, direction: null, result: null, error: error.message };
        }
    }

    /**
     * 添加事件監聽器
     */
    addListener(callback) {
        this.listeners.add(callback);
    }

    /**
     * 移除事件監聯器
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
