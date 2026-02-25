export const DEFAULT_SYSTEM_PROMPT = "```\n# 格式\n- 使用 Text Fragment 連結引用網頁內容，格式：`[數字編號](#:~:text=纯文本原文片段)`\n- 超連結格式：`[標題](URLREF1)`\n\n## 規則\n1. 無網頁內容時不使用引用\n2. 引用必須是原文，不可改寫\n3. 片段 ≤ 50 字符，選擇有辨識度的文字\n4. 數字編號按順序遞增\n5. 所有URL會以給代號你，比如：`URLREF1`\n\n## 範例\n- 錯誤引用：請點擊 1 送出。[1](#:~:text=按鈕 A)\n- 正確引用：請點擊按鈕 A 送出。[1](#:~:text=按鈕 A)\n```";

export const WEB_SEARCH_TOOL_DESCRIPTION = `You MUST call this tool to perform a web search in ANY of the following situations:\n\n1. Time-sensitive information: User asks about \"today\", \"latest\", \"recent\", \"now\", \"current\", or any time-related questions\n2. News and events: Any questions about news, events, or what happened\n3. Real-time data: Weather, stock prices, exchange rates, sports scores, prices, or any data that requires real-time updates\n4. People updates: What someone recently did, said, or published\n5. Product information: Latest versions, release dates, update contents\n6. Uncertain facts: Information you are unsure about or might be outdated\n\nExamples that REQUIRE search:\n- \"What's in the news today?\" → MUST search\n- \"Latest news about XXX\" → MUST search\n- \"What time is it now?\" → MUST search\n- \"How's the weather?\" → MUST search\n- \"XXX stock price\" → MUST search\n\nExamples that do NOT require search:\n- \"What is machine learning?\" → No search needed (general knowledge)\n- \"How to write a loop in Python?\" → No search needed (programming knowledge)`;

export const WEB_SEARCH_TOOL_QUERY_DESCRIPTION = `**Return short English keywords only.**\nRules:\n1. Do not analyze or reason about user intent.\n2. Convert the request into short English keywords.\n3. Use official English names when available (e.g., TSMC, iPhone, OpenAI).\n4. Output keywords only, not a sentence, explanation, or punctuation-heavy text.\nExamples:\n- \"今天有什么科技新闻\" -> \"technology news today\"\n- \"台积电股价\" -> \"TSMC stock price\"\n- \"比亚迪最新财报\" -> \"BYD latest earnings report\"\n- \"latest iPhone release\" -> \"iPhone latest release date\"`;

export const DEFAULT_QUICK_CHAT_OPTIONS = [
    {
        id: 'option-1',
        title: '列點總結',
        prompt: '```\n# 任務\n分析下方文章，用繁體中文依指定格式輸出摘要。\n\n## 規則\n- **總結**：約100字，涵蓋核心論點、關鍵證據與結論，不加個人評論，不使用引用。\n- **結論**：約200字，說明文章的核心訊息、潛在影響或作者的呼籲，解釋這篇文章的隱喻、為何重要及其啟示，不使用引用。\n- **觀點**：條列最多10點，每點上限100字，自成一體、邏輯清晰。每點須附引用佐證。\n- **譯名**：人名、公司、國家一律使用 `中文翻譯（原文）` 格式。\n- **連結**：除了引用內容外，回覆中禁止出現任何超連結。\n\n## 輸出格式\n🟣 **總結：**\n* <總結內容>\n🔵 **結論：**\n* <結論內容>\n🟢 **觀點：**\n* **<觀點標題>：** <觀點內容> [1](#:~:text=原文片段)\n* **<觀點標題>：** <觀點內容> [2](#:~:text=原文片段)\n```',
        icon: '📝'
    },
    {
        id: 'option-2',
        title: '200字總結',
        prompt: '```plaintext\\n用約200字總結網頁內容，不需要引用內容。\\n```',
        icon: '✨'
    },
    {
        id: 'option-3',
        title: '列出新聞',
        prompt: '```markdown\n# 任務\n以表格方式列出不少於20條最重要的新聞\n\n## 表格格式\n| 中文標題 | 原文標題 |\n| :--- | :--- |\n| 中文標題 [1](#:~:text=原文片段) | <新聞連結> |\n| 中文標題 [2](#:~:text=原文片段) | <新聞連結> |\n```',
        icon: '📰'
    }
].map((option) => ({
    ...option,
    prompt: option.prompt.replaceAll('\\n', '\n')
}));

export const DEFAULT_NEW_QUICK_CHAT_PROMPT = '请输入您的提示词';

export const TITLE_GENERATION_PROMPT = `根據以下對話內容，生成一個簡潔、準確、不超過 15 個字的標題。請直接返回標題文字，不要包含任何引號或多餘的解釋。\n對話內容：\n`;

export function createDefaultQuickChatOptions() {
    return DEFAULT_QUICK_CHAT_OPTIONS.map((option) => ({ ...option }));
}
