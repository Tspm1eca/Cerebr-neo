import { computeChatHash } from './src/utils/chat-hash.js';
import { SYNC_MODE_FLAG_KEY } from './src/utils/storage-adapter.js';

// Helper: 根據 sync 模式 flag 取得正確的 storage area（Service Worker 可能隨時重啟）
async function getSyncStorage() {
    const result = await chrome.storage.local.get(SYNC_MODE_FLAG_KEY);
    return result[SYNC_MODE_FLAG_KEY] ? chrome.storage.local : chrome.storage.sync;
}

// 确保 Service Worker 立即激活
self.addEventListener('install', (event) => {
  console.log('Service Worker 安装中...', new Date().toISOString());
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // console.log('Service Worker 已激活', new Date().toISOString());
  event.waitUntil(
    (async () => {
      // 使用 clients.claim() 来控制未受控制的客户端。
      // 这在开发过程中或没有要声明的客户端时可能会失败。
      // 安全地捕获错误以避免未捕ared 的 Promise 拒绝。
      try {
        await self.clients.claim();
      } catch (error) {
        // console.warn('clients.claim() 失败，但可以安全地忽略:', error);
      }
    })()
  );
});

// 添加启动日志
// console.log('Background script loaded at:', new Date().toISOString());

// 重新注入 content script 并等待连接
async function reinjectContentScript(tabId) {
  console.log('标签页未连接，尝试重新注入 content script...');
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'lib/pdf.js',
        'lib/turndown.js',
        'lib/turndown-plugin-gfm.js',
        'content.js'
      ]
    });
    console.log('已重新注入 content script');
    // 给脚本一点时间初始化
    await new Promise(resolve => setTimeout(resolve, 500));
    const isConnected = await isTabConnected(tabId);
    if (!isConnected) {
      console.log('重新注入后仍未连接');
    }
    return isConnected;
  } catch (error) {
    console.error('重新注入 content script 失败:', error);
    return false;
  }
}

// 处理标签页连接和消息发送的通用函数
async function handleTabCommand(commandType) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.log('没有找到活动标签页');
      return;
    }

    // 检查标签页是否已连接
    const isConnected = await isTabConnected(tab.id);
    if (!isConnected && await reinjectContentScript(tab.id)) {
      await chrome.tabs.sendMessage(tab.id, { type: commandType });
      return;
    }

    if (isConnected) {
      await chrome.tabs.sendMessage(tab.id, { type: commandType });
    }
  } catch (error) {
    console.error(`处理${commandType}命令失败:`, error);
  }
}

// 监听扩展图标点击
chrome.action.onClicked.addListener(async (tab) => {
  console.log('扩展图标被点击');
  try {
    // 检查标签页是否已连接
    const isConnected = await isTabConnected(tab.id);
    if (!isConnected && await reinjectContentScript(tab.id)) {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_onClicked' });
      return;
    }

    if (isConnected) {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_onClicked' });
    }
  } catch (error) {
    console.error('处理切换失败:', error);
  }
});

// 简化后的命令监听器
chrome.commands.onCommand.addListener(async (command) => {
  console.log('onCommand:', command);

  if (command === 'new_chat') {
    // 同時發送給 content script（浮窗模式）和 side panel（側欄模式）
    await handleTabCommand('NEW_CHAT');
    chrome.runtime.sendMessage({ type: 'NEW_CHAT' }).catch(() => {});
  }
});

