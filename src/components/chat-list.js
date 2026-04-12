import { appendMessage, createWaitingMessage, syncStreamAnimationPhase } from '../handlers/message-handler.js';
import { browserAdapter, isExtensionEnvironment } from '../utils/storage-adapter.js';
import { toggleQuickChatOptions } from './quick-chat.js';
import { resetWebpageSwitchesForCurrentContext } from './webpage-menu.js';
import { t } from '../utils/i18n.js';
import { HISTORY_LIMIT_THRESHOLD } from '../constants/history.js';
import { hideMenuWithAnimation } from '../utils/menu-animation.js';
import {
    hasRenderableMessageContent,
    TRANSIENT_ASSISTANT_STATE_WAITING
} from '../constants/assistant-state.js';

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

function updateHistoryCountDisplay(totalCount) {
    const historyCountElement = document.getElementById('chat-history-count');
    if (!historyCountElement) return;
    const nextText = `${totalCount}/${HISTORY_LIMIT_THRESHOLD}`;
    // Avoid redundant aria-live announcements when value does not change.
    if (historyCountElement.textContent !== nextText) {
        historyCountElement.textContent = nextText;
    }
}

export async function renderChatList(chatManager, chatCards, searchTerm = '') {
    const template = chatCards.querySelector('.chat-card.template');
    const lowerCaseSearchTerm = searchTerm.toLowerCase();

    // 清除现有的卡片（除了模板）
    Array.from(chatCards.children).forEach(card => {
        if (!card.classList.contains('template')) {
            card.remove();
        }
    });

    // 获取当前对话ID
    const currentChatId = chatManager.getCurrentChat()?.id;

    // 获取当前网页的 URL
    let currentPageUrl = null;
    try {
        const currentTab = await browserAdapter.getCurrentTab();
        if (currentTab && currentTab.url) {
            currentPageUrl = currentTab.url;
        }
    } catch (error) {
        console.warn('無法獲取當前網頁 URL:', error);
    }

    // 获取所有对话
    const allChats = chatManager.getAllChats();
    updateHistoryCountDisplay(allChats.length);

    // 筛选对话
    const filteredChats = allChats.filter(chat => {
        if (!searchTerm) return true; // 如果没有搜索词，则显示所有
        const titleMatch = chat.title.toLowerCase().includes(lowerCaseSearchTerm);
        // _remoteOnly 的聊天只搜尋標題（messages 尚未下載）
        if (chat._remoteOnly) return titleMatch;
        const contentMatch = chat.messages.some(message =>
            message.content &&
            (
                (typeof message.content === 'string' && message.content.toLowerCase().includes(lowerCaseSearchTerm)) ||
                (Array.isArray(message.content) && message.content.some(part => part.type === 'text' && part.text.toLowerCase().includes(lowerCaseSearchTerm)))
            )
        );
        return titleMatch || contentMatch;
    });

    // 添加筛选后的对话卡片
    filteredChats.forEach(chat => {
        const card = template.cloneNode(true);
        card.classList.remove('template');
        card.style.display = '';
        card.dataset.chatId = chat.id;

        const titleElement = card.querySelector('.chat-title');
        titleElement.textContent = chat.title;

        // 设置选中状态
        if (chat.id === currentChatId) {
            card.classList.add('selected');
        } else {
            card.classList.remove('selected');
        }

        // Add webpage URL button if URLs exist
        if (chat.webpageUrls && chat.webpageUrls.length > 0) {
            const urlButton = card.querySelector('.webpage-url-btn');
            urlButton.style.display = 'flex';
            // Join all URLs into a single string for the title
            urlButton.title = chat.webpageUrls.join('\n');
            urlButton.addEventListener('click', (e) => {
                e.stopPropagation();
                // For now, let's just open the first URL.
                // A more advanced implementation could show a dropdown.
                window.open(chat.webpageUrls[0], '_blank');
            });

            // 檢查是否與當前網頁 URL 匹配
            if (currentPageUrl && chat.webpageUrls.includes(currentPageUrl)) {
                card.classList.add('current-page-match');
            }
        }

        chatCards.appendChild(card);
    });
}

