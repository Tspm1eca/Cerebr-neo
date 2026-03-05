/**
 * 加密工具模組
 * 使用 Web Crypto API 實現 AES-256-GCM 加密
 * 用於加密 WebDAV 同步中的敏感數據（如 API Keys）
 */

// 加密配置常量
const CRYPTO_CONFIG = {
    algorithm: 'AES-GCM',
    keyLength: 256,
    ivLength: 12,        // GCM 推薦的 IV 長度
    tagLength: 128,      // 認證標籤長度（bits）
    iterations: 100000,  // PBKDF2 迭代次數
    saltLength: 16       // 鹽值長度
};

/**
 * 將 ArrayBuffer 轉換為 Base64 字符串
 * @param {ArrayBuffer} buffer - 要轉換的 ArrayBuffer
 * @returns {string} Base64 編碼的字符串
 */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * 將 Base64 字符串轉換為 ArrayBuffer
 * @param {string} base64 - Base64 編碼的字符串
 * @returns {ArrayBuffer} 解碼後的 ArrayBuffer
 */
function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * 從密碼派生加密密鑰
 * @param {string} password - 用戶密碼
 * @param {Uint8Array} salt - 鹽值
 * @returns {Promise<CryptoKey>} 派生的加密密鑰
 */
async function deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    // 導入密碼作為原始密鑰材料
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        'PBKDF2',
        false,
        ['deriveKey']
    );

    // 使用 PBKDF2 派生 AES 密鑰
    const key = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: CRYPTO_CONFIG.iterations,
            hash: 'SHA-256'
        },
        keyMaterial,
        {
            name: CRYPTO_CONFIG.algorithm,
            length: CRYPTO_CONFIG.keyLength
        },
        false,
        ['encrypt', 'decrypt']
    );

    return key;
}

/**
 * 加密數據
 * @param {Object|string} data - 要加密的數據（對象會被 JSON 序列化）
 * @param {string} password - 加密密碼
 * @returns {Promise<Object>} 加密結果，包含 salt、iv 和 ciphertext（均為 Base64）
 */
export async function encrypt(data, password) {
    if (!password || password.length === 0) {
        throw new Error('加密密码不能为空');
    }

    const encoder = new TextEncoder();

    // 將數據轉換為字符串
    const dataString = typeof data === 'string' ? data : JSON.stringify(data);
    const dataBuffer = encoder.encode(dataString);

    // 生成隨機鹽值和 IV
    const salt = crypto.getRandomValues(new Uint8Array(CRYPTO_CONFIG.saltLength));
    const iv = crypto.getRandomValues(new Uint8Array(CRYPTO_CONFIG.ivLength));

    // 派生密鑰
    const key = await deriveKey(password, salt);

    // 加密數據
    const ciphertext = await crypto.subtle.encrypt(
        {
            name: CRYPTO_CONFIG.algorithm,
            iv: iv,
            tagLength: CRYPTO_CONFIG.tagLength
        },
        key,
        dataBuffer
    );

    // 返回 Base64 編碼的結果
    return {
        salt: arrayBufferToBase64(salt.buffer),
        iv: arrayBufferToBase64(iv.buffer),
        ciphertext: arrayBufferToBase64(ciphertext),
        // 添加版本標識，便於未來升級加密方案
        version: 1
    };
}

/**
 * 解密數據
 * @param {Object} encryptedData - 加密的數據對象，包含 salt、iv 和 ciphertext
 * @param {string} password - 解密密碼
 * @param {boolean} parseJson - 是否將解密結果解析為 JSON（默認 true）
 * @returns {Promise<Object|string>} 解密後的數據
 */
