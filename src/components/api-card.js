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

// method markdown link
export const DEFAULT_SYSTEM_PROMPT = "1. 當你引用網頁內容時，請使用這種格式： `[編號](cite:引用內容)`。例如，如果你想引用“機器學習是一種人工智能”，請寫成 `[1](cite:機器學習是一種人工智能)`。\n2. **重要**：引用內容必須完全和網頁上看到的文字一模一樣，包括所有標點符號（如逗號、句號、引號等）。不要修改、替換、縮短或加空格。請直接從網頁上複製。\n3. 引用內容建議不超過 10-15 個字，選擇有特色的部分。\n4. 引用內容只是幫助說明，不能代替文章內容。只能放在句子的最後。\n5. 文章中的URL會給你對應的代號，比如：`(URLREF1)`。";

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
        console.error('找不到主 API 卡片元素');
        return;
    }

    const profileSelector = card.querySelector('.profile-selector');
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
    const advancedSettingsHeader = card.querySelector('.advanced-settings-header');
    const advancedSettingsContent = card.querySelector('.advanced-settings-content');
    const toggleIcon = card.querySelector('.toggle-icon');

    // 系统提示模态框
    const systemPromptModal = document.getElementById('system-prompt-modal');
    const modalTextarea = systemPromptModal?.querySelector('.system-prompt-modal-textarea');
    const modalCloseBtn = systemPromptModal?.querySelector('.system-prompt-modal-close');
    const modalCancelBtn = systemPromptModal?.querySelector('.system-prompt-modal-cancel');
    const modalSaveBtn = systemPromptModal?.querySelector('.system-prompt-modal-save');

    // 模型列表缓存
    let modelCache = {};
    let highlightedIndex = -1;

    // 更新 profile 下拉选单
    function updateProfileSelector() {
        profileSelector.innerHTML = '';
        apiConfigs.forEach((config, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = config.profileName || `配置 ${index + 1}`;
            if (index === selectedIndex) {
                option.selected = true;
            }
            profileSelector.appendChild(option);
        });
    }

    // 更新表单内容
    function updateFormContent(config) {
        if (!config) return;

        apiKeyInput.value = config.apiKey || '';
        baseUrlInput.value = config.baseUrl || '';
        modelNameInput.value = config.modelName || '';
        titleModelNameInput.value = config.titleModelName || '';
        systemPromptInput.value = config.advancedSettings?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

        // 设置高级设置的展开/折叠状态
        const isExpanded = config.advancedSettings?.isExpanded || false;
        if (isExpanded) {
            advancedSettingsContent.style.display = 'block';
            advancedSettingsContent.classList.add('visible');
        } else {
            advancedSettingsContent.style.display = 'none';
            advancedSettingsContent.classList.remove('visible');
        }
        toggleIcon.style.transform = isExpanded ? 'rotate(180deg)' : '';
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

    // Profile 选择器变更事件
    profileSelector.addEventListener('change', (e) => {
        // 先保存当前配置
        saveCurrentForm();

        const newIndex = parseInt(e.target.value, 10);
        selectedIndex = newIndex;
        updateFormContent(getCurrentConfig());
        onProfileChange(newIndex);
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
            profileName: `配置 ${apiConfigs.length + 1}`,
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

    // 重命名配置按钮
    renameProfileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const config = getCurrentConfig();
        const currentName = config.profileName || `配置 ${selectedIndex + 1}`;
        const newName = prompt('请输入新的配置名称：', currentName);

        if (newName !== null && newName.trim() !== '') {
            config.profileName = newName.trim();
            updateProfileSelector();
            onConfigChange(selectedIndex, config);
        }
    });

    // 删除配置按钮
    deleteProfileBtn.addEventListener('click', (e) => {
        e.stopPropagation();

        if (apiConfigs.length <= 1) {
            showToast('至少需要保留一个配置', 'error');
            return;
        }

        if (confirm('确定要删除当前配置吗？此操作无法撤销。')) {
            const deletedIndex = selectedIndex;
            apiConfigs.splice(deletedIndex, 1);

            // 调整选中索引
            if (selectedIndex >= apiConfigs.length) {
                selectedIndex = apiConfigs.length - 1;
            }

            updateProfileSelector();
            updateFormContent(getCurrentConfig());
            onProfileDelete(deletedIndex, selectedIndex);
        }
    });

    // 高级设置展开/折叠
    advancedSettingsHeader.addEventListener('click', (e) => {
        e.stopPropagation();

        const isCurrentlyExpanded = advancedSettingsContent.classList.contains('visible');

        if (isCurrentlyExpanded) {
            advancedSettingsContent.classList.remove('visible');
            advancedSettingsContent.classList.add('collapsing');
            toggleIcon.style.transform = '';

            setTimeout(() => {
                advancedSettingsContent.classList.remove('collapsing');
                advancedSettingsContent.style.display = 'none';
            }, 300);
        } else {
            advancedSettingsContent.style.display = 'block';
            advancedSettingsContent.offsetHeight;
            advancedSettingsContent.classList.add('expanding');
            toggleIcon.style.transform = 'rotate(180deg)';

            setTimeout(() => {
                advancedSettingsContent.classList.remove('expanding');
                advancedSettingsContent.classList.add('visible');
            }, 300);
        }

        // 更新配置
        const config = getCurrentConfig();
        if (config) {
            config.advancedSettings = {
                ...config.advancedSettings,
                isExpanded: !isCurrentlyExpanded
            };
            onConfigChange(selectedIndex, config);
        }
    });

    // 系统提示变更
    systemPromptInput.addEventListener('change', () => {
        saveCurrentForm();
    });

    // 还原系统提示按钮
    if (resetPromptBtn) {
        resetPromptBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('确定要还原系统提示为默认值吗？此操作无法撤销。')) {
                systemPromptInput.value = DEFAULT_SYSTEM_PROMPT;
                saveCurrentForm();
            }
        });
    }

    // 展开编辑系统提示按钮
    if (expandPromptBtn && systemPromptModal) {
        const modalContent = systemPromptModal.querySelector('.system-prompt-modal-content');

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
            dropdown.innerHTML = '<div class="model-list-item">请输入API Key和Base URL</div>';
            dropdown.classList.add('visible');
            return;
        }

        if (!force && modelCache[cacheKey]) {
            renderModelList(modelCache[cacheKey], input, dropdown);
            return;
        }

        dropdown.innerHTML = '<div class="model-list-item">加载中...</div>';
        dropdown.classList.add('visible');

        try {
            const response = await fetch(`${baseUrl}/models`, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`
                }
            });

            if (!response.ok) {
                throw new Error('无法获取模型列表');
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
            showToast('请输入 API Key, Base URL, 和模型名称', 'error');
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
                    messages: [{ role: 'user', content: 'ok，你好' }],
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

            button.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 6L9 17l-5-5"/>
                </svg>
            `;

        } catch (error) {
            console.error('Test connection error:', error);
            showToast(`连接失败: ${error.message}`, 'error');
            button.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            `;
        } finally {
            setTimeout(() => {
                button.disabled = false;
                button.innerHTML = originalBtnContent;
            }, 3000);
        }
    }

    // 显示 Toast 提示
    function showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = type === 'success' ? 'success-toast' : 'error-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
        }, 2700);

        setTimeout(() => {
            toast.remove();
        }, 3000);
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
        }
    };
}