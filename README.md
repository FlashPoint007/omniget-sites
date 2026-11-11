# OmniGet Web

OmniGet 的 Sites 网页工作台。可以在浏览器中整理下载链接、保存文件直链，或将媒体任务交给本机 OmniGet 桌面端。

| 功能 | 使用方式 |
| --- | --- |
| 链接和队列 | 单条粘贴、每行一条批量粘贴或导入 UTF-8 TXT。支持识别平台、去重和按状态筛选。任务留在当前浏览器会话。 |
| 文件直链 | 在队列点「保存文件」。跨域文件需由源站允许浏览器读取。可点「打开源文件」让浏览器处理。普通保存支持 64 MiB 以内文件。具备文件选择器的桌面浏览器可流式写入本地磁盘。 |
| 平台媒体、HLS / DASH、磁力 | 可用系统协议逐条打开桌面端，也可配对后批量发送。桌面端决定解析能力、下载位置、清晰度、格式与登录状态。 |
| 桌面端进度 | 配对后只显示与网页已发送链接匹配的任务进度。上游接口确认接收链接后，可能仍需在桌面端选择下载位置。 |
| 桌面安装包 | Windows、macOS 和 Linux 安装包链接及上游提供的 SHA-256。优先读取 GitHub 最新发行信息，离线时使用内置发行记录。 |

## 本机连接

1. 从 [上游 Releases](https://github.com/OpenSelena/omniget/releases/latest) 安装并启动 OmniGet v0.15.1 或更新版本。
2. 打开「设置 → 插件 → 浏览器扩展」，复制显示的本机端点和配对令牌。
3. 在网页点击「连接桌面端」，粘贴端点和令牌。如果浏览器请求本地网络权限，需允许它访问本机服务。
4. 添加 B 站、YouTube 或其他媒体链接，然后点「发送到本机」。无法建立本机连接时，可点「用桌面打开」通过 `omniget:` 协议交接单条任务。

网页通过 `http://127.0.0.1:<port>` 使用上游的 `/v1/health`、`/v1/enqueue` 和 `/v1/queue` 接口。令牌只保存在页面内存中，刷新页面后需要重新连接。文件由浏览器或桌面端直接读取，媒体地址和桌面令牌不会经过 Sites 后端。课程、Telegram、转码、转写和阅读等功能在桌面端使用。

## 本地运行和部署

没有构建依赖。使用 Python 3 在本机启动静态服务器。

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist
```

打开 [127.0.0.1:8080](http://127.0.0.1:8080)。直接从磁盘打开 HTML 时，浏览器会限制模块加载。

Sites 部署目录为 `dist`。注册自己的 Site 后，将返回的项目 ID 填入项目根目录的 `.openai/hosting.json`。

```json
{
  "project_id": "YOUR_SITE_PROJECT_ID",
  "static": { "directory": "dist" }
}
```

## 上游和许可证

这是 [OpenSelena/omniget](https://github.com/OpenSelena/omniget) 的独立网页适配，由上游桌面程序继续处理本机任务。上游由 igect 维护，基于 Tonho 的原版架构。网页使用上游 [`51d00c7`](https://github.com/OpenSelena/omniget/tree/51d00c75cf7bc339cf4e657a3b394a19968580fd) 的应用图标、扩展平台检测、下载单位格式和本机接口。桌面构建产物继续由上游发行。

本项目使用 [GPL-3.0](LICENSE)。
