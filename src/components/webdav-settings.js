/**
 * WebDAV 設置組件
 * 處理 WebDAV 同步的 UI 邏輯
 */

import { webdavSyncManager } from '../services/webdav-sync.js';

/**
 * 顯示 Toast 提示
 * @param {string} message - 提示訊息
 * @param {string} type - 類型 ('success' | 'error')
 */
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = type === 'success' ? 'success-toast' : 'error-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    // 2.7秒后开始淡出动画，3秒后移除提示
    setTimeout(() => {
        toast.classList.add('fade-out');
    }, 2700);

    setTimeout(() => {
        toast.remove();
    }, 3000);
}

/**
 * 格式化時間戳為可讀格式
 * @param {string} timestamp - ISO 時間戳
 * @returns {string} 格式化後的時間字符串
 */
function formatTimestamp(timestamp) {
    if (!timestamp) return '未知';
    try {
        const date = new Date(timestamp);
        return date.toLocaleString();
    } catch (e) {
        return '未知';
    }
}

/**
 * 顯示衝突解決對話框
 * @param {Object} conflictInfo - 衝突信息
 * @returns {Promise<'upload'|'download'>} 用戶選擇的方向
 */
function showConflictDialog(conflictInfo) {
    return new Promise((resolve) => {
        const modal = document.getElementById('webdav-conflict-modal');
        const localTimeEl = document.getElementById('conflict-local-time');
        const remoteTimeEl = document.getElementById('conflict-remote-time');
        const useLocalBtn = document.getElementById('conflict-use-local');
        const useRemoteBtn = document.getElementById('conflict-use-remote');

        if (!modal) {
            console.warn('[WebDAV] 衝突對話框元素不存在，使用自動解決');
            resolve(conflictInfo.recommendation);
            return;
        }

        // 更新時間顯示
        if (localTimeEl) {
            localTimeEl.textContent = formatTimestamp(conflictInfo.localTimestamp);
        }
        if (remoteTimeEl) {
            remoteTimeEl.textContent = formatTimestamp(conflictInfo.remoteTimestamp);
        }

        // 清理舊的事件監聽器
        const newUseLocalBtn = useLocalBtn.cloneNode(true);
        const newUseRemoteBtn = useRemoteBtn.cloneNode(true);
        useLocalBtn.parentNode.replaceChild(newUseLocalBtn, useLocalBtn);
        useRemoteBtn.parentNode.replaceChild(newUseRemoteBtn, useRemoteBtn);

        // 綁定新的事件監聽器
        newUseLocalBtn.addEventListener('click', () => {
            modal.style.display = 'none';
            resolve('upload');
        });

        newUseRemoteBtn.addEventListener('click', () => {
            modal.style.display = 'none';
            resolve('download');
        });

        // 顯示對話框
        modal.style.display = 'flex';
    });
}

/**
 * WebDAV 設置控制器
 */
class WebDAVSettingsController {
    constructor(options) {
        this.elements = options.elements;
        this.callbacks = options.callbacks || {};
        this.initialized = false;
    }

    /**
     * 初始化 WebDAV 設置
     */
    async initialize() {
        if (this.initialized) return;

        // 初始化 WebDAV 同步管理器
        await webdavSyncManager.initialize();

        // 綁定事件
        this.bindEvents();

        // 加載設置到 UI
        await this.loadSettings();

        // 監聽 WebDAV 同步事件
        webdavSyncManager.addListener((event, data) => {
            if (event === 'sync-complete') {
                this.updateLastSyncTimeDisplay();
            }
        });

        this.initialized = true;
    }

