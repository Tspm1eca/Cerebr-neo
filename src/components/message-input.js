/**
 * 消息输入组件
 * 处理用户输入、粘贴、拖放图片等交互
 */

import { adjustTextareaHeight, createImageTag, showImagePreview, hideImagePreview, addImageToPreview, clearImagePreview, getPreviewImages, updatePreviewVisibility } from '../utils/ui.js';
import { handleImageDrop } from '../utils/image.js';

// 跟踪输入法状态
let isComposing = false;

function initAnimatedFakeCaret(messageInput) {
    if (!messageInput?.isConnected) return;
    if (messageInput.__cerebrFakeCaretInited) return;

    const shell = messageInput.closest?.('.message-input-shell');
    const caretEl = shell?.querySelector?.('.fake-caret');
    if (!shell || !caretEl) return;

    messageInput.__cerebrFakeCaretInited = true;
    shell.classList.add('fake-caret-enabled');

    let rafId = 0;
    let pendingForceScroll = false;

    const scheduleUpdate = (options) => {
        pendingForceScroll ||= options?.forceScrollIntoView;
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            update({ forceScrollIntoView: pendingForceScroll });
            pendingForceScroll = false;
        });
    };

    const update = ({ forceScrollIntoView } = {}) => {
        if (!messageInput?.isConnected) return;

        const focused = document.activeElement === messageInput;
        const selection = window.getSelection?.();
        if (!focused || !selection || selection.rangeCount === 0) {
            shell.classList.remove('fake-caret-visible');
            return;
        }

        const range = selection.getRangeAt(0);
        if (!range?.collapsed || !messageInput.contains(range.startContainer)) {
            shell.classList.remove('fake-caret-visible');
            return;
        }

        const shellRect = shell.getBoundingClientRect();
        const inputRect = messageInput.getBoundingClientRect();
        const style = window.getComputedStyle(messageInput);
        const paddingLeft = parseFloat(style.paddingLeft) || 0;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const paddingRight = parseFloat(style.paddingRight) || 0;
        const paddingBottom = parseFloat(style.paddingBottom) || 0;
        const fontSize = parseFloat(style.fontSize) || 14;
        const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.5;

        // 統一計算視窗邊界
        const viewport = {
            top: inputRect.top + paddingTop,
            bottom: inputRect.bottom - paddingBottom,
            left: inputRect.left + paddingLeft,
            right: inputRect.right - paddingRight
        };
        viewport.height = viewport.bottom - viewport.top;

        const getRangeRect = () => {
            try {
                const rects = range.getClientRects?.();
                if (rects && rects.length) return rects[rects.length - 1];
            } catch {
                // ignore
            }

            try {
                const rect = range.getBoundingClientRect?.();
                if (rect && (rect.width || rect.height)) return rect;
            } catch {
                // ignore
            }

            // 某些情况下（例如 Shift+Enter 创建空行）折叠 range 可能拿不到任何 rect，
            // 用“探针节点”临时测量 caret 的可视位置，避免假光标回到首行。
            try {
                if (isComposing) return null;

                const marker = document.createElement('span');
                marker.setAttribute('data-cerebr-caret-probe', '1');
                marker.style.cssText = [
                    'display:inline-block',
                    'width:0',
                    'padding:0',
                    'margin:0',
                    'border:0',
                    'overflow:hidden',
                    'pointer-events:none',
                    'user-select:none',
                    'vertical-align:baseline'
                ].join(';');
                marker.textContent = '\u200b';

                const probeRange = range.cloneRange();
                probeRange.collapse(true);
                probeRange.insertNode(marker);
                try {
                    return marker.getBoundingClientRect?.() || null;
                } finally {
                    marker.remove();
                }
            } catch {
                return null;
            }
        };

        const rect = getRangeRect();
        const isEmptyInput = (messageInput.textContent || '').replace(/[\u200b\u200c\u200d\uFEFF]/g, '').trim() === '' && !messageInput.querySelector?.('.image-tag');

        let viewportX;
        let viewportY;
        let caretH;
        let caretVisualH;
        let caretYOffset;

        if (isEmptyInput) {
            viewportX = viewport.left;
            viewportY = viewport.top;
            caretH = lineHeight;
        } else if (!rect || (!rect.width && !rect.height)) {
            shell.classList.remove('fake-caret-visible');
            return;
        } else {
            viewportX = rect.left;
            viewportY = rect.top;
            caretH = rect.height || lineHeight;
        }

        // 视觉上 caret 更贴近"字形高度"（通常略小于 font-size），避免看起来比文本更高。
        const approxGlyphHeight = Math.max(8, Math.round(fontSize * 1.12));
        caretVisualH = Math.max(8, Math.min(caretH, approxGlyphHeight));
        caretYOffset = Math.max(0, (caretH - caretVisualH) / 2);
        viewportY += caretYOffset;

        const caretTop = viewportY;
        const caretBottom = viewportY + caretVisualH;

        if (forceScrollIntoView && messageInput.scrollHeight > messageInput.clientHeight + 1) {
            const desiredMargin = Math.min(12, Math.max(4, Math.round(fontSize * 0.4)));
            const effectiveMargin = Math.max(0, Math.min(desiredMargin, (viewport.height - caretVisualH) / 2));

            const delta =
                caretTop < viewport.top + effectiveMargin ? caretTop - (viewport.top + effectiveMargin) :
                caretBottom > viewport.bottom - effectiveMargin ? caretBottom - (viewport.bottom - effectiveMargin) :
                0;

            if (Math.abs(delta) >= 1) {
                const prevScrollTop = messageInput.scrollTop;
                messageInput.scrollTop += delta;
                if (messageInput.scrollTop !== prevScrollTop) {
                    scheduleUpdate({ forceScrollIntoView: true });
                    return;
                }
            }
        }

        const viewportTolerance = 1;
        if (caretTop < viewport.top - viewportTolerance || caretBottom > viewport.bottom + viewportTolerance) {
            shell.classList.remove('fake-caret-visible');
            return;
        }

        const clampedViewportX = Math.max(viewport.left, Math.min(viewportX, viewport.right));
        const clampedViewportY = viewportY;

        const x = clampedViewportX - shellRect.left;
        const y = clampedViewportY - shellRect.top;

        caretEl.style.setProperty('--cerebr-fake-caret-x', `${x}px`);
        caretEl.style.setProperty('--cerebr-fake-caret-y', `${y}px`);
        caretEl.style.setProperty('--cerebr-fake-caret-h', `${caretVisualH}px`);

        shell.classList.add('fake-caret-visible');
    };

    document.addEventListener('selectionchange', scheduleUpdate);
    window.addEventListener('resize', scheduleUpdate);

    // 需要強制滾動光標到可視範圍的按鍵
    const navigationKeys = new Set([
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'Home', 'End', 'PageUp', 'PageDown'
    ]);

    // 批次註冊需要強制滾動的事件
    ['focus', 'input', 'mousedown', 'mouseup', 'compositionend'].forEach(event => {
        messageInput.addEventListener(event, () => scheduleUpdate({ forceScrollIntoView: true }));
    });

    // 鍵盤事件：根據按鍵類型決定是否強制滾動
    messageInput.addEventListener('keydown', (e) => {
        scheduleUpdate({ forceScrollIntoView: navigationKeys.has(e?.key) });
    });

    // 批次註冊被動更新事件（只更新光標位置，不強制滾動）
    ['blur', 'scroll', 'keyup', 'compositionstart'].forEach(event => {
        messageInput.addEventListener(event, scheduleUpdate);
    });

    scheduleUpdate();
}

