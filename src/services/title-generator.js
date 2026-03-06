/**
 * API配置接口
 * @typedef {import('./chat.js').APIConfig} APIConfig
 */

/**
 * 消息接口
 * @typedef {import('./chat.js').Message} Message
 */

import { getTitleGenerationPrompt } from './remote-prompts.js';

/**
 * 根據對話內容生成標題
 * @param {Array<Message>} messages - 對話訊息
 * @param {APIConfig} apiConfig - API 配置
 * @returns {Promise<string|null>} - 返回生成的標題或在失敗時返回 null
 */
export async function generateTitle(messages, apiConfig) {
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey) {
        console.warn('API configuration is incomplete for title generation.');
        return null;
    }

    // 只取前三條訊息以節省 token
    const relevantMessages = messages.slice(0, 3).map(msg => {
        if (typeof msg.content === 'string') {
            return `${msg.role}: ${msg.content}`;
        }
        if (Array.isArray(msg.content)) {
            const textContent = msg.content
                .filter(part => part.type === 'text')
                .map(part => part.text)
                .join(' ');
            return `${msg.role}: ${textContent}`;
        }
        return '';
    }).join('\n');

    const prompt = await getTitleGenerationPrompt() + relevantMessages;

    const messagesForAPI = [{
        role: "user",
        content: prompt
    }];

    try {
        const response = await fetch(apiConfig.baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiConfig.apiKey}`
            },
            body: JSON.stringify({
                model: apiConfig.titleModelName || apiConfig.modelName || "gpt-5-nano",
                messages: messagesForAPI,
                stream: false, // 非流式請求
                temperature: 0.6
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Title generation API request failed:', errorText);
            return null;
        }

        const data = await response.json();
        let title = data.choices[0]?.message?.content?.trim();

        // 清理標題，移除可能出現的引號
        if (title) {
            title = title.replace(/^["']|["']$/g, '');
        }

        return title || null;

    } catch (error) {
        console.error('Error generating title:', error);
        return null;
    }
}
