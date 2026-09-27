# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构；版本号跟 `package.json`（当前 `0.2.0` —— 本版 agent 活动镜像与会话卡片把插件从 `0.1.0` 提到 `0.2.0`）。
接口契约的版本独立演进，见 `docs/ICD.md`（变更表在其 §10，当前 **v1.0.11**）。

## [Unreleased]

### Changed（性能·安全·CI：本轮五项 + 一项新配置键）
> 本节含 **3 项 breaking**（标 ⚠️）。每条给出迁移方式。验收：`node scripts/verify-all.mjs` 10/10 层绿（unit 616 / client 259 / integration 46）。

#### Performance
- **帧回放日志的淘汰由 O(n) 降为 O(1)**（`src/exec/frames.ts`）：原 `trim()` 在**每个 data 帧**上做 4 次全表扫描（`countData`/`findIndex`/`find`）+ `splice`，2 字节帧稳态下实测 **3536 µs/帧**且**同步执行 ⇒ 打满 host 单核并阻塞共享事件循环**（可用性问题，非吞吐）。现依据"被淘汰集恒为**连续前缀**"这一不变量（`entries` 只 push、`open` 恒在 index 0、淘汰恒取最旧数据帧）用 `deadEnd` 游标单调推进，**淘汰循环体内零扫描**，另有摊销压缩（阈值 `evicted ≥ max(256, live/4)`）。实测：**0.19–0.36 µs/帧且不随窗口增长**（旧实现 38→306 µs，**105–1633×**）；回放日志堆占用 **0.94 MiB**（旧 17.8 MiB）。与**修复前的构建快照**做了 12 组差分（帧流 / `retained()` / `replay(k)` / `gap` / 计数器全部 deepEqual），证明语义未变。
- **新增 `maxReplayFrames`（默认 8192，`0` = 不限）**：给回放日志加**帧数**预算，与既有字节预算同时生效、先到者淘汰。对 **≥32 字节的帧行为完全不变**（`262144 / 8192 = 32`，字节预算必定先生效，已实测），只有 <32 字节帧的流（交互式回显、进度点）回放窗口变小 —— 这正是内存放大的来源，且丢帧已由 `replayDropped` 与 `gap` 如实上报。**迁移**：设 `maxReplayFrames: 0` 即恢复旧行为（无限帧数）。

#### Security
- ⚠️ **已固定的主机若呈递另一种密钥算法，现在判为"密钥变更"并拒绝**（`src/known-hosts.ts`）：原先 `keyType` 不一致会被当成**新主机**，在默认 `accept-new` 下**静默写入** known_hosts（可被跨算法换钥绕过）。**迁移**：先在带外核对指纹；若确属换钥，删除该主机条目后重连（`ssh-keygen -R <host> -f <hostKey.knownHostsFile>`，默认 `<DSH_HOME>/known_hosts`）。
- ⚠️ **`@revoked` 现在对整台主机生效，且是硬拒绝**：任一算法的 `@revoked` 行会让该主机的**所有算法**被拒；拒绝**不进入用户提问路径**（无"仅本会话接受"出口）、不写 known_hosts，并以 `SSH_HOSTKEY_MISMATCH` + `details.reason='@revoked'` 进审计。**有意例外**：`policy: insecure` 按定义不咨询 known_hosts（`src/connection/transport.ts:155-158`、`src/known-hosts.ts:341-346`），故 insecure 下不适用 revoked —— 该边界已由 `test/integration/openssh-interop.test.mjs` 用**正向断言**钉住（同一主机同一密钥，strict/accept-new 拒绝、insecure 放行，三档两种结果，防止未来被误判为回归）。**迁移**：吊销即"此主机不再可信"，恢复需删除该 `@revoked` 行（产品内仍无删除接口，见下方 Known issues）。