/**
 * 初始化消息输入组件
 * @param {Object} config - 配置对象
 * @param {HTMLElement} config.messageInput - 消息输入框元素
 * @param {Function} config.sendMessage - 发送消息的回调函数
 * @param {Array} config.userQuestions - 用户问题历史数组
 * @param {Object} config.contextMenu - 上下文菜单对象
 * @param {Function} config.hideContextMenu - 隐藏上下文菜单的函数
 * @param {Object} config.uiConfig - UI配置对象
 * @param {HTMLElement} [config.settingsMenu] - 设置菜单元素（可选）
 * @param {HTMLElement} [config.webpageContentMenu] - 网页内容菜单元素（可选）
 */
export function initMessageInput(config) {
    const {
        messageInput,
        sendMessage,
        userQuestions,
        contextMenu,
        hideContextMenu,
        uiConfig,
        settingsMenu,
        webpageContentMenu // 接收二级菜单
    } = config;

    // 添加点击事件监听
    document.body.addEventListener('click', (e) => {
        // 如果有文本被选中，不要触发输入框聚焦
        if (window.getSelection().toString()) {
            return;
        }

        // 檢查點擊的是否是可聚焦的表單元素，避免搶走其他輸入框的焦點
        const isFocusableElement = e.target.matches(
            'input, select, textarea, [contenteditable="true"], button'
        ) || e.target.closest(
            'input, select, textarea, [contenteditable="true"]'
        );

        if (isFocusableElement) {
            return;  // 不干預其他可聚焦元素
        }

        // 排除点击设置按钮、设置菜单、上下文菜单、历史页面的情况
        if (!e.target.closest('#settings-button') &&
            !e.target.closest('#settings-menu') &&
            !e.target.closest('#context-menu') &&
            !e.target.closest('#chat-list-page') &&
            !e.target.closest('#quick-chat-settings-page') &&
            !e.target.closest('.message-edit-container')) {

            // 切换输入框焦点状态
            if (document.activeElement === messageInput) {
                messageInput.blur();
            } else {
                messageInput.focus();
            }
        }
    });

    // 获取 persistent-placeholder 元素
    const shell = messageInput.closest('.message-input-shell');
    const persistentPlaceholder = shell?.querySelector('.persistent-placeholder');

    // 更新 has-content 状态的函数
    const updateHasContentState = () => {
        // 过滤掉零宽空格等不可见字符
        const text = messageInput.textContent.replace(/[\u200b\u200c\u200d\uFEFF]/g, '').trim();
        // 检查输入框内的图片标签和预览区域的图片
        const previewImages = getPreviewImages();
        const hasContent = text !== '' || messageInput.querySelector('.image-tag') || previewImages.length > 0;
        if (shell) {
            if (hasContent) {
                shell.classList.add('has-content');
            } else {
                shell.classList.remove('has-content');
            }
        }
    };

    // 监听输入框变化
    messageInput.addEventListener('input', function() {
        adjustTextareaHeight({
            textarea: this,
            config: uiConfig.textarea
        });

        // 过滤掉零宽空格等不可见字符
        const text = this.textContent.replace(/[\u200b\u200c\u200d\uFEFF]/g, '').trim();
        const hasContent = text !== '' || this.querySelector('.image-tag');
        const inputContainer = document.getElementById('input-container');

        // 只有当输入框有内容时才展开 input-container
        if (hasContent && inputContainer && inputContainer.classList.contains('collapsed')) {
            inputContainer.classList.remove('collapsed');
        }

        // 更新 has-content 状态
        updateHasContentState();

        // 如果正在使用输入法，则不处理 placeholder
        if (isComposing) {
            return;
        }

        // 处理 placeholder 的显示
        if (!hasContent) {
            // 如果内容空且没有图片标签，清空内容以显示 placeholder
            while (this.firstChild) {
                this.removeChild(this.firstChild);
            }
            // 重置高度和 overflow，让 CSS min-height 生效，以便在收缩模式下正确缩小
            this.style.height = '';
            this.style.overflowY = '';
        }
    });

    // 监听输入框的焦点状态
    messageInput.addEventListener('focus', () => {
        // 输入框获得焦点时隐藏右键菜单
        if (hideContextMenu) {
            hideContextMenu({
                contextMenu,
                onMessageElementReset: () => {}
            });
        }

        // 如果存在设置菜单，则隐藏它
        if (settingsMenu) {
            settingsMenu.classList.remove('visible');
        }

        // 如果存在网页内容菜单，则隐藏它
        if (webpageContentMenu) {
            webpageContentMenu.classList.remove('visible');
        }

        // 输入框获得焦点时展开 input-container
        const inputContainer = document.getElementById('input-container');
        if (inputContainer) {
            inputContainer.classList.remove('collapsed');
        }

        // 输入框获得焦点，阻止事件冒泡
        messageInput.addEventListener('click', (e) => e.stopPropagation());
    });

    messageInput.addEventListener('blur', () => {
        // 输入框失去焦点时，移除点击事件监听
        messageInput.removeEventListener('click', (e) => e.stopPropagation());
    });

    // 处理换行和输入
    messageInput.addEventListener('compositionstart', () => {
        isComposing = true;
    });

    messageInput.addEventListener('compositionend', () => {
        isComposing = false;
    });

    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            if (isComposing) {
                // 如果正在使用输入法，不发送消息
                return;
            }
            e.preventDefault();
            // 过滤掉零宽空格等不可见字符
            const text = this.textContent.replace(/[\u200b\u200c\u200d\uFEFF]/g, '').trim();
            const previewImages = getPreviewImages();
            if (text || this.querySelector('.image-tag') || previewImages.length > 0) {  // 检查是否有文本或图片（包括预览区域）
                sendMessage();
            }
        } else if (e.key === 'Escape') {
            // 按 ESC 键时让输入框失去焦点
            messageInput.blur();
        } else if (e.key === 'ArrowUp' && e.target.textContent.replace(/[\u200b\u200c\u200d\uFEFF]/g, '').trim() === '') {
            // 处理输入框特定的键盘事件
            // 当按下向上键且输入框为空时
            e.preventDefault(); // 阻止默认行为

            // 如果有历史记录
            if (userQuestions.length > 0) {
                // 获取最后一个问题
                e.target.textContent = userQuestions[userQuestions.length - 1];
                // 触发入事件以调整高度
                e.target.dispatchEvent(new Event('input', { bubbles: true }));
                // 移动光标到末尾
                moveCaretToEnd(e.target);
            }
        } else if ((e.key === 'Backspace' || e.key === 'Delete')) {
            // 处理图片标签的删除
            const selection = window.getSelection();
            if (selection.rangeCount === 0) return;

            const range = selection.getRangeAt(0);
            const startContainer = range.startContainer;

            // 检查是否在图片标签旁边
            if (startContainer.nodeType === Node.TEXT_NODE && startContainer.textContent === '') {
                const previousSibling = startContainer.previousSibling;
                if (previousSibling && previousSibling.classList?.contains('image-tag')) {
                    e.preventDefault();
                    previousSibling.remove();

                    // 移除可能存在的多余换行
                    const brElements = messageInput.getElementsByTagName('br');
                    Array.from(brElements).forEach(br => {
                        if (!br.nextSibling || (br.nextSibling.nodeType === Node.TEXT_NODE && br.nextSibling.textContent.trim() === '')) {
                            br.remove();
                        }
                    });

                    // 触发输入事件以调整高度
                    messageInput.dispatchEvent(new Event('input'));
                }
            }
        }
    });

    // 粘贴事件处理
    messageInput.addEventListener('paste', async (e) => {
        e.preventDefault(); // 阻止默认粘贴行为

        const items = Array.from(e.clipboardData.items);
        const imageItem = items.find(item => item.type.startsWith('image/'));

        if (imageItem) {
            // 处理图片粘贴 - 使用新的预览区域
            const file = imageItem.getAsFile();
            const reader = new FileReader();

            reader.onload = async () => {
                const base64Data = reader.result;

                // 添加到预览区域
                addImageToPreview({
                    base64Data,
                    fileName: file.name,
                    onImageClick: (data) => {
                        showImagePreview({
                            base64Data: data,
                            config: uiConfig.imagePreview
                        });
                    },
                    onDelete: () => {
                        // 触发输入事件以更新状态
                        messageInput.dispatchEvent(new Event('input'));
                    }
                });

                // 展开 input-container
                const inputContainer = document.getElementById('input-container');
                if (inputContainer) {
                    inputContainer.classList.remove('collapsed');
                }

                // 触发输入事件以调整高度
                messageInput.dispatchEvent(new Event('input'));
            };

            reader.readAsDataURL(file);
        } else {
            // 处理文本粘贴
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
        }
    });

    // 拖放事件监听器
    messageInput.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    messageInput.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    messageInput.addEventListener('drop', (e) => {
        handleImageDrop(e, {
            messageInput,
            createImageTag,
            onImageClick: (base64Data) => {
                showImagePreview({
                    base64Data,
                    config: uiConfig.imagePreview
                });
            },
            onSuccess: () => {
                // 成功处理后的回调
            },
            onError: (error) => {
                console.error('处理拖放事件失败:', error);
            }
        });
    });

    // 初始化时同步一次，避免输入栏高度变化导致底部消息被遮挡
    initAnimatedFakeCaret(messageInput);

    // 初始化 has-content 状态
    updateHasContentState();
}

