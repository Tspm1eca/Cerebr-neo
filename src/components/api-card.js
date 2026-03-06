/**
 * API卡片配置接口
 * @typedef {Object} APIConfig
 * @property {string} apiKey - API密钥
 * @property {string} baseUrl - API的基础URL
 * @property {string} modelName - 模型名称
 * @property {string} titleModelName - 标题生成模型名称
 * @property {string} profileName - 配置文件名称
 * @property {Object} advancedSettings - 高级设置
 * @property {string} advancedSettings.systemPrompt - 系统提示
 * @property {boolean} advancedSettings.isExpanded - 高级设置是否展开
 */

import { DEFAULT_SYSTEM_PROMPT } from '../constants/prompts.js';
import { getDefaultSystemPrompt } from '../services/remote-prompts.js';
import { t } from '../utils/i18n.js';
import { showToast } from './webdav-settings.js';

export { DEFAULT_SYSTEM_PROMPT };

/**
 * 初始化 API 卡片
 * @param {Object} params - 初始化参数
 * @param {Array<APIConfig>} params.apiConfigs - API配置列表
 * @param {number} params.selectedIndex - 当前选中的配置索引
 * @param {function} params.onProfileChange - 配置切换回调函数
 * @param {function} params.onProfileAdd - 新增配置回调函数
 * @param {function} params.onProfileDelete - 删除配置回调函数
 * @param {function} params.onConfigChange - 配置内容变更回调函数
 * @param {function} params.onSave - 保存配置回调函数
 */
