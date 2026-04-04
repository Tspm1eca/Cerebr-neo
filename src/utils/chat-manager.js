import { storageAdapter, sessionStorageAdapter, isExtensionEnvironment } from './storage-adapter.js';
import { generateTitle } from '../services/title-generator.js';
import { HISTORY_LIMIT_THRESHOLD } from '../constants/history.js';
import { t } from './i18n.js';

export const CHAT_KEY_PREFIX = 'cerebr_chat_'; // Per-chat key 前綴
export const CHAT_INDEX_KEY = 'cerebr_chat_index'; // 輕量索引
export const CURRENT_CHAT_BY_TAB_KEY = 'cerebr_current_chat_by_tab';
const DIRTY_CHAT_IDS_KEY = 'cerebr_dirty_chat_ids';
const ACTIVE_STREAMS_BY_TAB_KEY = 'cerebr_active_stream_by_tab';
const GLOBAL_CHAT_SCOPE = '__global__';
const LOCAL_CHAT_SYNC_IGNORE_WINDOW_MS = 1200;

export class ChatManager {
    constructor() {
        this.storage = storageAdapter;
        this.sessionStorage = sessionStorageAdapter;
        this.currentChatId = null;
        this.currentChatByTab = {};
        this._transientChatByScope = {};
        this.chats = new Map();
        this.apiConfig = null; // 用于存储API配置
        this.onDemandLoader = null; // WebDAV 按需下載回調
        this._dirtyChatIds = new Set(); // WebDAV 同步用：追蹤被修改的聊天
        this._saveDebounceTimers = new Map(); // 流式更新時的 per-chat debounce 計時器
        this._chatIndex = []; // 記憶體中維護的輕量索引
        this._streamingChatId = null; // 正在串流回覆的聊天 ID
        this._pendingInitialize = false; // 串流期間是否有待補執行的 initialize()
        this._onDeferredInitComplete = null; // 延遲 initialize 完成後的回調
        this._activeStreamsByTab = new Map();
        this._ownedStream = null;
        this._initialized = false;
        this._lastLocalChatMutationAt = 0;
        this.uiContext = {
            contextId: null,
            uiType: 'unknown',
            tabId: null,
            windowId: null
        };

        if (isExtensionEnvironment && chrome.storage?.onChanged) {
            chrome.storage.onChanged.addListener((changes, areaName) => {
                if (areaName === 'session' && changes[ACTIVE_STREAMS_BY_TAB_KEY]) {
                    this._applyActiveStreamsSnapshot(changes[ACTIVE_STREAMS_BY_TAB_KEY].newValue);
                }
            });
        }
    }

    // ==================== Per-Chat 儲存輔助方法 ====================

    /**
     * 建構 per-chat 的 storage key
     */
    _chatKey(chatId) {
        return CHAT_KEY_PREFIX + chatId;
    }

    _markLocalChatMutation() {
        this._lastLocalChatMutationAt = Date.now();
    }

    async _setChatStorage(data) {
        this._markLocalChatMutation();
        await this.storage.set(data);
    }

    async _removeChatStorage(keys) {
        this._markLocalChatMutation();
        await this.storage.remove(keys);
    }

    isChatStorageChange(changes, areaName) {
        if (!changes || typeof changes !== 'object') {
            return false;
        }

        if (areaName === 'local') {
            return Object.keys(changes).some((key) =>
                key === CHAT_INDEX_KEY ||
                key.startsWith(CHAT_KEY_PREFIX)
            );
        }

        if (areaName === 'session') {
            return Object.prototype.hasOwnProperty.call(changes, CURRENT_CHAT_BY_TAB_KEY);
        }

        return false;
    }

    shouldIgnoreLocalChatSync(graceMs = LOCAL_CHAT_SYNC_IGNORE_WINDOW_MS) {
        return Date.now() - this._lastLocalChatMutationAt < graceMs;
    }

    /**
     * 從 chat 物件建構輕量索引條目（不含 messages）
     */
    _buildIndexEntry(chat) {
        return {
            id: chat.id,
            title: chat.title,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt || chat.createdAt,
            webpageUrls: chat.webpageUrls || [],
            messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
            _remoteOnly: chat._remoteOnly || false,
            _webdavHydrated: chat._webdavHydrated || false
        };
    }

    /**
     * 從目前記憶體中的 chats Map 重建完整索引（僅用於批次操作）
     */
    _buildCurrentIndex() {
        this._chatIndex = Array.from(this.chats.values())
            .filter(chat => !chat.isNew)
            .map(chat => this._buildIndexEntry(chat));
        return this._chatIndex;
    }