#### Security
- ⚠️ **P0：传输引擎不再是"任意本地写原语"**（F-SEC-05）。原先 `localPath` 完全由调用方（模型/浏览器）给出且**没有任何约束**，引擎直接 `node:fs` 落盘，于是 `ssh_download` 可以：截断任意已存在的本地文件、或在 `resume`（默认 true）下向**任意更小的无关文件追加远端内容**——包括插件自己的信任锚与证据链（`<DSH_HOME>/known_hosts`、`logs/dsh-ssh/audit.jsonl`、`dsh-ssh/profiles.json`）。而 `cordis.patch.yml` 承诺的 `confirmDangerous`（"Destructive operations (delete/overwrite/close-live-session) ask first"）在 `src/` 内**一次都没被读取**。本版两处收紧：
  1. **信任锚与状态文件永不触碰**（无论方向）：引擎在 `run()` 入口、任何文件系统操作之前，把 `localPath` 规范化（`realpath` 解析符号链接/junction，Windows 下折叠大小写）后与受保护清单比对，命中即 `SSH_CFG_INVALID` + `details.reason='protected-path'`。**两个方向都拦**：下载到锚点上是破坏它，上传锚点则是把它外泄。清单来自既有配置（`hostKey.knownHostsFile`、`profilesFile`、`auditFile`），**不需要新配置键**。
  2. **隐式追加/替换需要显式授权**：`confirmDangerous` 现在真的被读取。默认 true 时，`resume` 只对"新文件"或"**显式** `overwrite: true`"生效；否则走 ICD §4.5 的冲突流程抛 `SSH_SFTP_TARGET_EXISTS`（`resumable: true`），由调用方确认后重发。原因是尺寸无法区分"断点续传的半个文件"与"恰好更小的无关文件"——把后者当断点续传会**静默损坏它**。**迁移**：①若你在自动化里依赖隐式续传，显式传 `overwrite: true`（推荐，语义清晰），或设 `confirmDangerous: false` 恢复旧行为（文档化的逃生口）；②若下载报 `SSH_CFG_INVALID` 且 `reason='protected-path'`，说明目标就是插件自己的信任锚/审计文件——改到别处，**不要**试图绕过。
  - **未采用**（如实记录）：计划里曾提出 `sftp.localRoot` + 允许越界的开关（把下载限制在某个根目录内）与"工具返回 `refused` + `confirmToken` 由 UI 二次确认"的协议。本轮**只做了**上面的"信任锚清单 + 显式授权闸"，因为前者需要新增两个配置键（含默认值语义抉择），后者要动 `ApiDeps`/RPC/客户端 UI 与 ICD §4.5 的确认协议；两者都属"策略增强"，不是本条漏洞的可利用面。仍在计划中（`optimization-report.md` 的 Top 3 谨慎改动 #1）。
  - **残留风险（已文档化）**：指向"尚不存在的受保护文件"的符号链接/junction 在解析时会失败并回落到未解析路径，因而比不中（该窗口只持续到锚点文件首次创建为止，且创建此类链接在 Windows 上本身就需要特权）。真正的边界仍应由宿主沙箱承担。
#### Fixed
- **侧栏底色 token 拼写错误**（`client/src/theme.css:88`）：`--dsw-alias-specific-sidebar-fill` 在平台侧**从未注册**（真名 `--dsw-specific-sidebar-fill`，见 `packages/client/ui-theme/src/client/index.ts:145`、`design-platform.css:267,377`），故该处**永远走 fallback**、与平台侧栏有色差。**该缺陷长期存活的机制值得记录**：`client/src/chrome/theme.js` 的 `TOKENS` 白名单**抄了同一个错名**，`scripts/shot-files.mjs` 的截图 fixture 又给错名**伪造了色值** ⇒ 三重自洽使"引用 token 必须已知"（`chrome.test.mjs`）与视觉回归**同时自证正确**。三处已一并修正，`client/src/chrome/theme.gen.js` 镜像已重生成（`--check` 由 `stale` 转 `up to date`），并新增 `test/client/theme.test.mjs` 断言不再出现错名。
- **`examples/config/default.yml` 的 `tools` 只有 5/7 且顺序不同**：照抄该示例会**静默丢掉 `ssh_connect`/`ssh_disconnect`**（模型无法建立连接），而该文件自称"全量默认值镜像…由测试断言"却**无任何测试读它**。现补齐为与 schema **7 项同序**、补上整段缺失的 `activity.*` 4 键，并新增 `test/unit/examples-config.test.mjs` 做**递归全量对照**（含"schema 每个默认值都出现且不存在多余项"），另以变异测试确认该断言非空跑。

