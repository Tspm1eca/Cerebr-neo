import { initDarkTheme } from './utils/theme.js';
import { callAPI, TimeoutError } from './services/chat.js';
import { chatManager } from './utils/chat-manager.js';
import { appendMessage, createWaitingMessage, createYouTubeExtractionMessage, transitionExtractionToWaiting, loadThumbnailCache } from './handlers/message-handler.js';
import { hideContextMenu } from './components/context-menu.js';
import { initChatContainer } from './components/chat-container.js';
import { showImagePreview, hideImagePreview } from './utils/ui.js';
import { initAPICard } from './components/api-card.js';
import { DEFAULT_SYSTEM_PROMPT } from './constants/prompts.js';
import { storageAdapter, syncStorageAdapter, browserAdapter, isExtensionEnvironment, initSyncMode } from './utils/storage-adapter.js';
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
import { initWebDAVSettings, showToast as showWebDAVToast } from './components/webdav-settings.js';
import { webdavSyncManager } from './services/webdav-sync.js';

// 存储用户的问题历史
let userQuestions = [];

// 将 API 配置提升到模块作用域，以确保在异步事件中状态的稳定性
// 加载保存的 API 配置
let apiConfigs = [];
let selectedConfigIndex = 0;

// 网络搜索配置
let searchProvider = 'tavily'; // 'tavily' | 'exa'

/**
 * 光暈收縮進氣泡的過渡效果：移除呼吸光暈動畫時，
 * 先用 inline style 凍結當前光暈狀態，再透過 CSS transition 平滑收縮至基底樣式。
 */
function fadeOutGlow(messageEl) {
    const isSearch = messageEl.classList.contains('search-used');
    const isYouTube = messageEl.classList.contains('youtube-chat');
    const c = isSearch ? '34, 197, 94' : isYouTube ? '160, 100, 220' : '106, 161, 220';

    // 1. 用 inline style 凍結光暈起始狀態（取呼吸動畫的靜止幀值）
    messageEl.style.boxShadow =
        `0 0 3px rgba(${c}, 0.3), 0 0 6px rgba(${c}, 0.2), 0 0 9px rgba(${c}, 0.1)`;
    messageEl.style.borderColor = `rgba(${c}, 0.5)`;

    // 2. 移除動畫 class，加上帶 transition 的 glow-fading class
    messageEl.classList.remove('waiting', 'updating');
    messageEl.classList.add('glow-fading');

    // 3. 強制 reflow，確保瀏覽器記錄起始值
    void messageEl.offsetWidth;

    // 4. 清除 inline style → CSS transition 平滑收縮至基底 box-shadow / border-color
    messageEl.style.boxShadow = '';
    messageEl.style.borderColor = '';

    // 5. transition 結束後清理
    const cleanup = () => {
        messageEl.classList.remove('glow-fading');
        messageEl.removeEventListener('transitionend', onEnd);
    };
    const onEnd = (e) => {
        if (e.propertyName === 'box-shadow') cleanup();
    };
    messageEl.addEventListener('transitionend', onEnd);
    setTimeout(cleanup, 600); // fallback
}

function resetStreamingSizeState(messageEl) {
    if (!messageEl) return;

    // 清理可能殘留的尺寸鎖定，避免後續容器寬度變化時氣泡被舊寬度卡住
    messageEl.style.width = '';
    messageEl.style.height = '';
    messageEl.style.overflow = '';
    messageEl.style.transition = '';
    delete messageEl._waitingHeight;
    delete messageEl._waitingWidth;

    if (messageEl._heightAnim) {
        if (messageEl._heightAnim.rafId) cancelAnimationFrame(messageEl._heightAnim.rafId);
        delete messageEl._heightAnim;
    }
    if (messageEl._sizeAnim) {
        if (messageEl._sizeAnim.rafId) cancelAnimationFrame(messageEl._sizeAnim.rafId);
        delete messageEl._sizeAnim;
    }
}

