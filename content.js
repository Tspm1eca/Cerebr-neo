class CerebrSidebar {
  constructor() {
    this.isVisible = false;
    this.sidebarWidth = 430;
    this.initialized = false;
    this.pageKey = window.location.origin + window.location.pathname;
    this.lastUrl = window.location.href;
    this.sidebar = null;
    this.initializeSidebar();
    this.setupDragAndDrop(); // 添加拖放事件监听器
  }

  async saveState() {
    try {
      const states = await chrome.storage.local.get('sidebarStates') || { sidebarStates: {} };
      if (!states.sidebarStates) {
        states.sidebarStates = {};
      }
      states.sidebarStates[this.pageKey] = {
        width: this.sidebarWidth
      };
      await chrome.storage.local.set(states);
      this.recordWidthHistory();
    } catch (error) {
      console.error('保存侧边栏状态失败:', error);
    }
  }

  async recordWidthHistory() {
    try {
      const data = await chrome.storage.local.get('widthHistory');
      const history = data.widthHistory || [];
      history.push(this.sidebarWidth);
      // 只保留最近 15 筆
      await chrome.storage.local.set({ widthHistory: history.slice(-15) });
    } catch (error) {
      console.error('記錄寬度歷史失敗:', error);
    }
  }

  async getPreferredWidth() {
    try {
      const data = await chrome.storage.local.get('widthHistory');
      const history = data.widthHistory;
      if (!history || history.length < 3) return null;

      // 賦予線性遞增權重（越近期的記錄權重越高）
      const entries = history.map((width, i) => ({
        width,
        weight: i + 1
      }));

      // 按 width 排序，計算加權中位數
      entries.sort((a, b) => a.width - b.width);
      const halfWeight = entries.reduce((sum, e) => sum + e.weight, 0) / 2;

      let cumulative = 0;
      for (const entry of entries) {
        cumulative += entry.weight;
        if (cumulative >= halfWeight) return entry.width;
      }
    } catch (error) {
      console.error('計算偏好寬度失敗:', error);
    }
    return null;
  }

  async loadState() {
    try {
      const states = await chrome.storage.local.get('sidebarStates');
      if (states.sidebarStates && states.sidebarStates[this.pageKey]) {
        const state = states.sidebarStates[this.pageKey];
        // 只恢復寬度，不恢復可見狀態
        if (state.width) {
          this.sidebarWidth = state.width;
        }
      } else {
        // 新頁面：使用歷史偏好寬度作為默認值
        const preferred = await this.getPreferredWidth();
        if (preferred) {
          this.sidebarWidth = preferred;
        }
      }
      this.sidebar.style.setProperty('--sidebar-width', `${this.sidebarWidth}px`);
    } catch (error) {
      console.error('加载侧边栏状态失败:', error);
    }
  }

  async initializeSidebar() {
    try {
      // console.log('开始初始化侧边栏');
      const container = document.createElement('cerebr-root');

      // 防止外部JavaScript访问和修改我们的元素
      Object.defineProperty(container, 'remove', {
        configurable: false,
        writable: false,
        value: () => {
          console.log('阻止移除侧边栏');
          return false;
        }
      });

      // 使用closed模式的shadowRoot以增加隔离性
      const shadow = container.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = `
        :host {
          all: initial;
          contain: style layout size;
        }
        .cerebr-sidebar {
          --sidebar-width: 430px;
          --sidebar-margin: 20px;
          --sidebar-translation: calc(var(--sidebar-width) + var(--sidebar-margin));

          position: fixed;
          top: 20px;
          right: calc(-1 * var(--sidebar-translation));
          width: var(--sidebar-width);
          height: calc(100vh - 40px);
          background: var(--cerebr-bg-color, #ffffff);
          color: var(--cerebr-text-color, #000000);
          box-shadow: none;
          z-index: 2147483647;
          border-radius: 18px;
          margin-right: var(--sidebar-margin);
          overflow: hidden;
          visibility: hidden;
          transform: translate3d(0, 6px, 0);
          pointer-events: none;
          contain: style layout size;
          isolation: isolate;
          opacity: 0;
        }
        .cerebr-sidebar.initialized {
          visibility: visible;
          transition: transform 0.42s cubic-bezier(0.18, 0.95, 0.24, 1), opacity 0.28s ease-out;
          pointer-events: auto;
        }
        @media (prefers-color-scheme: dark) {
          .cerebr-sidebar {
            --cerebr-bg-color: #282c34;
            --cerebr-text-color: #abb2bf;
          }
        }
        .cerebr-sidebar.visible {
          transform: translate3d(calc(-1 * var(--sidebar-translation)), 0, 0);
          opacity: 1;
          box-shadow: none;
        }
        .cerebr-sidebar__content {
          height: 100%;
          overflow: hidden;
          border-radius: 18px;
          contain: style layout size;
        }
        .cerebr-sidebar__iframe {
          width: 100%;
          height: 100%;
          border: none;
          background: var(--cerebr-bg-color, #ffffff);
          contain: strict;
        }
        .cerebr-sidebar__resizer {
            position: absolute;
            left: -5px;
            top: 50%;
            transform: translateY(-50%);
            width: 15px;
            height: 85%;
            cursor: ew-resize;
            z-index: 10;
            background-color: transparent;
            border-radius: 8px;
            transition: background-color 0.2s ease;
        }
        .cerebr-sidebar__resizer:hover {
            background-color: rgba(0, 0, 0, 0.15);
        }
        .cerebr-sidebar__resizer:hover::before {
            background-color: rgba(0, 0, 0, 0.4);
        }
        @media (prefers-color-scheme: dark) {
            .cerebr-sidebar__resizer:hover {
                background-color: rgba(255, 255, 255, 0.15);
            }
            .cerebr-sidebar__resizer::before {
                background-color: rgba(255, 255, 255, 0.2);
            }
            .cerebr-sidebar__resizer:hover::before {
                background-color: rgba(255, 255, 255, 0.4);
            }
        }
      `;

      this.sidebar = document.createElement('div');
      this.sidebar.className = 'cerebr-sidebar';

      // 防止外部JavaScript访问和修改侧边栏
      Object.defineProperty(this.sidebar, 'remove', {
        configurable: false,
        writable: false,
        value: () => {
          console.log('阻止移除侧边栏');
          return false;
        }
      });

      const header = document.createElement('div');
      header.className = 'cerebr-sidebar__header';

      const resizer = document.createElement('div');
      resizer.className = 'cerebr-sidebar__resizer';

      const content = document.createElement('div');
      content.className = 'cerebr-sidebar__content';

      const iframe = document.createElement('iframe');
      iframe.className = 'cerebr-sidebar__iframe';
      iframe.src = chrome.runtime.getURL('index.html');
      iframe.allow = 'clipboard-write';

      content.appendChild(iframe);
      this.sidebar.appendChild(header);
      this.sidebar.appendChild(resizer);
      this.sidebar.appendChild(content);

      shadow.appendChild(style);
      shadow.appendChild(this.sidebar);

      // 先加载状态
      await this.loadState();

      // 添加到文档并保护它
      const root = document.documentElement;
      root.appendChild(container);

      // 使用MutationObserver确保我们的元素不会被移除
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            const removedNodes = Array.from(mutation.removedNodes);
            if (removedNodes.includes(container)) {
              console.log('检测到侧边栏被移除，正在恢复...');
              root.appendChild(container);
            }
          }
        }
      });

      observer.observe(root, {
        childList: true
      });

      // console.log('侧边栏已添加到文档');

      this.setupEventListeners(resizer);

      // 使用 requestAnimationFrame 确保状态已经应用
      requestAnimationFrame(() => {
        this.sidebar.classList.add('initialized');
        this.initialized = true;
        // console.log('侧边栏初始化完成');
      });
    } catch (error) {
      console.error('初始化侧边栏失败:', error);
    }
  }

  setupEventListeners(resizer) {
    let startX, startWidth;
    let isResizing = false;
    const iframe = this.sidebar.querySelector('.cerebr-sidebar__iframe');

    const handleMouseMove = (e) => {
      if (!isResizing) return;
      e.preventDefault(); // 防止意外的文本选择
      const diff = startX - e.clientX;
      const newWidth = Math.max(430, startWidth + diff);
      this.sidebarWidth = Math.min(newWidth, 800);
      requestAnimationFrame(() => {
        this.sidebar.style.setProperty('--sidebar-width', `${this.sidebarWidth}px`);
      });
    };

    const handleMouseUp = () => {
      isResizing = false;
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
      if (iframe) {
        iframe.style.pointerEvents = 'auto';
      }
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      this.sidebar.style.transition = 'transform 0.42s cubic-bezier(0.18, 0.95, 0.24, 1), opacity 0.28s ease-out';
      this.saveState(); // 保存宽度
    };

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizing = true;
      startX = e.clientX;
      startWidth = this.sidebarWidth;
      this.sidebar.style.transition = 'none';
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      if (iframe) {
        iframe.style.pointerEvents = 'none';
      }
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    });
  }

  toggle() {
    if (!this.initialized) return;

    try {
      const wasVisible = this.isVisible;
      this.isVisible = !this.isVisible;

      // 不再保存可見狀態，側邊欄不會自動出現

      if (!wasVisible && this.isVisible) {
        // 顯示側邊欄：使用雙 rAF 延遲添加 visible 類
        // 第一幀讓瀏覽器準備好 iframe 內容的佈局和繪製
        // 第二幀再觸發 CSS 過渡動畫，避免首幀卡頓
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.sidebar.classList.add('visible');
            // 通知iframe並聚焦輸入框
            const iframe = this.sidebar.querySelector('.cerebr-sidebar__iframe');
            if (iframe) {
              iframe.contentWindow.postMessage({ type: 'FOCUS_INPUT' }, '*');
              iframe.contentWindow.postMessage({ type: 'CHECK_CHAT_STATUS' }, '*');
            }
          });
        });
      } else {
        // 隱藏側邊欄：直接移除 visible 類
        this.sidebar.classList.remove('visible');
      }
    } catch (error) {
      console.error('切换侧边栏失败:', error);
    }
  }

  setVisible(visible) {
    if (!this.initialized) return;
    if (this.isVisible === visible) return;
    this.toggle();
  }

  setupDragAndDrop() {
    // console.log('初始化拖放功能');

    // 存储最后一次设置的图片数据
    let lastImageData = null;
    let isDraggingImage = false;

    // 检查是否在侧边栏范围内的函数
    const isInSidebarBounds = (x, y) => {
      if (!this.sidebar) return false;
      const sidebarRect = this.sidebar.getBoundingClientRect();
      return (
        x >= sidebarRect.left &&
        x <= sidebarRect.right &&
        y >= sidebarRect.top &&
        y <= sidebarRect.bottom
      );
    };

    // 检查 dataTransfer 是否包含图片
    const hasImageInDataTransfer = (dataTransfer) => {
      if (!dataTransfer) return false;
      // 检查是否有图片文件
      if (dataTransfer.files && dataTransfer.files.length > 0) {
        for (const file of dataTransfer.files) {
          if (file.type.startsWith('image/')) {
            return true;
          }
        }
      }
      // 检查 types 是否包含图片相关类型
      const types = dataTransfer.types || [];
      return types.includes('Files') ||
             types.includes('text/uri-list') ||
             types.includes('text/html') ||
             types.includes('application/x-cerebr-image');
    };

    // 监听页面上的所有图片
    document.addEventListener('dragstart', (e) => {
      console.log('拖动开始，目标元素:', e.target.tagName);
      const img = e.target;
      if (img.tagName === 'IMG') {
        isDraggingImage = true;
        console.log('检测到图片拖动，图片src:', img.src);

        // 保存图片 URL，用于后续通过 background script 获取
        const pendingImageUrl = img.src;
        const pendingImageName = img.alt || '拖放图片';

        // 通过 background script 获取图片数据（绕过 CORS 限制）
        chrome.runtime.sendMessage({
          action: 'fetchImageAsBase64',
          url: pendingImageUrl
        }).then(response => {
          if (response && response.success && response.data) {
            console.log('通过 background 成功获取图片数据');
            const imageData = {
              type: 'image',
              data: response.data,
              name: pendingImageName
            };
            lastImageData = imageData;
          } else {
            console.error('通过 background 获取图片失败:', response?.error);
            // 回退：尝试使用 Canvas 方法（对于同源图片可能有效）
            tryCanvasFallback(img, pendingImageName);
          }
        }).catch(error => {
          console.error('发送消息到 background 失败:', error);
          // 回退：尝试使用 Canvas 方法
          tryCanvasFallback(img, pendingImageName);
        });

        e.dataTransfer.effectAllowed = 'copy';
      }
    });

    // Canvas 回退方法（仅对同源或已设置 crossorigin 的图片有效）
    function tryCanvasFallback(img, imageName) {
      try {
        console.log('尝试使用 Canvas 方法获取图片数据');
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const base64Data = canvas.toDataURL(img.src.match(/\.png$/i) ? 'image/png' : 'image/jpeg');
        console.log('成功使用 Canvas 获取图片数据');
        const imageData = {
          type: 'image',
          data: base64Data,
          name: imageName
        };
        lastImageData = imageData;
      } catch (canvasError) {
        console.error('Canvas 获取图片数据失败（可能是跨域图片）:', canvasError);
      }
    }

    // 监听 dragenter 事件，检测外部拖入
    document.addEventListener('dragenter', (e) => {
      if (!this.isVisible) return;

      // 检测是否可能是图片拖入（来自外部）
      if (hasImageInDataTransfer(e.dataTransfer)) {
        isDraggingImage = true;
      }
    });

    // 监听 dragover 事件，允许在侧边栏上放置
    document.addEventListener('dragover', (e) => {
      if (!this.isVisible) return;

      // 检测是否可能是图片拖入
      if (hasImageInDataTransfer(e.dataTransfer)) {
        isDraggingImage = true;
      }

      if (!isDraggingImage) return;

      const inSidebar = isInSidebarBounds(e.clientX, e.clientY);
      if (inSidebar) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    // 监听 drop 事件
    document.addEventListener('drop', async (e) => {
      if (!this.isVisible) return;

      const inSidebar = isInSidebarBounds(e.clientX, e.clientY);
      if (!inSidebar) {
        isDraggingImage = false;
        lastImageData = null;
        return;
      }

      e.preventDefault();

      const iframe = this.sidebar?.querySelector('.cerebr-sidebar__iframe');
      if (!iframe) {
        isDraggingImage = false;
        lastImageData = null;
        return;
      }

      // 如果已经有 lastImageData（来自同页面拖动），直接使用
      if (lastImageData) {
        console.log('使用已缓存的图片数据');
        iframe.contentWindow.postMessage({
          type: 'DROP_IMAGE',
          imageData: lastImageData
        }, '*');
        isDraggingImage = false;
        lastImageData = null;
        return;
      }

      // 处理外部拖入的图片
      console.log('处理外部拖入的图片');

      // 尝试从 dataTransfer 获取图片
      const dataTransfer = e.dataTransfer;

      // 辅助函数：发送图片数据到 iframe
      const sendImageToIframe = (imageData, name = '拖放图片') => {
        iframe.contentWindow.postMessage({
          type: 'DROP_IMAGE',
          imageData: {
            type: 'image',
            data: imageData,
            name: name
          }
        }, '*');
        isDraggingImage = false;
      };

      // 辅助函数：从 URL 获取图片并转换为 base64
      const fetchImageFromUrl = async (url) => {
        try {
          const response = await fetch(url);
          const blob = await response.blob();
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch (error) {
          console.error('从 URL 获取图片失败:', error);
          return null;
        }
      };

      // 1. 首先尝试获取文件（支持多张图片）
      if (dataTransfer.files && dataTransfer.files.length > 0) {
        const imageFiles = Array.from(dataTransfer.files).filter(file => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          for (const file of imageFiles) {
            console.log('从文件获取图片:', file.name);
            const reader = new FileReader();
            reader.onload = () => sendImageToIframe(reader.result, file.name || '拖放图片');
            reader.readAsDataURL(file);
          }
          return;
        }
      }

      // 2-4. 统一处理 URL 来源（HTML、URI列表、纯文本）
      const urlSources = [
        {
          type: 'HTML',
          getUrl: () => {
            const html = dataTransfer.getData('text/html');
            const imgMatch = html?.match(/<img[^>]+src=["']([^"']+)["']/i);
            return imgMatch?.[1];
          }
        },
        {
          type: 'URI列表',
          getUrl: () => {
            const uriList = dataTransfer.getData('text/uri-list');
            const urls = uriList?.split('\n').filter(url => url && !url.startsWith('#'));
            return urls?.find(url => url.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?|$)/i));
          }
        },
        {
          type: '纯文本',
          getUrl: () => {
            const plainText = dataTransfer.getData('text/plain');
            return plainText?.match(/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?|$)/i) ? plainText : null;
          }
        }
      ];

      for (const source of urlSources) {
        const url = source.getUrl();
        if (url) {
          console.log(`从${source.type}获取图片 URL:`, url);
          const imageData = await fetchImageFromUrl(url);
          if (imageData) {
            sendImageToIframe(imageData);
            return;
          }
        }
      }

      console.log('无法从 dataTransfer 获取图片数据');
      isDraggingImage = false;
    });

    // 监听拖动结束事件
    document.addEventListener('dragend', (e) => {
      const inSidebar = isInSidebarBounds(e.clientX, e.clientY);
      console.log('拖动结束，是否在侧边栏内:', inSidebar, '坐标:', e.clientX, e.clientY);

      const iframe = this.sidebar?.querySelector('.cerebr-sidebar__iframe');
      if (iframe && inSidebar && lastImageData && this.isVisible) {  // 确保侧边栏可见
        console.log('在侧边栏内放下，发送图片数据到iframe');
        iframe.contentWindow.postMessage({
          type: 'DROP_IMAGE',
          imageData: lastImageData
        }, '*');
      }
      // 重置状态
      lastImageData = null;
      isDraggingImage = false;
    });

    // 监听 dragleave 事件，重置状态
    document.addEventListener('dragleave', (e) => {
      // 只有当离开文档时才重置
      if (e.relatedTarget === null) {
        // 延迟重置，以防是进入 iframe
        setTimeout(() => {
          if (!isInSidebarBounds(e.clientX, e.clientY)) {
            // isDraggingImage = false;
          }
        }, 100);
      }
    });
  }
}

