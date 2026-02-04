/**
 * 输入框配置接口
 * @typedef {Object} TextareaConfig
 * @property {number} maxHeight - 输入框最大高度
 */

/**
 * 图片预览配置接口
 * @property {HTMLElement} previewModal - 预览模态框元素
 * @property {HTMLElement} previewImage - 预览图片元素
 */

/**
 * 图片标签配置接口
 * @typedef {Object} ImageTagConfig
 * @property {function} onImageClick - 图片点击回调
 * @property {function} onDeleteClick - 删除按钮点击回调
 */

/**
 * 调整输入框高度
 * @param {Object} params - 参数对象
 * @param {HTMLElement} params.textarea - 输入框元素
 * @param {TextareaConfig} params.config - 输入框配置
 */
export function adjustTextareaHeight({
    textarea,
    config = { maxHeight: 200 }
}) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, config.maxHeight) + 'px';
    if (textarea.scrollHeight > config.maxHeight) {
        textarea.style.overflowY = 'auto';
    } else {
        textarea.style.overflowY = 'hidden';
    }
}

/**
 * 显示图片预览
 * @param {Object} params - 参数对象
 * @param {string} params.base64Data - 图片base64数据
 * @param {HTMLElement} [params.sourceElement] - 來源元素（用於動畫起始位置）
 */
export function showImagePreview({
    base64Data,
    config,
    sourceElement
}) {
    const { previewModal, previewImage } = config;
    const previewContent = previewModal.querySelector('.image-preview-content');

    // 設置圖片來源
    previewImage.src = base64Data;

    if (sourceElement && previewContent) {
        // 獲取來源元素的位置
        const sourceRect = sourceElement.getBoundingClientRect();
        const sourceCenterX = sourceRect.left + sourceRect.width / 2;
        const sourceCenterY = sourceRect.top + sourceRect.height / 2;

        // 計算視窗中心
        const viewportCenterX = window.innerWidth / 2;
        const viewportCenterY = window.innerHeight / 2;

        // 計算偏移量
        const translateX = sourceCenterX - viewportCenterX;
        const translateY = sourceCenterY - viewportCenterY;

        // 計算縮放比例（基於來源元素大小）
        const scale = Math.min(sourceRect.width, sourceRect.height) / 300;

        // 設置初始變換（從來源位置開始）
        previewContent.style.transition = 'none';
        previewContent.style.transform = `translate(${translateX}px, ${translateY}px) scale(${Math.max(scale, 0.1)})`;
        previewContent.style.opacity = '0';

        // 強制重繪
        previewContent.offsetHeight;

        // 添加動畫類
        previewModal.classList.add('animating-from-source');

        // 啟用過渡並移動到最終位置
        previewContent.style.transition = '';
        previewContent.style.transform = 'translate(0, 0) scale(1)';
        previewContent.style.opacity = '1';

        // 顯示模態框
        previewModal.classList.add('visible');

        // 動畫結束後清理
        const cleanup = () => {
            previewModal.classList.remove('animating-from-source');
            previewContent.style.transform = '';
            previewContent.style.opacity = '';
            previewContent.removeEventListener('transitionend', cleanup);
        };
        previewContent.addEventListener('transitionend', cleanup);
    } else {
        // 沒有來源元素時，使用預設動畫
        previewModal.classList.add('visible');
    }
}

/**
 * 隐藏图片预览
 * @param {Object} params - 参数对象
 */
export function hideImagePreview({
    config
}) {
    config.previewModal.classList.remove('visible');
    config.previewImage.src = '';
}

/**
 * 创建图片标签
 * @param {Object} params - 参数对象
 * @param {string} params.base64Data - 图片base64数据
 * @param {string} [params.fileName] - 文件名（可选）
 * @param {ImageTagConfig} params.config - 图片标签配置
 * @returns {HTMLElement} 创建的图片标签元素
 */
export function createImageTag({
    base64Data,
    fileName = '图片',
    config
}) {
    const container = document.createElement('span');
    container.className = 'image-tag';
    container.contentEditable = false;
    container.setAttribute('data-image', base64Data);
    container.title = fileName;

    const thumbnail = document.createElement('img');
    thumbnail.src = base64Data.startsWith('data:') ? base64Data : `data:image/png;base64,${base64Data}`;
    thumbnail.alt = fileName;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-linecap="round"/></svg>';
    deleteBtn.title = '删除图片';

    // 点击删除按钮时删除整个标签
    deleteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (config.onDeleteClick) {
            config.onDeleteClick(container);
        }
    });

    container.appendChild(thumbnail);
    container.appendChild(deleteBtn);

    // 点击图片区域预览图片
    thumbnail.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (config.onImageClick) {
            config.onImageClick(base64Data, thumbnail);
        }
    });

    return container;
}

/**
 * 在输入框上方的预览区域添加图片
 * @param {Object} params - 参数对象
 * @param {string} params.base64Data - 图片base64数据
 * @param {string} [params.fileName] - 文件名（可选）
 * @param {Function} [params.onImageClick] - 图片点击回调
 * @param {Function} [params.onDelete] - 删除回调
 */