#### CI / Tests
- ⚠️ **CI 依赖此前从未被锁定**：仓库只有 `pnpm-lock.yaml`、没有 `package-lock.json`，因此 `npm ci` **必然失败**，随后被 `|| npm install` **静默兜底** —— 兜底本身就是该缺陷长期不可见的原因。现改用仓库既有的 pnpm 链路：`pnpm/action-setup@v6` + `pnpm install --frozen-lockfile`（**兜底已删除**，失败可见）+ `cache: pnpm`，其余步骤改 `pnpm run`。pnpm 版本 **pin 10.34.5**：`pnpm@11.x` 的 `engines.node` 为 `>=22.13`，会让 CI 矩阵里的 **Node 20 leg 直接装不上**。
- **唯一的外部真值源不再在 CI 上"静默跳过却报绿"**：`test/integration/openssh-interop.test.mjs` 原先硬编码 Windows `ssh-keygen` 路径，Linux CI 上 `existsSync` 恒为 false ⇒ 整文件 skip 且 `node --test` exit 0。现改为**跨平台候选探测**（仅在 `ENOENT` 时判"不存在"，其余失败都证明二进制跑起来了；含 `DSH_SSH_SSH_KEYGEN` 逃生口），并新增 CI 步骤断言该层**确实执行**（本机实测 5/5、skipped 0）。
- **"整层全 skip"不再记为 PASS**：`scripts/verify-all.mjs` 现解析每层 `ℹ tests/pass/skipped`，当 `pass === 0 && skipped > 0` 时判为 **skipped 并计入失败**，汇总单列 `zero-execution layers (a green exit code here would have been a lie)`，头部打印 `npm test` 未覆盖的层（integration/e2e/perf）。新增 `test/unit/verify-all-reporting.test.mjs`（16 例，含"部分 skip 仍是 PASS"的对照）。

### Verified（2026-09-27 最终：十条验收全部通过，含 UI 实测）
- 用户完成全部十条验收走查：**文件页签**「进目录：切换过去了，也可以回到上一层」「上传：可以发出，传输条出现进度」「也能下载」——console 证据 `files: navigate`、`rpc stream sshPlugin/upload` → `upload open`、`rpc stream sshPlugin/download {remotePath, localPath}` → `download open { hostStreamId: "st_01M3G4FSGFZD0XA96C9993KCAF" }`，6938 B 落地 `C:\Users\<user>\.dsh\cordis.patch.yml.bak-preset-standard-20260925-222753`；GUI 内 `top` 与多会话/亮暗主题为用户走查确认。
- **证据边界**：100 MiB 级传输闭环于引擎/工具层（真机 100.0 MiB 实测）；UI 侧为小文件实测，不宣称“UI 端完成 100 MiB 传输”。已知缺口清单（`serverBanner`、`@revoked`/问题级 `policy`、lint warnings 等）**保持有效，不因全通过而删除**。
### Verified（2026-09-27：UI 全链路在真机实测打通）
- **UI 端到端可用（真实浏览器 + 真机 `203.0.113.10`）**：客户端 console 首行 marker `ssh-client-2026-09-26.4-console-clean`（新产物已生效）；`rpc stream sshPlugin/openShell` 打开（host `streamId st_01M3FYPPRYYBS78D70ZXNPKDKR`），逐键 `shellWrite {"data":"l"/"s"/" "/"-"/"a"/"\r"}` **全部 `ok`**；终端**有提示符且 `ls -a` 有真实输出**；console 无 `Cannot read properties of undefined (reading 'dimensions')` 未捕获错误、无 `has no channel yet` 告警。host `plugin.jsonl`：`22:52:18 connected to root@203.0.113.10:22 in 712ms (auth=password(••••••••), hostKey=accept-new)`、`22:52:18 session s_01M3FYPP1NHDKF36ZGPNZASCYH ready`；`audit.jsonl`：`connect ok (durationMs 722)`、`setSecret ok`。原文摘要与复现方法见 `docs/ACCEPTANCE.md` §11。
- 状态变化：**终端流式（上下行）**、**进度/日志流所用的同一流式通道**、**会话视图布局** 三项由"待走查"升级为"已实测覆盖"；**仍待用户走查**：GUI 内 `top` 全屏、文件 UI 上传/下载进度观感、多会话标签 + 亮/暗主题切换（**未记为通过**）。

