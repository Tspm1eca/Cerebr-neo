// 检测是否在Chrome扩展环境中
export const isExtensionEnvironment = !!(typeof chrome !== 'undefined' && chrome.runtime);

const IDB_DB_NAME = 'CerebrData';
const IDB_DB_VERSION = 1;
const IDB_STORE_NAME = 'keyValueStore';

let dbPromise = null;

function getDb() {
    if (!isExtensionEnvironment && !dbPromise) { //仅在非插件环境且dbPromise未初始化时创建
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
                    db.createObjectStore(IDB_STORE_NAME);
                }
            };

            request.onsuccess = (event) => {
                resolve(event.target.result);
            };

            request.onerror = (event) => {
                console.error('IndexedDB database error:', event.target.error);
                reject(event.target.error);
            };
        });
    }
    return dbPromise;
}

// 存储适配器
export const storageAdapter = {
    // 获取存储的数据（支援單一 key 或 key 陣列）
    async get(keyOrKeys) {
        if (isExtensionEnvironment) {
            return await chrome.storage.local.get(keyOrKeys);
        } else {
            const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
            try {
                const db = await getDb();
                if (!db) return Object.fromEntries(keys.map(k => [k, undefined]));

                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([IDB_STORE_NAME], 'readonly');
                    const store = transaction.objectStore(IDB_STORE_NAME);
                    const result = {};

                    for (const key of keys) {
                        const request = store.get(key);
                        request.onsuccess = () => {
                            result[key] = request.result;
                        };
                        request.onerror = (event) => {
                            console.error(`IndexedDB get error for key ${key}:`, event.target.error);
                            reject(event.target.error);
                        };
                    }

                    transaction.oncomplete = () => resolve(result);
                    transaction.onerror = (event) => {
                        console.error('IndexedDB get transaction error:', event.target.error);
                        reject(event.target.error);
                    };
                });
            } catch (error) {
                console.error('Failed to get data from IndexedDB:', error);
                return Object.fromEntries(keys.map(k => [k, undefined]));
            }
        }
    },

    // 设置存储的数据
    async set(data) {
        if (isExtensionEnvironment) {
            await chrome.storage.local.set(data);
        } else {
            try {
                const db = await getDb();
                if (!db) throw new Error("IndexedDB not available");

                // data 是一個物件，迭代它來存儲每個鍵值對
                // 例如：{ 'cerebr_chat_123': chatObj, 'cerebr_chat_index': [...] }

                const entries = Object.entries(data);
                if (entries.length === 0) return Promise.resolve();

                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([IDB_STORE_NAME], 'readwrite');
                    const store = transaction.objectStore(IDB_STORE_NAME);

                    entries.forEach(([key, value]) => {
                        const request = store.put(value, key);
                        request.onerror = (event) => {
                            console.error(`IndexedDB set error for key ${key}:`, event.target.error);
                            transaction.abort();
                            reject(event.target.error);
                        };
                    });

                    transaction.oncomplete = () => {
                        resolve();
                    };
                    transaction.onerror = (event) => {
                        console.error('IndexedDB set transaction error:', event.target.error);
                        reject(event.target.error);
                    };
                     transaction.onabort = (event) => {
                        console.error('IndexedDB set transaction aborted:', event.target.error);
                        reject(new Error('Transaction aborted, possibly due to an earlier error.'));
                    };
                });

            } catch (error) {
                console.error('Failed to set data in IndexedDB:', error);
                // 根据应用的需要决定如何处理这个错误，例如向上抛出
                throw error;
            }
        }
    },

    // 刪除存儲的數據（支援單一 key 或 key 陣列）
    async remove(keys) {
        const keyArray = Array.isArray(keys) ? keys : [keys];
        if (keyArray.length === 0) return;

        if (isExtensionEnvironment) {
            await chrome.storage.local.remove(keyArray);
        } else {
            try {
                const db = await getDb();
                if (!db) throw new Error("IndexedDB not available");

                return new Promise((resolve, reject) => {
                    const transaction = db.transaction([IDB_STORE_NAME], 'readwrite');
                    const store = transaction.objectStore(IDB_STORE_NAME);

                    for (const key of keyArray) {
                        store.delete(key);
                    }

                    transaction.oncomplete = () => resolve();
                    transaction.onerror = (event) => {
                        console.error('IndexedDB remove transaction error:', event.target.error);
                        reject(event.target.error);
                    };
                    transaction.onabort = (event) => {
                        console.error('IndexedDB remove transaction aborted:', event.target.error);
                        reject(new Error('Transaction aborted'));
                    };
                });
            } catch (error) {
                console.error('Failed to remove data from IndexedDB:', error);
                throw error;
            }
        }
    }
};

