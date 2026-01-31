import { storageAdapter } from './storage-adapter.js';
import { generateTitle } from '../services/title-generator.js';

const CHATS_KEY = 'cerebr_chats';
const CURRENT_CHAT_ID_KEY = 'cerebr_current_chat_id';

// 內存優化配置
const MAX_CHATS_IN_MEMORY = 50; // 內存中最多保留的對話數量
const MAX_MESSAGES_PER_CHAT = 100; // 每個對話最多保留的消息數量

export class ChatManager {
    constructor() {
        this.storage = storageAdapter;
        this.currentChatId = null;
        this.chats = new Map();
        this.apiConfig = null; // 用于存储API配置
        // 優化：使用 Map 存儲中止標記和時間戳，便於自動清理過期標記
        this.abortedChats = new Map(); // Map<chatId, timestamp>
        // 中止標記的過期時間（毫秒），超過此時間的標記會被自動清理
        this.ABORT_MARK_EXPIRY = 60000; // 60秒
        this.initialize();
    }

    // 標記某個 chat 的請求已被中止
    markChatAborted(chatId) {
        this.abortedChats.set(chatId, Date.now());
        // 每次標記時，順便清理過期的標記，防止記憶體洩漏
        this._cleanupExpiredAbortMarks();
    }

    // 檢查某個 chat 的請求是否已被中止
    isChatAborted(chatId) {
        const timestamp = this.abortedChats.get(chatId);
        if (!timestamp) return false;

        // 檢查標記是否已過期
        if (Date.now() - timestamp > this.ABORT_MARK_EXPIRY) {
            this.abortedChats.delete(chatId);
            return false;
        }
        return true;
    }

    // 清除某個 chat 的中止標記（當開始新請求時調用）
    clearChatAborted(chatId) {
        this.abortedChats.delete(chatId);
    }

    // 清理所有過期的中止標記（內部方法）
    _cleanupExpiredAbortMarks() {
        const now = Date.now();
        for (const [chatId, timestamp] of this.abortedChats) {
            if (now - timestamp > this.ABORT_MARK_EXPIRY) {
                this.abortedChats.delete(chatId);
            }
        }
    }

    setApiConfig(config) {
        this.apiConfig = config;
    }

    async initialize() {
        // 加载所有对话
        const result = await this.storage.get(CHATS_KEY);
        const savedChats = result[CHATS_KEY] || [];
        if (Array.isArray(savedChats)) {
            // 按創建時間排序，只加載最近的對話到內存
            const sortedChats = savedChats.sort((a, b) =>
                new Date(b.createdAt) - new Date(a.createdAt)
            );

            // 只加載最近的對話到內存，舊的對話保留在 storage 中
            const chatsToLoad = sortedChats.slice(0, MAX_CHATS_IN_MEMORY);
            chatsToLoad.forEach(chat => {
                this.chats.set(chat.id, chat);
            });

            // 如果有超出限制的對話，記錄日誌
            if (savedChats.length > MAX_CHATS_IN_MEMORY) {
                console.log(`ChatManager: Loaded ${chatsToLoad.length} of ${savedChats.length} chats into memory`);
            }
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

        // 清理內存中的舊對話
        this._trimChatsInMemory();

        // this.saveChats(); // 不再立即保存
        return chat;
    }

    async switchChat(chatId) {
        if (!this.chats.has(chatId)) {
            throw new Error('对话不存在');
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
        // 清理該對話的中止標記
        this.clearChatAborted(chatId);
        await this.saveChats();

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
     * 清理內存中的舊對話，只保留最近的對話
     * 這個方法會在添加新對話時自動調用
     */
    _trimChatsInMemory() {
        if (this.chats.size <= MAX_CHATS_IN_MEMORY) {
            return;
        }

        // 獲取所有對話並按創建時間排序
        const allChats = Array.from(this.chats.entries())
            .sort((a, b) => new Date(b[1].createdAt) - new Date(a[1].createdAt));

        // 保留最近的對話，刪除舊的
        const chatsToRemove = allChats.slice(MAX_CHATS_IN_MEMORY);
        chatsToRemove.forEach(([chatId, chat]) => {
            // 不刪除當前對話
            if (chatId !== this.currentChatId) {
                this.chats.delete(chatId);
                // 清理該對話的中止標記
                this.clearChatAborted(chatId);
            }
        });

        console.log(`ChatManager: Trimmed ${chatsToRemove.length} old chats from memory`);
    }

    /**
     * 限制對話中的消息數量，防止單個對話佔用過多內存
     * @param {Object} chat - 對話對象
     */
    _trimMessagesInChat(chat) {
        if (!chat || !chat.messages || chat.messages.length <= MAX_MESSAGES_PER_CHAT) {
            return;
        }

        // 保留最近的消息
        const trimmedMessages = chat.messages.slice(-MAX_MESSAGES_PER_CHAT);
        chat.messages = trimmedMessages;

        console.log(`ChatManager: Trimmed messages in chat ${chat.id} to ${MAX_MESSAGES_PER_CHAT}`);
    }

    async addMessageToCurrentChat(message, webpageInfo) {
        const currentChat = this.getCurrentChat();
        if (!currentChat) {
            throw new Error('当前没有活动的对话');
        }

        const isFirstMessage = currentChat.isNew && currentChat.messages.length === 0;

        currentChat.messages.push(message);

        // 檢查並限制消息數量
        this._trimMessagesInChat(currentChat);

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
            await this.saveChats();
            // 通知UI更新
            document.dispatchEvent(new CustomEvent('chat-title-updated', { detail: { chatId: chat.id, newTitle } }));
        }
    }

    async updateLastMessage(chatId, message, isFinalUpdate = false) {
        // 如果這個 chat 的請求已被中止，不進行任何更新
        if (this.isChatAborted(chatId)) {
            console.log('Chat request was aborted, skipping update for chatId:', chatId);
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
        if (message.content) {
            lastMessage.content = message.content;
        }
        if (message.reasoning_content) {
            lastMessage.reasoning_content = message.reasoning_content;
        }
        if (message.isSearchUsed) {
            lastMessage.isSearchUsed = true;
        }

        // 当流式响应结束时，触发标题生成
        if (isFinalUpdate) {
            delete lastMessage.updating;
            // 检查是否是第一次AI回复（即对话中只有两条消息，一条user，一条assistant）
            if (currentChat.messages.length === 2) {
                this.generateAndSaveTitle(currentChat);
            }
        }

        await this.saveChats();
    }

    async popMessage() {
        const currentChat = this.getCurrentChat();
        if (!currentChat) {
            throw new Error('对话不存在');
        }
        currentChat.messages.pop();
        await this.saveChats();
    }

    async saveChats() {
        const chatsToSave = Array.from(this.chats.values()).filter(chat => !chat.isNew);
        await this.storage.set({ [CHATS_KEY]: chatsToSave });
    }

    async clearCurrentChat() {
        const currentChat = this.getCurrentChat();
        if (currentChat) {
            currentChat.messages = [];
            await this.saveChats();
        }
    }

    async clearAllChats() {
        // 清除所有對話
        this.chats.clear();
        // 清除所有中止標記
        this.abortedChats.clear();

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