    /**
     * 增量更新索引中的單一條目（O(1) 查找 + 更新）
     * @param {string} chatId - 要更新的聊天 ID
     */
    _updateIndexEntry(chatId) {
        const chat = this.chats.get(chatId);
        if (!chat || chat.isNew) return;

        const entry = this._buildIndexEntry(chat);
        const idx = this._chatIndex.findIndex(e => e.id === chatId);
        if (idx !== -1) {
            this._chatIndex[idx] = entry;
        } else {
            this._chatIndex.push(entry);
        }
    }

    /**
     * 從索引中移除指定的條目
     * @param {string} chatId - 要移除的聊天 ID
     */
    _removeIndexEntry(chatId) {
        const idx = this._chatIndex.findIndex(e => e.id === chatId);
        if (idx !== -1) {
            this._chatIndex.splice(idx, 1);
        }
    }

    setUiContext(context = {}) {
        this.uiContext = {
            ...this.uiContext,
            ...context
        };
        return this.uiContext;
    }

    _getChatScopeKey(tabId = this.uiContext.tabId) {
        return Number.isInteger(tabId) ? String(tabId) : GLOBAL_CHAT_SCOPE;
    }

    async _loadCurrentChatMappings() {
        const result = await this.sessionStorage.get(CURRENT_CHAT_BY_TAB_KEY);
        this.currentChatByTab = result[CURRENT_CHAT_BY_TAB_KEY] && typeof result[CURRENT_CHAT_BY_TAB_KEY] === 'object'
            ? { ...result[CURRENT_CHAT_BY_TAB_KEY] }
            : {};
    }

    async _persistCurrentChatMappings() {
        await this.sessionStorage.set({
            [CURRENT_CHAT_BY_TAB_KEY]: this.currentChatByTab
        });
    }

    _setTransientChatForScope(scopeKey, chatId = null) {
        if (!scopeKey) {
            return;
        }

        if (chatId) {
            this._transientChatByScope[scopeKey] = chatId;
            return;
        }

        delete this._transientChatByScope[scopeKey];
    }

    _getTransientChatForScope(scopeKey = this._getChatScopeKey()) {
        const chatId = this._transientChatByScope[scopeKey];
        if (!chatId) {
            return null;
        }

        const chat = this.chats.get(chatId);
        if (chat && chat.isNew && chat.messages.length === 0) {
            return chat;
        }

        delete this._transientChatByScope[scopeKey];
        return null;
    }

    _removeChatFromScopeMappings(chatId) {
        let sessionChanged = false;

        Object.keys(this.currentChatByTab).forEach((scopeKey) => {
            if (this.currentChatByTab[scopeKey] === chatId) {
                delete this.currentChatByTab[scopeKey];
                sessionChanged = true;
            }
        });

        Object.keys(this._transientChatByScope).forEach((scopeKey) => {
            if (this._transientChatByScope[scopeKey] === chatId) {
                delete this._transientChatByScope[scopeKey];
            }
        });

        return sessionChanged;
    }

    async bindChatToCurrentContext(chatId = this.currentChatId, scopeKey = this._getChatScopeKey()) {
        if (!chatId || !this.chats.has(chatId)) {
            return null;
        }

        this.currentChatId = chatId;
        this.currentChatByTab[scopeKey] = chatId;
        this._setTransientChatForScope(scopeKey, null);
        await this._persistCurrentChatMappings();
        return this.chats.get(chatId);
    }

    async _ensureCurrentChatForContext() {
        const scopeKey = this._getChatScopeKey();
        const scopedChatId = this.currentChatByTab[scopeKey];

        if (scopedChatId && this.chats.has(scopedChatId)) {
            this.currentChatId = scopedChatId;
            this._setTransientChatForScope(scopeKey, null);
            return this.chats.get(scopedChatId);
        }

        if (scopedChatId) {
            delete this.currentChatByTab[scopeKey];
            await this._persistCurrentChatMappings();
        }

        const transientChat = this._getTransientChatForScope(scopeKey);
        if (transientChat) {
            this.currentChatId = transientChat.id;
            return transientChat;
        }

        const defaultChat = this.createNewChat('默认对话');
        this.currentChatId = defaultChat.id;
        this._setTransientChatForScope(scopeKey, defaultChat.id);
        return defaultChat;
    }

    _applyActiveStreamsSnapshot(snapshot) {
        this._activeStreamsByTab = new Map(Object.entries(snapshot || {}));
    }

    _getActiveStreamsSnapshot() {
        return Object.fromEntries(this._activeStreamsByTab);
    }