/**
 * 设置消息输入框的 placeholder
 * @param {Object} params - 参数对象
 * @param {HTMLElement} params.messageInput - 消息输入框元素
 * @param {string} params.placeholder - placeholder 文本
 * @param {number} [params.timeout] - 超时时间（可选），超时后恢复默认 placeholder
 */
export function setPlaceholder({ messageInput, placeholder, timeout }) {
    if (messageInput) {
        const originalPlaceholder = messageInput.getAttribute('data-original-placeholder') || '输入消息...';
        messageInput.setAttribute('placeholder', placeholder);
        if (timeout) {
            setTimeout(() => {
                messageInput.setAttribute('placeholder', originalPlaceholder);
            }, timeout);
        }
    }
}

/**
 * 更新输入框的永久 placeholder
 * @param {HTMLElement} messageInput - 消息输入框元素
 * @param {string} modelName - 当前模型的名称
 */
export function updatePermanentPlaceholder(messageInput, modelName) {
    if (messageInput) {
        const placeholder = `${modelName}`;
        messageInput.setAttribute('placeholder', placeholder);
        messageInput.setAttribute('data-original-placeholder', placeholder);

        // 同时更新 persistent-placeholder 元素
        const shell = messageInput.closest('.message-input-shell');
        const persistentPlaceholder = shell?.querySelector('.persistent-placeholder');
        if (persistentPlaceholder) {
            persistentPlaceholder.textContent = placeholder;
        }
    }
}

