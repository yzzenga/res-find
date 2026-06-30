# 🔍 Res-Find

> 嗅探浏览器页面中的图片、视频、视频流（HLS/DASH）、音频资源，一键下载。

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-brightgreen?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-green)

---

## 功能

- **自动嗅探** — 页面加载时自动捕获图片、视频、音频、HLS/DASH 流媒体资源
- **实时监控** — `MutationObserver` + `PerformanceObserver` 双重检测，动态加载的资源也不放过
- **分类筛选** — 按类型（图片/视频/音频/流）、格式、大小快速过滤
- **预览** — 点击资源可直接预览图片 / 播放视频和音频
- **一键下载** — 单个下载或批量选中后打包下载
- **智能命名** — 识别页面中的人类可读文件名，避免乱码哈希文件名
- **嗅探开关** — 可随时启用/停用嗅探，减少干扰
- **音视频合成** — 将分离的视频和音频流合成为一个包含音轨的视频文件（浏览器端合成）

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

> 🚧 即将上架，敬请期待。

## 使用

### 基本流程

1. 打开任意包含图片/视频/音频的网页
2. 点击工具栏中的 Res-Find 图标打开弹窗
3. 弹窗自动列出当前页面嗅探到的所有资源
4. 点击顶部标签按类型筛选（全部 / 图片 / 视频 / 音频 / 流）
5. 点击资源条目上的下载按钮即可下载

### 资源预览

点击资源条目可打开预览弹窗查看图片或播放音视频。

### 批量操作

勾选多个资源后点击 **下载选中** 按钮，或使用 **合并下载** 功能。

### 音视频合成

当页面中的视频和音频作为独立流加载时（常见于某些直播/点播站点）：

1. 在资源列表中分别找到视频流和音频流
2. 点击 **合成** 按钮打开合成页面
3. 预览确认后点击 **开始合成**
4. 完成后下载合并后的视频文件

### 嗅探开关

弹窗顶部的眼睛图标按钮可随时启用/停用当前页面的嗅探功能。停用后不再捕获新资源。

## 项目结构

```
res-find/
├── manifest.json         # Chrome 扩展清单 (Manifest V3)
├── background.js         # Service Worker：资源存储、下载编排
├── content.js            # Content Script：页面嗅探逻辑
├── popup.html            # 弹窗 UI
├── popup.css             # 弹窗样式
├── popup.js              # 弹窗交互逻辑
├── merge.html            # 音视频合成页面
├── merge.js              # 合成逻辑 (MediaRecorder API)
├── generate_icons.py     # 图标生成脚本 (可选)
├── icons/                # 扩展图标
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md
└── .gitignore
```

## 技术栈

| 类别             | 技术                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| 扩展框架         | Chrome Extension Manifest V3                                         |
| 架构             | Service Worker + Content Script 通信                                 |
| 资源嗅探         | `PerformanceObserver` + `MutationObserver` + `webRequest` API        |
| 音视频合成       | `MediaRecorder` API（浏览器端合成，无需服务端）                       |
| 语言             | 纯 JavaScript / HTML / CSS，无外部依赖                               |

## 开发

### 环境要求

- Chrome 浏览器（>= 88，支持 Manifest V3）
- Python 3（可选，用于生成图标）

### 本地开发

本项目为纯前端扩展，无需构建工具链。修改代码后，在 `chrome://extensions` 点击扩展卡片上的 **🔄 刷新** 按钮即可生效。

### 生成图标

```bash
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
manifest.json  background.js  content.js  popup.html
popup.css  popup.js  merge.html  merge.js  icons/
```

## FAQ

<details>
<summary><b>扩展无法嗅探到资源？</b></summary>

- 确认扩展已启用，且弹窗中的嗅探开关处于打开状态
- 某些页面可能使用 WebSocket 或 MediaSource 加载，嗅探范围有限
- 尝试刷新页面后重新打开弹窗
</details>

<details>
<summary><b>下载的文件名是乱码？</b></summary>

浏览器会尝试从页面中提取可读文件名。如果无法识别，将使用 URL 中的最后一段作为文件名。
</details>

<details>
<summary><b>音视频合成后没有声音？</b></summary>

确保同时选中了视频流和音频流。部分站点使用加密流（DRM），浏览器端无法合成。
</details>

## 贡献

欢迎提交 Issue 或 Pull Request！

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feat/your-feature`
3. 提交改动：`git commit -m "feat: add your feature"`
4. 推送分支：`git push origin feat/your-feature`
5. 开启 Pull Request

## 许可

[MIT](./LICENSE) © Res-Find Contributors
