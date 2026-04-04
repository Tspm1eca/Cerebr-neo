import { storageAdapter, browserAdapter } from '../utils/storage-adapter.js';

const YT_WATCH_RE = /^https?:\/\/(www\.)?youtube\.com\/watch/;
const WEBPAGE_SWITCHES_KEY = 'webpageSwitches';
const WEBPAGE_SWITCHES_BY_SCOPE_KEY = 'webpageSwitchesByScope';
const GLOBAL_WEBPAGE_SWITCH_SCOPE = 'global';

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function getWebpageSwitchScopeState() {
    const viewContext = browserAdapter.getViewContext();
    const scopedTabId = Number.isInteger(viewContext?.tabId) ? viewContext.tabId : null;
    const scopeKey = Number.isInteger(scopedTabId)
        ? String(scopedTabId)
        : GLOBAL_WEBPAGE_SWITCH_SCOPE;

    const result = await storageAdapter.get([WEBPAGE_SWITCHES_BY_SCOPE_KEY, WEBPAGE_SWITCHES_KEY]);
    const scopedSwitchesByScope = isPlainObject(result[WEBPAGE_SWITCHES_BY_SCOPE_KEY])
        ? result[WEBPAGE_SWITCHES_BY_SCOPE_KEY]
        : {};
    const scopedSwitches = isPlainObject(scopedSwitchesByScope[scopeKey])
        ? scopedSwitchesByScope[scopeKey]
        : null;
    const legacySwitches = isPlainObject(result[WEBPAGE_SWITCHES_KEY])
        ? result[WEBPAGE_SWITCHES_KEY]
        : {};

    return {
        scopeKey,
        scopedSwitchesByScope,
        switches: { ...(scopedSwitches ?? legacySwitches) }
    };
}

async function saveWebpageSwitchScopeState(scopeKey, nextSwitches, scopedSwitchesByScope = null) {
    const nextScopes = isPlainObject(scopedSwitchesByScope)
        ? { ...scopedSwitchesByScope }
        : {};
    nextScopes[scopeKey] = nextSwitches;

    await storageAdapter.set({
        [WEBPAGE_SWITCHES_BY_SCOPE_KEY]: nextScopes
    });
}

export async function resetWebpageSwitchesForCurrentContext(currentTabId = null) {
    const { scopeKey, scopedSwitchesByScope } = await getWebpageSwitchScopeState();
    let targetTabId = currentTabId;

    if (!Number.isInteger(targetTabId)) {
        const currentTab = await browserAdapter.getCurrentTab().catch(() => null);
        targetTabId = currentTab?.id ?? null;
    }

    if (!Number.isInteger(targetTabId)) {
        return null;
    }

    const nextSwitches = { [targetTabId]: true };
    await saveWebpageSwitchScopeState(scopeKey, nextSwitches, scopedSwitchesByScope);
    return nextSwitches;
}

// 过滤重复的标签页，只保留每个 URL 最新访问的标签页，但优先保留当前标签页
function getUniqueTabsByUrl(tabs, preferredTabId = null) {
    const chosenTabsByUrl = new Map();

    tabs.forEach((tab) => {
        if (!tab.url) {
            return;
        }

        const existingTab = chosenTabsByUrl.get(tab.url);
        if (!existingTab) {
            chosenTabsByUrl.set(tab.url, tab);
            return;
        }

        const shouldPreferCurrentTab = tab.id === preferredTabId && existingTab.id !== preferredTabId;
        if (shouldPreferCurrentTab) {
            chosenTabsByUrl.set(tab.url, tab);
        }
    });

    return tabs.filter((tab) => chosenTabsByUrl.get(tab.url)?.id === tab.id);
}

