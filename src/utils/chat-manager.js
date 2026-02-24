import { storageAdapter } from './storage-adapter.js';
import { generateTitle } from '../services/title-generator.js';

const CHAT_KEY_PREFIX = 'cerebr_chat_'; // Per-chat key 前綴
const CHAT_INDEX_KEY = 'cerebr_chat_index'; // 輕量索引
const CURRENT_CHAT_ID_KEY = 'cerebr_current_chat_id';
const DIRTY_CHAT_IDS_KEY = 'cerebr_dirty_chat_ids';

export class ChatManager {
    constructor() {
        this.storage = storageAdapter;
        this.currentChatId = null;
        this.chats = new Map();
        this.apiConfig = null; // 用于存储API配置
        this.onDemandLoader = null; // WebDAV 按需下載回調
        this._dirtyChatIds = new Set(); // WebDAV 同步用：追蹤被修改的聊天
        this._saveDebounceTimers = new Map(); // 流式更新時的 per-chat debounce 計時器
        this._chatIndex = []; // 記憶體中維護的輕量索引
        this._streamingChatId = null; // 正在串流回覆的聊天 ID
        this._pendingInitialize = false; // 串流期間是否有待補執行的 initialize()
        this._onDeferredInitComplete = null; // 延遲 initialize 完成後的回調
        this.initialize();
    }

    // ==================== Per-Chat 儲存輔助方法 ====================

