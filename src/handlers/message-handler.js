import { chatManager } from '../utils/chat-manager.js';
import { showImagePreview, createImageTag, removeImageFromChatManager } from '../utils/ui.js';
import { createThumbnailImage } from '../utils/image.js';
import { syncStorageAdapter } from '../utils/storage-adapter.js';
import { processMathAndMarkdown, renderMathInElement, textMayContainMath } from '../../htmd/latex.js';
import { extractCitationText, isCitationLink } from '../../htmd/citation.js';

const WEBDAV_CONFIG_KEY = 'webdav_config';
const WEBDAV_CONFIG_CACHE_TTL = 15000;

const webdavConfigCache = {
    value: null,
    timestamp: 0
};

/**
 * 處理消息中的連結：標記引用連結為 citation-link，設置外部連結屬性
 * 支援 Text Fragment 格式 (#:~:text=) 和舊版 cite: 格式
 * 點擊事件由 chat-container.js 中的事件委託統一處理，避免重複綁定
 * @param {HTMLElement} container - 包含連結的容器元素
 */
export function processMessageLinks(container) {
    container.querySelectorAll('a').forEach(link => {
        const href = link.getAttribute('href');
        if (isCitationLink(href)) {
            link.classList.add('citation-link');
            const textToFind = extractCitationText(href);
            if (textToFind) {
                link.title = `跳轉到: "${textToFind}"`;
            }
        } else {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
        }
    });
}

/**
 * Preloads and caches an image to a blob property on the img element.
 * This allows for instant copying later.
 * @param {HTMLImageElement} imgElement The image element to preload.
 */