// 加载对话内容
export async function loadChatContent(chat, chatContainer, chatManager) {
    chatContainer.innerHTML = '';
    const activeStream = chat?.id ? chatManager?.getActiveStreamForChat(chat.id) : null;
    const hasActiveStream = Boolean(activeStream);
    if (!hasActiveStream && chat?.id && chatManager) {
        await chatManager.removeTrailingTransientAssistant(chat.id);
    }
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    // console.log('loadChatContent', JSON.stringify(messages));

    // Use DocumentFragment to reduce reflow
    const fragment = document.createDocumentFragment();
    let pendingWaitingMessage = null;

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const hasRenderableContent = hasRenderableMessageContent(message);
        const isPendingAssistant = hasActiveStream &&
            message.role === 'assistant' &&
            message.updating &&
            (!hasRenderableContent || message.transientState === TRANSIENT_ASSISTANT_STATE_WAITING);

        if (isPendingAssistant) {
            pendingWaitingMessage = message;
            continue;
        }

        if (hasRenderableContent) {
            const messageElement = await appendMessage({
                text: message,
                sender: message.role === 'user' ? 'user' : 'ai',
                chatContainer,
                skipHistory: true,
                fragment,
            });
            if (hasActiveStream && message.role === 'assistant' && message.updating) {
                messageElement.classList.add('updating', 'stream-state-restored', 'rendered');
                syncStreamAnimationPhase(messageElement, activeStream?.startedAt);
            }
        }
    }

    // Insert all messages into DOM once
    chatContainer.appendChild(fragment);

    if (hasActiveStream && pendingWaitingMessage) {
        createWaitingMessage(chatContainer, {
            isSearchUsed: pendingWaitingMessage.isSearchUsed === true,
            restored: true,
            shouldScroll: false,
            streamStartedAt: activeStream?.startedAt
        });
    }

    // Show batch messages without entry animation
    requestAnimationFrame(() => {
        const batchMessages = chatContainer.querySelectorAll('.message.batch-load');
        batchMessages.forEach(msg => {
            msg.classList.add('show', 'rendered');
        });
    });
}

// Switch to target chat
export async function switchToChat(chatId, chatManager, loadChatContentFn = loadChatContent) {
    // console.log('switchToChat', chatId);
    const chat = await chatManager.switchChat(chatId);
    if (chat) {
        await loadChatContentFn(chat, document.getElementById('chat-container'), chatManager);

        // 根据对话是否有消息来显示或隐藏选项按钮区域
        const hasMessages = chat.messages && chat.messages.length > 0;
        toggleQuickChatOptions(!hasMessages);

        // 更新历史中的选中状态
        document.querySelectorAll('.chat-card').forEach(card => {
            if (card.dataset.chatId === chatId) {
                card.classList.add('selected');
            } else {
                card.classList.remove('selected');
            }
        });
    }
}

// 显示历史
export function showChatList(chatListPage, unifiedSettingsPage, onShow) {
    chatListPage.classList.add('show');
    if (unifiedSettingsPage) {
        unifiedSettingsPage.style.display = 'none'; // 确保统一设置页面被隐藏
    }
    if (onShow) onShow();
}

// 隐藏历史
export function hideChatList(chatListPage) {
    chatListPage.classList.remove('show');
}

// 初始化历史事件监听
export function initChatListEvents({
    chatListPage,
    chatCards,
    chatManager,
    loadChatContent: loadChatContentFn = loadChatContent,
    onHide
}) {
    let switchingChatId = null;

    // Chat card click handler
    chatCards.addEventListener('click', async (e) => {
        const card = e.target.closest('.chat-card');
        if (!card || card.classList.contains('template')) return;

        if (!e.target.closest('.delete-btn')) {
            const targetChatId = card.dataset.chatId;
            if (!targetChatId || switchingChatId) {
                return;
            }

            const targetChat = chatManager.getAllChats().find(chat => chat.id === targetChatId);
            const shouldShowLoading = targetChat?._remoteOnly;
            switchingChatId = targetChatId;

            if (shouldShowLoading) {
                card.classList.add('loading');
            }

            try {
                await switchToChat(targetChatId, chatManager, loadChatContentFn);
                if (onHide) onHide();
            } catch (error) {
                console.error(`切換對話 ${targetChatId} 失敗:`, error);
                showToast(error.message, 'error');
            } finally {
                card.classList.remove('loading');
                switchingChatId = null;
            }
        }
    });

    // Delete button click handler
    chatCards.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.delete-btn');
        if (!deleteBtn || switchingChatId) return;

        const card = deleteBtn.closest('.chat-card');
        if (!card || card.classList.contains('template')) return;

        e.stopPropagation();
        try {
            await chatManager.deleteChat(card.dataset.chatId);
        } catch (error) {
            console.error('删除对话失败:', error);
            showToast(error.message, 'error');
            return;
        }

        try {
            await renderChatList(chatManager, chatCards);

            // 如果删除的是当前对话，重新加载聊天内容
            const currentChat = chatManager.getCurrentChat();
            if (currentChat) {
                await loadChatContentFn(currentChat, document.getElementById('chat-container'), chatManager);
            }
        } catch (error) {
            console.error('删除对话后刷新失败:', error);
            showToast(t('chatList.deleteRefreshFailed') + error.message, 'error');
        }
    });

    // 返回按钮点击事件
    const backButton = chatListPage.querySelector('.back-button');
    if (backButton) {
        backButton.addEventListener('click', () => {
            if (onHide) onHide();
        });
    }
}

