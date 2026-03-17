import { createImageTag, showImagePreview, bindImageTagEvents } from '../utils/ui.js';
import { showContextMenu, hideContextMenu, copyMessageContent } from './context-menu.js';
import { handleImageDrop } from '../utils/image.js';
import { updateAIMessage } from '../handlers/message-handler.js';
import { processMathAndMarkdown, renderMathInElement, textMayContainMath } from '../../htmd/latex.js';
import { extractCitationText, isCitationLink } from '../../htmd/citation.js';
import { isTimestampLink, extractSeekSeconds } from '../../htmd/timestamp.js';
import { t } from '../utils/i18n.js';
import { storageAdapter } from '../utils/storage-adapter.js';
import {
    USER_QUESTION_HISTORY_STORAGE_KEY,
    normalizeUserQuestion,
    sanitizeUserQuestions,
    trimUserQuestionHistory
} from '../utils/question-history.js';

const USER_QUESTION_HISTORY_PERSIST_DEBOUNCE_MS = 300;

/**
 * 初始化聊天容器的所有功能
 * @param {Object} params - 初始化参数对象
 * @param {HTMLElement} params.chatContainer - 聊天容器元素
 * @param {HTMLElement} params.messageInput - 消息输入框元素
 * @param {HTMLElement} params.contextMenu - 上下文菜单元素
 * @param {Function} params.sendMessage - 发送消息的函数
 * @param {AbortController} params.currentController - 当前控制器引用
 * @param {Object} params.uiConfig - UI配置对象
 * @param {Array} params.userQuestions - 用户问题历史数组
 * @param {Object} params.chatManager - 聊天管理器实例
 * @returns {Object} 包含更新处理程序的对象
 */