let sidebar;
try {
  sidebar = new CerebrSidebar();
  // console.log('侧边栏实例已创建');
} catch (error) {
  console.error('创建侧边栏实例失败:', error);
}

// 注入 CSS Highlight API 的全局樣式（用於 citation 高亮）
try {
  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = `
    ::highlight(cerebr-citation) {
      background-color: rgba(255, 235, 59, 0.5);
      color: inherit;
    }
  `;
  (document.head || document.documentElement).appendChild(highlightStyle);
} catch (e) {
  // CSS Highlight API 不支持時靜默忽略
}

// 修改消息监听器
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // console.log('content.js 收到消息:', message.type);

    // 处理 PING 消息
    if (message.type === 'PING') {
      sendResponse({
        type: 'PONG',
        timestamp: message.timestamp,
        responseTime: Date.now()
      });
      return true;
    }

    // 处理侧边栏切换命令
    if (message.type === 'TOGGLE_SIDEBAR_onClicked') {
        try {
            if (sidebar) {
                sidebar.toggle();
                sendResponse({ success: true, status: sidebar.isVisible });
            } else {
                console.error('侧边栏实例不存在');
                sendResponse({ success: false, error: 'Sidebar instance not found' });
            }
        } catch (error) {
            console.error('处理切换命令失败:', error);
            sendResponse({ success: false, error: error.message });
        }
        return true;
    }

    if (message.type === 'SET_SIDEBAR_VISIBLE') {
        if (sidebar) {
            sidebar.setVisible(message.visible);
            sendResponse({ success: true, status: sidebar.isVisible });
        }
        return true;
    }

    // 处理获取页面内容请求
    if (message.type === 'GET_PAGE_CONTENT_INTERNAL') {
        // console.log('收到获取页面内容请求');
        isProcessing = true;

        extractPageContent(message.skipWaitContent).then(content => {
            isProcessing = false;
            sendResponse(content);
        }).catch(error => {
            console.error('提取页面内容失败:', error);
            isProcessing = false;
            sendResponse(null);
        });

        return true;
    }

    // 处理 NEW_CHAT 消息
    if (message.type === 'NEW_CHAT') {
        const iframe = sidebar?.sidebar?.querySelector('.cerebr-sidebar__iframe');
        if (iframe) {
            iframe.contentWindow.postMessage({ type: 'NEW_CHAT' }, '*');
        }
        sendResponse({ success: true });
        return true;
    }

    // 处理 SCROLL_TO_TEXT 消息
    if (message.type === 'SCROLL_TO_TEXT') {
        const result = scrollToText(message.text);
        sendResponse({ success: result });
        return true;
    }

    // 处理 SEEK_VIDEO 消息（YouTube 影片跳轉到指定時間）
    if (message.type === 'SEEK_VIDEO') {
        const video = document.querySelector('video');
        if (video) {
            video.currentTime = message.seconds;
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false });
        }
        return true;
    }

    return true;
});

