/**
 * 網絡搜索服務
 * 支持 Tavily 和 Exa 搜索 API
 */

/**
 * 搜索配置
 * @typedef {Object} SearchConfig
 * @property {string} provider - 搜索提供者 ('tavily' | 'exa')
 * @property {string} apiKey - API 密鑰
 * @property {string} [apiUrl] - 自定義 API URL
 * @property {string} query - 搜索查詢
 * @property {string} [searchDepth='basic'] - 搜索深度 ('basic' | 'advanced')
 * @property {number} [maxResults=5] - 最大結果數量
 * @property {boolean} [includeAnswer=true] - 是否包含 AI 生成的答案
 * @property {boolean} [includeRawContent=false] - 是否包含原始內容
 * @property {string[]} [includeDomains] - 限制搜索的域名
 * @property {string[]} [excludeDomains] - 排除的域名
 */

/**
 * 搜索結果
 * @typedef {Object} SearchResult
 * @property {string} title - 結果標題
 * @property {string} url - 結果 URL
 * @property {string} content - 結果摘要內容
 * @property {number} score - 相關性分數
 * @property {string} [rawContent] - 原始內容（如果請求）
 */

/**
 * 搜索響應
 * @typedef {Object} SearchResponse
 * @property {string} [answer] - AI 生成的答案（如果請求）
 * @property {string} query - 原始查詢
 * @property {number} responseTime - 響應時間（秒）
 * @property {SearchResult[]} results - 搜索結果列表
 */

const DEFAULT_TAVILY_API_URL = 'https://api.tavily.com/search';
const DEFAULT_EXA_API_URL = 'https://api.exa.ai/search';

/**
 * 執行網絡搜索（統一入口）
 * @param {SearchConfig} config - 搜索配置
 * @returns {Promise<SearchResponse>} 搜索結果
 * @throws {Error} 當 API 調用失敗時拋出錯誤
 */
export async function webSearch(config) {
    const provider = config.provider || 'tavily';

    if (provider === 'exa') {
        return exaSearch(config);
    }
    return tavilySearch(config);
}

/**
 * 執行 Tavily 網絡搜索
 * @param {SearchConfig} config - 搜索配置
 * @returns {Promise<SearchResponse>} 搜索結果
 * @throws {Error} 當 API 調用失敗時拋出錯誤
 */
export async function tavilySearch({
    apiKey,
    apiUrl,
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

    // 使用自定義 URL 或默認 URL，自動添加 /search 路徑
    let url = DEFAULT_TAVILY_API_URL;
    if (apiUrl && apiUrl.trim()) {
        let baseUrl = apiUrl.trim();
        // 移除結尾的斜線
        baseUrl = baseUrl.replace(/\/+$/, '');
        // 如果用戶沒有添加 /search，自動添加
        if (!baseUrl.endsWith('/search')) {
            baseUrl += '/search';
        }
        url = baseUrl;
    }

    try {
        const response = await fetch(url, {
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
 * 執行 Exa 網絡搜索
 * @param {SearchConfig} config - 搜索配置
 * @returns {Promise<SearchResponse>} 搜索結果
 * @throws {Error} 當 API 調用失敗時拋出錯誤
 */
export async function exaSearch({
    apiKey,
    apiUrl,
    query,
    maxResults = 5,
    includeAnswer = false,
    includeDomains = [],
    excludeDomains = []
}) {
    if (!apiKey) {
        throw new Error('Exa API Key 未設置');
    }

    if (!query || query.trim() === '') {
        throw new Error('搜索查詢不能為空');
    }

    const requestBody = {
        query: query.trim(),
        numResults: maxResults,
        contents: {
            text: true
        }
    };

    // Exa 的域名過濾
    if (includeDomains.length > 0) {
        requestBody.includeDomains = includeDomains;
    }
    if (excludeDomains.length > 0) {
        requestBody.excludeDomains = excludeDomains;
    }

    // 使用自定義 URL 或默認 URL，自動添加 /search 路徑
    let url = DEFAULT_EXA_API_URL;
    if (apiUrl && apiUrl.trim()) {
        let baseUrl = apiUrl.trim();
        // 移除結尾的斜線
        baseUrl = baseUrl.replace(/\/+$/, '');
        // 如果用戶沒有添加 /search，自動添加
        if (!baseUrl.endsWith('/search')) {
            baseUrl += '/search';
        }
        url = baseUrl;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            let errorMessage = `Exa API 錯誤: ${response.status}`;
            try {
                const errorData = await response.json();
                if (errorData.error) {
                    errorMessage += ` - ${errorData.error}`;
                } else if (errorData.message) {
                    errorMessage += ` - ${errorData.message}`;
                }
            } catch {
                // 忽略 JSON 解析錯誤
            }
            throw new Error(errorMessage);
        }

        const data = await response.json();

        // 將 Exa 響應格式轉換為統一格式
        return normalizeExaResponse(data, query);
    } catch (error) {
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            throw new Error('網絡連接失敗，請檢查網絡狀態');
        }
        throw error;
    }
}

/**
 * 將 Exa 響應格式轉換為統一格式
 * @param {Object} exaResponse - Exa API 響應
 * @param {string} query - 原始查詢
 * @returns {SearchResponse} 統一格式的搜索響應
 */
function normalizeExaResponse(exaResponse, query) {
    const results = (exaResponse.results || []).map(result => ({
        title: result.title || '',
        url: result.url || '',
        content: result.text || result.snippet || '',
        score: result.score || 0,
        rawContent: result.text || ''
    }));

    return {
        query: query,
        responseTime: exaResponse.requestId ? 0 : 0, // Exa 不提供響應時間
        results: results,
        answer: null // Exa 不提供 AI 答案
    };
}

/**
 * 格式化 Tavily 搜索結果為系統提示格式
 * @param {TavilySearchResponse} searchResponse - Tavily 搜索響應
 * @param {string} [userLanguage=navigator.language] - 用戶語言
 * @returns {string} 格式化的搜索結果文本
 */
export function formatSearchResultsForPrompt(searchResponse) {
    if (!searchResponse || !searchResponse.results || searchResponse.results.length === 0) {
        return '';
    }

    const header = 'Web Search Results';
    const answerLabel = 'AI Summary';
    const sourceLabel = 'Source';

    let formattedText = `# ${header}\n`;
    formattedText += `Query: "${searchResponse.query}"\n`;

    // 如果有 AI 生成的答案，先顯示
    if (searchResponse.answer) {
        formattedText += `\n## ${answerLabel}:\n${searchResponse.answer}\n`;
    }

    // 格式化每個搜索結果
    formattedText += `\n## ${sourceLabel}:\n`;
    searchResponse.results.forEach((result) => {
        const titleText = result.title || '';
        const contentText = result.content || '';
        const combinedText = `${titleText}${contentText}`;
        const contentWithUrlRef = result.url
            ? `${combinedText} (${result.url})`
            : combinedText;
        formattedText += `\n${contentWithUrlRef}\n`;
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
