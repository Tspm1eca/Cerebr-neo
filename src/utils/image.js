import { addImageToPreview } from './ui.js';

/**
 * 圖片壓縮配置
 */
const COMPRESSION_CONFIG = {
    maxWidth: 1024,      // 最大寬度
    maxHeight: 1024,     // 最大高度
    quality: 0.8,        // 圖片質量 (0-1)
    maxSizeKB: 200,      // 目標最大大小 (KB)
    preferWebP: true     // 優先使用 WebP 格式
};

/**
 * 檢測瀏覽器是否支持 WebP 格式
 * @returns {boolean} 是否支持 WebP
 */
function isWebPSupported() {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    return canvas.toDataURL('image/webp').startsWith('data:image/webp');
}

// 緩存 WebP 支持檢測結果
let webPSupported = null;

/**
 * 壓縮圖片
 * @param {string} base64Data - 原始圖片的 base64 數據
 * @param {Object} [options] - 壓縮選項
 * @param {number} [options.maxWidth=1024] - 最大寬度
 * @param {number} [options.maxHeight=1024] - 最大高度
 * @param {number} [options.quality=0.8] - 圖片質量 (0-1)
 * @param {number} [options.maxSizeKB=200] - 目標最大大小 (KB)
 * @param {boolean} [options.preferWebP=true] - 優先使用 WebP 格式
 * @returns {Promise<string>} 壓縮後的 base64 數據
 */
export async function compressImage(base64Data, options = {}) {
    const config = { ...COMPRESSION_CONFIG, ...options };

    // 檢測 WebP 支持（只檢測一次）
    if (webPSupported === null) {
        webPSupported = isWebPSupported();
        console.log(`WebP 格式支持: ${webPSupported ? '是' : '否'}`);
    }

    // 決定使用的格式
    const useWebP = config.preferWebP && webPSupported;
    const format = useWebP ? 'image/webp' : 'image/jpeg';
    const formatName = useWebP ? 'WebP' : 'JPEG';

    return new Promise((resolve, reject) => {
        const img = new Image();

        img.onload = () => {
            try {
                // 計算新尺寸，保持比例
                let { width, height } = img;

                if (width > config.maxWidth || height > config.maxHeight) {
                    const ratio = Math.min(
                        config.maxWidth / width,
                        config.maxHeight / height
                    );
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                }

                // 創建 canvas 進行壓縮
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // 嘗試不同質量級別以達到目標大小
                let quality = config.quality;
                let compressedData = canvas.toDataURL(format, quality);

                // 如果圖片仍然太大，逐步降低質量
                const targetSizeBytes = config.maxSizeKB * 1024;
                while (compressedData.length > targetSizeBytes && quality > 0.1) {
                    quality -= 0.1;
                    compressedData = canvas.toDataURL(format, quality);
                }

                // 如果使用 WebP 但結果不理想，嘗試 JPEG 作為備選
                if (useWebP && compressedData.length > targetSizeBytes) {
                    let jpegQuality = config.quality;
                    let jpegData = canvas.toDataURL('image/jpeg', jpegQuality);
                    while (jpegData.length > targetSizeBytes && jpegQuality > 0.1) {
                        jpegQuality -= 0.1;
                        jpegData = canvas.toDataURL('image/jpeg', jpegQuality);
                    }
                    // 如果 JPEG 更小，使用 JPEG
                    if (jpegData.length < compressedData.length) {
                        compressedData = jpegData;
                        console.log('WebP 壓縮效果不佳，改用 JPEG');
                    }
                }

                // 如果壓縮後比原始更大，返回原始數據
                if (compressedData.length >= base64Data.length) {
                    console.log('壓縮後大小未減少，使用原始圖片');
                    resolve(base64Data);
                    return;
                }

                const originalSizeKB = Math.round(base64Data.length / 1024);
                const compressedSizeKB = Math.round(compressedData.length / 1024);
                const compressionRatio = Math.round((1 - compressedData.length / base64Data.length) * 100);
                const finalFormat = compressedData.startsWith('data:image/webp') ? 'WebP' : 'JPEG';

                console.log(`圖片壓縮完成 (${finalFormat}): ${originalSizeKB}KB → ${compressedSizeKB}KB (減少 ${compressionRatio}%)`);

                resolve(compressedData);
            } catch (error) {
                console.error('圖片壓縮失敗:', error);
                // 壓縮失敗時返回原始數據
                resolve(base64Data);
            }
        };

        img.onerror = () => {
            console.error('圖片加載失敗');
            // 加載失敗時返回原始數據
            resolve(base64Data);
        };

        img.src = base64Data;
    });
}