const port = chrome.runtime.connect({ name: 'cerebr-sidebar' });
port.onDisconnect.addListener(() => {
  console.log('与 background 的连接已断开');
});

function sendInitMessage(retryCount = 0) {
  const maxRetries = 10;
  const retryDelay = 1000;

  // console.log(`尝试发送初始化消息，第 ${retryCount + 1} 次尝试`);

  chrome.runtime.sendMessage({
    type: 'CONTENT_LOADED',
    url: window.location.href
  }).then(response => {
    // console.log('Background 响应:', response);
  }).catch(error => {
    console.log('发送消息失败:', error);
    if (retryCount < maxRetries) {
      console.log(`${retryDelay}ms 后重试...`);
      setTimeout(() => sendInitMessage(retryCount + 1), retryDelay);
    } else {
      console.error('达最大重试次数，初始化消息发送失败');
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(sendInitMessage, 500);
  });
} else {
  setTimeout(sendInitMessage, 500);
}

window.addEventListener('error', (event) => {
  if (event.message && event.message.includes('ResizeObserver loop')) {
    // console.debug('忽略 ResizeObserver 警告:', event.message);
    return; // 不记录为错误
  }
  console.error('全局错误:', event.error);
  // 添加更多错误信息记录
  console.error('错误详情:', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    type: event.type,
    timeStamp: event.timeStamp,
    eventPhase: event.eventPhase
  });
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('未处理的 Promise 拒绝:', event.reason);
});