export async function decrypt(encryptedData, password, parseJson = true) {
    if (!password || password.length === 0) {
        throw new Error('解密密码不能为空');
    }

    if (!encryptedData || !encryptedData.salt || !encryptedData.iv || !encryptedData.ciphertext) {
        throw new Error('加密数据格式无效：缺少必要的加密字段（salt、iv 或 ciphertext）');
    }

    // 檢查加密版本
    const version = encryptedData.version;
    if (version === undefined) {
        throw new Error('加密数据格式无效：缺少版本标识');
    }
    if (version !== 1) {
        throw new Error(`不支持的加密版本：${version}，当前仅支持版本 1`);
    }

    const decoder = new TextDecoder();

    // 從 Base64 解碼
    let salt, iv, ciphertext;
    try {
        salt = new Uint8Array(base64ToArrayBuffer(encryptedData.salt));
        iv = new Uint8Array(base64ToArrayBuffer(encryptedData.iv));
        ciphertext = base64ToArrayBuffer(encryptedData.ciphertext);
    } catch (e) {
        throw new Error('加密数据解码失败：Base64 格式无效');
    }

    // 派生密鑰
    const key = await deriveKey(password, salt);

    try {
        // 解密數據
        const decryptedBuffer = await crypto.subtle.decrypt(
            {
                name: CRYPTO_CONFIG.algorithm,
                iv: iv,
                tagLength: CRYPTO_CONFIG.tagLength
            },
            key,
            ciphertext
        );

        // 將解密結果轉換為字符串
        const decryptedString = decoder.decode(decryptedBuffer);

        // 根據需要解析 JSON
        if (parseJson) {
            try {
                return JSON.parse(decryptedString);
            } catch (e) {
                // 如果不是有效的 JSON，返回原始字符串
                return decryptedString;
            }
        }

        return decryptedString;
    } catch (error) {
        // 解密失敗，提供更具體的錯誤信息
        if (error.name === 'OperationError') {
            throw new Error('解密失败：密码错误或数据已损坏。请确认您输入的密码与加密时使用的密码一致。');
        }
        throw new Error(`解密过程发生错误：${error.message}`);
    }
}

/**
 * 檢查數據是否已加密
 * @param {any} data - 要檢查的數據
 * @returns {boolean} 是否為加密數據
 */
export function isEncrypted(data) {
    return data &&
           typeof data === 'object' &&
           data.version !== undefined &&
           data.salt !== undefined &&
           data.iv !== undefined &&
           data.ciphertext !== undefined;
}

/**
 * 驗證密碼強度
 * @param {string} password - 要驗證的密碼
 * @returns {Object} 驗證結果，包含 valid 和 message
 */
export function validatePassword(password) {
    if (!password || password.length === 0) {
        return { valid: false, message: '密码不能为空' };
    }

    // 已移除密碼長度限制，允許任意長度的密碼

    return { valid: true, message: '密码有效' };
}

/**
 * 生成隨機密碼
 * @param {number} length - 密碼長度（默認 16）
 * @returns {string} 隨機生成的密碼
 */
export function generateRandomPassword(length = 16) {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    const randomValues = crypto.getRandomValues(new Uint8Array(length));
    let password = '';
    for (let i = 0; i < length; i++) {
        password += charset[randomValues[i] % charset.length];
    }
    return password;
}

/**
 * 生成主密鑰（用於加密存儲加密密碼）
 * 基於擴展 ID 和固定鹽值派生，確保同一擴展實例使用相同的主密鑰
 * @returns {Promise<CryptoKey>} 主密鑰
 */
async function deriveMasterKey() {
    // 使用擴展 ID 作為密鑰派生的基礎
    // 在 Chrome 擴展中，chrome.runtime.id 提供擴展的唯一標識符
    const extensionId = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id
        ? chrome.runtime.id
        : 'cerebr-neo-default';

    // 固定的鹽值（用於確保同一擴展實例生成相同的主密鑰）
    const saltString = 'cerebr-webdav-master-key-salt-v1';
    const encoder = new TextEncoder();
    const salt = encoder.encode(saltString);

    // 將擴展 ID 轉換為密鑰材料
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(extensionId),
        'PBKDF2',
        false,
        ['deriveKey']
    );

    // 派生主密鑰
    const masterKey = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        {
            name: CRYPTO_CONFIG.algorithm,
            length: CRYPTO_CONFIG.keyLength
        },
        false,
        ['encrypt', 'decrypt']
    );

    return masterKey;
}

