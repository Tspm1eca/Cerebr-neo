import { addImageToPreview } from './ui.js';

/**
 * 圖片壓縮配置
 */
const COMPRESSION_CONFIG = {
    maxWidth: 1024,      // 最大寬度
    maxHeight: 1024,     // 最大高度
    quality: 0.8,        // 圖片質量 (0-1)
    maxSizeKB: 200,      // 目標最大大小 (KB)
    preferAVIF: true,    // 優先使用 AVIF 格式
    preserveTransparency: true  // 保留透明度
};

/**
 * 格式支持緩存
 */
const formatSupport = {
    avif: null,
    webp: null
};

/**
 * 檢測瀏覽器是否支持指定的圖片格式
 * @param {string} format - 格式類型 ('avif' | 'webp')
 * @returns {boolean} 是否支持該格式
 */
function isFormatSupported(format) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const mimeType = `image/${format}`;
    return canvas.toDataURL(mimeType).startsWith(`data:${mimeType}`);
}

/**
 * 初始化格式支持檢測（只執行一次）
 */
function initFormatSupport() {
    if (formatSupport.avif === null) {
        formatSupport.avif = isFormatSupported('avif');
        console.log(`AVIF 格式支持: ${formatSupport.avif ? '是' : '否'}`);
    }
    if (formatSupport.webp === null) {
        formatSupport.webp = isFormatSupported('webp');
        console.log(`WebP 格式支持: ${formatSupport.webp ? '是' : '否'}`);
    }
}

/**
 * 計算 Base64 字符串的實際字節大小
 * @param {string} base64String - Base64 編碼的字符串
 * @returns {number} 實際字節大小
 */
function getBase64ByteSize(base64String) {
    // 移除 data:image/xxx;base64, 前綴
    const base64 = base64String.split(',')[1] || base64String;
    // Base64 編碼後大小約為原始的 4/3，所以實際大小 = 長度 * 3/4
    // 還需要考慮 padding（末尾的 = 號）
    const padding = (base64.match(/=+$/) || [''])[0].length;
    return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * 檢測圖片是否包含透明通道
 * @param {HTMLCanvasElement} canvas - 畫布元素
 * @param {CanvasRenderingContext2D} ctx - 畫布上下文
 * @returns {boolean} 是否包含透明像素
 */
function hasTransparency(canvas, ctx) {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    // 檢查 alpha 通道（每 4 個值的第 4 個）
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) {
            return true;
        }
    }
    return false;
}

/**
 * 使用二分搜索找到最佳壓縮質量
 * @param {HTMLCanvasElement} canvas - 畫布元素
 * @param {string} format - 圖片格式 MIME 類型
 * @param {number} targetBytes - 目標字節大小
 * @param {number} maxQuality - 最大質量值
 * @param {number} minQuality - 最小質量值
 * @returns {{data: string, quality: number}} 壓縮結果和使用的質量值
 */
function binarySearchQuality(canvas, format, targetBytes, maxQuality = 0.9, minQuality = 0.1) {
    let low = minQuality;
    let high = maxQuality;
    let bestData = canvas.toDataURL(format, high);
    let bestQuality = high;

    // 如果最高質量已經滿足要求，直接返回
    if (getBase64ByteSize(bestData) <= targetBytes) {
        return { data: bestData, quality: bestQuality };
    }

    // 二分搜索最佳質量（最多 8 次迭代）
    for (let i = 0; i < 8; i++) {
        const mid = (low + high) / 2;
        const data = canvas.toDataURL(format, mid);
        const size = getBase64ByteSize(data);

        if (size <= targetBytes) {
            // 大小符合要求，嘗試提高質量
            bestData = data;
            bestQuality = mid;
            low = mid;
        } else {
            // 大小超標，降低質量
            high = mid;
        }

        // 如果範圍已經很小，停止搜索
        if (high - low < 0.02) {
            break;
        }
    }

    // 如果二分搜索後仍然超標，使用最低質量
    if (getBase64ByteSize(bestData) > targetBytes) {
        bestData = canvas.toDataURL(format, minQuality);
        bestQuality = minQuality;
    }

    return { data: bestData, quality: bestQuality };
}

/**
 * 選擇最佳壓縮格式
 * @param {boolean} hasAlpha - 圖片是否有透明通道
 * @param {boolean} preferAVIF - 是否優先使用 AVIF
 * @returns {string[]} 按優先級排序的格式列表
 */
function getPreferredFormats(hasAlpha, preferAVIF) {
    const formats = [];

    if (hasAlpha) {
        // 有透明通道：優先使用支持透明的格式
        if (preferAVIF && formatSupport.avif) {
            formats.push('image/avif');
        }
        if (formatSupport.webp) {
            formats.push('image/webp');
        }
        formats.push('image/png'); // PNG 作為最後備選（支持透明但壓縮率低）
    } else {
        // 無透明通道：可以使用所有格式
        if (preferAVIF && formatSupport.avif) {
            formats.push('image/avif');
        }
        if (formatSupport.webp) {
            formats.push('image/webp');
        }
        formats.push('image/jpeg'); // JPEG 作為最後備選
    }

    return formats;
}

