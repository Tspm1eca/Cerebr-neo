/**
 * API配置接口
 * @typedef {Object} APIConfig
 * @property {string} baseUrl - API的基础URL
 * @property {string} apiKey - API密钥
 * @property {string} [modelName] - 模型名称，默认为 "gpt-4o"
 * @property {string} [tavilyApiKey] - Tavily API 密钥（用于网络搜索）
 */

import {
    DEFAULT_SYSTEM_PROMPT,
    WEB_SEARCH_SYSTEM_PROMPT,
    VIDEO_TRANSCRIPT_SYSTEM_PROMPT,
    WEB_SEARCH_TOOL_DESCRIPTION,
    WEB_SEARCH_TOOL_QUERY_DESCRIPTION
} from '../constants/prompts.js';
import { webSearch, tavilySearch, formatSearchResultsForPrompt, extractSearchQuery } from './web-search.js';

// 超時配置（毫秒）
const STREAM_TIMEOUT = 20000; // 流式響應超時：上次收到有效內容後 10 秒內無新內容則超時
const FIRST_CHUNK_TIMEOUT = 30000; // 首次數據超時：30 秒內必須收到第一個數據塊
const FETCH_TIMEOUT = 30000; // fetch 連線超時：30 秒內必須收到 HTTP 回應

/**
 * 超時錯誤類
 */
export class TimeoutError extends Error {
    constructor(message, type = 'stream') {
        super(message);
        this.name = 'TimeoutError';
        this.type = type; // 'stream' | 'first_chunk'
    }
}

/**
 * 計算流式超時參數
 * @param {boolean} isFirstChunk - 是否等待第一個數據塊
 * @param {number} lastContentTime - 上次收到有效內容的時間戳
 * @returns {{ timeout: number, message: string, type: string }}
 */
function calcStreamTimeout(isFirstChunk, lastContentTime) {
    if (isFirstChunk) {
        return {
            timeout: FIRST_CHUNK_TIMEOUT,
            message: `等待 AI 響應超時（${FIRST_CHUNK_TIMEOUT / 1000}秒內未收到任何數據）`,
            type: 'first_chunk'
        };
    }
    const remaining = STREAM_TIMEOUT - (Date.now() - lastContentTime);
    if (remaining <= 0) {
        throw new TimeoutError(
            `流式響應超時（${STREAM_TIMEOUT / 1000}秒內未收到新內容）`,
            'stream'
        );
    }
    return {
        timeout: remaining,
        message: `流式響應超時（${STREAM_TIMEOUT / 1000}秒內未收到新內容）`,
        type: 'stream'
    };
}

/**
 * 創建帶超時的 Promise
 * @param {Promise} promise - 原始 Promise
 * @param {number} timeout - 超時時間（毫秒）
 * @param {string} errorMessage - 超時錯誤訊息
 * @param {string} errorType - 錯誤類型
 * @returns {Promise} 帶超時的 Promise
 */
function withTimeout(promise, timeout, errorMessage, errorType = 'stream') {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new TimeoutError(errorMessage, errorType));
        }, timeout);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
}

/**
 * 网络搜索工具定义（用于 Function Calling）
 */
const WEB_SEARCH_TOOL = {
    type: "function",
    function: {
        name: "web_search",
        description: WEB_SEARCH_TOOL_DESCRIPTION,
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: WEB_SEARCH_TOOL_QUERY_DESCRIPTION
                }
            },
            required: ["query"]
        }
    }
};

/**
 * 网页信息接口
 * @typedef {Object} WebpageInfo
 * @property {string} title - 网页标题
 * @property {string} url - 网页URL
 * @property {string} content - 网页内容
 */

/**
 * 消息接口
 * @typedef {Object} Message
 * @property {string} role - 消息角色 ("system" | "user" | "assistant")
 * @property {string | Array<{type: string, text?: string, image_url?: {url: string}}>} content - 消息内容
 */