### Platform limitation（如实记录，非插件缺陷）
- 当前桌面端组合**无凭据服务**：`setSecret ok` 的结果是 `"persisted": false, "reason": "no credentials service in this composition"`，凭据仅登记为**会话期内存**，因此**每次重启 DSH 后需要重新输入密码**。插件已按 ICD §6 实现降级路径（记录原因、UI 显示来源），组合一旦提供 `ctx.credentials` 即自动持久化，无需改代码。

### Added（agent 活动镜像：终端标签的第二面，ICD §4.7）（2026-09-27）
- **新增 agent 活动镜像**（`src/activity/feed.ts`，`ActivityFeed`）：一个有界的**内存环**记录模型经 `ssh_*` 工具做过什么 —— 命令（含**实时** stdout/stderr 帧）、上传/下载（含进度行）、列目录、连接/断开/列会话。三条预算全部来自 `config.activity`（`maxRecords` 200 / `maxRecordBytes` 65536 / `maxTotalBytes` 1048576）：环满时先淘汰**最老的已结束**记录，**运行中的记录永不淘汰**；文本按 UTF-8 字节计费，截断只落在**字符边界**（不把 U+FFFD 画进用户画面）。镜像对任何输入都不抛（观察者失败绝不能把被观察的 SSH 调用带下去），每个事件都是深拷贝，`chunk` 只携带**真正留在环里**的文本 —— 因此客户端按 delta 打补丁的结果与 host 的 `snapshot()` **逐字节一致**。
- **新增 §4.7 两个端点**（`src/api/activity-api.ts` + `src/service.ts`）：`sshPlugin/followActivity`（**流，无参数** —— 镜像是全局的，每条记录自带 `sessionId`/`target`；加 `sessionId` 过滤会把 agent 在别的主机上的工作**静默藏起来**，过滤属于视图决定。首帧为 `activity-snapshot`，**替换**客户端已有列表，重连不产生重复记录）与 `sshPlugin/clearActivity`（**一元**，`{}` → `{ cleared }`，清**全局**历史）。三种帧：`activity-snapshot` / `activity`（`begin`|`end` 整条、`chunk` 增量）/ `activity-reset`（**只在真的丢掉了记录时**发 —— 一次没丢东西的 `clearActivity` 不发，否则会连带抹掉客户端正在画的运行中记录）。
- **「终端」标签的第二面**（`client/src/session/activity.js` + `client/src/panel.js`）：`AgentActivitySwitch` + `AgentActivityPane` 渲染镜像，遵循三条跟随规则 —— ①有活动的会话**直接开在活动面**（初值读 store，不是等第一帧，避免先闪一个空白终端）；②新活动**自动切过去**，除非用户**正在终端里打字**（`document.activeElement.closest('.ssh-ws-term')`）或**自己选过面**（显式选择不再被自动覆盖）；③自动切换只看**本会话**（`summary.total`/`running` 按 `sessionId` 过滤），别的主机上的工作只点亮全局未读徽标。列表只画最新 200 条（store 保留 400）；上滚即停止跟随并出现"跳到最新"；`清除` **先清本地**、再**尽力** `clearActivity`。镜像**只渲染、不驱动**：不发起任何 `exec`、按键或传输。
- **文档**：`docs/ICD.md` 新增 **§4.7**（端点、三种帧与调度不变式、`ActivityKind`/`ActivityStatus`/`ActivityChannel`/`ActivityChunk`/`ActivityView`、与审计的关系）、§6 补 `activity.*`、§12 新增 **R10**（镜像是**有界视图**而非 durable 日志 —— 审计文件才是），版本表升至 **v1.0.11**；`docs/DESIGN.md` 新增 D11 + §5.1 对象图（谁写：工具；谁读：面板）+ §5.2 两面与跟随规则；`README.md` 补 §2 配置行、§3 UI 两面说明与 §4.1 小节。