/**
 * 处理图片拖放的通用函数
 * @param {DragEvent} e - 拖放事件对象
 * @param {Object} config - 配置对象
 * @param {HTMLElement} config.messageInput - 消息输入框元素
 * @param {Function} config.createImageTag - 创建图片标签的函数（保留兼容性）
 * @param {Function} config.onSuccess - 成功处理后的回调函数
 * @param {Function} config.onError - 错误处理的回调函数
 * @param {Function} [config.onImageClick] - 图片点击回调
 */
export function handleImageDrop(e, config) {
    const {
        messageInput,
        createImageTag,
        onSuccess = () => {},
        onError = (error) => console.error('处理拖放事件失败:', error),
        onImageClick
    } = config;

    e.preventDefault();
    e.stopPropagation();

    try {
        // 处理文件拖放
        if (e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = async () => {
                    try {
                        // 壓縮圖片
                        const compressedData = await compressImage(reader.result);

                        // 使用新的预览区域显示图片
                        addImageToPreview({
                            base64Data: compressedData,
                            fileName: file.name,
                            onImageClick,
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
                        // 聚焦输入框
                        messageInput.focus();
                        onSuccess();
                    } catch (error) {
                        onError(error);
                    }
                };
                reader.readAsDataURL(file);
                return;
            }
        }

        // 处理网页图片拖放
        const data = e.dataTransfer.getData('text/plain');
        if (data) {
            // 使用 async IIFE 來處理異步操作
            (async () => {
                try {
                    const imageData = JSON.parse(data);
                    if (imageData.type === 'image') {
                        // 壓縮圖片
                        const compressedData = await compressImage(imageData.data);

                        // 使用新的预览区域显示图片
                        addImageToPreview({
                            base64Data: compressedData,
                            fileName: imageData.name,
                            onImageClick,
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
                        // 聚焦输入框
                        messageInput.focus();
                        onSuccess();
                    }
                } catch (error) {
                    onError(error);
                }
            })();
        }
    } catch (error) {
        onError(error);
    }
}

/**
 * 在输入框中插入图片（保留用于粘贴功能）
 * @param {Object} params - 参数对象
 * @param {HTMLElement} params.messageInput - 消息输入框元素
 * @param {Function} params.createImageTag - 创建图片标签的函数
 * @param {Object} params.imageData - 图片数据
 * @param {string} params.imageData.base64Data - 图片的base64数据
 * @param {string} params.imageData.fileName - 图片文件名
 */
export function insertImageToInput({ messageInput, createImageTag, imageData }) {
    const imageTag = createImageTag({
        base64Data: imageData.base64Data,
        fileName: imageData.fileName
    });

    // 确保输入框有焦点
    messageInput.focus();

    // 获取或创建选区
    const selection = window.getSelection();
    let range;

    // 检查是否有现有选区
    if (selection.rangeCount > 0) {
        range = selection.getRangeAt(0);
    } else {
        // 创建新的选区
        range = document.createRange();
        // 将选区设置到输入框的末尾
        range.selectNodeContents(messageInput);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // 插入图片标签
    range.deleteContents();
    range.insertNode(imageTag);

    // 移动光标到图片标签后面
    const newRange = document.createRange();
    newRange.setStartAfter(imageTag);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);

    // 触发输入事件以调整高度
    messageInput.dispatchEvent(new Event('input'));
}