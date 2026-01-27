/**
 * API配置接口
 * @typedef {Object} APIConfig
 * @property {string} baseUrl - API的基础URL
 * @property {string} apiKey - API密钥
 * @property {string} [modelName] - 模型名称，默认为 "gpt-4o"
 * @property {string} [tavilyApiKey] - Tavily API 密钥（用于网络搜索）
 */

import { DEFAULT_SYSTEM_PROMPT } from '../components/api-card.js';
import { tavilySearch, formatSearchResultsForPrompt } from './tavily.js';

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

    // 匹配URL的正規表示式
    const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;

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
    enableWebSearch = false,
    searchQuery = null,
    tavilyApiKey = null
}, chatManager, chatId, onMessageUpdate) {
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey) {
        throw new Error('API 配置不完整');
    }

    // 初始化URL映射表
    const urlToIdMap = new Map();
    const idToUrlMap = new Map();

    // 构建系统消息
    let systemMessageContent = '';

    if (webpageInfo && webpageInfo.pages && webpageInfo.pages.length > 0) {
        let systemPrompt = apiConfig.advancedSettings?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
        systemPrompt = systemPrompt.replace(/\{\{userLanguage\}\}/gm, userLanguage);

        const pagesContent = webpageInfo.pages.map(page => {
            const prefix = page.isCurrent ? '当前网页内容' : '其他打开的网页';
            const contentWithMappedUrls = extractAndReplaceUrls(page.content, urlToIdMap, idToUrlMap);
            // URL本身也映射，以防模型引用
            // const mappedUrl = extractAndReplaceUrls(page.url, urlToIdMap, idToUrlMap);
            // 決定不映射頁面元數據中的URL，因為這對用戶識別很重要，且數量少
            return `\n${prefix}：\n标题：${page.title}\nURL：${page.url}\n内容：${contentWithMappedUrls}`;
        }).join('\n\n---\n');

        systemMessageContent = `${systemPrompt}${pagesContent}`;
    }

    // 处理网络搜索
    if (enableWebSearch && tavilyApiKey) {
        try {
            // 获取搜索查询：使用自定义查询或最后一条用户消息
            let query = searchQuery;
            if (!query) {
                const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
                if (lastUserMessage) {
                    query = typeof lastUserMessage.content === 'string'
                        ? lastUserMessage.content
                        : lastUserMessage.content.find(c => c.type === 'text')?.text || '';
                }
            }

            if (query) {
                console.log('执行 Tavily 网络搜索:', query);
                const searchResults = await tavilySearch({
                    apiKey: tavilyApiKey,
                    query: query,
                    searchDepth: 'basic',
                    maxResults: 5,
                    includeAnswer: true
                });

                // 将搜索结果添加到系统消息
                const formattedResults = formatSearchResultsForPrompt(searchResults, userLanguage);
                if (formattedResults) {
                    // 如果之前没有系统消息内容，添加基础提示
                    if (!systemMessageContent) {
                        systemMessageContent = `你是一个有帮助的AI助手。请使用用户的语言（${userLanguage}）回答问题。以下是从网络搜索获取的最新信息，请基于这些信息回答用户的问题：`;
                    }
                    systemMessageContent += formattedResults;
                    console.log('已添加网络搜索结果到系统提示');
                }
            }
        } catch (error) {
            console.error('Tavily 搜索失败:', error);
            // 搜索失败不应阻止 API 调用，继续执行
        }
    } else if (enableWebSearch && !tavilyApiKey) {
        console.warn('网络搜索已启用，但未设置 Tavily API Key');
    }

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
                return item;
            });
        }

        return { ...rest, content: processedContent };
    });

    if (systemMessage.content.trim() && (processedMessages.length === 0 || processedMessages[0].role !== "system")) {
        processedMessages.unshift(systemMessage);
    }

    const controller = new AbortController();
    const signal = controller.signal;

    const response = await fetch(apiConfig.baseUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiConfig.apiKey}`
        },
        body: JSON.stringify({
            model: apiConfig.modelName || "gpt-4o",
            messages: processedMessages,
            stream: true,
        }),
        signal
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(error);
    }

    // 处理流式响应
    const reader = response.body.getReader();

    const processStream = async () => {
        try {
            let buffer = '';
            let currentMessage = {
                content: '',
                reasoning_content: ''
            };
            let lastUpdateTime = 0;
            let updateTimeout = null;
            const UPDATE_INTERVAL = 100; // 每100ms更新一次
            let isThinking = false; // 新增状态：用于跟踪是否在<think>标签内

            const dispatchUpdate = () => {
                if (chatManager && chatId) {
                    // 创建一个副本以避免回调函数意外修改
                    const messageCopy = { ...currentMessage };

                    // 還原URL
                    if (messageCopy.content) {
                        messageCopy.content = restoreUrls(messageCopy.content, idToUrlMap);
                    }
                    if (messageCopy.reasoning_content) {
                        messageCopy.reasoning_content = restoreUrls(messageCopy.reasoning_content, idToUrlMap);
                    }

                    chatManager.updateLastMessage(chatId, messageCopy, false); // 流式更新
                    onMessageUpdate(chatId, messageCopy);
                    lastUpdateTime = Date.now();
                }
                if (updateTimeout) {
                    clearTimeout(updateTimeout);
                    updateTimeout = null;
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    // 确保最后的数据被发送
                   if (Date.now() - lastUpdateTime > 0) {
                       dispatchUpdate();
                   }
                   // 流结束，进行最终更新
                   // 最終更新也需要還原URL
                   const finalMessage = { ...currentMessage };
                   if (finalMessage.content) {
                       finalMessage.content = restoreUrls(finalMessage.content, idToUrlMap);
                   }
                   if (finalMessage.reasoning_content) {
                       finalMessage.reasoning_content = restoreUrls(finalMessage.reasoning_content, idToUrlMap);
                   }

                   chatManager.updateLastMessage(chatId, finalMessage, true);
                   break;
               }

                const chunk = new TextDecoder().decode(value);
                buffer += chunk;

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
                            const delta = JSON.parse(data).choices[0]?.delta;
                            let hasUpdate = false;

                            // 优先处理原生reasoning_content
                            if (delta?.reasoning_content) {
                                currentMessage.reasoning_content += delta.reasoning_content;
                                hasUpdate = true;
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
            }

            return currentMessage;
        } catch (error) {
            if (error.name === 'AbortError') {
                return;
            }
            throw error;
        }
    };

    return {
        processStream,
        controller
    };
}
