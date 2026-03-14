const ZERO_WIDTH_CHARS_RE = /[\u200b\u200c\u200d\uFEFF]/g;

export const USER_QUESTION_HISTORY_LIMIT = 20;
export const USER_QUESTION_HISTORY_STORAGE_KEY = 'cerebr_user_question_history';

export function normalizeUserQuestion(text = '') {
    return String(text || '').replace(ZERO_WIDTH_CHARS_RE, '').trim();
}

export function sanitizeUserQuestions(questions) {
    if (!Array.isArray(questions)) return [];
    const normalizedQuestions = questions
        .map(normalizeUserQuestion)
        .filter(Boolean);

    // Keep only the latest occurrence of each question while preserving order.
    const dedupedQuestions = [];
    const seenQuestions = new Set();
    for (let i = normalizedQuestions.length - 1; i >= 0; i--) {
        const question = normalizedQuestions[i];
        if (seenQuestions.has(question)) {
            continue;
        }
        seenQuestions.add(question);
        dedupedQuestions.push(question);
    }

    dedupedQuestions.reverse();
    return dedupedQuestions.slice(-USER_QUESTION_HISTORY_LIMIT);
}

export function trimUserQuestionHistory(userQuestions) {
    if (!Array.isArray(userQuestions)) return;
    const sanitizedQuestions = sanitizeUserQuestions(userQuestions);
    userQuestions.length = 0;
    userQuestions.push(...sanitizedQuestions);
}