async function preloadAndCacheImage(imgElement) {
    const imageUrl = imgElement.src;
    // Don't preload base64 images, or if already cached
    if (!imageUrl || imageUrl.startsWith('data:') || imageUrl.startsWith('blob:') || imgElement.cachedBlob) {
        return;
    }

    // Use the proxy for external URLs
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(imageUrl)}`;

    try {
        const response = await fetch(proxyUrl);
        if (!response.ok) {
            console.warn(`Failed to preload image via proxy for ${imageUrl}: ${response.statusText}`);
            return;
        }
        const blob = await response.blob();
        imgElement.cachedBlob = blob;
    } catch (err) {
        console.error(`Failed to preload and cache image for ${imageUrl} via proxy:`, err);
    }
}

/**
 * 消息接口
 * @typedef {Object} Message
 * @property {string} role - 消息角色 ("user" | "assistant")
 * @property {string | Array<{type: string, text?: string, image_url?: {url: string}}>} content - 消息内容
 */

/**
 * 添加消息到聊天界面
 * @param {Object} params - 参数对象
 * @param {Object|string} params.text - 消息文本内容，可以是字符串或包含content和reasoning_content的对象
 * @param {string} params.sender - 发送者类型 ("user" | "assistant")
 * @param {HTMLElement} params.chatContainer - 聊天容器元素
 * @param {boolean} [params.skipHistory=false] - 是否跳过历史记录，skipHistory 的实际作用是：作为一个标志，告诉 appendMessage 函数，当前这条消息只是一个临时的、用于界面展示的通知，而不应该被当作正式的对话内容来处理。
 * @param {DocumentFragment} [params.fragment=null] - 文档片段（用于批量加载）
 * @returns {HTMLElement} 创建的消息元素
 */
export async function appendMessage({
    text,
    sender,
    chatContainer,
    skipHistory = false,
    fragment = null
}) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}-message`;

    // 如果是批量加载，添加特殊类名
    if (fragment) {
        messageDiv.classList.add('batch-load');
    }

    // 檢查是否使用了搜索
    if (typeof text === 'object' && text.isSearchUsed) {
        messageDiv.classList.add('search-used');
    }

    // 檢查是否是錯誤消息
    if (typeof text === 'object' && text.isError) {
        messageDiv.classList.add('error');
    }

    // 处理文本内容
    let textContent = typeof text === 'string' ? text : text.content;

    const previewModal = document.querySelector('.image-preview-modal');
    const previewImage = previewModal.querySelector('img');
    const messageInput = document.getElementById('message-input');

    let messageHtml = '';
    let imagesHtml = '';  // 單獨存放圖片 HTML
    if (Array.isArray(textContent)) {
        for (const item of textContent) {
            if (item.type === "text") {
                messageHtml += item.text;
                textContent = item.text;
            } else if (item.type === "image_url") {
                const imageSource = getImageItemSource(item.image_url);
                let thumbnailSource = getImageItemThumbnail(item.image_url);
                if (!item.image_url?.thumbnail && isHttpImageUrl(imageSource)) {
                    thumbnailSource = await ensureMessageImageThumbnail(item.image_url);
                }
                const imageTag = createImageTag({
                    imageSource,
                    thumbnailSource,
                    config: {
                        onImageClick: (targetImageSource, sourceElement) => {
                            showImagePreview({
                                imageSource: targetImageSource,
                                config: {
                                    previewModal,
                                    previewImage
                                },
                                sourceElement
                            });
                        },
                        onDeleteClick: (container) => {
                            container.remove();
                            messageInput.dispatchEvent(new Event('input'));
                        }
                    }
                });
                imagesHtml += imageTag.outerHTML;  // 圖片單獨收集
            }
        }
    } else {
        messageHtml = textContent;
    }

    // 标题生成逻辑已移至 ChatManager

    const reasoningContent = typeof text === 'string' ? null : text.reasoning_content;

    // 存储原始文本用于复制
    messageDiv.setAttribute('data-original-text', textContent);

    // 如果有思考内容，添加思考模块
    if (reasoningContent) {
        const reasoningWrapper = document.createElement('div');
        reasoningWrapper.className = 'reasoning-wrapper';

        const reasoningDiv = document.createElement('div');
        reasoningDiv.className = 'reasoning-content';

        // 添加占位文本容器
        const placeholderDiv = document.createElement('div');
        placeholderDiv.className = 'reasoning-placeholder';
        placeholderDiv.textContent = '深度思考';
        reasoningDiv.appendChild(placeholderDiv);

        // 添加文本容器
        const reasoningTextDiv = document.createElement('div');
        reasoningTextDiv.className = 'reasoning-text';
        reasoningTextDiv.innerHTML = processMathAndMarkdown(reasoningContent).trim();
        reasoningDiv.appendChild(reasoningTextDiv);

        // 添加点击事件处理折叠/展开
        if (textContent) {
            reasoningDiv.classList.add('collapsed');
        }
        reasoningDiv.onclick = function() {
            this.classList.toggle('collapsed');
        };

        reasoningWrapper.appendChild(reasoningDiv);
        messageDiv.appendChild(reasoningWrapper);
    }

    // 如果有圖片，先添加圖片容器（用戶消息時圖片在文字上方）
    if (imagesHtml && sender === 'user') {
        const imagesContainer = document.createElement('div');
        imagesContainer.className = 'message-images';
        imagesContainer.innerHTML = imagesHtml;
        messageDiv.appendChild(imagesContainer);
        // 添加 has-images class 以便文字右對齊
        messageDiv.classList.add('has-images');
    }

    // 添加主要内容
    const mainContent = document.createElement('div');
    mainContent.className = 'main-content';
    mainContent.innerHTML = processMathAndMarkdown(messageHtml);
    messageDiv.appendChild(mainContent);

    // 如果是 AI 消息且有圖片，圖片放在文字下方
    if (imagesHtml && sender === 'ai') {
        const imagesContainer = document.createElement('div');
        imagesContainer.className = 'message-images';
        imagesContainer.innerHTML = imagesHtml;
        messageDiv.appendChild(imagesContainer);
    }

    // 渲染 LaTeX 公式（僅在文本可能包含數學公式時才呼叫 MathJax）
    if (textMayContainMath(messageHtml) || (reasoningContent && textMayContainMath(reasoningContent))) {
        try {
            await renderMathInElement(messageDiv);
        } catch (err) {
            console.error('渲染LaTeX公式失败:', err);
        }
    }

    // Preload images for faster copying
    messageDiv.querySelectorAll('img').forEach(preloadAndCacheImage);

    // 处理消息中的链接（标记 citation-link 和外部链接属性，点击事件由事件委託處理）
    processMessageLinks(messageDiv);

    // 处理消息中的图片标签
    messageDiv.querySelectorAll('.image-tag').forEach(tag => {
        const img = tag.querySelector('img');
        const deleteBtn = tag.querySelector('.delete-btn');
        const imageSource = tag.getAttribute('data-image');

        // 綁定圖片點擊預覽事件
        if (img && imageSource) {
            img.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showImagePreview({
                    imageSource,
                    config: {
                        previewModal,
                        previewImage
                    },
                    sourceElement: img
                });
            });
        }

        // 綁定刪除按鈕事件
        if (deleteBtn && imageSource) {
            deleteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // 獲取圖片容器
                const imagesContainer = tag.closest('.message-images');

                // 從 DOM 中移除圖片標籤
                tag.remove();

                // 如果圖片容器中沒有圖片了，移除容器並更新樣式
                if (imagesContainer && imagesContainer.querySelectorAll('.image-tag').length === 0) {
                    imagesContainer.remove();
                    messageDiv.classList.remove('has-images');
                }

                // 獲取消息在聊天記錄中的索引並更新 chatManager
                const messageIndex = Array.from(chatContainer.children).indexOf(messageDiv);
                removeImageFromChatManager({
                    chatManager,
                    messageIndex,
                    imageSource
                });
            });
        }
    });

    // 如果提供了文档片段，添加到片段中；否则直接添加到聊天容器
    if (fragment) {
        fragment.appendChild(messageDiv);
    } else {
        chatContainer.appendChild(messageDiv);
        // 只在发送新消息时自动滚动（不是加载历史记录）
        if (sender === 'user' && !skipHistory) {
            requestAnimationFrame(() => {
                chatContainer.scrollTo({
                    top: chatContainer.scrollHeight,
                    behavior: 'smooth'
                });
            });
        }
    }

    // 只有在不跳过历史记录时才添加到历史记录
    if (!skipHistory) {
        if (sender === 'ai') {
            messageDiv.classList.add('updating');
        }
    }

    return messageDiv;
}

