// 提示詞服務：優先使用遠端 (GitHub) 提示詞，fallback 到本地打包的 prompts.json
import { isExtensionEnvironment } from '../utils/storage-adapter.js';

const SESSION_KEY = 'cerebr_remote_prompts';
const REMOTE_URL = 'https://raw.githubusercontent.com/Tspm1eca/Cerebr-neo/main/src/constants/prompts.json';
const LOCAL_JSON_PATH = 'src/constants/prompts.json';
const FETCH_TIMEOUT_MS = 8000;

// 記憶體緩存，避免重複異步讀取 session storage
let _memoryCache = null;
// 去重：確保同時多次呼叫只觸發一次 fetch
let _fetchPromise = null;

function isValidPromptData(data) {
    return data?.version === 1 && typeof data.DEFAULT_SYSTEM_PROMPT === 'string';
}

/**
 * 從遠端 URL fetch 提示詞 JSON。
 * @returns {Promise<Object|null>}
 */
async function fetchRemote() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const resp = await fetch(REMOTE_URL, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!resp.ok) return null;

        const data = await resp.json();
        if (isValidPromptData(data)) return data;
    } catch { /* 靜默處理 */ }
    return null;
}

/**
 * 從本地打包的 prompts.json fetch 提示詞。
 * @returns {Promise<Object|null>}
 */
async function fetchLocal() {
    try {
        const url = chrome.runtime.getURL(LOCAL_JSON_PATH);
        const resp = await fetch(url);
        const data = await resp.json();
        if (isValidPromptData(data)) return data;
    } catch { /* 靜默處理 */ }
    return null;
}

/**
 * 載入提示詞並存入 chrome.storage.session。
 * 流程：session cache → 遠端 URL → 本地 JSON。
 * 非阻塞式調用，所有錯誤靜默處理。
 */
export function fetchAndCacheRemotePrompts() {
    if (!isExtensionEnvironment) return Promise.resolve();
    if (!_fetchPromise) {
        _fetchPromise = _doFetch();
    }
    return _fetchPromise;
}

async function _doFetch() {
    try {
        // 1. 檢查 session storage 緩存
        const existing = await chrome.storage.session.get(SESSION_KEY);
        if (existing[SESSION_KEY]) {
            _memoryCache = existing[SESSION_KEY];
            return;
        }

        // 2. 嘗試遠端 URL
        let data = await fetchRemote();

        // 3. 失敗則回退到本地打包的 JSON
        if (!data) {
            data = await fetchLocal();
        }

        if (data) {
            await chrome.storage.session.set({ [SESSION_KEY]: data });
            _memoryCache = data;
        }
    } catch (e) {
        console.warn('[RemotePrompts] 初始化失敗:', e.message);
    }
}

/**
 * 取得緩存的提示詞，若尚未載入則觸發 lazy fetch。
 * @returns {Promise<Object|null>}
 */
async function getCachedPrompts() {
    if (_memoryCache) return _memoryCache;
    if (!isExtensionEnvironment) return null;

    try {
        const result = await chrome.storage.session.get(SESSION_KEY);
        if (result[SESSION_KEY]) {
            _memoryCache = result[SESSION_KEY];
            return _memoryCache;
        }
    } catch { /* 靜默處理 */ }

    // session storage 也沒有，觸發 fetch
    await fetchAndCacheRemotePrompts();
    return _memoryCache;
}

// ── Getter 函數 ──────────────────────────────────────────────

function createGetter(key, fallback = '') {
    return async () => {
        const cached = await getCachedPrompts();
        return cached?.[key] || fallback;
    };
}

export const getDefaultSystemPrompt = createGetter('DEFAULT_SYSTEM_PROMPT');
export const getWebSearchSystemPrompt = createGetter('WEB_SEARCH_SYSTEM_PROMPT');
export const getVideoTranscriptSystemPrompt = createGetter('VIDEO_TRANSCRIPT_SYSTEM_PROMPT');
export const getWebSearchToolDescription = createGetter('WEB_SEARCH_TOOL_DESCRIPTION');
export const getWebSearchToolQueryDescription = createGetter('WEB_SEARCH_TOOL_QUERY_DESCRIPTION');
export const getTitleGenerationPrompt = createGetter('TITLE_GENERATION_PROMPT');

/**
 * 返回預設快捷聊天選項（深拷貝）。
 */
export async function getDefaultQuickChatOptions() {
    const cached = await getCachedPrompts();
    const opts = cached?.DEFAULT_QUICK_CHAT_OPTIONS;
    if (Array.isArray(opts)) {
        return opts.map(opt => ({ ...opt }));
    }
    return [];
}