export function addImageToPreview({
    base64Data,
    fileName = '图片',
    onImageClick,
    onDelete
}) {
    const previewContainer = document.getElementById('input-image-preview');
    const chatContainer = document.getElementById('chat-container');
    if (!previewContainer) return null;

    const item = document.createElement('div');
    item.className = 'preview-image-item';
    item.setAttribute('data-image', base64Data);
    // 不設置 title，避免 hover 時顯示 tooltip

    const img = document.createElement('img');
    img.src = base64Data.startsWith('data:') ? base64Data : `data:image/png;base64,${base64Data}`;
    img.alt = fileName;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'preview-delete-btn';
    deleteBtn.innerHTML = '';
    deleteBtn.title = '删除图片';

    // 点击图片预览
    img.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onImageClick) {
            onImageClick(base64Data, img);
        }
    });

    // 点击删除按钮
    deleteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.remove();
        updatePreviewVisibility();
        if (onDelete) {
            onDelete();
        }
    });

    item.appendChild(img);
    item.appendChild(deleteBtn);
    previewContainer.appendChild(item);

    // 更新预览区域可见性
    updatePreviewVisibility();

    return item;
}

/**
 * 更新图片预览区域的可见性
 */
export function updatePreviewVisibility() {
    const previewContainer = document.getElementById('input-image-preview');
    const chatContainer = document.getElementById('chat-container');
    if (!previewContainer) return;

    const hasImages = previewContainer.children.length > 0;

    if (hasImages) {
        previewContainer.classList.add('has-images');
        if (chatContainer) {
            chatContainer.classList.add('has-image-preview');
        }

        // 當圖片預覽區域顯示時，隱藏快速選項
        // 動態導入以避免循環依賴
        import('../components/quick-chat.js').then(({ toggleQuickChatOptions }) => {
            toggleQuickChatOptions(false);
        });
    } else {
        previewContainer.classList.remove('has-images');
        if (chatContainer) {
            chatContainer.classList.remove('has-image-preview');
        }
    }
}

/**
 * 清空图片预览区域
 */
export function clearImagePreview() {
    const previewContainer = document.getElementById('input-image-preview');
    if (previewContainer) {
        previewContainer.innerHTML = '';
        updatePreviewVisibility();
    }
}

/**
 * 获取预览区域中的所有图片数据
 * @returns {Array} 图片数据数组
 */
export function getPreviewImages() {
    const previewContainer = document.getElementById('input-image-preview');
    if (!previewContainer) return [];

    const items = previewContainer.querySelectorAll('.preview-image-item');
    return Array.from(items).map(item => ({
        base64Data: item.getAttribute('data-image'),
        fileName: item.title
    }));
}

/**
 * 從 chatManager 中移除指定圖片
 * @param {Object} params - 參數對象
 * @param {Object} params.chatManager - 聊天管理器實例
 * @param {number} params.messageIndex - 消息在聊天記錄中的索引
 * @param {string} params.base64Data - 要移除的圖片 base64 數據
 */
export function removeImageFromChatManager({ chatManager, messageIndex, base64Data }) {
    const currentChat = chatManager.getCurrentChat();
    if (!currentChat || messageIndex === -1 || !currentChat.messages[messageIndex]) {
        return;
    }

    const message = currentChat.messages[messageIndex];
    if (!Array.isArray(message.content)) {
        return;
    }

    const imageIndex = message.content.findIndex(
        item => item.type === 'image_url' && item.image_url.url === base64Data
    );

    if (imageIndex !== -1) {
        message.content.splice(imageIndex, 1);

        // 如果只剩下文字，將內容轉換為字符串格式
        if (message.content.length === 1 && message.content[0].type === 'text') {
            message.content = message.content[0].text;
        }

        chatManager.saveChats();
    }
}

/**
 * 為圖片容器中的圖片標籤綁定事件（點擊預覽和刪除）
 * @param {Object} params - 參數對象
 * @param {HTMLElement} params.imagesContainer - 圖片容器元素
 * @param {HTMLElement} params.messageElement - 消息元素
 * @param {number} params.messageIndex - 消息在聊天記錄中的索引
 * @param {Object} params.chatManager - 聊天管理器實例
 */
export function bindImageTagEvents({
    imagesContainer,
    messageElement,
    messageIndex,
    chatManager
}) {
    const previewModal = document.querySelector('.image-preview-modal');
    const previewImage = previewModal.querySelector('img');

    imagesContainer.querySelectorAll('.image-tag').forEach(tag => {
        const img = tag.querySelector('img');
        const deleteBtn = tag.querySelector('.delete-btn');
        const base64Data = tag.getAttribute('data-image');

        // 綁定圖片點擊預覽事件
        if (img && base64Data) {
            img.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                showImagePreview({
                    base64Data,
                    config: { previewModal, previewImage },
                    sourceElement: img
                });
            });
        }

        // 綁定刪除按鈕事件
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();

                // 從 DOM 中移除圖片標籤
                tag.remove();

                // 如果圖片容器中沒有圖片了，移除容器並更新樣式
                if (imagesContainer.querySelectorAll('.image-tag').length === 0) {
                    imagesContainer.remove();
                    messageElement.classList.remove('has-images');
                }

                // 更新 chatManager 中的消息內容
                removeImageFromChatManager({
                    chatManager,
                    messageIndex,
                    base64Data
                });
            });
        }
    });
}