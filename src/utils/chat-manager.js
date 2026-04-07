import { storageAdapter, sessionStorageAdapter, isExtensionEnvironment } from './storage-adapter.js';
import { generateTitle } from '../services/title-generator.js';
import { HISTORY_LIMIT_THRESHOLD } from '../constants/history.js';
import { t } from './i18n.js';
import {
    ACTIVE_STREAM_HEARTBEAT_INTERVAL_MS,
    ACTIVE_STREAMS_BY_TAB_KEY,
    createActiveStreamRecord,
    normalizeActiveStreamsSnapshot,
    pruneStoredActiveStreams,
    touchActiveStreamRecord
} from './active-streams.js';

export const CHAT_KEY_PREFIX = 'cerebr_chat_'; // Per-chat key 前綴
export const CHAT_INDEX_KEY = 'cerebr_chat_index'; // 輕量索引
export const CURRENT_CHAT_BY_TAB_KEY = 'cerebr_current_chat_by_tab';
export { ACTIVE_STREAMS_BY_TAB_KEY };
const DIRTY_CHAT_IDS_KEY = 'cerebr_dirty_chat_ids';
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
        this._ownedStreamHeartbeatTimer = null;
        this._chatMutationInterrupter = null;
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

    shouldIgnoreLocalChatSync(graceMs = LOCAL_CHAT_SYNC_IGNORE_WINDOW_MS) {
        return Date.now() - this._lastLocalChatMutationAt < graceMs;
    }

    _findIndexEntry(indexValue, chatId) {
        if (!Array.isArray(indexValue) || !chatId) {
            return null;
        }
        return indexValue.find((entry) => entry?.id === chatId) || null;
    }

    _didIndexEntryChangeForChat(oldIndex, newIndex, chatId) {
        if (!chatId) {
            return false;
        }

        const previousEntry = this._findIndexEntry(oldIndex, chatId);
        const nextEntry = this._findIndexEntry(newIndex, chatId);
        return JSON.stringify(previousEntry || null) !== JSON.stringify(nextEntry || null);
    }

    getChatStorageSyncImpact(changes, areaName, {
        tabId = this.uiContext.tabId,
        currentChatId = this.currentChatId
    } = {}) {
        const impact = {
            hasChatChange: false,
            affectsChatList: false,
            affectsCurrentChat: false
        };

        if (!changes || typeof changes !== 'object') {
            return impact;
        }

        if (areaName === 'local') {
            const changedKeys = Object.keys(changes);
            const hasChatStorageChange = changedKeys.some((key) =>
                key === CHAT_INDEX_KEY || key.startsWith(CHAT_KEY_PREFIX)
            );

            if (!hasChatStorageChange) {
                return impact;
            }

            impact.hasChatChange = true;
            impact.affectsChatList = changedKeys.includes(CHAT_INDEX_KEY);

            if (currentChatId) {
                const currentChatKey = this._chatKey(currentChatId);
                if (Object.prototype.hasOwnProperty.call(changes, currentChatKey)) {
                    impact.affectsCurrentChat = true;
                } else if (changes[CHAT_INDEX_KEY]) {
                    impact.affectsCurrentChat = this._didIndexEntryChangeForChat(
                        changes[CHAT_INDEX_KEY].oldValue,
                        changes[CHAT_INDEX_KEY].newValue,
                        currentChatId
                    );
                }
            } else {
                impact.affectsCurrentChat = impact.affectsChatList;
            }

            return impact;
        }

        if (areaName === 'session' && Object.prototype.hasOwnProperty.call(changes, CURRENT_CHAT_BY_TAB_KEY)) {
            const scopeKey = this._getChatScopeKey(tabId);
            const previousMappings = changes[CURRENT_CHAT_BY_TAB_KEY].oldValue || {};
            const nextMappings = changes[CURRENT_CHAT_BY_TAB_KEY].newValue || {};

            if ((previousMappings?.[scopeKey] || null) !== (nextMappings?.[scopeKey] || null)) {
                impact.hasChatChange = true;
                impact.affectsChatList = true;
                impact.affectsCurrentChat = true;
            }
        }

        return impact;
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

    _sortChatIndexEntries(indexEntries = []) {
        return [...indexEntries].sort((a, b) =>
            new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
        );
    }

    _normalizeChatIndex(indexValue) {
        if (!Array.isArray(indexValue)) {
            return [];
        }

        const seen = new Set();
        const normalized = [];
        for (const entry of indexValue) {
            if (!entry?.id || seen.has(entry.id)) {
                continue;
            }
            seen.add(entry.id);
            normalized.push({
                ...entry,
                webpageUrls: Array.isArray(entry.webpageUrls) ? entry.webpageUrls : [],
                messageCount: Number.isFinite(entry.messageCount) ? entry.messageCount : 0
            });
        }

        return this._sortChatIndexEntries(normalized);
    }

    _upsertIndexEntries(indexEntries, entriesToUpsert = []) {
        if (!Array.isArray(indexEntries) || !Array.isArray(entriesToUpsert)) {
            return false;
        }

        let changed = false;
        entriesToUpsert.forEach((entry) => {
            if (!entry?.id) {
                return;
            }
            const index = indexEntries.findIndex((item) => item?.id === entry.id);
            if (index === -1) {
                indexEntries.push(entry);
                changed = true;
                return;
            }

            if (JSON.stringify(indexEntries[index]) !== JSON.stringify(entry)) {
                indexEntries[index] = entry;
                changed = true;
            }
        });

        return changed;
    }

    _removeIndexEntries(indexEntries, chatIds = []) {
        if (!Array.isArray(indexEntries) || !Array.isArray(chatIds) || chatIds.length === 0) {
            return false;
        }

        const idsToRemove = new Set(chatIds.filter(Boolean));
        const initialLength = indexEntries.length;
        for (let i = indexEntries.length - 1; i >= 0; i--) {
            if (idsToRemove.has(indexEntries[i]?.id)) {
                indexEntries.splice(i, 1);
            }
        }

        return indexEntries.length !== initialLength;
    }

    async _updateCurrentChatMappings(mutator) {
        const result = await this.sessionStorage.get(CURRENT_CHAT_BY_TAB_KEY);
        const nextMappings = result[CURRENT_CHAT_BY_TAB_KEY] && typeof result[CURRENT_CHAT_BY_TAB_KEY] === 'object'
            ? { ...result[CURRENT_CHAT_BY_TAB_KEY] }
            : {};
        const changed = mutator(nextMappings) === true;
        this.currentChatByTab = nextMappings;
        if (changed) {
            await this.sessionStorage.set({
                [CURRENT_CHAT_BY_TAB_KEY]: nextMappings
            });
        }
        return nextMappings;
    }

    async _updateActiveStreams(mutator) {
        const result = await this.sessionStorage.get(ACTIVE_STREAMS_BY_TAB_KEY);
        const nextSnapshot = result[ACTIVE_STREAMS_BY_TAB_KEY] && typeof result[ACTIVE_STREAMS_BY_TAB_KEY] === 'object'
            ? { ...result[ACTIVE_STREAMS_BY_TAB_KEY] }
            : {};
        const changed = mutator(nextSnapshot) === true;
        if (changed) {
            await this.sessionStorage.set({
                [ACTIVE_STREAMS_BY_TAB_KEY]: nextSnapshot
            });
        }
        this._applyActiveStreamsSnapshot(nextSnapshot);
        return nextSnapshot;
    }

    async _commitChatStorage({
        upsertChats = [],
        removeChatIds = [],
        upsertIndexEntries = [],
        removeIndexIds = [],
        replaceIndex = null
    } = {}) {
        let nextIndex;
        if (Array.isArray(replaceIndex)) {
            nextIndex = this._normalizeChatIndex(replaceIndex);
        } else {
            const result = await this.storage.get(CHAT_INDEX_KEY);
            nextIndex = this._normalizeChatIndex(result[CHAT_INDEX_KEY]);
            this._removeIndexEntries(nextIndex, removeIndexIds);
            this._upsertIndexEntries(nextIndex, upsertIndexEntries);
            nextIndex = this._sortChatIndexEntries(nextIndex);
        }

        const dataToWrite = {
            [CHAT_INDEX_KEY]: nextIndex
        };
        upsertChats.forEach((chat) => {
            if (!chat?.id) {
                return;
            }
            dataToWrite[this._chatKey(chat.id)] = chat;
        });

        await this._setChatStorage(dataToWrite);

        const uniqueRemoveIds = [...new Set(removeChatIds.filter(Boolean))];
        if (uniqueRemoveIds.length > 0) {
            await this._removeChatStorage(uniqueRemoveIds.map((chatId) => this._chatKey(chatId)));
        }

        this._chatIndex = nextIndex;
        return nextIndex;
    }

    async _loadCurrentChatMappings() {
        const result = await this.sessionStorage.get(CURRENT_CHAT_BY_TAB_KEY);
        this.currentChatByTab = result[CURRENT_CHAT_BY_TAB_KEY] && typeof result[CURRENT_CHAT_BY_TAB_KEY] === 'object'
            ? { ...result[CURRENT_CHAT_BY_TAB_KEY] }
            : {};
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
        Object.keys(this.currentChatByTab).forEach((scopeKey) => {
            if (this.currentChatByTab[scopeKey] === chatId) {
                delete this.currentChatByTab[scopeKey];
            }
        });

        Object.keys(this._transientChatByScope).forEach((scopeKey) => {
            if (this._transientChatByScope[scopeKey] === chatId) {
                delete this._transientChatByScope[scopeKey];
            }
        });
    }

    async bindChatToCurrentContext(chatId = this.currentChatId, scopeKey = this._getChatScopeKey()) {
        if (!chatId || !this.chats.has(chatId)) {
            return null;
        }

        this.currentChatId = chatId;
        this._setTransientChatForScope(scopeKey, null);
        await this._updateCurrentChatMappings((nextMappings) => {
            if (nextMappings[scopeKey] === chatId) {
                return false;
            }
            nextMappings[scopeKey] = chatId;
            return true;
        });
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
            await this._updateCurrentChatMappings((nextMappings) => {
                if (nextMappings[scopeKey] !== scopedChatId) {
                    return false;
                }
                delete nextMappings[scopeKey];
                return true;
            });
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
        const normalized = normalizeActiveStreamsSnapshot(snapshot).snapshot;
        this._activeStreamsByTab = new Map(Object.entries(normalized));
    }

    _pruneActiveStreamsInMemory() {
        this._applyActiveStreamsSnapshot(Object.fromEntries(this._activeStreamsByTab));
    }

    async _loadActiveStreamsFromSession() {
        const snapshot = await pruneStoredActiveStreams(this.sessionStorage);
        this._applyActiveStreamsSnapshot(snapshot);
    }

    _findActiveStreamByChatId(chatId) {
        if (!chatId) return null;
        this._pruneActiveStreamsInMemory();
        for (const stream of this._activeStreamsByTab.values()) {
            if (stream?.chatId === chatId) {
                return stream;
            }
        }
        return null;
    }

    getActiveStreams() {
        this._pruneActiveStreamsInMemory();
        return Array.from(this._activeStreamsByTab.values()).filter((stream) => Boolean(stream?.requestId));
    }

    hasActiveStreams() {
        return this.getActiveStreams().length > 0;
    }

    getActiveStreamForChat(chatId) {
        return this._findActiveStreamByChatId(chatId);
    }

    hasActiveStreamForChat(chatId) {
        return Boolean(this.getActiveStreamForChat(chatId));
    }

    async _ensureChatMutationAllowed(chatId, errorMessageKey = 'chat.activeStreamMutationBlocked') {
        if (!chatId) {
            return;
        }

        let activeStream = this.getActiveStreamForChat(chatId);
        if (
            activeStream &&
            activeStream.ownerContextId === this.uiContext.contextId &&
            typeof this._chatMutationInterrupter === 'function'
        ) {
            await this._chatMutationInterrupter({ chatId, activeStream, errorMessageKey });
            activeStream = this.getActiveStreamForChat(chatId);
        }

        if (activeStream) {
            throw new Error(t(errorMessageKey));
        }
    }

    async _ensureBatchChatMutationAllowed(chatIds = [], errorMessageKey = 'chat.activeStreamBatchMutationBlocked') {
        const uniqueChatIds = Array.from(new Set((Array.isArray(chatIds) ? chatIds : []).filter(Boolean)));

        for (const chatId of uniqueChatIds) {
            const activeStream = this.getActiveStreamForChat(chatId);
            if (
                activeStream &&
                activeStream.ownerContextId === this.uiContext.contextId &&
                typeof this._chatMutationInterrupter === 'function'
            ) {
                await this._chatMutationInterrupter({ chatId, activeStream, errorMessageKey });
            }
        }

        const blockingChatIds = uniqueChatIds
            .filter((chatId) => this.hasActiveStreamForChat(chatId));
        if (blockingChatIds.length > 0) {
            throw new Error(t(errorMessageKey));
        }
    }

    _stopOwnedStreamHeartbeat() {
        if (this._ownedStreamHeartbeatTimer) {
            clearInterval(this._ownedStreamHeartbeatTimer);
            this._ownedStreamHeartbeatTimer = null;
        }
    }

    _startOwnedStreamHeartbeat(requestId) {
        this._stopOwnedStreamHeartbeat();
        this._ownedStreamHeartbeatTimer = setInterval(() => {
            this.refreshStreamOwnership({ requestId }).catch((error) => {
                console.warn('[ChatManager] 刷新 stream ownership 心跳失败:', error);
            });
        }, ACTIVE_STREAM_HEARTBEAT_INTERVAL_MS);
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
        const streamRecord = createActiveStreamRecord({
            requestId,
            chatId,
            tabId,
            ownerContextId: this.uiContext.contextId,
            uiType: this.uiContext.uiType
        });

        await this._updateActiveStreams((nextSnapshot) => {
            if (JSON.stringify(nextSnapshot[scopeKey] || null) === JSON.stringify(streamRecord)) {
                return false;
            }
            nextSnapshot[scopeKey] = streamRecord;
            return true;
        });
        this._ownedStream = streamRecord;
        this._startOwnedStreamHeartbeat(requestId);
        this.setStreamingChatId(chatId);
        return streamRecord;
    }

    async refreshStreamOwnership({ requestId = this._ownedStream?.requestId } = {}) {
        if (!requestId || this._ownedStream?.requestId !== requestId) {
            return null;
        }

        let nextRecord = null;
        await this._updateActiveStreams((nextSnapshot) => {
            for (const [scopeKey, activeStream] of Object.entries(nextSnapshot)) {
                if (
                    activeStream &&
                    activeStream.requestId === requestId &&
                    activeStream.ownerContextId === this.uiContext.contextId
                ) {
                    nextRecord = touchActiveStreamRecord(activeStream);
                    nextSnapshot[scopeKey] = nextRecord;
                    return true;
                }
            }
            return false;
        });

        if (nextRecord) {
            this._ownedStream = nextRecord;
        }
        return nextRecord;
    }

    async releaseStreamOwnership({ requestId = this._ownedStream?.requestId } = {}) {
        if (!requestId) {
            return;
        }

        await this._updateActiveStreams((nextSnapshot) => {
            for (const [scopeKey, activeStream] of Object.entries(nextSnapshot)) {
                if (
                    activeStream &&
                    activeStream.requestId === requestId &&
                    activeStream.ownerContextId === this.uiContext.contextId
                ) {
                    delete nextSnapshot[scopeKey];
                    return true;
                }
            }
            return false;
        });

        if (this._ownedStream?.requestId === requestId) {
            this._stopOwnedStreamHeartbeat();
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

    setChatMutationInterrupter(interrupter) {
        this._chatMutationInterrupter = typeof interrupter === 'function' ? interrupter : null;
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

    async _loadDirtyChatIdsFromStorage() {
        try {
            const dirtyResult = await this.storage.get(DIRTY_CHAT_IDS_KEY);
            const savedDirty = dirtyResult[DIRTY_CHAT_IDS_KEY];
            this._dirtyChatIds = Array.isArray(savedDirty) ? new Set(savedDirty) : new Set();
        } catch {
            this._dirtyChatIds = new Set();
        }
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

        // 載入持久化的 dirty flags（處理擴充套件重啟與跨分頁更新）
        await this._loadDirtyChatIdsFromStorage();

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
        await this._loadDirtyChatIdsFromStorage();
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

        try {
            await this._commitChatStorage({
                upsertChats: [chat],
                upsertIndexEntries: [this._buildIndexEntry(chat)]
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

        const chatsToWrite = [];
        const indexEntries = [];
        const newChatIds = new Set();
        const chatIdsToRemove = new Set();
        const writeAll = !dirtyIds;

        for (const chat of chatsArray) {
            this.chats.set(chat.id, chat);
            newChatIds.add(chat.id);
            if (!chat.isNew) {
                if (chat._remoteOnly) {
                    chatIdsToRemove.add(chat.id);
                } else if (writeAll || dirtyIds.has(chat.id)) {
                    chatsToWrite.push(chat);
                }
                indexEntries.push(this._buildIndexEntry(chat));
            }
        }

        // 清理孤兒 keys（舊的 chat 不在新列表中）
        for (const oldId of oldChatIds) {
            if (!newChatIds.has(oldId)) {
                chatIdsToRemove.add(oldId);
            }
        }

        await this._commitChatStorage({
            replaceIndex: indexEntries,
            upsertChats: chatsToWrite,
            removeChatIds: [...chatIdsToRemove]
        });
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
        await this._ensureChatMutationAllowed(chatId);
        this.chats.delete(chatId);
        this._removeIndexEntry(chatId);
        this._removeChatFromScopeMappings(chatId);

        // 更新索引並移除 per-chat key
        const pendingWrites = [
            this._commitChatStorage({
                removeChatIds: [chatId],
                removeIndexIds: [chatId]
            })
        ];
        pendingWrites.push(this._updateCurrentChatMappings((nextMappings) => {
            let changed = false;
            Object.keys(nextMappings).forEach((scopeKey) => {
                if (nextMappings[scopeKey] === chatId) {
                    delete nextMappings[scopeKey];
                    changed = true;
                }
            });
            return changed;
        }));
        await Promise.all(pendingWrites);

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
            const activeStreamChatIds = new Set(
                this.getActiveStreams()
                    .map((stream) => stream?.chatId)
                    .filter(Boolean)
            );

            const deletedIds = [];
            // getAllChats 返回的是由新到舊排序，因此從尾端開始找最舊且可刪的聊天。
            for (let index = allChats.length - 1; index >= 0 && deletedIds.length < excessCount; index -= 1) {
                const chat = allChats[index];
                // 不刪除當前正在使用或仍在生成回覆的對話
                if (chat.id !== this.currentChatId && !activeStreamChatIds.has(chat.id)) {
                    this.chats.delete(chat.id);
                    this._removeIndexEntry(chat.id);
                    deletedIds.push(chat.id);
                }
            }

            if (deletedIds.length > 0) {
                deletedIds.forEach((id) => {
                    this._removeChatFromScopeMappings(id);
                });

                // 清理 dirty flags，避免 WebDAV 同步嘗試同步已刪除的聊天
                this.clearDirtyChatIds(deletedIds);

                // 通知 WebDAV 同步記錄刪除
                for (const id of deletedIds) {
                    document.dispatchEvent(new CustomEvent('chat-deleted', { detail: { chatId: id } }));
                }

                const pendingWrites = [
                    this._commitChatStorage({
                        removeChatIds: deletedIds,
                        removeIndexIds: deletedIds
                    })
                ];
                pendingWrites.push(this._updateCurrentChatMappings((nextMappings) => {
                    let changed = false;
                    Object.keys(nextMappings).forEach((scopeKey) => {
                        if (deletedIds.includes(nextMappings[scopeKey])) {
                            delete nextMappings[scopeKey];
                            changed = true;
                        }
                    });
                    return changed;
                }));
                await Promise.all(pendingWrites);
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
        this._mergeWebpageInfoIntoChat(currentChat, webpageInfo);

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

    _mergeWebpageInfoIntoChat(chat, webpageInfo) {
        if (!chat || !webpageInfo?.pages) {
            return false;
        }

        const urls = webpageInfo.pages
            .map(page => page?.url)
            .filter(Boolean);
        if (urls.length === 0) {
            return false;
        }

        const existingUrls = Array.isArray(chat.webpageUrls) ? chat.webpageUrls : [];
        const uniqueUrls = new Set([...existingUrls, ...urls]);
        if (uniqueUrls.size === existingUrls.length) {
            return false;
        }

        chat.webpageUrls = Array.from(uniqueUrls);
        return true;
    }

    async addWebpageInfoToChat(chatId = this.currentChatId, webpageInfo) {
        if (!chatId || !this.canFlushChat(chatId)) {
            return false;
        }

        const chat = this.chats.get(chatId);
        if (!chat) {
            throw new Error(t('chat.notFound'));
        }

        const didUpdate = this._mergeWebpageInfoIntoChat(chat, webpageInfo);
        if (!didUpdate) {
            return false;
        }

        this.markChatDirty(chatId);
        await this.saveChat(chatId);
        return true;
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
            await this._ensureChatMutationAllowed(currentChat.id);
            currentChat.messages = [];
            this._touchChatUpdatedAt(currentChat.id);
            this.markChatDirty(currentChat.id);
            await this.saveChat(this.currentChatId);
        }
    }

    async clearAllChats() {
        await this._ensureBatchChatMutationAllowed(Array.from(this.chats.keys()));

        // 通知 WebDAV 同步記錄所有刪除（批次發送一次事件）
        const allIds = Array.from(this.chats.keys());
        if (allIds.length > 0) {
            document.dispatchEvent(new CustomEvent('chats-cleared', { detail: { chatIds: allIds } }));
        }

        // 清除記憶體
        this.chats.clear();

        // 寫入空索引
        this._chatIndex = [];
        this.currentChatByTab = {};
        this._transientChatByScope = {};
        await Promise.all([
            this._commitChatStorage({
                replaceIndex: [],
                removeChatIds: allIds
            }),
            this._updateCurrentChatMappings((nextMappings) => {
                const hasMappings = Object.keys(nextMappings).length > 0;
                Object.keys(nextMappings).forEach((scopeKey) => {
                    delete nextMappings[scopeKey];
                });
                return hasMappings;
            })
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
