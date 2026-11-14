<div align="center">
  <img src="dist/assets/omniget.png" width="84" alt="OmniGet application icon">
  <h1>OmniGet Web</h1>
  <p><strong>链接在网页整理，下载由浏览器或本机完成。</strong></p>
  <p>A lightweight download workbench for your browser and desktop.</p>
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
  <p><a href="https://omniget.tarokiki.chatgpt.site">在线体验</a> · <a href="#快速开始">快速开始</a> · <a href="#系统架构">系统架构</a> · <a href="https://github.com/OpenSelena/omniget/releases/latest">桌面端下载</a></p>
</div>

![OmniGet Web visual overview](docs/images/hero.svg)

## 一个轻量入口，两条下载路径

OmniGet Web 是 [OmniGet](https://github.com/OpenSelena/omniget) 的独立 Sites 网页适配。无需构建工具：打开网页，整理链接，将文件直链交给浏览器，或将支持的媒体任务交给本机 OmniGet。

> **它不是云端下载服务器，也不是完整版桌面应用。** 平台解析、下载位置、清晰度、格式与登录状态由本机桌面端决定。课程、Telegram、转码、转写和阅读等功能仍在桌面端使用。

| 能力 | 你能做什么 | 实际边界 |
| --- | --- | --- |
| 链接工作台 | 单条、批量粘贴，UTF-8 TXT 导入，识别平台、去重和状态筛选 | 队列最多 50 项；TXT 上限 128 KiB |
| 文件直链 | 保存 HTTP(S) 文件，查看读取进度，取消读取 | 源站需允许跨域；普通缓冲保存上限 64 MiB |
| 流式保存 | 直接写入本地磁盘，避免完整文件驻留内存 | 仅在支持文件选择器的顶层桌面浏览器显示 |
| 桌面接管 | 配对后逐条或批量发送；也可通过 `omniget:` 协议交接 | 本机需运行兼容桌面端；接收成功不等于下载完成 |
| 进度回传 | 查看与网页已发送链接匹配的桌面任务 | 连接有效且页面可见时轮询，不展示完整桌面队列 |
| 安装包入口 | 按 Windows、macOS、Linux 展示上游发行资产 | 在线读取 GitHub；不可用时回退内置记录，摘要仅在上游提供时显示 |

## 快速开始

### 只保存文件直链

1. 打开 [在线工作台](https://omniget.tarokiki.chatgpt.site)，或按下方说明本地运行。
2. 粘贴可直接读取的文件 URL，加入队列。
3. 点击 **保存文件**；支持的浏览器还可选择 **流式保存**。
4. 若源站禁止跨域或链接失效，尝试 **打开源文件**，或交给桌面端。网页不会绕过源站限制。

### 连接本机 OmniGet

1. 从 [上游 Releases](https://github.com/OpenSelena/omniget/releases/latest) 安装并启动 **v0.15.1 或更新版本**。
2. 在桌面端打开 **设置 → 插件 → 浏览器扩展**，复制本机端点与配对令牌。
3. 在网页点击 **连接桌面端**，粘贴端点和令牌；如出现浏览器本地网络权限提示，确认后才能访问本机服务。
4. 添加媒体链接并点击 **发送到本机**。桌面端可能仍要求选择下载位置或确认任务。
5. 无法配对时，可使用 **用桌面打开**，通过 `omniget:` 协议交接单条任务。

**这里的“本机”是运行浏览器的设备。** 手机网页中的 `127.0.0.1` 不会自动指向你的电脑。不要将本机桥接端口或配对令牌公开到互联网。

## 系统架构

![OmniGet Web bilingual architecture](docs/images/architecture.svg)

[查看架构图源文件](docs/images/architecture.svg)

- **静态层**：Sites 仅提供 `dist/` 中的 HTML、CSS、ES modules 和静态资源，没有应用后端代理下载。
- **浏览器层**：`app.mjs` 编排 UI 与队列；`links.mjs` 与 `detect.mjs` 解析并分流链接。
- **文件路径**：`download.mjs` 直接读取文件源，采用 Blob 缓冲保存或文件系统流式写入。
- **桌面路径**：`bridge.mjs` 访问 `http://127.0.0.1:<port>` 的 `/v1/health`、`/v1/enqueue`、`/v1/queue`。队列与提交接口使用 Bearer 配对令牌。
- **发行信息**：`releases.mjs` 获取 GitHub 最新版本，并以 `assets/releases.json` 作为回退。

### 数据与隐私

| 数据 | 保存或发送位置 |
| --- | --- |
| 链接、任务状态（可能包含签名 URL） | 当前浏览器会话的 `sessionStorage`；禁用存储时仅在内存中 |
| 配对令牌 | 仅页面内存，刷新后需重新连接 |
| 媒体地址与桌面令牌 | 不经过 Sites 后端；需要时发送到本机桌面桥接 |
| 下载文件 | 浏览器或桌面端直接从来源读取 |
| 安装包元数据 | 浏览器请求 GitHub API；失败时读取内置记录 |

清除网页队列不会取消已经交给桌面端的任务。发送后若未收到确认，先检查桌面队列，避免盲目重试造成重复任务。

## 本地运行

无需 npm 安装或构建步骤。使用 Python 3 启动静态服务器：

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist
```

访问 [http://127.0.0.1:8080](http://127.0.0.1:8080)。请勿直接以 `file://` 打开 HTML，浏览器会限制模块加载。

### 部署到 Sites

部署目录为 `dist`。注册自己的 Site 后，在项目根目录的 `.openai/hosting.json` 中填入返回的项目 ID：

```json
{
  "project_id": "YOUR_SITE_PROJECT_ID",
  "static": { "directory": "dist" }
}
```

不要将个人令牌或真实凭证写进部署配置、README 或提交记录。

## 目录导航

```text
dist/
├── index.html          # 页面结构
├── app.mjs             # UI、会话队列、任务编排
├── assets/
│   ├── site.css        # 响应式样式
│   ├── omniget.png     # 上游应用图标
│   └── releases.json   # 发行信息回退
├── lib/
│   ├── links.mjs       # 链接解析与分流
│   ├── detect.mjs      # 平台识别
│   ├── download.mjs    # 浏览器文件保存
│   ├── bridge.mjs      # 本机桥接与进度
│   └── releases.mjs    # 安装包信息
└── samples/            # 演示文件
docs/images/            # README 矢量配图
```

## 常见问题

**为什么提示无法读取文件？**  
文件源可能不允许 CORS、需要登录，或链接已经失效。尝试打开源文件；网页不会代理或绕过访问控制。

**为什么连接不了桌面端？**  
确认桌面端已运行、版本兼容、端点正确，且浏览器允许本地网络访问。令牌失效时复制当前令牌，刷新网页后重新配对。

**“桌面端已接收”就是下载完成吗？**  
不是。它只代表入队请求被确认，后续下载和可能的文件位置选择由桌面端处理。

**能在网页直接下载平台视频、HLS/DASH 或磁力吗？**  
这些任务交由桌面端解析和下载，网页仅负责整理与交接。

## 上游与许可证

本项目是 [OpenSelena/omniget](https://github.com/OpenSelena/omniget) 的独立网页适配，不是上游桌面程序的完整替代。上游由 **igect** 维护，基于 **Tonho** 的原版架构。

网页使用上游 [`51d00c7`](https://github.com/OpenSelena/omniget/tree/51d00c75cf7bc339cf4e657a3b394a19968580fd) 的应用图标、扩展平台检测、下载单位格式和本机接口；桌面构建产物仍由上游发行。README 配图是文档示意图，不是运行截图。

本项目使用 [GPL-3.0](LICENSE)。仅下载你拥有权利或获准获取的内容，并遵守来源服务的使用条款。