/**
 * 获取格式化后的消息内容（处理HTML转义和图片）
 * @param {HTMLElement} messageInput - 消息输入框元素
 * @returns {Object} 格式化后的内容和图片标签以及预览区域图片
 */
export function getFormattedMessageContent(messageInput) {
    // 使用innerHTML获取内容，并将<br>转换为\n
    let message = messageInput.innerHTML
        .replace(/<div><br><\/div>/g, '\n')  // 处理换行后的空行
        .replace(/<div>/g, '\n')             // 处理换行后的新行开始
        .replace(/<\/div>/g, '')             // 处理换行后的新行结束
        .replace(/<br\s*\/?>/g, '\n')        // 处理单个换行
        .replace(/&nbsp;/g, ' ');            // 处理空格

    // 将HTML实体转换回实际字符
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = message;
    message = tempDiv.textContent;

    // 获取输入框内的图片标签
    const imageTags = messageInput.querySelectorAll('.image-tag');

    // 获取预览区域的图片
    const previewImages = getPreviewImages();

    return { message, imageTags, previewImages };
}

/**
 * 构建消息内容对象（文本+图片）
 * @param {string} message - 消息文本
 * @param {NodeList} imageTags - 图片标签节点列表
 * @param {Array} [previewImages] - 预览区域的图片数组
 * @returns {string|Array} 格式化后的消息内容
 */
