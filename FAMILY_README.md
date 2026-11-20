# Antigravity 家庭组用量

家庭组插件按成员汇总多台设备的 Antigravity 用量，并在独立网页和桌面「家庭组」页签展示。每个成员可以接入自己的 Windows、macOS 或 Linux 设备。服务端可运行在 Cloudflare Workers + D1，也可使用 Node.js 和本地 SQLite。

## 哪台电脑需要在线

服务端和成员设备分别运行。你们可以按看板需要开放的时间选择部署方式。

| 部署位置 | 你的电脑关机后 |
| --- | --- |
| Cloudflare Workers + D1 | 部署一次后，由 Cloudflare 托管。网页看板和其他成员的上报仍可使用。 |
| 你的电脑上运行 Node 服务 | 服务随你的电脑关机、休眠或 Node 进程退出而暂停。 |
| 另一台常开的电脑或服务器运行 Node | 只需那台机器和 Node 服务在线。你的电脑可以关机。 |

正常安装后，桌面插件随各自的 Antigravity 运行。每位成员在自己的设备上完成账号分类并开启自动上报后，该设备会在联网时同步自己的用量。关机、休眠或断网会暂停该设备的上报。恢复联网并运行 Antigravity 后，符合账号规则的本地记录会补传。网页看板可以随时关闭。

收到 `family-release.zip` 后，先解压外层，再解压与你的操作系统和 CPU 架构相符的安装包。下面的部署和安装命令在该安装包的解压目录执行。

## 统计口径