/**
 * 加密存儲加密密碼
 * 使用主密鑰加密用戶的加密密碼，然後存儲加密後的結果
 * @param {string} password - 要加密存儲的密碼
 * @returns {Promise<Object>} 加密結果，包含 iv 和 ciphertext（均為 Base64）
 */
export async function encryptPasswordForStorage(password) {
    if (!password || password.length === 0) {
        throw new Error('密碼不能為空');
    }

    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    // 生成隨機 IV
    const iv = crypto.getRandomValues(new Uint8Array(CRYPTO_CONFIG.ivLength));

    // 派生主密鑰
    const masterKey = await deriveMasterKey();

    // 加密密碼
    const ciphertext = await crypto.subtle.encrypt(
        {
            name: CRYPTO_CONFIG.algorithm,
            iv: iv,
            tagLength: CRYPTO_CONFIG.tagLength
        },
        masterKey,
        passwordBuffer
    );

    // 返回 Base64 編碼的結果
    return {
        iv: arrayBufferToBase64(iv.buffer),
        ciphertext: arrayBufferToBase64(ciphertext),
        version: 1
    };
}

/**
 * 解密存儲的加密密碼
 * 使用主密鑰解密存儲的加密密碼
 * @param {Object} encryptedPassword - 加密的密碼對象，包含 iv 和 ciphertext
 * @returns {Promise<string>} 解密後的密碼
 */
export async function decryptPasswordFromStorage(encryptedPassword) {
    if (!encryptedPassword || !encryptedPassword.iv || !encryptedPassword.ciphertext) {
        throw new Error('加密密码格式无效：缺少必要的加密字段（iv 或 ciphertext）');
    }

    // 檢查加密版本
    const version = encryptedPassword.version;
    if (version === undefined) {
        throw new Error('加密密码格式无效：缺少版本标签');
    }
    if (version !== 1) {
        throw new Error(`不支持的加密密码版本：${version}，当前仅支持版本 1`);
    }

    const decoder = new TextDecoder();

    // 從 Base64 解碼
    let iv, ciphertext;
    try {
        iv = new Uint8Array(base64ToArrayBuffer(encryptedPassword.iv));
        ciphertext = base64ToArrayBuffer(encryptedPassword.ciphertext);
    } catch (e) {
        throw new Error('加密密碼解碼失敗：Base64 格式無效');
    }

    // 派生主密鑰
    const masterKey = await deriveMasterKey();

    try {
        // 解密密碼
        const decryptedBuffer = await crypto.subtle.decrypt(
            {
                name: CRYPTO_CONFIG.algorithm,
                iv: iv,
                tagLength: CRYPTO_CONFIG.tagLength
            },
            masterKey,
            ciphertext
        );

        // 將解密結果轉換為字符串
        return decoder.decode(decryptedBuffer);
    } catch (error) {
        // 解密失敗
        if (error.name === 'OperationError') {
            throw new Error('解密失败：数据已损坏或扩展环境已变更');
        }
        throw new Error(`解密过程发生错误：${error.message}`);
    }
}

/**
 * 檢查密碼是否已加密存儲
 * @param {any} data - 要檢查的數據
 * @returns {boolean} 是否為加密存儲的密碼
 */
export function isEncryptedPassword(data) {
    return data &&
           typeof data === 'object' &&
           data.version !== undefined &&
           data.iv !== undefined &&
           data.ciphertext !== undefined;
}

// 導出配置常量（用於測試或調試）
export const CRYPTO_CONSTANTS = {
    ...CRYPTO_CONFIG
};