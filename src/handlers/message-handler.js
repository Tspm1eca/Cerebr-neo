import { chatManager } from '../utils/chat-manager.js';
import { showImagePreview, createImageTag, removeImageFromChatManager, applyImageTagThumbnail } from '../utils/ui.js';
import { createThumbnailImage } from '../utils/image.js';
import { isHttpImageUrl, blobToDataUrl } from '../utils/url.js';
import { processMathAndMarkdown, renderMathInElement, textMayContainMath } from '../../htmd/latex.js';
import { extractCitationText, isCitationLink } from '../../htmd/citation.js';
import { isTimestampLink } from '../../htmd/timestamp.js';
import { storageAdapter } from '../utils/storage-adapter.js';

const YT_WATCH_RE = /^https?:\/\/(www\.)?youtube\.com\/watch/;

function isYouTubeChat() {
    const chat = chatManager.getCurrentChat();
    return chat?.webpageUrls?.some(url => YT_WATCH_RE.test(url)) ?? false;
}

// 氣泡拉伸動畫參數（欠阻尼彈簧 F = -k*x - c*v, ζ = c/(2√k)）
const SPRING = {
    STIFFNESS: 180,
    DAMPING_H: 24,   // ζ ≈ 0.89，高度帶含蓄彈性
    DAMPING_W: 21,   // ζ ≈ 0.78，寬度帶可感知的彈性過衝
    MIN_STRETCH_H: 24,
    MIN_STRETCH_W: 36,
    MIN_SIZE: 8,
    KICK: 5,
};

// 縮圖持久化快取（啟動時從 storage 載入，新增時 debounce 寫回）
const _thumbnailCache = new Map();
const THUMBNAIL_CACHE_MAX = 200;
const THUMBNAIL_PERSIST_MAX = 50; // 持久化上限（每筆 data URL 約 2-5KB）
const THUMBNAIL_STORAGE_KEY = '_thumbnail_cache';
let _thumbnailPersistTimer = null;
// 正在生成中的縮圖 promise（防止同一張圖片並發 fetch）
const _thumbnailInflight = new Map();

/**
 * 從 storage 載入持久化的縮圖快取（啟動時呼叫一次）
 */
export async function loadThumbnailCache() {
    try {
        const result = await storageAdapter.get(THUMBNAIL_STORAGE_KEY);
        const stored = result[THUMBNAIL_STORAGE_KEY];
        if (stored && typeof stored === 'object') {
            for (const [key, value] of Object.entries(stored)) {
                _thumbnailCache.set(key, value);
            }
        }
    } catch (e) {
        // 載入失敗不影響功能，快取會在使用時重新建立
    }
}

/**
 * 將縮圖快取 debounce 寫入 storage（只保留最近 THUMBNAIL_PERSIST_MAX 筆）
 */
function persistThumbnailCache() {
    clearTimeout(_thumbnailPersistTimer);
    _thumbnailPersistTimer = setTimeout(() => {
        // 只持久化最近的 N 筆（Map 保持插入順序，取最後 N 筆）
        const entries = [..._thumbnailCache.entries()];
        const toStore = entries.slice(-THUMBNAIL_PERSIST_MAX);
        storageAdapter.set({ [THUMBNAIL_STORAGE_KEY]: Object.fromEntries(toStore) }).catch(() => {});
    }, 2000);
}