### Added（会话里的 `ssh_exec` 终端卡片）（2026-09-27）
- **工具调用在会话里渲染成终端卡片**（`client/src/session/toolview.js` + `client/src/plugin.js`）：DSH Web 客户端**不消费** host 的 `presentCall`/`presentResult` 卡片视图 —— 它按 **wire 工具名**分派键控槽位 `tool.call.toolview`，没注册就落回通用行，因此 host 早已算好的 `card:'terminal'`（`title`/`output`/`exitCode`/`signal`）在会话里一直被丢掉：`ssh_exec` 只显示 `Tool call · ssh_exec · <第一个字符串参数>` 加一段 Input/Output。本版在插件自己的 client 半边注册 `key: 'ssh_exec'`，渲染 `$ <命令>`、按 host 的 `[stderr]` 标记分节的输出（带标签与 `aria-label`，不只靠颜色）、**仅在 `exitCode` 是数字时**给出退出码徽标（被信号终止时改显示信号）、状态/结局徽标，以及一句事实行（outcome / 耗时 / streamId / sessionId / cwd / label）。`meta` 缺失或形状怪异时退回到 `block.content`，**永不返回 `null`**（键控命中会替换通用行，返回 `null` 就是一行空白）。

### Fixed（agent 活动镜像同期）
- **活动面在"载体同步失败"之后再也不会重订阅**（`client/src/session/activity.js`，**由独立验证者发现**）：`ensureConnected()` 在 `bridge.stream()` **返回之后**才保存 handle，而同步失败会在 `stream()` 内部就送出终止 `end` 帧（`client/src/bridge.js` 同时填好 `state.error`）——那具死 handle 被缓存后（`if (handle) return handle`），本 bundle 生命周期内**任何重挂载都不会再订阅**，只能刷新页面；host 半边缺 §4.7（**正是本机当前状态**）或载体同步抛错时就会命中。现拒绝缓存 `state.error` 已置位的 handle，并且**只警告一次、且点名原因**（原先只打一句通用 `ended`，把"host 版本旧"伪装成"流断了"）。
- **`ssh_sessions` 的输出 schema 曾把成功调用报成"工具返回非法输出"**（`src/tools/sessions.ts`）：`sessions` 的 item 曾经是空的 `objectNode({})`，而 `objectNode` 默认 `additionalProperties: false` —— 即一个**封闭的空对象**，于是 Host 校验真实值时每个字段都被判为未声明属性（代码注释记录了实测报错 `"value.sessions[0].sessionId" is not a declared property`），模型看到的是"工具返回了非法输出"，而这次调用**其实成功了**。现按真实投影**逐字段声明** item（`sessionId`/`label`/`host`/`port`/`user`/`state`/`since`/`connectedForMs`/`rttMs`/`bytesIn`/`bytesOut`/`capabilities`），其中只有 `rttMs` 可选（连接尚未测出 RTT 时投影不携带它）。