    /**
     * 建構 per-chat 的 storage key
     */
    _chatKey(chatId) {
        return CHAT_KEY_PREFIX + chatId;
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
            _remoteOnly: chat._remoteOnly || false
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

    // ==================== WebDAV Dirty Flag 管理 ====================

    /**
     * 設定按需下載回調（由 main.js 在 WebDAV 啟用時設定）
     * @param {Function} loader - async (chatId) => chatData | null
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

        // 获取当前对话ID
        const currentChatResult = await this.storage.get(CURRENT_CHAT_ID_KEY);
        this.currentChatId = currentChatResult[CURRENT_CHAT_ID_KEY];

        // 如果没有当前对话，创建一个默认对话
        if (!this.currentChatId || !this.chats.has(this.currentChatId)) {
            const defaultChat = this.createNewChat('默认对话');
            this.currentChatId = defaultChat.id;
            await this.storage.set({ [CURRENT_CHAT_ID_KEY]: this.currentChatId });
        }

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

        this._updateIndexEntry(chatId);
        await this.storage.set({
            [this._chatKey(chatId)]: chat,
            [CHAT_INDEX_KEY]: this._chatIndex
        });
    }

    /**
     * 延遲儲存單一聊天 — 用於流式更新期間，避免頻繁寫入。
     * 每個 chatId 獨立計時，多次呼叫只會在最後一次呼叫後 500ms 執行一次寫入。
     */
    _debouncedSaveChat(chatId) {
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
     */
    async replaceAllChats(chatsArray) {
        // 記錄舊的 chat IDs，用於清理孤兒 keys
        const oldChatIds = new Set(this.chats.keys());

        this.chats.clear();

        const dataToWrite = {};
        const indexEntries = [];
        const newChatIds = new Set();

        for (const chat of chatsArray) {
            this.chats.set(chat.id, chat);
            newChatIds.add(chat.id);
            if (!chat.isNew) {
                if (!chat._remoteOnly) {
                    dataToWrite[this._chatKey(chat.id)] = chat;
                }
                indexEntries.push(this._buildIndexEntry(chat));
            }
        }
        dataToWrite[CHAT_INDEX_KEY] = indexEntries;
        this._chatIndex = indexEntries;

        // 寫入新資料
        await this.storage.set(dataToWrite);

        // 清理孤兒 keys（舊的 chat 不在新列表中）
        const orphanedKeys = [];
        for (const oldId of oldChatIds) {
            if (!newChatIds.has(oldId)) {
                orphanedKeys.push(this._chatKey(oldId));
            }
        }
        if (orphanedKeys.length > 0) {
            await this.storage.remove(orphanedKeys);
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

    async switchChat(chatId) {
        if (!this.chats.has(chatId)) {
            throw new Error('对话不存在');
        }

        const chat = this.chats.get(chatId);

        // 按需載入：如果聊天標記為 _remoteOnly，從 WebDAV 下載完整內容
        if (chat._remoteOnly && this.onDemandLoader) {
            const fullChat = await this.onDemandLoader(chatId);
            if (fullChat) {
                delete fullChat._remoteOnly;
                this.chats.set(chatId, fullChat);
                this.markChatDirty(chatId);
                await this.saveChat(chatId);
            } else {
                // 下載失敗，保持空殼狀態
                console.warn(`[ChatManager] 按需下載聊天 ${chatId} 失敗`);
            }
        }

        this.currentChatId = chatId;
        await this.storage.set({ [CURRENT_CHAT_ID_KEY]: chatId });
        return this.chats.get(chatId);
    }

    async deleteChat(chatId) {
        if (!this.chats.has(chatId)) {
            throw new Error('对话不存在');
        }
        this.chats.delete(chatId);
        this._removeIndexEntry(chatId);

        // 更新索引並移除 per-chat key
        await this.storage.set({ [CHAT_INDEX_KEY]: this._chatIndex });
        this.storage.remove(this._chatKey(chatId)).catch(() => {});

        // 通知 WebDAV 同步記錄刪除
        document.dispatchEvent(new CustomEvent('chat-deleted', { detail: { chatId } }));

        // 如果删除的是当前对话，切换到其他对话
        if (chatId === this.currentChatId) {
            const nextChat = Array.from(this.chats.values()).pop();
            if (nextChat) {
                await this.switchChat(nextChat.id);
                this.currentChatId = nextChat.id;
            } else {
                const newChat = this.createNewChat('默认对话');
                await this.switchChat(newChat.id);
                this.currentChatId = newChat.id;
            }
        }
    }

    getCurrentChat() {
        return this.chats.get(this.currentChatId);
    }

    getAllChats() {
        return Array.from(this.chats.values())
            .filter(chat => !chat.isNew || chat.messages.length > 0) // 过滤掉未保存的新对话
            .sort((a, b) =>
                new Date(b.createdAt) - new Date(a.createdAt)
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
    async autoCleanupHistory(limit = 100) {
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
                // 清理 dirty flags，避免 WebDAV 同步嘗試同步已刪除的聊天
                this.clearDirtyChatIds(deletedIds);

                // 通知 WebDAV 同步記錄刪除
                for (const id of deletedIds) {
                    document.dispatchEvent(new CustomEvent('chat-deleted', { detail: { chatId: id } }));
                }

                const keysToRemove = deletedIds.map(id => this._chatKey(id));
                await this.storage.set({ [CHAT_INDEX_KEY]: this._chatIndex });
                this.storage.remove(keysToRemove).catch(() => {});
            }

            return deletedIds.length;
        }
        return 0;
    }

    async addMessageToCurrentChat(message, webpageInfo) {
        const currentChat = this.getCurrentChat();
        if (!currentChat) {
            throw new Error('当前没有活动的对话');
        }

        const isFirstMessage = currentChat.isNew && currentChat.messages.length === 0;

        currentChat.messages.push(message);
        currentChat.updatedAt = new Date().toISOString();
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
                this.autoCleanupHistory(100).then(deletedCount => {
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
            this.markChatDirty(chat.id);
            await this.saveChat(chat.id);
            // 通知UI更新
            document.dispatchEvent(new CustomEvent('chat-title-updated', { detail: { chatId: chat.id, newTitle } }));
        }
    }

    async updateLastMessage(chatId, message, isFinalUpdate = false) {
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
        if (message.content) {
            lastMessage.content = message.content;
        }
        if (message.reasoning_content) {
            lastMessage.reasoning_content = message.reasoning_content;
        }
        if (message.isSearchUsed) {
            lastMessage.isSearchUsed = true;
        }

        this.markChatDirty(chatId);

        // 当流式响应结束时，触发标题生成
        if (isFinalUpdate) {
            delete lastMessage.updating;
            currentChat.updatedAt = new Date().toISOString();
            // 检查是否是第一次AI回复（即对话中只有两条消息，一条user，一条assistant）
            if (currentChat.messages.length === 2) {
                this.generateAndSaveTitle(currentChat);
            }
            await this.flushSaveChat(chatId);
        }
        // 串流中間更新：只保留在記憶體中，不寫入 storage
        // flushSaveChat 會在串流結束時一次性寫入
    }

    async popMessage() {
        const currentChat = this.getCurrentChat();
        if (!currentChat) {
            throw new Error('对话不存在');
        }
        currentChat.messages.pop();
        currentChat.updatedAt = new Date().toISOString();
        this.markChatDirty(currentChat.id);
        await this.saveChat(this.currentChatId);
    }

    async clearCurrentChat() {
        const currentChat = this.getCurrentChat();
        if (currentChat) {
            currentChat.messages = [];
            currentChat.updatedAt = new Date().toISOString();
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
            await this.storage.remove(keysToRemove);
        }

        // 清除記憶體
        this.chats.clear();

        // 寫入空索引
        this._chatIndex = [];
        await this.storage.set({ [CHAT_INDEX_KEY]: [] });

        // 創建一個新的默認對話
        const defaultChat = this.createNewChat('默认对话');
        this.currentChatId = defaultChat.id;
        await this.storage.set({ [CURRENT_CHAT_ID_KEY]: this.currentChatId });

        return defaultChat;
    }
}

// 创建并导出单例实例
export const chatManager = new ChatManager();