// ==================== YouTube 字幕提取 ====================

function isYouTubeVideoPage() {
  return window.location.hostname.includes('youtube.com')
    && window.location.pathname === '/watch';
}

function getYouTubeVideoInfo() {
  const title = document.querySelector('yt-formatted-string.ytd-watch-metadata')?.textContent?.trim()
    || document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim()
    || document.title || 'YouTube Video';
  const channel = document.querySelector('ytd-channel-name a')?.textContent?.trim()
    || document.querySelector('yt-formatted-string.ytd-channel-name')?.textContent?.trim()
    || '';
  const description = document.querySelector('#attributed-snippet-text')?.textContent?.trim()
    || document.querySelector('ytd-text-inline-expander > .content')?.textContent?.trim()
    || '';
  return { title, channel, description };
}

// --- YouTube API 字幕提取 Helper Functions ---

function formatSubtitleTimestamp(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function extractCaptionTracks(html) {
  const marker = '"captionTracks":';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  const arrayStart = html.indexOf('[', idx);
  if (arrayStart === -1 || arrayStart - idx > marker.length + 5) return null;

  // 用括號匹配提取 JSON 陣列，正確處理字串內的特殊字元
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = arrayStart; i < Math.min(arrayStart + 100000, html.length); i++) {
    const ch = html[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.substring(arrayStart, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

function selectBestCaptionTrack(tracks) {
  if (!tracks?.length) return null;
  // 透過自動字幕 (ASR) 判斷影片原文語言（YouTube 只對原始音訊語言生成 ASR）
  const asrTrack = tracks.find(t => t.kind === 'asr');
  const originalLang = asrTrack?.languageCode;
  // 優先級：原文手動字幕 > 英文手動字幕 > 第一個手動字幕 > 英文自動字幕
  if (originalLang) {
    const originalManual = tracks.find(t => t.languageCode === originalLang && t.kind !== 'asr');
    if (originalManual) return originalManual;
  }
  return tracks.find(t => t.languageCode?.startsWith('en') && t.kind !== 'asr')
    || tracks.find(t => t.kind !== 'asr')
    || tracks.find(t => t.languageCode?.startsWith('en') && t.kind === 'asr')
    || tracks[0];
}

function cleanSubtitleText(raw) {
  if (!raw) return '';
  // 合併換行為空格，壓縮多餘空白
  let text = raw.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  // 解碼殘留的 HTML 實體（YouTube 雙重編碼：&amp;#39; → &#39;）
  if (text.includes('&')) {
    text = new DOMParser().parseFromString(text, 'text/html').documentElement.textContent;
  }
  return text;
}

function parseSubtitleResponse(xmlText) {
  const parser = new DOMParser();
  let doc = parser.parseFromString(xmlText, 'text/xml');
  const hasParseError = !!doc.querySelector('parsererror');

  // 格式 1：<text start="0.5" dur="3.2">內容</text>（srv1 / 預設格式）
  let elements = hasParseError ? [] : [...doc.querySelectorAll('text')];

  // 格式 2：<p t="500" d="3200">內容</p>（srv3 格式，時間為毫秒）
  if (elements.length === 0 && !hasParseError) {
    const pElements = [...doc.querySelectorAll('p[t]')];
    if (pElements.length > 0) {
      let transcript = '';
      for (const el of pElements) {
        const ms = parseInt(el.getAttribute('t') || '0', 10);
        const text = cleanSubtitleText(el.textContent);
        if (text) transcript += `[${formatSubtitleTimestamp(ms / 1000)}] ${text}\n`;
      }
      console.log(`[YT API] Parsed ${pElements.length} segments (srv3 format)`);
      return transcript.trim() || null;
    }
  }

  // Fallback：XML 解析失敗時改用 HTML 解析（更寬容）
  if (elements.length === 0) {
    doc = parser.parseFromString(`<body>${xmlText}</body>`, 'text/html');
    elements = [...doc.querySelectorAll('text')];
  }

  if (elements.length === 0) return null;

  let transcript = '';
  for (const el of elements) {
    const start = parseFloat(el.getAttribute('start') || '0');
    const text = cleanSubtitleText(el.textContent);
    if (text) transcript += `[${formatSubtitleTimestamp(start)}] ${text}\n`;
  }
  console.log(`[YT API] Parsed ${elements.length} segments`);
  return transcript.trim() || null;
}

async function getPoToken() {
  // 第一層：從 Resource Timing API 中查找已有的 timedtext 請求
  let entry = performance
    .getEntriesByType('resource')
    .filter(e => e.name?.includes('/api/timedtext?'))
    .pop();

  if (entry) {
    try {
      const pot = new URL(entry.name).searchParams.get('pot');
      if (pot) { console.log('[YT API] POToken from Resource Timing'); return pot; }
    } catch {}
  }

  // 第二層：模擬點擊字幕按鈕觸發播放器發起 timedtext 請求
  const btn = document.querySelector('button.ytp-subtitles-button.ytp-button');
  if (btn) {
    await new Promise(r => setTimeout(r, 500));
    btn.click();
    await new Promise(r => setTimeout(r, 200));
    btn.click();
    await new Promise(r => setTimeout(r, 800));

    entry = performance
      .getEntriesByType('resource')
      .filter(e => e.name?.includes('/api/timedtext?'))
      .pop();

    if (entry) {
      try {
        const pot = new URL(entry.name).searchParams.get('pot');
        if (pot) { console.log('[YT API] POToken from button click'); return pot; }
      } catch {}
    }
  }

  console.log('[YT API] POToken not available');
  return null;
}

async function extractYouTubeTranscript() {
  try {
    // --- Phase 1：取得頁面 HTML 原始碼 ---
    let pageHtml = document.documentElement.innerHTML;

    if (!pageHtml.includes('/api/timedtext')) {
      // SPA 導航可能不在當前 DOM 中，嘗試 fetch
      console.log('[YT API] timedtext not in DOM, trying fetch...');
      try {
        pageHtml = await (await fetch(location.href, { credentials: 'include' })).text();
      } catch (e) {
        console.log('[YT API] Fetch fallback failed:', e);
        return null;
      }
    }

    if (!pageHtml.includes('/api/timedtext')) {
      console.log('[YT API] No captions found for this video');
      return null;
    }

    // --- Phase 2：提取字幕 URL（支援多語言選擇）---
    let subtitleUrl = null;
    let langInfo = '';

    // 優先從 captionTracks 中選擇最佳語言
    const tracks = extractCaptionTracks(pageHtml);
    if (tracks?.length) {
      const track = selectBestCaptionTrack(tracks);
      if (track?.baseUrl) {
        subtitleUrl = track.baseUrl;
        langInfo = ` [${track.languageCode}${track.kind === 'asr' ? '/auto' : ''}]`;
        console.log(`[YT API] Selected: ${track.languageCode} (${track.kind || 'manual'}), ${tracks.length} tracks available`);
      }
    }

    // Fallback：直接從 HTML 中提取第一個 timedtext URL
    if (!subtitleUrl) {
      const start = pageHtml.indexOf('https://www.youtube.com/api/timedtext');
      if (start !== -1) {
        let raw = pageHtml.substring(start);
        raw = raw.substring(0, raw.indexOf('"'));
        subtitleUrl = raw.replaceAll('\\u0026', '&');
        console.log('[YT API] Using first timedtext URL from HTML');
      }
    }

    if (!subtitleUrl) {
      console.log('[YT API] Could not extract subtitle URL');
      return null;
    }

    // --- Phase 3：取得字幕資料（POToken + 無 Token 雙策略）---
    let subtitleData = null;

    // 策略 A：帶 POToken 請求
    const potoken = await getPoToken();
    if (potoken) {
      try {
        const resp = await fetch(`${subtitleUrl}&pot=${potoken}&c=WEB`);
        if (resp.ok) {
          const data = await resp.text();
          if (data.includes('<')) subtitleData = data;
        }
      } catch (e) {
        console.log('[YT API] Fetch with POToken failed:', e);
      }
    }

    // 策略 B：不帶 POToken 請求（部分影片/地區不需要）
    if (!subtitleData) {
      console.log('[YT API] Trying without POToken...');
      try {
        const resp = await fetch(`${subtitleUrl}&c=WEB`);
        if (resp.ok) {
          const data = await resp.text();
          if (data.includes('<')) subtitleData = data;
        }
      } catch (e) {
        console.log('[YT API] Fetch without POToken also failed:', e);
      }
    }

    if (!subtitleData) {
      console.log('[YT API] All fetch strategies failed');
      return null;
    }

    // --- Phase 4：解析字幕 XML ---
    const transcript = parseSubtitleResponse(subtitleData);
    if (transcript) {
      console.log(`[YT API] Success${langInfo}, length: ${transcript.length}`);
    }
    return transcript;

  } catch (e) {
    console.log('[YT API] Unexpected error:', e);
    return null;
  }
}

// 修改 extractPageContent 函数
async function extractPageContent(skipWaitContent = false) {
  // console.log('extractPageContent 开始提取页面内容');

  // 检查是否是PDF或者iframe中的PDF
  let pdfUrl = null;
  if (document.contentType === 'application/pdf' ||
      (window.location.href.includes('.pdf') ||
       document.querySelector('iframe[src*="pdf.js"]') ||
       document.querySelector('iframe[src*=".pdf"]'))) {
    // console.log('检测到PDF文件，尝试提取PDF内容');
    pdfUrl = window.location.href;

    // 如果是iframe中的PDF，尝试提取实际的PDF URL
    const pdfIframe = document.querySelector('iframe[src*="pdf.js"]') || document.querySelector('iframe[src*=".pdf"]');
    if (pdfIframe) {
      const iframeSrc = pdfIframe.src;
      // 尝试从iframe src中提取实际的PDF URL
      const urlMatch = iframeSrc.match(/[?&]file=([^&]+)/);
      if (urlMatch) {
        pdfUrl = decodeURIComponent(urlMatch[1]);
        console.log('从iframe中提取到PDF URL:', pdfUrl);
      }
    }

  }

  // 等待内容加载和网络请求完成 - 如果 skipWaitContent 为 true，则跳过等待
  // 当 skipWaitContent 为 true 时，表示是按需提取
  if (skipWaitContent) {
    // console.log('按需提取内容 (skipWaitContent=true)');
    // 如果是 PDF
    if (pdfUrl) {
      // console.log('按需提取 PDF 内容');
      const pdfText = await extractTextFromPDF(pdfUrl);
      if (pdfText) {
        return {
          title: document.title,
          url: window.location.href,
          content: pdfText
        };
      }
      return null;
    }
    // === YouTube 字幕提取 ===
    if (isYouTubeVideoPage()) {
      const transcript = await extractYouTubeTranscript();
      const { title, channel, description } = getYouTubeVideoInfo();

      if (transcript) {
        let content = `# ${title}\n`;
        if (channel) content += `Channel: ${channel}\n`;
        content += `URL: ${window.location.href}\n\n`;
        if (description) content += `## Description\n${description}\n\n`;
        content += `## Transcript\n${transcript}`;

        console.log('YouTube 字幕提取完成，內容長度:', content.length);
        return { title, url: window.location.href, content };
      }
      // 在 YouTube watch 頁面強制依賴字幕：提取失敗時直接返回錯誤，不回退到一般頁面提取
      const errorMessage = '无法提取 YouTube 字幕，找不到CC字幕。';
      console.warn('YouTube 字幕不可用，终止后续流程');
      return {
        title,
        url: window.location.href,
        error: {
          code: 'YOUTUBE_TRANSCRIPT_UNAVAILABLE',
          message: errorMessage
        }
      };
    }
    // === 內容提取流程 ===
    let mainContent = '';
    const turndown = getTurndownService();

    // 提取同源 iframe 內容（套用完整清理 + Turndown）
    const iframes = document.querySelectorAll('iframe');
    let frameContent = '';
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument || iframe.contentWindow) {
          const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
          const iframeClone = iframeDocument.body.cloneNode(true);
          SELECTORS_TO_REMOVE.forEach(selector => {
            iframeClone.querySelectorAll(selector).forEach(el => el.remove());
          });
          iframeClone.querySelectorAll('header').forEach(header => {
            if (!header.querySelector('h1')) header.remove();
          });
          if (turndown) {
            frameContent += turndown.turndown(iframeClone.innerHTML);
          } else {
            frameContent += iframeClone.innerText;
          }
        }
      } catch (e) {
        // 跨域 iframe 無法存取
      }
    }

    // 標記在原始 DOM 中不可見的容器（display:none 等），克隆後從副本移除
    // offsetParent === null 且尺寸為零 → 元素或其祖先為 display:none
    // position:fixed/sticky 的可見元素 offsetParent 也為 null，但尺寸不為零，不會被誤判
    // display:contents 的元素自身不產生盒模型（尺寸為零），但子元素正常可見，須排除
    const CEREBR_HIDDEN = 'data-cerebr-hidden';
    const hiddenEls = [];
    for (const el of document.body.querySelectorAll('div, section, article, aside, form, fieldset, details, dialog, main, [role]')) {
      if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0
          && getComputedStyle(el).display !== 'contents') {
        el.setAttribute(CEREBR_HIDDEN, '');
        hiddenEls.push(el);
      }
    }

    const tempContainer = document.body.cloneNode(true);

    // 清理原始 DOM 上的標記
    for (const el of hiddenEls) el.removeAttribute(CEREBR_HIDDEN);

    // 從克隆移除不可見的容器
    tempContainer.querySelectorAll(`[${CEREBR_HIDDEN}]`).forEach(el => el.remove());

    const originalFormElements = document.body.querySelectorAll('textarea, input');
    const clonedFormElements = tempContainer.querySelectorAll('textarea, input');
    originalFormElements.forEach((el, index) => {
      if (clonedFormElements[index] && el.value) {
        clonedFormElements[index].textContent = el.value;
      }
    });

    SELECTORS_TO_REMOVE.forEach(selector => {
      tempContainer.querySelectorAll(selector).forEach(element => element.remove());
    });

    // 有條件地移除 <header>：保留包含 <h1> 的文章標題 header，只移除導覽用 header
    tempContainer.querySelectorAll('header').forEach(header => {
      if (!header.querySelector('h1')) {
        header.remove();
      }
    });

    // 移除 aria-hidden 元素中殘留的媒體時間戳（如 "1:54"、"12:03:45"）
    tempContainer.querySelectorAll('[aria-hidden="true"]').forEach(el => {
      const text = el.textContent.trim();
      if (text.length < 10 && /^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) {
        el.remove();
      }
    });

    // 將相對 URL 解析為絕對 URL，並移除 title 屬性（tooltip 提示文字對內容提取無價值）
    const baseUrl = document.baseURI;
    tempContainer.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (href && !href.startsWith('http') && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('javascript:')) {
        try {
          a.setAttribute('href', new URL(href, baseUrl).href);
        } catch (e) {}
      }
      a.removeAttribute('title');
    });

    // 處理卡片式連結：當 <a> 同時包含標題（h1-h6）與其他區塊內容時，
    // 僅保留標題作為連結文字，將描述段落移到連結外，丟棄元資料（時間、標籤等）
    tempContainer.querySelectorAll('a[href]').forEach(a => {
      const headings = a.querySelectorAll('h1, h2, h3, h4, h5, h6');
      if (headings.length === 0) return;

      // 收集所有標題文字（按 DOM 順序）
      const headingTexts = [];
      headings.forEach(h => {
        const text = h.textContent.trim();
        if (text) headingTexts.push(text);
      });
      if (headingTexts.length === 0) return;

      // 收集有意義的描述文字（<p> 或不含區塊子元素的葉級 <div>）
      // 用長度門檻過濾 CTA 按鈕（"See more"）、時間戳、標籤等短文字
      const descriptions = [];
      const descTexts = new Set();
      function collectDesc(el) {
        if (/^H[1-6]$/.test(el.tagName)) return;
        const hasBlock = el.querySelector('h1, h2, h3, h4, h5, h6, p, div, section, article');
        if (el.tagName === 'P' || (el.tagName === 'DIV' && !hasBlock)) {
          const text = el.textContent.trim();
          if (text.length > 40 && !descTexts.has(text)) {
            descTexts.add(text);
            descriptions.push(text);
          }
          return;
        }
        for (const child of el.children) {
          collectDesc(child);
        }
      }
      for (const child of a.children) {
        collectDesc(child);
      }

      // 重寫連結內容：合併所有標題文字（丟棄元資料 span、時間戳、標籤等）
      a.textContent = headingTexts.join(' - ');

      // 將描述段落作為獨立 <p> 插入到連結之後
      let insertAfter = a;
      for (const desc of descriptions) {
        const p = document.createElement('p');
        p.textContent = desc;
        if (insertAfter.parentNode) {
          insertAfter.parentNode.insertBefore(p, insertAfter.nextSibling);
          insertAfter = p;
        }
      }
    });

    if (turndown) {
      mainContent = turndown.turndown(tempContainer.innerHTML);
    } else {
      // Fallback：Turndown 不可用時，使用原始邏輯
      tempContainer.querySelectorAll('a').forEach(a => {
        const text = a.innerText.trim();
        const href = a.href;
        if (text && href && href.startsWith('http')) {
          a.replaceWith(' ' + text + ' (' + href + ') ');
        }
      });
      mainContent = tempContainer.innerText;
    }

    // 附加 iframe 內容（去重：逐段檢查是否已存在於主內容中）
    if (frameContent) {
      const paragraphs = frameContent.split(/\n{2,}/);
      const newParagraphs = paragraphs.filter(p => {
        const trimmed = p.trim();
        if (trimmed.length < 20) return false; // 過短的段落直接丟棄
        // 取段落前 80 字作為指紋，檢查主內容是否已包含
        const fingerprint = trimmed.substring(0, 80);
        return !mainContent.includes(fingerprint);
      });
      if (newParagraphs.length > 0) {
        mainContent += '\n\n---\n\n' + newParagraphs.join('\n\n');
      }
    }

    // 清理多餘空白（保留 Markdown 結構）
    mainContent = mainContent
      // GFM 表格插件會把表格單元格中的換行轉成字面 <br>，在此還原為真正的換行
      .replace(/(?:\s*<br\s*\/?>\s*)+/gi, '\n')
      .replace(/\[([^\]]*\n[^\]]*)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_, inner, url) => {
        // 修復多行連結：將包含換行的連結文字壓縮為單行
        // 文字為空時（如圖片連結被清除後）整個連結移除
        const cleaned = inner.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
        return cleaned ? '[' + cleaned + '](' + url + ')' : '';
      })
      .replace(/\[(?:[\s\u200B\u200C\u200D\u2060\uFEFF]|<br\s*\/?>)*\]\([^()]*(?:\([^()]*\)[^()]*)*\)/gi, '')  // 移除無意義超連結（空白、零寬度字元、<br> 等）；URL 部分支援一層括號（如 Wikipedia 的 (cropped).jpg）
      .replace(/^[ \t\u200B\u200C\u200D\u2060\uFEFF]+$/gm, '')  // 清除僅含不可見字元的假空行
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\]\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\[/g, match => match.replace(/\)\s*\[/, ')\n['))  // 相鄰 Markdown 連結各自換行
      .replace(/[ \t]+$/gm, '')
      .trim();

    // 逐行去重：移除重複出現的內容行（桌面版/手機版雙重渲染等）
    const seenLines = new Set();
    mainContent = mainContent.split('\n').filter(line => {
      const trimmed = line.trim();
      if (trimmed.length < 50) return true; // 短行保留（空行、標題標記等）
      if (seenLines.has(trimmed)) return false;
      seenLines.add(trimmed);
      return true;
    }).join('\n')
      .replace(/\n{3,}/g, '\n\n'); // 去重後可能產生連續空行，再清理一次

    if (mainContent.length < 40) {
      console.log('提取的内容太少，返回 null');
      return null;
    }

    const gptTokenCount = await estimateGPTTokens(mainContent);
    console.log('页面内容提取完成，内容长度:', mainContent.length, 'GPT tokens:', gptTokenCount);

    return {
      title: document.title,
      url: window.location.href,
      content: mainContent
    };
  }

  // 当 skipWaitContent 为 false (默认)，表示是自动调用。
  // 在这种模式下，我们不进行任何耗时操作，特别是对于PDF。
  // console.log('自动调用 extractPageContent，不执行提取 (skipWaitContent=false)');
  return null;
}

