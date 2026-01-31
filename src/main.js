import { setTheme } from './utils/theme.js';
import { callAPI, TimeoutError } from './services/chat.js';
import { chatManager } from './utils/chat-manager.js';
import { appendMessage, createWaitingMessage } from './handlers/message-handler.js';
import { hideContextMenu } from './components/context-menu.js';
import { initChatContainer } from './components/chat-container.js';
import { showImagePreview, hideImagePreview } from './utils/ui.js';
import { initAPICard, DEFAULT_SYSTEM_PROMPT } from './components/api-card.js';
import { storageAdapter, syncStorageAdapter, browserAdapter, isExtensionEnvironment } from './utils/storage-adapter.js';
import { initMessageInput, getFormattedMessageContent, buildMessageContent, clearMessageInput, handleWindowMessage, updatePermanentPlaceholder } from './components/message-input.js';
import './utils/viewport.js';
import {
    hideChatList,
    initChatListEvents,
    loadChatContent,
    initializeChatList,
    renderChatList
} from './components/chat-list.js';
import { initWebpageMenu, getEnabledTabsContent } from './components/webpage-menu.js';
import { initQuickChat, toggleQuickChatOptions } from './components/quick-chat.js';

// 存储用户的问题历史
let userQuestions = [];

// 将 API 配置提升到模块作用域，以确保在异步事件中状态的稳定性
// 加载保存的 API 配置
let apiConfigs = [];
let selectedConfigIndex = 0;

