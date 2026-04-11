import {
  encrypt,
  decrypt,
  decryptPasswordFromStorage,
  isEncryptedPassword
} from './src/utils/crypto.js';
import { SYNC_MODE_FLAG_KEY } from './src/utils/storage-adapter.js';
import {
  performStorageBackedCloseSyncUpload,
  withWebDAVSyncLock,
} from './src/services/webdav-sync-shared.js';
import {
  ACTIVE_STREAMS_BY_TAB_KEY,
  hasStoredActiveStreams,
  normalizeActiveStreamsSnapshot,
  pruneStoredActiveStreams
} from './src/utils/active-streams.js';

const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
        if (chrome.storage?.session) {
          await pruneStoredActiveStreams(chrome.storage.session);
        }
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
const uiContexts = new Map();

function normalizeUiContext(context = {}, sender = null) {
  if (!context?.contextId) {
    return null;
  }

  const senderTab = sender?.tab || null;
  const normalizedTabId = Number.isInteger(context.tabId)
    ? context.tabId
    : senderTab?.id ?? null;
  const normalizedWindowId = Number.isInteger(context.windowId)
    ? context.windowId
    : senderTab?.windowId ?? null;

  return {
    contextId: context.contextId,
    uiType: context.uiType || 'unknown',
    tabId: normalizedTabId,
    windowId: normalizedWindowId
  };
}

function upsertUiContext(context, sender = null) {
  const normalizedContext = normalizeUiContext(context, sender);
  if (!normalizedContext) {
    return null;
  }
  uiContexts.set(normalizedContext.contextId, normalizedContext);
  return normalizedContext;
}

function removeUiContext(contextId) {
  if (!contextId) return null;
  const removedContext = uiContexts.get(contextId) || null;
  uiContexts.delete(contextId);
  return removedContext;
}

async function cleanupActiveStreamsByOwnerContextIds(contextIds = []) {
  const ownerIds = new Set(contextIds.filter(Boolean));
  if (ownerIds.size === 0 || !chrome.storage?.session) {
    return false;
  }

  const result = await chrome.storage.session.get(ACTIVE_STREAMS_BY_TAB_KEY);
  const normalizedResult = normalizeActiveStreamsSnapshot(result[ACTIVE_STREAMS_BY_TAB_KEY]);
  const snapshot = normalizedResult.snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    return false;
  }

  const nextSnapshot = {};
  let changed = false;

  for (const [scopeKey, streamRecord] of Object.entries(snapshot)) {
    if (streamRecord?.ownerContextId && ownerIds.has(streamRecord.ownerContextId)) {
      changed = true;
      continue;
    }
    nextSnapshot[scopeKey] = streamRecord;
  }

  if (changed || normalizedResult.changed) {
    await chrome.storage.session.set({
      [ACTIVE_STREAMS_BY_TAB_KEY]: nextSnapshot
    });
  }

  return changed || normalizedResult.changed;
}