// PDF.js 库的路径
const PDFJS_PATH = chrome.runtime.getURL('lib/pdf.js');
const PDFJS_WORKER_PATH = chrome.runtime.getURL('lib/pdf.worker.js');

// 设置 PDF.js worker 路径
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;

// === 內容清理用選擇器 ===
const SELECTORS_TO_REMOVE = [
    'script', 'style', 'nav', 'footer',
    'iframe', 'noscript', 'img', 'svg', 'video', 'audio', 'canvas',
    'template',
    '[role="complementary"]', '[role="navigation"]', '[role="contentinfo"]',
    '[role="search"]', '[role="alert"]', '[role="dialog"]', '[role="tooltip"]',
    // 隱藏元素與懸浮提示（tooltip / popover），這些不屬於頁面主內容
    '[hidden]', '[popover]', '[data-tippy-root]',
    // 對話框、彈出層、覆蓋層、摺疊區塊等用戶不可見的互動 UI
    'dialog', '[aria-modal="true"]',
    'details:not([open])',
    '.dropdown-menu', '.dropdown-content',
    'select',
    '.sidebar', '.nav', '.footer', '.header',
    '.comments', '#comments', '.comment-list',
    '.related-posts', '.related-articles', '.recommended',
    '.share', '.social-share', '.sharing',
    '.breadcrumb', '.breadcrumbs',
    '.cookie-banner', '.cookie-consent',
    '.newsletter', '.subscribe',
    '.ad', '.ads', '.advertisement',
    '.pagination',
    // 影音播放器容器（移除整個播放器 UI，而非僅 <video>/<audio> 標籤）
    '.video-js', '.plyr', '.jwplayer', '.html5-video-player',
    '.mejs-container', '[data-testid="videoPlayer"]',
    '[data-component="bloomberg-audio-bar"]',
    '[class*="audio-bar"]', '[class*="audioBar"]',
    '.audio-controls', '.audio-subscribe',
    '[class*="audio-control"]', '[class*="AudioControl"]',
    // 影音播放器覆蓋層 UI（播放按鈕、時長標籤等）
    '[data-component*="play-icon"]',
    '[class*="video-duration"]', '[class*="VideoDuration"]',
    '[data-testid="videoDuration"]',
    '[data-testid*="overlay" i]', '[class*="InitialOverlay"]',
    // 連結內的時間戳（如 "9 months ago"），避免污染連結文字
    'a time',
    // 螢幕閱讀器專用文字（與可見文字重複，常含「play video」等媒體描述）
    '.visually-hidden', '.sr-only', '.screen-reader-text',
    '[class*="VisuallyHidden"]', '[class*="ScreenReader"]',
    // 瀏覽器擴充套件注入的 UI
    '[class*="immersive-translate"]', '[id*="immersive-translate"]',
    '[class*="darkreader"]',
];