export function initAPICard({
    apiConfigs,
    selectedIndex,
    onProfileChange,
    onProfileAdd,
    onProfileDelete,
    onConfigChange,
    onSave
}) {
    const card = document.querySelector('.api-card.main-api-card');
    if (!card) {
        console.error(t('api.notFoundMainCard'));
        return;
    }

    const profileSelector = card.querySelector('.profile-selector');
    const profileSelectorText = card.querySelector('.profile-selector-text');
    const profileSelectorContainer = card.querySelector('.profile-selector-container');
    const profileListDropdown = card.querySelector('.profile-list-dropdown');
    const renameProfileBtn = card.querySelector('.rename-profile-btn');
    const addProfileBtn = card.querySelector('.add-profile-btn');
    const deleteProfileBtn = card.querySelector('.delete-profile-btn');
    const apiKeyInput = card.querySelector('.api-key');
    const baseUrlInput = card.querySelector('.base-url');
    const modelNameInput = card.querySelector('.model-name');
    const titleModelNameInput = card.querySelector('.title-model-name');
    const modelListDropdowns = card.querySelectorAll('.model-list-dropdown');
    const testConnectionBtns = card.querySelectorAll('.test-connection-btn');
    const systemPromptInput = card.querySelector('.system-prompt');
    const resetPromptBtn = card.querySelector('.reset-prompt-btn');
    const expandPromptBtn = card.querySelector('.expand-prompt-btn');

    // 系统提示模态框
    const systemPromptModal = document.getElementById('system-prompt-modal');
    const modalTextarea = systemPromptModal?.querySelector('.prompt-modal-textarea');
    const modalCloseBtn = systemPromptModal?.querySelector('.prompt-modal-close');
    const modalCancelBtn = systemPromptModal?.querySelector('.prompt-modal-cancel');
    const modalSaveBtn = systemPromptModal?.querySelector('.prompt-modal-save');

    // 模型列表缓存
    let modelCache = {};
    let highlightedIndex = -1;

    // profile 下拉菜單高亮索引
    let profileHighlightedIndex = -1;

    // 切換 profile 下拉菜單顯示
    function toggleProfileDropdown(show) {
        if (show) {
            renderProfileList();
            profileListDropdown.classList.add('visible');
            profileSelectorContainer.classList.add('open');
            profileHighlightedIndex = selectedIndex;
            updateProfileHighlight();
        } else {
            profileListDropdown.classList.remove('visible');
            profileSelectorContainer.classList.remove('open');
            profileHighlightedIndex = -1;
        }
    }

    function isProfileDropdownOpen() {
        return profileListDropdown.classList.contains('visible');
    }

    // 渲染 profile 列表項
    function renderProfileList() {
        profileListDropdown.innerHTML = '';
        apiConfigs.forEach((config, index) => {
            const item = document.createElement('div');
            item.className = 'profile-list-item' + (index === selectedIndex ? ' selected' : '');
            item.textContent = config.profileName || t('api.profileDefault', { index: index + 1 });
            item.dataset.index = index;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                selectProfile(index);
            });
            profileListDropdown.appendChild(item);
        });
    }

    function updateProfileHighlight() {
        const items = profileListDropdown.querySelectorAll('.profile-list-item');
        items.forEach((item, i) => {
            item.classList.toggle('highlighted', i === profileHighlightedIndex);
        });
        if (profileHighlightedIndex >= 0 && items[profileHighlightedIndex]) {
            items[profileHighlightedIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    function selectProfile(index) {
        if (index === selectedIndex) {
            toggleProfileDropdown(false);
            return;
        }
        saveCurrentForm();
        selectedIndex = index;
        updateProfileSelectorText();
        updateFormContent(getCurrentConfig());
        onProfileChange(selectedIndex);
        toggleProfileDropdown(false);
    }

    // 更新顯示文字
    function updateProfileSelectorText() {
        const config = getCurrentConfig();
        profileSelectorText.textContent = config?.profileName || t('api.profileDefault', { index: selectedIndex + 1 });
    }

    // 更新 profile 下拉选单
    function updateProfileSelector() {
        updateProfileSelectorText();
    }

    // 更新表单内容
    function updateFormContent(config) {
        if (!config) return;

        apiKeyInput.value = config.apiKey || '';
        baseUrlInput.value = config.baseUrl || '';
        modelNameInput.value = config.modelName || '';
        titleModelNameInput.value = config.titleModelName || '';
        systemPromptInput.value = config.advancedSettings?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    }

    // 获取当前配置
    function getCurrentConfig() {
        return apiConfigs[selectedIndex];
    }

    // 保存当前表单到配置
    function saveCurrentForm() {
        const config = getCurrentConfig();
        if (!config) return;

        config.apiKey = apiKeyInput.value;
        config.baseUrl = baseUrlInput.value;
        config.modelName = modelNameInput.value;
        config.titleModelName = titleModelNameInput.value;
        config.advancedSettings = {
            ...config.advancedSettings,
            systemPrompt: systemPromptInput.value
        };

        onConfigChange(selectedIndex, config);
    }

    // 初始化
    updateProfileSelector();
    updateFormContent(getCurrentConfig());

    // Profile 選擇器點擊事件
    profileSelector.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleProfileDropdown(!isProfileDropdownOpen());
    });

    // Profile 選擇器鍵盤事件
    profileSelector.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleProfileDropdown(!isProfileDropdownOpen());
        } else if (e.key === 'Escape') {
            toggleProfileDropdown(false);
        } else if (isProfileDropdownOpen()) {
            const items = profileListDropdown.querySelectorAll('.profile-list-item');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                profileHighlightedIndex = Math.min(profileHighlightedIndex + 1, items.length - 1);
                updateProfileHighlight();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                profileHighlightedIndex = Math.max(profileHighlightedIndex - 1, 0);
                updateProfileHighlight();
            } else if (e.key === 'Enter' && profileHighlightedIndex >= 0) {
                e.preventDefault();
                selectProfile(profileHighlightedIndex);
            }
        }
    });

    // 點擊外部關閉下拉菜單
    document.addEventListener('click', (e) => {
        if (!profileSelectorContainer.contains(e.target)) {
            toggleProfileDropdown(false);
        }
    });

    // 新增配置按钮
    addProfileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 先保存当前配置
        saveCurrentForm();

        const newConfig = {
            apiKey: '',
            baseUrl: 'https://api.CloseAi.com/v1/chat/completions',
            modelName: '',
            titleModelName: '',
            profileName: t('api.profileDefault', { index: apiConfigs.length + 1 }),
            advancedSettings: {
                systemPrompt: DEFAULT_SYSTEM_PROMPT,
                isExpanded: false
            }
        };

        apiConfigs.push(newConfig);
        selectedIndex = apiConfigs.length - 1;

        updateProfileSelector();
        updateFormContent(newConfig);
        onProfileAdd(newConfig, selectedIndex);
    });

    // 重命名配置模态框元素
    const renameProfileModal = document.getElementById('rename-profile-modal');
    const renameProfileInput = document.getElementById('rename-profile-input');
    const renameProfileCancel = document.getElementById('rename-profile-cancel');
    const renameProfileConfirm = document.getElementById('rename-profile-confirm');
    const renameProfileClose = renameProfileModal?.querySelector('.input-modal-close');

    // 重命名配置按钮
    renameProfileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const config = getCurrentConfig();
        const currentName = config.profileName || t('api.profileDefault', { index: selectedIndex + 1 });

        if (renameProfileModal && renameProfileInput) {
            renameProfileInput.value = currentName;
            renameProfileModal.style.display = 'flex';
            renameProfileInput.focus();
            renameProfileInput.select();
        }
    });

    // 重命名模态框事件处理
    if (renameProfileModal) {
        const handleRenameConfirm = () => {
            const newName = renameProfileInput.value.trim();
            if (newName !== '') {
                const config = getCurrentConfig();
                config.profileName = newName;
                updateProfileSelector();
                onConfigChange(selectedIndex, config);
            }
            renameProfileModal.style.display = 'none';
        };

        const handleRenameCancel = () => {
            renameProfileModal.style.display = 'none';
        };

        renameProfileConfirm?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleRenameConfirm();
        });

        renameProfileCancel?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleRenameCancel();
        });

        renameProfileClose?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleRenameCancel();
        });

        // 点击模态框背景关闭
        renameProfileModal.addEventListener('click', (e) => {
            if (e.target === renameProfileModal) {
                handleRenameCancel();
            }
        });

        // 输入框回车确认
        renameProfileInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleRenameConfirm();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                handleRenameCancel();
            }
        });

        // 阻止输入框事件冒泡
        renameProfileInput?.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    // 删除配置模态框元素
    const deleteProfileModal = document.getElementById('delete-profile-confirm-modal');
    const cancelDeleteProfile = document.getElementById('cancel-delete-profile');
    const confirmDeleteProfile = document.getElementById('confirm-delete-profile');

    // 删除配置按钮
    deleteProfileBtn.addEventListener('click', (e) => {
        e.stopPropagation();

        if (apiConfigs.length <= 1) {
            showToast(t('api.atLeastOneProfile'), 'error');
            return;
        }

        if (deleteProfileModal) {
            deleteProfileModal.style.display = 'flex';
        }
    });

    // 删除配置模态框事件处理
    if (deleteProfileModal) {
        const handleDeleteConfirm = () => {
            const deletedIndex = selectedIndex;
            apiConfigs.splice(deletedIndex, 1);

            // 调整选中索引
            if (selectedIndex >= apiConfigs.length) {
                selectedIndex = apiConfigs.length - 1;
            }

            updateProfileSelector();
            updateFormContent(getCurrentConfig());
            onProfileDelete(deletedIndex, selectedIndex);
            deleteProfileModal.style.display = 'none';
        };

        const handleDeleteCancel = () => {
            deleteProfileModal.style.display = 'none';
        };

        confirmDeleteProfile?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleDeleteConfirm();
        });

        cancelDeleteProfile?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleDeleteCancel();
        });

        // 点击模态框背景关闭
        deleteProfileModal.addEventListener('click', (e) => {
            if (e.target === deleteProfileModal) {
                handleDeleteCancel();
            }
        });
    }

    // 系统提示变更
    systemPromptInput.addEventListener('change', () => {
        saveCurrentForm();
    });

    // 还原系统提示模态框元素
    const resetPromptModal = document.getElementById('reset-prompt-confirm-modal');
    const cancelResetPrompt = document.getElementById('cancel-reset-prompt');
    const confirmResetPrompt = document.getElementById('confirm-reset-prompt');

    // 还原系统提示按钮
    if (resetPromptBtn) {
        resetPromptBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (resetPromptModal) {
                resetPromptModal.style.display = 'flex';
            }
        });
    }

    // 还原系统提示模态框事件处理
    if (resetPromptModal) {
        const handleResetConfirm = async () => {
            try {
                systemPromptInput.value = await getDefaultSystemPrompt();
                saveCurrentForm();
            } catch (e) {
                console.warn('重置系統提示詞失敗:', e);
            } finally {
                resetPromptModal.style.display = 'none';
            }
        };

        const handleResetCancel = () => {
            resetPromptModal.style.display = 'none';
        };

        confirmResetPrompt?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleResetConfirm();
        });

        cancelResetPrompt?.addEventListener('click', (e) => {
            e.stopPropagation();
            handleResetCancel();
        });

        // 点击模态框背景关闭
        resetPromptModal.addEventListener('click', (e) => {
            if (e.target === resetPromptModal) {
                handleResetCancel();
            }
        });
    }

    // 展开编辑系统提示按钮
    if (expandPromptBtn && systemPromptModal) {
        const modalContent = systemPromptModal.querySelector('.prompt-modal-content');

        expandPromptBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            modalTextarea.value = systemPromptInput.value;
            systemPromptModal.style.display = 'flex';
        });

        // 阻止模态框内容区域的点击事件冒泡
        modalContent?.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        // 阻止 textarea 的点击和焦点事件冒泡
        modalTextarea?.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        modalTextarea?.addEventListener('focus', (e) => {
            e.stopPropagation();
        });
        modalTextarea?.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });

        // 模态框关闭按钮
        modalCloseBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            systemPromptModal.style.display = 'none';
        });

        // 模态框取消按钮
        modalCancelBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            systemPromptModal.style.display = 'none';
        });

        // 模态框保存按钮
        modalSaveBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            systemPromptInput.value = modalTextarea.value;
            saveCurrentForm();
            systemPromptModal.style.display = 'none';
        });

        // 点击模态框背景关闭（只有点击背景本身才关闭）
        systemPromptModal.addEventListener('click', (e) => {
            if (e.target === systemPromptModal) {
                systemPromptModal.style.display = 'none';
            }
        });
    }

    // 输入框变更事件
    [apiKeyInput, baseUrlInput, modelNameInput, titleModelNameInput].forEach(input => {
        input.addEventListener('change', () => {
            saveCurrentForm();
        });
    });

    // 阻止输入框点击事件冒泡
    const stopPropagation = (e) => {
        e.stopPropagation();
    };

    // 阻止 profile 选择器的点击事件冒泡
    profileSelector.addEventListener('click', stopPropagation);
    profileSelector.addEventListener('focus', stopPropagation);
    profileSelector.addEventListener('mousedown', stopPropagation);

    [apiKeyInput, baseUrlInput, modelNameInput, titleModelNameInput, systemPromptInput].forEach(input => {
        input.addEventListener('click', stopPropagation);
        input.addEventListener('focus', stopPropagation);
    });

    // 获取模型列表
    async function fetchModels(input, dropdown, force = false) {
        const apiKey = apiKeyInput.value;
        const baseUrl = baseUrlInput.value.replace(/\/chat\/completions$/, '');
        const cacheKey = `${baseUrl}:${apiKey}`;

        if (!apiKey || !baseUrl) {
            dropdown.innerHTML = `<div class="model-list-item">${t('api.enterApiKeyAndUrl')}</div>`;
            dropdown.classList.add('visible');
            return;
        }

        if (!force && modelCache[cacheKey]) {
            renderModelList(modelCache[cacheKey], input, dropdown);
            return;
        }

        dropdown.innerHTML = `<div class="model-list-item">${t('common.loading')}</div>`;
        dropdown.classList.add('visible');

        try {
            const response = await fetch(`${baseUrl}/models`, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`
                }
            });

            if (!response.ok) {
                throw new Error(t('api.cannotFetchModels'));
            }

            const data = await response.json();
            const models = data.data.map(model => model.id);
            modelCache[cacheKey] = models;
            renderModelList(models, input, dropdown);
        } catch (error) {
            console.error(error);
            dropdown.innerHTML = `<div class="model-list-item">${error.message}</div>`;
        }
    }

    function renderModelList(models, input, dropdown) {
        dropdown.innerHTML = '';
        if (models.length === 0) {
            dropdown.classList.remove('visible');
            return;
        }
        models.forEach((model, idx) => {
            const item = document.createElement('div');
            item.className = 'model-list-item';
            item.textContent = model;
            item.dataset.index = idx;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                input.value = model;
                dropdown.classList.remove('visible');
                saveCurrentForm();
            });
            dropdown.appendChild(item);
        });
        dropdown.classList.add('visible');
        highlightedIndex = -1;
    }

    function updateHighlight(dropdown) {
        const items = dropdown.querySelectorAll('.model-list-item');
        items.forEach((item, idx) => {
            if (idx === highlightedIndex) {
                item.classList.add('highlighted');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('highlighted');
            }
        });
    }

    // 测试连接按钮
    testConnectionBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            testModelConnection(e.currentTarget);
        });
    });

    async function testModelConnection(button) {
        const container = button.closest('.model-name-container');
        const input = container.querySelector('input');
        const modelName = input.value;
        const apiKey = apiKeyInput.value;
        const baseUrl = baseUrlInput.value;

        if (!apiKey || !baseUrl || !modelName) {
            showToast(t('api.enterAllFields'), 'error');
            return;
        }

        const originalBtnContent = button.innerHTML;
        button.disabled = true;
        button.innerHTML = `
            <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
        `;

        try {
            const response = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: modelName,
                    messages: [{ role: 'user', content: t('api.testMessage') }],
                    stream: false
                })
            });

            if (!response.ok) {
                let errorMsg = `HTTP error! status: ${response.status}`;
                try {
                    const errorData = await response.json();
                    errorMsg += ` - ${errorData.error?.message || JSON.stringify(errorData)}`;
                } catch (e) {
                    // ignore if response is not json
                }
                throw new Error(errorMsg);
            }

            button.classList.add('success');
            button.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 6L9 17l-5-5"/>
                </svg>
            `;

        } catch (error) {
            console.error('Test connection error:', error);
            showToast(`${t('api.connectionFailed')}<br>${error.message}`, 'error');
            button.classList.add('error');
            button.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            `;
        } finally {
            setTimeout(() => {
                button.disabled = false;
                button.classList.remove('success', 'error');
                button.innerHTML = originalBtnContent;
            }, 3000);
        }
    }

    // 点击外部关闭下拉列表
    document.addEventListener('click', (e) => {
        if (!card.contains(e.target)) {
            modelListDropdowns.forEach(dropdown => {
                dropdown.classList.remove('visible');
            });
        }
    });

    // 输入法状态跟踪
    let isComposing = false;

    [apiKeyInput, baseUrlInput, modelNameInput, titleModelNameInput, systemPromptInput].forEach(input => {
        input.addEventListener('compositionstart', () => {
            isComposing = true;
        });

        input.addEventListener('compositionend', () => {
            isComposing = false;
        });
    });

    function handleModelInputKeydown(input, dropdown, e) {
        if (!dropdown.classList.contains('visible')) return;

        const items = dropdown.querySelectorAll('.model-list-item');
        if (items.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                highlightedIndex = (highlightedIndex + 1) % items.length;
                updateHighlight(dropdown);
                break;
            case 'ArrowUp':
                e.preventDefault();
                highlightedIndex = (highlightedIndex - 1 + items.length) % items.length;
                updateHighlight(dropdown);
                break;
            case 'Enter':
                e.preventDefault();
                e.stopPropagation();
                if (highlightedIndex > -1) {
                    items[highlightedIndex].click();
                }
                break;
            case 'Escape':
                e.preventDefault();
                dropdown.classList.remove('visible');
                break;
        }
    }

    [modelNameInput, titleModelNameInput].forEach(input => {
        const dropdown = input.closest('.model-name-container').querySelector('.model-list-dropdown');
        input.addEventListener('keydown', (e) => handleModelInputKeydown(input, dropdown, e));

        input.addEventListener('focus', () => {
            fetchModels(input, dropdown);
            highlightedIndex = -1;
        });

        input.addEventListener('blur', () => {
            setTimeout(() => {
                dropdown.classList.remove('visible');
            }, 150);
        });

        input.addEventListener('input', () => {
            const searchTerm = input.value.toLowerCase();
            const cacheKey = `${baseUrlInput.value.replace(/\/chat\/completions$/, '')}:${apiKeyInput.value}`;
            if (modelCache[cacheKey]) {
                const filteredModels = modelCache[cacheKey].filter(model => model.toLowerCase().includes(searchTerm));
                renderModelList(filteredModels, input, dropdown);
            }
        });
    });

    // 返回更新函数供外部调用
    return {
        updateProfileSelector,
        updateFormContent,
        setSelectedIndex: (index) => {
            selectedIndex = index;
            updateProfileSelector();
            updateFormContent(getCurrentConfig());
        },
        // 更新配置列表（用於 WebDAV 同步後刷新）
        updateConfigs: (newConfigs, newSelectedIndex) => {
            // 清空並重新填充 apiConfigs 陣列，保持引用不變
            apiConfigs.length = 0;
            newConfigs.forEach(config => apiConfigs.push(config));
            selectedIndex = newSelectedIndex;
            updateProfileSelector();
            updateFormContent(getCurrentConfig());
        }
    };
}