/**
 * 创建一个等待中的消息元素
 * @param {HTMLElement} chatContainer - 聊天容器元素
 * @param {Object} [options] - 可選配置
 * @param {boolean} [options.isSearchUsed=false] - 是否使用了搜索功能
 * @returns {HTMLElement} 创建的等待消息元素
 */
export function createWaitingMessage(chatContainer, options = {}) {
    const { isSearchUsed = false } = options;

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message ai-message waiting';

    // 如果使用了搜索，添加搜索標記樣式
    if (isSearchUsed) {
        messageDiv.classList.add('search-used');
    }

    const thinkingDots = document.createElement('div');
    thinkingDots.className = 'thinking-dots';
    thinkingDots.innerHTML = '<span></span><span></span><span></span>';
    messageDiv.appendChild(thinkingDots);

    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });

    return messageDiv;
}

/**
 * 為等待訊息添加搜索標記樣式
 * @param {HTMLElement} chatContainer - 聊天容器元素
 */
export function markWaitingMessageAsSearchUsed(chatContainer) {
    const waitingMessage = chatContainer.querySelector('.message.ai-message.waiting');
    if (waitingMessage && !waitingMessage.classList.contains('search-used')) {
        waitingMessage.classList.add('search-used');
    }
}

/**
 * 更新AI消息内容
 * @param {Object} params - 参数对象
 * @param {Object} params.text - 新的消息文本对象，包含content和reasoningContent
 * @param {string} params.text.content - 主要消息内容
 * @param {string|null} params.text.reasoning_content - 深度思考内容
 * @param {HTMLElement} params.chatContainer - 聊天容器元素
 * @param {Function} [params.addCopyButtonToCodeBlocks] - 可选的添加复制按钮函数
 * @returns {Promise<boolean>} 返回是否成功更新了消息
 */
// 等待动画的特殊标记
const WAITING_ANIMATION_MARKER = '{{WAITING_ANIMATION}}';