export function initChatContainer({
    chatContainer,
    messageInput,
    contextMenu,
    userQuestions,
    chatManager
}) {
    // 定义本地变量
    let currentMessageElement = null;
    let currentCodeElement = null;
    let persistUserQuestionsTimerId = null;
    let lastPersistedUserQuestionsSnapshot = JSON.stringify(sanitizeUserQuestions(userQuestions));

    const YT_WATCH_RE = /^https?:\/\/(www\.)?youtube\.com\/watch/;
    function isYouTubeChat() {
        const chat = chatManager.getCurrentChat();
        return chat?.webpageUrls?.some(url => YT_WATCH_RE.test(url)) ?? false;
    }

    function schedulePersistUserQuestions() {
        if (!Array.isArray(userQuestions)) return;

        const sanitizedQuestions = sanitizeUserQuestions(userQuestions);
        const nextSnapshot = JSON.stringify(sanitizedQuestions);
        if (nextSnapshot === lastPersistedUserQuestionsSnapshot) return;

        const persist = async () => {
            try {
                await storageAdapter.set({
                    [USER_QUESTION_HISTORY_STORAGE_KEY]: sanitizedQuestions
                });
                lastPersistedUserQuestionsSnapshot = nextSnapshot;
            } catch (error) {
                console.warn('保存本地提问记录失败:', error);
            }
        };

        if (persistUserQuestionsTimerId) {
            clearTimeout(persistUserQuestionsTimerId);
        }
        persistUserQuestionsTimerId = setTimeout(() => {
            persistUserQuestionsTimerId = null;
            void persist();
        }, USER_QUESTION_HISTORY_PERSIST_DEBOUNCE_MS);
    }

    /**
     * 處理 citation-link 的點擊事件
     * 發送跳轉指令到 content script，並提供用戶反饋
     * @param {HTMLElement} linkElement - 被點擊的連結元素
     * @param {string} textToFind - 要在頁面中查找的文本
     */
    async function handleCitationClick(linkElement, textToFind) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                const response = await chrome.tabs.sendMessage(tab.id, {
                    type: 'SCROLL_TO_TEXT',
                    text: textToFind
                });
                // 如果未找到文本，顯示反饋
                if (response && !response.success) {
                    linkElement.classList.add('citation-not-found');
                    setTimeout(() => {
                        linkElement.classList.remove('citation-not-found');
                    }, 2000);
                }
            }
        } catch (error) {
            console.error('發送跳轉指令失敗:', error);
            // 連接失敗時也顯示反饋
            linkElement.classList.add('citation-not-found');
            setTimeout(() => {
                linkElement.classList.remove('citation-not-found');
            }, 2000);
        }
    }

    /**
     * 處理 timestamp-link 的點擊事件
     * 發送跳轉指令到 content script，讓 YouTube 播放器跳轉到指定時間
     * @param {HTMLElement} linkElement - 被點擊的連結元素
     */
    async function handleTimestampClick(linkElement) {
        const href = linkElement.getAttribute('href');
        const seconds = extractSeekSeconds(href);
        if (seconds === null) return;

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                const response = await chrome.tabs.sendMessage(tab.id, {
                    type: 'SEEK_VIDEO',
                    seconds
                });
                if (response && !response.success) {
                    linkElement.classList.add('timestamp-not-found');
                    setTimeout(() => {
                        linkElement.classList.remove('timestamp-not-found');
                    }, 2000);
                }
            }
        } catch (error) {
            console.error('發送影片跳轉指令失敗:', error);
            linkElement.classList.add('timestamp-not-found');
            setTimeout(() => {
                linkElement.classList.remove('timestamp-not-found');
            }, 2000);
        }
    }

    // 初始化 MutationObserver 来监视添加到聊天容器的新用户消息
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) { // 确保是元素节点
                    if (node.classList && node.classList.contains('user-message')) {
                        const isBatchLoadMessage = node.classList.contains('batch-load');
                        if (!isBatchLoadMessage) {
                            const question = normalizeUserQuestion(node.textContent);
                            if (question) {
                                userQuestions.push(question);
                                trimUserQuestionHistory(userQuestions);
                                schedulePersistUserQuestions();
                            }
                        }
                    }
                    // 为新消息中的代码块添加复制按钮
                    addCopyButtonToCodeBlocks(node);

                    // 動畫結束後添加 .rendered 類，移除 will-change 以釋放 GPU 合成層
                    if (node.classList && node.classList.contains('message') && !node.classList.contains('rendered')) {
                        node.addEventListener('animationend', () => {
                            node.classList.add('rendered');
                        }, { once: true });
                    }
                }
            });
        });
    });

    // 开始观察聊天容器的变化
    observer.observe(chatContainer, { childList: true });

    // 添加点击事件监听
    chatContainer.addEventListener('click', (e) => {
        // 事件委託：處理連結的點擊事件
        const link = e.target.closest('a');
        if (link) {
            const href = link.getAttribute('href');
            // 檢查是否為時間戳連結（YouTube 影片跳轉）
            if (isTimestampLink(href)) {
                e.preventDefault();
                e.stopPropagation();
                handleTimestampClick(link);
                return;
            }
            // 檢查是否為引用連結（Text Fragment 或 cite:）
            if (isCitationLink(href)) {
                e.preventDefault();
                e.stopPropagation();
                const textToFind = extractCitationText(href);
                if (textToFind) {
                    handleCitationClick(link, textToFind);
                }
                return;
            }
        }

        // 点击聊天区域时让输入框失去焦点
        messageInput.blur();
    });

    // 监听 AI 消息的右键点击
    chatContainer.addEventListener('contextmenu', (e) => {
        const messageElement = e.target.closest('.ai-message, .user-message');
        const codeElement = e.target.closest('pre > code');
        const imageElement = e.target.closest('img');

        if (messageElement) {
            currentMessageElement = messageElement;
            currentCodeElement = codeElement;

            // 获取菜单元素
            const editMessageButton = document.getElementById('edit-message');
            const copyCodeButton = document.getElementById('copy-code');
            const copyMathButton = document.getElementById('copy-math');
            const copyImageButton = document.getElementById('copy-image');
            const copyMessageButton = document.getElementById('copy-message');
            const deleteMessageButton = document.getElementById('delete-message');
            const regenerateMessageButton = document.getElementById('regenerate-message');

            // 根据右键点击的元素类型显示/隐藏相应的菜单项
            // 只有用户消息且不在更新状态时才显示修改按钮
            const isUserMessage = messageElement.classList.contains('user-message');
            const isUpdating = messageElement.classList.contains('updating');
            editMessageButton.style.display = (isUserMessage && !isUpdating) ? 'flex' : 'none';
            regenerateMessageButton.style.display = 'flex';
            copyMessageButton.style.display = 'flex';
            deleteMessageButton.style.display = 'flex';
            copyCodeButton.style.display = codeElement ? 'flex' : 'none';
            copyMathButton.style.display = 'none';  // 默认隐藏复制公式按钮

            const isImageClick = imageElement && messageElement.classList.contains('ai-message');
            copyImageButton.style.display = isImageClick ? 'flex' : 'none';
            if (isImageClick) {
                copyImageButton.dataset.src = imageElement.getAttribute('data-original-src') || imageElement.src;
            }

            showContextMenu({
                event: e,
                messageElement,
                contextMenu,
                onMessageElementSelect: (element) => {
                    currentMessageElement = element;
                }
            });
        }
    });

    // 添加长按触发右键菜单的支持
    let touchTimeout;
    let touchStartX;
    let touchStartY;
    const LONG_PRESS_DURATION = 200; // 长按触发时间为200ms

    chatContainer.addEventListener('touchstart', (e) => {
        const messageElement = e.target.closest('.ai-message, .user-message');
        if (!messageElement) return;

        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;

        touchTimeout = setTimeout(() => {
            const codeElement = e.target.closest('pre > code');
            currentMessageElement = messageElement;
            currentCodeElement = codeElement;

            // 获取菜单元素
            const editMessageButton = document.getElementById('edit-message');
            const copyMessageButton = document.getElementById('copy-message');
            const copyCodeButton = document.getElementById('copy-code');
            const deleteMessageButton = document.getElementById('delete-message');
            const regenerateMessageButton = document.getElementById('regenerate-message');

             // 根据长按元素类型显示/隐藏相应的菜单项
            // 只有用户消息且不在更新状态时才显示修改按钮
            const isUserMessage = messageElement.classList.contains('user-message');
            const isUpdating = messageElement.classList.contains('updating');
            editMessageButton.style.display = (isUserMessage && !isUpdating) ? 'flex' : 'none';
            regenerateMessageButton.style.display = 'flex';
            copyMessageButton.style.display = 'flex';
            deleteMessageButton.style.display = 'flex';
            copyCodeButton.style.display = codeElement ? 'flex' : 'none';

            showContextMenu({
                event: {
                    preventDefault: () => {},
                    clientX: touchStartX,
                    clientY: touchStartY
                },
                messageElement,
                contextMenu,
                onMessageElementSelect: (element) => {
                    currentMessageElement = element;
                }
            });
        }, LONG_PRESS_DURATION);
    }, { passive: false });

    chatContainer.addEventListener('touchmove', (e) => {
        // 如果移动超过10px，取消长按
        if (touchTimeout &&
            (Math.abs(e.touches[0].clientX - touchStartX) > 10 ||
            Math.abs(e.touches[0].clientY - touchStartY) > 10)) {
            clearTimeout(touchTimeout);
            touchTimeout = null;
        }
    }, { passive: true });

    chatContainer.addEventListener('touchend', (e) => {
        if (touchTimeout) {
            clearTimeout(touchTimeout);
            touchTimeout = null;
        }

        // 如果点击的是编辑容器内的元素，不处理
        if (e.target.closest('.message-edit-container')) {
            return;
        }

        // 如果用户没有触发长按（即正常的触摸结束），则隐藏菜单
        if (!contextMenu.style.display || contextMenu.style.display === 'none') {
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => { currentMessageElement = null; }
            });
        }
    });

    // 为聊天区域添加拖放事件监听器
    chatContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    chatContainer.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    chatContainer.addEventListener('drop', (e) => {
        handleImageDrop(e, {
            messageInput,
            createImageTag,
            onSuccess: () => {
                // 可以在这里添加成功处理的回调
            },
            onError: (error) => {
                console.error('处理拖放事件失败:', error);
            }
        });
    });

    // 阻止聊天区域的图片默认行为
    chatContainer.addEventListener('click', (e) => {
        if (e.target.tagName === 'IMG') {
            e.preventDefault();
            // 注意：这里不再调用 e.stopPropagation()。
            // 这样，点击事件可以冒泡到 document 上的全局监听器，
            // 该监听器会检查点击是否在菜单外部，并相应地隐藏菜单。
            // 我之前的修改错误地在这里隐藏了菜单，现在这个逻辑由全局监听器正确处理。
        }
    });

    // 创建消息同步函数
    const syncMessage = async (updatedChatId, message) => {
        const currentChat = chatManager.getCurrentChat();
        // 只有当更新的消息属于当前显示的对话时才更新界面
        if (currentChat && currentChat.id === updatedChatId) {
            await updateAIMessage({
                text: message,
                chatContainer,
                addCopyButtonToCodeBlocks
            });
        }
    };

    // 设置按钮事件处理器
    function setupButtonHandlers({
        editMessageButton,
        copyMessageButton,
        copyCodeButton,
        copyImageButton,
        deleteMessageButton,
        regenerateMessageButton,
        abortController,
        regenerateMessage
    }) {
        // 点击修改按钮
        editMessageButton.addEventListener('click', () => {
            if (currentMessageElement && currentMessageElement.classList.contains('user-message')) {
                // 保存当前消息元素的引用，防止在编辑过程中 currentMessageElement 被重置或修改
                const messageElementToEdit = currentMessageElement;

                // 获取原始文本
                const originalText = messageElementToEdit.getAttribute('data-original-text') || messageElementToEdit.textContent.trim();

                // 获取消息在聊天记录中的索引
                const messageIndex = Array.from(chatContainer.children).indexOf(messageElementToEdit);

                // 创建编辑输入框
                const editContainer = document.createElement('div');
                editContainer.className = 'message-edit-container';

                const editInput = document.createElement('div');
                editInput.className = 'message-edit-input';
                editInput.contentEditable = 'true';
                // 使用 innerText 來保留換行符
                editInput.innerText = originalText;

                const editActions = document.createElement('div');
                editActions.className = 'message-edit-actions';

                // 取消按钮 - 使用 X 图标
                const cancelButton = document.createElement('button');
                cancelButton.className = 'message-edit-cancel';
                cancelButton.title = t('chat.editCancel');
                cancelButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

                // 保存按钮 - 使用勾选图标
                const saveButton = document.createElement('button');
                saveButton.className = 'message-edit-save';
                saveButton.title = t('chat.editSave');
                saveButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

                // 保存并重新发送按钮 - 使用发送图标
                const saveAndResendButton = document.createElement('button');
                saveAndResendButton.className = 'message-edit-resend';
                saveAndResendButton.title = t('chat.editSaveAndResend');
                saveAndResendButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

                editActions.appendChild(cancelButton);
                editActions.appendChild(saveButton);
                editActions.appendChild(saveAndResendButton);
                editContainer.appendChild(editInput);
                editContainer.appendChild(editActions);

                // 阻止点击输入框时的事件冒泡
                editInput.addEventListener('click', (e) => {
                    e.stopPropagation();
                });

                // 保存原始内容以便取消时恢复
                const originalContent = messageElementToEdit.innerHTML;
                const originalClassName = messageElementToEdit.className;

                // 替换消息内容为编辑框
                messageElementToEdit.innerHTML = '';
                messageElementToEdit.className = 'message user-message editing';
                messageElementToEdit.appendChild(editContainer);

                // 聚焦到输入框并将光标移到末尾
                editInput.focus();
                const range = document.createRange();
                const selection = window.getSelection();
                range.selectNodeContents(editInput);
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);

                // 取消按钮事件
                cancelButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    messageElementToEdit.innerHTML = originalContent;
                    messageElementToEdit.className = originalClassName;
                });

                // 保存按钮事件
                saveButton.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // 使用 innerText 來保留換行符
                    const newText = editInput.innerText.trim();
                    if (newText && newText !== originalText) {
                        // 從原始內容中提取圖片容器（如果有的話）
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = originalContent;
                        const originalImagesContainer = tempDiv.querySelector('.message-images');

                        // 更新消息元素
                        messageElementToEdit.innerHTML = '';
                        messageElementToEdit.className = originalClassName;

                        // 如果有圖片，先添加圖片容器（用戶消息時圖片在文字上方）
                        if (originalImagesContainer) {
                            const clonedImagesContainer = originalImagesContainer.cloneNode(true);
                            messageElementToEdit.appendChild(clonedImagesContainer);

                            // 使用共用函數綁定圖片事件
                            bindImageTagEvents({
                                imagesContainer: clonedImagesContainer,
                                messageElement: messageElementToEdit,
                                messageIndex,
                                chatManager
                            });
                        }

                        // 创建主要内容容器
                        const mainContent = document.createElement('div');
                        mainContent.className = 'main-content';
                        // 使用 processMathAndMarkdown 渲染 Markdown 和數學公式
                        mainContent.innerHTML = processMathAndMarkdown(newText, { timestamps: isYouTubeChat() });
                        messageElementToEdit.appendChild(mainContent);

                        // 渲染 LaTeX 公式（僅在文本可能包含數學公式時才呼叫 MathJax）
                        if (textMayContainMath(newText)) {
                            try {
                                await renderMathInElement(mainContent);
                            } catch (err) {
                                console.error('渲染LaTeX公式失败:', err);
                            }
                        }

                        // 为代码块添加复制按钮
                        addCopyButtonToCodeBlocks(mainContent);

                        // 更新 data-original-text 属性
                        messageElementToEdit.setAttribute('data-original-text', newText);

                        // 更新 chatManager 中的消息
                        const currentChat = chatManager.getCurrentChat();
                        if (currentChat && messageIndex !== -1 && currentChat.messages[messageIndex]) {
                            // 更新消息内容
                            const message = currentChat.messages[messageIndex];
                            if (typeof message.content === 'string') {
                                message.content = newText;
                            } else if (Array.isArray(message.content)) {
                                // 如果是数组格式，更新文本部分
                                const textItem = message.content.find(item => item.type === 'text');
                                if (textItem) {
                                    textItem.text = newText;
                                }
                            }
                            chatManager.saveChat(chatManager.currentChatId);
                        }
                    } else {
                        // 如果文本没有变化或为空，恢复原始内容
                        messageElementToEdit.innerHTML = originalContent;
                        messageElementToEdit.className = originalClassName;
                    }
                });

                // 保存并重新发送按钮事件
                saveAndResendButton.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // 使用 innerText 來保留換行符
                    const newText = editInput.innerText.trim();
                    if (newText) {
                        // 從原始內容中提取圖片容器（如果有的話）
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = originalContent;
                        const originalImagesContainer = tempDiv.querySelector('.message-images');

                        // 更新消息元素
                        messageElementToEdit.innerHTML = '';
                        messageElementToEdit.className = originalClassName;

                        // 如果有圖片，先添加圖片容器（用戶消息時圖片在文字上方）
                        if (originalImagesContainer) {
                            const clonedImagesContainer = originalImagesContainer.cloneNode(true);
                            messageElementToEdit.appendChild(clonedImagesContainer);

                            // 使用共用函數綁定圖片事件
                            bindImageTagEvents({
                                imagesContainer: clonedImagesContainer,
                                messageElement: messageElementToEdit,
                                messageIndex,
                                chatManager
                            });
                        }

                        // 创建主要内容容器
                        const mainContent = document.createElement('div');
                        mainContent.className = 'main-content';
                        // 使用 processMathAndMarkdown 渲染 Markdown 和數學公式
                        mainContent.innerHTML = processMathAndMarkdown(newText, { timestamps: isYouTubeChat() });
                        messageElementToEdit.appendChild(mainContent);

                        // 渲染 LaTeX 公式（僅在文本可能包含數學公式時才呼叫 MathJax）
                        if (textMayContainMath(newText)) {
                            try {
                                await renderMathInElement(mainContent);
                            } catch (err) {
                                console.error('渲染LaTeX公式失败:', err);
                            }
                        }

                        // 为代码块添加复制按钮
                        addCopyButtonToCodeBlocks(mainContent);

                        // 更新 data-original-text 属性
                        messageElementToEdit.setAttribute('data-original-text', newText);

                        // 更新 chatManager 中的消息
                        const currentChat = chatManager.getCurrentChat();
                        if (currentChat && messageIndex !== -1 && currentChat.messages[messageIndex]) {
                            // 更新消息内容
                            const message = currentChat.messages[messageIndex];
                            if (typeof message.content === 'string') {
                                message.content = newText;
                            } else if (Array.isArray(message.content)) {
                                // 如果是数组格式，更新文本部分
                                const textItem = message.content.find(item => item.type === 'text');
                                if (textItem) {
                                    textItem.text = newText;
                                }
                            }
                            chatManager.saveChat(chatManager.currentChatId);
                        }

                        // 触发重新生成消息
                        // 使用 document 上的自定义事件来触发重新生成
                        const regenerateEvent = new CustomEvent('regenerate-from-edit', {
                            detail: { messageElement: messageElementToEdit }
                        });
                        document.dispatchEvent(regenerateEvent);
                    }
                });

                // 按 Enter 保存，按 Escape 取消，按 Ctrl+Enter 保存并重新发送
                editInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && e.ctrlKey) {
                        e.preventDefault();
                        saveAndResendButton.click();
                    } else if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        saveButton.click();
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelButton.click();
                    }
                });

                // 隐藏右键菜单
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => {
                        // 不重置 currentMessageElement，因为我们还需要它来保存编辑
                    }
                });

                return; // 不重置 currentMessageElement
            }
        });

        // 点击复制按钮
        copyMessageButton.addEventListener('click', () => {
            copyMessageContent({
                messageElement: currentMessageElement,
                onSuccess: () => hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => {
                        currentMessageElement = null;
                        currentCodeElement = null;
                    }
                }),
                onError: (err) => console.error('复制失败:', err)
            });
        });

        // 点击复制代码按钮
        copyCodeButton.addEventListener('click', () => {
            if (currentCodeElement) {
                const codeText = currentCodeElement.textContent;
                navigator.clipboard.writeText(codeText)
                    .then(() => {
                        hideContextMenu({
                            contextMenu,
                            onMessageElementReset: () => {
                                currentMessageElement = null;
                                currentCodeElement = null;
                            }
                        });
                    })
                    .catch(err => console.error('复制代码失败:', err));
            }
        });

        // 点击复制图片按钮
        copyImageButton.addEventListener('click', async () => {
            const imageUrl = copyImageButton.dataset.src;
            if (!imageUrl) return;

            // Find the actual image element in the message
            const imgElement = currentMessageElement.querySelector(`img[data-original-src="${imageUrl}"]`) ||
                currentMessageElement.querySelector(`img[src="${imageUrl}"]`);

            try {
                let blob = imgElement ? imgElement.cachedBlob : null;

                // If not cached, fetch it on-demand
                if (!blob) {
                    console.warn("Image was not pre-cached, fetching on demand.");
                    const activeImageUrl = imgElement?.src || imageUrl;
                    if (activeImageUrl.startsWith('data:') || activeImageUrl.startsWith('blob:')) {
                        const response = await fetch(activeImageUrl);
                        blob = await response.blob();
                    } else {
                        // Use the proxy for on-demand fetching as well
                        const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(imageUrl)}`;
                        const response = await fetch(proxyUrl);
                        if (!response.ok) {
                            throw new Error(t('chat.imageProxyFetchFailed', { statusText: response.statusText }));
                        }
                        blob = await response.blob();
                    }
                }

                if (blob) {
                    await navigator.clipboard.write([
                        new ClipboardItem({ [blob.type]: blob })
                    ]);
                } else {
                    throw new Error(t('chat.imageDataUnavailable'));
                }

            } catch (err) {
                console.error('复制图片失败:', err);
                alert(err.message || t('chat.copyImageFailed'));
            } finally {
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => {
                        currentMessageElement = null;
                        currentCodeElement = null;
                    }
                });
            }
        });

        // 添加删除消息按钮的点击事件处理
        deleteMessageButton.addEventListener('click', () => {
            if (currentMessageElement) {
                // 如果消息正在更新，先中止请求
                if (currentMessageElement.classList.contains('updating') && abortController.current) {
                    abortController.current.abort();
                    abortController.current = null;
                }

                // 从DOM中移除消息元素
                const messageIndex = Array.from(chatContainer.children).indexOf(currentMessageElement);
                currentMessageElement.remove();

                // 从chatManager中删除对应的消息
                const currentChat = chatManager.getCurrentChat();
                if (currentChat && messageIndex !== -1) {
                    currentChat.messages.splice(messageIndex, 1);
                    chatManager.saveChat(chatManager.currentChatId);
                }

                // 隐藏右键菜单
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => {
                        currentMessageElement = null;
                        currentCodeElement = null;
                    }
                });
            }
        });

        // 添加重新生成消息按钮的点击事件处理
        regenerateMessageButton.addEventListener('click', () => {
            if (currentMessageElement) {
                regenerateMessage(currentMessageElement);
                // 隐藏右键菜单
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => {
                        currentMessageElement = null;
                        currentCodeElement = null;
                    }
                });
            }
        });
    }

    // 设置数学公式上下文菜单处理
    function setupMathContextMenu() {
        document.addEventListener('contextmenu', (event) => {
            // 检查是否点击了 MathJax 3 的任何元素
            const isMathElement = (element) => {
                const isMjx = element.tagName && element.tagName.toLowerCase().startsWith('mjx-');
                const hasContainer = element.closest('mjx-container') !== null;
                return isMjx || hasContainer;
            };

            if (isMathElement(event.target)) {
                event.preventDefault();
                event.stopPropagation();

                // 获取最外层的 mjx-container
                const container = event.target.closest('mjx-container');

                if (container) {
                    const mathContextMenu = document.getElementById('copy-math');
                    const copyMessageButton = document.getElementById('copy-message');
                    const copyCodeButton = document.getElementById('copy-code');

                    if (mathContextMenu) {
                        // 设置菜单项的显示状态
                        mathContextMenu.style.display = 'flex';
                        copyMessageButton.style.display = 'flex';  // 显示复制消息按钮
                        copyCodeButton.style.display = 'none';

                        // 获取包含公式的 AI 消息元素
                        const aiMessage = container.closest('.ai-message');
                        currentMessageElement = aiMessage;  // 设置当前消息元素为 AI 消息

                        // 调用 showContextMenu 函数
                        showContextMenu({
                            event,
                            messageElement: aiMessage,  // 使用 AI 消息元素
                            contextMenu
                        });

                        // 设置数学公式内容
                        const assistiveMml = container.querySelector('mjx-assistive-mml');
                        let mathContent;

                        // 获取原始的 LaTeX 源码
                        const mjxTexElement = container.querySelector('script[type="math/tex; mode=display"]') ||
                                            container.querySelector('script[type="math/tex"]');

                        if (mjxTexElement) {
                            mathContent = mjxTexElement.textContent;
                        } else {
                            // 如果找不到原始 LaTeX，尝试从 MathJax 内部存储获取
                            const mjxInternal = container.querySelector('mjx-math');
                            if (mjxInternal) {
                                const texAttr = mjxInternal.getAttribute('aria-label');
                                if (texAttr) {
                                    // 移除 "TeX:" 前缀（如果有的话）
                                    mathContent = texAttr.replace(/^TeX:\s*/, '');
                                }
                            }
                        }

                        // 如果还是没有找到，尝试其他方法
                        if (!mathContent) {
                            if (assistiveMml) {
                                const texAttr = assistiveMml.getAttribute('aria-label');
                                if (texAttr) {
                                    mathContent = texAttr.replace(/^TeX:\s*/, '');
                                }
                            }
                        }

                        mathContextMenu.dataset.mathContent = mathContent || container.textContent;
                    }
                }
            }
        }, { capture: true, passive: false });

        // 复制数学公式
        document.getElementById('copy-math')?.addEventListener('click', async () => {
            try {
                // 获取数学公式内容
                const mathContent = document.getElementById('copy-math').dataset.mathContent;

                if (mathContent) {
                    await navigator.clipboard.writeText(mathContent);
                    console.log('数学公式已复制:', mathContent);

                    // 隐藏上下文菜单
                    hideContextMenu({
                        contextMenu,
                        onMessageElementReset: () => {
                            currentMessageElement = null;
                        }
                    });
                } else {
                    console.error('没有找到可复制的数学公式内容');
                }
            } catch (err) {
                console.error('复制公式失败:', err);
            }
        });
    }

    // 设置全局点击和触摸事件，用于隐藏上下文菜单
    function setupGlobalEvents() {
        // 点击其他地方隐藏菜单
        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) {
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => { currentMessageElement = null; }
                });
            }
        });

        // 触摸其他地方隐藏菜单
        document.addEventListener('touchstart', (e) => {
            if (!contextMenu.contains(e.target)) {
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => { currentMessageElement = null; }
                });
            }
        });

        // 滚动相关变量
        let lastScrollTop = chatContainer.scrollTop;
        let scrollTimeout = null;
        let isScrolling = false;
        const inputContainer = document.getElementById('input-container');

        // 监听 input-container 的 class 变化，当展开时重置 lastScrollTop
        const inputContainerObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                    // 当 collapsed 类被移除时，重置 lastScrollTop
                    if (!inputContainer.classList.contains('collapsed')) {
                        lastScrollTop = chatContainer.scrollTop;
                    }
                }
            });
        });
        inputContainerObserver.observe(inputContainer, { attributes: true });

        let rafId = null;
        const messageInputShell = messageInput.closest('.message-input-shell');

        // 滚动时隐藏菜单并处理输入区域收缩
        chatContainer.addEventListener('scroll', () => {
            if (rafId) return;

            rafId = requestAnimationFrame(() => {
                rafId = null;

                // 只有当菜单显示时才隐藏，避免不必要的 DOM 操作
                if (contextMenu.style.display && contextMenu.style.display !== 'none') {
                    hideContextMenu({
                        contextMenu,
                        onMessageElementReset: () => { currentMessageElement = null; }
                    });
                }

                // 检查输入框是否有内容 (使用 class 判断比读取 textContent 更快)
                // message-input.js 会维护 shell 的 has-content 类
                const hasContent = messageInputShell && messageInputShell.classList.contains('has-content');

                // 如果输入框有内容，不触发收缩
                if (hasContent) {
                    lastScrollTop = chatContainer.scrollTop;
                    return;
                }

                // 处理输入区域收缩动画
                const currentScrollTop = chatContainer.scrollTop;
                const scrollDelta = currentScrollTop - lastScrollTop;
                const isAtBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 50;

                // 标记正在滚动
                isScrolling = true;

                // 向下滚动且不在底部时收缩
                if (scrollDelta > 5 && !isAtBottom && currentScrollTop > 100) {
                    if (!inputContainer.classList.contains('collapsed')) {
                        inputContainer.classList.add('collapsed');
                    }
                }
                // 向上滚动时展开
                else if (scrollDelta < -5) {
                    if (inputContainer.classList.contains('collapsed')) {
                        inputContainer.classList.remove('collapsed');
                    }
                }

                lastScrollTop = currentScrollTop;

                // 停止滚动后一段时间恢复展开状态
                clearTimeout(scrollTimeout);
                scrollTimeout = setTimeout(() => {
                    isScrolling = false;
                    // 如果在底部附近，展开输入区域
                    if (isAtBottom) {
                        inputContainer.classList.remove('collapsed');
                    }
                }, 1500);
            });
        });

        // 按下 Esc 键隐藏菜单
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideContextMenu({
                    contextMenu,
                    onMessageElementReset: () => { currentMessageElement = null; }
                });
            }
        });
    }

    // 为代码块添加复制按钮的函数
    function addCopyButtonToCodeBlocks(container) {
        const codeBlocks = container.querySelectorAll('pre');
        codeBlocks.forEach(pre => {
            // 防止重复添加按钮
            if (pre.querySelector('.copy-code-button')) {
                return;
            }

            const button = document.createElement('button');
            button.className = 'copy-code-button';
            const copyIcon = `<svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
            const copiedIcon = `<svg class="checkmark-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 L9 17 L20 6"></path></svg>`;
            button.innerHTML = copyIcon;
            pre.appendChild(button);

            button.addEventListener('click', (e) => {
                e.stopPropagation(); // 防止触发其他点击事件
                const code = pre.querySelector('code');
                if (code) {
                    // 防止重复点击
                    if (button.classList.contains('copied')) return;

                    navigator.clipboard.writeText(code.textContent).then(() => {
                        // 添加动画类
                        button.classList.add('copying');

                        // 短暂延迟后切换到打勾图标
                        setTimeout(() => {
                            button.innerHTML = copiedIcon;
                            button.classList.remove('copying');
                            button.classList.add('copied');
                        }, 80);

                        // 不再自动恢复，而是等用户离开代码块时才恢复
                    }).catch(err => {
                        console.error('Failed to copy code: ', err);
                        button.textContent = 'Error';
                        setTimeout(() => {
                            button.innerHTML = copyIcon;
                        }, 2000);
                    });
                }
            });

            // 当用户离开代码块时，恢复复制按钮的原始状态
            pre.addEventListener('mouseleave', () => {
                if (button.classList.contains('copied')) {
                    button.classList.remove('copied');
                    button.innerHTML = copyIcon;
                }
            });
        });
    }

     // 初始化函数
     function initialize() {
         setupMathContextMenu();
         setupGlobalEvents();
         addCopyButtonToCodeBlocks(chatContainer); // 为已存在的代码块添加按钮
     }

     // 立即执行初始化
     initialize();

    // 添加自定义复制事件处理器
    chatContainer.addEventListener('copy', (event) => {
        const selection = document.getSelection();
        if (selection.rangeCount === 0 || selection.toString().trim() === '') {
            return;
        }

        // 检查选区是否在聊天容器内
        if (!chatContainer.contains(selection.anchorNode) || !chatContainer.contains(selection.focusNode)) {
            return;
        }

        event.preventDefault();

        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        const tempDiv = document.createElement('div');
        tempDiv.appendChild(fragment);

        // 优化MathJax公式的复制，移除导致换行的多余结构
        const mjxContainers = tempDiv.querySelectorAll('mjx-container');
        mjxContainers.forEach(container => {
            const assistiveMml = container.querySelector('mjx-assistive-mml math');
            if (assistiveMml) {
                // 用干净的 MathML 替换整个 mjx-container
                container.parentNode.replaceChild(assistiveMml.cloneNode(true), container);
            }
        });

        const html = tempDiv.innerHTML;
        const plainText = tempDiv.textContent; // 从清理后的div中获取纯文本

        event.clipboardData.setData('text/html', html);
        event.clipboardData.setData('text/plain', plainText);
    });

    // 返回包含公共方法的对象
    return {
        syncMessage,
        setupButtonHandlers,
        addCopyButtonToCodeBlocks
    };
}