// === Turndown 初始化 ===
let _turndownService = null;

function getTurndownService() {
  if (_turndownService) return _turndownService;

  if (typeof TurndownService === 'undefined') {
    console.warn('TurndownService 未載入，將使用 fallback 提取方式');
    return null;
  }

  _turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });

  // 啟用 GFM 插件（表格、刪除線、任務列表）
  if (typeof turndownPluginGfm !== 'undefined') {
    _turndownService.use(turndownPluginGfm.gfm);
  }

  // 處理含有區塊級內容（如列表）的表格：
  // GFM 表格語法不支援巢狀列表，Turndown 會直接輸出原始 HTML。
  // 此規則攔截這類表格，提取內部 th/caption 作為粗體標題，其餘內容遞迴轉換。
  _turndownService.addRule('blockTable', {
    filter: function (node) {
      return node.nodeName === 'TABLE' &&
        node.querySelector('ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6');
    },
    replacement: function (_content, node) {
      var parts = [];
      // 提取表頭文字（th 或 caption）作為粗體標題
      var headers = node.querySelectorAll('th, caption');
      headers.forEach(function (h) {
        var text = h.textContent.trim();
        if (text) parts.push('**' + text + '**');
      });
      // 提取 td 內容，讓 Turndown 遞迴處理（列表、連結等會正常轉換）
      var cells = node.querySelectorAll('td');
      cells.forEach(function (td) {
        var cellMd = _turndownService.turndown(td.innerHTML);
        if (cellMd.trim()) parts.push(cellMd.trim());
      });
      return '\n\n' + parts.join('\n\n') + '\n\n';
    }
  });

  // 安全網：這些 HTML 標籤類型永遠不該產生文字輸出，
  // 即使 DOM 清理階段有漏網（擴充套件注入、Shadow DOM 等），Turndown 也會忽略
  _turndownService.remove(['script', 'style', 'template', 'link', 'meta', 'object', 'embed']);

  return _turndownService;
}

