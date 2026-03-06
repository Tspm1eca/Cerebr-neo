/**
 * WebDAV 设置组件
 * 处理 WebDAV 同步的 UI 逻辑
 */

import { webdavSyncManager } from '../services/webdav-sync.js';
import { validatePassword } from '../utils/crypto.js';
import { t } from '../utils/i18n.js';

/**
 * 显示 Toast 提示
 * @param {string} message - 提示讯息
 * @param {string} type - 类型 ('success' | 'error')
 */
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = type === 'success' ? 'success-toast' : 'error-toast';
    toast.innerHTML = message.replace(/\n/g, '<br>');
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
 * 格式化时间戳为可读格式
 * @param {string} timestamp - ISO 时间戳
 * @returns {string} 格式化后的时间字符串，格式为 YYYY/MM/DD HH:mm
 */
function formatTimestamp(timestamp) {
    if (!timestamp) return t('common.unknown');
    try {
        const date = new Date(timestamp);
        // 格式化为 YYYY/MM/DD HH:mm
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}/${month}/${day} ${hours}:${minutes}`;
    } catch (e) {
        return t('common.unknown');
    }
}

/**
 * 显示冲突解决对话框
 * @param {Object} conflictInfo - 冲突信息
 * @returns {Promise<'upload'|'download'>} 用户选择的方向
 */
function showConflictDialog(conflictInfo) {
    return new Promise((resolve) => {
        const modal = document.getElementById('webdav-conflict-modal');
        const localTimeEl = document.getElementById('conflict-local-time');
        const remoteTimeEl = document.getElementById('conflict-remote-time');
        const useLocalBtn = document.getElementById('conflict-use-local');
        const useRemoteBtn = document.getElementById('conflict-use-remote');

        if (!modal || !useLocalBtn || !useRemoteBtn) {
            console.warn(`[WebDAV] ${t('webdav.conflictDialogMissing')}`);
            resolve(conflictInfo.recommendation);
            return;
        }

        // 更新时间显示
        if (localTimeEl) {
            localTimeEl.textContent = formatTimestamp(conflictInfo.localTimestamp);
        }
        if (remoteTimeEl) {
            remoteTimeEl.textContent = formatTimestamp(conflictInfo.remoteTimestamp);
        }

        // 清理旧的事件监听器
        const newUseLocalBtn = useLocalBtn.cloneNode(true);
        const newUseRemoteBtn = useRemoteBtn.cloneNode(true);
        useLocalBtn.parentNode.replaceChild(newUseLocalBtn, useLocalBtn);
        useRemoteBtn.parentNode.replaceChild(newUseRemoteBtn, useRemoteBtn);

        // 绑定新的事件监听器
        newUseLocalBtn.addEventListener('click', () => {
            modal.style.display = 'none';
            resolve('upload');
        });

        newUseRemoteBtn.addEventListener('click', () => {
            modal.style.display = 'none';
            resolve('download');
        });

        // 显示对话框
        modal.style.display = 'flex';
    });
}

/**
 * WebDAV 设置控制器
 */
class WebDAVSettingsController {
    constructor(options) {
        this.elements = options.elements;
        this.callbacks = options.callbacks || {};
        this.initialized = false;
        this._isTogglingEnabled = false;
    }

    /**
     * 初始化 WebDAV 设置
     */
    async initialize() {
        if (this.initialized) return;

        // 初始化 WebDAV 同步管理器
        await webdavSyncManager.initialize();

        // 绑定事件
        this.bindEvents();

        // 加载设置到 UI
        await this.loadSettings();

        // 监听 WebDAV 同步事件
        webdavSyncManager.addListener((event, data) => {
            if (event === 'sync-complete') {
                this.updateLastSyncTimeDisplay();
            }
        });

        this.initialized = true;
    }

    /**
     * 绑定事件处理器
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
            encryptApiSwitch,
            encryptionPassword,
            toggleEncryptionPassword,
            testConnection,
            syncNow
        } = this.elements;

        const saveWithoutBlocking = (overrides = {}) => {
            const safeOverrides = this._isTogglingEnabled
                ? { ...overrides, enabled: false }
                : overrides;
            this.saveSettings(safeOverrides).catch((error) => {
                console.error('[WebDAV] 保存设置失败:', error);
            });
        };

        // 启用开关事件：开启前先测试连接，成功后才真正启用并切模式
        enabledSwitch?.addEventListener('change', () => {
            this.handleEnabledToggle().catch((error) => {
                console.error('[WebDAV] 处理启用开关失败:', error);
            });
        });

        // 服务器地址输入事件
        serverUrl?.addEventListener('change', () => saveWithoutBlocking());
        serverUrl?.addEventListener('click', (e) => e.stopPropagation());

        // 用户名输入事件
        username?.addEventListener('change', () => saveWithoutBlocking());
        username?.addEventListener('click', (e) => e.stopPropagation());

        // 密码输入事件
        password?.addEventListener('change', () => saveWithoutBlocking());
        password?.addEventListener('click', (e) => e.stopPropagation());

        // 密码显示/隐藏切换
        togglePassword?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePasswordVisibility();
        });

        // 同步路径输入事件
        syncPath?.addEventListener('change', () => saveWithoutBlocking());
        syncPath?.addEventListener('click', (e) => e.stopPropagation());

        // 同步 API 配置开关事件
        syncApiSwitch?.addEventListener('change', () => {
            saveWithoutBlocking();
            this.updateEncryptionFieldsState();
        });

        // 加密 API Keys 开关事件
        encryptApiSwitch?.addEventListener('change', () => {
            saveWithoutBlocking();
            this.updateEncryptionFieldsState();
        });

        // 加密密码输入事件
        encryptionPassword?.addEventListener('change', () => {
            saveWithoutBlocking();
            this.updateEncryptionFieldsState();
        });
        encryptionPassword?.addEventListener('input', () => {
            this.updateEncryptionFieldsState();
        });
        encryptionPassword?.addEventListener('click', (e) => e.stopPropagation());

        // 加密密码显示/隐藏切换
        toggleEncryptionPassword?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleEncryptionPasswordVisibility();
        });

        // 测试连接按钮事件
        testConnection?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleTestConnection().catch((error) => {
                console.error('[WebDAV] 测试连接失败:', error);
            });
        });

        // 立即同步按钮事件
        syncNow?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleSyncNow().catch((error) => {
                console.error('[WebDAV] 立即同步失败:', error);
            });
        });
    }

    /**
     * 加载 WebDAV 设置到 UI
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
            encryptApiSwitch,
            encryptionPassword,
            form
        } = this.elements;

        if (enabledSwitch) enabledSwitch.checked = config.enabled;
        if (serverUrl) serverUrl.value = config.serverUrl || '';
        if (username) username.value = config.username || '';
        if (password) password.value = config.password || '';
        if (syncPath) syncPath.value = config.syncPath || '/Cerebr-neo';
        if (syncApiSwitch) syncApiSwitch.checked = config.syncApiConfig || false;
        if (encryptApiSwitch) encryptApiSwitch.checked = config.encryptApiKeys || false;
        if (encryptionPassword) encryptionPassword.value = config.encryptionPassword || '';

        // 更新表单禁用状态
        this.updateFormState(config.enabled);

        // 初始載入時跳過動畫
        const apiSection = document.querySelector('.webdav-sync-api-section');
        if (apiSection) {
            apiSection.style.transition = 'none';
            apiSection.offsetHeight; // 強制 reflow
            requestAnimationFrame(() => {
                apiSection.style.transition = '';
            });
        }

        // 更新加密字段状态
        this.updateEncryptionFieldsState();

        // 更新最后同步时间
        await this.updateLastSyncTimeDisplay();
    }

    /**
     * 从表单构建 WebDAV 配置对象
     */
    buildConfig(overrides = {}) {
        const {
            enabledSwitch,
            serverUrl,
            username,
            password,
            syncPath,
            syncApiSwitch,
            encryptApiSwitch,
            encryptionPassword
        } = this.elements;

        return {
            enabled: enabledSwitch?.checked || false,
            serverUrl: serverUrl?.value.trim() || '',
            username: username?.value.trim() || '',
            password: password?.value || '',
            syncPath: syncPath?.value.trim() || '/Cerebr-neo',
            syncApiConfig: syncApiSwitch?.checked || false,
            encryptApiKeys: encryptApiSwitch?.checked || false,
            encryptionPassword: encryptionPassword?.value || '',
            ...overrides
        };
    }

    /**
     * 保存 WebDAV 设置
     */
    async saveSettings(overrides = {}) {
        const config = this.buildConfig(overrides);

        // 如果启用加密但密码无效，显示警告
        if (config.encryptApiKeys && config.encryptionPassword) {
            const validation = validatePassword(config.encryptionPassword);
            if (!validation.valid) {
                showToast(validation.message, 'error');
            }
        }

        await webdavSyncManager.saveConfig(config);
        this.updateFormState(config.enabled);
        return config;
    }

    /**
     * 处理启用开关
     * 开启时会先测试连接，成功后才真正启用 WebDAV（并切换到 local sync）
     */
    async handleEnabledToggle() {
        const { enabledSwitch } = this.elements;
        if (!enabledSwitch || this._isTogglingEnabled) return;

        const targetEnabled = enabledSwitch.checked;
        if (!targetEnabled) {
            try {
                await this.saveSettings({ enabled: false });
            } catch (error) {
                enabledSwitch.checked = true;
                showToast(`${t('webdav.syncFailed')}<br>${error.message}`, 'error');
            } finally {
                this.updateEncryptionFieldsState();
            }
            return;
        }

        this._isTogglingEnabled = true;
        const baseConfig = this.buildConfig({ enabled: false });
        try {
            // 先保存连接信息但保持 disabled，避免测试前触发模式切换
            await webdavSyncManager.saveConfig(baseConfig);
            await webdavSyncManager.testConnection();

            // 连接通过后再真正启用（此时才会切换 sync 模式）
            await webdavSyncManager.saveConfig({ ...baseConfig, enabled: true });
            this.updateFormState(true);
        } catch (error) {
            enabledSwitch.checked = false;
            this.updateFormState(false);
            showToast(`${t('webdav.connectionFailed')}<br>${error.message}`, 'error');
        } finally {
            this._isTogglingEnabled = false;
            this.updateEncryptionFieldsState();
        }
    }

    /**
     * 更新表单禁用状态
     * @param {boolean} enabled - 是否启用
     */
    updateFormState(enabled) {
        const { form } = this.elements;
        form?.classList.toggle('disabled', !enabled);

        // 展開/收合同步 API 配置區域
        const apiSection = document.querySelector('.webdav-sync-api-section');
        apiSection?.classList.toggle('collapsed', !enabled);
    }

    /**
     * 更新加密字段的启用/禁用状态
     */
    updateEncryptionFieldsState() {
        const {
            enabledSwitch,
            syncApiSwitch,
            encryptApiSwitch,
            encryptionPassword,
            encryptionPasswordGroup,
            syncNow
        } = this.elements;

        const webdavEnabled = enabledSwitch?.checked || false;
        const syncApiEnabled = syncApiSwitch?.checked || false;
        const encryptEnabled = encryptApiSwitch?.checked || false;

        // 加密开关只有在同步 API 配置启用时才可用
        if (encryptApiSwitch) {
            encryptApiSwitch.disabled = !syncApiEnabled;
            const encryptToggle = encryptApiSwitch.closest('.webdav-encrypt-toggle');
            encryptToggle?.classList.toggle('disabled', !syncApiEnabled);
        }

        // 加密密码输入框只有在加密启用时才可用
        if (encryptionPasswordGroup) {
            const enabled = syncApiEnabled && encryptEnabled;
            encryptionPasswordGroup.classList.toggle('disabled', !enabled);
            if (encryptionPassword) encryptionPassword.disabled = !enabled;
        }

        // 更新警告提示（區域顯隱已由 webdav-sync-api-section 的收合動畫處理）
        const hasPassword = !!(encryptionPassword?.value);
        this.updateWarningDisplay(syncApiEnabled, encryptEnabled, hasPassword);

        // 更新同步按钮状态：WebDAV 未启用或加密开启但未输入密码时禁用
        const shouldDisable = !webdavEnabled || (syncApiEnabled && encryptEnabled && !hasPassword);
        if (syncNow) syncNow.disabled = shouldDisable;
    }

    /**
     * 更新警告提示显示
     * @param {boolean} syncApiEnabled - 是否启用同步 API 配置
     * @param {boolean} isEncrypted - 是否启用加密
     * @param {boolean} hasPassword - 是否已输入加密密码
     */
    updateWarningDisplay(syncApiEnabled, isEncrypted, hasPassword) {
        const warningContainer = document.getElementById('webdav-api-warning');
        if (!warningContainer) return;

        const unencryptedWarning = warningContainer.querySelector('.warning-unencrypted');
        const encryptedWarning = warningContainer.querySelector('.warning-encrypted');
        const needPasswordWarning = warningContainer.querySelector('.warning-need-password');

        if (unencryptedWarning && encryptedWarning && needPasswordWarning) {
            // 同步 API 配置關閉時收合警告（內容由 overflow:hidden 隱藏）
            if (!syncApiEnabled) {
                warningContainer.classList.remove('visible');
                return;
            }

            // 切換內部警告類型
            unencryptedWarning.style.display = 'none';
            encryptedWarning.style.display = 'none';
            needPasswordWarning.style.display = 'none';

            // 按条件显示对应警告
            if (isEncrypted && hasPassword) {
                encryptedWarning.style.display = 'flex';
            } else if (isEncrypted) {
                needPasswordWarning.style.display = 'flex';
            } else {
                unencryptedWarning.style.display = 'flex';
            }
            warningContainer.classList.add('visible');
        }
    }

    /**
     * 更新最后同步时间显示
     */
    async updateLastSyncTimeDisplay() {
        const { lastSyncTime } = this.elements;
        if (!lastSyncTime) return;

        const lastSync = await webdavSyncManager.getLastSyncTime();
        lastSyncTime.textContent = lastSync
            ? formatTimestamp(lastSync)
            : t('webdav.neverSynced');
    }

    /**
     * 切换密码可见性（通用）
     */
    _toggleVisibility(inputEl, toggleBtn) {
        if (!inputEl || !toggleBtn) return;
        const eyeIcon = toggleBtn.querySelector('.eye-icon');
        const eyeOffIcon = toggleBtn.querySelector('.eye-off-icon');
        const show = inputEl.type === 'password';
        inputEl.type = show ? 'text' : 'password';
        if (eyeIcon) eyeIcon.style.display = show ? 'none' : 'block';
        if (eyeOffIcon) eyeOffIcon.style.display = show ? 'block' : 'none';
    }

    /**
     * 切换密码可见性
     */
    togglePasswordVisibility() {
        this._toggleVisibility(this.elements.password, this.elements.togglePassword);
    }

    /**
     * 切换加密密码可见性
     */
    toggleEncryptionPasswordVisibility() {
        this._toggleVisibility(this.elements.encryptionPassword, this.elements.toggleEncryptionPassword);
    }

    /**
     * 处理测试连接
     */
    async handleTestConnection() {
        const { testConnection } = this.elements;
        if (!testConnection) return;

        // 先保存当前设置，但不改变 enabled 状态（避免测试连接时误触发模式切换）
        const persistedEnabled = webdavSyncManager.getConfig().enabled;
        await this.saveSettings({ enabled: persistedEnabled });

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
            showToast(`${t('webdav.connectionFailed')}<br>${error.message}`, 'error');
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
     * 处理立即同步
     */
    async handleSyncNow() {
        const { enabledSwitch, syncNow } = this.elements;

        if (!enabledSwitch?.checked) {
            showToast(t('webdav.enableFirst'), 'error');
            return;
        }

        if (!syncNow) return;

        syncNow.classList.add('syncing');
        syncNow.disabled = true;

        try {
            const status = await webdavSyncManager.checkSyncStatus();

            if (!status.needsSync) {
                // 没有检测到差异，强制上传本地数据
                const result = await webdavSyncManager.syncToRemote();
                showToast(result.message, 'success');
            } else if (status.direction === 'conflict') {
                const result = await webdavSyncManager.bidirectionalSync();
                showToast(result.message || t('webdav.syncSuccess'), 'success');
                if (result.needsReload && this.callbacks.onDataReload) {
                    await this.callbacks.onDataReload(result);
                }
            } else if (status.direction === 'upload') {
                const result = await webdavSyncManager.syncToRemote();
                showToast(result.message, 'success');
            } else if (status.direction === 'download') {
                const result = await webdavSyncManager.syncFromRemote();
                showToast(result.message, 'success');
                if (result.needsReload && this.callbacks.onDataReload) {
                    await this.callbacks.onDataReload(result);
                }
            }

            await this.updateLastSyncTimeDisplay();
        } catch (error) {
            showToast(t('webdav.syncFailed') + '<br>' + error.message, 'error');
        } finally {
            syncNow.classList.remove('syncing');
            syncNow.disabled = false;
        }
    }

    /**
     * 执行开启时同步
     * @param {Object} options - 选项
     * @param {string} options.currentChatId - 當前聊天 ID（按需下載用）
     * @returns {Promise<Object>} 同步结果
     */
    async performSyncOnOpen(options = {}) {
        try {
            const syncResult = await webdavSyncManager.syncOnOpen({
                currentChatId: options.currentChatId
            });

            // 如果有错误，显示 Toast 提示
            if (syncResult.error) {
                showToast(`${t('webdav.webdavSyncFailed')}<br>${syncResult.error}`, 'error');
                return syncResult;
            }

            // 智能合併結果
            if (syncResult.direction === 'merge' && syncResult.result) {
                showToast(syncResult.result.message, 'success');
                if (syncResult.result.needsReload && this.callbacks.onDataReload) {
                    await this.callbacks.onDataReload(syncResult.result);
                }
                return syncResult;
            }

            // 非冲突情况的正常处理
            if (syncResult.synced) {
                // 如果是下载，触发回调以重新载入数据
                if (syncResult.direction === 'download' && syncResult.result?.needsReload) {
                    if (this.callbacks.onDataReload) {
                        await this.callbacks.onDataReload(syncResult.result);
                    }
                }
            }
            return syncResult;
        } catch (error) {
            showToast(`${t('webdav.webdavSyncFailed')}<br>${error.message}`, 'error');
            return { synced: false, direction: null, result: null, error: error.message };
        }
    }

    /**
     * 执行关闭时同步（仅上传本地变更）
     * @returns {Promise<Object>} 同步结果
     */
    async performSyncOnClose() {
        try {
            const syncResult = await webdavSyncManager.syncOnClose();

            if (syncResult.error) {
                console.error('[WebDAV] 关闭同步失败:', syncResult.error);
                // 关闭时不显示 Toast，因为页面可能已经关闭
            }

            return syncResult;
        } catch (error) {
            console.error('[WebDAV] 关闭同步失败:', error);
            return { synced: false, result: null, error: error.message };
        }
    }
}

/**
 * 初始化 WebDAV 设置组件
 * @param {Object} options - 配置选项
 * @returns {WebDAVSettingsController} 控制器实例
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
        encryptApiSwitch: document.getElementById('webdav-encrypt-api-switch'),
        encryptionPassword: document.getElementById('webdav-encryption-password'),
        toggleEncryptionPassword: document.getElementById('webdav-toggle-encryption-password'),
        encryptionPasswordGroup: document.getElementById('webdav-encryption-password-group'),
        testConnection: document.getElementById('webdav-test-connection'),
        syncNow: document.getElementById('webdav-sync-now'),
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