    async _loadActiveStreamsFromSession() {
        const result = await this.sessionStorage.get(ACTIVE_STREAMS_BY_TAB_KEY);
        this._applyActiveStreamsSnapshot(result[ACTIVE_STREAMS_BY_TAB_KEY]);
    }

    _findActiveStreamByChatId(chatId) {
        if (!chatId) return null;
        for (const stream of this._activeStreamsByTab.values()) {
            if (stream?.chatId === chatId) {
                return stream;
            }
        }
        return null;
    }

    getActiveStreams() {
        return Array.from(this._activeStreamsByTab.values()).filter((stream) => Boolean(stream?.requestId));
    }

    getConflictingActiveStream({ tabId = this.uiContext.tabId } = {}) {
        const currentScopeKey = this._getChatScopeKey(tabId);
        const currentScopeStream = this._activeStreamsByTab.get(currentScopeKey);

        if (currentScopeStream?.requestId) {
            return null;
        }

        for (const [scopeKey, streamRecord] of this._activeStreamsByTab.entries()) {
            if (!streamRecord?.requestId) {
                continue;
            }
            if (scopeKey === currentScopeKey) {
                continue;
            }
            return streamRecord;
        }

        return null;
    }

    hasConflictingActiveStream(options = {}) {
        return Boolean(this.getConflictingActiveStream(options));
    }

    canFlushChat(chatId) {
        const activeStream = this._findActiveStreamByChatId(chatId);
        return !activeStream || activeStream.ownerContextId === this.uiContext.contextId;
    }

    isStreamOwner(chatId) {
        const activeStream = this._findActiveStreamByChatId(chatId);
        return Boolean(activeStream && activeStream.ownerContextId === this.uiContext.contextId);
    }

    async claimStreamOwnership({ chatId, requestId, tabId = this.uiContext.tabId } = {}) {
        if (!chatId || !requestId) return null;

        const scopeKey = this._getChatScopeKey(tabId);
        const streamRecord = {
            requestId,
            chatId,
            tabId: Number.isInteger(tabId) ? tabId : null,
            ownerContextId: this.uiContext.contextId,
            uiType: this.uiContext.uiType
        };

        this._activeStreamsByTab.set(scopeKey, streamRecord);
        this._ownedStream = streamRecord;
        await this.sessionStorage.set({
            [ACTIVE_STREAMS_BY_TAB_KEY]: this._getActiveStreamsSnapshot()
        });
        this.setStreamingChatId(chatId);
        return streamRecord;
    }

    async releaseStreamOwnership({ requestId = this._ownedStream?.requestId } = {}) {
        if (!requestId) {
            return;
        }

        let streamRemoved = false;
        for (const [scopeKey, activeStream] of this._activeStreamsByTab.entries()) {
            if (
                activeStream &&
                activeStream.requestId === requestId &&
                activeStream.ownerContextId === this.uiContext.contextId
            ) {
                this._activeStreamsByTab.delete(scopeKey);
                streamRemoved = true;
                break;
            }
        }

        if (streamRemoved) {
            await this.sessionStorage.set({
                [ACTIVE_STREAMS_BY_TAB_KEY]: this._getActiveStreamsSnapshot()
            });
        }

        if (this._ownedStream?.requestId === requestId) {
            this._ownedStream = null;
            this.setStreamingChatId(null);
        }
    }

    // ==================== WebDAV Dirty Flag 管理 ====================

    /**
     * 設定按需下載回調（由 main.js 在 WebDAV 啟用時設定）
     * @param {Function} loader - async (chatId) => { ok, data, error }
     */
    setOnDemandLoader(loader) {
        this.onDemandLoader = loader;
    }

    /**
     * 標記聊天為 dirty（WebDAV 同步用）
     * 只在 Set 新增元素時才持久化，避免 AI 串流期間重複寫入
     */
    markChatDirty(chatId) {
        if (!chatId) return;
        const chat = this.chats.get(chatId);
        if (chat) {
            delete chat._webdavHydrated;
            delete chat._webdavHash;
            delete chat._webdavMessageCount;
        }
        if (!this._dirtyChatIds.has(chatId)) {
            this._dirtyChatIds.add(chatId);
            this.storage.set({ [DIRTY_CHAT_IDS_KEY]: [...this._dirtyChatIds] }).catch(() => {});
        }
    }

    getDirtyChatIds() {
        return this._dirtyChatIds;
    }

    /**
     * 清除指定的 dirty flags（同步完成後呼叫）
     * @param {Iterable<string>} ids - 要清除的 chat IDs，不傳則清除全部
     */
    clearDirtyChatIds(ids) {
        if (ids) {
            for (const id of ids) {
                this._dirtyChatIds.delete(id);
            }
        } else {
            this._dirtyChatIds.clear();
        }
        this.storage.set({ [DIRTY_CHAT_IDS_KEY]: [...this._dirtyChatIds] }).catch(() => {});
    }

