/**
 * 輕量級 i18n 模組
 * 支援語言偵測、動態切換、參數替換
 */

import { syncStorageAdapter } from './storage-adapter.js';

const LOCALE_KEY = 'cerebrLocale';

// 支援的語言列表
const SUPPORTED_LOCALES = ['zh-TW', 'zh-CN', 'en', 'ja'];
const DEFAULT_LOCALE = 'zh-TW';

let currentLocale = DEFAULT_LOCALE;
let messages = {};
let fallbackMessages = {};

/**
 * 根據瀏覽器語言偵測最佳 locale
 * @returns {string}
 */
function detectLocale() {
    const lang = navigator.language || navigator.languages?.[0] || '';
    const lower = lang.toLowerCase();

    if (lower.startsWith('zh')) {
        // zh-TW, zh-Hant → 繁體
        if (lower.includes('tw') || lower.includes('hk') || lower.includes('mo') || lower.includes('hant')) {
            return 'zh-TW';
        }
        // zh-CN, zh-Hans, zh → 簡體
        return 'zh-CN';
    }
    if (lower.startsWith('ja')) return 'ja';
    if (lower.startsWith('en')) return 'en';
    // 其他語言預設英文
    return 'en';
}

/**
 * 動態載入 locale 模組
 * @param {string} locale
 * @returns {Promise<Object>}
 */
async function loadLocaleMessages(locale) {
    try {
        const mod = await import(`../locales/${locale}.js`);
        return mod.default || mod;
    } catch (e) {
        console.warn(`[i18n] 無法載入 locale "${locale}":`, e);
        return {};
    }
}

/**
 * 初始化 i18n
 * 從 storage 讀取使用者偏好，否則自動偵測
 */
export async function initI18n() {
    try {
        const result = await syncStorageAdapter.get(LOCALE_KEY);
        currentLocale = result[LOCALE_KEY] || detectLocale();
    } catch {
        currentLocale = detectLocale();
    }

    if (!SUPPORTED_LOCALES.includes(currentLocale)) {
        currentLocale = DEFAULT_LOCALE;
    }

    // 載入目標語言和 fallback（zh-TW 作為 fallback）
    messages = await loadLocaleMessages(currentLocale);
    if (currentLocale !== DEFAULT_LOCALE) {
        fallbackMessages = await loadLocaleMessages(DEFAULT_LOCALE);
    } else {
        fallbackMessages = {};
    }

    // 套用 HTML 靜態文字
    applyI18nToDOM();
}

/**
 * 翻譯函數
 * @param {string} key - 翻譯鍵，用 '.' 分隔層級
 * @param {Object} [params] - 替換參數，如 { count: 3 } → {{count}}
 * @returns {string}
 */
export function t(key, params) {
    let value = getNestedValue(messages, key)
        ?? getNestedValue(fallbackMessages, key)
        ?? key;

    if (params && typeof value === 'string') {
        for (const [k, v] of Object.entries(params)) {
            value = value.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
        }
    }
    return value;
}

/**
 * 從巢狀物件中取值
 * @param {Object} obj
 * @param {string} path - 'a.b.c'
 * @returns {*}
 */
function getNestedValue(obj, path) {
    if (!obj || !path) return undefined;
    const keys = path.split('.');
    let current = obj;
    for (const key of keys) {
        if (current == null || typeof current !== 'object') return undefined;
        current = current[key];
    }
    return current;
}

/**
 * 將 CSS content 用的翻譯注入為 CSS 自訂屬性
 */
function applyCssI18nVars() {
    const root = document.documentElement;
    root.style.setProperty('--i18n-not-found', `'${t('css.notFound')}'`);
    root.style.setProperty('--i18n-cannot-jump', `'${t('css.cannotJump')}'`);
}

/**
 * 將 HTML 中帶有 data-i18n 屬性的元素替換為翻譯文字
 * 支援：
 *   data-i18n="key" → textContent
 *   data-i18n-placeholder="key" → placeholder
 *   data-i18n-title="key" → title
 *   data-i18n-html="key" → innerHTML
 *   data-i18n-aria-label="key" → aria-label
 */
export function applyI18nToDOM(root = document) {
    // CSS custom properties for content: rules
    applyCssI18nVars();

    // textContent
    root.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key) el.textContent = t(key);
    });
    // innerHTML
    root.querySelectorAll('[data-i18n-html]').forEach(el => {
        const key = el.getAttribute('data-i18n-html');
        if (key) el.innerHTML = t(key);
    });
    // placeholder
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) el.setAttribute('placeholder', t(key));
    });
    // title
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key) el.setAttribute('title', t(key));
    });
    // aria-label
    root.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        const key = el.getAttribute('data-i18n-aria-label');
        if (key) el.setAttribute('aria-label', t(key));
    });
}

/**
 * 切換語言
 * @param {string} locale
 */
export async function setLocale(locale) {
    if (!SUPPORTED_LOCALES.includes(locale)) return;

    currentLocale = locale;
    await syncStorageAdapter.set({ [LOCALE_KEY]: locale });

    messages = await loadLocaleMessages(currentLocale);
    if (currentLocale !== DEFAULT_LOCALE) {
        fallbackMessages = await loadLocaleMessages(DEFAULT_LOCALE);
    } else {
        fallbackMessages = {};
    }

    applyI18nToDOM();
}

/**
 * 取得目前 locale
 * @returns {string}
 */
export function getLocale() {
    return currentLocale;
}

/**
 * 取得支援的語言列表
 * @returns {string[]}
 */
export function getSupportedLocales() {
    return [...SUPPORTED_LOCALES];
}

/**
 * 取得目前語言的顯示名稱（用於 AI prompt 中的語言指定）
 * @returns {string}
 */
export function getUserLanguageName() {
    switch (currentLocale) {
        case 'zh-TW': return 'Traditional Chinese';
        case 'zh-CN': return 'Simplified Chinese';
        case 'en': return 'English';
        case 'ja': return 'Japanese';
        default: return 'English';
    }
}