// 网络搜索配置
let searchProvider = 'tavily'; // 'tavily' | 'exa'
let tavilyApiKey = '';
let tavilyApiUrl = '';
let exaApiKey = '';
let exaApiUrl = '';

 document.addEventListener('DOMContentLoaded', async () => {
     const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const contextMenu = document.getElementById('context-menu');
    const editMessageButton = document.getElementById('edit-message');
    const copyMessageButton = document.getElementById('copy-message');
    const copyCodeButton = document.getElementById('copy-code');
    const copyImageButton = document.getElementById('copy-image');
    const settingsButton = document.getElementById('settings-button');
    const settingsMenu = document.getElementById('settings-menu');
    const previewModal = document.querySelector('.image-preview-modal');
    const previewImage = previewModal.querySelector('img');
    const chatListPage = document.getElementById('chat-list-page');
    const newChatButton = document.getElementById('new-chat-button');
    const stopResponseButton = document.getElementById('stop-response-button');
    const chatListButton = document.getElementById('chat-list');
    const modelSelectorMenu = document.getElementById('model-selector-menu');
    const unifiedSettingsPage = document.getElementById('unified-settings-page');
    const deleteMessageButton = document.getElementById('delete-message');
    const regenerateMessageButton = document.getElementById('regenerate-message');
    const webpageQAContainer = document.getElementById('webpage-qa');
    const webpageContentMenu = document.getElementById('webpage-content-menu');

    // 常用聊天選項相關元素
    const quickChatContainer = document.getElementById('quick-chat-options');
    const quickChatSettingsPage = document.getElementById('quick-chat-tab');

    // 修改: 创建一个对象引用来保存当前控制器
    // pendingAbort 用于处理「首 token 前」用户立刻点停止的情况
    const abortControllerRef = { current: null, pendingAbort: false };
    let currentController = null;
    let activeRequestId = null; // 用于跟踪当前活动的请求ID

    // 创建UI工具配置
    const uiConfig = {
        textarea: {
            maxHeight: 200
        },
        imagePreview: {
            previewModal,
            previewImage
        },
        imageTag: {
            onImageClick: (base64Data) => {
                showImagePreview({
                    base64Data,
                    config: uiConfig.imagePreview
                });
            },
            onDeleteClick: (container) => {
                container.remove();
                messageInput.dispatchEvent(new Event('input'));
            }
        }
    };


    // 初始化聊天容器
    const chatContainerManager = initChatContainer({
        chatContainer,
        messageInput,
        contextMenu,
        userQuestions,
        chatManager
    });

    // 设置按钮事件处理
    chatContainerManager.setupButtonHandlers({
        editMessageButton,
        copyMessageButton,
        copyCodeButton,
        copyImageButton,
        deleteMessageButton,
        regenerateMessageButton,
        abortController: abortControllerRef,
        regenerateMessage: regenerateMessage,
    });

    // 监听从编辑模式触发的重新生成事件
    document.addEventListener('regenerate-from-edit', (e) => {
        const { messageElement } = e.detail;
        if (messageElement) {
            regenerateMessage(messageElement);
        }
    });

    // 初始化消息输入组件
    initMessageInput({
        messageInput,
        sendMessage,
        userQuestions,
        contextMenu,
        hideContextMenu: hideContextMenu.bind(null, {
            contextMenu,
            onMessageElementReset: () => { /* 清空引用 */ }
        }),
        uiConfig,
        settingsMenu,
        webpageContentMenu // 传递二级菜单
    });

    // 初始化常用聊天選項
    initQuickChat({
        quickChatContainer,
        messageInput,
        settingsPage: quickChatSettingsPage,
        settingsButton,
        settingsMenu,
        sendMessage,
        uiConfig
    });

    // 初始化ChatManager
    await chatManager.initialize();

    // 初始化用户问题历史
    chatContainerManager.initializeUserQuestions();

    // 初始化历史组件
    initChatListEvents({
        chatListPage,
        chatCards: chatListPage.querySelector('.chat-cards'),
        chatManager,
        loadChatContent: (chat) => loadChatContent(chat, chatContainer),
        onHide: hideChatList.bind(null, chatListPage)
    });

    // 初始化聊天列表功能
    initializeChatList({
        chatListPage,
        chatManager,
        newChatButton,
        chatListButton,
        settingsMenu,
        unifiedSettingsPage,
        loadChatContent: (chat) => loadChatContent(chat, chatContainer)
    });


    // 加载当前对话内容
    const currentChat = chatManager.getCurrentChat();
    if (currentChat) {
        await loadChatContent(currentChat, chatContainer);
        const hasMessages = currentChat.messages && currentChat.messages.length > 0;
        toggleQuickChatOptions(!hasMessages);
    }

    if ((!currentChat || currentChat.messages.length === 0) && isExtensionEnvironment) {
        const currentTab = await browserAdapter.getCurrentTab();
        if (currentTab) {
            await storageAdapter.set({ webpageSwitches: { [currentTab.id]: true } });
        }
    }

    // 如果不是扩展环境，隐藏网页问答功能
    if (!isExtensionEnvironment) {
        webpageQAContainer.style.display = 'none';
    }


    // 监听来自 content script 的消息
    window.addEventListener('message', (event) => {
        // 使用消息输入组件的窗口消息处理函数
        handleWindowMessage(event, {
            messageInput,
            newChatButton,
            uiConfig
        });

        // 处理检查对话状态的消息
        if (event.data.type === 'CHECK_CHAT_STATUS') {
            const currentChat = chatManager.getCurrentChat();
            const hasMessages = currentChat && currentChat.messages && currentChat.messages.length > 0;
            toggleQuickChatOptions(!hasMessages);
        }
    });

    // 新增：带重试逻辑的API调用函数
    async function callAPIWithRetry(apiParams, chatManager, chatId, onMessageUpdate, maxRetries = 10) {
        let attempt = 0;

        // 切換按鈕顯示：使用 CSS 類觸發動畫
        newChatButton.classList.add('button-hidden');
        stopResponseButton.classList.add('button-visible');

        // 绑定停止按钮事件
        const stopHandler = () => {
            if (currentController) {
                currentController.abort();
                currentController = null;
            }
            if (abortControllerRef) {
                abortControllerRef.pendingAbort = true;
            }
            // 移除等待动画
            const waitingMsg = chatContainer.querySelector('.message.ai-message.waiting');
            if (waitingMsg) {
                waitingMsg.classList.add('message-vanishing');
                waitingMsg.addEventListener('animationend', () => {
                    waitingMsg.remove();
                }, { once: true });
                setTimeout(() => {
                    if (waitingMsg.parentNode) waitingMsg.remove();
                }, 350);
            }
        };
        stopResponseButton.onclick = stopHandler;

        try {
            while (attempt <= maxRetries) {
                const { processStream, controller } = await callAPI(apiParams, chatManager, chatId, onMessageUpdate);
                currentController = controller;
                abortControllerRef.current = controller;

                // 检查是否有「预约取消」
                if (abortControllerRef.pendingAbort) {
                    abortControllerRef.pendingAbort = false;
                    try {
                        controller.abort();
                    } finally {
                        abortControllerRef.current = null;
                        currentController = null;
                    }
                    const error = new Error('Aborted');
                    error.name = 'AbortError';
                    throw error;
                }

                const result = await processStream();

                // 如果 content 为空但 reasoning_content 不为空，则可能被截断，进行重试
                if (result && !result.content && result.reasoning_content && attempt < maxRetries) {
                    console.log(`API响应可能被截断，正在重试... (尝试次数 ${attempt + 1})`);
                    attempt++;
                    // 在重试前，将不完整的 assistant 消息从历史记录中移除
                    chatManager.popMessage();
                } else {
                    return; // 成功或达到最大重试次数
                }
            }
        } finally {
            // 恢復按鈕顯示：使用 CSS 類觸發動畫
            newChatButton.classList.remove('button-hidden');
            stopResponseButton.classList.remove('button-visible');
            stopResponseButton.onclick = null; // 清理事件处理
        }
    }

    async function regenerateMessage(messageElement) {
        if (!messageElement) return;

        // 生成新的请求ID
        const currentRequestId = Date.now().toString();
        activeRequestId = currentRequestId;

        // 如果有正在更新或等待的AI消息，停止它
        const updatingMessage = chatContainer.querySelector('.ai-message.updating, .ai-message.waiting');
        if (updatingMessage && currentController) {
            const isWaiting = updatingMessage.classList.contains('waiting');
            currentController.abort();
            currentController = null;
            abortControllerRef.current = null;
            updatingMessage.classList.remove('updating');
            updatingMessage.classList.remove('waiting');

            if (isWaiting) {
                updatingMessage.remove();
            }
        }
        if (abortControllerRef) abortControllerRef.pendingAbort = false;

        let userMessageElement = null;
        let aiMessageElement = null;
        if (messageElement.classList.contains('user-message')) {
            userMessageElement = messageElement;
            aiMessageElement = messageElement.nextElementSibling;
        } else {
            userMessageElement = messageElement.previousElementSibling;
            aiMessageElement = messageElement;
        }

        if (!userMessageElement || !userMessageElement.classList.contains('user-message')) {
            console.error('无法找到对应的用户消息');
            return;
        }

        try {
            const currentChat = chatManager.getCurrentChat();
            if (!currentChat) return;

            const domMessages = Array.from(chatContainer.querySelectorAll('.user-message, .ai-message'));
            const userMessageDomIndex = domMessages.indexOf(userMessageElement);
            const aiMessageDomIndex = domMessages.indexOf(aiMessageElement);

            // 通过比较DOM和历史记录中的消息数量，判断是否在从一个临时错误消息中重新生成
            const historyMessages = currentChat.messages.filter(m => ['user', 'assistant'].includes(m.role));

            if (domMessages.length === historyMessages.length && aiMessageDomIndex !== -1) {
                // 正常情况：重新生成一个已保存的响应。
                // 我们需要从历史记录中删除旧的响应。
                currentChat.messages.splice(aiMessageDomIndex);
            } else if (domMessages.length > historyMessages.length) {
                // 错误情况：DOM中有比历史记录更多的消息
                // 这意味着用户消息可能已经从历史记录中被移除（发送失败时）
                // 我们需要重新添加用户消息到历史记录

                // 获取用户消息的原始内容（包括图片）
                const userMessageContent = userMessageElement.getAttribute('data-original-text');
                const imageTags = userMessageElement.querySelectorAll('.image-tag');

                let content;
                if (imageTags.length > 0) {
                    content = [];
                    if (userMessageContent && userMessageContent.trim()) {
                        content.push({
                            type: "text",
                            text: userMessageContent
                        });
                    }
                    imageTags.forEach(tag => {
                        const base64Data = tag.getAttribute('data-image');
                        if (base64Data) {
                            content.push({
                                type: "image_url",
                                image_url: {
                                    url: base64Data
                                }
                            });
                        }
                    });
                } else {
                    content = userMessageContent || userMessageElement.textContent;
                }

                // 检查历史记录中是否已经有这条用户消息
                // 通过比较索引位置来判断
                if (userMessageDomIndex >= historyMessages.length ||
                    historyMessages[userMessageDomIndex]?.role !== 'user') {
                    currentChat.messages.push({
                        role: 'user',
                        content: content
                    });
                }
            }
            chatManager.saveChats();

            // 只移除AI消息（错误消息或旧的成功消息），保留用户消息
            if (aiMessageElement) {
                aiMessageElement.remove();
            }
            // 移除AI消息之后的所有消息（如果有的话）
            const remainingDomMessages = Array.from(chatContainer.querySelectorAll('.user-message, .ai-message'));
            const newUserMessageIndex = remainingDomMessages.indexOf(userMessageElement);
            if (newUserMessageIndex !== -1) {
                remainingDomMessages.slice(newUserMessageIndex + 1).forEach(el => el.remove());
            }

            const messagesToResend = currentChat.messages;

            // 准备API调用参数
            // 当传送网页开启时，强制关闭 auto 模式（避免 tool_choice 冲突）
            const effectiveWebSearchMode = (isExtensionEnvironment && sendWebpageSwitch.checked && webSearchMode === 'auto')
                ? 'off'
                : webSearchMode;

            const apiParams = {
                messages: messagesToResend,
                apiConfig: apiConfigs[selectedConfigIndex],
                userLanguage: navigator.language,
                webpageInfo: isExtensionEnvironment && sendWebpageSwitch.checked ? await getEnabledTabsContent() : null,
                webSearchMode: effectiveWebSearchMode,
                searchConfig: {
                    provider: searchProvider,
                    tavilyApiKey: tavilyApiKey,
                    tavilyApiUrl: tavilyApiUrl,
                    exaApiKey: exaApiKey,
                    exaApiUrl: exaApiUrl
                }
            };

            // 显示等待动画
            createWaitingMessage(chatContainer);

            // 调用带重试逻辑的 API
            await callAPIWithRetry(apiParams, chatManager, currentChat.id, (chatId, message) => {
                // 只有当仍然是当前活动的请求时才更新界面
                if (currentRequestId === activeRequestId) {
                    chatContainerManager.syncMessage(chatId, message);
                }
            });

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('用户手动停止更新');
                // 如果是手动停止，也要移除等待消息
                if (currentRequestId === activeRequestId) {
                    const waitingMsg = chatContainer.querySelector('.message.ai-message.waiting');
                    if (waitingMsg) {
                        // 添加消失動畫類
                        waitingMsg.classList.add('message-vanishing');
                        // 監聽動畫結束事件後移除元素
                        waitingMsg.addEventListener('animationend', () => {
                            waitingMsg.remove();
                        }, { once: true });

                        // 設置一個超時作為保險，防止動畫事件未觸發
                        setTimeout(() => {
                            if (waitingMsg.parentNode) {
                                waitingMsg.remove();
                            }
                        }, 350); // 稍微比動畫時間 (0.3s) 長一點
                    }
                }
                return;
            }
            console.error('重新生成消息失败:', error);
            // 只有当仍然是当前活动的请求时才显示错误
            if (currentRequestId === activeRequestId) {
                // 移除等待動畫（如果存在）
                const waitingMsg = chatContainer.querySelector('.message.ai-message.waiting');
                if (waitingMsg) {
                    waitingMsg.remove();
                }

                // 根據錯誤類型顯示不同的錯誤訊息
                let errorMessage = '重新生成失败: ' + error.message;
                if (error instanceof TimeoutError) {
                    errorMessage = '⏱️ ' + error.message;
                    console.warn('API 請求超時:', error.type, error.message);
                }

                appendMessage({
                    text: {
                        content: errorMessage,
                        isError: true
                    },
                    sender: 'ai',
                    chatContainer,
                    skipHistory: true,
                });
            }
        } finally {
            // 只有当仍然是当前活动的请求时才清理状态
            if (currentRequestId === activeRequestId) {
                const lastMessage = chatContainer.querySelector('.ai-message:last-child');
                if (lastMessage) {
                    lastMessage.classList.remove('updating');
                }
            }
        }
    }

    async function sendMessage() {
        // 生成新的请求ID
        const currentRequestId = Date.now().toString();
        activeRequestId = currentRequestId;

        // 如果有正在更新或等待的AI消息，停止它
        const updatingMessage = chatContainer.querySelector('.ai-message.updating, .ai-message.waiting');
        if (updatingMessage && currentController) {
            const isWaiting = updatingMessage.classList.contains('waiting');
            currentController.abort();
            currentController = null;
            abortControllerRef.current = null; // 同步更新引用对象
            updatingMessage.classList.remove('updating');
            updatingMessage.classList.remove('waiting');

            if (isWaiting) {
                updatingMessage.remove();
            }
        }
        if (abortControllerRef) abortControllerRef.pendingAbort = false;

        // 获取格式化后的消息内容
        const { message, imageTags } = getFormattedMessageContent(messageInput);

        if (!message.trim() && imageTags.length === 0) return;

        try {
            // 构建消息内容
            const content = buildMessageContent(message, imageTags);

            // 构建用户消息
            const userMessage = {
                role: "user",
                content: content
            };

            const wasNewChat = chatManager.getCurrentChat()?.isNew;

            // 先添加用户消息到界面和历史记录
            await appendMessage({
                text: userMessage,
                sender: 'user',
                chatContainer,
            });

            // 隐藏选项按钮区域
            toggleQuickChatOptions(false);

            // 清空输入框并调整高度
            clearMessageInput(messageInput, uiConfig);

            // 构建消息数组
            const currentChat = chatManager.getCurrentChat();
            const messages = currentChat ? [...currentChat.messages] : [];  // 从chatManager获取消息历史
            messages.push(userMessage);
            const webpageInfo = isExtensionEnvironment && sendWebpageSwitch.checked ? await getEnabledTabsContent() : null;
            chatManager.addMessageToCurrentChat(userMessage, webpageInfo);

            if (wasNewChat) {
                const chatCards = chatListPage.querySelector('.chat-cards');
                renderChatList(chatManager, chatCards);
            }

            // 显示等待动画
            const waitingMessage = createWaitingMessage(chatContainer);

            // 准备API调用参数
            // 当传送网页开启时，强制关闭 auto 模式（避免 tool_choice 冲突）
            const effectiveWebSearchMode = (webpageInfo && webSearchMode === 'auto')
                ? 'off'
                : webSearchMode;

            const apiParams = {
                messages,
                apiConfig: apiConfigs[selectedConfigIndex],
                userLanguage: navigator.language,
                webpageInfo: webpageInfo,
                webSearchMode: effectiveWebSearchMode,
                searchConfig: {
                    provider: searchProvider,
                    tavilyApiKey: tavilyApiKey,
                    tavilyApiUrl: tavilyApiUrl,
                    exaApiKey: exaApiKey,
                    exaApiUrl: exaApiUrl
                }
            };

            // 调用带重试逻辑的 API
            await callAPIWithRetry(apiParams, chatManager, currentChat.id, (chatId, message) => {
                // 只有当仍然是当前活动的请求时才更新界面
                if (currentRequestId === activeRequestId) {
                    // updateAIMessage 现在会处理等待消息的移除
                    chatContainerManager.syncMessage(chatId, message);
                }
            });

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('用户手动停止更新');
                // 如果是手动停止，也要移除等待消息（如果在等待阶段停止）
                if (currentRequestId === activeRequestId) {
                    const waitingMsg = chatContainer.querySelector('.message.ai-message.waiting');
                    if (waitingMsg) {
                        // 添加消失動畫類
                        waitingMsg.classList.add('message-vanishing');
                        // 監聽動畫結束事件後移除元素
                        waitingMsg.addEventListener('animationend', () => {
                            waitingMsg.remove();
                        }, { once: true });

                        // 設置一個超時作為保險，防止動畫事件未觸發
                        setTimeout(() => {
                            if (waitingMsg.parentNode) {
                                waitingMsg.remove();
                            }
                        }, 350); // 稍微比動畫時間 (0.3s) 長一點
                    }
                }
                return;
            }
            console.error('发送消息失败:', error);

            // 只有当仍然是当前活动的请求时才处理错误
            if (currentRequestId === activeRequestId) {
                // 移除等待動畫（如果存在）
                const waitingMsg = chatContainer.querySelector('.message.ai-message.waiting');
                if (waitingMsg) {
                    waitingMsg.remove();
                }

                // 根據錯誤類型顯示不同的錯誤訊息
                let errorMessage = '发送失败: ' + error.message;
                if (error instanceof TimeoutError) {
                    errorMessage = '⏱️ ' + error.message;
                    console.warn('API 請求超時:', error.type, error.message);
                }

                appendMessage({
                    text: {
                        content: errorMessage,
                        isError: true
                    },
                    sender: 'ai',
                    chatContainer,
                    skipHistory: true,
                });
                // 从 chatHistory 中移除最后一条记录（用户的问题）
                const currentChat = chatManager.getCurrentChat();
                const messages = currentChat ? [...currentChat.messages] : [];
                if (messages.length > 0) {
                    if (messages[messages.length - 1].role === 'assistant') {
                        chatManager.popMessage();
                        chatManager.popMessage();
                    } else {
                        chatManager.popMessage();
                    }
                }
            }
        } finally {
            // 只有当仍然是当前活动的请求时才清理状态
            if (currentRequestId === activeRequestId) {
                const lastMessage = chatContainer.querySelector('.ai-message:last-child');
                if (lastMessage) {
                    lastMessage.classList.remove('updating');
                }
            }
        }
    }

    // 修改点击事件监听器
    document.addEventListener('click', (e) => {
        // 如果点击的不是设置按钮本身和设置菜单，就关闭菜单
        if (!settingsButton.contains(e.target) && !settingsMenu.contains(e.target)) {
            settingsMenu.classList.remove('visible');
        }
       if (!webpageQAContainer.contains(e.target) && !webpageContentMenu.contains(e.target)) {
           webpageContentMenu.classList.remove('visible');
       }
    });

    // Close subpages with Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // Close settings page
            if (unifiedSettingsPage.style.display === 'flex') {
                unifiedSettingsPage.style.display = 'none';
            }
            // Close chat list (history) page
            if (chatListPage.classList.contains('show')) {
                hideChatList(chatListPage);
            }
        }
    });

   // 初始化网页内容二级菜单
   if (isExtensionEnvironment) {
    initWebpageMenu({ webpageQAContainer, webpageContentMenu });
   }

    // 设置菜单的显示和隐藏逻辑
    let menuTimeout;

    const showMenu = () => {
        clearTimeout(menuTimeout);
        settingsMenu.classList.add('visible');
    };

    const hideMenu = () => {
        menuTimeout = setTimeout(() => {
            if (!settingsMenu.matches(':hover') && !webpageContentMenu.matches(':hover')) {
                settingsMenu.classList.remove('visible');
                webpageContentMenu.classList.remove('visible'); // 同时隐藏二级菜单
            }
        }, 200); // 200ms 延迟
    };

    // 鼠标悬停在按钮上时显示菜单
    settingsButton.addEventListener('mouseenter', showMenu);

    // 鼠标离开按钮时准备隐藏菜单
    settingsButton.addEventListener('mouseleave', hideMenu);

    // 鼠标悬停在菜单上时保持显示
    settingsMenu.addEventListener('mouseenter', showMenu);

    // 鼠标离开菜单时隐藏菜单
    settingsMenu.addEventListener('mouseleave', hideMenu);

    // 点击按钮仍然可以切换菜单的显示/隐藏状态
    settingsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = settingsMenu.classList.toggle('visible');
        if (!isVisible) {
            webpageContentMenu.classList.remove('visible');
        }
    });

    // 模型選擇子菜單邏輯
    let modelSelectorTimeout;
    let modelListCache = {}; // 緩存模型列表
    let isModelSearchFocused = false; // 追蹤搜索框焦點狀態

    // 獲取模型列表
    async function fetchModelList(force = false) {
        const config = apiConfigs[selectedConfigIndex];
        if (!config?.apiKey || !config?.baseUrl) {
            return null;
        }

        const baseUrl = config.baseUrl.replace(/\/chat\/completions$/, '');
        const cacheKey = `${baseUrl}:${config.apiKey}`;

        if (!force && modelListCache[cacheKey]) {
            return modelListCache[cacheKey];
        }

        try {
            const response = await fetch(`${baseUrl}/models`, {
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`
                }
            });

            if (!response.ok) {
                throw new Error('無法獲取模型列表');
            }

            const data = await response.json();
            const models = data.data.map(model => model.id);
            modelListCache[cacheKey] = models;
            return models;
        } catch (error) {
            console.error('獲取模型列表失敗:', error);
            return null;
        }
    }

    // 渲染模型列表
    function renderModelSelectorList(models, filterText = '') {
        const listContainer = modelSelectorMenu.querySelector('.model-selector-list');
        const emptyContainer = modelSelectorMenu.querySelector('.model-selector-empty');
        const config = apiConfigs[selectedConfigIndex];

        // 動畫：如果菜單可見，記錄起始尺寸
        const isVisible = modelSelectorMenu.classList.contains('visible');
        let startHeight, startWidth;

        if (isVisible) {
            startHeight = modelSelectorMenu.offsetHeight;
            startWidth = modelSelectorMenu.offsetWidth;
            modelSelectorMenu.style.height = `${startHeight}px`;
            modelSelectorMenu.style.width = `${startWidth}px`;
        }

        const updateDOM = () => {
            if (!models || models.length === 0) {
                listContainer.innerHTML = '';
                listContainer.style.display = 'none';
                emptyContainer.style.display = 'block';
                return;
            }

            // 根據篩選文字過濾模型
            const filteredModels = filterText
                ? models.filter(model => model.toLowerCase().includes(filterText.toLowerCase()))
                : models;

            if (filteredModels.length === 0) {
                listContainer.innerHTML = '';
                listContainer.style.display = 'none';
                emptyContainer.textContent = '没有匹配的模型';
                emptyContainer.style.display = 'block';
                return;
            }

            emptyContainer.style.display = 'none';
            listContainer.style.display = 'flex';
            listContainer.innerHTML = '';

            filteredModels.forEach(model => {
                const item = document.createElement('div');
                item.className = 'model-selector-item';
                if (model === config?.modelName) {
                    item.classList.add('selected');
                }
                item.textContent = model;
                item.title = model;
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    selectModel(model);
                });
                listContainer.appendChild(item);
            });
        };

        updateDOM();

        // 動畫：應用新尺寸
        if (isVisible) {
            // 暫時設為 auto 以測量自然尺寸
            modelSelectorMenu.style.height = 'auto';
            modelSelectorMenu.style.width = 'auto';

            const targetHeight = modelSelectorMenu.offsetHeight;
            const targetWidth = modelSelectorMenu.offsetWidth;

            // 恢復到起始尺寸準備過渡
            modelSelectorMenu.style.height = `${startHeight}px`;
            modelSelectorMenu.style.width = `${startWidth}px`;

            // 強制重排
            modelSelectorMenu.offsetHeight;

            // 設置目標尺寸觸發過渡
            modelSelectorMenu.style.height = `${targetHeight}px`;
            modelSelectorMenu.style.width = `${targetWidth}px`;

            // 過渡結束後清理
            setTimeout(() => {
                modelSelectorMenu.style.height = 'auto';
                modelSelectorMenu.style.width = 'auto';
            }, 200);
        }
    }

    // 選擇模型
    function selectModel(modelName) {
        const config = apiConfigs[selectedConfigIndex];
        if (config) {
            config.modelName = modelName;
            saveAPIConfigs();
            updatePlaceholderWithCurrentModel();
            chatManager.setApiConfig(apiConfigs[selectedConfigIndex]);

            // 更新子菜單中的選中狀態
            const items = modelSelectorMenu.querySelectorAll('.model-selector-item');
            items.forEach(item => {
                if (item.textContent === modelName) {
                    item.classList.add('selected');
                } else {
                    item.classList.remove('selected');
                }
            });

            // 重新渲染 API 卡片以更新設置頁面中的模型名稱顯示
            renderAPICardsWithCallbacks();

            // 隱藏子菜單
            hideModelSelectorMenu();
        }
    }

    // 顯示模型選擇子菜單
    async function showModelSelectorMenu() {
        clearTimeout(modelSelectorTimeout);
        modelSelectorMenu.classList.add('visible');

        const searchInput = modelSelectorMenu.querySelector('.model-search-input');
        const config = apiConfigs[selectedConfigIndex];

        // 更新搜索框的 placeholder 顯示當前模型
        if (searchInput) {
            searchInput.placeholder = config?.modelName ? `${config.modelName}` : '搜索模型...';
            searchInput.value = '';
        }

        // 檢查是否有有效的 API 配置
        if (!config?.apiKey || !config?.baseUrl) {
            renderModelSelectorList(null);
            return;
        }

        // 檢查緩存
        const baseUrl = config.baseUrl.replace(/\/chat\/completions$/, '');
        const cacheKey = `${baseUrl}:${config.apiKey}`;

        if (modelListCache[cacheKey]) {
            renderModelSelectorList(modelListCache[cacheKey]);
            return;
        }

        // 獲取模型列表
        const models = await fetchModelList();
        renderModelSelectorList(models);
    }

    // 隱藏模型選擇子菜單
    function hideModelSelectorMenu() {
        // 如果搜索框有焦點，不隱藏菜單
        if (isModelSearchFocused) return;
        modelSelectorTimeout = setTimeout(() => {
            modelSelectorMenu.classList.remove('visible');
        }, 150);
    }

    // 新對話按鈕的 hover 事件
    newChatButton.addEventListener('mouseenter', () => {
        showModelSelectorMenu();
    });

    newChatButton.addEventListener('mouseleave', () => {
        hideModelSelectorMenu();
    });

    // 子菜單的 hover 事件（保持顯示）
    modelSelectorMenu.addEventListener('mouseenter', () => {
        clearTimeout(modelSelectorTimeout);
    });

    modelSelectorMenu.addEventListener('mouseleave', () => {
        hideModelSelectorMenu();
    });

    // 點擊新對話按鈕時隱藏子菜單
    newChatButton.addEventListener('click', () => {
        modelSelectorMenu.classList.remove('visible');
    });

    // 模型搜索輸入框事件
    const modelSearchInput = modelSelectorMenu.querySelector('.model-search-input');
    if (modelSearchInput) {
        // 輸入時篩選模型列表
        modelSearchInput.addEventListener('input', (e) => {
            const config = apiConfigs[selectedConfigIndex];
            if (!config?.apiKey || !config?.baseUrl) return;

            const baseUrl = config.baseUrl.replace(/\/chat\/completions$/, '');
            const cacheKey = `${baseUrl}:${config.apiKey}`;
            const models = modelListCache[cacheKey];

            if (models) {
                renderModelSelectorList(models, e.target.value);
            }
        });

        // 阻止輸入框的點擊事件冒泡
        modelSearchInput.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        // 阻止輸入框的 mouseenter/mouseleave 影響菜單顯示
        modelSearchInput.addEventListener('mouseenter', () => {
            clearTimeout(modelSelectorTimeout);
        });

        // 追蹤搜索框焦點狀態，防止輸入時菜單消失
        modelSearchInput.addEventListener('focus', () => {
            isModelSearchFocused = true;
            clearTimeout(modelSelectorTimeout);
        });

        modelSearchInput.addEventListener('blur', () => {
            isModelSearchFocused = false;
        });

        // 鍵盤導航支援
        modelSearchInput.addEventListener('keydown', (e) => {
            const listContainer = modelSelectorMenu.querySelector('.model-selector-list');
            const items = listContainer.querySelectorAll('.model-selector-item');
            const highlightedItem = listContainer.querySelector('.model-selector-item.highlighted');

            if (items.length === 0) return;

            let currentIndex = -1;
            if (highlightedItem) {
                currentIndex = Array.from(items).indexOf(highlightedItem);
            }

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    if (highlightedItem) highlightedItem.classList.remove('highlighted');
                    currentIndex = (currentIndex + 1) % items.length;
                    items[currentIndex].classList.add('highlighted');
                    items[currentIndex].scrollIntoView({ block: 'nearest' });
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    if (highlightedItem) highlightedItem.classList.remove('highlighted');
                    currentIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
                    items[currentIndex].classList.add('highlighted');
                    items[currentIndex].scrollIntoView({ block: 'nearest' });
                    break;
                case 'Enter':
                    e.preventDefault();
                    // 先讓搜索框失去焦點，確保 hideModelSelectorMenu 能正常工作
                    modelSearchInput.blur();
                    if (highlightedItem) {
                        selectModel(highlightedItem.textContent);
                    } else if (items.length > 0) {
                        selectModel(items[0].textContent);
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    hideModelSelectorMenu();
                    break;
            }
        });
    }

    // 主题切换
    const themeSwitch = document.getElementById('theme-switch');
    const sendWebpageSwitch = document.getElementById('send-webpage-switch');
    const webSearchSwitch = document.getElementById('web-search-switch');
    const searchProviderSwitch = document.getElementById('search-provider-switch');

    // 网络搜索模式状态
    let webSearchMode = 'off'; // 'off' | 'auto' | 'on'
    let savedWebSearchMode = null; // 保存禁用前的网络搜索模式

    const sidePanelToggle = document.getElementById('side-panel-toggle');

    // 检查是否在 Side Panel 中运行
    const isSidePanel = window.location.protocol === 'chrome-extension:' && window.self === window.top;

    if (sidePanelToggle) {
        // 更新按钮状态或文本
        if (isSidePanel) {
            sidePanelToggle.querySelector('span').textContent = '悬浮模式';
        } else {
            sidePanelToggle.querySelector('span').textContent = '侧栏模式';
        }

        sidePanelToggle.addEventListener('click', async () => {
            try {
                if (!isSidePanel) {
                    // 如果在 iframe 中，先尝试本地打开 Side Panel (利用当前的用户点击手势)
                    try {
                        const window = await chrome.windows.getCurrent();
                        // 只有当 API 可用时才调用
                        if (chrome.sidePanel && chrome.sidePanel.open) {
                            await chrome.sidePanel.open({ windowId: window.id });
                        }
                    } catch (e) {
                        console.log('本地打开 Side Panel 失败 (将由 background 尝试或等待用户点击):', e);
                    }
                }

                const targetMode = isSidePanel ? 'iframe' : 'side_panel';
                await chrome.runtime.sendMessage({
                    type: 'SWITCH_MODE',
                    mode: targetMode
                });

                // 如果当前是 Side Panel，尝试关闭自己
                if (isSidePanel) {
                    window.close();
                }
            } catch (error) {
                console.error('切换模式失败:', error);
            }
        });
    }

    // 创建主题配置对象
    const themeConfig = {
        root: document.documentElement,
        themeSwitch,
        saveTheme: async (theme) => await syncStorageAdapter.set({ theme })
    };

    // 初始化主题
    async function initTheme() {
        try {
            const result = await syncStorageAdapter.get('theme');
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            const isDark = result.theme === 'dark' || (!result.theme && prefersDark);
            setTheme(isDark, themeConfig);
        } catch (error) {
            console.error('初始化主题失败:', error);
            // 如果出错，使用系统主题
            setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches, themeConfig);
        }
    }

    // 监听主题切换
    themeSwitch.addEventListener('change', () => {
        setTheme(themeSwitch.checked, themeConfig);
    });

    // 监听系统主题变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async (e) => {
        const data = await syncStorageAdapter.get('theme');
        if (!data.theme) {  // 只有在用户没有手动设置主题时才跟随系统
            setTheme(e.matches, themeConfig);
        }
    });

    // 初始化主题
    await initTheme();

    // 初始化“传送网页”开关
    async function initSendWebpageSwitch() {
        try {
            const result = await syncStorageAdapter.get('sendWebpageContent');
            // 默认开启
            const shouldSend = result.sendWebpageContent === undefined ? true : result.sendWebpageContent;
            sendWebpageSwitch.checked = shouldSend;
        } catch (error) {
            console.error('初始化“传送网页”开关失败:', error);
            sendWebpageSwitch.checked = true; // 出错时默认开启
        }
    }

    // 更新网络搜索开关的禁用状态
    function updateWebSearchDisabledState(sendWebpageEnabled) {
        const webSearchToggle = document.getElementById('web-search-toggle');
        if (sendWebpageEnabled) {
            // 当传送网页启用时，保存当前状态，然后禁用网络搜索并设为 off
            if (savedWebSearchMode === null) {
                savedWebSearchMode = webSearchMode;
            }
            webSearchSwitch.disabled = true;
            searchProviderSwitch.disabled = true;
            webSearchToggle.classList.add('disabled');
            // 强制设为 off
            webSearchMode = 'off';
            updateWebSearchSwitchUI();
        } else {
            // 当传送网页关闭时，恢复网络搜索的可用状态和之前的模式
            webSearchSwitch.disabled = false;
            searchProviderSwitch.disabled = false;
            webSearchToggle.classList.remove('disabled');
            // 恢复之前保存的模式
            if (savedWebSearchMode !== null) {
                webSearchMode = savedWebSearchMode;
                savedWebSearchMode = null;
                updateWebSearchSwitchUI();
            }
        }
    }

    // 监听"传送网页"开关变化
    sendWebpageSwitch.addEventListener('change', async () => {
        try {
            await syncStorageAdapter.set({ sendWebpageContent: sendWebpageSwitch.checked });
            // 更新网络搜索开关的禁用状态
            updateWebSearchDisabledState(sendWebpageSwitch.checked);
        } catch (error) {
            console.error('保存"传送网页"设置失败:', error);
        }
    });

    await initSendWebpageSwitch();

    // 初始化"网络搜索"三态开关
    async function initWebSearchSwitch() {
        try {
            const result = await syncStorageAdapter.get('webSearchMode');
            // 默认为 'off'，兼容旧版本的 enableWebSearch
            if (result.webSearchMode) {
                webSearchMode = result.webSearchMode;
            } else {
                // 兼容旧版本：如果有 enableWebSearch 设置，转换为新格式
                const oldResult = await syncStorageAdapter.get('enableWebSearch');
                if (oldResult.enableWebSearch === true) {
                    webSearchMode = 'on';
                } else {
                    webSearchMode = 'off';
                }
            }
            updateWebSearchSwitchUI();
        } catch (error) {
            console.error('初始化"网络搜索"开关失败:', error);
            webSearchMode = 'off';
            updateWebSearchSwitchUI();
        }
    }

    // 更新三态按钮 UI
    function updateWebSearchSwitchUI() {
        webSearchSwitch.dataset.value = webSearchMode;
        // 更新 title 提示
        const titles = {
            'off': '关闭 - 点击切换到自动',
            'auto': '自动（AI决定）- 点击切换到开启',
            'on': '开启 - 点击切换到关闭'
        };
        webSearchSwitch.title = titles[webSearchMode] || '点击切换';
    }

    // 循环切换模式：off -> auto -> on -> off
    function cycleWebSearchMode() {
        const modes = ['off', 'auto', 'on'];
        const currentIndex = modes.indexOf(webSearchMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        webSearchMode = modes[nextIndex];
        return webSearchMode;
    }

    // 监听三态按钮点击
    webSearchSwitch.addEventListener('click', async (e) => {
        e.stopPropagation();
        cycleWebSearchMode();
        updateWebSearchSwitchUI();
        try {
            await syncStorageAdapter.set({ webSearchMode });
        } catch (error) {
            console.error('保存"网络搜索"设置失败:', error);
        }
    });

    // 先初始化网络搜索模式，确保 webSearchMode 从 storage 正确载入
    await initWebSearchSwitch();
    // 然后再检查并更新网络搜索开关的禁用状态（此时 webSearchMode 已经是正确的值）
    updateWebSearchDisabledState(sendWebpageSwitch.checked);

   // 网络搜索设置
  const tavilyApiKeyInput = document.getElementById('tavily-api-key');
  const tavilyApiUrlInput = document.getElementById('tavily-api-url');
  const testTavilyBtn = document.getElementById('test-tavily-btn');
  const exaApiKeyInput = document.getElementById('exa-api-key');
  const exaApiUrlInput = document.getElementById('exa-api-url');
  const testExaBtn = document.getElementById('test-exa-btn');
  const providerBtns = document.querySelectorAll('.provider-btn');
  const providerSettings = document.querySelectorAll('.provider-settings');

  // 加载所有搜索设置
  async function loadSearchSettings() {
      try {
          const result = await syncStorageAdapter.get([
              'searchProvider',
              'tavilyApiKey',
              'tavilyApiUrl',
              'exaApiKey',
              'exaApiUrl'
          ]);

          searchProvider = result.searchProvider || 'tavily';
          tavilyApiKey = result.tavilyApiKey || '';
          tavilyApiUrl = result.tavilyApiUrl || '';
          exaApiKey = result.exaApiKey || '';
          exaApiUrl = result.exaApiUrl || '';

          // 更新 UI
          tavilyApiKeyInput.value = tavilyApiKey;
          tavilyApiUrlInput.value = tavilyApiUrl;
          exaApiKeyInput.value = exaApiKey;
          exaApiUrlInput.value = exaApiUrl;

          // 更新提供者切换按钮状态
          updateProviderUI();
      } catch (error) {
          console.error('加载搜索设置失败:', error);
      }
  }

  // 保存所有搜索设置
  async function saveSearchSettings() {
      try {
          await syncStorageAdapter.set({
              searchProvider,
              tavilyApiKey,
              tavilyApiUrl,
              exaApiKey,
              exaApiUrl
          });
      } catch (error) {
          console.error('保存搜索设置失败:', error);
      }
  }

  // 更新提供者 UI
  function updateProviderUI() {
      providerBtns.forEach(btn => {
          if (btn.dataset.provider === searchProvider) {
              btn.classList.add('active');
          } else {
              btn.classList.remove('active');
          }
      });

      providerSettings.forEach(settings => {
          if (settings.dataset.provider === searchProvider) {
              settings.classList.add('active');
          } else {
              settings.classList.remove('active');
          }
      });

      // 同步更新菜单中的提供者切换按钮
      if (searchProviderSwitch) {
          searchProviderSwitch.dataset.value = searchProvider;
          searchProviderSwitch.title = searchProvider === 'tavily'
              ? '当前: Tavily - 点击切换到 Exa'
              : '当前: Exa - 点击切换到 Tavily';
      }
  }

  // 提供者切换按钮事件（设置页面中的按钮）
  providerBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
          e.stopPropagation();
          searchProvider = btn.dataset.provider;
          updateProviderUI();
          saveSearchSettings();
      });
  });

  // 菜单中的提供者切换按钮事件
  if (searchProviderSwitch) {
      searchProviderSwitch.addEventListener('click', (e) => {
          e.stopPropagation();
          // 切换提供者：tavily <-> exa
          searchProvider = searchProvider === 'tavily' ? 'exa' : 'tavily';
          updateProviderUI();
          saveSearchSettings();
      });
  }

  // Tavily 输入框事件
  tavilyApiKeyInput.addEventListener('change', () => {
      tavilyApiKey = tavilyApiKeyInput.value;
      saveSearchSettings();
  });

  tavilyApiKeyInput.addEventListener('click', (e) => {
      e.stopPropagation();
  });

  tavilyApiUrlInput.addEventListener('change', () => {
      tavilyApiUrl = tavilyApiUrlInput.value;
      saveSearchSettings();
  });

  tavilyApiUrlInput.addEventListener('click', (e) => {
      e.stopPropagation();
  });

  // Exa 输入框事件
  exaApiKeyInput.addEventListener('change', () => {
      exaApiKey = exaApiKeyInput.value;
      saveSearchSettings();
  });

  exaApiKeyInput.addEventListener('click', (e) => {
      e.stopPropagation();
  });

  exaApiUrlInput.addEventListener('change', () => {
      exaApiUrl = exaApiUrlInput.value;
      saveSearchSettings();
  });

  exaApiUrlInput.addEventListener('click', (e) => {
      e.stopPropagation();
  });

  // 测试连接按钮事件
  testTavilyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await testTavilyConnection(testTavilyBtn);
  });

  testExaBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await testExaConnection(testExaBtn);
  });

  // 构建带 /search 路径的 URL
  function buildSearchUrl(baseUrl, defaultUrl) {
      if (!baseUrl || !baseUrl.trim()) {
          return defaultUrl;
      }
      let url = baseUrl.trim();
      // 移除结尾的斜线
      url = url.replace(/\/+$/, '');
      // 如果用户没有添加 /search，自动添加
      if (!url.endsWith('/search')) {
          url += '/search';
      }
      return url;
  }

  // Tavily 测试连接
  async function testTavilyConnection(button) {
      const key = tavilyApiKeyInput.value;
      const url = buildSearchUrl(tavilyApiUrlInput.value, 'https://api.tavily.com/search');

      if (!key) {
          showToast('请输入 Tavily API Key', 'error');
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
          const response = await fetch(url, {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                  api_key: key,
                  query: 'test connection',
                  search_depth: 'basic',
                  max_results: 1
              })
          });

          if (!response.ok) {
              let errorMsg = `HTTP error! status: ${response.status}`;
              try {
                  const errorData = await response.json();
                  errorMsg += ` - ${errorData.detail || errorData.message || JSON.stringify(errorData)}`;
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
          console.error('Tavily test connection error:', error);
          showToast(`Tavily 连接失败: ${error.message}`, 'error');
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

  // Exa 测试连接
  async function testExaConnection(button) {
      const key = exaApiKeyInput.value;
      const url = buildSearchUrl(exaApiUrlInput.value, 'https://api.exa.ai/search');

      if (!key) {
          showToast('请输入 Exa API Key', 'error');
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
          const response = await fetch(url, {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': key
              },
              body: JSON.stringify({
                  query: 'test connection',
                  numResults: 1,
                  contents: {
                      text: true
                  }
              })
          });

          if (!response.ok) {
              let errorMsg = `HTTP error! status: ${response.status}`;
              try {
                  const errorData = await response.json();
                  errorMsg += ` - ${errorData.error || errorData.message || JSON.stringify(errorData)}`;
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
          console.error('Exa test connection error:', error);
          showToast(`Exa 连接失败: ${error.message}`, 'error');
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

  // 兼容旧版本的函数别名
  async function loadTavilyApiKey() {
      await loadSearchSettings();
  }

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

    // Unified Settings Page Logic
   const unifiedSettingsToggle = document.getElementById('unified-settings-toggle');
   const backButton = unifiedSettingsPage.querySelector('.back-button');
   const tabButtons = unifiedSettingsPage.querySelectorAll('.tab-button');
   const tabContents = unifiedSettingsPage.querySelectorAll('.tab-content');

   unifiedSettingsToggle.addEventListener('click', () => {
       unifiedSettingsPage.style.display = 'flex';
       settingsMenu.classList.remove('visible');
   });

   backButton.addEventListener('click', () => {
       unifiedSettingsPage.style.display = 'none';
   });

   tabButtons.forEach(button => {
       button.addEventListener('click', () => {
           tabButtons.forEach(btn => btn.classList.remove('active'));
           button.classList.add('active');

           tabContents.forEach(content => {
               if (content.id === button.dataset.tab) {
                   content.classList.add('active');
               } else {
                   content.classList.remove('active');
               }
           });
       });
   });

    // API 设置功能
    const apiCards = unifiedSettingsPage.querySelector('.api-cards');

    // 更新 placeholder 的函数
    function updatePlaceholderWithCurrentModel() {
        if (apiConfigs.length > 0 && selectedConfigIndex < apiConfigs.length) {
            const modelName = apiConfigs[selectedConfigIndex].modelName || 'default model';
            updatePermanentPlaceholder(messageInput, modelName);
        }
    }

    // API 卡片控制器引用
    let apiCardController = null;

    // 初始化 API 卡片的辅助函数
    const initAPICardWithCallbacks = () => {
        apiCardController = initAPICard({
            apiConfigs,
            selectedIndex: selectedConfigIndex,
            onProfileChange: (newIndex) => {
                selectedConfigIndex = newIndex;
                updatePlaceholderWithCurrentModel();
                chatManager.setApiConfig(apiConfigs[selectedConfigIndex]);
                saveAPIConfigs();
            },
            onProfileAdd: (newConfig, newIndex) => {
                selectedConfigIndex = newIndex;
                updatePlaceholderWithCurrentModel();
                chatManager.setApiConfig(apiConfigs[selectedConfigIndex]);
                saveAPIConfigs();
            },
            onProfileDelete: (deletedIndex, newIndex) => {
                selectedConfigIndex = newIndex;
                updatePlaceholderWithCurrentModel();
                chatManager.setApiConfig(apiConfigs[selectedConfigIndex]);
                saveAPIConfigs();
            },
            onConfigChange: (index, config) => {
                apiConfigs[index] = config;
                if (index === selectedConfigIndex) {
                    updatePlaceholderWithCurrentModel();
                    chatManager.setApiConfig(apiConfigs[selectedConfigIndex]);
                }
                saveAPIConfigs();
            },
            onSave: saveAPIConfigs
        });
    };

    // 为了兼容性保留的函数别名
    const renderAPICardsWithCallbacks = () => {
        if (apiCardController) {
            apiCardController.setSelectedIndex(selectedConfigIndex);
        }
    };

    // 从存储加载配置
    async function loadAPIConfigs() {
        try {
            // 统一使用 syncStorageAdapter 来实现配置同步
            const result = await syncStorageAdapter.get(['apiConfigs', 'selectedConfigIndex']);

            // 分别检查每个配置项
            if (result.apiConfigs) {
                apiConfigs = result.apiConfigs;
            } else {
                apiConfigs = [{
                    apiKey: '',
                    baseUrl: 'https://api.CloseAi.com/v1/chat/completions',
                    modelName: '',
                    profileName: '配置 1',
                    advancedSettings: {
                        systemPrompt: DEFAULT_SYSTEM_PROMPT,
                        isExpanded: false
                    }
                }];
                // 只有在没有任何配置的情况下才保存默认配置
                await saveAPIConfigs();
            }

            // 只有当 selectedConfigIndex 为 undefined 或 null 时才使用默认值 0
            selectedConfigIndex = result.selectedConfigIndex ?? 0;

            // 初始化 API 卡片
            initAPICardWithCallbacks();
            updatePlaceholderWithCurrentModel();
            chatManager.setApiConfig(apiConfigs[selectedConfigIndex]); // 初始化时设置API配置
        } catch (error) {
            console.error('加载 API 配置失败:', error);
            // 只有在出错的情况下才使用默认值
            apiConfigs = [{
                apiKey: '',
                baseUrl: 'https://api.CloseAi.com/v1/chat/completions',
                modelName: '',
                profileName: '配置 1',
                advancedSettings: {
                    systemPrompt: DEFAULT_SYSTEM_PROMPT,
                    isExpanded: false
                }
            }];
            selectedConfigIndex = 0;
            initAPICardWithCallbacks();
            updatePlaceholderWithCurrentModel();
            chatManager.setApiConfig(apiConfigs[selectedConfigIndex]); // 初始化时设置API配置
        }
    }

    // 监听标签页切换
    browserAdapter.onTabActivated(async () => {
        // console.log('标签页切换，重新加载API配置');
        // await loadWebpageSwitch();
        // 同步API配置
        await loadAPIConfigs();
        await loadTavilyApiKey();
        renderAPICardsWithCallbacks();

        // 同步历史
        await chatManager.initialize();
        await renderChatList(
            chatManager,
            chatListPage.querySelector('.chat-cards')
        );

        // 如果当前对话为空，则重置网页内容开关
        const currentChat = chatManager.getCurrentChat();
        if (currentChat && currentChat.messages.length === 0) {
            const currentTab = await browserAdapter.getCurrentTab();
            if (currentTab) {
                await storageAdapter.set({ webpageSwitches: { [currentTab.id]: true } });
            }
        }
    });
    // 保存配置到存储
    async function saveAPIConfigs() {
        try {
            // 统一使用 syncStorageAdapter 来实现配置同步
            await syncStorageAdapter.set({
                apiConfigs,
                selectedConfigIndex
            });
        } catch (error) {
            console.error('保存 API 配置失败:', error);
        }
    }

    // 等待 DOM 加载完成后再初始化
    await loadAPIConfigs();
    await loadTavilyApiKey();

    // 监听标题更新事件
    document.addEventListener('chat-title-updated', (e) => {
        const { chatId, newTitle } = e.detail;
        const card = chatListPage.querySelector(`.chat-card[data-chat-id="${chatId}"]`);
        if (card) {
            const titleElement = card.querySelector('.chat-title');
            if (titleElement) {
                titleElement.textContent = newTitle;
            }
        }
    });

    // 图片预览功能
    const closeButton = previewModal.querySelector('.image-preview-close');

    closeButton.addEventListener('click', () => {
        hideImagePreview({ config: uiConfig.imagePreview });
    });

    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) {
            hideImagePreview({ config: uiConfig.imagePreview });
        }
    });
});