    setApiConfig(config) {
        this.apiConfig = config;
    }

    /**
     * 設定正在串流回覆的聊天 ID
     * @param {string|null} chatId - 聊天 ID，串流結束時傳入 null
     */
    setStreamingChatId(chatId) {
        this._streamingChatId = chatId;
        if (!chatId && this._pendingInitialize) {
            this._pendingInitialize = false;
            this.initialize().then(() => {
                this._onDeferredInitComplete?.();
            });
        }
    }

    // ==================== 初始化 ====================

    async initialize() {
        // 串流進行中，延遲初始化，避免清除記憶體中的串流資料
        if (this._streamingChatId) {
            this._pendingInitialize = true;
            return;
        }

        this.chats.clear();

        // 載入 per-chat index
        const indexResult = await this.storage.get(CHAT_INDEX_KEY);
        const chatIndex = indexResult[CHAT_INDEX_KEY];

        if (chatIndex && Array.isArray(chatIndex) && chatIndex.length > 0) {
            await this._loadFromPerChatKeys(chatIndex);
        }
        // 空陣列或不存在：chats Map 保持空（新安裝）

        // 從載入的 chats 建構記憶體索引
        this._buildCurrentIndex();

        await this._loadCurrentChatMappings();
        await this._ensureCurrentChatForContext();
        await this._loadActiveStreamsFromSession();

        // 載入持久化的 dirty flags（處理擴充套件重啟）
        try {
            const dirtyResult = await this.storage.get(DIRTY_CHAT_IDS_KEY);
            const savedDirty = dirtyResult[DIRTY_CHAT_IDS_KEY];
            if (Array.isArray(savedDirty)) {
                this._dirtyChatIds = new Set(savedDirty);
            }
        } catch {
            // 載入失敗不影響正常運作
        }

        this._initialized = true;
    }

    async _refreshChatsFromStorage() {
        const indexResult = await this.storage.get(CHAT_INDEX_KEY);
        const chatIndex = Array.isArray(indexResult[CHAT_INDEX_KEY]) ? indexResult[CHAT_INDEX_KEY] : [];
        const nextChatIds = new Set(chatIndex.map(entry => entry.id));
        const entriesToFetch = [];

        for (const entry of chatIndex) {
            const activeStream = this._findActiveStreamByChatId(entry.id);
            if (activeStream && activeStream.ownerContextId === this.uiContext.contextId) {
                continue;
            }

            const existingChat = this.chats.get(entry.id);
            const existingMessageCount = Array.isArray(existingChat?.messages) ? existingChat.messages.length : 0;
            const shouldRefresh = entry._remoteOnly
                ? !existingChat || existingChat._remoteOnly
                : (
                    !existingChat ||
                    existingChat._remoteOnly ||
                    existingChat.updatedAt !== entry.updatedAt ||
                    existingChat.title !== entry.title ||
                    existingMessageCount !== entry.messageCount
                );

            if (!shouldRefresh) {
                continue;
            }

            if (entry._remoteOnly) {
                this.chats.set(entry.id, {
                    id: entry.id,
                    title: entry.title,
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                    webpageUrls: entry.webpageUrls || [],
                    messages: [],
                    _remoteOnly: true
                });
            } else {
                entriesToFetch.push(entry);
            }
        }

        if (entriesToFetch.length > 0) {
            const keys = entriesToFetch.map(entry => this._chatKey(entry.id));
            const results = await this.storage.get(keys);
            for (const entry of entriesToFetch) {
                const storedChat = results[this._chatKey(entry.id)];
                if (storedChat) {
                    this.chats.set(entry.id, storedChat);
                }
            }
        }

        for (const [chatId, chat] of this.chats.entries()) {
            if (!chat.isNew && !nextChatIds.has(chatId)) {
                this.chats.delete(chatId);
            }
        }

        this._chatIndex = chatIndex;
    }

    async switchUiContext(context = {}) {
        this.setUiContext(context);
        await this._loadCurrentChatMappings();
        await this._loadActiveStreamsFromSession();

        if (!this._initialized) {
            await this.initialize();
            return this.getCurrentChat();
        }

        await this._refreshChatsFromStorage();
        await this._ensureCurrentChatForContext();
        return this.getCurrentChat();
    }

