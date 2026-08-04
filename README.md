# WebTranslator 电脑版 v2（前端 + Node.js）

网页/游戏本地化翻译工具，从 Android 版（`com.webt.translator`）完整移植。
v2 全新架构：**现代 Web 前端（HTML/CSS/JS）+ Node.js 后端包装**，界面美观、零闪退。

## 快速开始

> **安装包下载**：GitHub [Releases](https://github.com/Winster308/webtranslator-pc/releases) 页下载 `WebTranslator-Setup-2.0.0.exe`，安装后桌面出现「WebTranslator」图标，双击即用（无需安装 Node.js）。

1. 安装 [Node.js 18+](https://nodejs.org)（自带 `node` 命令即可；**仅源码运行需要**，用安装包则跳过）
2. **双击桌面上的「WebTranslator 电脑版」快捷方式**（或项目目录里的同名快捷方式 / `启动电脑端.vbs`）→ 直接打开 Electron 桌面窗口，**不会弹出任何 CMD 窗口**
3. 左下角「设置」填入 **DeepSeek API Key**（[platform.deepseek.com](https://platform.deepseek.com) 申请）、模型（默认 `deepseek-chat`）、目标语言，保存

> - 应急模式：双击 `浏览器模式.bat` 会用系统浏览器打开（该窗口是服务器控制台，需保持开启，按 Ctrl+C 退出）
> - 程序为单实例：重复双击只会聚焦已有窗口，不会开多个
> - 桌面窗口的页面**直接从本地文件加载**（不走网络），API 走 `127.0.0.1` 本地服务——
>   即使网络/代理/杀软拦截本地连接，界面也秒开不会转圈，只有对应功能会提示错误
> - **自动适配系统代理**：应用启动时读取 Windows 系统代理设置（注册表），GitHub 请求自动走代理
>   （解决"浏览器能打开 GitHub、应用却网络错误"的问题）；本地地址自动绕过代理
> - **本地安全防护**：本地 API 每次启动生成随机访问令牌（页面经 preload / `/api/bootstrap` 获取），
>   其他网页即使探测到本地端口也无法调用或读取数据（无令牌返回 403，且 CORS 只反射可信来源）；
>   `/api/config` 不再向页面返回明文 API Key / GitHub Token（只返回"是否已设置"）
> - 无任何第三方运行时依赖：后端用 Node 内置 `http` + `fetch`，JS 语法校验用内置 `vm` 引擎
>   （ESM 语法自动退回 `node --check`），ZIP 打包为手写实现（deflate 压缩），Electron 二进制已随项目提供。

## 界面（四个功能页 + 日志面板）

| 页面 | 功能 |
|------|------|
| 📄 本地翻译 | 拖拽/选择文件（**支持多文件批量排队**，可中途停止）→ DeepSeek 翻译（HTML/JS/CSS/文本）→ 自动语法校验与修复 → **原文/译文对照查看** → 保存单个或**全部打包 ZIP** |
| 🔍 仓库翻译 | **任意静态网站**（GitHub Pages / github.com / itch.io / GitLab Pages / Gitee Pages / Netlify / Vercel / 自定义域名，自动识别）→ 文件清单（全选 / ✨ AI 智能筛选）→ 多线程批量翻译 → 保存 ZIP / 重试失败文件 / **一键复制失败清单**；JS 在线语法检测 |
| 🐙 GitHub 推送 | **多账号管理**（Token 或 OAuth 设备码登录，可添加/切换/删除多个账号，各自独立）→ 仓库选择/新建 → 推送翻译结果 / 网站文件夹 / 任意文件，可一键开启 GitHub Pages（自动写 .nojekyll） |
| 📂 仓库文件管理（GitHub 页内） | 浏览仓库文件树 → 点击文件在**本地编辑器**查看/修改 → 保存回 GitHub；**新建文件**、**删除文件**、**独立开启 GitHub Pages** |
| 🏠 网站文件夹 | 选择本地网站文件夹 → 自动扫描 JS/HTML 语法错误（坏文件标红 ⚠）→ 浏览器预览 → 推送到 GitHub Pages |

底部：实时运行日志 + 任务进度条（长任务后台执行，界面永不卡死）。

## 主题与个性化

- 顶栏 🌓 按钮一键循环切换 **暗色 / 亮色 / 午夜紫** 三套主题，选择自动保存（重启后保持）
- 设置里可填 **API 地址**：默认 DeepSeek，支持任意 OpenAI 兼容 API（如本地 Ollama、其他中转服务），留空即用默认
- **目标语言可自定义**：下拉常用语言 + 自由输入任意语言（如"乌克兰语"）
- **模型高级参数**：温度（0~2）与最大输出 tokens 可调
- **代理设置**：手动填代理地址（如 `http://127.0.0.1:7890`）优先于系统自动检测，留空自动
- **翻译历史**：🕘 按钮查看最近 50 条翻译记录（本地/仓库、时间、语言、成败统计），自动持久化到本机，重启不丢
- **系统通知**：Electron 模式下翻译完成/失败弹出 Windows 通知
- **失败清单一键复制**：翻译有失败文件时可复制完整清单（路径 + 原因）到剪贴板
- **日志导出**：日志面板 📤 按钮一键下载当前日志为 .txt，便于排查问题

> 通用网站解析会直接访问你粘贴的链接（含内网/本地地址），请只粘贴你信任的网站链接。

## 翻译质量保障（与 Android 版一致的失败修复链）

- 按文件类型生成专属翻译指令，JS 只翻译用户可见文案、标识符零改动
- 翻译后自动校验：括号/引号配对、行数完整性、尾部锚点、标识符一致性、JS 语法（vm 引擎）
- 失败自动修复链：**确定性算法修复**（对照原文补括号/引号/还原标识符）→ **AI 窗口修复**（只修错误行附近 ±40 行）→ **全文件 AI 修复** → 仍失败保留原文
- 失败记忆：历史失败原因自动带入下次翻译提示词（自动截断防止提示词膨胀）
- 每个文件 15 分钟超时保护；GitHub 推送/上传并发执行（6 并发）

## 命令

```bat
启动电脑端.vbs                     :: 无窗口一键启动（桌面窗口）
WebTranslator 电脑版.lnk           :: 桌面/项目目录快捷方式（无窗口）
浏览器模式.bat                     :: 应急：系统浏览器模式（控制台窗口，Ctrl+C 退出）
node main.js            :: 浏览器模式（自动打开浏览器）
node_modules\electron\dist\electron.exe .  :: 强制 Electron 模式
node test\test_translator.js   :: 核心单元测试（语法校验/切块/标识符）
node test\test_e2e.js          :: 端到端测试（API/ZIP/静态资源）
electron test\test_electron.js :: Electron 页面加载验证
```

## 项目结构

```
webtranslator_desktop/
├── main.js                  # 入口：Electron / 浏览器双模式
├── package.json
├── server/
│   ├── index.js             # HTTP 服务器 + API 路由 + job 任务队列
│   ├── translator.js        # 翻译编排（分块/校验/修复链/失败记忆）
│   ├── structural_repairer.js  # 确定性结构修复器
│   ├── translator_helpers.js   # 词法工具（正则/标识符）
│   ├── deepseek.js          # DeepSeek API 客户端（重试/降级）
│   ├── github.js            # GitHub API/OAuth/推送/Pages/itch.io 解析
│   ├── failure_memory.js    # 翻译失败记忆
│   └── zip.js               # 手写 ZIP 打包（store 模式）
├── renderer/
│   ├── index.html           # 现代暗色 UI
│   ├── style.css            # 设计系统
│   └── app.js               # 前端逻辑
└── test/                    # 测试
```

## 配置与数据

- 设置（API Key / 模型 / 语言 / GitHub Token）保存在 `%USERPROFILE%\.webtranslator_pc_config.json`
- 翻译结果、会话状态保存在程序内存中，重启后需重新查询/翻译
- GitHub Token 请妥善保管，勿分享他人

## 常见问题

- **杀毒软件拦截 npm 写入 D 盘**：本项目 `node_modules/` 已预先内置，正常使用**不需要**再运行 npm install
- **想用真实桌面窗口**：确保 `node_modules/electron/dist/electron.exe` 存在（已内置）；杀毒软件可能首次运行 Electron 弹提示，允许即可
- **GitHub 功能需能访问 GitHub 的网络**（部分地区需代理）；DeepSeek API 需官方 key