async function populateWebpageContentMenu(webpageContentMenu) {
    webpageContentMenu.innerHTML = ''; // 清空现有内容
    let allTabs = await browserAdapter.getAllTabs();
    const currentTab = await browserAdapter.getCurrentTab().catch(() => null);

    // 1. 过滤掉浏览器自身的特殊页面
    allTabs = allTabs.filter(tab => tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:'));

    // 2. 按照 lastAccessed 时间降序排序
    allTabs.sort((a, b) => b.lastAccessed - a.lastAccessed);

    // 2. 过滤掉重复的 URL
    const finalTabs = getUniqueTabsByUrl(allTabs, currentTab?.id ?? null);

    const { switches } = await getWebpageSwitchScopeState();

    for (const tab of finalTabs) {
        if (!tab.title || !tab.url) continue;

        const item = document.createElement('div');
        item.className = 'webpage-menu-item';

        // 添加 Favicon
        if (tab.favIconUrl) {
            const favicon = document.createElement('img');
            favicon.src = tab.favIconUrl;
            favicon.className = 'favicon';
            item.appendChild(favicon);
        }

        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = tab.title;
        title.title = tab.title; // for tooltip on long titles

        const switchId = `webpage-switch-${tab.id}`;
        const switchLabel = document.createElement('label');
        switchLabel.className = 'switch';
        switchLabel.setAttribute('for', switchId);

        // Stop the click event from bubbling up, which would close the main menu.
        switchLabel.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        const switchInput = document.createElement('input');
        switchInput.type = 'checkbox';
        switchInput.id = switchId;

        // 确定开关状态
        const isEnabled = Object.prototype.hasOwnProperty.call(switches, tab.id)
            ? switches[tab.id]
            : (tab.id === currentTab?.id);
        switchInput.checked = isEnabled;

        switchInput.addEventListener('change', async (e) => {
            const isChecked = e.target.checked;
            const {
                scopeKey,
                switches: currentSwitches,
                scopedSwitchesByScope
            } = await getWebpageSwitchScopeState();
            const nextSwitches = { ...currentSwitches, [tab.id]: isChecked };
            await saveWebpageSwitchScopeState(scopeKey, nextSwitches, scopedSwitchesByScope);

            // 如果是开启，且标签页未连接，则刷新它
            if (isChecked) {
                const isConnected = await browserAdapter.isTabConnected(tab.id);
                if (!isConnected) {
                    await browserAdapter.reloadTab(tab.id);
                    console.log(`Webpage-menu: populateWebpageContentMenu Reloaded tab ${tab.id} ${tab.title} (${tab.url}).`);
                    // 可选：刷新后可以给个提示或自动重新打开菜单
                }
            }
        });

        const slider = document.createElement('span');
        slider.className = 'slider';

        switchLabel.appendChild(switchInput);
        switchLabel.appendChild(slider);
        item.appendChild(title);
        item.appendChild(switchLabel);
        webpageContentMenu.appendChild(item);
    }
}

export async function getEnabledTabsContent() {
    const { switches } = await getWebpageSwitchScopeState();
    let allTabs = await browserAdapter.getAllTabs();
    const currentTab = await browserAdapter.getCurrentTab();
    let combinedContent = null;

    // 1. 过滤掉浏览器自身的特殊页面
    allTabs = allTabs.filter(tab => tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:'));

    // 2. 按照 lastAccessed 时间降序排序
    allTabs.sort((a, b) => b.lastAccessed - a.lastAccessed);

    // 2. 过滤掉重复的 URL
    const finalTabs = getUniqueTabsByUrl(allTabs, currentTab?.id ?? null);

    for (const tab of finalTabs) {
        const isEnabled = Object.prototype.hasOwnProperty.call(switches, tab.id)
            ? switches[tab.id]
            : (tab.id === currentTab?.id);
        if (isEnabled) {
            let isConnected = await browserAdapter.isTabConnected(tab.id);

            // 如果未连接，尝试重新加载并再次检查
            if (!isConnected) {
                await browserAdapter.reloadTab(tab.id);
                // 等待一段时间让标签页加载
                await new Promise(resolve => setTimeout(resolve, 1000));
                isConnected = await browserAdapter.isTabConnected(tab.id);
                console.log(`Webpage-menu: getEnabledTabsContent Reloaded tab ${tab.id} ${tab.title} (${tab.url}) isConnected: ${isConnected}.`);
            }

            if (isConnected) {
                try {
                    let pageData = null;
                    console.log(`Webpage-menu: getting content ${tab.id} ${tab.title} (${tab.url}).`);
                    pageData = await browserAdapter.sendMessage({
                        type: 'GET_PAGE_CONTENT_FROM_SIDEBAR',
                        tabId: tab.id,
                        skipWaitContent: true // 明确要求立即提取
                    });

                    // YouTube 当前頁字幕提取失敗：直接中止流程，交由上層顯示錯誤氣泡
                    if (pageData?.error?.code === 'YOUTUBE_TRANSCRIPT_UNAVAILABLE'
                        && tab.id === currentTab?.id
                        && YT_WATCH_RE.test(tab.url || '')) {
                        const err = new Error(pageData.error.message || '无法提取 YouTube 字幕');
                        err.code = 'YOUTUBE_TRANSCRIPT_UNAVAILABLE';
                        throw err;
                    }

                    if (pageData && pageData.content) {
                        if (!combinedContent) {
                            combinedContent = { pages: [] };
                        }
                        combinedContent.pages.push({
                            title: pageData.title,
                            url: tab.url,
                            content: pageData.content,
                            isCurrent: tab.id === currentTab?.id
                        });
                    }
                } catch (e) {
                    if (e?.code === 'YOUTUBE_TRANSCRIPT_UNAVAILABLE') {
                        throw e;
                    }
                    console.warn(`Could not get content from tab ${tab.id} (${tab.url}): ${e}`);
                }
            }
        }
    }
    return combinedContent;
}

export function initWebpageMenu({ webpageQAContainer, webpageContentMenu }) {
    let menuTimeout;

    const showMenu = async () => {
        clearTimeout(menuTimeout);
        // 核心修复：先隐藏，计算完位置再显示，防止闪烁
        webpageContentMenu.style.visibility = 'hidden';
        webpageContentMenu.classList.add('visible');

        await populateWebpageContentMenu(webpageContentMenu);
        const rect = webpageQAContainer.getBoundingClientRect();
        const menuHeight = webpageContentMenu.offsetHeight;
        const windowHeight = window.innerHeight;

        let top = rect.top;
        if (top + menuHeight > windowHeight) {
            top = windowHeight - menuHeight - 150; // 向上调整
        }

        webpageContentMenu.style.top = `${Math.max(8, top)}px`;
        webpageContentMenu.style.left = `${rect.right + 8}px`;

        // 在正确的位置上使其可见
        webpageContentMenu.style.visibility = 'visible';
    };

    const hideMenu = () => {
        menuTimeout = setTimeout(() => {
            webpageContentMenu.classList.remove('visible');
        }, 200); // 200ms 延迟
    };

    webpageQAContainer.addEventListener('mouseenter', showMenu);
    webpageQAContainer.addEventListener('mouseleave', hideMenu);
    webpageContentMenu.addEventListener('mouseenter', () => clearTimeout(menuTimeout));
    webpageContentMenu.addEventListener('mouseleave', hideMenu);

    // 防止點擊菜單背景時關閉菜單
    webpageContentMenu.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    webpageQAContainer.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = webpageContentMenu.classList.toggle('visible');
        if (isVisible) {
            showMenu();
        }
    });
}
