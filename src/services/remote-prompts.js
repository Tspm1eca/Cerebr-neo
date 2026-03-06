// 遠端提示詞服務：從 GitHub 下載最新提示詞，緩存於 chrome.storage.session
import { isExtensionEnvironment } from '../utils/storage-adapter.js';
import {
    DEFAULT_SYSTEM_PROMPT,
    WEB_SEARCH_SYSTEM_PROMPT,
    VIDEO_TRANSCRIPT_SYSTEM_PROMPT,
    WEB_SEARCH_TOOL_DESCRIPTION,
    WEB_SEARCH_TOOL_QUERY_DESCRIPTION,
    TITLE_GENERATION_PROMPT,
    createDefaultQuickChatOptions
} from '../constants/prompts.js';

const SESSION_KEY = 'cerebr_remote_prompts';
const REMOTE_URL = 'https://raw.githubusercontent.com/Tspm1eca/Cerebr-neo/Dev/prompts.json';
const FETCH_TIMEOUT_MS = 8000;

// 記憶體緩存，避免重複異步讀取 session storage
let _memoryCache = null;

/**
 * 從 GitHub 下載提示詞並存入 chrome.storage.session。
 * 若本次 session 已有緩存則跳過。非阻塞式調用，所有錯誤靜默處理。
 */
export async function fetchAndCacheRemotePrompts() {
    if (!isExtensionEnvironment) return;

    try {
        const existing = await chrome.storage.session.get(SESSION_KEY);
        if (existing[SESSION_KEY]) {
            _memoryCache = existing[SESSION_KEY];
            return;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const resp = await fetch(REMOTE_URL, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!resp.ok) return;

        const data = await resp.json();

        if (!data || data.version !== 1 || typeof data.DEFAULT_SYSTEM_PROMPT !== 'string') return;

        await chrome.storage.session.set({ [SESSION_KEY]: data });
        _memoryCache = data;
        console.log('[RemotePrompts] 已下載並緩存遠端提示詞');
    } catch (e) {
        console.warn('[RemotePrompts] 下載失敗，將使用內置預設值:', e.message);
    }
}

/**
 * 讀取緩存的遠端提示詞，返回 null 表示無可用緩存。
 */
async function getRemotePrompts() {
    if (_memoryCache) return _memoryCache;
    if (!isExtensionEnvironment) return null;

    try {
        const result = await chrome.storage.session.get(SESSION_KEY);
        _memoryCache = result[SESSION_KEY] || null;
        return _memoryCache;
    } catch {
        return null;
    }
}

/**
 * 返回預設系統提示詞：優先使用遠端版本，否則使用內置預設值。
 */
export async function getDefaultSystemPrompt() {
    const remote = await getRemotePrompts();
    return remote?.DEFAULT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
}

/**
 * 返回網頁搜索系統提示詞。
 */
export async function getWebSearchSystemPrompt() {
    const remote = await getRemotePrompts();
    return remote?.WEB_SEARCH_SYSTEM_PROMPT || WEB_SEARCH_SYSTEM_PROMPT;
}

/**
 * 返回影片字幕系統提示詞。
 */
export async function getVideoTranscriptSystemPrompt() {
    const remote = await getRemotePrompts();
    return remote?.VIDEO_TRANSCRIPT_SYSTEM_PROMPT || VIDEO_TRANSCRIPT_SYSTEM_PROMPT;
}

/**
 * 返回網頁搜索工具描述。
 */
export async function getWebSearchToolDescription() {
    const remote = await getRemotePrompts();
    return remote?.WEB_SEARCH_TOOL_DESCRIPTION || WEB_SEARCH_TOOL_DESCRIPTION;
}

/**
 * 返回網頁搜索查詢描述。
 */
export async function getWebSearchToolQueryDescription() {
    const remote = await getRemotePrompts();
    return remote?.WEB_SEARCH_TOOL_QUERY_DESCRIPTION || WEB_SEARCH_TOOL_QUERY_DESCRIPTION;
}

/**
 * 返回標題生成提示詞。
 */
export async function getTitleGenerationPrompt() {
    const remote = await getRemotePrompts();
    return remote?.TITLE_GENERATION_PROMPT || TITLE_GENERATION_PROMPT;
}

/**
 * 返回預設快捷聊天選項（深拷貝）：優先使用遠端版本，否則使用內置預設值。
 */
export async function getDefaultQuickChatOptions() {
    const remote = await getRemotePrompts();
    if (remote?.DEFAULT_QUICK_CHAT_OPTIONS && Array.isArray(remote.DEFAULT_QUICK_CHAT_OPTIONS)) {
        return remote.DEFAULT_QUICK_CHAT_OPTIONS.map(opt => ({ ...opt }));
    }
    return createDefaultQuickChatOptions();
}