/**
 * API调用参数接口
 * @typedef {Object} APIParams
 * @property {Array<Message>} messages - 消息历史
 * @property {APIConfig} apiConfig - API配置
 * @property {string} userLanguage - 用户语言
 * @property {WebpageInfo} [webpageInfo] - 网页信息（可选）
 * @property {boolean} [enableWebSearch] - 是否启用网络搜索
 * @property {string} [searchQuery] - 自定义搜索查询（可选，默认使用最后一条用户消息）
 */

/**
 * 提取並替換文本中的URL
 * @param {string} text - 原始文本
 * @param {Map<string, string>} urlToIdMap - URL到ID的映射
 * @param {Map<string, string>} idToUrlMap - ID到URL的映射
 * @returns {string} 處理後的文本
 */
function extractAndReplaceUrls(text, urlToIdMap, idToUrlMap) {
    if (!text) return text;

    // 還原 Markdown 連結中被轉義的括號
    // Turndown 會將 URL 中的 ( ) 轉義為 \( \)，例如：
    // [Silicon Valley](https://...Silicon_Valley_\(TV_series\))
    // 需先還原才能讓 URL 正則完整匹配
    text = text.replace(/\]\(((?:[^\\)]|\\.)*)\)/g, (match, url) => {
        if (!url.includes('\\(') && !url.includes('\\)')) return match;
        return '](' + url.replace(/\\([()])/g, '$1') + ')';
    });

    // 匹配URL的正規表示式
    const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=,!]*)/g;

    return text.replace(urlRegex, (match) => {
        let url = match;
        let suffix = '';

        // 處理結尾的標點符號
        // 循環去除常見的結尾標點，直到剩下的部分看起來像一個合法的URL結尾
        const trailingPunctuation = /[)\]}.:;!?,"']$/;

        while (trailingPunctuation.test(url)) {
            const lastChar = url[url.length - 1];

            // 特殊處理括號：只有在不平衡的情況下才移除
            // 例如：https://en.wikipedia.org/wiki/Graph_(discrete_mathematics) 應該保留
            // 而 (https://example.com) 中的 ) 應該移除
            if (lastChar === ')') {
                const openCount = (url.match(/\(/g) || []).length;
                const closeCount = (url.match(/\)/g) || []).length;
                if (closeCount > openCount) {
                    url = url.slice(0, -1);
                    suffix = lastChar + suffix;
                } else {
                    break; // 括號平衡，應該是URL的一部分
                }
            } else {
                // 其他標點符號直接移除
                url = url.slice(0, -1);
                suffix = lastChar + suffix;
            }
        }

        if (urlToIdMap.has(url)) {
            return urlToIdMap.get(url) + suffix;
        }

        const id = `URLREF${urlToIdMap.size + 1}`;
        urlToIdMap.set(url, id);
        idToUrlMap.set(id, url);
        return id + suffix;
    });
}

/**
 * 還原文本中的URL
 * @param {string} text - 包含ID的文本
 * @param {Map<string, string>} idToUrlMap - ID到URL的映射
 * @returns {string} 還原後的文本
 */
function restoreUrls(text, idToUrlMap) {
    if (!text || idToUrlMap.size === 0) return text;

    // 使用正則表達式來匹配 URLREF<數字> 的格式
    // 這樣可以避免因為AI輸出不完整或包含額外字符導致的還原失敗
    // 也能更精確地匹配我們生成的ID
    return text.replace(/URLREF(\d+)/g, (match, idNum) => {
        const id = `URLREF${idNum}`;
        if (idToUrlMap.has(id)) {
            return idToUrlMap.get(id);
        }
        return match;
    });
}

/**
 * 建立已還原 URL 的訊息副本
 * @param {Object} msg - 原始訊息物件
 * @param {Map<string, string>} idToUrlMap - ID到URL的映射
 * @returns {Object} 還原 URL 後的訊息副本
 */
function createRestoredMessage(msg, idToUrlMap) {
    const copy = { ...msg };
    if (copy.content) copy.content = restoreUrls(copy.content, idToUrlMap);
    if (copy.reasoning_content) copy.reasoning_content = restoreUrls(copy.reasoning_content, idToUrlMap);
    return copy;
}

/**
 * 网络搜索模式
 * @typedef {'off' | 'auto' | 'on'} WebSearchMode
 */