### Added（task-11 OpenSSH 真值对拍 + 真机层）
- `test/integration/openssh-interop.test.mjs`（A 层，离线、CI 安全、默认执行）：用真 `ssh-keygen` 作为**实现之外的真值** —— 三把真密钥（ed25519/rsa/ecdsa）的指纹与 `ssh-keygen -lf` **逐字节一致**；我们写出的 known_hosts 行可被 `ssh-keygen -F` 找到；`|1|salt|hmac` 哈希条目**双向**可读且不泄漏主机名；通配/取反/`@cert-authority`/`@revoked` 解析保留；策略矩阵（strict 拒未知、accept-new+remember→`exact`、同类型换钥→`MISMATCH`/`changed`、**不同类型换钥→`MISMATCH`/`changed`**（F-SEC-04 之后；此前为 `unknown`）、insecure 放行、**`@revoked` 跨算法硬拒绝且不进入提问路径**（RT-A-3））；解析后再发回的 blob 经 OpenSSH 指纹仍一致（零字节丢失）。`ssh-keygen` 的探测已跨平台（Windows 候选路径 + POSIX PATH 与常见前缀，仅在 `ENOENT` 时判缺失），且 CI 新增步骤断言该层**必须真执行** —— 整层 skip 不再等于绿灯。
- `test/integration/real-target.test.mjs`（B 层，`DSH_SSH_TEST_REAL_*` gating）：**已对真机 `203.0.113.10` 实跑通过**主机密钥序列（三把真密钥 accept-new → `remember` → strict `exact` → 同类型换钥 → `SSH_HOSTKEY_MISMATCH`）；另有真机 `exec uname -a` + `/tmp/dsh-ssh-test/**` 内的 SFTP 往返与清理断言。凭据缺失时 skip 并给出理由；`ssh-keyscan` 无法协商（本地 OpenSSH 缺 `sntrup761x25519`）时自动回退到我们自己的 ssh2 栈捕获主机密钥。
- `scripts/verify-all.mjs`：集成层改为**按文件名枚举并显式排除** `real-target.test.mjs`，真机层只在 `--real` 下运行。

### Known issues（对拍发现，已派单）
- ~~`@revoked` 条目在 `verify()` 中不生效~~ —— **已修复**（见上方 Changed § Security：跨算法生效 + 硬拒绝 + 进审计；`insecure` 为有意例外）。**遗留**：产品内**没有**删除/重置 known_hosts 条目的接口（RPC / 工具 / UI 全缺），因此吊销收紧后"恢复某主机"只能手工改文件（`ssh-keygen -R <host> -f <hostKey.knownHostsFile>`）；**建议与本次同批发布该接口**，否则用户会被逼向 `insecure`。
- 问题级 `policy` 覆盖未生效（仍未修复）。以上（含已修复项的回归护栏）在 `DSH_SSH_STRICT_ICD=1` 下转为硬失败，详见 `docs/TESTING.md` §4.1。