export async function updateAIMessage({
    text,
    chatContainer,
    addCopyButtonToCodeBlocks
}) {
    // 处理文本内容
    let textContent = typeof text === 'string' ? text : text.content;
    const reasoningContent = typeof text === 'string' ? null : text.reasoning_content;

    // 特殊處理：如果內容為空且只有 isSearchUsed 標記，則只更新等待訊息的樣式
    // 這用於 "on" 模式下搜索完成後立即標記等待訊息
    if (typeof text === 'object' && text.isSearchUsed && !textContent && !reasoningContent) {
        const waitingMsg = chatContainer.querySelector('.message.ai-message.waiting');
        if (waitingMsg && !waitingMsg.classList.contains('search-used')) {
            waitingMsg.classList.add('search-used');
        }
        return true;
    }

    // 检查是否是等待动画标记
    const isWaitingAnimation = textContent === WAITING_ANIMATION_MARKER;

    // 如果是等待动画，不移除等待消息，而是更新它
    const waitingMessage = chatContainer.querySelector('.message.waiting');

    if (isWaitingAnimation) {
        // 如果已经有等待消息，檢查是否需要添加搜索標記
        if (waitingMessage) {
            // 檢查是否使用了搜索並更新樣式
            if (typeof text === 'object' && text.isSearchUsed) {
                if (!waitingMessage.classList.contains('search-used')) {
                    waitingMessage.classList.add('search-used');
                }
            }
            return true;
        }

        // 否则创建一个新的
        if (!waitingMessage) {
            // 查找正在更新的消息（如果有的话，比如搜索状态消息）
            let targetMessage = chatContainer.querySelector('.ai-message.updating');

            if (!targetMessage) {
                // 如果没有正在更新的消息，创建一个新的
                targetMessage = document.createElement('div');
                targetMessage.className = 'message ai-message updating';
                chatContainer.appendChild(targetMessage);
            }

            // 檢查是否使用了搜索並更新樣式
            if (typeof text === 'object' && text.isSearchUsed) {
                if (!targetMessage.classList.contains('search-used')) {
                    targetMessage.classList.add('search-used');
                }
            }

            // 动画处理：记录原始尺寸
            const rect = targetMessage.getBoundingClientRect();
            targetMessage.style.width = `${rect.width}px`;
            targetMessage.style.height = `${rect.height}px`;
            targetMessage.style.overflow = 'hidden';
            targetMessage.style.transition = 'none'; // 确保设置初始尺寸时不触发过渡

            // 强制重绘
            targetMessage.offsetHeight;

            // 转换为等待状态
            targetMessage.classList.add('waiting');

            // 清空除了 reasoning-wrapper 以外的内容
            Array.from(targetMessage.children).forEach(child => {
                if (!child.classList.contains('reasoning-wrapper')) {
                    child.remove();
                }
            });

            const thinkingDots = document.createElement('div');
            thinkingDots.className = 'thinking-dots';
            thinkingDots.innerHTML = '<span></span><span></span><span></span>';
            targetMessage.appendChild(thinkingDots);

            // 测量新尺寸
            targetMessage.style.width = '';
            targetMessage.style.height = '';
            const newRect = targetMessage.getBoundingClientRect();

            // 恢复到旧尺寸准备动画
            targetMessage.style.width = `${rect.width}px`;
            targetMessage.style.height = `${rect.height}px`;

            // 强制重绘
            targetMessage.offsetHeight;

            // 执行动画
            targetMessage.style.transition = 'width 0.3s ease, height 0.3s ease';
            targetMessage.style.width = `${newRect.width}px`;
            targetMessage.style.height = `${newRect.height}px`;

            // 动画结束后清理
            const cleanup = () => {
                targetMessage.style.width = '';
                targetMessage.style.height = '';
                targetMessage.style.transition = '';
                targetMessage.style.overflow = '';
                targetMessage.removeEventListener('transitionend', cleanup);
            };
            targetMessage.addEventListener('transitionend', cleanup);

            chatContainer.scrollTo({
                top: chatContainer.scrollHeight,
                behavior: 'smooth'
            });
        }
        return true;
    }

    // 不是等待动画，如果有等待消息，将其转换为普通消息
    if (waitingMessage) {
        // 檢查是否使用了搜索並更新樣式（在等待訊息轉換前就添加）
        if (typeof text === 'object' && text.isSearchUsed) {
            if (!waitingMessage.classList.contains('search-used')) {
                waitingMessage.classList.add('search-used');
            }
        }

        // 动画处理：记录原始尺寸（三点动画时的尺寸）
        const rect = waitingMessage.getBoundingClientRect();

        // 锁定起始尺寸，准备过渡
        waitingMessage.style.width = `${rect.width}px`;
        waitingMessage.style.height = `${rect.height}px`;
        waitingMessage.style.overflow = 'hidden';
        waitingMessage.style.transition = 'none'; // 暂时不开启过渡，等待内容更新后统一处理

        // 强制重绘
        waitingMessage.offsetHeight;

        waitingMessage.classList.remove('waiting');

        // 移除 thinking-dots
        const dots = waitingMessage.querySelector('.thinking-dots');
        if (dots) {
            dots.remove();
        }

        // 此时 waitingMessage 应该已经有 updating 类
        if (!waitingMessage.classList.contains('updating')) {
            waitingMessage.classList.add('updating');
        }

        // 标记该消息正在进行过渡动画
        waitingMessage._isTransitioning = true;
    }

    // 優先尋找正在更新中的 AI 消息
    let lastMessage = chatContainer.querySelector('.ai-message.updating');
    const currentText = lastMessage ? lastMessage.getAttribute('data-original-text') || '' : '';

    // 如果没有找到 updating 消息，但有 waiting 消息，则使用 waiting 消息
    // 这处理了从 waiting 状态直接转换的情况，确保不会创建重复消息
    if (!lastMessage && waitingMessage) {
        lastMessage = waitingMessage;
        if (!lastMessage.classList.contains('updating')) {
            lastMessage.classList.add('updating');
        }
        lastMessage.classList.remove('waiting');
        const dots = lastMessage.querySelector('.thinking-dots');
        if (dots) dots.remove();
    }

    if (lastMessage) {
        // 檢查是否使用了搜索並更新樣式
        if (typeof text === 'object' && text.isSearchUsed) {
            if (!lastMessage.classList.contains('search-used')) {
                lastMessage.classList.add('search-used');
            }
        }

        // 获取当前显示的文本
        // 只要内容发生变化就更新（包括重置/变短的情况，这对应于重试）
        // 注意：如果是从 waiting 状态刚恢复过来，lastMessage 就是 waitingMessage，我们需要更新它的内容
        if (textContent !== currentText || reasoningContent || lastMessage.innerHTML === '') {

            // 如果正在过渡中，先锁定当前视觉尺寸，防止内容更新导致闪跳
            if (lastMessage._isTransitioning) {
                const computedStyle = window.getComputedStyle(lastMessage);
                const currentWidth = computedStyle.width;
                const currentHeight = computedStyle.height;

                // 移除旧的 cleanup (如果存在)，手动接管
                if (lastMessage._animCleanup) {
                    lastMessage.removeEventListener('transitionend', lastMessage._animCleanup);
                }

                lastMessage.style.width = currentWidth;
                lastMessage.style.height = currentHeight;
                lastMessage.style.transition = 'none';

                // 强制重绘以应用锁定
                lastMessage.offsetHeight;
            }

            // 更新原始文本属性
            lastMessage.setAttribute('data-original-text', textContent);

            // 处理深度思考内容
            let reasoningDiv = lastMessage.querySelector('.reasoning-content');
            if (reasoningContent) {
                if (!reasoningDiv) {
                    const reasoningWrapper = document.createElement('div');
                    reasoningWrapper.className = 'reasoning-wrapper';

                    reasoningDiv = document.createElement('div');
                    reasoningDiv.className = 'reasoning-content';

                    // 添加占位文本容器
                    const placeholderDiv = document.createElement('div');
                    placeholderDiv.className = 'reasoning-placeholder';
                    placeholderDiv.textContent = '深度思考';
                    reasoningDiv.appendChild(placeholderDiv);

                    // 添加文本容器
                    const reasoningTextDiv = document.createElement('div');
                    reasoningTextDiv.className = 'reasoning-text';
                    reasoningDiv.appendChild(reasoningTextDiv);

                    // 添加点击事件处理折叠/展开
                    reasoningDiv.onclick = function() {
                        this.classList.toggle('collapsed');
                    };

                    reasoningWrapper.appendChild(reasoningDiv);

                    // 确保深度思考模块在最上方
                    if (lastMessage.firstChild) {
                        lastMessage.insertBefore(reasoningWrapper, lastMessage.firstChild);
                    } else {
                        lastMessage.appendChild(reasoningWrapper);
                    }
                }

                // 获取或创建文本容器
                let reasoningTextDiv = reasoningDiv.querySelector('.reasoning-text');
                if (!reasoningTextDiv) {
                    reasoningTextDiv = document.createElement('div');
                    reasoningTextDiv.className = 'reasoning-text';
                    reasoningDiv.appendChild(reasoningTextDiv);
                }

                // 获取当前显示的文本
                const currentReasoningText = reasoningTextDiv.getAttribute('data-original-text') || '';

                // 只要内容发生变化就更新
            if (reasoningContent !== currentReasoningText) {
                // 更新原始文本属性
                reasoningTextDiv.setAttribute('data-original-text', reasoningContent);
                // 更新显示内容
                reasoningTextDiv.innerHTML = processMathAndMarkdown(reasoningContent).trim();
                if (textMayContainMath(reasoningContent)) {
                    await renderMathInElement(reasoningTextDiv);
                }
            }
            }

            if (textContent && reasoningDiv && !reasoningDiv.classList.contains('collapsed')) {
                reasoningDiv.classList.add('collapsed');
            }

            // 处理主要内容
            const mainContent = document.createElement('div');
            mainContent.className = 'main-content';
            mainContent.innerHTML = processMathAndMarkdown(textContent);

            // 清除原有的主要内容
            Array.from(lastMessage.children).forEach(child => {
                if (!child.classList.contains('reasoning-wrapper')) {
                    child.remove();
                }
            });

            // 将主要内容添加到深度思考模块之后
            const reasoningWrapper = lastMessage.querySelector('.reasoning-wrapper');
            if (reasoningWrapper) {
                lastMessage.insertBefore(mainContent, reasoningWrapper.nextSibling);
            } else {
                lastMessage.appendChild(mainContent);
            }

            // 渲染LaTeX公式（僅在文本可能包含數學公式時才呼叫 MathJax）
            if (textMayContainMath(textContent)) {
                await renderMathInElement(mainContent);
            }

            // Preload images for faster copying
            mainContent.querySelectorAll('img').forEach(preloadAndCacheImage);

            // 处理新渲染的链接（标记 citation-link 和外部链接属性，点击事件由事件委託處理）
            processMessageLinks(lastMessage);

            // 为新渲染的代码块添加复制按钮
            if (addCopyButtonToCodeBlocks) {
                addCopyButtonToCodeBlocks(mainContent);
            }

            // 内容更新完毕，处理尺寸过渡动画
            if (lastMessage._isTransitioning) {
                // 测量新内容尺寸
                // 使用 cloneNode 确保样式上下文一致
                const clone = lastMessage.cloneNode(true);
                clone.style.width = 'fit-content';
                clone.style.height = 'auto';
                clone.style.position = 'absolute';
                clone.style.visibility = 'hidden';
                clone.style.maxHeight = 'none'; // 防止高度受限
                clone.style.maxWidth = 'calc(100% - 32px)'; // 保持与CSS一致

                // 插入到容器中测量
                chatContainer.appendChild(clone);
                const newRect = clone.getBoundingClientRect();
                clone.remove();

                // 强制重绘
                lastMessage.offsetHeight;

                // 设置新动画目标
                lastMessage.style.transition = 'width 0.3s ease, height 0.3s ease';
                lastMessage.style.width = `${newRect.width}px`;
                lastMessage.style.height = `${newRect.height}px`;

                // 绑定 cleanup
                const cleanup = () => {
                    lastMessage.style.width = '';
                    lastMessage.style.height = '';
                    lastMessage.style.transition = '';
                    lastMessage.style.overflow = '';
                    lastMessage.removeEventListener('transitionend', cleanup);
                    delete lastMessage._isTransitioning;
                    delete lastMessage._animCleanup;
                };

                lastMessage._animCleanup = cleanup;
                lastMessage.addEventListener('transitionend', cleanup);
            }

            return true;
        }
        return true; // 如果文本没有变长，也认为是成功的
    } else {
        // 创建新消息时也需要包含思考内容
        await appendMessage({
            text: {
                content: textContent,
                reasoning_content: reasoningContent,
                isSearchUsed: typeof text === 'object' ? text.isSearchUsed : false
            },
            sender: 'ai',
            chatContainer
        });
        return true;
    }
}