async function extractTextFromPDF(url) {
  try {
    // 使用已存在的 sidebar 实例
    if (!sidebar || !sidebar.sidebar) {
      console.error('侧边栏实例不存在');
      return null;
    }

    // 获取iframe
    const iframe = sidebar.sidebar.querySelector('.cerebr-sidebar__iframe');
    if (!iframe) {
      console.error('找不到iframe元素');
      return null;
    }

    // 发送更新placeholder消息
    const sendPlaceholderUpdate = (message, timeout = 0) => {
      // console.log('发送placeholder更新:', message);
      iframe.contentWindow.postMessage({
        type: 'UPDATE_PLACEHOLDER',
        placeholder: message,
        timeout: timeout
      }, '*');
    };

    sendPlaceholderUpdate('正在下载PDF文件...');

    console.log('开始下载PDF:', url);
    // 首先获取PDF文件的初始信息
    const initResponse = await chrome.runtime.sendMessage({
      action: 'downloadPDF',
      url: url
    });

    if (!initResponse.success) {
      console.error('PDF初始化失败，响应:', initResponse);
      sendPlaceholderUpdate('PDF下载失败', 2000);
      throw new Error('PDF初始化失败');
    }

    const { totalChunks, totalSize } = initResponse;
    // console.log(`PDF文件大小: ${totalSize} bytes, 总块数: ${totalChunks}`);

    // 分块接收数据
    const chunks = new Array(totalChunks);
    for (let i = 0; i < totalChunks; i++) {
      sendPlaceholderUpdate(`正在下载PDF文件 (${Math.round((i + 1) / totalChunks * 100)}%)...`);

      const chunkResponse = await chrome.runtime.sendMessage({
        action: 'getPDFChunk',
        url: url,
        chunkIndex: i
      });

      if (!chunkResponse.success) {
        sendPlaceholderUpdate('PDF下载失败', 2000);
        throw new Error(`获取PDF块 ${i} 失败`);
      }

      chunks[i] = new Uint8Array(chunkResponse.data);
    }

    // 合并所有块
    const completeData = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      completeData.set(chunk, offset);
      offset += chunk.length;
    }

    sendPlaceholderUpdate('正在解析PDF文件...');

    // console.log('开始解析PDF文件');
    const loadingTask = pdfjsLib.getDocument({data: completeData});
    const pdf = await loadingTask.promise;
    // console.log('PDF加载成功，总页数:', pdf.numPages);

    let fullText = '';
    // 遍历所有页面
    for (let i = 1; i <= pdf.numPages; i++) {
      sendPlaceholderUpdate(`正在提取文本 (${i}/${pdf.numPages})...`);
      // console.log(`开始处理第 ${i}/${pdf.numPages} 页`);
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      // console.log(`第 ${i} 页提取的文本长度:`, pageText.length);
      fullText += pageText + '\n';
    }

    // 计算GPT分词数量
    const gptTokenCount = await estimateGPTTokens(fullText);
    console.log('PDF文本提取完成，总文本长度:', fullText.length, '预计GPT tokens:', gptTokenCount);
    sendPlaceholderUpdate(`PDF处理完成 (约 ${gptTokenCount} tokens)`, 2000);
    return fullText;
  } catch (error) {
    console.error('PDF处理过程中出错:', error);
    console.error('错误堆栈:', error.stack);
    if (sidebar && sidebar.sidebar) {
      const iframe = sidebar.sidebar.querySelector('.cerebr-sidebar__iframe');
      if (iframe) {
        iframe.contentWindow.postMessage({
          type: 'UPDATE_PLACEHOLDER',
          placeholder: 'PDF处理失败',
          timeout: 2000
        }, '*');
      }
    }
    return null;
  }
}