/**
 * 獲取格式的顯示名稱
 * @param {string} mimeType - MIME 類型
 * @returns {string} 格式名稱
 */
function getFormatName(mimeType) {
    const names = {
        'image/avif': 'AVIF',
        'image/webp': 'WebP',
        'image/jpeg': 'JPEG',
        'image/png': 'PNG'
    };
    return names[mimeType] || mimeType;
}

/**
 * 壓縮圖片
 * @param {string} base64Data - 原始圖片的 base64 數據
 * @param {Object} [options] - 壓縮選項
 * @param {number} [options.maxWidth=1024] - 最大寬度
 * @param {number} [options.maxHeight=1024] - 最大高度
 * @param {number} [options.quality=0.8] - 圖片質量 (0-1)
 * @param {number} [options.maxSizeKB=200] - 目標最大大小 (KB)
 * @param {boolean} [options.preferAVIF=true] - 優先使用 AVIF 格式
 * @param {boolean} [options.preserveTransparency=true] - 保留透明度
 * @returns {Promise<string>} 壓縮後的 base64 數據
 */
export async function compressImage(base64Data, options = {}) {
    const config = { ...COMPRESSION_CONFIG, ...options };

    // 初始化格式支持檢測
    initFormatSupport();

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

                // 檢測是否需要保留透明度
                let imageHasAlpha = false;
                if (config.preserveTransparency) {
                    // 先繪製到臨時 canvas 檢測透明度
                    ctx.drawImage(img, 0, 0, width, height);
                    imageHasAlpha = hasTransparency(canvas, ctx);

                    if (!imageHasAlpha) {
                        // 如果沒有透明度，用白色背景重繪（優化 JPEG 壓縮）
                        ctx.fillStyle = '#FFFFFF';
                        ctx.fillRect(0, 0, width, height);
                        ctx.drawImage(img, 0, 0, width, height);
                    }
                } else {
                    // 不保留透明度，直接用白色背景
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, width, height);
                    ctx.drawImage(img, 0, 0, width, height);
                }

                // 獲取優先格式列表
                const formats = getPreferredFormats(imageHasAlpha, config.preferAVIF);
                const targetBytes = config.maxSizeKB * 1024;
                const originalBytes = getBase64ByteSize(base64Data);

                let bestResult = null;
                let bestFormat = null;

                // 嘗試每種格式，選擇最佳結果
                for (const format of formats) {
                    const result = binarySearchQuality(
                        canvas,
                        format,
                        targetBytes,
                        config.quality,
                        0.1
                    );

                    const resultBytes = getBase64ByteSize(result.data);

                    // 選擇最小的結果
                    if (!bestResult || resultBytes < getBase64ByteSize(bestResult.data)) {
                        bestResult = result;
                        bestFormat = format;
                    }

                    // 如果已經達到目標大小且壓縮率不錯，可以提前結束
                    if (resultBytes <= targetBytes && resultBytes < originalBytes * 0.8) {
                        break;
                    }
                }

                // 如果壓縮後比原始更大，返回原始數據
                const compressedBytes = getBase64ByteSize(bestResult.data);
                if (compressedBytes >= originalBytes) {
                    console.log('壓縮後大小未減少，使用原始圖片');
                    resolve(base64Data);
                    return;
                }

                const originalSizeKB = Math.round(originalBytes / 1024);
                const compressedSizeKB = Math.round(compressedBytes / 1024);
                const compressionRatio = Math.round((1 - compressedBytes / originalBytes) * 100);
                const formatName = getFormatName(bestFormat);

                console.log(
                    `圖片壓縮完成 (${formatName}, 質量=${Math.round(bestResult.quality * 100)}%): ` +
                    `${originalSizeKB}KB → ${compressedSizeKB}KB (減少 ${compressionRatio}%)` +
                    (imageHasAlpha ? ' [保留透明度]' : '')
                );

                resolve(bestResult.data);
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
                        const thumbnailData = await createThumbnailImage(compressedData);

                        // 使用新的预览区域显示图片
                        addImageToPreview({
                            imageSource: compressedData,
                            thumbnailSource: thumbnailData,
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
                        const thumbnailData = await createThumbnailImage(compressedData);

                        // 使用新的预览区域显示图片
                        addImageToPreview({
                            imageSource: compressedData,
                            thumbnailSource: thumbnailData,
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

/**
 * 生成消息缩略图（用于聊天气泡快速展示）
 * @param {string} base64Data - 原始图片 data URL
 * @returns {Promise<string>} 缩略图 data URL
 */
export async function createThumbnailImage(base64Data) {
    if (typeof base64Data !== 'string' || !base64Data.startsWith('data:image/')) {
        return base64Data;
    }

    return await compressImage(base64Data, {
        maxWidth: 128,
        maxHeight: 128,
        quality: 0.62,
        maxSizeKB: 24,
        preferAVIF: false,
        preserveTransparency: true
    });
}
