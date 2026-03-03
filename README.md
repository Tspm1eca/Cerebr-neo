<p align="center">
<img width="128" height="128" alt="icon_crop_new" src="https://github.com/user-attachments/assets/5e0475c3-3c9c-42f1-a986-6f80e24c5cde" />
</p>

<h1 align="center">Cerebr-neo 網頁AI助手</h1>

## 個人修改
1. 多處UI修改，請自行體驗。
2. **映射表**：將網頁中所有URL以映射表方式發送給LLM，大大降低token的使用量。
3. **網頁引索**：與網頁交互時，可點擊LLM輸出的網頁引索，自動滾動到引索位置。
4. 支持**Tavily**/**Exa**網絡搜索。
5. **無感**、**智能**、**雙向**的同步WebDav（支持加密儲存），真正的**跨平台**、**跨瀏覽器**雙向同步（https://infini-cloud.net 有免費20GB，我的推薦碼：`2GZHC`）。
6. 圖片極致壓縮，以配合WebDav功能。
7. 引入Cloudflare Markdown for Agents做法，把網頁Markdown化。
8. 支持Youtube CC字幕提取。 

### **注意：**
- 如果你是**默認提示詞**使用者，建議在每次更新後使用`還原提示詞`按鈕。因為我會不停改進默認提示詞。

<img width="300" height="900" alt="1" src="https://github.com/user-attachments/assets/681b8c94-c7ae-4d98-92d7-c5ac6119f36e" /> <img width="300" height="900" alt="12" src="https://github.com/user-attachments/assets/f8b77afd-8d71-4d4d-a152-e45d2871d26e" /> <img width="300" height="900" alt="11" src="https://github.com/user-attachments/assets/bc5ab03c-e9b1-49ba-8381-85563b33d497" />
<img width="300" height="900" alt="4" src="https://github.com/user-attachments/assets/03636f83-12d9-4cbf-9734-1645ebf96fe0" /> <img width="300" height="900" alt="5" src="https://github.com/user-attachments/assets/aa7452e8-cb4a-4c5b-b458-db15582d176a" /> <img width="300" height="900" alt="6" src="https://github.com/user-attachments/assets/17212b9a-6693-47e2-a56e-f74e77409e14" />
<img width="300" height="900" alt="2" src="https://github.com/user-attachments/assets/c4b82e86-dc42-4828-9f73-69675e76ac91" /> <img width="300" height="900" alt="3" src="https://github.com/user-attachments/assets/90e81925-6cf5-41ae-a011-b0370fcf14d9" /> <img width="300" height="900" alt="10" src="https://github.com/user-attachments/assets/a485b018-b57a-4781-945c-cff042ce5a4e" />
<img width="300" height="900" alt="7" src="https://github.com/user-attachments/assets/a6df2223-3463-4cab-817b-eea083d27158" /> <img width="300" height="900" alt="8" src="https://github.com/user-attachments/assets/a9f2537d-3d89-43aa-a77d-7c58c482a4cd" /> <img width="300" height="900" alt="9" src="https://github.com/user-attachments/assets/9069fedd-a90b-4ce2-bbc1-442e3a4661c4" />
<img width="910" height="900" alt="14" src="https://github.com/user-attachments/assets/c725a09b-77d2-4cd4-a7b9-b94f8dcddab2" />

## 原版訊息

## ✨ 核心特性

- 🎯 **智能侧边栏** - 通过快捷键(Windows: `Alt+Z` / Mac: `Ctrl+Z`)快速唤出,随时随地与 AI 对话
- 🔄 **多 API 支持** - 支持配置多个 API,灵活切换不同的 AI 助手
- 🔁 **配置同步** - 支持跨浏览器的 API 配置同步，轻松在不同设备间共享设置
- 💻 **多平台支持** - 已上架 Chrome、Firefox 和 Edge 商店，在不同浏览器中提供一致的体验。
- � **全能问答** - 支持网页内容问答、PDF 文档问答、图片问答等多种场景
- 🎨 **优雅渲染** - 完美支持 Markdown 文本渲染、LaTeX 数学公式显示
- ⚡ **实时响应** - 采用流式输出,即时获取 AI 回复
- ⏹️ **灵活控制** - 支持在生成过程中随时停止，发送新消息自动停止当前生成
- 🌓 **主题切换** - 支持浅色/深色主题,呵护您的眼睛
- 🌐 **网页版** - 支持网页版，无需安装，通过任何浏览器访问，支持 vercel、GitHub Pages 和 cloudflare pages 部署

## 🛠️ 技术特性

- 💾 **状态持久化** - 自动保存对话历史、侧边栏状态等
- 🔄 **配置同步** - 支持通过浏览器原生同步API实现跨设备配置共享
- 🔍 **智能提取** - 自动识别并提取网页/PDF 内容
- ⌨️ **快捷操作** - 支持快捷键清空聊天(Windows: `Alt+X` / Mac: `Ctrl+X`)、上下键快速调用历史问题
- 🔒 **安全可靠** - 支持多 API Key 管理,数据本地存储
- 🎭 **兼容性强** - 官方支持 Chrome、Firefox、Edge 等主流浏览器，适配各类网页环境。

## 🎮 使用指南

1. 🔑 **配置 API**
   - 点击设置按钮
   - 填写 API Key、Base URL 和模型名称
   - 支持添加多个 API 配置

2. 💬 **开始对话**
   - 使用快捷键 Windows: `Alt+Z` / Mac: `Ctrl+Z` 唤出侧边栏
   - 输入问题并发送
   - 支持图片上传进行图像问答

3. 📚 **网页/PDF 问答**
   - 开启网页问答开关
   - 自动识别并提取当前页面内容
   - 支持 PDF 文件智能问答

## 🔧 高级功能

- 📋 **右键复制** - 支持右键直接复制消息文本
- 🔄 **历史记录** - 使用上下方向键快速调用历史问题
- ⏹️ **停止生成** - 在生成消息时右键显示停止按钮，可随时中断生成
- 🖼️ **图片预览** - 点击图片可查看大图
- ⚙️ **自定义配置** - 支持自定义快捷键、主题等设置

## 🚀 网页版部署

1. 你可以一键将 Cerebr 的 Web 版本部署到 Vercel：

[![使用 Vercel 部署](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyym68686%2Fcerebr)

2. 你可以部署到 Cloudflare Pages：

2.1 注册好 CF 账号后，申请 Workers API TOKEN。

进入 CF 首页后，右上角选择配置文件 -> 我的个人资料 -> API 令牌 -> 创建令牌 -> 编辑 Cloudflare Workers -> `账户资源`和`区域资源`可以自己选择授予权限 -> 继续以显示摘要 -> 创建令牌 -> 保存令牌（**注意：** 保存好自己的令牌，因为只显示一次）

2.2 回到首页，左侧找到 Workers -> 打开 `Worker 和 Pages` -> 点击`创建` -> `Pages` -> 导入现有 Git 存储库 -> 找到 Fork 的存储库 -> 开始部署

2.3 项目名称写上自己喜欢的名字，在`构建命令`项输入：

`npm install -g wrangler && wrangler pages deploy . --project-name cerebr --branch main`

2.4 下方`环境变量（高级）` -> 添加变量：

`CLOUDFLARE_API_TOKEN`：填上刚申请到的API
`CLOUDFLARE_ACCOUNT_ID`：Cloudflare 控制台首页的 URL 中获取，格式如 https://dash.cloudflare.com/<ACCOUNT_ID>

2.5 保存并部署。

（由于直接构建部署会导致 API 和 accountID 会以明文形式保存，若想更改成密文，可以选择部署完成后点击`继续处理项目` -> 设置 -> 变量和机密 -> 编辑 -> 把`文本`形式更改成`密文` -> 保存）

3. 你也可以部署到 GitHub Pages：

```bash
# Fork 这个仓库
# 然后进入你的仓库的 Settings -> Pages
# 在"构建和部署"部分：
# - 将"Source"选择为"Deploy from a branch"
# - 选择你的分支（main/master）和根目录（/）
# - 点击保存
```

部署将由 GitHub Actions 自动处理。你可以通过 `https://<你的用户名>.github.io/cerebr` 访问你的站点

### Web 版本特点
- 🌐 无需安装，通过任何浏览器访问
- 💻 与 Chrome 扩展版本具有相同的强大功能
- ☁️ 部署自己的实例以获得更好的控制
- 🔒 安全私密的部署方案

## mac 桌面应用

安装 dmg 后，需要执行以下命令：

```bash
sudo xattr -r -d com.apple.quarantine /Applications/Cerebr.app
```

本项目使用 Pake 打包，打包命令如下：

```bash
iconutil -c icns icon.iconset
pake https://xxx/ --name Cerebr --hide-title-bar --icon ./icon.icns
```

https://github.com/tw93/Pake

## 🚀 最新更新

- 🆕 支持图片问答功能
- 🔄 优化网页内容提取算法
- 🐛 修复数学公式渲染问题
- ⚡ 提升整体性能和稳定性

## 📝 开发说明

本项目采用 Chrome Extension Manifest V3 开发,主要技术栈:

- 🎨 原生 JavaScript + CSS
- 📦 Chrome Extension API
- 🔧 PDF.js + KaTeX + Marked.js

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request 来帮助改进项目。在提交之前,请确保:

- 🔍 已经搜索过相关的 Issue
- ✅ 遵循现有的代码风格
- 📝 提供清晰的描述和复现步骤

## 📄 许可证

本项目采用 GPLv3 许可证