    /**
     * 從 per-chat keys 載入聊天（新格式）
     */
    async _loadFromPerChatKeys(chatIndex) {
        // 分離需要從儲存載入的聊天和 remoteOnly 空殼
        const entriesToFetch = [];
        const remoteOnlyEntries = [];

        for (const entry of chatIndex) {
            if (entry._remoteOnly) {
                remoteOnlyEntries.push(entry);
            } else {
                entriesToFetch.push(entry);
            }
        }

        // 批次讀取所有非 remoteOnly 的聊天
        if (entriesToFetch.length > 0) {
            const keys = entriesToFetch.map(e => this._chatKey(e.id));
            const results = await this.storage.get(keys);

            for (const entry of entriesToFetch) {
                const chatData = results[this._chatKey(entry.id)];
                if (chatData) {
                    this.chats.set(entry.id, chatData);
                }
                // 若 chatData 缺失（孤兒索引），跳過
            }
        }

        // 重建 remoteOnly 空殼
        for (const entry of remoteOnlyEntries) {
            this.chats.set(entry.id, {
                id: entry.id,
                title: entry.title,
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt,
                webpageUrls: entry.webpageUrls || [],
                messages: [],
                _remoteOnly: true
            });
        }
    }

    // ==================== Per-Chat 儲存操作 ====================

    /**
     * 儲存單一聊天 — 只寫入該聊天的 key 和增量更新索引
     * @param {string} chatId - 要儲存的聊天 ID
     */
    async saveChat(chatId) {
        const chat = this.chats.get(chatId);
        if (!chat || chat.isNew) return;
        if (!this.canFlushChat(chatId)) return;

        this._updateIndexEntry(chatId);
        try {
            await this._setChatStorage({
                [this._chatKey(chatId)]: chat,
                [CHAT_INDEX_KEY]: this._chatIndex
            });
        } catch (error) {
            console.error(`儲存聊天 ${chatId} 失敗:`, error);
            // 不向上拋出：記憶體中的資料仍是最新的，
            // 下次 saveChat 呼叫（如 debounce 觸發或使用者下一則訊息）會重試寫入
        }
    }

    _touchChatUpdatedAt(chatId) {
        const chat = this.chats.get(chatId);
        if (chat) {
            chat.updatedAt = new Date().toISOString();
        }
        return chat;
    }

    async persistModifiedChat(chatId) {
        if (!chatId) return;
        if (!this.canFlushChat(chatId)) return;
        this._touchChatUpdatedAt(chatId);
        this.markChatDirty(chatId);
        await this.saveChat(chatId);
    }