// ===== Sync 模式切換：WebDAV 啟用時改用 local storage =====
export const SYNC_MODE_FLAG_KEY = 'cerebr_use_local_sync';
const SYNC_MIGRATION_STATE_KEY = 'cerebr_sync_migration_state';

let _useLocalForSync = false;

// 所有透過 syncStorageAdapter 管理的 keys（遷移與健檢共用）
export const SYNC_KEYS_REGISTRY = Object.freeze([
    'apiConfigs', 'selectedConfigIndex',
    'searchProvider', 'tavilyApiKey', 'tavilyApiUrl', 'exaApiKey', 'exaApiUrl',
    'quickChatOptions',
    'sendWebpageContent', 'webSearchMode', 'enableWebSearch', // 舊版兼容：僅遷移
    'cerebrLocale',
    'webdav_config',
    'webdav_remote_etag', 'webdav_local_hash',
    'webdav_last_sync', 'webdav_last_sync_timestamp'
]);
const SYNC_KEYS_REGISTRY_SET = new Set(SYNC_KEYS_REGISTRY);
const DEFAULT_SYNC_MODE_OPTIONS = Object.freeze({
    cleanupSource: false,
    verifyAfterCopy: true
});

function areSyncValuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function warnUnregisteredSyncKeys(data) {
    if (!data || typeof data !== 'object') {
        return;
    }
    const unknownKeys = Object.keys(data).filter((key) => !SYNC_KEYS_REGISTRY_SET.has(key));
    if (unknownKeys.length > 0) {
        console.warn('[SyncMode] 检测到未注册的 sync key，请补充至 SYNC_KEYS_REGISTRY:', unknownKeys);
    }
}

// 啟動時讀取 flag（必須在任何 syncStorageAdapter 操作之前呼叫）
export async function initSyncMode() {
    if (!isExtensionEnvironment) return;
    const result = await chrome.storage.local.get(SYNC_MODE_FLAG_KEY);
    _useLocalForSync = result[SYNC_MODE_FLAG_KEY] === true;
    console.log(`[SyncMode] 初始化完成：当前使用 ${_useLocalForSync ? 'local' : 'sync'}，registry keys=${SYNC_KEYS_REGISTRY.length}`);
}

// 切換模式並遷移數據
export async function setSyncMode(useLocal, options = {}) {
    if (!isExtensionEnvironment) return { switched: false, reason: 'not-extension' };

    const { cleanupSource, verifyAfterCopy } = {
        ...DEFAULT_SYNC_MODE_OPTIONS,
        ...options
    };
    const currentFlagResult = await chrome.storage.local.get(SYNC_MODE_FLAG_KEY);
    const currentUseLocal = currentFlagResult[SYNC_MODE_FLAG_KEY] === true;
    _useLocalForSync = currentUseLocal;

    if (currentUseLocal === useLocal) {
        return { switched: false, reason: 'already-target-mode' };
    }

    const source = useLocal ? chrome.storage.sync : chrome.storage.local;
    const target = useLocal ? chrome.storage.local : chrome.storage.sync;

    let movedKeys = [];
    try {
        // 從來源讀取並複製到目標（預設不刪來源，降低多裝置風險）
        const data = await source.get(SYNC_KEYS_REGISTRY);
        movedKeys = Object.keys(data);
        if (movedKeys.length > 0) {
            await target.set(data);
            if (verifyAfterCopy) {
                const verifyData = await target.get(movedKeys);
                const mismatchKeys = movedKeys.filter((key) => !areSyncValuesEqual(data[key], verifyData[key]));
                if (mismatchKeys.length > 0) {
                    throw new Error(`同步数据校验失败: ${mismatchKeys.join(', ')}`);
                }
            }
            if (cleanupSource) {
                await source.remove(movedKeys);
            }
        }

        // 持久化 flag 並更新記憶體
        _useLocalForSync = useLocal;
        await chrome.storage.local.set({
            [SYNC_MODE_FLAG_KEY]: useLocal,
            [SYNC_MIGRATION_STATE_KEY]: {
                from: currentUseLocal ? 'local' : 'sync',
                to: useLocal ? 'local' : 'sync',
                finishedAt: new Date().toISOString(),
                success: true,
                movedKeys
            }
        });
        return { switched: true, movedKeys };
    } catch (error) {
        _useLocalForSync = currentUseLocal;
        await chrome.storage.local.set({
            [SYNC_MIGRATION_STATE_KEY]: {
                from: currentUseLocal ? 'local' : 'sync',
                to: useLocal ? 'local' : 'sync',
                finishedAt: new Date().toISOString(),
                success: false,
                movedKeys,
                error: error.message
            }
        });
        throw error;
    }
}