/** 快取元素的 padding + border 額外空間（border-box → content-box 轉換） */
function ensureBoxExtra(el) {
    if (!el._boxExtra) {
        const cs = getComputedStyle(el);
        el._boxExtra = {
            h: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
               parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth),
            w: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
               parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
        };
    }
    return el._boxExtra;
}

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
        } else if (isTimestampLink(href)) {
            link.classList.add('timestamp-link');
            link.title = `跳轉到 ${link.textContent}`;
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

    // YouTube 字幕模式標記（用於紫色光暈）
    if (sender === 'ai' && isYouTubeChat()) {
        messageDiv.classList.add('youtube-chat');
    }

    // 处理文本内容
    let textContent = typeof text === 'string' ? text : text.content;

    const previewModal = document.querySelector('.image-preview-modal');
    const previewImage = previewModal.querySelector('img');

    let messageHtml = '';
    const imageTags = [];
    if (Array.isArray(textContent)) {
        for (const item of textContent) {
            if (item.type === "text") {
                messageHtml += item.text;
                textContent = item.text;
            } else if (item.type === "image_url") {
                const imageSource = getImageItemSource(item.image_url);
                const cachedThumbnail = _thumbnailCache.get(imageSource);
                const shouldGenerateThumbnail = !cachedThumbnail && isHttpImageUrl(imageSource);
                const thumbnailSource = cachedThumbnail || (shouldGenerateThumbnail ? '' : imageSource);
                const imageTag = createImageTag({
                    imageSource,
                    thumbnailSource,
                    isThumbnailLoading: shouldGenerateThumbnail
                });

                if (shouldGenerateThumbnail) {
                    void ensureMessageImageThumbnail(item.image_url).then((generatedThumbnailSource) => {
                        applyImageTagThumbnail(imageTag, generatedThumbnailSource);
                        const generatedImg = imageTag.querySelector('img');
                        if (generatedImg) {
                            preloadAndCacheImage(generatedImg);
                        }
                    });
                }

                imageTags.push(imageTag);
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
        reasoningTextDiv.innerHTML = processMathAndMarkdown(reasoningContent, { timestamps: isYouTubeChat() }).trim();
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
    if (imageTags.length > 0 && sender === 'user') {
        const imagesContainer = document.createElement('div');
        imagesContainer.className = 'message-images';
        imageTags.forEach(tag => imagesContainer.appendChild(tag));
        messageDiv.appendChild(imagesContainer);
        // 添加 has-images class 以便文字右對齊
        messageDiv.classList.add('has-images');
    }

    // 添加主要内容
    const mainContent = document.createElement('div');
    mainContent.className = 'main-content';
    mainContent.innerHTML = processMathAndMarkdown(messageHtml, { timestamps: isYouTubeChat() });
    messageDiv.appendChild(mainContent);

    // 如果是 AI 消息且有圖片，圖片放在文字下方
    if (imageTags.length > 0 && sender === 'ai') {
        const imagesContainer = document.createElement('div');
        imagesContainer.className = 'message-images';
        imageTags.forEach(tag => imagesContainer.appendChild(tag));
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
    const { isSearchUsed = false, isYouTube = false } = options;

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message ai-message waiting';

    // YouTube 字幕模式標記（用於紫色光暈）
    if (isYouTube || isYouTubeChat()) {
        messageDiv.classList.add('youtube-chat');
    }

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
        // 若在等待氣泡建立後才確定是 YouTube 模式，補上樣式標記
        if (isYouTubeChat() && !waitingMessage.classList.contains('youtube-chat')) {
            waitingMessage.classList.add('youtube-chat');
        }

        // 動畫處理：記錄原始尺寸並鎖定，防止 content swap 時閃跳
        const rect = waitingMessage.getBoundingClientRect();
        waitingMessage._waitingHeight = rect.height;
        waitingMessage._waitingWidth = rect.width;

        // 鎖定起始尺寸（content-box），防止移除 waiting 類和 dots 時尺寸跳變
        const bx = ensureBoxExtra(waitingMessage);
        waitingMessage.style.width = `${rect.width - bx.w}px`;
        waitingMessage.style.height = `${rect.height - bx.h}px`;
        waitingMessage.style.overflow = 'hidden';

        // 檢查是否使用了搜索並更新樣式（在等待訊息轉換前就添加）
        if (typeof text === 'object' && text.isSearchUsed) {
            if (!waitingMessage.classList.contains('search-used')) {
                waitingMessage.classList.add('search-used');
            }
        }

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

    }

    // 優先尋找正在更新中的 AI 消息
    let lastMessage = chatContainer.querySelector('.ai-message.updating');
    const currentText = lastMessage ? lastMessage.getAttribute('data-original-text') || '' : '';

    // 如果没有找到 updating 消息，但有 waiting 消息，则使用 waiting 消息
    // 这处理了从 waiting 状态直接转换的情况，确保不会创建重复消息
    if (!lastMessage && waitingMessage) {
        lastMessage = waitingMessage;
        // 記錄等待氣泡尺寸（若主路徑未記錄）
        if (!lastMessage._waitingHeight) {
            const rect = lastMessage.getBoundingClientRect();
            lastMessage._waitingHeight = rect.height;
            lastMessage._waitingWidth = rect.width;
        }
        ensureBoxExtra(lastMessage);
        if (!lastMessage.classList.contains('updating')) {
            lastMessage.classList.add('updating');
        }
        lastMessage.classList.remove('waiting');
        const dots = lastMessage.querySelector('.thinking-dots');
        if (dots) dots.remove();
    }

    if (lastMessage) {
        if (isYouTubeChat() && !lastMessage.classList.contains('youtube-chat')) {
            lastMessage.classList.add('youtube-chat');
        }

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

            // 記錄更新前的氣泡尺寸，用於平滑拉伸動畫
            // 優先使用等待氣泡的原始尺寸（dots 移除前），確保從三點動畫平滑過渡
            const bx = ensureBoxExtra(lastMessage);
            const prevBubbleHeight = (lastMessage._waitingHeight || lastMessage.getBoundingClientRect().height) - bx.h;
            const prevBubbleWidth = (lastMessage._waitingWidth || lastMessage.getBoundingClientRect().width) - bx.w;
            delete lastMessage._waitingHeight;
            delete lastMessage._waitingWidth;

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
                reasoningTextDiv.innerHTML = processMathAndMarkdown(reasoningContent, { timestamps: isYouTubeChat() }).trim();
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
            mainContent.innerHTML = processMathAndMarkdown(textContent, { timestamps: isYouTubeChat() });

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

            // 平滑拉伸動畫：使用 requestAnimationFrame + 欠阻尼彈簧（underdamped spring）
            // 高度 ζ≈0.89 含蓄彈性；寬度 ζ≈0.78 可感知的彈性過衝
            lastMessage.style.width = '';
            lastMessage.style.height = 'auto';
            lastMessage.style.overflow = '';
            const targetHeight = lastMessage.offsetHeight - lastMessage._boxExtra.h;
            const targetWidth = lastMessage.offsetWidth - lastMessage._boxExtra.w;

            if (!lastMessage._sizeAnim) {
                // 等待→內容的初始過渡：確保最小拉伸距離，避免尺寸相近時動畫不可見
                // dots 氣泡 (~68×40) 和首個 chunk (~68×41) 幾乎同尺寸，
                // 需要人為拉開起始位置，製造「壓縮→彈開」的視覺張力
                const startH = (targetHeight - prevBubbleHeight) < SPRING.MIN_STRETCH_H
                    ? Math.max(targetHeight - SPRING.MIN_STRETCH_H, SPRING.MIN_SIZE)
                    : prevBubbleHeight;
                const startW = (targetWidth - prevBubbleWidth) < SPRING.MIN_STRETCH_W
                    ? Math.max(targetWidth - SPRING.MIN_STRETCH_W, SPRING.MIN_SIZE)
                    : prevBubbleWidth;

                lastMessage._sizeAnim = {
                    currentH: startH,
                    currentW: startW,
                    targetH: targetHeight,
                    targetW: targetWidth,
                    velocityH: (targetHeight - startH) * SPRING.KICK,
                    velocityW: (targetWidth - startW) * SPRING.KICK,
                    rafId: 0,
                    lastTime: 0
                };
            }
            const anim = lastMessage._sizeAnim;
            anim.targetH = targetHeight;
            anim.targetW = targetWidth;
            lastMessage.style.height = `${Math.round(anim.currentH)}px`;
            lastMessage.style.width = `${Math.round(anim.currentW)}px`;
            lastMessage.style.overflow = 'hidden';

            if (!anim.rafId) {
                const tick = (timestamp) => {
                    if (!anim.lastTime) anim.lastTime = timestamp;
                    const dt = Math.min((timestamp - anim.lastTime) / 1000, 0.04);
                    anim.lastTime = timestamp;

                    const diffH = anim.targetH - anim.currentH;
                    const diffW = anim.targetW - anim.currentW;
                    if (Math.abs(diffH) < 0.5 && Math.abs(anim.velocityH) < 0.5 &&
                        Math.abs(diffW) < 0.5 && Math.abs(anim.velocityW) < 0.5) {
                        anim.currentH = anim.targetH;
                        anim.currentW = anim.targetW;
                        lastMessage.style.height = '';
                        lastMessage.style.width = '';
                        lastMessage.style.overflow = '';
                        anim.rafId = 0;
                        anim.lastTime = 0;
                        return;
                    }

                    // Height — 輕微欠阻尼，含蓄彈性
                    const accH = -SPRING.STIFFNESS * (anim.currentH - anim.targetH) - SPRING.DAMPING_H * anim.velocityH;
                    anim.velocityH += accH * dt;
                    anim.currentH += anim.velocityH * dt;

                    // Width — 欠阻尼，可感知的彈性展開
                    const accW = -SPRING.STIFFNESS * (anim.currentW - anim.targetW) - SPRING.DAMPING_W * anim.velocityW;
                    anim.velocityW += accW * dt;
                    anim.currentW += anim.velocityW * dt;

                    lastMessage.style.height = `${Math.round(anim.currentH)}px`;
                    lastMessage.style.width = `${Math.round(anim.currentW)}px`;
                    anim.rafId = requestAnimationFrame(tick);
                };
                anim.rafId = requestAnimationFrame(tick);
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

async function fetchImageBlob(imageSource) {
    if (!isHttpImageUrl(imageSource)) {
        throw new Error('不支持的远端图片地址');
    }

    const response = await fetch(imageSource);
    if (!response.ok) {
        throw new Error(`拉取远端图片失败: HTTP ${response.status}`);
    }

    return await response.blob();
}

async function ensureMessageImageThumbnail(imageItem) {
    const imageSource = getImageItemSource(imageItem);
    if (!imageSource) return '';

    // 檢查記憶體快取
    if (_thumbnailCache.has(imageSource)) {
        return _thumbnailCache.get(imageSource);
    }

    if (!isHttpImageUrl(imageSource)) {
        return imageSource;
    }

    // 同一張圖片正在生成中，直接等待既有 promise
    if (_thumbnailInflight.has(imageSource)) {
        return _thumbnailInflight.get(imageSource);
    }

    const promise = (async () => {
        try {
            const blob = await fetchImageBlob(imageSource);
            const dataUrl = await blobToDataUrl(blob);
            const thumbnail = await createThumbnailImage(dataUrl);
            // 快取淘汰：超過上限時刪除最早的 entry
            if (_thumbnailCache.size >= THUMBNAIL_CACHE_MAX) {
                const firstKey = _thumbnailCache.keys().next().value;
                _thumbnailCache.delete(firstKey);
            }
            _thumbnailCache.set(imageSource, thumbnail);
            persistThumbnailCache();
            return thumbnail;
        } catch (error) {
            console.warn('[Message] 生成远端图片缩图失败:', error);
            return imageSource;
        } finally {
            _thumbnailInflight.delete(imageSource);
        }
    })();

    _thumbnailInflight.set(imageSource, promise);
    return promise;
}

function getImageItemSource(imageItem) {
    if (!imageItem || typeof imageItem !== 'object') {
        return '';
    }

    return typeof imageItem.url === 'string' ? imageItem.url : '';
}

