/**
 * WebDAV 设置组件
 * 处理 WebDAV 同步的 UI 逻辑
 */

import { webdavSyncManager } from '../services/webdav-sync.js';
import { validatePassword } from '../utils/crypto.js';

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
    if (!timestamp) return '未知';
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
        return '未知';
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
            console.warn('[WebDAV] 冲突对话框元素不存在，使用自动解决');
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
            syncUpload,
            syncDownload
        } = this.elements;

        // 启用开关事件
        enabledSwitch?.addEventListener('change', () => this.saveSettings());

        // 服务器地址输入事件
        serverUrl?.addEventListener('change', () => this.saveSettings());
        serverUrl?.addEventListener('click', (e) => e.stopPropagation());

        // 用户名输入事件
        username?.addEventListener('change', () => this.saveSettings());
        username?.addEventListener('click', (e) => e.stopPropagation());

        // 密码输入事件
        password?.addEventListener('change', () => this.saveSettings());
        password?.addEventListener('click', (e) => e.stopPropagation());

        // 密码显示/隐藏切换
        togglePassword?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePasswordVisibility();
        });

        // 同步路径输入事件
        syncPath?.addEventListener('change', () => this.saveSettings());
        syncPath?.addEventListener('click', (e) => e.stopPropagation());

        // 同步 API 配置开关事件
        syncApiSwitch?.addEventListener('change', () => {
            this.saveSettings();
            this.updateEncryptionFieldsState();
        });

        // 加密 API Keys 开关事件
        encryptApiSwitch?.addEventListener('change', () => {
            this.saveSettings();
            this.updateEncryptionFieldsState();
        });

        // 加密密码输入事件
        encryptionPassword?.addEventListener('change', () => this.saveSettings());
        encryptionPassword?.addEventListener('click', (e) => e.stopPropagation());

        // 加密密码显示/隐藏切换
        toggleEncryptionPassword?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleEncryptionPasswordVisibility();
        });

        // 测试连接按钮事件
        testConnection?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleTestConnection();
        });

        // 上传到云端按钮事件
        syncUpload?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleSyncUpload();
        });

        // 从云端下载按钮事件
        syncDownload?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleSyncDownload();
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
        if (syncPath) syncPath.value = config.syncPath || '/cerebr-sync/';
        if (syncApiSwitch) syncApiSwitch.checked = config.syncApiConfig || false;
        if (encryptApiSwitch) encryptApiSwitch.checked = config.encryptApiKeys || false;
        if (encryptionPassword) encryptionPassword.value = config.encryptionPassword || '';

        // 更新表单禁用状态
        this.updateFormState(config.enabled);

        // 更新加密字段状态
        this.updateEncryptionFieldsState();

        // 更新最后同步时间
        await this.updateLastSyncTimeDisplay();
    }

    /**
     * 保存 WebDAV 设置
     */
    async saveSettings() {
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

        const encryptEnabled = encryptApiSwitch?.checked || false;
        const encryptPwd = encryptionPassword?.value || '';

        // 如果启用加密但密码无效，显示警告
        if (encryptEnabled && encryptPwd) {
            const validation = validatePassword(encryptPwd);
            if (!validation.valid) {
                showToast(validation.message, 'error');
            }
        }

        const config = {
            enabled: enabledSwitch?.checked || false,
            serverUrl: serverUrl?.value.trim() || '',
            username: username?.value.trim() || '',
            password: password?.value || '',
            syncPath: syncPath?.value.trim() || '/cerebr-sync/',
            syncApiConfig: syncApiSwitch?.checked || false,
            encryptApiKeys: encryptEnabled,
            encryptionPassword: encryptPwd
        };

        await webdavSyncManager.saveConfig(config);
        this.updateFormState(config.enabled);
    }

    /**
     * 更新表单禁用状态
     * @param {boolean} enabled - 是否启用
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
     * 更新加密字段的启用/禁用状态
     */
    updateEncryptionFieldsState() {
        const {
            syncApiSwitch,
            encryptApiSwitch,
            encryptionPassword,
            encryptionPasswordGroup
        } = this.elements;

        const syncApiEnabled = syncApiSwitch?.checked || false;
        const encryptEnabled = encryptApiSwitch?.checked || false;

        // 加密开关只有在同步 API 配置启用时才可用
        if (encryptApiSwitch) {
            encryptApiSwitch.disabled = !syncApiEnabled;
            const encryptToggle = encryptApiSwitch.closest('.webdav-encrypt-toggle');
            if (encryptToggle) {
                if (syncApiEnabled) {
                    encryptToggle.classList.remove('disabled');
                } else {
                    encryptToggle.classList.add('disabled');
                }
            }
        }

        // 加密密码输入框只有在加密启用时才可用
        if (encryptionPasswordGroup) {
            if (syncApiEnabled && encryptEnabled) {
                encryptionPasswordGroup.classList.remove('disabled');
                if (encryptionPassword) encryptionPassword.disabled = false;
            } else {
                encryptionPasswordGroup.classList.add('disabled');
                if (encryptionPassword) encryptionPassword.disabled = true;
            }
        }

        // 更新警告提示
        this.updateWarningDisplay(syncApiEnabled && encryptEnabled);
    }

    /**
     * 更新警告提示显示
     * @param {boolean} isEncrypted - 是否启用加密
     */
    updateWarningDisplay(isEncrypted) {
        const warningContainer = document.getElementById('webdav-api-warning');
        if (!warningContainer) return;

        const unencryptedWarning = warningContainer.querySelector('.warning-unencrypted');
        const encryptedWarning = warningContainer.querySelector('.warning-encrypted');

        if (unencryptedWarning && encryptedWarning) {
            if (isEncrypted) {
                unencryptedWarning.style.display = 'none';
                encryptedWarning.style.display = 'flex';
            } else {
                unencryptedWarning.style.display = 'flex';
                encryptedWarning.style.display = 'none';
            }
        }
    }

    /**
     * 更新最后同步时间显示
     */
    async updateLastSyncTimeDisplay() {
        const { lastSyncTime } = this.elements;
        if (!lastSyncTime) return;

        const lastSync = await webdavSyncManager.getLastSyncTime();
        if (lastSync) {
            const date = new Date(lastSync);
            // 格式化为 YYYY/MM/DD HH:mm
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
     * 切换密码可见性
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
     * 切换加密密码可见性
     */
    toggleEncryptionPasswordVisibility() {
        const { encryptionPassword, toggleEncryptionPassword } = this.elements;
        if (!encryptionPassword || !toggleEncryptionPassword) return;

        const eyeIcon = toggleEncryptionPassword.querySelector('.eye-icon');
        const eyeOffIcon = toggleEncryptionPassword.querySelector('.eye-off-icon');

        if (encryptionPassword.type === 'password') {
            encryptionPassword.type = 'text';
            if (eyeIcon) eyeIcon.style.display = 'none';
            if (eyeOffIcon) eyeOffIcon.style.display = 'block';
        } else {
            encryptionPassword.type = 'password';
            if (eyeIcon) eyeIcon.style.display = 'block';
            if (eyeOffIcon) eyeOffIcon.style.display = 'none';
        }
    }

    /**
     * 处理测试连接
     */
    async handleTestConnection() {
        const { testConnection } = this.elements;
        if (!testConnection) return;

        // 先保存当前设置
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
            showToast(`WebDAV 连接失败<br>${error.message}`, 'error');
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
     * 处理上传到云端
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
     * 处理从云端下载
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

            // 触发回调以重新载入数据
            if (result.needsReload && this.callbacks.onDataReload) {
                await this.callbacks.onDataReload(result);
            }
        } catch (error) {
            showToast('同步失败<br>' + error.message, 'error');
        } finally {
            syncDownload.classList.remove('syncing');
            syncDownload.disabled = false;
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
                showToast(`WebDAV 同步失败<br>${syncResult.error}`, 'error');
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
            showToast(`WebDAV 同步失败<br>${error.message}`, 'error');
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