### Added（T8 测试基建、文档与 Demo）
- `test/support/sshd.mjs`：基于 `ssh2` **Server API** 的真协议 sshd 靶机（真实 TCP/密钥交换/加密/通道/SFTP 子系统），支持密码 + 公钥（含加密私钥 + passphrase）认证、`exec`（stdout/stderr/退出码/env/cwd/stdin/信号）、PTY `shell`（行编辑/历史/补全/`window-change`/全屏 `top`）、完整 SFTP 操作（含任意 offset 读写与分批 `READDIR`）、故障注入（`dropAll`/`freeze`/`setAllowedMethods`/`denyPath`）与统计时间线。自测 13/13。
- `test/support/minish.mjs`：进程内 POSIX 风格解释器（管道/`;`/`&&`/`||`/重定向/引号/变量/通配/`VAR=value cmd` 前缀）+ 交互式 shell（方向键、Ctrl 组合、历史、Tab 补全、假全屏应用 `top`、ONLCR 换行语义）。
- `test/support/fixtures.mjs` / `host.mjs` / `frames.mjs`：可复现负载、虚拟路径沙箱、ICD §7 门面夹具（连接池/执行/SFTP）、§3 帧不变式校验器。
- `test/integration/sshd-double.test.mjs`：靶机自测（认证三态、exec、PTY、signal、SFTP 全操作、denyPath、freeze→keepalive 超时、dropAll→ECONNRESET）。
- `test/integration/stack.test.mjs`：**对靶机驱动真实 host 模块**的集成层（连接/认证/host-key 三档/exec/PTY/SFTP/10 会话并发/池上限/断链）。
- `test/integration/icd-conformance.test.mjs`：契约门 —— §0 包与入口、§0.3 bundle 封套、§3 帧判别式与不变式（真流）、§4 方法表存在性（未接线时带理由 skip，`DSH_SSH_STRICT_ICD=1` 转硬失败）、§5 全 32 错误码 + `retryable` 与文档一致、§6 patch 默认值、§8.5 双语 i18n 键集合。
- `test/e2e/run.mjs`：9 步无头验收走查（新建连接→连接→PTY `uname -a`+`top`→exec 帧不变式→2 MiB 上传→下载校验→10 会话并发→断开→日志无凭据）。
- `test/perf/perf.test.mjs`：100 MiB 上传/下载字节一致 + 吞吐下限、10 会话并发各自哈希匹配、大流式 exec 完整性；规模与下限可环境变量降级。
- `scripts/verify-all.mjs`：一键验证（typecheck→lint→build→bundle:check→unit→client→integration→e2e→perf→real/coverage 可选），**每层硬超时 + kill 进程树 + 输出尾部**，EPERM 时退化 `stdio:'inherit'` 重跑；启动前**并发自检**并清理注入的 `NODE_OPTIONS` 等变量（ICD §12 R9）。
- `scripts/lint.mjs` + `eslint.config.js`：优先真 eslint（flat config，排除 vendor；errors=正确性/warnings=风格），未安装时退回等价的内建结构检查（`@module`/`@order` 头、client 禁 ESM 语法、第一方禁硬编码色值、禁止 `.only`、skip 必须带理由、全局 U+FFFD 编码门）。
- `README.md`（安装/配置/UI/Agent 工具/FAQ/开发/截图）、`docs/TESTING.md`（分层命令、单一 tsc 工程纪律、并发纪律、真机 gating、性能参数与实测、覆盖矩阵）、`docs/DEMO.md`（自动化 + GUI 逐步走查）、`CHANGELOG.md`、`.gitignore`。

### Fixed（T8 期间发现并修复）
- 靶机：`ssh2` 1.17 三处坑的规避（`generateKeyPairSync('ed25519')` 约 2% 产出畸形公钥 → 校验并重生成；`Server` 的 `'connection'` 事件载荷是 Client 而非 socket → 自持 TCP 服务器 + `injectSocket()`；公钥验签第三参应为 `ctx.hashAlgo`）。
- 靶机：解译器补齐 `VAR=value cmd` 前缀赋值与 `cd -- <path>`（真实实现发送的命令形态）；未知变量在第一次展开时保留字面量，交由按命令环境二次展开。
- 靶机：`chmod`/模式位虚拟化（Windows 只支持只读位），使 `0644/0600/0755` 在 `stat`/`ls -l` 中可精确回读。
- 靶机：信号终止改为发送 `exit-signal`（客户端看到 `code:null, signal:'TERM'`），与 OpenSSH 一致。

### Known issues
- 第一方 4 处硬编码 `rgba()`（`client/src/core.js:91`、`client/src/chrome/theme.gen.js:308/392/507`）违反 ICD §8.6，已派单 sp5/sp7；`verify-all` 的 lint 层会红。
- `src/service.ts` 仍是 M0 切片（`ping`/`probeStream`/`describe`/`reportSpike`），§4 的 39 个端点在 `src/api/**` 接线完成前，契约门以带理由的 skip 报告。
- `SftpHandle` 门面在 `listDir`/`createWriteStream` 失败路径上泄漏 ssh2 原始数字状态码（`2`）而非 ICD §5 字符串码；已记录并在集成层以 `DSH_SSH_STRICT_INTEGRATION=1` 作为硬门待闭合。
- `eslint-plugin-react-hooks` 未安装：`exhaustive-deps` 在 flat config 中为显式 no-op（hooks 依赖不做静态检查），见 `docs/TESTING.md` §2.4。
