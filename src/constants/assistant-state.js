export const WAITING_ANIMATION_MARKER = '{{WAITING_ANIMATION}}';
export const TRANSIENT_ASSISTANT_STATE_WAITING = 'waiting';
export const TRANSIENT_ASSISTANT_STATE_SEARCHING = 'searching';

function hasNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

export function isTransientAssistantState(state) {
    return state === TRANSIENT_ASSISTANT_STATE_WAITING ||
        state === TRANSIENT_ASSISTANT_STATE_SEARCHING;
}

export function hasRenderableMessageContent(message) {
    if (!message) {
        return false;
    }

    if (Array.isArray(message.content)) {
        return message.content.length > 0;
    }

    if (hasNonEmptyString(message.content)) {
        return message.content !== WAITING_ANIMATION_MARKER;
    }

    return hasNonEmptyString(message.reasoning_content);
}

export function isTransientAssistantMessage(message) {
    if (!message || message.role !== 'assistant') {
        return false;
    }

    if (isTransientAssistantState(message.transientState)) {
        return true;
    }

    return Boolean(message.updating && !hasRenderableMessageContent(message));
}

export function isTransientAssistantStatusPayload(message) {
    if (!message) {
        return false;
    }

    return isTransientAssistantState(message.transientState);
}
