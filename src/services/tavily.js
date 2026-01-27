/**
 * Tavily 搜索服務
 * 專為 AI 代理設計的網絡搜索 API
 */

/**
 * Tavily 搜索配置
 * @typedef {Object} TavilySearchConfig
 * @property {string} apiKey - Tavily API 密鑰
 * @property {string} query - 搜索查詢
 * @property {string} [searchDepth='basic'] - 搜索深度 ('basic' | 'advanced')
 * @property {number} [maxResults=5] - 最大結果數量
 * @property {boolean} [includeAnswer=true] - 是否包含 AI 生成的答案
 * @property {boolean} [includeRawContent=false] - 是否包含原始內容
 * @property {string[]} [includeDomains] - 限制搜索的域名
 * @property {string[]} [excludeDomains] - 排除的域名
 */

/**
 * Tavily 搜索結果
 * @typedef {Object} TavilySearchResult
 * @property {string} title - 結果標題
 * @property {string} url - 結果 URL
 * @property {string} content - 結果摘要內容
 * @property {number} score - 相關性分數
 * @property {string} [rawContent] - 原始內容（如果請求）
 */

/**
 * Tavily 搜索響應
 * @typedef {Object} TavilySearchResponse
 * @property {string} [answer] - AI 生成的答案（如果請求）
 * @property {string} query - 原始查詢
 * @property {number} responseTime - 響應時間（秒）
 * @property {TavilySearchResult[]} results - 搜索結果列表
 */

const TAVILY_API_URL = 'https://api.tavily.com/search';

/**
 * 執行 Tavily 網絡搜索
 * @param {TavilySearchConfig} config - 搜索配置
 * @returns {Promise<TavilySearchResponse>} 搜索結果
 * @throws {Error} 當 API 調用失敗時拋出錯誤
 */
export async function tavilySearch({
    apiKey,
    query,
    searchDepth = 'basic',
    maxResults = 5,
    includeAnswer = true,
    includeRawContent = false,
    includeDomains = [],
    excludeDomains = []
}) {
    if (!apiKey) {
        throw new Error('Tavily API Key 未設置');
    }

    if (!query || query.trim() === '') {
        throw new Error('搜索查詢不能為空');
    }

    const requestBody = {
        api_key: apiKey,
        query: query.trim(),
        search_depth: searchDepth,
        max_results: maxResults,
        include_answer: includeAnswer,
        include_raw_content: includeRawContent
    };

    // 只有在有值時才添加域名過濾
    if (includeDomains.length > 0) {
        requestBody.include_domains = includeDomains;
    }
    if (excludeDomains.length > 0) {
        requestBody.exclude_domains = excludeDomains;
    }

    try {
        const response = await fetch(TAVILY_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            let errorMessage = `Tavily API 錯誤: ${response.status}`;
            try {
                const errorData = await response.json();
                if (errorData.detail) {
                    errorMessage += ` - ${errorData.detail}`;
                } else if (errorData.message) {
                    errorMessage += ` - ${errorData.message}`;
                }
            } catch {
                // 忽略 JSON 解析錯誤
            }
            throw new Error(errorMessage);
        }

        const data = await response.json();
        return data;
    } catch (error) {
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            throw new Error('網絡連接失敗，請檢查網絡狀態');
        }
        throw error;
    }
}

/**
 * 格式化 Tavily 搜索結果為系統提示格式
 * @param {TavilySearchResponse} searchResponse - Tavily 搜索響應
 * @param {string} [userLanguage='zh-TW'] - 用戶語言
 * @returns {string} 格式化的搜索結果文本
 */
export function formatSearchResultsForPrompt(searchResponse, userLanguage = 'zh-TW') {
    if (!searchResponse || !searchResponse.results || searchResponse.results.length === 0) {
        return '';
    }

    const isChineseUser = userLanguage.startsWith('zh');
    const header = isChineseUser ? '網絡搜索結果' : 'Web Search Results';
    const answerLabel = isChineseUser ? 'AI 摘要' : 'AI Summary';
    const sourceLabel = isChineseUser ? '來源' : 'Source';

    let formattedText = `\n\n--- ${header} ---\n`;
    formattedText += `查詢: "${searchResponse.query}"\n`;

    // 如果有 AI 生成的答案，先顯示
    if (searchResponse.answer) {
        formattedText += `\n${answerLabel}:\n${searchResponse.answer}\n`;
    }

    // 格式化每個搜索結果
    formattedText += `\n${sourceLabel}:\n`;
    searchResponse.results.forEach((result, index) => {
        formattedText += `\n[${index + 1}] ${result.title}\n`;
        formattedText += `URL: ${result.url}\n`;
        formattedText += `${result.content}\n`;
    });

    return formattedText;
}

/**
 * 檢測用戶消息是否需要網絡搜索
 * 基於關鍵詞和模式匹配來判斷
 * @param {string} message - 用戶消息
 * @returns {boolean} 是否需要搜索
 */
export function shouldPerformSearch(message) {
    if (!message || typeof message !== 'string') {
        return false;
    }

    const lowerMessage = message.toLowerCase();

    // 搜索觸發關鍵詞
    const searchTriggers = [
        // 中文關鍵詞
        '搜索', '搜尋', '查找', '查詢', '找一下', '幫我找', '查一下',
        '最新', '最近', '今天', '昨天', '本週', '這週', '本月',
        '新聞', '消息', '報導', '資訊',
        '價格', '股價', '匯率', '天氣',
        '是什麼', '是誰', '在哪', '怎麼樣', '如何',
        // 英文關鍵詞
        'search', 'find', 'look up', 'google',
        'latest', 'recent', 'today', 'yesterday', 'this week',
        'news', 'price', 'weather', 'stock',
        'what is', 'who is', 'where is', 'how to'
    ];

    // 檢查是否包含觸發關鍵詞
    for (const trigger of searchTriggers) {
        if (lowerMessage.includes(trigger)) {
            return true;
        }
    }

    // 檢查是否是問句（以問號結尾或包含疑問詞）
    if (message.includes('?') || message.includes('？')) {
        // 問句中包含時間相關詞彙時更可能需要搜索
        const timeRelatedWords = ['現在', '目前', '當前', '最新', 'now', 'current', 'latest'];
        for (const word of timeRelatedWords) {
            if (lowerMessage.includes(word)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * 從用戶消息中提取搜索查詢
 * @param {string} message - 用戶消息
 * @returns {string} 提取的搜索查詢
 */
export function extractSearchQuery(message) {
    if (!message || typeof message !== 'string') {
        return '';
    }

    // 移除常見的前綴詞
    let query = message
        .replace(/^(請|幫我|幫忙|麻煩)?/g, '')
        .replace(/^(搜索|搜尋|查找|查詢|找一下|查一下)/g, '')
        .replace(/^(search|find|look up|google)\s*/gi, '')
        .trim();

    // 如果處理後為空，返回原始消息
    return query || message;
}