// 创建一个持久连接
let port = null;
chrome.runtime.onConnect.addListener((p) => {
  // console.log('建立持久连接');
  port = p;
  port.onDisconnect.addListener(() => {
    // console.log('连接断开，尝试重新连接', p.sender.tab.id, p.sender.tab.url);
    port = null;
  });
});

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // console.log('收到消息:', message, '来自:', sender.tab?.id);

  if (message.type === 'GET_ALL_TABS') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({});
        sendResponse(tabs);
      } catch (e) {
        console.error("Failed to get all tabs:", e);
        sendResponse(null);
      }
    })();
    return true;
  }

  if (message.type === 'GET_CURRENT_TAB') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        sendResponse(tab);
      } catch (e) {
        console.error("Failed to get current tab:", e);
        sendResponse(null);
      }
    })();
    return true; // Indicates that the response is sent asynchronously.
  }

  if (message.type === 'CONTENT_LOADED') {
    // console.log('内容脚本已加载:', message.url);
    sendResponse({ status: 'ok', timestamp: new Date().toISOString() });
    return false;
  }

  // 检查标签页是否活跃
  if (message.type === 'CHECK_TAB_ACTIVE') {
    (async () => {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) {
          sendResponse(false);
          return;
        }
        sendResponse(sender.tab && sender.tab.id === activeTab.id);
      } catch (error) {
        console.error('检查标签页活跃状态失败:', error);
        sendResponse(false);
      }
    })();
    return true;
  }

  if (message.type === 'IS_TAB_CONNECTED') {
    (async () => {
        const isConnected = await isTabConnected(message.tabId);
        sendResponse(isConnected);
    })();
    return true; // 保持通道开放以进行异步响应
  }

  if (message.type === 'RELOAD_TAB') {
    (async () => {
        try {
            await chrome.tabs.reload(message.tabId);
            sendResponse({ status: 'success' });
        } catch (error) {
            console.error(`Failed to reload tab ${message.tabId}:`, error);
            sendResponse({ status: 'error', error: error.message });
        }
    })();
    return true;
  }

  // 处理来自 sidebar 的网页内容请求
  if (message.type === 'GET_PAGE_CONTENT_FROM_SIDEBAR') {
    (async () => {
      try {
        // 确保请求来自我们的扩展UI
        if (!sender.url || !sender.url.includes('index.html')) {
          console.warn('GET_PAGE_CONTENT_FROM_SIDEBAR request from invalid sender:', sender.url);
          sendResponse(null);
          return;
        }

        // 如果消息中指定了 tabId，则使用它；否则，查询当前活动标签页
        const tabIdToQuery = message.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

        if (!tabIdToQuery) {
          console.warn('No target tab found for GET_PAGE_CONTENT_FROM_SIDEBAR');
          sendResponse(null);
          return;
        }

        let isConnected = await isTabConnected(tabIdToQuery);
        if (!isConnected) {
            // 如果未连接，尝试重新注入脚本
            console.log(`Tab ${tabIdToQuery} not connected, attempting to reinject content script.`);
            isConnected = await reinjectContentScript(tabIdToQuery);
        }

        if (isConnected) {
          const response = await chrome.tabs.sendMessage(tabIdToQuery, {
            type: 'GET_PAGE_CONTENT_INTERNAL',
            skipWaitContent: message.skipWaitContent || false
          });
          sendResponse(response);
        } else {
          console.warn(`Tab ${tabIdToQuery} is still not connected, even after attempting to reinject.`);
          sendResponse(null);
        }
      } catch (error) {
        console.error(`Error in GET_PAGE_CONTENT_FROM_SIDEBAR for tab ${message.tabId}:`, error);
        sendResponse(null);
      }
    })();
    return true;
  }

  // 处理图片获取请求（绕过 CORS 限制）
  if (message.action === 'fetchImageAsBase64') {
    (async () => {
      try {
        const response = await fetch(message.url, {
          method: 'GET',
          credentials: 'include',
          mode: 'cors'
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const blob = await response.blob();

        // 将 blob 转换为 base64
        const reader = new FileReader();
        const base64Promise = new Promise((resolve, reject) => {
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
        });
        reader.readAsDataURL(blob);

        const base64Data = await base64Promise;
        sendResponse({ success: true, data: base64Data });
      } catch (error) {
        console.error('获取图片失败:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  // 处理PDF下载请求
  if (message.action === 'downloadPDF') {
    (async () => {
      try {
        const response = await downloadPDF(message.url);
        sendResponse(response);
      } catch (error) {
        sendResponse({success: false, error: error.message});
      }
    })();
    return true;
  }

  // 处理获取PDF块的请求
  if (message.action === 'getPDFChunk') {
    (async () => {
      try {
        const response = await getPDFChunk(message.url, message.chunkIndex);
        sendResponse(response);
      } catch (error) {
        sendResponse({success: false, error: error.message});
      }
    })();
    return true;
  }

  // 处理模式切换
  if (message.type === 'SWITCH_MODE') {
      (async () => {
          try {
              // 获取当前窗口ID，优先使用 sender.tab 的 windowId，否则获取当前窗口
              let windowId;
              if (sender.tab) {
                  windowId = sender.tab.windowId;
              } else {
                  const currentWindow = await chrome.windows.getCurrent();
                  windowId = currentWindow.id;
              }

              if (message.mode === 'side_panel') {
                  // 切换到 Side Panel 模式
                  // 设置点击图标打开 Side Panel
                  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

                  // 关闭当前页面可能存在的 iframe 侧边栏
                  if (sender.tab) {
                      await chrome.tabs.sendMessage(sender.tab.id, { type: 'SET_SIDEBAR_VISIBLE', visible: false });
                  } else {
                      const [tab] = await chrome.tabs.query({ active: true, windowId });
                      if (tab) {
                          await chrome.tabs.sendMessage(tab.id, { type: 'SET_SIDEBAR_VISIBLE', visible: false });
                      }
                  }

                  // 尝试打开 Side Panel (需要用户交互，如果是在点击事件中触发可能成功)
                  try {
                       await chrome.sidePanel.open({ windowId });
                  } catch (e) {
                      console.log('无法自动打开 Side Panel (可能需要用户点击扩展图标):', e);
                  }

              } else {
                  // 切换到悬浮窗 (Iframe) 模式
                  // 设置点击图标不再打开 Side Panel (恢复默认行为: 触发 action onClicked)
                  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

                  // 打开 iframe 侧边栏
                  const [tab] = await chrome.tabs.query({ active: true, windowId });
                  if (tab) {
                      // 首先确保 content script 已注入
                      const isConnected = await isTabConnected(tab.id);
                      if (!isConnected) {
                          await reinjectContentScript(tab.id);
                      }
                      await chrome.tabs.sendMessage(tab.id, { type: 'SET_SIDEBAR_VISIBLE', visible: true });
                  }
              }

              sendResponse({ success: true });
          } catch (error) {
              console.error('切换模式失败:', error);
              sendResponse({ success: false, error: error.message });
          }
      })();
      return true;
  }

  // ========== WebDAV 關閉同步委託 ==========
  if (message.type === 'WEBDAV_SYNC_UPLOAD') {
      performWebDAVSyncUpload()
          .then(() => sendResponse({ success: true }))
          .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
  }

  return false;
});

// 监听存储变化
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.webpageSwitchDomains) {
        const { newValue = {}, oldValue = {} } = changes.webpageSwitchDomains;
        const domains = { ...oldValue, ...newValue };
        chrome.storage.local.set({ webpageSwitchDomains: domains });
    }
});

// 简化初始化检查
chrome.runtime.onInstalled.addListener(() => {
    console.log('扩展已安装/更新:', new Date().toISOString());
});

// 改进标签页连接检查
async function isTabConnected(tabId) {
    try {
        // console.log(`isTabConnected PING: ${tabId}`);
        const response = await chrome.tabs.sendMessage(tabId, {
            type: 'PING',
            timestamp: Date.now()
        });
        // console.log('isTabConnected:', response.type);
        return response && response.type === 'PONG';
    } catch {
        return false;
    }
}

// 添加公共的PDF文件获取函数
async function getPDFArrayBuffer(url) {
  if (url.startsWith('file://')) {
      // 处理本地文件
      const response = await fetch(url);
      if (!response.ok) {
          throw new Error('无法读取本地PDF文件');
      }
      return response.arrayBuffer();
  } else {
      const headers = {
          'Accept': 'application/pdf,*/*',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
      };

      // 如果是ScienceDirect的URL，添加特殊处理
      if (url.includes('sciencedirectassets.com')) {
          // 从原始页面获取必要的cookie和referer
          headers['Accept'] = '*/*';  // ScienceDirect需要这个
          headers['Referer'] = 'https://www.sciencedirect.com/';
          headers['Origin'] = 'https://www.sciencedirect.com';
          headers['Connection'] = 'keep-alive';
      }
      const response = await fetch(url, {
        method: 'GET',
        headers: headers,
        credentials: 'include',
        mode: 'cors'
      });
      // 处理在线文件
      if (!response.ok) {
          throw new Error('PDF文件下载失败');
      }
      return response.arrayBuffer();
  }
}

// 修改 downloadPDF 函数
async function downloadPDF(url) {
  try {
      // console.log('开始下载PDF文件:', url);
      const arrayBuffer = await getPDFArrayBuffer(url);
      // console.log('PDF文件下载完成，大小:', arrayBuffer.byteLength, 'bytes');

      // 将ArrayBuffer转换为Uint8Array
      const uint8Array = new Uint8Array(arrayBuffer);

      // 分块大小设为4MB
      const chunkSize = 4 * 1024 * 1024;
      const chunks = Math.ceil(uint8Array.length / chunkSize);

      // 发送第一个消息，包含总块数和文件大小信息
      return {
          success: true,
          type: 'init',
          totalChunks: chunks,
          totalSize: uint8Array.length
      };
  } catch (error) {
      console.error('PDF下载失败:', error);
      console.error('错误堆栈:', error.stack);
      throw new Error('PDF下载失败: ' + error.message);
  }
}

// 修改 getPDFChunk 函数
async function getPDFChunk(url, chunkIndex) {
  try {
      const arrayBuffer = await getPDFArrayBuffer(url);
      const uint8Array = new Uint8Array(arrayBuffer);
      const chunkSize = 4 * 1024 * 1024;
      const start = chunkIndex * chunkSize;
      const end = Math.min(start + chunkSize, uint8Array.length);

      return {
          success: true,
          type: 'chunk',
          chunkIndex: chunkIndex,
          data: Array.from(uint8Array.slice(start, end))
      };
  } catch (error) {
      console.error('获取PDF块数据失败:', error);
      return {
          success: false,
          error: error.message
      };
  }
}

// 监听标签页激活事件，并通知相关方，兼容 Firefox 需要
chrome.tabs.onActivated.addListener(activeInfo => {
  chrome.runtime.sendMessage({
    type: 'TAB_ACTIVATED',
    payload: activeInfo
  }).catch(error => {
    // 忽略错误，因为可能没有页面在监听
    if (error.message.includes('Could not establish connection') || error.message.includes('Receiving end does not exist')) {
      // This is expected if no content script is listening
    } else {
      console.error('Error sending TAB_ACTIVATED message:', error);
    }
  });
});

// ========== WebDAV 關閉同步：Service Worker 自包含上傳 ==========

/**
 * Service Worker 自包含的 WebDAV 上傳同步
 * 從 chrome.storage 讀取所有必要資料，執行上傳，更新狀態
 * 用於頁面關閉時接替 side panel 完成同步
 */
async function performWebDAVSyncUpload() {
    try {
        // 0. 等待短暫時間，讓新面板有機會啟動並設置 webdav_panel_active 標記
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 0.1 若面板已重新啟動（會自行透過 syncOnOpen 處理同步），跳過 SW 上傳
        const { webdav_panel_active: panelActive } = await chrome.storage.local.get('webdav_panel_active');
        if (panelActive) {
            console.log('[WebDAV SW] 面板已啟動，跳過 SW 同步（面板會接手）');
            return;
        }

        // 1. 讀取 WebDAV 配置
        const syncStorage = await getSyncStorage();
        const { webdav_config: config } = await syncStorage.get('webdav_config');
        if (!config || !config.enabled) return;

        // 加密已启用但未设置密码时，跳过 SW 同步
        if (config.encryptApiKeys && !config.encryptionPassword) {
            console.log('[WebDAV SW] 加密已启用但未设置加密密码，跳过同步');
            return;
        }

        // 2. 讀取 dirty chat IDs + tombstone（重新讀取，可能已被面板更新）
        const {
            cerebr_dirty_chat_ids: dirtyIdsRaw,
            webdav_deleted_chat_ids: tombstonesRaw
        } = await chrome.storage.local.get(['cerebr_dirty_chat_ids', 'webdav_deleted_chat_ids']);
        const dirtyIds = Array.isArray(dirtyIdsRaw) ? dirtyIdsRaw : [];
        const tombstones = Array.isArray(tombstonesRaw) ? tombstonesRaw : [];

        // 3. 讀取 dirty chats + 同步狀態
        const chatKeys = dirtyIds.map(id => `cerebr_chat_${id}`);
        const localData = await chrome.storage.local.get([
            ...chatKeys,
            'webdav_cached_manifest',
            'webdav_local_chat_hashes'
        ]);

        const cachedManifest = localData.webdav_cached_manifest;
        const hashTable = new Map(Object.entries(localData.webdav_local_chat_hashes || {}));
        const chatIndex = [...(cachedManifest?.chatIndex || [])];
        const tombstonesForReplay = tombstones.length > 0
            ? tombstones
            : (cachedManifest?.deletedChatIds || []);
        if (dirtyIds.length === 0 && tombstonesForReplay.length === 0) return;

        // 4. 建立 WebDAV 請求基礎
        const baseUrl = config.serverUrl.replace(/\/+$/, '');
        const syncPath = config.syncPath.replace(/^\/+/, '').replace(/\/+$/, '');
        const getUrl = (path) => `${baseUrl}/${syncPath}/${path}`;
        const credentials = btoa(`${config.username}:${config.password}`);
        const headers = {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
        };

        // 5. 上傳 dirty chats 並更新 chatIndex
        const uploadedIds = [];
        for (const id of dirtyIds) {
            const chat = localData[`cerebr_chat_${id}`];
            if (!chat || chat._remoteOnly) continue;

            try {
                const response = await fetch(getUrl(`chats/${id}.json`), {
                    method: 'PUT', headers, body: JSON.stringify(chat)
                });
                if (response.ok) {
                    uploadedIds.push(id);

                    const hash = computeChatHash(chat);
                    hashTable.set(id, hash);

                    const entry = {
                        id: chat.id,
                        title: chat.title || '',
                        createdAt: chat.createdAt || new Date().toISOString(),
                        updatedAt: chat.updatedAt || new Date().toISOString(),
                        webpageUrls: chat.webpageUrls || [],
                        messageCount: (chat.messages || []).length,
                        hash
                    };
                    const existingIdx = chatIndex.findIndex(e => e.id === id);
                    if (existingIdx >= 0) {
                        chatIndex[existingIdx] = entry;
                    } else {
                        chatIndex.push(entry);
                    }
                }
            } catch (e) {
                console.error(`[WebDAV SW] 上傳聊天 ${id} 失敗:`, e);
            }
        }

        // 6. 回放 tombstone 刪除（404 視為成功）
        const failedTombstones = new Set();
        for (const tombstone of tombstonesForReplay) {
            try {
                const response = await fetch(getUrl(`chats/${tombstone.id}.json`), {
                    method: 'DELETE',
                    headers
                });
                if (!response.ok && response.status !== 404) {
                    failedTombstones.add(tombstone.id);
                    console.warn(`[WebDAV SW] 刪除 tombstone ${tombstone.id} 失敗: HTTP ${response.status}`);
                }
            } catch (error) {
                failedTombstones.add(tombstone.id);
                console.warn(`[WebDAV SW] 刪除 tombstone ${tombstone.id} 失敗:`, error);
            }
        }
        const remainingTombstones = tombstonesForReplay.filter(t => failedTombstones.has(t.id));

        const tombstoneChanged = remainingTombstones.length !== tombstonesForReplay.length;
        if (uploadedIds.length === 0 && !tombstoneChanged) return;

        // 7. 建立並上傳 manifest
        const manifest = {
            version: 2,
            timestamp: new Date().toISOString(),
            chatIndex,
            deletedChatIds: remainingTombstones,
            quickChatOptions: cachedManifest?.quickChatOptions || []
        };

        // 保留快取 manifest 中的 API 設定（不在 SW 中重新加密）
        if (cachedManifest?.apiSettings) {
            manifest.apiSettings = cachedManifest.apiSettings;
            if (cachedManifest.apiSettingsEncrypted) {
                manifest.apiSettingsEncrypted = true;
            }
        }

        const manifestResponse = await fetch(getUrl('cerebr.json'), {
            method: 'PUT', headers, body: JSON.stringify(manifest)
        });

        if (!manifestResponse.ok) {
            throw new Error(`manifest 上傳失敗: HTTP ${manifestResponse.status}`);
        }

        // 8. 更新同步狀態
        const newETag = manifestResponse.headers.get('ETag') || manifestResponse.headers.get('Last-Modified') || null;

        const syncUpdates = {};
        if (newETag) syncUpdates.webdav_remote_etag = newETag;
        syncUpdates.webdav_last_sync = manifest.timestamp;
        syncUpdates.webdav_last_sync_timestamp = manifest.timestamp;
        await syncStorage.set(syncUpdates);

        // 清除已上傳的 dirty IDs，儲存更新後的狀態
        const { cerebr_dirty_chat_ids: currentDirty } = await chrome.storage.local.get('cerebr_dirty_chat_ids');
        const uploadedSet = new Set(uploadedIds);
        const remaining = (currentDirty || []).filter(id => !uploadedSet.has(id));

        await chrome.storage.local.set({
            cerebr_dirty_chat_ids: remaining,
            webdav_deleted_chat_ids: remainingTombstones,
            webdav_cached_manifest: manifest,
            webdav_local_chat_hashes: Object.fromEntries(hashTable)
        });

        console.log(
            `[WebDAV SW] 關閉同步完成：已上傳 ${uploadedIds.length} 個聊天，已刪除 ${tombstonesForReplay.length - remainingTombstones.length} 個 tombstone`
        );
    } catch (e) {
        console.error('[WebDAV SW] 同步上傳失敗:', e);
        throw e;
    }
}