- **家庭统计**汇总各设备上明确加入家庭统计的账号。总 Token 沿用上游账本口径，计算输入、缓存读取和输出。思考 Token 单独展示。
- **API 参考费用**用上游的公开 API 费率计算。缺少费率的调用仍计入 Token 和调用次数。按费用计算的占比覆盖有费率的调用。
- **账号额度快照**展示同一账号最近上报的模型组余额、窗口与重置时间。多个账号分别显示。Google 的家庭 AI credits 可在 [Google One AI 用量活动](https://one.google.com/ai/credits) 查看。
- **独立统计**只收录成员主动选择上传的独立账号，并对持有家庭组密钥的成员可见。家庭统计的合计与占比只使用家庭统计范围内的记录。
- 「今日」「近 7 天」「本月」按看板所在设备提供的 UTC 偏移计算。「近 5 小时」为滚动窗口。

## 在本机启动

需要 Node.js 22.4 或更高版本。以下命令在仓库或安装包根目录执行。生成的密钥显示在本机终端，供首次打开看板及连接插件使用。

```sh
export FAMILY_SECRET="$(node -p "require('node:crypto').randomBytes(32).toString('hex')")"
printf '%s\n' "$FAMILY_SECRET"
node family-server/node-server.mjs
```

打开 [本机看板](http://127.0.0.1:8787)。要重启并保留接入配置，请为同一个服务继续使用同一密钥。数据默认保存在当前目录的 `family-data.sqlite`，可通过 `FAMILY_DATABASE` 指定。默认绑定 `127.0.0.1`，端口可通过 `PORT` 指定。跨网络自托管时通过 HTTPS 反向代理访问，仅代理进程需要能连接 Node 服务。

## 部署到 Cloudflare Workers + D1

用具有 Workers 和 D1 权限的 Cloudflare 账号执行。创建完成后，把输出的 `database_id` 写入同目录的 `wrangler.toml`。

```sh
cd family-server
npx wrangler login
npx wrangler d1 create antigravity-family-meter
```

初始化远程数据库，上传生成的随机密钥，并部署 Worker。

```sh
npx wrangler d1 execute antigravity-family-meter --remote --file schema.sql
npx wrangler secret put FAMILY_SECRET
npx wrangler deploy
```

设置 `FAMILY_SECRET` 时使用无空格的 24 至 512 个 ASCII 字符。部署完成后，打开 Wrangler 给出的 HTTPS 地址，输入密钥登录。共享密钥授予看板读取与成员、设备管理权限，加入配置仅发给家庭成员。

## 浏览器看板与自动上报

只看网页用量的成员通过浏览器打开看板。需要自动上报的设备才安装插件。

在 Worker 的 `[vars]` 下设 `FAMILY_PUBLIC_READ = "1"`，或在 Node 启动前设置同名环境变量为 `1`，即可让访客直接打开首页。公开页展示成员显示名、共享用量汇总和去掉账号标识的额度快照。任何能打开链接的人都可查看这些统计。点击「管理登录」后才可查看设备详情、私人统计与成员管理。设备注册和上报始终使用家庭组密钥。

## 一键安装并开启上报

每台要上报的电脑执行一次。请先安装 Node.js 22.4 或更高版本，并打开 Antigravity 登录要上报的账号。

1. 解压适合本机系统和架构的 ZIP。把管理员私发的 `family-join.json` 放到解压目录，也就是 `setup-family.js` 所在的目录。
2. Windows 双击 `setup-family.bat`。macOS 或 Linux 在解压目录运行 `bash setup-family.sh`。三个系统都可以在该目录运行 `node setup-family.js`。
3. 输入你的成员显示名。同一人的多台设备输入同一个名字。接着从列表选一个要上报的 Antigravity 账号。
4. 脚本会安装插件、注册设备并开启自动同步。如果当前窗口还没出现「家庭组」页签，重启一次 Antigravity。发起一条新请求后，就能在网页看板里看到新增用量。

加入配置放在其他目录时，用 `node setup-family.js --join "<加入配置路径>"`。Antigravity 安装在自定义位置时，可追加 `--path "<app.asar 路径>"`。其他未分类账号会留在本机。你可以在「家庭组」页签调整各账号的上报规则。

## 手动接入或调整设备

1. 在每台电脑解压对应系统和架构的安装包，并准备 Node.js 22.4 或更高版本。在解压目录运行 `node cli.js install`。若使用自定义客户端路径，追加 `--path "<实际 app.asar 路径>"`。运行 `node cli.js status` 检查磁盘安装和运行窗口的加载状态。
2. 家庭管理者从网页看板复制「加入配置」。成员打开 Antigravity 插件的「家庭组」页签，粘贴到「加入配置 JSON」，点「导入并连接」。
3. 选择或添加自己的成员名，再给本机设置设备名。同一人接入多台设备时选择同一个成员。保存连接。
4. 在「本机账号规则」逐个确认账号。选择「家庭统计」后，该账号的记录与确认来源的额度可以上报。「私人 · 仅本机」保留本地记录。「独立统计」会把记录单独显示给家庭成员。待分类、归属未知或缺少可靠时间的记录留在本机。
5. 勾选「启用自动上报」并保存。账本变更后约 2 秒触发一次同步，另有约 30 秒的保底检查。首次接入从保存连接时开始统计，历史数据可显式补传近 7 天、近 30 天或全部本地账本。

重复上报按设备 ID 和本地调用 ID 生成的稳定摘要去重。账号模式变更在下一次同步时生效。改为仅本机后，可点击「立即同步」撤回本设备之前上报的记录，也可等启用的自动同步处理。用量上报只包含统计字段与用户填写的别名。邮箱原文、认证凭据、对话与文件路径保留在本机。

切换服务器会重新要求本机账号分类。原服务器已接收的数据由原服务器保存。同一份修改版插件应从这个开发分支更新，使用原版的在线更新会替换本插件。

## AI 智能体跨系统部署与版本更新

如果你希望让 Windows、macOS 或 Linux 上的 AI 助手帮你**首次部署**或**同步升级本家庭分支版本**，请直接指示它阅读 [`AGENTS.md`](AGENTS.md) 并运行统一入口 [`deploy.js`](deploy.js)：

```sh
# 首次部署（保留后续家庭接入配置能力）
node deploy.js

# 日常版本更新（自动拉取 git 更新、注入最新插件并保留本机 family_sync_config.json 与账本）
node deploy.js --pull
```

> 更新只会替换客户端插件包体并自动附带 `--enable-meter`，不会覆盖本机状态目录下的 `family_sync_config.json`、`family_sync_state.json` 或 `pricing_ledger_v1.json`。切勿使用客户端菜单里的原版在线更新替换本分支。

## 本地验证

在源码仓库根目录运行测试。

```sh
node --test family-server/family-server.test.mjs meter-family-sync.test.js
npm test
```

测试使用临时账本、模拟账号与本地 SQLite。Windows、macOS、Linux 的安装包和测试覆盖分开核对，实际宿主的加载状态由 `node cli.js status` 验证。
