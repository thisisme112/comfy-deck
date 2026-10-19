# ComfyDeck · ComfyUI 管理器

[![Release](https://img.shields.io/github/v/release/thisisme112/comfy-deck?include_prereleases&label=release)](https://github.com/thisisme112/comfy-deck/releases)
[![License](https://img.shields.io/github/license/thisisme112/comfy-deck)](LICENSE)

给 Windows 便携版 ComfyUI 用的本地管理面板：启动 / 停止、图库、工作流、模型、插件、核心版本，以及 CivitAI 浏览和下载。不修改 ComfyUI 源码。

- 默认地址：<http://127.0.0.1:8288>，只监听本机
- 所有数据保存在程序旁边的 `data` 目录，整个文件夹可以随 ComfyUI 一起移动
- 前端是原生 JS / CSS，没有构建步骤；后端 FastAPI

## 下载

到 [Releases](https://github.com/thisisme112/comfy-deck/releases) 选择一种：

| 版本 | 适用场景 |
| --- | --- |
| `ComfyDeck-x.y.z-setup.exe` | 安装版。按用户安装到 `%LOCALAPPDATA%\Programs\ComfyDeck`，带开始菜单、桌面快捷方式和卸载器 |
| `ComfyDeck-x.y.z-portable-win64.zip` | 便携版。解压后双击 `ComfyDeck.exe`，不需要安装 Python |

ComfyDeck 不会自带 ComfyUI；首次启动会**自动检测**已有的 ComfyUI 安装。

## 启动与路径设置

首次启动时，ComfyDeck 会按以下顺序自动查找 ComfyUI：

1. `COMFYUI_DIR` / `COMFYUI_PATH` 环境变量
2. 正在运行的 ComfyUI 进程
3. 程序目录及上一级目录中的 `ComfyUI`
4. 各个磁盘的常见位置，例如 `D:\ComfyUI`、`D:\ComfyUI_windows_portable\ComfyUI`、`D:\AI\ComfyUI`
5. 设置页里的“深度扫描”会继续搜索磁盘（最多三层）

找不到或需要切换时，到 **设置 → 安装位置**：

- **自动检测**：列出所有候选目录，点“使用”即可
- **选择 ComfyUI 目录**：弹出 Windows 原生文件夹选择器（目录必须包含 `main.py`）
- **选择 Python**：选择启动 ComfyUI 用的解释器；选中 ComfyUI 目录后会自动匹配上一级的 `python_embeded\python.exe`
- 也可以直接粘贴路径。保存时会校验目录和 Python 是否存在

源码运行时，双击 `start_manager.bat`，或：

```bat
cd /d E:\ComfyUI_windows_portable\comfy-deck
..\python_embeded\python.exe server.py
```

参数：`--port 8288`、`--no-browser`、`--host 127.0.0.1`。

快捷键 `Ctrl+K` 打开命令面板（跳转页面、启停 ComfyUI、搜索工作流和模型）。

## 功能

### 启动台
- 启动 / 停止 / 重启 ComfyUI，状态常驻在左下角
- **启动方案**：一套可命名的启动参数 + 环境变量，内置标准 / fp16 累加 / 低显存 / 安全模式，常用参数点标签即可开关
- 实时日志（ANSI 颜色已去除，进度条按行覆盖，报错高亮），可回看最近 12 次运行的日志
- 运行中可一键释放显存、中断当前任务、清空队列
- 就绪后自动打开浏览器；可设置打开 ComfyDeck 时自动启动 ComfyUI
- ComfyUI 由管理器启动后独立运行，关闭或重启管理器不会影响它，下次会自动接管
- 异常退出会在总览和启动台提示退出码；外部启动的实例也能识别并停止

### 图库
- 索引 `output`、`input` 以及设置里添加的其他文件夹，后台增量扫描，缩略图缓存在 `data/thumbs`
- 读取 PNG / WebP 里的 ComfyUI 元数据：提示词、反向提示词、模型、LoRA、种子、步数、CFG、采样器（兼容 A1111 参数）
- 按提示词 / 模型 / LoRA / 种子 / 文件名搜索，按文件夹、类型、收藏、是否含工作流筛选
- 网格 / 方形 / 瀑布流，可调缩略图大小，按日期分组，无限滚动
- 大图查看器：← → 切换，`F` 收藏，`Delete` 删除；点模型或 LoRA 可筛出同模型的所有图
- 从图片提取内嵌工作流，存入工作流库或下载 JSON；一键复制到 `input` 作为输入图
- 多选（Shift 连选、Ctrl+A）批量收藏 / 删除，删除进回收站

### 工作流
- 浏览 `user/*/workflows` 下的全部工作流，带节点图预览（滚轮缩放、拖动平移，支持子图节点）
- 自动分析用到的模型，对照本地模型库标出缺失；ComfyUI 运行时还会检出未安装的节点
- 收藏、标签、备注、重命名、移动文件夹、复制副本、删除，支持拖拽或按钮导入 JSON
- 模型详情里会列出引用它的工作流；模型库可筛选“没被任何工作流用到”的模型，方便清理

### 模型库
- 扫描 `models`、`extra_model_paths.yaml` 和手动添加的目录；SHA256 匹配 CivitAI，读取 safetensors 元数据
- **检查新版本**：对已匹配的模型查询 CivitAI 是否有更新的同基础模型版本
- 触发词点击复制、重复文件检测、重命名、收藏、备注、删除到回收站

### CivitAI
- 搜索 / 作者 / 类型 / 基础模型 / 排序 / 时间范围，滚动自动加载
- 封面优先选安全图，视频封面使用静帧；NSFW 默认模糊
- 已安装的模型带标记，可隐藏；版本和文件列表、参考图与提示词、一键下载到对应目录（断点续传）

### 其他
- **插件**：Git / Registry 插件检查更新、批量更新、启用 / 禁用、安装、移除
- **核心版本**：检查最新稳定版、更新、回滚、更新历史
- **回收站**：通过 ComfyDeck 删除的模型 / 插件 / 工作流 / 图片都先放这里，可恢复到原位置
- **总览**：运行状态与显存、待处理事项、最近生成、最近工作流、磁盘占用

## 数据目录

```text
ComfyDeck/
  data/
    config.json      设置与 Token（明文，仅本机）
    profiles.json    启动方案
    comfydeck.db     模型元数据、工作流标签、图库索引、缓存
    previews/        CivitAI 预览图
    thumbs/          图库缩略图
    logs/            任务日志；logs/comfyui/ 是 ComfyUI 运行日志
    trash/           回收站
  _internal/         PyInstaller 运行时与前端资源
  ComfyDeck.exe
```

便携版把 `data` 放在 `ComfyDeck.exe` 旁边；如果程序目录不可写（例如安装在 Program Files），会自动改用 `%LOCALAPPDATA%\ComfyDeck\data`。可用环境变量 `COMFYDECK_DATA_DIR` 强制指定数据目录。

源码运行时的布局：

```text
comfy-deck/
  data/
  comfydeck/         后端
  web/               前端
  server.py
```

## 安全

- 只绑定 `127.0.0.1`；校验 `Host` 与 `Origin`，拒绝外部网页和 DNS rebinding
- 删除都先进回收站；停止外部进程前会确认它确实是 ComfyUI
- API Key 只保存在本机 `data/config.json`

## 常见问题

**端口被占用**：`ComfyDeck.exe --port 8289`（源码运行时加在 `server.py` 后面）。

**图库为空**：确认图片在 `ComfyUI/output`，或在设置里添加文件夹；点图库右上角刷新重建索引。

**检测不到缺失节点**：需要 ComfyUI 正在运行（节点列表来自它的 `/object_info`）。

**更新核心被拒绝**：ComfyUI 正在运行或仓库有未提交修改，先停止，或使用“强制更新”（会 `git stash`）。

**插件更新后 ComfyUI 起不来**：用启动台的“安全模式”方案启动，再到插件页处理；日志在启动台右侧。

**打包版界面打不开**：查看 `data/logs/comfydeck.log`；端口冲突时用 `--port` 换一个。

## 构建与发布

需要 Windows、Python 3.10+、Inno Setup 6（脚本会自动通过 winget / Chocolatey 安装）。

```powershell
pwsh -File tools\build_release.ps1
```

产物在 `dist/release/`：

- `ComfyDeck-<version>-portable-win64.zip`
- `ComfyDeck-<version>-setup.exe`
- `SHA256SUMS.txt`

只构建便携版：

```powershell
pwsh -File tools\build_release.ps1 -SkipInstaller
```

发布到 GitHub Release：

```powershell
gh release create v2.1.0 dist/release/* --title "ComfyDeck 2.1.0" --generate-notes
```

推送 `v*` 标签时，`.github/workflows/release.yml` 也会在 GitHub Actions 中自动构建并上传安装包和便携版。

## 许可

[MIT](LICENSE)