// 清除之前的高亮（用於 CSS Highlight API）
let currentHighlightTimeout = null;

/**
 * 使用 CSS Highlight API 高亮指定的 Range（精確高亮文字而非整個元素）
 * 如果瀏覽器不支持，則回退到修改背景色的方式
 * @param {Range} range - 要高亮的文字範圍
 */
function highlightRange(range) {
    // 清除之前的高亮
    if (currentHighlightTimeout) {
        clearTimeout(currentHighlightTimeout);
        currentHighlightTimeout = null;
    }

    // 優先使用 CSS Custom Highlight API（Chrome 105+）
    if (typeof CSS !== 'undefined' && CSS.highlights) {
        try {
            const highlight = new Highlight(range);
            CSS.highlights.set('cerebr-citation', highlight);
            currentHighlightTimeout = setTimeout(() => {
                CSS.highlights.delete('cerebr-citation');
                currentHighlightTimeout = null;
            }, 2000);
            return;
        } catch (e) {
            console.warn('CSS Highlight API 失敗，回退到背景色方式:', e);
        }
    }

    // 回退方案：修改父元素背景色
    const element = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;

    if (element) {
        const originalTransition = element.style.transition;
        const originalBg = element.style.backgroundColor;

        element.style.transition = 'background-color 0.5s ease';
        element.style.backgroundColor = 'rgba(255, 235, 59, 0.5)';

        currentHighlightTimeout = setTimeout(() => {
            element.style.backgroundColor = originalBg;
            setTimeout(() => {
                element.style.transition = originalTransition;
            }, 500);
            currentHighlightTimeout = null;
        }, 2000);
    }
}

/**
 * 使用 TreeWalker 在 DOM 中查找文本並返回對應的 Range
 * 作為 window.find() 的備用方案
 * @param {string} text - 要查找的文本
 * @returns {Range|null} 找到的文字範圍，未找到返回 null
 */
function findTextWithTreeWalker(text) {
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node) => {
                // 跳過不可見元素中的文本
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                const style = window.getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden') {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    const lowerText = text.toLowerCase();

    // 第一遍：嘗試在單個文本節點中查找
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const index = node.textContent.toLowerCase().indexOf(lowerText);
        if (index !== -1) {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + text.length);
            return range;
        }
    }

    // 第二遍：嘗試跨節點查找（處理文本被分割到多個節點的情況）
    walker.currentNode = document.body;
    const textNodes = [];
    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }

    // 構建連續文本並記錄每個字符對應的節點和偏移
    let concatenated = '';
    const charMap = []; // { node, offset }

    for (const node of textNodes) {
        for (let i = 0; i < node.textContent.length; i++) {
            charMap.push({ node, offset: i });
            concatenated += node.textContent[i];
        }
    }

    const searchIndex = concatenated.toLowerCase().indexOf(lowerText);
    if (searchIndex !== -1) {
        const startInfo = charMap[searchIndex];
        const endInfo = charMap[searchIndex + text.length - 1];
        if (startInfo && endInfo) {
            const range = document.createRange();
            range.setStart(startInfo.node, startInfo.offset);
            range.setEnd(endInfo.node, endInfo.offset + 1);
            return range;
        }
    }

    return null;
}

/**
 * 滾動到指定文本並高亮顯示
 * 優先使用 window.find()，失敗時回退到 TreeWalker
 * @param {string} text - 要查找並滾動到的文本
 * @returns {boolean} 是否成功找到並滾動到文本
 */
function scrollToText(text) {
    if (!text) return false;

    try {
        // 記錄當前滾動位置
        const currentScrollX = window.scrollX;
        const currentScrollY = window.scrollY;

        // 先移除當前選區，以免影響搜索起始位置
        window.getSelection().removeAllRanges();

        // 嘗試使用 window.find（wrapAround=true 確保全文檔搜索）
        const found = window.find(text, false, false, true, false, true, false);

        if (found) {
            // 立即恢復原來的滾動位置，抵消 window.find 可能造成的瞬間跳轉
            window.scrollTo(currentScrollX, currentScrollY);

            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                const element = range.startContainer.nodeType === Node.ELEMENT_NODE
                    ? range.startContainer
                    : range.startContainer.parentElement;

                if (element) {
                    // 使用 requestAnimationFrame 確保在恢復滾動位置後執行平滑滾動
                    requestAnimationFrame(() => {
                        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    });

                    // 使用精確的高亮方式
                    highlightRange(range);
                    return true;
                }
            }
        }

        // 備用方案：使用 TreeWalker 遍歷 DOM 查找文本
        console.log('window.find 未找到文本，嘗試 TreeWalker 備用方案:', text);
        const fallbackRange = findTextWithTreeWalker(text);

        if (fallbackRange) {
            const element = fallbackRange.startContainer.nodeType === Node.ELEMENT_NODE
                ? fallbackRange.startContainer
                : fallbackRange.startContainer.parentElement;

            if (element) {
                requestAnimationFrame(() => {
                    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });

                // 設置選區以便用戶看到找到的文本
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(fallbackRange);

                // 使用精確的高亮方式
                highlightRange(fallbackRange);
                return true;
            }
        }

        console.log('未找到文本:', text);
    } catch (e) {
        console.error('滾動到文本失敗:', e);
    }
    return false;
}

// 添加GPT分词估算函数
async function estimateGPTTokens(text) {
  try {
    // 简单估算：平均每4个字符约为1个token
    // 这是一个粗略估计，实际token数可能会有所不同
    const estimatedTokens = Math.ceil(text.length / 4.25625);
    return estimatedTokens;
  } catch (error) {
    console.error('计算GPT tokens时出错:', error);
    return 0;
  }
}

