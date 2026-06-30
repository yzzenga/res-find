# Res-Find

> 嗅探浏览器页面中的图片、视频、视频流（HLS/DASH）、音频资源，一键下载。

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-brightgreen?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-green)

Res-Find 是一款轻量级的 Chrome 扩展，无需任何外部依赖。它能自动嗅探网页中加载的所有媒体资源，并提供便捷的预览、下载和合成功能。无论是普通图片、背景音乐，还是流媒体视频（HLS/DASH），都能轻松捕获。

---

## 功能特性

- **自动嗅探** — 页面加载时自动捕获图片、视频、音频、HLS/DASH 流媒体资源，无需手动操作
- **多维度检测** — 结合 `webRequest` API、`PerformanceObserver`、`MutationObserver`、`IntersectionObserver` 四种机制，确保动态加载和懒加载的资源也不会遗漏
- **JS 层 Hook** — 通过 `injected.js` 在页面 MAIN World 中拦截 `HTMLMediaElement.src` 赋值、`fetch/XHR` 响应体、`Audio()` 构造函数等，捕获框架内部加载的媒体 URL
- **分类筛选** — 按类型（图片/视频/音频/流）、格式（PNG/MP4/M3U8 等）、文件大小快速过滤
- **关键词搜索** — 按资源名称或 URL 搜索，快速定位目标资源
- **预览** — 点击资源即可预览图片、播放视频和音频，或查看流媒体信息
- **一键下载** — 单个下载或批量选中后打包下载，支持自动重命名
- **智能命名** — 自动从页面 DOM 上下文（`alt`、`title`、`figcaption`、标题等）提取人类可读的文件名，避免乱码哈希文件名
- **手动重命名** — 支持在弹窗中直接修改资源名称和资源类型
- **嗅探开关** — 可随时启用/停用当前页面的嗅探功能，减少干扰
- **音视频合成** — 将分离的视频和音频流合成为一个包含音轨的视频文件，完全在浏览器端完成，无需服务端
- **特定站点适配** — 内置对 Bilibili（`__INITIAL_STATE__`）、抖音（`_ROUTER_DATA`）、Next.js SSR 等站点的全局数据提取支持

## 安装

### 从源码安装（开发模式）

1. **克隆仓库**
   ```bash
   git clone https://github.com/your-username/res-find.git
   cd res-find
   ```

2. **加载到 Chrome**
   - 打开 Chrome 浏览器，进入 `chrome://extensions`
   - 开启右上角的 **开发者模式**
   - 点击 **加载已解压的扩展程序**
   - 选择本项目所在的 `res-find` 目录

### 从 Chrome 应用商店安装

> 即将上架，敬请期待。

## 使用指南

### 基本流程

1. 打开任意包含图片/视频/音频的网页
2. 点击工具栏中的 Res-Find 图标打开弹窗
3. 弹窗自动列出当前页面嗅探到的所有资源
4. 点击顶部标签按类型筛选（全部 / 图片 / 视频 / 音频 / 流）
5. 可进一步按格式（PNG / MP4 / M3U8 等）或文件大小筛选
6. 在搜索框中输入关键词快速查找资源
7. 点击资源条目上的下载按钮即可下载

### 资源预览

点击资源条目可打开预览弹窗：
- **图片** — 放大显示图片
- **视频** — 使用浏览器原生播放器播放
- **音频** — 显示波形图标并提供播放控件
- **流媒体** — 提示不支持直接预览，可下载或用外部播放器打开

### 批量操作

勾选多个资源后，底部操作栏会出现 **下载选中** 按钮。如果勾选的资源中包含可配对的视频+音频流，还会出现 **音视频合成下载** 按钮。

### 音视频合成

当页面中的视频和音频作为独立流加载时（常见于 Bilibili 等使用 DASH 技术的站点）：

1. 在资源列表中分别勾选视频流和音频流（它们会有紫色左边框和 P 组标记）
2. 点击 **音视频合成下载** 按钮
3. 扩展会先分别下载视频和音频文件
4. 自动打开合成页面，预览确认后点击 **开始合成**
5. 完成后下载合并后的视频文件

> 注意：合成完全在浏览器端使用 `MediaRecorder` API 完成，无需服务端支持。
> 部分站点使用 DRM 加密流，浏览器端无法合成。

### 嗅探开关

弹窗顶部的眼睛图标按钮可随时启用/停用当前页面的嗅探功能。停用后不再捕获新资源，之前发现的资源仍然保留。

### 资源类型修正

如果资源被错误分类（例如将视频流识别为音频），可以使用资源条目上的下拉菜单手动修改类型。

### 重命名

点击资源名称旁的重命名按钮（铅笔图标），可以直接修改资源的显示名称，方便后续查找和下载。

## 项目结构

