/**
 * 計算聊天的 djb2 hash（用於變更偵測）
 * 只使用純文本內容計算 hash，排除 base64 圖片等非文本內容以提升效能
 * 注意：文本提取邏輯與 message-handler.js 中的 content 解析模式類似，
 *       若 message content 格式變動需同步修改。
 */
export function computeChatHash(chat) {
    const textOnlyMessages = (chat.messages || []).map(msg => {
        const content = msg.content;
        if (typeof content === 'string') {
            return { role: msg.role, content };
        }
        if (Array.isArray(content)) {
            const text = content
                .filter(item => item.type === 'text')
                .map(item => item.text)
                .join('');
            return { role: msg.role, content: text };
        }
        return { role: msg.role, content: '' };
    });

    const jsonString = JSON.stringify({
        id: chat.id,
        title: chat.title,
        messages: textOnlyMessages,
        webpageUrls: chat.webpageUrls
    });
    let hash = 5381;
    for (let i = 0; i < jsonString.length; i++) {
        hash = ((hash << 5) + hash) + jsonString.charCodeAt(i);
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
}