/**
 * 调用API发送消息并处理响应
 * @param {APIParams} params - API调用参数
 * @param {Object} chatManager - 聊天管理器实例
 * @param {string} chatId - 当前聊天ID
 * @param {Function} onMessageUpdate - 消息更新回调函数
 * @returns {Promise<{processStream: () => Promise<{content: string, reasoning_content: string}>, controller: AbortController}>}
 */
export async function callAPI({
    messages,
    apiConfig,
    userLanguage,
    webpageInfo = null,
    webSearchMode = 'off',
    searchQuery = null,
    tavilyApiKey = null, // 保留向後兼容
    searchConfig = null  // 新的搜索配置
}, chatManager, chatId, onMessageUpdate) {
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey) {
        throw new Error('API 配置不完整');
    }

    // 初始化URL映射表
    const urlToIdMap = new Map();
    const idToUrlMap = new Map();

    // 构建系统消息
    let systemMessageContent = '';

    // 獲取用戶設定的 systemPrompt
    // 網絡搜索模式（on/auto）強制使用 WEB_SEARCH_SYSTEM_PROMPT
    // YouTube 影片字幕內容使用 VIDEO_TRANSCRIPT_SYSTEM_PROMPT
    // 傳送網頁開啟時使用 API 設置中的 systemPrompt
    // 兩者皆關閉時不使用任何 systemPrompt
    const isWebSearchActive = webSearchMode === 'on' || webSearchMode === 'auto';
    const hasWebpageInfo = webpageInfo && webpageInfo.pages && webpageInfo.pages.length > 0;
    const hasVideoTranscript = hasWebpageInfo && webpageInfo.pages.some(page =>
        page.isCurrent && /^https?:\/\/(www\.)?youtube\.com\/watch/.test(page.url) && page.content?.includes('## Transcript\n')
    );
    let userSystemPrompt;
    if (isWebSearchActive) {
        userSystemPrompt = WEB_SEARCH_SYSTEM_PROMPT;
    } else if (hasVideoTranscript) {
        userSystemPrompt = VIDEO_TRANSCRIPT_SYSTEM_PROMPT;
    } else if (hasWebpageInfo) {
        userSystemPrompt = apiConfig.advancedSettings?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    } else {
        userSystemPrompt = '';
    }
    const processedSystemPrompt = userSystemPrompt.replace(/\{\{userLanguage\}\}/gm, userLanguage);

    if (webpageInfo && webpageInfo.pages && webpageInfo.pages.length > 0) {
        const pagesContent = webpageInfo.pages.map(page => {
            const prefix = page.isCurrent ? '当前网页内容' : '其他打开的网页';
            const contentWithMappedUrls = extractAndReplaceUrls(page.content, urlToIdMap, idToUrlMap);
            return `\n${prefix}：\n标题：${page.title}\nURL：${page.url}\n内容：\n${contentWithMappedUrls}`;
        }).join('\n\n---\n');

        systemMessageContent = `${processedSystemPrompt}${pagesContent}`;
    } else if (processedSystemPrompt) {
        // 沒有網頁內容但有 systemPrompt 時，單獨使用 systemPrompt
        systemMessageContent = processedSystemPrompt;
    }

    // 解析搜索配置（支持新舊兩種格式）
    const effectiveSearchConfig = searchConfig || {
        provider: 'tavily',
        tavilyApiKey: tavilyApiKey,
        tavilyApiUrl: '',
        exaApiKey: '',
        exaApiUrl: ''
    };

    // 獲取當前提供者的 API Key
    const currentApiKey = effectiveSearchConfig.provider === 'exa'
        ? effectiveSearchConfig.exaApiKey
        : effectiveSearchConfig.tavilyApiKey;

    // 处理网络搜索 - 根据模式决定行为
    // 'on' 模式：直接执行搜索
    // 'auto' 模式：使用 Function Calling 让 AI 决定
    // 'off' 模式：不搜索
    // 用於標記 'on' 模式下是否已執行搜索
    let searchUsedInOnMode = false;
    // 'on' 模式的搜索結果（不再塞入 system prompt，改為注入 user message）
    let onModeSearchResults = null;

    if (webSearchMode === 'on' && currentApiKey) {
        try {
            // 获取搜索查询：使用自定义查询或最后一条用户消息
            let query = searchQuery;
            if (!query) {
                const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
                if (lastUserMessage) {
                    const rawQuery = typeof lastUserMessage.content === 'string'
                        ? lastUserMessage.content
                        : lastUserMessage.content.find(c => c.type === 'text')?.text || '';
                    query = extractSearchQuery(rawQuery);
                }
            }

            if (query) {
                console.log(`执行 ${effectiveSearchConfig.provider} 网络搜索:`, query);

                // 使用統一的搜索入口
                const searchResults = await webSearch({
                    provider: effectiveSearchConfig.provider,
                    apiKey: currentApiKey,
                    apiUrl: effectiveSearchConfig.provider === 'exa'
                        ? effectiveSearchConfig.exaApiUrl
                        : effectiveSearchConfig.tavilyApiUrl,
                    query: query,
                    searchDepth: 'basic',
                    maxResults: 5,
                    includeAnswer: true
                });

                // 格式化搜索結果
                const formattedResults = formatSearchResultsForPrompt(searchResults, userLanguage);
                const mappedFormattedResults = extractAndReplaceUrls(formattedResults, urlToIdMap, idToUrlMap);
                if (mappedFormattedResults) {
                    // 暫存搜索結果，後續注入到 user message
                    onModeSearchResults = mappedFormattedResults;

                    // 標記搜索已使用（用於後續流處理）
                    searchUsedInOnMode = true;

                    // 同時更新 chatManager 和 UI（讓等待訊息立即顯示搜索標記）
                    if (chatManager && chatId) {
                        chatManager.updateLastMessage(chatId, { isSearchUsed: true }, false);
                        // 立即通知 UI 更新，讓等待訊息顯示淺綠色邊框
                        onMessageUpdate(chatId, { content: '', reasoning_content: '', isSearchUsed: true });
                    }
                }
            }
        } catch (error) {
            console.error(`${effectiveSearchConfig.provider} 搜索失败:`, error);
            // 搜索失败不应阻止 API 调用，继续执行
        }
    } else if (webSearchMode === 'on' && !currentApiKey) {
        console.warn(`网络搜索已启用，但未设置 ${effectiveSearchConfig.provider} API Key`);
    }

    // 判断是否使用 Function Calling（自动模式）
    const useToolCalling = webSearchMode === 'auto' && currentApiKey;

    const systemMessage = {
        role: "system",
        content: systemMessageContent
    };

    // 确保消息数组中有系统消息
    // 删除消息列表中的reasoning_content字段，並處理URL映射
    const processedMessages = messages.map(msg => {
        const { reasoning_content, updating, content, ...rest } = msg;

        // 處理content中的URL
        let processedContent = content;
        if (typeof content === 'string') {
            processedContent = extractAndReplaceUrls(content, urlToIdMap, idToUrlMap);
        } else if (Array.isArray(content)) {
            processedContent = content.map(item => {
                if (item.type === 'text' && item.text) {
                    return { ...item, text: extractAndReplaceUrls(item.text, urlToIdMap, idToUrlMap) };
                }
                if (item.type === 'image_url' && item.image_url?.url) {
                    return {
                        type: 'image_url',
                        image_url: {
                            url: item.image_url.url
                        }
                    };
                }
                return item;
            });
        }

        return { ...rest, content: processedContent };
    });

    if (systemMessage.content.trim() && (processedMessages.length === 0 || processedMessages[0].role !== "system")) {
        processedMessages.unshift(systemMessage);
    }

    // 'on' 模式：將搜索結果注入到最後一條 user message（而非 system prompt）
    if (onModeSearchResults) {
        for (let i = processedMessages.length - 1; i >= 0; i--) {
            if (processedMessages[i].role === 'user') {
                const msg = processedMessages[i];
                if (typeof msg.content === 'string') {
                    msg.content = msg.content + '\n\n' + onModeSearchResults;
                } else if (Array.isArray(msg.content)) {
                    // multimodal content：在最後一個 text part 後追加
                    const lastTextIdx = msg.content.findLastIndex(c => c.type === 'text');
                    if (lastTextIdx !== -1) {
                        msg.content[lastTextIdx].text += '\n\n' + onModeSearchResults;
                    } else {
                        msg.content.push({ type: 'text', text: onModeSearchResults });
                    }
                }
                break;
            }
        }
    }

    const controller = new AbortController();
    const signal = controller.signal;

    // 构建请求体
    const requestBody = {
        model: apiConfig.modelName || "gpt-4o",
        messages: processedMessages,
        stream: true,
    };

    // 如果是自动模式，添加工具定义
    if (useToolCalling) {
        requestBody.tools = [WEB_SEARCH_TOOL];
        requestBody.tool_choice = "auto";
    }

    const processStream = async () => {
        let currentMessage = {
            content: '',
            reasoning_content: '',
            // 如果是 'on' 模式且已執行搜索，則初始化為 true
            isSearchUsed: searchUsedInOnMode
        };

        try {
            const response = await withTimeout(
                fetch(apiConfig.baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiConfig.apiKey}`
                    },
                    body: JSON.stringify(requestBody),
                    signal
                }),
                FETCH_TIMEOUT,
                `API 連線超時（${FETCH_TIMEOUT / 1000}秒內未收到回應）`,
                'fetch'
            );

            if (!response.ok) {
                const error = await response.text();
                throw new Error(error);
            }

            // 处理流式响应
            const reader = response.body.getReader();

            let buffer = '';
            let lastUpdateTime = 0;
            let updateTimeout = null;
            const UPDATE_INTERVAL = 100; // 每100ms更新一次
            let isThinking = false; // 新增状态：用于跟踪是否在<think>标签内

            // Function Calling 相关状态
            let toolCalls = [];

            // 超時控制
            let isFirstChunk = true; // 是否等待第一個數據塊
            let lastStreamContentTime = 0; // 上次收到有效流式內容的時間（首次數據到達後才有意義）

            const decoder = new TextDecoder();

            const clearScheduledUpdate = () => {
                if (updateTimeout) {
                    clearTimeout(updateTimeout);
                    updateTimeout = null;
                }
            };

            const updateMessageSnapshot = async ({ isFinalUpdate = false } = {}) => {
                if (!(chatManager && chatId)) {
                    clearScheduledUpdate();
                    return;
                }

                const messageSnapshot = createRestoredMessage(currentMessage, idToUrlMap);
                onMessageUpdate(chatId, messageSnapshot);
                lastUpdateTime = Date.now();
                clearScheduledUpdate();
                await chatManager.updateLastMessage(chatId, messageSnapshot, isFinalUpdate);
            };

            const dispatchUpdate = () => {
                void updateMessageSnapshot({ isFinalUpdate: false }).catch(error => {
                    console.warn('流式消息保存失敗（已忽略）:', error);
                });
            };

            // 僅在整個回覆流程（包含可能的 tool call）完成後觸發一次最終更新
            const finalizeMessage = async () => {
                const MAX_FINALIZE_RETRIES = 2;
                const RETRY_DELAY_MS = 250;

                for (let attempt = 0; attempt <= MAX_FINALIZE_RETRIES; attempt++) {
                    try {
                        await updateMessageSnapshot({ isFinalUpdate: true });
                        return;
                    } catch (error) {
                        const isLastAttempt = attempt === MAX_FINALIZE_RETRIES;
                        if (isLastAttempt) {
                            console.warn('最終消息保存失敗（回覆已完成）:', error);
                            return;
                        }
                        // 最終保存失敗時短暫退避重試，避免將暫時性儲存錯誤誤判為整體請求失敗
                        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
                    }
                }
            };

            while (true) {
                // 計算當前應使用的超時時間
                const { timeout, message: timeoutMessage, type: timeoutType } = calcStreamTimeout(isFirstChunk, lastStreamContentTime);

                // 使用帶超時的 read 操作
                const { done, value } = await withTimeout(
                    reader.read(),
                    timeout,
                    timeoutMessage,
                    timeoutType
                );

                if (done) {
                    clearScheduledUpdate();
                    break;
                }

                    // 收到數據，更新超時控制狀態
                    if (isFirstChunk) {
                        lastStreamContentTime = Date.now();
                    }
                    isFirstChunk = false;

                    const chunk = decoder.decode(value);
                buffer += chunk;
                let hasNewStreamContentInChunk = false;

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);

                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') {
                            continue;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            const delta = parsed.choices[0]?.delta;
                            const finishReason = parsed.choices[0]?.finish_reason;
                            let hasUpdate = false;

                            // 处理 tool_calls
                            if (delta?.tool_calls) {
                                hasNewStreamContentInChunk = true;
                                for (const toolCallDelta of delta.tool_calls) {
                                    const index = toolCallDelta.index;

                                    // 初始化新的 tool call
                                    if (toolCallDelta.id) {
                                        toolCalls[index] = {
                                            id: toolCallDelta.id,
                                            type: toolCallDelta.type,
                                            function: {
                                                name: toolCallDelta.function?.name || '',
                                                arguments: toolCallDelta.function?.arguments || ''
                                            }
                                        };
                                    } else if (toolCalls[index] && toolCallDelta.function?.arguments) {
                                        // 累积 arguments
                                        toolCalls[index].function.arguments += toolCallDelta.function.arguments;
                                    }
                                }
                            }

                            // 优先处理原生reasoning_content
                            if (delta?.reasoning_content) {
                                currentMessage.reasoning_content += delta.reasoning_content;
                                hasUpdate = true;
                                hasNewStreamContentInChunk = true;
                            }

                            if (delta?.content) {
                                let contentBuffer = delta.content;
                                while (contentBuffer.length > 0) {
                                    if (!isThinking) {
                                        const thinkStartIndex = contentBuffer.search(/<think>|<thinking>/);
                                        if (thinkStartIndex !== -1) {
                                            // 将<think>之前的内容添加到正常content
                                            currentMessage.content += contentBuffer.substring(0, thinkStartIndex);
                                            // 移除已处理部分和标签
                                            const tagMatch = contentBuffer.match(/<think>|<thinking>/)[0];
                                            contentBuffer = contentBuffer.substring(thinkStartIndex + tagMatch.length);
                                            isThinking = true;
                                        } else {
                                            // 没有<think>标签，全部是正常content
                                            currentMessage.content += contentBuffer;
                                            contentBuffer = '';
                                        }
                                    }

                                    if (isThinking) {
                                        const thinkEndIndex = contentBuffer.search(/<\/think>|<\/thinking>/);
                                        if (thinkEndIndex !== -1) {
                                            // 将</think>之前的内容添加到reasoning_content
                                            currentMessage.reasoning_content += contentBuffer.substring(0, thinkEndIndex);
                                            // 移除已处理部分和标签
                                            const tagMatch = contentBuffer.match(/<\/think>|<\/thinking>/)[0];
                                            contentBuffer = contentBuffer.substring(thinkEndIndex + tagMatch.length);
                                            isThinking = false;
                                        } else {
                                            // 没有</think>标签，全部是reasoning_content
                                            currentMessage.reasoning_content += contentBuffer;
                                            contentBuffer = '';
                                        }
                                    }
                                }
                                hasUpdate = true;
                                hasNewStreamContentInChunk = true;
                            }


                            if (hasUpdate) {
                                if (!updateTimeout) {
                                     // 如果距离上次更新超过了间隔，则立即更新
                                    if (Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
                                        dispatchUpdate();
                                    } else {
                                         // 否则，设置一个定时器，在间隔的剩余时间后更新
                                        updateTimeout = setTimeout(dispatchUpdate, UPDATE_INTERVAL - (Date.now() - lastUpdateTime));
                                    }
                                }
                            }
                        } catch (e) {
                            console.error('解析数据时出错:', e);
                        }
                    }
                }

                if (hasNewStreamContentInChunk) {
                    lastStreamContentTime = Date.now();
                }
            }

            // 检查是否有 tool calls 需要处理
            if (toolCalls.length > 0 && useToolCalling) {
                console.log('AI 决定调用工具:', toolCalls);

                // 处理每个 tool call
                for (const toolCall of toolCalls) {
                    if (toolCall.function.name === 'web_search') {
                        try {
                            const args = JSON.parse(toolCall.function.arguments);
                            const searchQuery = args.query;

                            console.log('执行 AI 请求的网络搜索:', searchQuery);

                            // 显示搜索状态
                            currentMessage.content = `🔍 正在搜索: "${searchQuery}"...\n\n`;
                            currentMessage.isSearchUsed = true; // 標記搜索已使用
                            dispatchUpdate();

                            // 执行网络搜索（使用統一入口）
                            const searchResults = await webSearch({
                                provider: effectiveSearchConfig.provider,
                                apiKey: currentApiKey,
                                apiUrl: effectiveSearchConfig.provider === 'exa'
                                    ? effectiveSearchConfig.exaApiUrl
                                    : effectiveSearchConfig.tavilyApiUrl,
                                query: searchQuery,
                                searchDepth: 'basic',
                                maxResults: 5,
                                includeAnswer: true
                            });

                            // 搜索完成，显示等待 AI 回复的动画（使用特殊标记）
                            currentMessage.content = '{{WAITING_ANIMATION}}';
                            dispatchUpdate();

                            // 格式化搜索结果，并在发送给AI前映射其中的URL
                            const formattedResults = formatSearchResultsForPrompt(searchResults, userLanguage);
                            const mappedFormattedResults = extractAndReplaceUrls(formattedResults, urlToIdMap, idToUrlMap);

                            // 构建包含工具结果的新消息列表
                            const messagesWithToolResult = [
                                ...processedMessages,
                                {
                                    role: 'assistant',
                                    content: null,
                                    tool_calls: toolCalls.map(tc => ({
                                        id: tc.id,
                                        type: tc.type,
                                        function: {
                                            name: tc.function.name,
                                            arguments: tc.function.arguments
                                        }
                                    }))
                                },
                                {
                                    role: 'tool',
                                    tool_call_id: toolCall.id,
                                    content: mappedFormattedResults || '搜索未返回结果'
                                }
                            ];

                            // 发起第二次 API 调用获取最终回答
                            const secondResponse = await withTimeout(
                                fetch(apiConfig.baseUrl, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'Authorization': `Bearer ${apiConfig.apiKey}`
                                    },
                                    body: JSON.stringify({
                                        model: apiConfig.modelName || "gpt-4o",
                                        messages: messagesWithToolResult,
                                        stream: true,
                                    }),
                                    signal
                                }),
                                FETCH_TIMEOUT,
                                `API 連線超時（${FETCH_TIMEOUT / 1000}秒內未收到回應）`,
                                'fetch'
                            );

                            if (!secondResponse.ok) {
                                const error = await secondResponse.text();
                                throw new Error(error);
                            }

                            // 处理第二次响应的流
                            const secondReader = secondResponse.body.getReader();
                            let secondBuffer = '';
                            currentMessage.content = ''; // 清空等待动画，准备接收 AI 回复

                            // 第二次流的超時控制
                            let isSecondFirstChunk = true;
                            let lastSecondStreamContentTime = 0;

                            // 重置 think 標籤狀態
                            isThinking = false;

                            const secondDecoder = new TextDecoder();

                            while (true) {
                                // 計算當前應使用的超時時間
                                const { timeout: secondTimeout, message: secondTimeoutMessage, type: secondTimeoutType } = calcStreamTimeout(isSecondFirstChunk, lastSecondStreamContentTime);

                                // 使用帶超時的 read 操作
                                const { done: secondDone, value: secondValue } = await withTimeout(
                                    secondReader.read(),
                                    secondTimeout,
                                    secondTimeoutMessage,
                                    secondTimeoutType
                                );

                                if (secondDone) {
                                    clearScheduledUpdate();
                                    break;
                                }

                                // 收到數據，更新超時控制狀態
                                if (isSecondFirstChunk) {
                                    lastSecondStreamContentTime = Date.now();
                                }
                                isSecondFirstChunk = false;

                                const secondChunk = secondDecoder.decode(secondValue);
                                secondBuffer += secondChunk;
                                let hasSecondNewStreamContentInChunk = false;

                                let secondNewlineIndex;
                                while ((secondNewlineIndex = secondBuffer.indexOf('\n')) !== -1) {
                                    const secondLine = secondBuffer.slice(0, secondNewlineIndex);
                                    secondBuffer = secondBuffer.slice(secondNewlineIndex + 1);

                                    if (secondLine.startsWith('data: ')) {
                                        const secondData = secondLine.slice(6);
                                        if (secondData === '[DONE]') continue;

                                        try {
                                            const secondDelta = JSON.parse(secondData).choices[0]?.delta;
                                            let hasUpdate = false;

                                            if (secondDelta?.reasoning_content) {
                                                currentMessage.reasoning_content += secondDelta.reasoning_content;
                                                hasUpdate = true;
                                                hasSecondNewStreamContentInChunk = true;
                                            }

                                            if (secondDelta?.content) {
                                                let contentBuffer = secondDelta.content;
                                                while (contentBuffer.length > 0) {
                                                    if (!isThinking) {
                                                        const thinkStartIndex = contentBuffer.search(/<think>|<thinking>/);
                                                        if (thinkStartIndex !== -1) {
                                                            currentMessage.content += contentBuffer.substring(0, thinkStartIndex);
                                                            const tagMatch = contentBuffer.match(/<think>|<thinking>/)[0];
                                                            contentBuffer = contentBuffer.substring(thinkStartIndex + tagMatch.length);
                                                            isThinking = true;
                                                        } else {
                                                            currentMessage.content += contentBuffer;
                                                            contentBuffer = '';
                                                        }
                                                    }

                                                    if (isThinking) {
                                                        const thinkEndIndex = contentBuffer.search(/<\/think>|<\/thinking>/);
                                                        if (thinkEndIndex !== -1) {
                                                            currentMessage.reasoning_content += contentBuffer.substring(0, thinkEndIndex);
                                                            const tagMatch = contentBuffer.match(/<\/think>|<\/thinking>/)[0];
                                                            contentBuffer = contentBuffer.substring(thinkEndIndex + tagMatch.length);
                                                            isThinking = false;
                                                        } else {
                                                            currentMessage.reasoning_content += contentBuffer;
                                                            contentBuffer = '';
                                                        }
                                                    }
                                                }
                                                hasUpdate = true;
                                                hasSecondNewStreamContentInChunk = true;
                                            }

                                            if (hasUpdate) {
                                                if (!updateTimeout) {
                                                    if (Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
                                                        dispatchUpdate();
                                                    } else {
                                                        updateTimeout = setTimeout(dispatchUpdate, UPDATE_INTERVAL - (Date.now() - lastUpdateTime));
                                                    }
                                                }
                                            }
                                        } catch (e) {
                                            console.error('解析第二次响应数据时出错:', e);
                                        }
                                    }
                                }

                                if (hasSecondNewStreamContentInChunk) {
                                    lastSecondStreamContentTime = Date.now();
                                }
                            }
                        } catch (error) {
                            console.error('处理 web_search tool call 失败:', error);
                            currentMessage.isError = true;
                            currentMessage.content += `\n\n⚠️ 网络搜索失败: ${error.message}`;
                            dispatchUpdate();
                        }
                    }
                }
            }

            // 直到可能的工具調用與第二次回覆都完成後，才做最終更新
            await finalizeMessage();

            return currentMessage;
        } catch (error) {
            // 無論錯誤類型，都嘗試保存已接收的部分內容，避免資料遺失
            if (chatManager && chatId && (currentMessage.content || currentMessage.reasoning_content)) {
                try {
                    const partialMessage = createRestoredMessage(currentMessage, idToUrlMap);
                    // 不使用 isFinalUpdate=true，避免在錯誤路徑觸發標題生成 API
                    chatManager.updateLastMessage(chatId, partialMessage, false);
                    await chatManager.flushSaveChat(chatId);
                } catch (saveError) {
                    console.error('保存部分串流內容失敗:', saveError);
                }
            }
            throw error;
        }
    };

    return {
        processStream,
        controller
    };
}
