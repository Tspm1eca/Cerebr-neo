/**
 * 初始化深色主题
 * @param {Object} config - 配置对象
 * @param {HTMLElement} config.root - 根元素（通常是document.documentElement）
 */
export function initDarkTheme({ root }) {
    // 设置深色主题类
    root.classList.add('dark-theme');

    // 更新 Mermaid 主题
    if (window.mermaid) {
        window.mermaid.initialize({
            theme: 'dark'
        });

        // 重新渲染所有图表
        if (window.renderMermaidDiagrams) {
            window.renderMermaidDiagrams();
        }
    }
}