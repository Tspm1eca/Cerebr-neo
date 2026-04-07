export const ACTIVE_STREAMS_BY_TAB_KEY = 'cerebr_active_stream_by_tab';
export const ACTIVE_STREAM_HEARTBEAT_INTERVAL_MS = 15 * 1000;
export const ACTIVE_STREAM_STALE_MS = 60 * 1000;

function normalizeTimestamp(value, fallback = 0) {
    const nextValue = Number(value);
    return Number.isFinite(nextValue) && nextValue > 0 ? nextValue : fallback;
}

function normalizeActiveStreamRecord(record, fallbackTimestamp = Date.now()) {
    if (!record?.requestId) {
        return null;
    }

    const startedAt = normalizeTimestamp(record.startedAt) ||
        normalizeTimestamp(record.heartbeatAt) ||
        fallbackTimestamp;
    const heartbeatAt = normalizeTimestamp(record.heartbeatAt, startedAt);

    return {
        ...record,
        startedAt,
        heartbeatAt
    };
}

function areActiveStreamRecordsEqual(left, right) {
    return JSON.stringify(left || null) === JSON.stringify(right || null);
}

export function createActiveStreamRecord({
    requestId,
    chatId,
    tabId,
    ownerContextId,
    uiType
}, now = Date.now()) {
    return {
        requestId,
        chatId,
        tabId: Number.isInteger(tabId) ? tabId : null,
        ownerContextId,
        uiType,
        startedAt: now,
        heartbeatAt: now
    };
}

export function touchActiveStreamRecord(record, now = Date.now()) {
    const normalized = normalizeActiveStreamRecord(record, now);
    if (!normalized) {
        return null;
    }

    return {
        ...normalized,
        heartbeatAt: now
    };
}

export function isActiveStreamStale(record, now = Date.now(), staleMs = ACTIVE_STREAM_STALE_MS) {
    const normalized = normalizeActiveStreamRecord(record, now);
    if (!normalized) {
        return false;
    }

    return (now - normalized.heartbeatAt) > staleMs;
}

export function normalizeActiveStreamsSnapshot(snapshot, {
    now = Date.now(),
    staleMs = ACTIVE_STREAM_STALE_MS
} = {}) {
    const hasStructuredSnapshot = Boolean(snapshot && typeof snapshot === 'object');
    const sourceSnapshot = hasStructuredSnapshot ? snapshot : {};
    const nextSnapshot = {};
    let changed = false;

    Object.entries(sourceSnapshot).forEach(([scopeKey, record]) => {
        const normalized = normalizeActiveStreamRecord(record, now);
        if (!normalized) {
            changed = true;
            return;
        }

        if (isActiveStreamStale(normalized, now, staleMs)) {
            changed = true;
            return;
        }

        nextSnapshot[scopeKey] = normalized;
        if (!areActiveStreamRecordsEqual(record, normalized)) {
            changed = true;
        }
    });

    if (Object.keys(nextSnapshot).length !== Object.keys(sourceSnapshot).length) {
        changed = true;
    }

    return {
        snapshot: nextSnapshot,
        changed
    };
}

export function hasActiveStreamsInSnapshot(snapshot, options = {}) {
    const { snapshot: nextSnapshot } = normalizeActiveStreamsSnapshot(snapshot, options);
    return Object.values(nextSnapshot).some((record) => Boolean(record?.requestId));
}

export async function pruneStoredActiveStreams(storage, options = {}) {
    const result = await storage.get(ACTIVE_STREAMS_BY_TAB_KEY);
    const { snapshot, changed } = normalizeActiveStreamsSnapshot(result[ACTIVE_STREAMS_BY_TAB_KEY], options);
    if (changed) {
        await storage.set({
            [ACTIVE_STREAMS_BY_TAB_KEY]: snapshot
        });
    }
    return snapshot;
}

export async function hasStoredActiveStreams(storage, options = {}) {
    const snapshot = await pruneStoredActiveStreams(storage, options);
    return Object.values(snapshot).some((record) => Boolean(record?.requestId));
}