export function buildMessageContent(message, imageTags, previewImages = []) {
    const hasImages = imageTags.length > 0 || previewImages.length > 0;

    if (hasImages) {
        const content = [];
        if (message.trim()) {
            content.push({
                type: "text",
                text: message
            });
        }
        // 添加输入框内的图片
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
        // 添加预览区域的图片
        previewImages.forEach(img => {
            if (img.base64Data) {
                content.push({
                    type: "image_url",
                    image_url: {
                        url: img.base64Data
                    }
                });
            }
        });
        return content;
    } else {
        return message;
    }
}

/**
 * 清空输入框
 * @param {HTMLElement} messageInput - 消息输入框元素
 * @param {Object} config - UI配置
 */
export function clearMessageInput(messageInput, config) {
    messageInput.innerHTML = '';
    // 重置高度和 overflow
    messageInput.style.height = '';
    messageInput.style.overflowY = '';

    // 清空预览区域
    clearImagePreview();

    // 清空后移除 has-content 状态
    const shell = messageInput.closest('.message-input-shell');
    if (shell) {
        shell.classList.remove('has-content');
    }
}

/**
 * 将光标移动到元素末尾
 * @param {HTMLElement} element - 要操作的元素
 */
function moveCaretToEnd(element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

/**
 * 处理消息输入组件的窗口消息
 * @param {MessageEvent} event - 消息事件对象
 * @param {Object} config - 配置对象
 */
export function handleWindowMessage(event, config) {
    const { messageInput, newChatButton, uiConfig } = config;

    if (event.data.type === 'DROP_IMAGE') {
        const imageData = event.data.imageData;
        if (imageData && imageData.data) {
            // 确保base64数据格式正确
            const base64Data = imageData.data.startsWith('data:') ? imageData.data : `data:image/png;base64,${imageData.data}`;

            // 使用新的预览区域显示图片
            addImageToPreview({
                base64Data: base64Data,
                fileName: imageData.name,
                onImageClick: (data) => {
                    showImagePreview({
                        base64Data: data,
                        config: uiConfig.imagePreview
                    });
                },
                onDelete: () => {
                    // 触发输入事件以更新状态
                    messageInput.dispatchEvent(new Event('input'));
                }
            });

            // 展开 input-container
            const inputContainer = document.getElementById('input-container');
            if (inputContainer) {
                inputContainer.classList.remove('collapsed');
            }

            // 确保输入框有焦点
            messageInput.focus();

            // 触发输入事件以调整高度
            messageInput.dispatchEvent(new Event('input'));
        }
    } else if (event.data.type === 'FOCUS_INPUT') {
        messageInput.focus();
        const range = document.createRange();
        range.selectNodeContents(messageInput);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    } else if (event.data.type === 'UPDATE_PLACEHOLDER') {
        setPlaceholder({
            messageInput,
            placeholder: event.data.placeholder,
            timeout: event.data.timeout
        });
    } else if (event.data.type === 'NEW_CHAT') {
        // 模拟点击新对话按钮
        newChatButton.click();
        messageInput.focus();
    }
}