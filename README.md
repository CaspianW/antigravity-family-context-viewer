# Antigravity 家庭组上下文查看器与 Token 用量看板

**简体中文** · [家庭组部署指南](FAMILY_README.md) · [AI 智能体部署规范](AGENTS.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

给 Antigravity 桌面客户端补全上下文用量、模型额度、生成速度、本地消耗统计与家庭组多设备共享看板，支持 Windows、macOS 与 Linux。

> **上游说明**：本项目基于原仓库 **[elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)**（`v0.8.8`）二次开发，保留原版核心上下文与用量看板能力，并针对家庭组多设备共享、五面板界面重塑、Antigravity `v2.34.0` 兼容、跨平台切号及自动化部署进行了扩展与修复。原版演示视频与上游动态可参考原仓库；**本分支更新请使用 `git pull` 或 `node deploy.js --pull`，切勿使用插件内原版在线更新（会覆盖本分支功能）**。

---

## ✨ 新增与改进功能（相比原版）

### 1. 家庭组多设备用量共享与网页看板（详参 [FAMILY_README.md](FAMILY_README.md)）
- **「家庭组」面板与独立环形饼图**：在「Token 用量」面板内集成「家庭组」视图，提供独立的紫色环形占比饼图（按模型 API 成本加权折算，并按重置周期锁定周额度峰值），清晰分离家庭成员占比与分时段统计卡片。
- **多设备自动上报与接入引导**：支持 Windows、macOS、Linux 多设备接入，支持「今日 / 近 5 小时 / 近 7 天 / 本月」筛选、3 步引导式 JSON 配置导入以及 [`setup-family.js`](setup-family.js) 一键接入。
- **双后端自托管与低配额消耗优化**：内置 [`family-server/`](family-server/README.md)，支持 **Cloudflare Workers + D1** 或 **Node.js + SQLite** 自托管。插件端集成缓存、防抖与退避机制以大幅降低 D1 `row_read` 请求消耗。
- **账号粒度隐私控制**：按本机账号独立配置规则（`家庭统计` / `独立统计` / `私人 · 仅本机`）；邮箱原文、认证凭据、对话内容与文件路径始终保留在本机，修复了多轮调用及实时暂态调用漏报与孤立步骤重复计数问题。

### 2. 五面板架构重构与主题配色优化
- **五独立面板 + 统一固定宽度**：重整为 5 个独立面板，并统一面板内各页签与子视图宽度；整体背景、卡片与正文保持跟随系统浅色 / 深色主题，仅用功能强调色区分模块：
  - **模型额度（深翠绿）**：精简聚焦 Gemini / Claude 共享额度池，支持按账号每周额度对比。
  - **当前会话上下文（深蓝）**：新增一键 `/compact` 上下文压缩按钮与按剩余比例（默认 `20%`）触发的自动压缩设置，修复 `/compact` 后的统计刷新延迟。
  - **模型输出速度（暖琥珀金 / S 级橙色星标）**：展示实时输出速度、首字延迟（TTFT）与历史样本趋势对比。
  - **本机 Token 用量 & 家庭组（紫色）**：优化「按模型 Token 用量」柱状图默认线性比例与高度区分度，提升高低用量对比可读性。
- **CLI 启动提示防遮挡**：优化缺失 `agy` CLI 时的错误 Toast 定位，动态锚定在顶栏下方并 3 秒自动淡出，不再遮挡顶栏功能按钮。

### 3. Antigravity `v2.34.0` 适配与跨平台切号修复
- **Antigravity `v2.34.0` 全面兼容**：
  - 适配新版客户端 `dist/utils.js` 的 `loadHubWindowUrl` ASAR 注入锚点（保留与内联 CoT 等补丁共存）。
  - 适配默认禁用 CDP 及 `AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP=1` 机制：优先从 Electron 主进程与 `daemon/hub_*.json` 获取本地 Language Server 鉴权与 CSRF Token，并在 `401/403` 时自动刷新重试。
- **Linux 与跨平台一键切号修复**：
  - 修复 Linux 客户端（如 Antigravity 2.x）不读取 `state.vscdb` 导致的切号失效问题，新增基于 FreeDesktop Secret Service（GNOME Keyring / `org.freedesktop.secrets`，通过 `stdin` 安全传输并支持快照回滚）及兜底文件的凭据读写与当前账号 `refresh_token` 自动回填。
  - 修复 Linux Language Server 探测与平滑重启、Windows 下 OAuth 浏览器调用失败（改用 `rundll32.exe` 处理含 `&` URL），以及缺失凭据账号的按钮禁用态与引导提示。

### 4. AI 智能体跨平台一键部署脚本 (`deploy.js`)
- 新增零外部依赖、跨 Windows / macOS / Linux 的 [`deploy.js`](deploy.js)（需 Node.js `>= 22.4.0`），支持首次部署（`node deploy.js`）与版本升级（`node deploy.js --pull`），自动启用 `--enable-meter` 并完整保留本机 `family_sync_config.json` 与历史账本，支持 `--dry-run --json` 供任意 AI 智能体自动化执行与结果校验。

---

## 📦 继承自原版的核心能力

- **上下文监控与模型预算设置**：实时查看当前会话已用 Token 与剩余空间，按模型分别保存上下文长度（支持预设、自定义及恢复默认），并区分已保存设置与实际服务端共享请求预算。
- **模型额度圆环**：顶栏圆环展示剩余额度，展开查看共享额度池、5 小时及每周额度与重置时间，支持刷新与低额度提醒，并在模型设置列表中联动显示各模型余量（区分额度耗尽、无权限与未知状态）。
- **生成速度与会话明细**：实时查看输出速度、首字延迟（TTFT）、生成耗时与本轮输出 Token，并展开提示词、回复、思考、工具调用及可读取附件的体积估算。
- **历史用量与活跃热力图**：汇总桌面端与 CLI 本地已采集用量，支持按周期查看统计及自定义 5 档活跃热力图配色。
- **API 费用参考与订阅对比**：按已记录用量折算 API 预估费用并与常见订阅方案对比（支持币种切换与人民币折算；仅供消费参考，不代表实际扣费）。
- **三语言插件面板**：面板内置简体中文、繁體中文与 English 即时切换，支持浅色 / 深色主题联动。
- **可选系统增强与免 TUN 代理**：提供客户端简体中文化、免 TUN 本地代理、提示词 `0~4` 档位、防幻觉约束、中文会话标题等按平台能力提供的可选设置。
- **一键启动 CLI 与备份还原**：从顶栏快速启动已安装的 Antigravity CLI，安装器内置原版 `app.asar` 备份、完整性校验与无损还原。

> **注意事项**：
> - 上下文设置的实际效果取决于模型、客户端及服务端限制，不代表所有模型都能无限扩容；模型设置列表用于配置上下文预算，不替代客户端切换实际聊天模型。
> - 免 TUN 功能需要可用的本地代理，并非免费网络服务。

---

## 🤖 给 AI 智能体的一键部署与更新指令 (For AI Agents)

如果你将本仓库交给 Windows、macOS 或 Linux 上的任意 AI 助手部署或升级，只需对 AI 说：

> **“读取仓库 `https://github.com/CaspianW/antigravity-family-context-viewer` 里的 `AGENTS.md`，帮我自动部署（或拉取最新版本并更新）这个插件。”**

AI 智能体只需在仓库根目录运行统一部署脚本 [`deploy.js`](deploy.js)（零外部依赖，需要 Node.js `>= 22.4.0`，**会自动启用 `--enable-meter` 并保留本机 `family_sync_config.json` 与账本**）：

```bash
# 首次部署（克隆本分支仓库后执行）
node deploy.js

# 后续版本更新（自动 git pull --ff-only + 重新注入 + 检查是否需要重启客户端）
node deploy.js --pull

# 如需 AI 解析结构化结果或先做只读预检
node deploy.js --pull --json
node deploy.js --dry-run --json
```

> [!IMPORTANT] **AI 智能体执行与验证边界规范（完整规则见 [`AGENTS.md`](AGENTS.md)）**：
> - **拉取源约束**：本家庭魔改版必须通过 `CaspianW/antigravity-family-context-viewer` 的 `git pull` / `node deploy.js --pull` 更新；**切勿**使用插件内置的在线更新功能（指向原版仓库）。
> - **零外部依赖 & 非交互脚本**：无需执行 `npm install`；Windows 下切勿让 Agent 调用末尾带 `pause` 的 `.bat` 脚本，直接运行 `node deploy.js`。
> - **`--enable-meter` 与自定义路径**：`deploy.js` 会自动附带 `--enable-meter` 写入持久化配置；若目标机器客户端装在非默认路径，追加 `--path "<app.asar 路径>"`。
> - **严禁在对话内强杀宿主进程**：若 Windows 下因运行中锁定导致 `ASAR_LOCKED`，或 `deploy.js` 输出 `restartRequired: true`（涉及主进程 `meter-main.js`、同步模块或预加载钩子更新），必须提示用户**手动完全退出所有 Antigravity 窗口（含托盘退出）并重开**，不可把 `node cli.js live` 前端热挂载当作完整升级验收。

---

## 🚀 快速开始 (Quick Start)

### 方式一：家庭组一键接入（推荐家庭成员使用）

收到管理员私发的 `family-join.json` 后，将其放到仓库或安装包根目录运行（完整服务端搭建与多设备说明见 [`FAMILY_README.md`](FAMILY_README.md)）：

- **Windows**：双击 [`setup-family.bat`](setup-family.bat)（或运行 `node setup-family.js`）
- **macOS / Linux**：运行 `bash setup-family.sh` 或 `node setup-family.js`

### 方式二：跨平台部署与更新（推荐日常使用 `deploy.js`）

```bash
# 首次部署到本机 Antigravity 客户端
node deploy.js

# 拉取本分支最新代码并重新注入（自动保留本地家庭组配置与账本）
node deploy.js --pull
```

### 方式三：传统一键脚本

- **Windows**：安装 / 更新双击 [`install.bat`](install.bat)；卸载 / 还原双击 [`uninstall.bat`](uninstall.bat)
- **macOS / Linux**：安装 / 更新运行 `./install.sh`；卸载 / 还原运行 `./uninstall.sh`

### 方式四：CLI 命令行管理器

```bash
# 1. 环境健康预检（自动探测 Node、Antigravity 安装路径、CDP 端口与 Python）
node cli.js check

# 2. 一键安装（ASAR 持久化注入；支持热加载的运行窗口可即时生效）
node cli.js install

# 3. 仅对支持 CDP 的当前运行窗口进行免改盘热挂载
node cli.js live

# 4. 查看当前安装状态与实时会话上下文用量
node cli.js status

# 5. 一键无损还原安装前的原始 app.asar
node cli.js restore

# 6. 指定自定义客户端路径安装
node cli.js install --path "<path-to-app.asar>"

# 7. 查看 / 应用 / 还原系统增强（提示词档位、中文标题、客户端语言与品牌展示）
node cli.js enhance-status
node cli.js enhance --tier 3 --chinese-title on --brand-title english
node cli.js enhance-restore
```

---

## 🌐 界面语言

- **插件面板三语言**：面板内置 **简体中文**、**繁體中文**、**English** 即时切换与持久保存，覆盖全部页签、图表、家庭组视图、价格账单与系统增强页（`src/renderer/i18n.js`）。
- **客户端语言与授权说明**：桌面端界面语言支持切换 **简体中文**（内置自主整理的 `i18n/zh-CN.json` 与 `i18n/i18n-runtime.js`）或 **英文原版**。因外部繁体词典仓库 `qqxpee/antigravity2-cn` 未声明开源许可证，本版本未内置客户端繁體词典；繁體中文选项仅作用于插件自身面板。

---

## 🧪 自动化测试 (Testing)

```bash
npm test
```

测试覆盖 Token 去重、服务端超限、会话切换、家庭组同步、多账号凭据与切号、部署脚本、代理配置、订阅设置与渲染层状态。附件扫描测试可单独运行 `python -m unittest attachment_scan_test.py`。单测不替代宿主客户端中的安装与界面验证。

---

## 📁 仓库结构 (Repository Structure)

```text
antigravity-family-context-viewer/
├── deploy.js / deploy.test.js              # 跨平台一键部署 / 更新入口（自动启用 --enable-meter）
├── cli.js                                  # 统一命令行接口 (install / live / status / check / restore / enhance*)
├── install.js / restore.js                 # ASAR 注入调度器与原始备份无损还原调度器
├── modular-installer.js                    # 模块化 ASAR 钩子注入器（兼容 v2.34.0 loadHubWindowUrl）
├── local-api.js                            # 主进程引导信息 / daemon/hub_*.json / CDP 鉴权统一探测
├── asar-engine.js                          # 零外部依赖的纯原生 Node.js ASAR 打包/解包引擎
├── meter-main.js                           # Electron 主进程窗口钩子与只读 IPC 通道
├── meter-core.js                           # 上下文估算、额度/计价、Token 统计与图表比例核心引擎
├── meter-collector.js                      # 本地会话归档读取、增量对账与附件提取收集器
├── meter-accounts.js                       # 跨平台账号识别与切换（含 Linux Keyring 读写与回滚）
├── meter-family-sync.js                    # 家庭组本地缓存、去重上报与低请求退避同步模块
├── meter-context-unlock.js                 # 桌面端/CLI 上下文长度模式改写与安全还原引擎
├── meter-enhance.js                        # 系统提示词 0~4 档、防幻觉与中文标题等长替换引擎
├── meter-renderer.js                       # 渲染层构建产物 (v0.8.8)
├── src/renderer/                           # 五面板渲染层源码与三语言 i18n
├── family-server/                          # Cloudflare Workers + D1 / Node.js + SQLite 家庭组后端与网页看板
├── setup-family.js / .bat / .sh            # 家庭组一键接入脚本与说明文档 (FAMILY_README.md)
├── i18n/                                   # 客户端简体中文化词典与运行时 (zh-CN.json / i18n-runtime.js)
├── unlock/                                 # PR #3 跨平台解锁工具与文档 (language-server & agy-cli)
├── scripts/                                # 渲染器构建、清单校验、发布打包与原生窗口辅助源码
├── assets/                                 # 演示动图、高清录屏与实拍截图
├── attachment_scan.py                      # 全格式附件只读分析核心脚本 (Office / PDF / Code)
├── AGENTS.md / FAMILY_README.md            # AI 智能体部署规范 & 家庭组部署接入完整指南
├── install.bat / install.sh                # 传统一键安装入口脚本
└── uninstall.bat / .sh                     # 传统一键卸载与还原入口脚本
```

---

## 🛡️ 安全说明与原生窗口辅助程序 (Security & Transparency)

- **用途说明**：Windows 安装包中的可选组件 `scripts/cli-window-helper.exe`（源码 [scripts/cli-window-helper.cs](scripts/cli-window-helper.cs)）仅用于在从插件弹窗一键启动 `agy` CLI 时定位新控制台窗口、按当前工作区居中并激活前台焦点，不包含任何联网、持久化或后台驻留逻辑。
- **工具链与构建命令**：基于 Windows 自带 `.NET Framework 4.0` 编译，可随时自行审计源码并本地重编：
  ```powershell
  C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /platform:anycpu /optimize+ /out:scripts\cli-window-helper.exe scripts\cli-window-helper.cs
  ```
- **当前随附二进制 SHA-256**：`e6a62cbb03163107db889e6accf7c05049ecf949c89f29afaf072c66fe09eac9`（注：.NET Framework `csc.exe` 默认嵌入 PE 时间戳/MVID，自行本地或由 `.github/workflows/release.yml` 在 `windows-latest` 上从同份源码重编会生成有效功能等价但哈希值不同的二进制；CI 现场编译旨在提升构建来源透明度，但**不代表所有杀软引擎一定会停止触发告警**）。
- **常见安全软件检测说明**：由于该程序是约 15 KB 的未数字签名原生辅助二进制且调用了 `keybd_event`、`AttachThreadInput`、`AllowSetForegroundWindow`、`CreateToolhelp32Snapshot` 与 `Process.Start("cmd.exe")`，部分杀毒引擎可能报启发式可疑告警。
- **无需关闭杀软的可选降级**：如果您不希望保留任何预编译 `.exe` 或其被安全软件拦截，无需关闭安全软件，也无需购买签名证书，可直接删除 `scripts/cli-window-helper.exe`。`meter-cli-launcher.js` 检测到 helper 缺失或失败时会自动降级为直接启动标准 Windows 控制台 `cmd.exe /d /k`，CLI 启动与对话能力完全正常（仅不再自动居中或强制置顶窗口）。

---

## 🤝 致谢与上游署名 (Acknowledgements & Upstream)

- **原项目与原作者**：本项目基于 **[elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)** 二次开发，感谢原作者 **[ELVISCHEN](https://github.com/elviscjn-cjn)** 打造并开源了最初的上下文查看器与核心插件架构。
- **[LINUX DO](https://linux.do/)**：本项目支持并认可 LINUX DO 社区，欢迎各位社区佬友交流探讨。
- **上下文解锁原方案**：感谢 **Linux.do @23375** 公布的上下文长度限制分析与修补思路（<https://linux.do/t/topic/3117832>）。
- **PR #3（多模式上下文解锁 & agy CLI 工具链）**：感谢 **[@anyu0804](https://github.com/anyu0804)** 贡献 `ORIG / CONST / DYN` 模式、实验覆盖门禁分析、`cli_serializer_max_ctx` 对齐及跨平台 `unlock/` 工具与文档。
- **PR #4（系统增强中心与防幻觉提示词）**：感谢 **[@Jia131313](https://github.com/Jia131313)** 贡献系统提示词 `0~4` 档位精简、防幻觉约束、中文会话标题、品牌展示与推荐配置体系。
- **PR #7 / #12（模型剩余配额圆环、双窗口与主题/Opt-in 保护）**：感谢 **[@Azreal2021](https://github.com/Azreal2021)** 与 **[@Andrew-liu](https://github.com/Andrew-liu)**。
- **PR #9（2.31+ 模型计价、共享池匹配与三源账本实时同步）**：感谢 **[@MoiraToki](https://github.com/MoiraToki)**。
- **PR #11（沙箱 Preload 汉化配置门禁安全读取）**：感谢 **[@yinshengphy](https://github.com/yinshengphy)**。
- **PR #13（弹窗动态锚点定位与展开防抖动）**：感谢 **[@nocoo](https://github.com/nocoo)**。
- **PR #14（macOS 兼容适配评估参考）**：感谢 **[@nokiy](https://github.com/nokiy)**。
- **Issue #17（`cli-window-helper` VirusTotal 检测溯源、文档透明度与 Windows CI 源码构建建议）**：感谢 **[@riandycandra](https://github.com/riandycandra)**。
- **PR #21（繁体中文面板译文精细优化）**：感谢 **[@U1tr0n-Lee](https://github.com/U1tr0n-Lee)**。
- **Issue #22（GitHub API 限流时官方 Atom/Web 更新回退方案）**：感谢 **[@zhao33079-zhao](https://github.com/zhao33079-zhao)**。