async function hasActiveStreamsInSession() {
  if (!chrome.storage?.session) {
    return false;
  }

  return await hasStoredActiveStreams(chrome.storage.session);
}

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

  if (message.type === 'GET_TAB_INFO') {
    (async () => {
      try {
        if (!Number.isInteger(message.tabId)) {
          sendResponse(null);
          return;
        }
        const tab = await chrome.tabs.get(message.tabId);
        sendResponse(tab);
      } catch (e) {
        console.error(`Failed to get tab info for ${message.tabId}:`, e);
        sendResponse(null);
      }
    })();
    return true;
  }

  if (message.type === 'GET_EMBED_CONTEXT') {
    sendResponse({
      tabId: sender.tab?.id ?? null,
      windowId: sender.tab?.windowId ?? null
    });
    return false;
  }

  if (message.type === 'REGISTER_UI_CONTEXT') {
    const context = upsertUiContext(message.context, sender);
    sendResponse({ success: true, context });
    return false;
  }

  if (message.type === 'UPDATE_UI_CONTEXT') {
    const context = upsertUiContext(message.context, sender);
    sendResponse({ success: true, context });
    return false;
  }

  if (message.type === 'UNREGISTER_UI_CONTEXT') {
    (async () => {
      try {
        const removedContext = removeUiContext(message.contextId);
        await cleanupActiveStreamsByOwnerContextIds([
          removedContext?.contextId ?? message.contextId
        ]);
      } catch (error) {
        console.warn('清理 UI context 关联的 stream ownership 失败:', error);
      }
      sendResponse({ success: true });
    })();
    return true;
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

chrome.tabs.onRemoved.addListener((tabId) => {
  const removedContextIds = [];
  for (const [contextId, context] of uiContexts.entries()) {
    if (context.tabId === tabId) {
      uiContexts.delete(contextId);
      removedContextIds.push(contextId);
    }
  }
  cleanupActiveStreamsByOwnerContextIds(removedContextIds).catch((error) => {
    console.warn('标签页关闭后清理 stream ownership 失败:', error);
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  const removedContextIds = [];
  for (const [contextId, context] of uiContexts.entries()) {
    if (context.windowId === windowId) {
      uiContexts.delete(contextId);
      removedContextIds.push(contextId);
    }
  }
  cleanupActiveStreamsByOwnerContextIds(removedContextIds).catch((error) => {
    console.warn('窗口关闭后清理 stream ownership 失败:', error);
  });
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

// 监听标签页激活事件，并只路由到真正关心的 UI
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const sidePanelTargets = Array.from(uiContexts.values()).filter((context) =>
      context.uiType === 'side_panel' && context.windowId === activeInfo.windowId
    );

    await Promise.allSettled(sidePanelTargets.map((context) =>
      chrome.runtime.sendMessage({
        type: 'TAB_CONTEXT_SWITCH',
        targetContextId: context.contextId,
        payload: activeInfo
      })
    ));
  } catch (error) {
    console.error('Error routing tab activation:', error);
  }
});

// ========== WebDAV 關閉同步：Service Worker 自包含上傳 ==========

/**
 * Service Worker 自包含的 WebDAV 上傳同步
 * 從 chrome.storage 讀取所有必要資料，執行上傳，更新狀態
 * 用於頁面關閉時接替 side panel 完成同步
 */
async function performWebDAVSyncUpload() {
    try {
        // 0. 等待短暫時間，讓新打開的面板有機會先進入同步流程
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (await hasActiveStreamsInSession()) {
            console.log('[WebDAV SW] 仍有其他分頁正在生成回覆，延後本次關閉同步');
            return;
        }

        await withWebDAVSyncLock(async () => {
            // 1. 讀取 WebDAV 配置
            const syncStorage = await getSyncStorage();
            const [{ webdav_config: storedConfig }, passwordResult] = await Promise.all([
                syncStorage.get('webdav_config'),
                chrome.storage.local.get('webdav_encryption_password')
            ]);
            if (!storedConfig || !storedConfig.enabled) return;

            let encryptionPassword = '';
            const storedPassword = passwordResult.webdav_encryption_password;
            if (storedPassword) {
                if (isEncryptedPassword(storedPassword)) {
                    try {
                        encryptionPassword = await decryptPasswordFromStorage(storedPassword);
                    } catch (error) {
                        console.error('[WebDAV SW] 解密本地加密密码失败:', error);
                        encryptionPassword = '';
                    }
                } else {
                    encryptionPassword = storedPassword;
                }
            }

            const config = { ...storedConfig, encryptionPassword };
            if (config.encryptApiKeys && !config.encryptionPassword) {
                console.log('[WebDAV SW] 加密已启用但未设置加密密码，跳過同步');
                return;
            }

            const result = await performStorageBackedCloseSyncUpload({
                config,
                localStorageArea: chrome.storage.local,
                syncStorageArea: syncStorage,
                encryptValue: encrypt,
                decryptValue: decrypt,
                tombstoneMaxAgeMs: TOMBSTONE_MAX_AGE_MS
            });
            if (result.skipped) return;

            console.log(
                `[WebDAV SW] 關閉同步完成：已上傳 ${result.uploadedIds.length} 個聊天，已同步 ${result.persistedTombstones.length} 個 tombstone，metadataDirty=${result.localDataDirty}`
            );
        }, {
            logLabel: '[WebDAV SW]',
            onBusy: () => {
                console.log('[WebDAV SW] 其他實例正在同步，略過本次關閉同步');
                return null;
            }
        });
    } catch (e) {
        console.error('[WebDAV SW] 同步上傳失敗:', e);
        throw e;
    }
}