function isHttpImageUrl(url) {
    return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

async function getWebdavConfig(forceRefresh = false) {
    const now = Date.now();
    if (
        !forceRefresh &&
        webdavConfigCache.value &&
        (now - webdavConfigCache.timestamp) < WEBDAV_CONFIG_CACHE_TTL
    ) {
        return webdavConfigCache.value;
    }

    try {
        const result = await syncStorageAdapter.get(WEBDAV_CONFIG_KEY);
        webdavConfigCache.value = result?.[WEBDAV_CONFIG_KEY] || null;
        webdavConfigCache.timestamp = now;
        return webdavConfigCache.value;
    } catch (error) {
        console.warn('[Message] 读取 WebDAV 配置失败:', error);
        return null;
    }
}

function normalizeSyncPath(syncPath = '') {
    return syncPath.replace(/^\/+/, '').replace(/\/+$/, '');
}

function buildWebdavBaseUrl(webdavConfig) {
    const serverUrl = (webdavConfig?.serverUrl || '').replace(/\/+$/, '');
    const syncPath = normalizeSyncPath(webdavConfig?.syncPath || '');
    if (!serverUrl || !syncPath) {
        return '';
    }

    return `${serverUrl}/${syncPath}`;
}

async function fetchImageBlob(imageSource) {
    if (!isHttpImageUrl(imageSource)) {
        throw new Error('不支持的远端图片地址');
    }

    const webdavConfig = await getWebdavConfig();
    const baseUrl = buildWebdavBaseUrl(webdavConfig);

    if (webdavConfig?.enabled && baseUrl && imageSource.startsWith(`${baseUrl}/`) && webdavConfig.username) {
        const credentials = btoa(`${webdavConfig.username}:${webdavConfig.password || ''}`);
        const response = await fetch(imageSource, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'X-Requested-With': 'XMLHttpRequest'
            },
            credentials: 'omit'
        });

        if (!response.ok) {
            throw new Error(`拉取远端图片失败: HTTP ${response.status}`);
        }

        return await response.blob();
    }

    const response = await fetch(imageSource);
    if (!response.ok) {
        throw new Error(`拉取远端图片失败: HTTP ${response.status}`);
    }

    return await response.blob();
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('图片转码失败'));
        reader.readAsDataURL(blob);
    });
}