function cleanupStreamingMessage(messageEl) {
    if (!messageEl) return;

    // 清理可能殘留的尺寸動畫與 inline 尺寸
    resetStreamingSizeState(messageEl);

    // waiting 氣泡不應該在請求結束後殘留
    if (messageEl.classList.contains('waiting')) {
        messageEl.classList.remove('waiting', 'updating');
        messageEl.remove();
        return;
    }

    if (messageEl.classList.contains('updating')) {
        fadeOutGlow(messageEl);
    } else {
        messageEl.classList.remove('waiting', 'updating');
    }
    messageEl.classList.add('rendered');
}

function cleanupActiveStreamingMessages(chatContainer) {
    const activeMessages = chatContainer.querySelectorAll('.ai-message.updating, .ai-message.waiting');
    activeMessages.forEach(cleanupStreamingMessage);
}

let tavilyApiKey = '';
let tavilyApiUrl = '';
let exaApiKey = '';
let exaApiUrl = '';
const YT_WATCH_RE = /^https?:\/\/(www\.)?youtube\.com\/watch/;

 document.addEventListener('DOMContentLoaded', async () => {
     // 初始化 sync 模式（必須在任何 syncStorageAdapter 呼叫之前）
     await initSyncMode();

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
            onImageClick: (imageSource, sourceElement) => {
                showImagePreview({
                    imageSource,
                    config: uiConfig.imagePreview,
                    sourceElement
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
    const quickChatController = await initQuickChat({
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

    // 載入持久化的縮圖快取（非阻塞，不影響啟動速度）
    loadThumbnailCache();

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
        try {
            const currentTab = await browserAdapter.getCurrentTab();
            if (currentTab) {
                await storageAdapter.set({ webpageSwitches: { [currentTab.id]: true } });
            }
        } catch (error) {
            console.warn('初始化时重置网页开关失败:', error);
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

        // 標記正在串流的聊天，防止 initialize() 清除記憶體中的串流資料
        chatManager.setStreamingChatId(chatId);

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
            // 移除等待动画（包括 YouTube 提取狀態）
            const waitingMsg = chatContainer.querySelector('.message.ai-message.waiting, .message.ai-message.updating');
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
            // 清除串流標記
            chatManager.setStreamingChatId(null);
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
            resetStreamingSizeState(updatingMessage);

            if (isWaiting) {
                updatingMessage.classList.remove('waiting', 'updating');
                updatingMessage.remove();
            } else {
                fadeOutGlow(updatingMessage);
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
                        const imageSource = tag.getAttribute('data-image');
                        if (imageSource) {
                            content.push({
                                type: "image_url",
                                image_url: { url: imageSource }
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
            chatManager.saveChat(currentChat.id);

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
                    const waitingMsg = chatContainer.querySelector('.message.ai-message.waiting, .message.ai-message.updating');
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
                // 移除等待動畫（如果存在，包括 YouTube 提取狀態）
                // 注意：updating 訊息已有串流內容，不應刪除，只清理串流狀態
                const waitingMsg = chatContainer.querySelector('.message.ai-message.waiting, .message.ai-message.updating');
                if (waitingMsg) {
                    if (waitingMsg.classList.contains('waiting')) {
                        waitingMsg.remove();
                    } else {
                        cleanupStreamingMessage(waitingMsg);
                    }
                }

                // 根據錯誤類型顯示不同的錯誤訊息
                let errorMessage = '重新生成失败: ' + error.message;
                if (error?.code === 'YOUTUBE_TRANSCRIPT_UNAVAILABLE') {
                    errorMessage = error.message || '无法提取 YouTube 字幕。';
                }
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
                cleanupActiveStreamingMessages(chatContainer);
            }
        }
    }

    async function sendMessage() {
        // 生成新的请求ID
        const currentRequestId = Date.now().toString();
        activeRequestId = currentRequestId;
        let shouldRollbackUserMessage = false;

        // 如果有正在更新或等待的AI消息，停止它
        const updatingMessage = chatContainer.querySelector('.ai-message.updating, .ai-message.waiting');
        if (updatingMessage && currentController) {
            const isWaiting = updatingMessage.classList.contains('waiting');
            currentController.abort();
            currentController = null;
            abortControllerRef.current = null; // 同步更新引用对象
            resetStreamingSizeState(updatingMessage);

            if (isWaiting) {
                updatingMessage.classList.remove('waiting', 'updating');
                updatingMessage.remove();
            } else {
                fadeOutGlow(updatingMessage);
            }
        }
        if (abortControllerRef) abortControllerRef.pendingAbort = false;

        // 获取格式化后的消息内容
        const { message, imageTags, previewImages } = getFormattedMessageContent(messageInput);

        if (!message.trim() && imageTags.length === 0 && previewImages.length === 0) return;

        try {
            // 构建消息内容
            const content = await buildMessageContent(message, imageTags, previewImages);

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

            if (wasNewChat) {
                const chatCards = chatListPage.querySelector('.chat-cards');
                renderChatList(chatManager, chatCards);
            }

            // 先基于当前活动标签页预判 YouTube 模式，保证等待气泡及时显示紫色样式
            let isCurrentTabYouTube = false;
            if (isExtensionEnvironment && sendWebpageSwitch.checked) {
                try {
                    const currentTab = await browserAdapter.getCurrentTab();
                    const currentTabUrl = currentTab?.url || '';
                    isCurrentTabYouTube = YT_WATCH_RE.test(currentTabUrl);
                } catch (e) {
                    console.warn('获取当前标签页失败:', e);
                }
            }

            // 先显示等待动画，再执行网页内容提取，避免 YouTube 字幕较长时无反馈
            // 僅首次提問顯示提取動畫，後續提問直接顯示等待動畫（字幕已快取）
            const isFirstMessage = !currentChat || currentChat.messages.length === 0;
            let youtubeExtractionMsg = null;
            if (isCurrentTabYouTube && isFirstMessage) {
                youtubeExtractionMsg = createYouTubeExtractionMessage(chatContainer);
            } else {
                createWaitingMessage(chatContainer, { isYouTube: isCurrentTabYouTube });
            }
            const webpageInfo = isExtensionEnvironment && sendWebpageSwitch.checked ? await getEnabledTabsContent() : null;
            // YouTube 提取完成後，過渡到三點等待動畫（帶拉伸動畫）
            if (youtubeExtractionMsg && youtubeExtractionMsg.parentNode) {
                transitionExtractionToWaiting(youtubeExtractionMsg, chatContainer);
            }
            shouldRollbackUserMessage = true;
            await chatManager.addMessageToCurrentChat(userMessage, webpageInfo);

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
                    const waitingMsg = chatContainer.querySelector('.message.ai-message.waiting, .message.ai-message.updating');
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
                // 移除等待動畫（如果存在，包括 YouTube 提取狀態）
                // 注意：updating 訊息已有串流內容，不應刪除，只清理串流狀態
                const waitingMsg = chatContainer.querySelector('.message.ai-message.waiting, .message.ai-message.updating');
                if (waitingMsg) {
                    if (waitingMsg.classList.contains('waiting')) {
                        waitingMsg.remove();
                    } else {
                        cleanupStreamingMessage(waitingMsg);
                    }
                }

                // 根據錯誤類型顯示不同的錯誤訊息
                let errorMessage = '发送失败: ' + error.message;
                if (error?.code === 'YOUTUBE_TRANSCRIPT_UNAVAILABLE') {
                    errorMessage = error.message || '无法提取 YouTube 字幕。';
                }
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
                if (shouldRollbackUserMessage) {
                    const currentChat = chatManager.getCurrentChat();
                    const messages = currentChat?.messages || [];
                    if (messages.length > 0) {
                        const lastMsg = messages[messages.length - 1];
                        if (lastMsg.role === 'assistant') {
                            // 空回覆才 rollback 整個回合；有內容則保留部分回覆
                            if (!lastMsg.content?.trim()) {
                                chatManager.popMessage(); // 移除空的 assistant 訊息
                                // 僅在不會清空對話的情況下才移除用戶訊息，
                                // 保留用戶訊息讓「重新生成」功能能正確運作
                                if (currentChat.messages.length > 1) {
                                    chatManager.popMessage();
                                }
                            }
                        } else {
                            // 僅在不會清空對話的情況下才移除用戶訊息，
                            // 保留用戶訊息讓「重新生成」功能能正確運作
                            if (messages.length > 1) {
                                chatManager.popMessage();
                            }
                        }
                    }

                    // rollback 後若對話已無任何訊息，刪除整個對話並刷新歷史列表
                    const chatAfterRollback = chatManager.getCurrentChat();
                    if (chatAfterRollback && chatAfterRollback.messages.length === 0) {
                        await chatManager.deleteChat(chatAfterRollback.id);
                        const chatCards = chatListPage.querySelector('.chat-cards');
                        renderChatList(chatManager, chatCards);
                    }
                }
            }
        } finally {
            // 只有当仍然是当前活动的请求时才清理状态
            if (currentRequestId === activeRequestId) {
                cleanupActiveStreamingMessages(chatContainer);
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
        // 先清掉舊 timer，避免殘留 timer 在點擊選單項目時把選單提前收起
        clearTimeout(menuTimeout);
        menuTimeout = setTimeout(() => {
            const stillHoveringSettingsArea =
                settingsButton.matches(':hover') ||
                settingsMenu.matches(':hover') ||
                webpageContentMenu.matches(':hover');
            if (!stillHoveringSettingsArea) {
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
    settingsMenu.addEventListener('pointerdown', () => clearTimeout(menuTimeout));

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

    // 传送网页开关
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

    // 初始化深色主题
    initDarkTheme({ root: document.documentElement });

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

          button.classList.add('success');
          button.innerHTML = `
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 6L9 17l-5-5"/>
              </svg>
          `;

      } catch (error) {
          console.error('Tavily test connection error:', error);
          showToast(`Tavily 连接失败<br>${error.message}`, 'error');
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

          button.classList.add('success');
          button.innerHTML = `
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 6L9 17l-5-5"/>
              </svg>
          `;

      } catch (error) {
          console.error('Exa test connection error:', error);
          showToast(`Exa 连接失败<br>${error.message}`, 'error');
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

   function showToast(message, type = 'success') {
       showWebDAVToast(message, type);
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
    async function loadAPIConfigs(skipInit = false) {
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

            // 初始化 API 卡片（只在首次加载时初始化，避免重复绑定事件）
            if (!skipInit) {
                initAPICardWithCallbacks();
            } else if (apiCardController) {
                // 标签页切换或 WebDAV 同步后更新配置和 UI，不重新绑定事件
                apiCardController.updateConfigs(apiConfigs, selectedConfigIndex);
            }
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
            if (!skipInit) {
                initAPICardWithCallbacks();
            } else if (apiCardController) {
                apiCardController.updateConfigs(apiConfigs, selectedConfigIndex);
            }
            updatePlaceholderWithCurrentModel();
            chatManager.setApiConfig(apiConfigs[selectedConfigIndex]); // 初始化时设置API配置
        }
    }

    // 监听标签页切换
    browserAdapter.onTabActivated(async () => {
        try {
            // console.log('标签页切换，重新加载API配置');
            // await loadWebpageSwitch();
            // 同步API配置（传入 skipInit=true 避免重复绑定事件）
            await loadAPIConfigs(true);
            await loadSearchSettings();

            // 同步快速選項配置
            await quickChatController.loadQuickChatOptions();

            // 同步历史
            await chatManager.initialize();
            await renderChatList(
                chatManager,
                chatListPage.querySelector('.chat-cards')
            );

            // 保持 UI 与当前对话状态一致，避免分頁切換後畫面殘留舊對話
            const currentChat = chatManager.getCurrentChat();
            if (currentChat && !chatManager._streamingChatId) {
                await loadChatContent(currentChat, chatContainer);
                toggleQuickChatOptions(!(currentChat.messages && currentChat.messages.length > 0));
            }

            // 如果当前对话为空，则重置网页内容开关
            if (currentChat && currentChat.messages.length === 0) {
                try {
                    const currentTab = await browserAdapter.getCurrentTab();
                    if (currentTab) {
                        await storageAdapter.set({ webpageSwitches: { [currentTab.id]: true } });
                    }
                } catch (error) {
                    console.warn('标签页切换后重置网页开关失败:', error);
                }
            }
        } catch (error) {
            console.error('处理标签页切换失败:', error);
        }
    });

    // 延遲 initialize 完成後刷新聊天列表 UI
    chatManager._onDeferredInitComplete = async () => {
        await renderChatList(
            chatManager,
            chatListPage.querySelector('.chat-cards')
        );
    };
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
    await loadSearchSettings();

    // ==================== WebDAV 同步設置 ====================
    // 初始化 WebDAV 設置組件
    const webdavSettingsController = initWebDAVSettings({
        callbacks: {
            onDataReload: async (result) => {
                // 重新載入聊天數據
                await chatManager.initialize();
                const chatCards = chatListPage.querySelector('.chat-cards');
                await renderChatList(chatManager, chatCards);

                const currentChat = chatManager.getCurrentChat();
                if (currentChat) {
                    await loadChatContent(currentChat, chatContainer);
                }

                // 如果 API 配置被同步，重新加載 API 配置和搜索設置
                if (result.apiConfigSynced) {
                    await loadAPIConfigs(true);
                    await loadSearchSettings();
                }

                // 重新載入快速選項
                await quickChatController.loadQuickChatOptions();
            }
        }
    });
    await webdavSettingsController.initialize();

    // WebDAV 按需下載：當用戶切換到 _remoteOnly 聊天時從 WebDAV 下載
    chatManager.setOnDemandLoader((chatId) => webdavSyncManager.downloadChatFile(chatId));

    // 監聯聊天刪除事件，記錄 tombstone 以便 WebDAV 同步
    document.addEventListener('chat-deleted', async (e) => {
        const { chatId } = e.detail;
        if (webdavSyncManager.getConfig().enabled) {
            await webdavSyncManager.addDeletedChatId(chatId);
        }
    });

    // 監聽批次清除事件
    document.addEventListener('chats-cleared', async (e) => {
        const { chatIds } = e.detail;
        if (webdavSyncManager.getConfig().enabled) {
            for (const id of chatIds) {
                await webdavSyncManager.addDeletedChatId(id);
            }
        }
    });

    // WebDAV 同步函數 - 當用戶通過 Alt+Z 開啟插件時調用
    async function performWebDAVSyncOnOpen() {
        const currentChat = chatManager.getCurrentChat();
        await webdavSettingsController.performSyncOnOpen({
            currentChatId: currentChat?.id
        });
    }

    // WebDAV 同步函數 - 當程序關閉時調用
    async function performWebDAVSyncOnClose() {
        await webdavSettingsController.performSyncOnClose();
    }

    // 監聽頁面關閉事件，執行 WebDAV 同步
    window.addEventListener('beforeunload', (event) => {
        // 使用 navigator.sendBeacon 或同步方式確保數據能夠發送
        // 由於 beforeunload 中無法可靠地執行異步操作，
        // 我們使用 visibilitychange 事件作為主要的關閉檢測方式
    });

    // 使用 visibilitychange 事件來檢測頁面即將關閉
    // 這比 beforeunload 更可靠，因為它在頁面隱藏時觸發
    // 加入防抖機制，避免快速切換標籤頁時產生不必要的網路請求
    let syncOnCloseDebounceTimer = null;
    let syncOnCloseExecuted = false; // 去重標記，防止 visibilitychange 和 pagehide 重複觸發
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'hidden') {
            // 頁面被隱藏時，立即寫入當前對話（防止串流中途丟失資料）
            const currentChatId = chatManager.getCurrentChat()?.id;
            if (currentChatId) {
                await chatManager.flushSaveChat(currentChatId);
            }
            // 頁面被隱藏（可能是關閉、切換標籤頁或最小化）
            // 使用 5 秒防抖，過濾快速切換標籤頁的情況
            syncOnCloseExecuted = false;
            clearTimeout(syncOnCloseDebounceTimer);
            syncOnCloseDebounceTimer = setTimeout(async () => {
                syncOnCloseExecuted = true;
                await performWebDAVSyncOnClose();
            }, 5000);
        } else if (document.visibilityState === 'visible') {
            // 頁面重新可見時，取消待執行的同步（用戶快速切回來了）
            clearTimeout(syncOnCloseDebounceTimer);
            syncOnCloseExecuted = false;
        }
    });

    // 監聯頁面卸載事件（作為備用方案，僅在真正卸載時觸發）
    // 委託給 background service worker 執行同步，因為 SW 不受頁面生命週期影響
    window.addEventListener('pagehide', (event) => {
        // pagehide 事件在頁面被卸載時觸發
        // persisted 為 true 表示頁面可能被緩存（bfcache）
        if (!event.persisted) {
            // 標記面板已關閉，讓 SW 知道可以接手同步
            chrome.storage.local.set({ webdav_panel_active: false }).catch(() => {});
            // 取消防抖計時器，避免重複執行
            clearTimeout(syncOnCloseDebounceTimer);
            // 如果 visibilitychange 已經執行過同步，則跳過
            if (!syncOnCloseExecuted) {
                // 委託給 service worker（訊息傳遞幾乎瞬間完成，SW 可在頁面關閉後繼續執行）
                chrome.runtime.sendMessage({ type: 'WEBDAV_SYNC_UPLOAD' }).catch(() => {});
            }
        }
    });

    // 標記面板已啟動，防止 SW 重複同步（面板的 syncOnOpen 會接手）
    chrome.storage.local.set({ webdav_panel_active: true }).catch(() => {});

    // 網頁載入時執行 WebDAV 同步
    performWebDAVSyncOnOpen();
    // ==================== WebDAV 同步設置結束 ====================

    // ==================== 歷史紀錄自動清理功能 ====================
    const HISTORY_LIMIT_THRESHOLD = 100;

    /**
     * 檢查並自動清理超過限制的歷史紀錄
     */
    async function autoCleanupHistoryIfNeeded() {
        const deletedCount = await chatManager.autoCleanupHistory(HISTORY_LIMIT_THRESHOLD);
        if (deletedCount > 0) {
            console.log(`已自動刪除 ${deletedCount} 條舊的歷史紀錄`);
            // 更新歷史紀錄列表顯示
            const chatCards = chatListPage.querySelector('.chat-cards');
            renderChatList(chatManager, chatCards);
        }
    }

    // 在所有初始化完成後檢查並清理歷史紀錄
    autoCleanupHistoryIfNeeded();
    // ==================== 歷史紀錄自動清理功能結束 ====================

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

    // 監聽歷史紀錄自動清理事件
    document.addEventListener('history-auto-cleaned', (e) => {
        const { deletedCount } = e.detail;
        // 更新歷史紀錄列表顯示
        const chatCards = chatListPage.querySelector('.chat-cards');
        renderChatList(chatManager, chatCards);
    });

    // 图片预览功能
    previewModal.addEventListener('click', (e) => {
        // 點擊模態框背景或圖片內容區域都會關閉預覽
        if (e.target === previewModal || e.target.closest('.image-preview-content')) {
            hideImagePreview({ config: uiConfig.imagePreview });
        }
    });
});