    /**
     * 綁定事件處理器
     */
    bindEvents() {
        const {
            enabledSwitch,
            serverUrl,
            username,
            password,
            togglePassword,
            syncPath,
            syncApiSwitch,
            testConnection,
            syncUpload,
            syncDownload
        } = this.elements;

        // 啟用開關事件
        enabledSwitch?.addEventListener('change', () => this.saveSettings());

        // 伺服器地址輸入事件
        serverUrl?.addEventListener('change', () => this.saveSettings());
        serverUrl?.addEventListener('click', (e) => e.stopPropagation());

        // 用戶名輸入事件
        username?.addEventListener('change', () => this.saveSettings());
        username?.addEventListener('click', (e) => e.stopPropagation());

        // 密碼輸入事件
        password?.addEventListener('change', () => this.saveSettings());
        password?.addEventListener('click', (e) => e.stopPropagation());

        // 密碼顯示/隱藏切換
        togglePassword?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePasswordVisibility();
        });

        // 同步路徑輸入事件
        syncPath?.addEventListener('change', () => this.saveSettings());
        syncPath?.addEventListener('click', (e) => e.stopPropagation());

        // 同步 API 配置開關事件
        syncApiSwitch?.addEventListener('change', () => this.saveSettings());

        // 測試連接按鈕事件
        testConnection?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleTestConnection();
        });

        // 上傳到雲端按鈕事件
        syncUpload?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleSyncUpload();
        });

        // 從雲端下載按鈕事件
        syncDownload?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleSyncDownload();
        });
    }

    /**
     * 加載 WebDAV 設置到 UI
     */
    async loadSettings() {
        const config = webdavSyncManager.getConfig();
        const {
            enabledSwitch,
            serverUrl,
            username,
            password,
            syncPath,
            syncApiSwitch,
            form
        } = this.elements;

        if (enabledSwitch) enabledSwitch.checked = config.enabled;
        if (serverUrl) serverUrl.value = config.serverUrl || '';
        if (username) username.value = config.username || '';
        if (password) password.value = config.password || '';
        if (syncPath) syncPath.value = config.syncPath || '/cerebr-sync/';
        if (syncApiSwitch) syncApiSwitch.checked = config.syncApiConfig || false;

        // 更新表單禁用狀態
        this.updateFormState(config.enabled);

        // 更新最後同步時間
        await this.updateLastSyncTimeDisplay();
    }

    /**
     * 保存 WebDAV 設置
     */
    async saveSettings() {
        const {
            enabledSwitch,
            serverUrl,
            username,
            password,
            syncPath,
            syncApiSwitch
        } = this.elements;

        const config = {
            enabled: enabledSwitch?.checked || false,
            serverUrl: serverUrl?.value.trim() || '',
            username: username?.value.trim() || '',
            password: password?.value || '',
            syncPath: syncPath?.value.trim() || '/cerebr-sync/',
            syncApiConfig: syncApiSwitch?.checked || false
        };

        await webdavSyncManager.saveConfig(config);
        this.updateFormState(config.enabled);
    }

    /**
     * 更新表單禁用狀態
     * @param {boolean} enabled - 是否啟用
     */
    updateFormState(enabled) {
        const { form } = this.elements;
        if (form) {
            if (enabled) {
                form.classList.remove('disabled');
            } else {
                form.classList.add('disabled');
            }
        }
    }

    /**
     * 更新最後同步時間顯示
     */
    async updateLastSyncTimeDisplay() {
        const { lastSyncTime } = this.elements;
        if (!lastSyncTime) return;

        const lastSync = await webdavSyncManager.getLastSyncTime();
        if (lastSync) {
            const date = new Date(lastSync);
            // 格式化為 YYYY/MM/DD HH:mm
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            lastSyncTime.textContent = `${year}/${month}/${day} ${hours}:${minutes}`;
        } else {
            lastSyncTime.textContent = '从未同步';
        }
    }

    /**
     * 切換密碼可見性
     */
    togglePasswordVisibility() {
        const { password, togglePassword } = this.elements;
        if (!password || !togglePassword) return;

        const eyeIcon = togglePassword.querySelector('.eye-icon');
        const eyeOffIcon = togglePassword.querySelector('.eye-off-icon');

        if (password.type === 'password') {
            password.type = 'text';
            if (eyeIcon) eyeIcon.style.display = 'none';
            if (eyeOffIcon) eyeOffIcon.style.display = 'block';
        } else {
            password.type = 'password';
            if (eyeIcon) eyeIcon.style.display = 'block';
            if (eyeOffIcon) eyeOffIcon.style.display = 'none';
        }
    }

    /**
     * 處理測試連接
     */
    async handleTestConnection() {
        const { testConnection } = this.elements;
        if (!testConnection) return;

        // 先保存當前設置
        await this.saveSettings();

        const originalBtnContent = testConnection.innerHTML;
        testConnection.disabled = true;
        testConnection.classList.add('testing');
        testConnection.innerHTML = `
            <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
        `;

        try {
            await webdavSyncManager.testConnection();
            testConnection.classList.add('success');
            testConnection.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 6L9 17l-5-5"/>
                </svg>
            `;
        } catch (error) {
            showToast(`WebDAV 连接失败: ${error.message}`, 'error');
            testConnection.classList.add('error');
            testConnection.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            `;
        } finally {
            testConnection.classList.remove('testing');
            setTimeout(() => {
                testConnection.disabled = false;
                testConnection.classList.remove('success', 'error');
                testConnection.innerHTML = originalBtnContent;
            }, 3000);
        }
    }

    /**
     * 處理上傳到雲端
     */
    async handleSyncUpload() {
        const { enabledSwitch, syncUpload } = this.elements;

        if (!enabledSwitch?.checked) {
            showToast('请先启用 WebDAV', 'error');
            return;
        }

        if (!syncUpload) return;

        syncUpload.classList.add('syncing');
        syncUpload.disabled = true;

        try {
            const result = await webdavSyncManager.syncToRemote();
            showToast(result.message, 'success');
            await this.updateLastSyncTimeDisplay();
        } catch (error) {
            showToast('上传失败: ' + error.message, 'error');
        } finally {
            syncUpload.classList.remove('syncing');
            syncUpload.disabled = false;
        }
    }

    /**
     * 處理從雲端下載
     */
    async handleSyncDownload() {
        const { enabledSwitch, syncDownload } = this.elements;

        if (!enabledSwitch?.checked) {
            showToast('请先启用 WebDAV 同步', 'error');
            return;
        }

        if (!syncDownload) return;

        syncDownload.classList.add('syncing');
        syncDownload.disabled = true;

        try {
            const result = await webdavSyncManager.syncFromRemote();
            showToast(result.message, 'success');
            await this.updateLastSyncTimeDisplay();

            // 觸發回調以重新載入數據
            if (result.needsReload && this.callbacks.onDataReload) {
                await this.callbacks.onDataReload(result);
            }
        } catch (error) {
            showToast('下载失败: ' + error.message, 'error');
        } finally {
            syncDownload.classList.remove('syncing');
            syncDownload.disabled = false;
        }
    }

    /**
     * 執行開啟時同步
     * @returns {Promise<Object>} 同步結果
     */
    async performSyncOnOpen() {
        try {
            // 首先檢查是否有衝突
            const syncResult = await webdavSyncManager.syncOnOpen({
                onConflict: () => true // 標記我們想要處理衝突
            });

            // 如果有錯誤，顯示 Toast 提示
            if (syncResult.error) {
                console.error('[WebDAV] 開啟同步失敗:', syncResult.error);
                showToast(`WebDAV 同步失敗: ${syncResult.error}`, 'error');
                return syncResult;
            }

            // 如果檢測到衝突，顯示對話框讓用戶選擇
            if (syncResult.direction === 'conflict' && syncResult.conflict) {
                const userChoice = await showConflictDialog(syncResult.conflict);

                // 根據用戶選擇執行同步
                let result;
                if (userChoice === 'upload') {
                    result = await webdavSyncManager.syncToRemote();
                    return { synced: true, direction: 'upload', result, error: null };
                } else {
                    result = await webdavSyncManager.syncFromRemote();
                    // 如果是下載，觸發回調以重新載入數據
                    if (result.needsReload && this.callbacks.onDataReload) {
                        await this.callbacks.onDataReload(result);
                    }
                    return { synced: true, direction: 'download', result, error: null };
                }
            }

            // 非衝突情況的正常處理
            if (syncResult.synced) {
                // 如果是下載，觸發回調以重新載入數據
                if (syncResult.direction === 'download' && syncResult.result?.needsReload) {
                    if (this.callbacks.onDataReload) {
                        await this.callbacks.onDataReload(syncResult.result);
                    }
                }
            }
            return syncResult;
        } catch (error) {
            console.error('[WebDAV] 開啟同步失敗:', error);
            showToast(`WebDAV 同步失敗: ${error.message}`, 'error');
            return { synced: false, direction: null, result: null, error: error.message };
        }
    }

    /**
     * 執行關閉時同步（僅上傳本地變更）
     * @returns {Promise<Object>} 同步結果
     */
    async performSyncOnClose() {
        try {
            const syncResult = await webdavSyncManager.syncOnClose();

            if (syncResult.error) {
                console.error('[WebDAV] 關閉同步失敗:', syncResult.error);
                // 關閉時不顯示 Toast，因為頁面可能已經關閉
            }

            return syncResult;
        } catch (error) {
            console.error('[WebDAV] 關閉同步失敗:', error);
            return { synced: false, result: null, error: error.message };
        }
    }
}

/**
 * 初始化 WebDAV 設置組件
 * @param {Object} options - 配置選項
 * @returns {WebDAVSettingsController} 控制器實例
 */
export function initWebDAVSettings(options) {
    const elements = {
        enabledSwitch: document.getElementById('webdav-enabled-switch'),
        serverUrl: document.getElementById('webdav-server-url'),
        username: document.getElementById('webdav-username'),
        password: document.getElementById('webdav-password'),
        togglePassword: document.getElementById('webdav-toggle-password'),
        syncPath: document.getElementById('webdav-sync-path'),
        syncApiSwitch: document.getElementById('webdav-sync-api-switch'),
        testConnection: document.getElementById('webdav-test-connection'),
        syncUpload: document.getElementById('webdav-sync-upload'),
        syncDownload: document.getElementById('webdav-sync-download'),
        lastSyncTime: document.getElementById('webdav-last-sync-time'),
        form: document.querySelector('.webdav-form'),
        ...options.elements
    };

    const controller = new WebDAVSettingsController({
        elements,
        callbacks: options.callbacks
    });

    return controller;
}

export { WebDAVSettingsController, showToast };