async function ensureMessageImageThumbnail(imageItem) {
    if (!imageItem || typeof imageItem !== 'object') {
        return '';
    }

    if (typeof imageItem.thumbnail === 'string' && imageItem.thumbnail) {
        return imageItem.thumbnail;
    }

    const imageSource = getImageItemSource(imageItem);
    if (!isHttpImageUrl(imageSource)) {
        return imageSource;
    }

    try {
        const blob = await fetchImageBlob(imageSource);
        const dataUrl = await blobToDataUrl(blob);
        const thumbnail = await createThumbnailImage(dataUrl);
        imageItem.thumbnail = thumbnail;

        if (chatManager?.saveChats) {
            await chatManager.saveChats();
        }

        return thumbnail;
    } catch (error) {
        console.warn('[Message] 生成远端图片缩图失败:', error);
        return imageSource;
    }
}

function getImageItemSource(imageItem) {
    if (!imageItem || typeof imageItem !== 'object') {
        return '';
    }

    return typeof imageItem.url === 'string' ? imageItem.url : '';
}

function getImageItemThumbnail(imageItem) {
    if (!imageItem || typeof imageItem !== 'object') {
        return '';
    }

    if (typeof imageItem.thumbnail === 'string' && imageItem.thumbnail) {
        return imageItem.thumbnail;
    }

    return getImageItemSource(imageItem);
}
