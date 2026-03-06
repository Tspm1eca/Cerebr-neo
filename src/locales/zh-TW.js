/**
 * 繁體中文語言包 (zh-TW) — 預設語言
 */
export default {
    // ===== 通用 =====
    common: {
        cancel: '取消',
        confirm: '確定',
        save: '儲存',
        delete: '刪除',
        reset: '重置',
        close: '關閉',
        loading: '載入中...',
        unknown: '未知',
        error: '錯誤',
        success: '成功',
    },

    // ===== 右鍵選單 =====
    contextMenu: {
        edit: '修改',
        copyMessage: '複製訊息',
        copyCode: '複製程式碼',
        copyImage: '複製圖片',
        copyMath: '複製公式',
        regenerate: '重新生成',
        deleteMessage: '刪除訊息',
    },

    // ===== 輸入框 =====
    input: {
        placeholder: '輸入訊息',
        newChat: '新對話',
        stopResponse: '停止生成',
        searchModel: '搜尋模型',
        configureApiFirst: '請先配置 API',
        noMatchingModels: '沒有匹配的模型',
    },

    // ===== 設定選單 =====
    settingsMenu: {
        sendWebpage: '傳送網頁',
        webSearch: '網路搜尋',
        sidePanel: '側欄模式',
        floatingMode: '浮窗模式',
        webpageContent: '網頁內容',
        history: '歷史',
        settings: '設定',
    },

    // ===== 設定頁面 =====
    settings: {
        title: '設定',
        tabQuickChat: '快速選項',
        tabApiSettings: 'API 設定',
        tabWebdav: 'WebDAV',
    },

    // ===== 快速選項 =====
    quickChat: {
        addOption: '新增選項',
        resetAll: '重置所有為預設',
        emptyTitle: '還沒有常用選項',
        emptyHint: '點擊下方按鈕新增您的第一個選項',
        titlePlaceholder: '選項標題',
        promptPlaceholder: '輸入提示詞',
        expandEdit: '展開編輯',
        newOption: '新選項',
        maxOptionsAlert: '最多只能新增四個快速選項。',
        defaultNewPrompt: '請輸入您的提示詞',
        // 預設選項
        defaultOption1Title: '列點總結',
        defaultOption2Title: '200字總結',
        defaultOption3Title: '列出新聞',
    },

    // ===== API 設定 =====
    api: {
        configLabel: 'API配置',
        profileDefault: '配置 {{index}}',
        renameProfile: '重新命名配置',
        addProfile: '新增配置',
        deleteProfile: '刪除當前配置',
        apiKey: 'API Key',
        apiKeyPlaceholder: '輸入 API Key',
        baseUrl: 'Base URL',
        chatModel: '對話模型',
        modelPlaceholder: '輸入模型名稱',
        titleModel: '標題生成模型',
        titleModelPlaceholder: '輸入模型名稱（可選）',
        systemPrompt: '系統提示词',
        systemPromptPlaceholder: '輸入系統提示詞',
        expandEdit: '展開編輯',
        resetPrompt: '還原預設提示詞',
        testConnection: '測試連線',
        webSearch: '網路搜尋',
        optionalNoSearch: '(可選，無需添加 /search)',
        tavilyApiKeyPlaceholder: '輸入 Tavily API Key',
        exaApiKeyPlaceholder: '輸入 Exa API Key',
        // 錯誤訊息
        notFoundMainCard: '找不到主 API 卡片元素',
        atLeastOneProfile: '至少需要保留一個配置',
        enterApiKeyAndUrl: '請輸入API Key和Base URL',
        cannotFetchModels: '無法取得模型列表',
        enterAllFields: '請輸入 API Key, Base URL, 和模型名稱',
        connectionFailed: '連線失敗',
        testMessage: 'ok，你好',
        apiIncomplete: 'API 配置不完整',
    },

    // ===== WebDAV =====
    webdav: {
        enableWebdav: '啟用 WebDAV',
        serverUrl: '伺服器位址',
        username: '使用者名稱',
        usernamePlaceholder: '輸入使用者名稱',
        password: '密碼',
        passwordPlaceholder: '輸入密碼',
        togglePassword: '顯示/隱藏密碼',
        syncPath: '同步路徑 (可選)',
        syncApiConfig: '同步API配置',
        encryptApiConfig: '加密API配置',
        encryptionPassword: '加密密碼',
        encryptionPasswordPlaceholder: '輸入加密密碼',
        encryptionHint: '請牢記密碼，遺失後無法恢復加密資料',
        warningUnencrypted: 'API 配置以明文儲存',
        warningEncrypted: 'API 配置以加密儲存',
        warningNeedPassword: '輸入加密密碼以啟用同步',
        syncNow: '立即同步',
        lastSync: '上次同步：',
        neverSynced: '從未同步',
        connectionFailed: 'WebDAV 連線失敗',
        enableFirst: '請先啟用 WebDAV',
        uploadFailed: '上傳失敗: ',
        enableSyncFirst: '請先啟用 WebDAV 同步',
        syncFailed: '同步失敗',
        webdavSyncFailed: 'WebDAV 同步失敗',
        conflictTitle: '同步衝突',
        conflictMessage: '本機和雲端資料都有變更，請選擇要保留的版本：',
        useLocal: '使用本機資料',
        useRemote: '使用雲端資料',
        conflictDialogMissing: '衝突對話框元素不存在，使用自動解決',
        syncSuccess: '同步成功',
    },

    // ===== 聊天列表 =====
    chatList: {
        title: '歷史',
        searchPlaceholder: '搜尋對話',
        clearAll: '清除所有對話',
        newChat: '新對話',
        clearAllConfirm: '您確定要清除所有對話歷史記錄嗎？',
        clearAllWarning: '此操作無法撤銷。',
        allCleared: '所有對話已清除',
        clearFailed: '清除對話失敗: ',
    },

    // ===== 模態框 =====
    modal: {
        editSystemPrompt: '編輯系統提示',
        editPrompt: '編輯提示詞',
        renameProfileTitle: '重新命名配置',
        renameProfileLabel: '請輸入新的配置名稱：',
        renameProfilePlaceholder: '配置名稱',
        deleteProfileConfirm: '確定要刪除當前配置嗎？',
        cannotUndo: '此操作無法撤銷。',
        resetQuickChatConfirm: '您確定要重置為預設選項嗎？',
        resetQuickChatWarning: '此操作將刪除所有自訂選項且無法撤銷。',
        deleteQuickChatConfirm: '確定要刪除這個選項嗎？',
        resetPromptConfirm: '確定要還原系統提示為預設值嗎？',
    },

    // ===== CSS 內容 (用 JS 注入) =====
    css: {
        notFound: '未找到',
        cannotJump: '無法跳轉',
    },

    // ===== 聊天容器 =====
    chat: {
        copyImageFailed: '複製圖片失敗，請稍後重試。',
        editCancel: '取消',
        editSave: '儲存',
        editSaveAndResend: '儲存並重新傳送',
    },

    // ===== 服務層錯誤 =====
    service: {
        waitingTimeout: '等待 AI 回應逾時（{{seconds}}秒內未收到任何資料）',
        streamTimeout: '串流回應逾時（{{seconds}}秒內未收到新內容）',
        fetchTimeout: 'API 連線逾時（{{seconds}}秒內未收到回應）',
        keywordEmpty: '關鍵字提取輸入為空',
        keywordApiIncomplete: 'API 配置不完整，無法提取關鍵字',
        keywordTimeout: '關鍵字提取連線逾時（{{seconds}}秒內未收到回應）',
        keywordTimeoutShort: '關鍵字提取逾時: ',
        keywordRequestFailed: '關鍵字提取請求失敗: ',
        keywordApiError: '關鍵字提取 API 錯誤: ',
        keywordParseFailed: '關鍵字提取回應解析失敗：返回非 JSON',
        keywordResultEmpty: '關鍵字提取為空',
        searchNoQuery: '網路搜尋已開啟，但未找到可用的提取關鍵字的文字查詢',
        searchNoResults: '搜尋未返回結果',
        searching: '🔍 正在搜尋: "{{query}}"...\n\n',
        webSearchFailed: '⚠️ 網路搜尋失敗: {{message}}',
        regenerateFailed: '重新生成失敗: {{message}}',
        sendFailed: '傳送失敗: {{message}}',
        youtubeExtractFailed: '無法提取 YouTube 字幕。',
        tavilyKeyMissing: 'Tavily API Key 未設定',
        exaKeyMissing: 'Exa API Key 未設定',
        searchQueryEmpty: '搜尋查詢不能為空',
        tavilyApiError: 'Tavily API 錯誤: ',
        exaApiError: 'Exa API 錯誤: ',
        networkError: '網路連線失敗，請檢查網路狀態',
        tavilyConnectionFailed: 'Tavily 連線失敗',
        exaConnectionFailed: 'Exa 連線失敗',
    },

    // ===== 提示詞切換按鈕 =====
    searchProvider: {
        switchTitle: '點擊切換搜尋提供者：Tavily ↔ Exa',
        triStateTitle: '點擊切換：關閉 → 自動 → 開啟',
        triStateOff: '關閉 - 點擊切換到自動',
        triStateAuto: '自動（AI 決定）- 點擊切換到開啟',
        triStateOn: '開啟 - 點擊切換到關閉',
        currentTavily: '當前: Tavily - 點擊切換到 Exa',
        currentExa: '當前: Exa - 點擊切換到 Tavily',
        enterTavilyKey: '請輸入 Tavily API Key',
        enterExaKey: '請輸入 Exa API Key',
    },
};
