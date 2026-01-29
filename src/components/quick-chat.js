/**
 * 常用聊天選項組件
 * 處理常用聊天選項的顯示、點擊、設置等功能
 */

import { syncStorageAdapter } from '../utils/storage-adapter.js';
import { clearMessageInput } from './message-input.js';

// 默認的常用聊天選項
const DEFAULT_QUICK_CHAT_OPTIONS = [
    {
        id: 'option-1',
        title: '列點總結',
        prompt: '```\n# 角色\n你是一位資深的內容分析師與研究員。你的專長是快速閱讀、分析和歸納各種專業文章，並以客觀、中立、精煉的語言，為他人提供高品質的摘要與重點整理。\n\n# 任務\n請你處理下方提供的文章，並嚴格遵循以下指示與格式，用繁體中文輸出結果。\n\n## 指示\n1.  **總結部分**：撰寫一段約 100 字的精煉總結。內容必須準確捕捉文章的核心論點、關鍵證據與最終結論，避免任何不必要的細節或個人評論。\n2.  **結論部分**：撰寫一段約 200 字的深度結論。請說明文章背後希望傳達的核心訊息、潛在影響或作者的最終呼籲，幫助讀者理解「為什麼這篇文章很重要」以及它帶來的啟示。\n3.  **觀點部分**：以條列式清單，深入淺出地列出文章中最多10個的主要觀點。每個觀點都應自成一體、邏輯清晰，確保完整傳達作者的意圖。每個觀點上限100字。\n4.  **名詞部分**：當遇到人、公司、国家名時，使用格式`中文翻释（原文）`。\n\n## 輸出格式\n請嚴格依照以下格式輸出，不要添加任何說明文字或額外格式：\n🟣 **總結：**\n* <此處填寫總結內容>\n🔵 **結論：**\n* <此處填寫約100字的結論與核心訊息>\n🟢 **觀點：**\n* **<觀點標題>：** <觀點內容><引用鏈接>\n* **<觀點標題>：** <觀點內容><引用鏈接>\n<依此類推>\n```',
        icon: '📝'
    },
    {
        id: 'option-2',
        title: '200字總結',
        prompt: '```\n用約200字總結網頁內容，不需要使用引用鏈接。\n```',
        icon: '✨'
    },
    {
        id: 'option-3',
        title: '列出新聞',
        prompt: '```\n**核心指令**\n你會收到網頁內容和對應的網址參考 `(URLREF1)`、`(URLREF2)` 等。在你的回覆中，請嚴格遵守以下兩種連結格式：\n1.  **引用鏈接 (`cite`)**:\n    *   當你從文章中**引用一個完整的句子**時，使用格式 `[編號](cite:引用的原文句子)`。\n    *   `編號` 應從 `1` 開始，並依序遞增。\n    *   `引用的原文句子` 必須與來源內容完全一致，不可修改。\n\n2.  **原文標題鏈接 (`URLREF`)**:\n    *   當你需要連結到新聞的原始網頁時，使用格式 `[原文標題](URLREF編號)`。\n    *   直接使用提供的 `URLREF` 編號。\n\n**你的任務**\n以表格方式列出不少於20條最重要的新聞。\n*   表格標題必須是：「中文標題+引用鏈接」、「原文標題」。\n*   在「中文標題+引用鏈接」欄中，附上至少一個從該新聞摘要或內文中提取的引用鏈接。\n*   在「原文標題」欄中，使用 `URLREF` 格式創建指向原文的連結。\n\n**表格範例格式**\n| 中文標題+引用鏈接 | 原文標題 |\n| :--- | :--- |\n| 這是第一則新聞的中文標題 [1](cite:This is a direct quote from the first news article.) | [Original Title of First News](URLREF1) |\n| 這是第二則新聞的中文標題 [2](cite:This is a quote from the second article.) [3](cite:This is another quote from the second article.) | [Original Title of Second News](URLREF2) |\n```',
        icon: '📰'
    }
];

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

    // 加載常用選項配置
    async function loadQuickChatOptions() {
        try {
            const result = await syncStorageAdapter.get(QUICK_CHAT_OPTIONS_KEY);
            quickChatOptions = result.quickChatOptions || DEFAULT_QUICK_CHAT_OPTIONS;
        } catch (error) {
            console.error('加载常用聊天选项失败:', error);
            quickChatOptions = DEFAULT_QUICK_CHAT_OPTIONS;
        }
        renderQuickChatOptions();
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
            quickChatOptions = JSON.parse(JSON.stringify(DEFAULT_QUICK_CHAT_OPTIONS));
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
                        <input type="text" class="quick-chat-option-icon-input" value="${option.icon}" maxlength="2" placeholder="📝">
                        <input type="text" class="quick-chat-option-title-input" value="${option.title}" placeholder="选项标题">
                    </div>
                    <div class="quick-chat-option-actions">
                        <button class="quick-chat-option-button delete" title="刪除">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <path d="M3 4H13" stroke="currentColor" stroke-width="1.5"/>
                                <path d="M5 4V12H11V4" stroke="currentColor" stroke-width="1.5"/>
                            </svg>
                        </button>
                    </div>
                </div>
                <textarea class="quick-chat-option-prompt-input" placeholder="输入提示词...">${option.prompt}</textarea>
            `;

            // 添加事件監聽器
            const iconInput = itemElement.querySelector('.quick-chat-option-icon-input');
            const titleInput = itemElement.querySelector('.quick-chat-option-title-input');
            const promptInput = itemElement.querySelector('.quick-chat-option-prompt-input');
            const deleteButton = itemElement.querySelector('.quick-chat-option-button.delete');

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

            // 刪除按鈕事件
            deleteButton.addEventListener('click', () => {
                if (confirm('确定要删除这个选项吗？')) {
                    quickChatOptions.splice(index, 1);
                    saveQuickChatOptions();
                    renderQuickChatOptions();
                    renderSettingsOptions();
                    updateAddButtonState(); // 更新添加按钮状态
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
                prompt: '请输入您的提示词',
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

/**
 * 控制選項按鈕區域的顯示或隱藏
 * @param {boolean} show - 是否顯示選項按鈕區域
 */
export function toggleQuickChatOptions(show) {
    const quickChatOptionsElement = document.getElementById('quick-chat-options');
    if (quickChatOptionsElement) {
        if (show) {
            // 顯示時使用動畫效果
            quickChatOptionsElement.style.display = '';
            quickChatOptionsElement.classList.remove('quick-chat-options-hiding');
            quickChatOptionsElement.classList.add('quick-chat-options-showing');
            setTimeout(() => {
                quickChatOptionsElement.classList.remove('quick-chat-options-showing');
            }, 300);
        } else {
            // 隱藏時使用動畫效果
            quickChatOptionsElement.classList.add('quick-chat-options-hiding');
            setTimeout(() => {
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
        return result.quickChatOptions || DEFAULT_QUICK_CHAT_OPTIONS;
    } catch (error) {
        console.error('获取常用聊天选项失败:', error);
        return DEFAULT_QUICK_CHAT_OPTIONS;
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