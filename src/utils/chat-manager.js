import { storageAdapter } from './storage-adapter.js';
import { generateTitle } from '../services/title-generator.js';

const CHATS_KEY = 'cerebr_chats';
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
        this._saveDebounceTimer = null; // 流式更新時的 debounce 計時器
        this.initialize();
    }

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

    async initialize() {
        // 加载所有对话
        const result = await this.storage.get(CHATS_KEY);
        const savedChats = result[CHATS_KEY] || [];

        // 清空現有的對話 Map，確保刪除的對話不會殘留
        this.chats.clear();

        if (Array.isArray(savedChats)) {
            savedChats.forEach(chat => {
                this.chats.set(chat.id, chat);
            });
        }

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
        // this.saveChats(); // 不再立即保存
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
                await this.saveChats();
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
        await this.saveChats();

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

            let deletedCount = 0;
            for (const chat of chatsToDelete) {
                // 不刪除當前正在使用的對話
                if (chat.id !== this.currentChatId) {
                    this.chats.delete(chat.id);
                    deletedCount++;
                }
            }

            if (deletedCount > 0) {
                await this.saveChats();
            }

            return deletedCount;
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

        await this.saveChats();
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
            await this.saveChats();
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
            await this.flushSaveChats();
        } else {
            // 流式中間更新：只更新記憶體，延遲寫入 IndexedDB
            this._debouncedSaveChats();
        }
    }

    async popMessage() {
        const currentChat = this.getCurrentChat();
        if (!currentChat) {
            throw new Error('对话不存在');
        }
        currentChat.messages.pop();
        currentChat.updatedAt = new Date().toISOString();
        this.markChatDirty(currentChat.id);
        await this.saveChats();
    }

    async saveChats() {
        const chatsToSave = Array.from(this.chats.values()).filter(chat => !chat.isNew);
        await this.storage.set({ [CHATS_KEY]: chatsToSave });
    }

    /**
     * 延遲儲存 — 用於流式更新期間，避免每 100ms 都寫入 IndexedDB。
     * 多次呼叫只會在最後一次呼叫後 500ms 執行一次寫入。
     */
    _debouncedSaveChats() {
        if (this._saveDebounceTimer) {
            clearTimeout(this._saveDebounceTimer);
        }
        this._saveDebounceTimer = setTimeout(() => {
            this._saveDebounceTimer = null;
            this.saveChats();
        }, 500);
    }

    /**
     * 立即寫入並取消任何待處理的 debounce — 用於流式結束時的最終儲存。
     */
    async flushSaveChats() {
        if (this._saveDebounceTimer) {
            clearTimeout(this._saveDebounceTimer);
            this._saveDebounceTimer = null;
        }
        await this.saveChats();
    }

    async clearCurrentChat() {
        const currentChat = this.getCurrentChat();
        if (currentChat) {
            currentChat.messages = [];
            currentChat.updatedAt = new Date().toISOString();
            this.markChatDirty(currentChat.id);
            await this.saveChats();
        }
    }

    async clearAllChats() {
        // 通知 WebDAV 同步記錄所有刪除（批次發送一次事件）
        const allIds = Array.from(this.chats.keys());
        if (allIds.length > 0) {
            document.dispatchEvent(new CustomEvent('chats-cleared', { detail: { chatIds: allIds } }));
        }

        // 清除所有對話
        this.chats.clear();

        // 保存空的對話列表到存儲
        await this.saveChats();

        // 創建一個新的默認對話
        const defaultChat = this.createNewChat('默认对话');
        this.currentChatId = defaultChat.id;
        await this.storage.set({ [CURRENT_CHAT_ID_KEY]: this.currentChatId });

        return defaultChat;
    }
}

// 创建并导出单例实例
export const chatManager = new ChatManager();