// 同步存储适配器
export const syncStorageAdapter = {
    // 获取存储的数据
    async get(key) {
        if (isExtensionEnvironment) {
            const storage = _useLocalForSync ? chrome.storage.local : chrome.storage.sync;
            return await storage.get(key);
        } else {
            // 对于 sync，localStorage 可能是个更简单的回退，因为它本身容量就小
            // 或者您也可以为 sync 实现单独的 IndexedDB 存储（例如不同的 object store）
            // 这里暂时保持 localStorage 作为示例，但请注意其容量限制
            console.warn("Sync storage in web environment is using localStorage fallback, which has size limitations.");
            if (Array.isArray(key)) {
                const result = {};
                for (const k of key) {
                    const value = localStorage.getItem(`sync_${k}`);
                    if (value) {
                        try {
                            result[k] = JSON.parse(value);
                        } catch (e) {
                             console.error(`Error parsing sync_ ${k} from localStorage`, e);
                        }
                    }
                }
                return result;
            } else {
                const value = localStorage.getItem(`sync_${key}`);
                if (value) {
                    try {
                        return { [key]: JSON.parse(value) };
                    } catch (e) {
                        console.error(`Error parsing sync_ ${key} from localStorage`, e);
                    }
                }
                return {};
            }
        }
    },

    // 设置存储的数据
    async set(data) {
        if (isExtensionEnvironment) {
            warnUnregisteredSyncKeys(data);
            const storage = _useLocalForSync ? chrome.storage.local : chrome.storage.sync;
            await storage.set(data);
        } else {
            console.warn("Sync storage in web environment is using localStorage fallback, which has size limitations.");
            for (const [key, value] of Object.entries(data)) {
                try {
                    localStorage.setItem(`sync_${key}`, JSON.stringify(value));
                } catch (e) {
                    console.error(`Error setting sync_ ${key} to localStorage`, e);
                    // 如果 localStorage 也满了，这里可能会抛出 QuotaExceededError
                    throw e;
                }
            }
        }
    }
};