    /**
     * 延遲儲存單一聊天 — 用於流式更新期間，避免頻繁寫入。
     * 每個 chatId 獨立計時，多次呼叫只會在最後一次呼叫後 500ms 執行一次寫入。
     */
    _debouncedSaveChat(chatId) {
        if (!this.canFlushChat(chatId)) return;
        const existingTimer = this._saveDebounceTimers.get(chatId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this._saveDebounceTimers.delete(chatId);
            this.saveChat(chatId);
        }, 500);
        this._saveDebounceTimers.set(chatId, timer);
    }

    /**
     * 立即寫入單一聊天並取消待處理的 debounce — 用於流式結束時的最終儲存。
     */
    async flushSaveChat(chatId) {
        if (!chatId) return;
        if (!this.canFlushChat(chatId)) return;
        const existingTimer = this._saveDebounceTimers.get(chatId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this._saveDebounceTimers.delete(chatId);
        }
        await this.saveChat(chatId);
    }

    // ==================== WebDAV 同步用輔助方法 ====================

    /**
     * 回傳所有聊天的陣列（從記憶體 Map 讀取，無 I/O）
     * 供 WebDAV 同步層使用
     */
    getAllChatsArray() {
        return Array.from(this.chats.values()).filter(chat => !chat.isNew);
    }

    /**
     * 替換所有本地聊天（供 WebDAV 同步下載後使用）
     * 寫入所有 per-chat keys + 清理孤兒 keys + 更新索引
     * @param {Array} chatsArray - 合併後的聊天陣列
     * @param {Set<string>} [dirtyIds] - 需要寫入 storage 的聊天 ID（不傳則全量寫入）
     */
    async replaceAllChats(chatsArray, dirtyIds) {
        // 記錄舊的 chat IDs，用於清理孤兒 keys
        const oldChatIds = new Set(this.chats.keys());

        this.chats.clear();

        const dataToWrite = {};
        const indexEntries = [];
        const newChatIds = new Set();
        const keysToRemove = new Set();
        const writeAll = !dirtyIds;

        for (const chat of chatsArray) {
            this.chats.set(chat.id, chat);
            newChatIds.add(chat.id);
            if (!chat.isNew) {
                if (chat._remoteOnly) {
                    keysToRemove.add(this._chatKey(chat.id));
                } else if (writeAll || dirtyIds.has(chat.id)) {
                    dataToWrite[this._chatKey(chat.id)] = chat;
                }
                indexEntries.push(this._buildIndexEntry(chat));
            }
        }
        dataToWrite[CHAT_INDEX_KEY] = indexEntries;
        this._chatIndex = indexEntries;

        // 寫入新資料
        await this._setChatStorage(dataToWrite);

        // 清理孤兒 keys（舊的 chat 不在新列表中）
        for (const oldId of oldChatIds) {
            if (!newChatIds.has(oldId)) {
                keysToRemove.add(this._chatKey(oldId));
            }
        }
        if (keysToRemove.size > 0) {
            await this._removeChatStorage([...keysToRemove]);
        }
    }

    // ==================== CRUD 操作 ====================

    createNewChat(title = '新对话') {
        const chatId = Date.now().toString();
        const chat = {
            id: chatId,
            title: title,
            messages: [],
            createdAt: new Date().toISOString(),
            webpageUrls: [], // Add this to store webpage URLs
            isNew: true // 添加一个标记来识别新创建的、尚未保存的对话
        };
        this.chats.set(chatId, chat);
        return chat;
    }

    async switchChat(chatId, options = {}) {
        if (!this.chats.has(chatId)) {
            throw new Error(t('chat.notFound'));
        }

        const {
            allowRemoteOnlyFallback = false,
            persistScopeBinding = true
        } = options;
        const chat = this.chats.get(chatId);

        // 按需載入：如果聊天標記為 _remoteOnly，從 WebDAV 下載完整內容
        if (chat._remoteOnly && this.onDemandLoader) {
            let loadResult;
            try {
                loadResult = await this.onDemandLoader(chatId);
            } catch (error) {
                loadResult = { ok: false, data: null, error };
            }

            const fullChat = loadResult && typeof loadResult === 'object' && Object.prototype.hasOwnProperty.call(loadResult, 'ok')
                ? loadResult.data
                : loadResult;
            if (fullChat) {
                delete fullChat._remoteOnly;
                fullChat._webdavHydrated = true;
                fullChat._webdavHash = chat._webdavHash || null;
                fullChat._webdavMessageCount = Number.isFinite(chat._webdavMessageCount)
                    ? chat._webdavMessageCount
                    : (Array.isArray(fullChat.messages) ? fullChat.messages.length : 0);
                this.chats.set(chatId, fullChat);
                await this.saveChat(chatId);
            } else {
                const loadError = loadResult?.error instanceof Error
                    ? loadResult.error
                    : new Error(t('chat.remoteLoadFailed', { error: t('common.unknown') }));
                console.warn(`[ChatManager] 按需下載聊天 ${chatId} 失敗:`, loadError);
                if (!allowRemoteOnlyFallback) {
                    throw loadError;
                }
            }
        }

        this.currentChatId = chatId;
        const scopeKey = this._getChatScopeKey();
        if (persistScopeBinding) {
            await this.bindChatToCurrentContext(chatId, scopeKey);
        } else {
            this._setTransientChatForScope(scopeKey, chatId);
        }
        return this.chats.get(chatId);
    }

    async deleteChat(chatId) {
        if (!this.chats.has(chatId)) {
            throw new Error(t('chat.notFound'));
        }
        this.chats.delete(chatId);
        this._removeIndexEntry(chatId);
        const sessionChanged = this._removeChatFromScopeMappings(chatId);

        // 更新索引並移除 per-chat key
        const pendingWrites = [
            this._setChatStorage({
                [CHAT_INDEX_KEY]: this._chatIndex
            })
        ];
        if (sessionChanged) {
            pendingWrites.push(this._persistCurrentChatMappings());
        }
        await Promise.all(pendingWrites);
        this._removeChatStorage(this._chatKey(chatId)).catch(() => {});

        // 通知 WebDAV 同步記錄刪除
        document.dispatchEvent(new CustomEvent('chat-deleted', { detail: { chatId } }));

        // 如果删除的是当前对话，切换到其他对话
        if (chatId === this.currentChatId) {
            const remainingChats = this.getAllChats();
            let switched = false;

            for (const nextChat of remainingChats) {
                try {
                    await this.switchChat(nextChat.id);
                    this.currentChatId = nextChat.id;
                    switched = true;
                    break;
                } catch (error) {
                    console.warn(`[ChatManager] 刪除後切換聊天 ${nextChat.id} 失敗:`, error);
                }
            }

            if (!switched) {
                const newChat = this.createNewChat('默认对话');
                this.currentChatId = newChat.id;
                this._setTransientChatForScope(this._getChatScopeKey(), newChat.id);
            }
        }
    }

    getCurrentChat() {
        return this.chats.get(this.currentChatId);
    }

    getChat(chatId) {
        return this.chats.get(chatId);
    }

    getAllChats() {
        return Array.from(this.chats.values())
            .filter(chat => !chat.isNew || chat.messages.length > 0) // 过滤掉未保存的新对话
            .sort((a, b) =>
                new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
            );
    }

    /**
     * 獲取歷史紀錄數量
     * @returns {number} 歷史紀錄的數量
     */
    getChatCount() {
        return this.getAllChats().length;
    }

    /**
     * 自動清理超過限制的歷史記錄
     * @param {number} limit - 歷史記錄上限
     * @returns {Promise<number>} 刪除的數量
     */
    async autoCleanupHistory(limit = HISTORY_LIMIT_THRESHOLD) {
        const allChats = this.getAllChats();
        const chatCount = allChats.length;

        if (chatCount > limit) {
            const excessCount = chatCount - limit;
            // getAllChats 返回的是按創建時間降序排列的，所以最舊的在最後
            const chatsToDelete = allChats.slice(-excessCount);

            const deletedIds = [];
            for (const chat of chatsToDelete) {
                // 不刪除當前正在使用的對話
                if (chat.id !== this.currentChatId) {
                    this.chats.delete(chat.id);
                    this._removeIndexEntry(chat.id);
                    deletedIds.push(chat.id);
                }
            }

            if (deletedIds.length > 0) {
                let sessionChanged = false;
                deletedIds.forEach((id) => {
                    sessionChanged = sessionChanged || this._removeChatFromScopeMappings(id);
                });

                // 清理 dirty flags，避免 WebDAV 同步嘗試同步已刪除的聊天
                this.clearDirtyChatIds(deletedIds);

                // 通知 WebDAV 同步記錄刪除
                for (const id of deletedIds) {
                    document.dispatchEvent(new CustomEvent('chat-deleted', { detail: { chatId: id } }));
                }

                const keysToRemove = deletedIds.map(id => this._chatKey(id));
                const pendingWrites = [
                    this._setChatStorage({ [CHAT_INDEX_KEY]: this._chatIndex })
                ];
                if (sessionChanged) {
                    pendingWrites.push(this._persistCurrentChatMappings());
                }
                await Promise.all(pendingWrites);
                this._removeChatStorage(keysToRemove).catch(() => {});
            }

            return deletedIds.length;
        }
        return 0;
    }

    async addMessageToCurrentChat(message, webpageInfo) {
        const currentChat = this.getCurrentChat();
        if (!currentChat) {
            throw new Error(t('chat.noActiveChat'));
        }

        const isFirstMessage = currentChat.isNew && currentChat.messages.length === 0;

        currentChat.messages.push(message);
        this._touchChatUpdatedAt(currentChat.id);
        this.markChatDirty(currentChat.id);

        // If there's webpage info, add the URLs to the chat
        if (webpageInfo && webpageInfo.pages) {
            const urls = webpageInfo.pages.map(page => page.url);
            // Use a Set to avoid duplicate URLs
            const uniqueUrls = new Set([...(currentChat.webpageUrls || []), ...urls]);
            currentChat.webpageUrls = Array.from(uniqueUrls);
        }

        // 如果这是第一条消息，只移除 isNew 标记，不在此处生成标题
        if (isFirstMessage) {
            delete currentChat.isNew;
            await this.bindChatToCurrentContext(currentChat.id);
            // 设置临时标题
            const userMessage = currentChat.messages.find(m => m.role === 'user');
            if (userMessage) {
                let fallbackTitle = '';
                if (typeof userMessage.content === 'string') {
                    fallbackTitle = userMessage.content.substring(0, 20);
                } else if (Array.isArray(userMessage.content)) {
                    const textPart = userMessage.content.find(p => p.type === 'text');
                    if (textPart) {
                        fallbackTitle = textPart.text.substring(0, 20);
                    }
                }
                if (fallbackTitle) {
                    currentChat.title = fallbackTitle;
                    document.dispatchEvent(new CustomEvent('chat-title-updated', { detail: { chatId: currentChat.id, newTitle: fallbackTitle } }));
                }
            }

            // 當創建新對話時，自動清理超過限制的歷史紀錄
            // 使用 setTimeout 確保不阻塞當前操作，並在下一個事件循環中執行
            setTimeout(() => {
                this.autoCleanupHistory(HISTORY_LIMIT_THRESHOLD).then(deletedCount => {
                    if (deletedCount > 0) {
                        console.log(`已自動刪除 ${deletedCount} 條舊的歷史紀錄`);
                        // 觸發事件通知 UI 更新歷史紀錄列表
                        document.dispatchEvent(new CustomEvent('history-auto-cleaned', { detail: { deletedCount } }));
                    }
                });
            }, 0);
        }

        await this.saveChat(currentChat.id);
    }

    async generateAndSaveTitle(chat) {
        if (!this.apiConfig) {
            console.warn("API config not set in ChatManager, skipping title generation.");
            return; // 临时标题已设置，此处无需操作
        }

        // 确保我们有足够的内容来生成标题
        if (chat.messages.length < 2) return;

        const newTitle = await generateTitle(chat.messages, this.apiConfig);
        if (newTitle && newTitle !== chat.title) {
            chat.title = newTitle;
            await this.persistModifiedChat(chat.id);
            // 通知UI更新
            document.dispatchEvent(new CustomEvent('chat-title-updated', { detail: { chatId: chat.id, newTitle } }));
        }
    }

    async updateLastMessage(chatId, message, isFinalUpdate = false) {
        if (!this.canFlushChat(chatId)) {
            return;
        }

        const currentChat = this.chats.get(chatId);
        if (!currentChat || currentChat.messages.length === 0) {
            return;
        }

        // 确保最后一条消息是 assistant 消息
        if (currentChat.messages[currentChat.messages.length - 1].role === 'user') {
            currentChat.messages.push({
                role: 'assistant',
                content: '', // 初始化 content
                updating: true
            });
        }

        const lastMessage = currentChat.messages[currentChat.messages.length - 1];
        if (Object.prototype.hasOwnProperty.call(message, 'content')) {
            lastMessage.content = message.content;
        }
        if (Object.prototype.hasOwnProperty.call(message, 'reasoning_content')) {
            lastMessage.reasoning_content = message.reasoning_content;
        }
        if (message.isSearchUsed) {
            lastMessage.isSearchUsed = true;
        }
        if (Object.prototype.hasOwnProperty.call(message, 'isError')) {
            if (message.isError === true) {
                lastMessage.isError = true;
            } else {
                delete lastMessage.isError;
            }
        }

        this.markChatDirty(chatId);

        // 当流式响应结束时，触发标题生成
        if (isFinalUpdate) {
            delete lastMessage.updating;
            this._touchChatUpdatedAt(chatId);
            // 检查是否是第一次AI回复（即对话中只有两条消息，一条user，一条assistant）
            if (currentChat.messages.length === 2) {
                this.generateAndSaveTitle(currentChat);
            }
            await this.flushSaveChat(chatId);
        } else {
            // 串流中間更新：使用 debounce 定期寫入（500ms 防抖）
            // 確保頁面崩潰時最多只丟失 500ms 的內容
            this._debouncedSaveChat(chatId);
        }
    }

    async popMessage(chatId = this.currentChatId) {
        if (!chatId || !this.canFlushChat(chatId)) {
            return;
        }

        const currentChat = this.chats.get(chatId);
        if (!currentChat) {
            throw new Error(t('chat.notFound'));
        }
        currentChat.messages.pop();
        this._touchChatUpdatedAt(currentChat.id);
        this.markChatDirty(currentChat.id);
        await this.saveChat(chatId);
    }

    async clearCurrentChat() {
        const currentChat = this.getCurrentChat();
        if (currentChat) {
            currentChat.messages = [];
            this._touchChatUpdatedAt(currentChat.id);
            this.markChatDirty(currentChat.id);
            await this.saveChat(this.currentChatId);
        }
    }

    async clearAllChats() {
        // 通知 WebDAV 同步記錄所有刪除（批次發送一次事件）
        const allIds = Array.from(this.chats.keys());
        if (allIds.length > 0) {
            document.dispatchEvent(new CustomEvent('chats-cleared', { detail: { chatIds: allIds } }));
        }

        // 移除所有 per-chat keys
        const keysToRemove = allIds.map(id => this._chatKey(id));
        if (keysToRemove.length > 0) {
            await this._removeChatStorage(keysToRemove);
        }

        // 清除記憶體
        this.chats.clear();

        // 寫入空索引
        this._chatIndex = [];
        this.currentChatByTab = {};
        this._transientChatByScope = {};
        await Promise.all([
            this._setChatStorage({
                [CHAT_INDEX_KEY]: []
            }),
            this._persistCurrentChatMappings()
        ]);

        // 創建一個新的默認對話
        const defaultChat = this.createNewChat('默认对话');
        this.currentChatId = defaultChat.id;
        this._setTransientChatForScope(this._getChatScopeKey(), this.currentChatId);

        return defaultChat;
    }
}

// 创建并导出单例实例
export const chatManager = new ChatManager();
