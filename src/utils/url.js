/**
 * URL 相關工具函數
 */

/**
 * 檢查 URL 是否為 HTTP/HTTPS 圖片 URL
 * @param {string} url - 要檢查的 URL
 * @returns {boolean} 是否為 HTTP/HTTPS URL
 */
export function isHttpImageUrl(url) {
    return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

/**
 * 標準化同步路徑，移除首尾斜線
 * @param {string} syncPath - 同步路徑
 * @returns {string} 標準化後的路徑
 */
export function normalizeSyncPath(syncPath = '') {
    return syncPath.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * 構建 WebDAV 基礎 URL
 * @param {Object} config - WebDAV 配置對象
 * @param {string} config.serverUrl - 伺服器 URL
 * @param {string} config.syncPath - 同步路徑
 * @returns {string} 完整的基礎 URL，如果配置無效則返回空字串
 */
export function buildWebdavBaseUrl(config) {
    const serverUrl = (config?.serverUrl || '').replace(/\/+$/, '');
    const syncPath = normalizeSyncPath(config?.syncPath || '');
    if (!serverUrl || !syncPath) {
        return '';
    }
    return `${serverUrl}/${syncPath}`;
}

/**
 * 將 Blob 轉換為 Data URL
 * @param {Blob} blob - 要轉換的 Blob 對象
 * @returns {Promise<string>} Data URL
 */
export function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('图片转码失败'));
        reader.readAsDataURL(blob);
    });
}