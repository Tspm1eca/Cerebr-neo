/**
 * 常用聊天選項組件
 * 處理常用聊天選項的顯示、點擊、設置等功能
 */

import { syncStorageAdapter } from '../utils/storage-adapter.js';
import { clearMessageInput } from './message-input.js';
import {
    DEFAULT_NEW_QUICK_CHAT_PROMPT,
    createDefaultQuickChatOptions
} from '../constants/prompts.js';

// 存儲鍵名
const QUICK_CHAT_OPTIONS_KEY = 'quickChatOptions';

/**
 * 初始化常用聊天選項
 * @param {Object} config - 配置對象
 * @param {HTMLElement} config.quickChatContainer - 常用選項容器
 * @param {HTMLElement} config.messageInput - 消息輸入框
 * @param {HTMLElement} config.settingsPage - 設置頁面
 * @param {HTMLElement} config.settingsButton - 設置按鈕
 * @param {HTMLElement} config.settingsMenu - 設置菜單
 * @param {Function} config.sendMessage - 發送消息的函數
 * @param {Object} config.uiConfig - UI配置對象
 */
export async function initQuickChat({
    quickChatContainer,
    messageInput,
    settingsPage,
    settingsButton,
    settingsMenu,
    sendMessage,
    uiConfig
}) {
    let quickChatOptions = [];
    const quickChatOptionsElement = document.getElementById('quick-chat-options');

    // 設置頁面渲染函數引用（用於外部調用）
    let renderSettingsOptionsRef = null;
    let updateAddButtonStateRef = null;

    // 加載常用選項配置
    async function loadQuickChatOptions() {
        try {
            const result = await syncStorageAdapter.get(QUICK_CHAT_OPTIONS_KEY);
            quickChatOptions = result.quickChatOptions || createDefaultQuickChatOptions();
        } catch (error) {
            console.error('加载常用聊天选项失败:', error);
            quickChatOptions = createDefaultQuickChatOptions();
        }
        renderQuickChatOptions();
        // 同時更新設置頁面中的選項列表（如果已初始化）
        if (renderSettingsOptionsRef) {
            renderSettingsOptionsRef();
        }
        if (updateAddButtonStateRef) {
            updateAddButtonStateRef();
        }
    }

    // 保存常用選項配置
    async function saveQuickChatOptions() {
        try {
            await syncStorageAdapter.set({ [QUICK_CHAT_OPTIONS_KEY]: quickChatOptions });
        } catch (error) {
            console.error('保存常用聊天选项失败:', error);
        }
    }

    // 渲染常用選項
    function renderQuickChatOptions() {
        if (!quickChatContainer) return;

        quickChatContainer.innerHTML = '';

        quickChatOptions.forEach(option => {
            const optionElement = createQuickChatOption(option);
            quickChatContainer.appendChild(optionElement);
        });
    }

    // 創建常用選項元素
    function createQuickChatOption(option) {
        const optionElement = document.createElement('div');
        optionElement.className = 'quick-chat-option';
        optionElement.dataset.prompt = option.prompt;
        optionElement.dataset.id = option.id;

        optionElement.innerHTML = `
            <span class="quick-chat-icon">${option.icon}</span>
            <span class="quick-chat-title">${option.title}</span>
        `;

        // 添加點擊事件
        optionElement.addEventListener('click', () => {
            handleQuickChatClick(option);
        });

        return optionElement;
    }

    // 處理常用選項點擊
    function handleQuickChatClick(option) {
        if (!messageInput || !sendMessage) return;

        // 清空輸入框
        clearMessageInput(messageInput, uiConfig);

        // 設置輸入框內容
        messageInput.textContent = option.prompt;

        // 觸發輸入事件以調整高度
        messageInput.dispatchEvent(new Event('input', { bubbles: true }));

        // 聚焦輸入框
        messageInput.focus();

        // 移動光標到末尾
        moveCaretToEnd(messageInput);

        // 隱藏選項按鈕區域（帶動畫效果）
        if (quickChatOptionsElement) {
            // 添加動畫類
            quickChatOptionsElement.classList.add('quick-chat-options-hiding');

            // 動畫完成後隱藏元素
            setTimeout(() => {
                quickChatOptionsElement.style.display = 'none';
                quickChatOptionsElement.classList.remove('quick-chat-options-hiding');
            }, 300);
        }

        // 自動發送消息
        sendMessage();
    }

    // 將光標移動到元素末尾
    function moveCaretToEnd(element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // 初始化設置頁面
    function initSettingsPage() {
        if (!settingsPage) return;

        const backButton = settingsPage.querySelector('.back-button');
        const addButton = document.getElementById('add-quick-chat-option');
        const resetButton = document.getElementById('reset-quick-chat-options');
        const optionsList = settingsPage.querySelector('.quick-chat-options-list');

        // 初始化快速選項提示詞模態框
        const quickChatPromptModal = document.getElementById('quick-chat-prompt-modal');
        if (quickChatPromptModal) {
            const modalTextarea = quickChatPromptModal.querySelector('.prompt-modal-textarea');
            const modalCloseBtn = quickChatPromptModal.querySelector('.prompt-modal-close');
            const modalCancelBtn = quickChatPromptModal.querySelector('.prompt-modal-cancel');
            const modalSaveBtn = quickChatPromptModal.querySelector('.prompt-modal-save');
            const modalContent = quickChatPromptModal.querySelector('.prompt-modal-content');

            // 模態框關閉按鈕
            modalCloseBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                quickChatPromptModal.style.display = 'none';
            });

            // 模態框取消按鈕
            modalCancelBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                quickChatPromptModal.style.display = 'none';
            });

            // 模態框保存按鈕
            modalSaveBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                const editIndex = parseInt(quickChatPromptModal.dataset.editIndex, 10);
                const currentPromptInput = quickChatPromptModal._currentPromptInput;

                if (!isNaN(editIndex) && currentPromptInput) {
                    // 更新 textarea 的值
                    currentPromptInput.value = modalTextarea.value;
                    // 更新選項數據
                    quickChatOptions[editIndex].prompt = modalTextarea.value;
                    saveQuickChatOptions();
                }
                quickChatPromptModal.style.display = 'none';
            });

            // 點擊模態框背景關閉（只有點擊背景本身才關閉）
            quickChatPromptModal.addEventListener('click', (e) => {
                if (e.target === quickChatPromptModal) {
                    quickChatPromptModal.style.display = 'none';
                }
            });

            // 阻止模態框內容區域的點擊事件冒泡
            modalContent?.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            // 阻止 textarea 的點擊和焦點事件冒泡
            modalTextarea?.addEventListener('click', (e) => {
                e.stopPropagation();
            });
            modalTextarea?.addEventListener('focus', (e) => {
                e.stopPropagation();
            });
            modalTextarea?.addEventListener('mousedown', (e) => {
                e.stopPropagation();
            });
        }

        // 添加選項按鈕事件
        addButton.addEventListener('click', () => {
            addNewQuickChatOption();
        });

        // 重置按鈕事件
        resetButton.addEventListener('click', () => {
            const modal1 = document.getElementById('reset-confirm-modal-1');
            modal1.style.display = 'flex';
        });

        // Modal 1 event listeners
        const cancelReset1 = document.getElementById('cancel-reset-1');
        const confirmReset1 = document.getElementById('confirm-reset-1');
        const modal1 = document.getElementById('reset-confirm-modal-1');

        cancelReset1.addEventListener('click', () => {
            modal1.style.display = 'none';
        });

        confirmReset1.addEventListener('click', () => {
            modal1.style.display = 'none';
            // 使用深拷貝確保完全重置，避免引用問題
            quickChatOptions = createDefaultQuickChatOptions();
            saveQuickChatOptions();
            renderQuickChatOptions();
            renderSettingsOptions();
            updateAddButtonState(); // 更新添加按钮状态
        });

        // 渲染設置選項
        function renderSettingsOptions() {
            if (!optionsList) return;

            optionsList.innerHTML = '';

            if (quickChatOptions.length === 0) {
                optionsList.innerHTML = `
                    <div class="quick-chat-empty-state">
                        <svg viewBox="0 0 24 24" fill="none">
                            <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <p>还没有常用选项</p>
                        <small>点击下方按钮添加您的第一个选项</small>
                    </div>
                `;
                return;
            }

            quickChatOptions.forEach((option, index) => {
                const optionItem = createSettingsOptionItem(option, index);
                optionsList.appendChild(optionItem);
            });
        }

        // 創建設置選項項目
        function createSettingsOptionItem(option, index) {
            const itemElement = document.createElement('div');
            itemElement.className = 'quick-chat-option-item';
            itemElement.dataset.index = index;

            itemElement.innerHTML = `
                <div class="quick-chat-option-header">
                    <div class="quick-chat-option-info">
                        <input type="text" class="quick-chat-option-icon-input" value="${option.icon}" maxlength="2">
                        <input type="text" class="quick-chat-option-title-input" value="${option.title}" placeholder="选项标题">
                    </div>
                    <div class="quick-chat-option-actions">
                        <button class="quick-chat-option-button expand" title="展开编辑">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                <path d="M2 6V2H6M14 6V2H10M2 10V14H6M14 10V14H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <button class="quick-chat-option-button delete" title="删除">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <path d="M3 4H13" stroke="currentColor" stroke-width="1.5"/>
                                <path d="M5 4V12H11V4" stroke="currentColor" stroke-width="1.5"/>
                            </svg>
                        </button>
                    </div>
                </div>
                <textarea class="quick-chat-option-prompt-input" placeholder="输入提示词">${option.prompt}</textarea>
            `;

            // 添加事件監聽器
            const iconInput = itemElement.querySelector('.quick-chat-option-icon-input');
            const titleInput = itemElement.querySelector('.quick-chat-option-title-input');
            const promptInput = itemElement.querySelector('.quick-chat-option-prompt-input');
            const expandButton = itemElement.querySelector('.quick-chat-option-button.expand');
            const deleteButton = itemElement.querySelector('.quick-chat-option-button.delete');

            // 獲取模態框元素
            const quickChatPromptModal = document.getElementById('quick-chat-prompt-modal');
            const modalTextarea = quickChatPromptModal?.querySelector('.prompt-modal-textarea');
            const modalCloseBtn = quickChatPromptModal?.querySelector('.prompt-modal-close');
            const modalCancelBtn = quickChatPromptModal?.querySelector('.prompt-modal-cancel');
            const modalSaveBtn = quickChatPromptModal?.querySelector('.prompt-modal-save');
            const modalContent = quickChatPromptModal?.querySelector('.prompt-modal-content');

            // 阻止输入框点击事件冒泡，防止触发外部的点击处理（如关闭菜单等）导致焦点丢失
            const stopPropagation = (e) => {
                e.stopPropagation();
            };

            [iconInput, titleInput, promptInput].forEach(input => {
                input.addEventListener('click', stopPropagation);
                // 注意：这里不需要阻止 focus 事件的冒泡，因为 focus 不会冒泡，
                // 但有些框架或浏览器行为可能会模拟 focusin/focusout 冒泡。
                // 为了保险起见，可以保留，或者只处理 click。
                // 参考 api-card.js 的实现，这里也加上。
                input.addEventListener('focus', stopPropagation);
            });

            // 圖標輸入事件
            iconInput.addEventListener('input', (e) => {
                quickChatOptions[index].icon = e.target.value;
                saveQuickChatOptions();
                renderQuickChatOptions();
            });

            // 標題輸入事件
            titleInput.addEventListener('input', (e) => {
                quickChatOptions[index].title = e.target.value;
                saveQuickChatOptions();
                renderQuickChatOptions();
            });

            // 提示詞輸入事件
            promptInput.addEventListener('input', (e) => {
                quickChatOptions[index].prompt = e.target.value;
                saveQuickChatOptions();
            });

            // 展開編輯按鈕事件
            if (expandButton && quickChatPromptModal) {
                expandButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    modalTextarea.value = promptInput.value;
                    // 存儲當前編輯的索引和對應的 promptInput
                    quickChatPromptModal.dataset.editIndex = index;
                    quickChatPromptModal._currentPromptInput = promptInput;
                    quickChatPromptModal.style.display = 'flex';
                });

                // 阻止模態框內容區域的點擊事件冒泡
                modalContent?.addEventListener('click', (e) => {
                    e.stopPropagation();
                });

                // 阻止 textarea 的點擊和焦點事件冒泡
                modalTextarea?.addEventListener('click', (e) => {
                    e.stopPropagation();
                });
                modalTextarea?.addEventListener('focus', (e) => {
                    e.stopPropagation();
                });
                modalTextarea?.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                });
            }

            // 刪除按鈕事件
            deleteButton.addEventListener('click', () => {
                const deleteModal = document.getElementById('delete-quick-chat-option-modal');
                const cancelBtn = document.getElementById('cancel-delete-quick-chat-option');
                const confirmBtn = document.getElementById('confirm-delete-quick-chat-option');

                if (deleteModal && cancelBtn && confirmBtn) {
                    // 顯示模態框
                    deleteModal.style.display = 'flex';

                    // 移除舊的事件監聽器（避免重複綁定）
                    const newCancelBtn = cancelBtn.cloneNode(true);
                    const newConfirmBtn = confirmBtn.cloneNode(true);
                    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
                    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

                    // 取消按鈕事件
                    newCancelBtn.addEventListener('click', () => {
                        deleteModal.style.display = 'none';
                    });

                    // 確認按鈕事件
                    newConfirmBtn.addEventListener('click', () => {
                        deleteModal.style.display = 'none';
                        quickChatOptions.splice(index, 1);
                        saveQuickChatOptions();
                        renderQuickChatOptions();
                        renderSettingsOptions();
                        updateAddButtonState(); // 更新添加按钮状态
                    });
                }
            });

            return itemElement;
        }

        // 添加新選項
        function addNewQuickChatOption() {
            if (quickChatOptions.length >= 4) {
                alert('最多只能添加四个快速选项。');
                return;
            }

            const newOption = {
                id: 'custom-' + Date.now(),
                title: '新选项',
                prompt: DEFAULT_NEW_QUICK_CHAT_PROMPT,
                icon: '⭐'
            };

            quickChatOptions.push(newOption);
            saveQuickChatOptions();
            renderQuickChatOptions();
            renderSettingsOptions();
            updateAddButtonState(); // 更新添加按钮状态

            // 滾動到新添加的選項
            setTimeout(() => {
                const newItem = optionsList.lastElementChild;
                if (newItem) {
                    newItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    const titleInput = newItem.querySelector('.quick-chat-option-title-input');
                    if (titleInput) {
                        titleInput.focus();
                        titleInput.select();
                    }
                }
            }, 100);
        }

        // 更新“添加”按钮的状态
        function updateAddButtonState() {
            if (quickChatOptions.length >= 4) {
                addButton.disabled = true;
                addButton.style.opacity = '0.5';
                addButton.style.cursor = 'not-allowed';
            } else {
                addButton.disabled = false;
                addButton.style.opacity = '1';
                addButton.style.cursor = 'pointer';
            }
        }

        // 保存函數引用到外部變量，以便 loadQuickChatOptions 可以調用
        renderSettingsOptionsRef = renderSettingsOptions;
        updateAddButtonStateRef = updateAddButtonState;

        // 初始渲染
        renderSettingsOptions();
        updateAddButtonState(); // 初始加载时更新按钮状态
    }

    // 設置按鈕事件處理
    function setupSettingsButton() {
       // This is now handled by the unified settings manager in main.js
    }

    // 初始化
    async function initialize() {
        await loadQuickChatOptions();
        initSettingsPage();
        setupSettingsButton();
    }

    // 立即執行初始化
    initialize();

    // 返回公共方法
    return {
        loadQuickChatOptions,
        saveQuickChatOptions,
        renderQuickChatOptions
    };
}