// 浏览器API适配器
export const browserAdapter = {
    // 获取当前标签页信息
    async getCurrentTab() {
        if (isExtensionEnvironment) {
            const tab = await chrome.runtime.sendMessage({ type: "GET_CURRENT_TAB" });
            if (!tab?.url) return null;

            // 处理本地文件
            if (tab.url.startsWith('file://')) {
                return {
                    id: tab.id,
                    url: 'file://',
                    title: 'Local PDF',
                    hostname: 'local_pdf'
                };
            }

            const url = new URL(tab.url);
            return {
                id: tab.id,
                url: tab.url,
                title: tab.title,
                hostname: url.hostname
            };
        } else {
            const url = window.location.href;
            // 处理本地文件
            if (url.startsWith('file://')) {
                return {
                    id: tab.id,
                    url: 'file://',
                    title: 'Local PDF',
                    hostname: 'local_pdf'
                };
            }
            return {
                id: tab.id,
                url: url,
                title: document.title,
                hostname: window.location.hostname
            };
        }
    },

    // 发送消息
    async sendMessage(message) {
        if (isExtensionEnvironment) {
           return new Promise((resolve, reject) => {
               chrome.runtime.sendMessage(message, (response) => {
                   if (chrome.runtime.lastError) {
                       return reject(chrome.runtime.lastError);
                   }
                   resolve(response);
               });
           });
        } else {
            console.warn('Message passing is not supported in web environment:', message);
            return Promise.resolve(null);
        }
    },

    getAllTabs: () => {
        if (!isExtensionEnvironment) {
            return Promise.resolve([{
                id: 'current',
                title: document.title,
                url: window.location.href,
            }]);
        }
        // Must be sent to background script to access tabs API
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'GET_ALL_TABS' }, (response) => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve(response);
            });
        });
    },

    executeScriptInTab: (tabId, func, args = []) => {
        return new Promise((resolve, reject) => {
            if (!isExtensionEnvironment) {
                return reject(new Error('Not in an extension environment.'));
            }
            chrome.scripting.executeScript(
                {
                    target: { tabId: tabId },
                    func: func,
                    args: args,
                    world: 'MAIN'
                },
                (injectionResults) => {
                    if (chrome.runtime.lastError) {
                        return reject(chrome.runtime.lastError);
                    }
                    if (injectionResults && injectionResults.length > 0) {
                        resolve(injectionResults[0].result);
                    } else {
                        resolve(null);
                    }
                }
            );
        });
    },

    // 添加标签页变化监听器
    onTabActivated(callback) {
        if (isExtensionEnvironment) {
            // In a non-background script, we can't directly access chrome.tabs.
            // We listen for messages from the background script instead.
            // chrome.tabs.onActivated.addListener(callback);

            // 兼容 Firefox 需要
            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                if (message.type === 'TAB_ACTIVATED') {
                    callback(message.payload);
                }
            });
        }
    },

    isTabConnected: (tabId) => {
        if (!isExtensionEnvironment) return Promise.resolve(false);

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log(`Tab ${tabId} timed out.`);
                resolve(false);
            }, 100); // 200毫秒超时

            chrome.runtime.sendMessage({ type: 'IS_TAB_CONNECTED', tabId }, (response) => {
                clearTimeout(timeout);
                if (chrome.runtime.lastError) {
                    // 比如tab不存在或无法访问
                    // console.warn(`Error checking tab ${tabId}:`, chrome.runtime.lastError.message);
                    return resolve(false);
                }
                resolve(response);
            });
        });
    },

    reloadTab: (tabId) => {
        if (!isExtensionEnvironment) return Promise.resolve(false);
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'RELOAD_TAB', tabId }, (response) => {
                if (chrome.runtime.lastError || response?.status === 'error') {
                    console.error(`Failed to reload tab ${tabId}:`, chrome.runtime.lastError || response?.error);
                    return resolve(false);
                }
                resolve(true);
            });
        });
    }
};

// 记录存储空间占用的函数
function logStorageUsage() {
    if (isExtensionEnvironment && typeof chrome.storage.local.getBytesInUse === 'function') {
        chrome.storage.local.getBytesInUse(null).then((bytesInUse) => {
            console.log(`[Cerebr] 插件(Chrome)本地存储精确占用: ${(bytesInUse / (1024 * 1024)).toFixed(2)} MB`);
        }).catch(error => {
            console.warn("[Cerebr] 获取插件本地存储空间失败:", error);
        });
    }
    // 在 Firefox 等其他插件环境中，使用手动计算作为回退，兼容 Firefox 需要
    else if (isExtensionEnvironment) {
        chrome.storage.local.get(null, (items) => {
            if (chrome.runtime.lastError) {
                console.error("[Cerebr] 手动计算存储失败 (获取数据出错):", chrome.runtime.lastError);
                return;
            }
            try {
                const jsonString = JSON.stringify(items);
                // 使用 Blob 来获取 UTF-8 编码的字节大小，这比简单地计算字符串长度更准确
                const bytes = new Blob([jsonString]).size;
                console.log(`[Cerebr] 插件(Firefox/其他)本地存储估算占用: ${(bytes / (1024 * 1024)).toFixed(2)} MB`);
            } catch (e) {
                console.error("[Cerebr] 手动计算存储失败 (JSON序列化出错):", e);
            }
        });
    } else {
        // 网页环境 - IndexedDB
        if (navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then(estimate => {
                console.log(`[Cerebr] 网页预估存储使用 (IndexedDB等): ${(estimate.usage / (1024 * 1024)).toFixed(2)} MB / 配额: ${(estimate.quota / (1024 * 1024)).toFixed(2)} MB`);
            }).catch(error => {
                console.warn("[Cerebr] 无法通过 navigator.storage.estimate() 获取网页存储信息:", error);
                console.log("[Cerebr] 网页环境使用 IndexedDB。具体大小请通过浏览器开发者工具查看。");
            });
        } else {
            console.log("[Cerebr] 网页环境使用 IndexedDB。具体大小请通过浏览器开发者工具查看。");
        }
    }
}

// 在模块加载时执行日志记录
logStorageUsage();