// 初始化聊天列表功能
export function initializeChatList({
    chatListPage,
    chatManager,
    newChatButton,
    chatListButton,
    settingsMenu,
    unifiedSettingsPage,
    loadChatContent: loadChatContentFn = loadChatContent
}) {
    const messageInput = document.getElementById('message-input');
    // 新建对话按钮点击事件
    newChatButton.addEventListener('click', async () => {
        const currentChat = chatManager.getCurrentChat();
        // 如果当前对话没有消息，并且不是一个已经保存的对话，则不创建新对话
        if (currentChat && currentChat.messages.length === 0 && currentChat.isNew) {
            return;
        }

        if (isExtensionEnvironment) {
            try {
                const currentTab = await browserAdapter.getCurrentTab();
                if (currentTab) {
                    await resetWebpageSwitchesForCurrentContext(currentTab.id);
                }
            } catch (error) {
                console.warn('新建对话时获取当前标签页失败，已跳过网页开关重置:', error);
            }
        }

        const newChat = chatManager.createNewChat();
        await switchToChat(newChat.id, chatManager, loadChatContentFn);
        // 新建对话后，立即渲染一次列表，以显示这个“新对话”
        const chatCards = chatListPage.querySelector('.chat-cards');
        renderChatList(chatManager, chatCards);
        hideMenuWithAnimation(settingsMenu);
        messageInput.focus();
    });

    const openChatListPage = () => {
        showChatList(chatListPage, unifiedSettingsPage, () => {
            const searchInput = document.getElementById('chat-search-input');
            const chatCards = chatListPage.querySelector('.chat-cards');
            searchInput.value = ''; // 清空搜索框
            renderChatList(chatManager, chatCards);
            console.log(`[Cerebr] 共有 ${chatManager.getAllChats().length} 條歷史記錄`);
        });
        hideMenuWithAnimation(settingsMenu);
    };

    // 用於去重 pointerdown 後的相容 click 事件
    let lastPointerOpenAt = 0;

    // 歷史按鈕：優先使用 pointerdown，避免 click 階段被 hover-hide 計時器打斷
    chatListButton.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        lastPointerOpenAt = Date.now();
        openChatListPage();
    });

    // click 後備：保留給鍵盤/非 pointer 情境，並忽略 pointerdown 之後的重複 click
    chatListButton.addEventListener('click', (e) => {
        if (e.detail > 0 && Date.now() - lastPointerOpenAt < 500) {
            return;
        }
        openChatListPage();
    });

    // 搜索框事件
    const searchInput = document.getElementById('chat-search-input');
    const clearSearchBtn = chatListPage.querySelector('.clear-search-btn');
    const chatCards = chatListPage.querySelector('.chat-cards');

    searchInput.addEventListener('input', () => {
        const searchTerm = searchInput.value;
        renderChatList(chatManager, chatCards, searchTerm);
        clearSearchBtn.style.display = searchTerm ? 'flex' : 'none';
    });

    clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
        searchInput.focus();
    });

    // 历史返回按钮点击事件
    const chatListBackButton = chatListPage.querySelector('.back-button');
    if (chatListBackButton) {
        chatListBackButton.addEventListener('click', () => hideChatList(chatListPage));
    }

    // 清除所有對話按鈕點擊事件
    const clearAllBtn = chatListPage.querySelector('.clear-all-btn');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', () => {
            const modal = document.getElementById('clear-all-chats-confirm-modal');
            modal.style.display = 'flex';
        });

        const cancelClearAll = document.getElementById('cancel-clear-all-chats');
        const confirmClearAll = document.getElementById('confirm-clear-all-chats');
        const modal = document.getElementById('clear-all-chats-confirm-modal');

        cancelClearAll.addEventListener('click', () => {
            modal.style.display = 'none';
        });

        confirmClearAll.addEventListener('click', async () => {
            modal.style.display = 'none';
            try {
                // 清除所有對話
                const newChat = await chatManager.clearAllChats();

                // 重新加載對話列表
                renderChatList(chatManager, chatCards);

                // 加載新對話內容
                await loadChatContentFn(newChat, document.getElementById('chat-container'), chatManager);

                // 隱藏對話列表頁面
                hideChatList(chatListPage);

                showToast(t('chatList.allCleared'), 'success');

            } catch (error) {
                console.error('清除对话失败:', error);
                showToast(t('chatList.clearFailed') + error.message, 'error');
            }
        });
    }
}