// 用於追蹤 toggleQuickChatOptions 的 timeout，避免競態條件
let toggleTimeoutId = null;

/**
 * 控制選項按鈕區域的顯示或隱藏
 * @param {boolean} show - 是否顯示選項按鈕區域
 */
export function toggleQuickChatOptions(show) {
    const quickChatOptionsElement = document.getElementById('quick-chat-options');
    if (quickChatOptionsElement) {
        // 取消之前的 timeout，避免競態條件
        if (toggleTimeoutId !== null) {
            clearTimeout(toggleTimeoutId);
            toggleTimeoutId = null;
        }

        if (show) {
            // 顯示時使用動畫效果
            quickChatOptionsElement.style.display = '';
            quickChatOptionsElement.classList.remove('quick-chat-options-hiding');
            quickChatOptionsElement.classList.add('quick-chat-options-showing');
            toggleTimeoutId = setTimeout(() => {
                toggleTimeoutId = null;
                quickChatOptionsElement.classList.remove('quick-chat-options-showing');
            }, 300);
        } else {
            // 隱藏時使用動畫效果
            quickChatOptionsElement.classList.add('quick-chat-options-hiding');
            toggleTimeoutId = setTimeout(() => {
                toggleTimeoutId = null;
                quickChatOptionsElement.style.display = 'none';
                quickChatOptionsElement.classList.remove('quick-chat-options-hiding');
            }, 300);
        }
    }
}

/**
 * 獲取常用聊天選項
 * @returns {Array} 常用聊天選項數組
 */
export async function getQuickChatOptions() {
    try {
        const result = await syncStorageAdapter.get(QUICK_CHAT_OPTIONS_KEY);
        return result.quickChatOptions || createDefaultQuickChatOptions();
    } catch (error) {
        console.error('获取常用聊天选项失败:', error);
        return createDefaultQuickChatOptions();
    }
}

/**
 * 更新常用聊天選項
 * @param {Array} options - 新的常用選項數組
 */
export async function updateQuickChatOptions(options) {
    try {
        await syncStorageAdapter.set({ [QUICK_CHAT_OPTIONS_KEY]: options });
    } catch (error) {
        console.error('更新常用聊天选项失败:', error);
    }
}