```
res-find/
├── manifest.json         # Chrome 扩展清单 (Manifest V3)
├── background.js         # Service Worker：资源存储、webRequest 监听、下载编排
├── content.js            # Content Script：DOM 扫描、MutationObserver、站点数据提取
├── injected.js           # 注入 MAIN World 的 Hook 脚本：拦截 JS 原生 API
├── popup.html            # 弹窗 UI
├── popup.css             # 弹窗样式（暗色主题）
├── popup.js              # 弹窗交互逻辑：渲染、筛选、下载、预览
├── merge.html            # 音视频合成页面
├── merge.js              # 合成逻辑（基于 Canvas + MediaRecorder API）
├── generate_icons.py     # 图标生成脚本（可选，需要 Python + Pillow）
├── icons/                # 扩展图标
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md             # 中文文档
├── README.en.md          # 英文文档
└── .gitignore
```

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 扩展框架 | Chrome Extension Manifest V3 |
| 架构模式 | Service Worker + Content Script 双向消息通信 |
| 资源嗅探 | `webRequest` API + `PerformanceObserver` + `MutationObserver` + `IntersectionObserver` |
| JS 层 Hook | Monkey-patch `HTMLMediaElement.src`、`fetch`、`XMLHttpRequest`、`Audio()`、`URL.createObjectURL` |
| 音视频合成 | `Canvas.captureStream()` + `AudioContext` + `MediaRecorder` API（纯客户端合成） |
| 语言 | 纯 JavaScript / HTML / CSS，零外部依赖 |
| 站点适配 | 内置 Bilibili、抖音、Next.js SSR 等站点的数据提取支持 |

## 开发

### 环境要求

- Chrome 浏览器（>= 88，支持 Manifest V3）
- Python 3（可选，用于生成图标）

### 本地开发

本项目为纯前端扩展，无需构建工具链。修改代码后，在 `chrome://extensions` 点击扩展卡片上的 **刷新** 按钮即可生效。

### 代码结构说明

- **background.js** — 扩展的核心后台脚本，管理所有标签页的资源存储，通过 `webRequest` API 嗅探网络请求，处理来自 content script 和 popup 的消息
- **content.js** — 注入每个页面的内容脚本，执行 DOM 扫描、性能监听、动态元素监控和站点特定数据提取
- **injected.js** — 通过 `<script>` 标签注入到页面 MAIN World 中，拦截原生 JS API 调用以捕获媒体 URL
- **popup.js** — 弹窗 UI 的控制器，负责渲染资源列表、筛选、预览和下载流程
- **merge.js** — 音视频合成页面逻辑，使用 Canvas 逐帧绘制视频并与外部音频混合

### 生成图标

```bash
pip install Pillow
python generate_icons.py
```

### 打包发布

```bash
# 1. 在 chrome://extensions 中点击"打包扩展程序"
# 2. 选择 res-find 目录
# 3. 生成 .crx 文件和 .pem 私钥
```

也可手动将以下文件压缩为 `.zip` 用于 Chrome 应用商店上传：

```
manifest.json  background.js  content.js  injected.js  popup.html
popup.css  popup.js  merge.html  merge.js  icons/
```

## FAQ

<details>
<summary><b>扩展无法嗅探到资源？</b></summary>

- 确认扩展已启用，且弹窗中的嗅探开关处于打开状态
- 某些页面使用 WebSocket 或 MSE（Media Source Extensions）加载媒体，嗅探范围有限
- 尝试刷新页面后重新打开弹窗
- 如果页面使用了 Service Worker 拦截请求，部分资源可能无法被嗅探
</details>

<details>
<summary><b>下载的文件名是乱码？</b></summary>

浏览器会尝试从页面 DOM 上下文（`alt`、`title`、`figcaption`、标题等）提取可读文件名。如果无法识别，将使用 URL 中的最后一段作为文件名。你可以在弹窗中手动重命名资源后再下载。
</details>

<details>
<summary><b>音视频合成后没有声音？</b></summary>

确保同时选中了视频流和音频流。部分站点使用加密流（DRM），浏览器端无法合成。另外，合成时请确保浏览器标签页不是静音状态。
</details>

<details>
<summary><b>扩展与其他嗅探工具冲突？</b></summary>

Res-Find 使用 Manifest V3 标准 API，理论上与其他扩展无冲突。如果遇到问题，可尝试在无痕模式下逐个排查。
</details>

<details>
<summary><b>如何贡献代码？</b></summary>

欢迎提交 Issue 或 Pull Request！请参见下方的贡献指南。
</details>

## 贡献

欢迎提交 Issue 或 Pull Request！

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feat/your-feature`
3. 提交改动：`git commit -m "feat: add your feature"`
4. 推送分支：`git push origin feat/your-feature`
5. 开启 Pull Request

## 许可

[MIT](./LICENSE) &copy; Res-Find Contributors
