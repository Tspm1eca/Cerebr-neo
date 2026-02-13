export const DEFAULT_SYSTEM_PROMPT = "```\n# 引用格式\n引用網頁內容時，使用 Text Fragment 連結，格式：`[編號](#:~:text=原文片段)`\n\n## 規則\n1. 無網頁內容時不使用引用\n2. 引用必須是原文，不可改寫\n3. 片段 ≤ 50 字符，選擇有辨識度的文字\n4. 編號按順序遞增\n\n# 超連結映射表\n\n## 格式\n1. 所有URL會以給代號你，比如：`URLREF1`。\n```";

export const WEB_SEARCH_TOOL_DESCRIPTION = `You MUST call this tool to perform a web search in ANY of the following situations:\n\n1. Time-sensitive information: User asks about \"today\", \"latest\", \"recent\", \"now\", \"current\", or any time-related questions\n2. News and events: Any questions about news, events, or what happened\n3. Real-time data: Weather, stock prices, exchange rates, sports scores, prices, or any data that requires real-time updates\n4. People updates: What someone recently did, said, or published\n5. Product information: Latest versions, release dates, update contents\n6. Uncertain facts: Information you are unsure about or might be outdated\n\nExamples that REQUIRE search:\n- \"What's in the news today?\" → MUST search\n- \"Latest news about XXX\" → MUST search\n- \"What time is it now?\" → MUST search\n- \"How's the weather?\" → MUST search\n- \"XXX stock price\" → MUST search\n\nExamples that do NOT require search:\n- \"What is machine learning?\" → No search needed (general knowledge)\n- \"How to write a loop in Python?\" → No search needed (programming knowledge)`;

export const WEB_SEARCH_TOOL_QUERY_DESCRIPTION = `Extract keywords only.\nRules:\n1. Do not analyze or reason about user intent.\n2. Convert the request into short English keywords.\n3. Use official English names when available (e.g., TSMC, iPhone, OpenAI).\n4. Output keywords only, not a sentence, explanation, or punctuation-heavy text.\nExamples:\n- \"今天有什么科技新闻\" -> \"technology news today\"\n- \"台积电股价\" -> \"TSMC stock price\"\n- \"比亚迪最新财报\" -> \"BYD latest earnings report\"\n- \"latest iPhone release\" -> \"iPhone latest release date\"`;

export const DEFAULT_QUICK_CHAT_OPTIONS = [
    {
        id: 'option-1',
        title: '列點總結',
        prompt: '```markdown\\n# 角色\\n你是一位資深的內容分析師與研究員。你的專長是快速閱讀、分析和歸納各種專業文章，並以客觀、中立、精煉的語言，為他人提供高品質的摘要與重點整理。\\n\\n# 任務\\n請你處理下方提供的文章，並嚴格遵循以下指示與格式，用繁體中文輸出結果。\\n\\n## 指示\\n1.  **總結部分**：撰寫一段約 100 字的精煉總結。內容必須準確捕捉文章的核心論點、關鍵證據與最終結論，避免任何不必要的細節或個人評論。\\n2.  **結論部分**：撰寫一段約 200 字的深度結論。請說明文章背後希望傳達的核心訊息、潛在影響或作者的最終呼籲，幫助讀者理解「為什麼這篇文章很重要」以及它帶來的啟示。\\n3.  **觀點部分**：以條列式清單，深入淺出地列出文章中最多10個的主要觀點。每個觀點都應自成一體、邏輯清晰，確保完整傳達作者的意圖。每個觀點上限100字。\\n4.  **名詞部分**：當遇到人、公司、国家名時，使用格式`中文翻释（原文）`。\\n\\n## 輸出格式\\n請嚴格依照以下格式輸出，不要添加任何說明文字或額外格式：\\n🟣 **總結：**\\n* <此處填寫總結內容>\\n🔵 **結論：**\\n* <此處填寫約100字的結論與核心訊息>\\n🟢 **觀點：**\\n* **<觀點標題>：** <觀點內容><引用內容>\\n* **<觀點標題>：** <觀點內容><引用內容>\\n<依此類推>\\n```',
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
        prompt: '```markdown\n# 任務\n以表格方式列出不少於20條最重要的新聞\n\n## 表格格式\n| 中文標題 | 原文標題 |\n| :--- | :--- |\n| 中文標題 <引用內容> | <新聞連結> |\n```',
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
