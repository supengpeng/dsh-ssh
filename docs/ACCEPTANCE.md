# SSH 插件验收报告（对照用户十条验收标准）

> 生成时间：M5 阶段。**每条都给出「证据 + 复现命令 + 实测结果」**，未通过或未验证的条目**明确标注**，不掩饰。
> 机器：Windows 11 · Node v24.21.0（`C:\Users\<user>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node`）
> 目标机：**Ubuntu 24.04.5 LTS**（kernel 6.8.0-48，x86_64，8 vCPU / 7.9 GB / 25 GB 可用）见 [REAL-TARGET.md](REAL-TARGET.md)

## 0. 总体状态

| 门 | 命令 | 实测 |
|---|---|---|
| 类型检查 | `tsc -p tsconfig.json --noEmit` | **0 错** |
| 单元测试 | `node --test --test-concurrency=1 "test/unit/*.test.mjs"` | **522 项 / 519 通过 / 0 失败 / 3 skip**（47.8 s） |
| 客户端测试 | `node --test --test-concurrency=1 "test/client/*.test.mjs"` | **143 / 143 通过** |
| 集成测试 | `node --test --test-concurrency=1 "test/integration/*.test.mjs"` | **40 项 / 37 通过 / 0 失败 / 3 skip** |
| 端到端走查 | `node test/e2e/run.mjs` | **9/9 步通过** |
| Lint | `node scripts/lint.mjs` | **0 errors**（16 warnings，按"errors=正确性 / warnings=风格"口径不挡验收） |
| 真机集成 | `npm run test:real`（需 `DSH_SSH_TEST_REAL_*`） | 见标准 2/3/4 |
| ICD 一致性 | `node --test --test-concurrency=1 --test-force-exit --test-timeout=60000 test/integration/icd-conformance.test.mjs` | **7 pass / 1 skip / 0 fail**：**§4 方法表 41/41 存在**、§5 全 32 码、§3 帧不变式、§8.5 双语 **143** 键（2026-09-27 更新，见 §12；本表其余行的全仓数字是更早一次全量运行的快照） |

> 3 个 skip 均**带明确理由**（真机未配置凭据 ×2、§4.2 投影需要活实例 ×1），不是静默跳过。并发纪律见 ICD §12 R9：**同一时刻只允许一份全仓测试**；全仓必须 `--test-force-exit`（实测套件 33.7 s 跑完，此前的"挂住"是多份并发测试互相拖死，不是代码缺陷）。

## 1. 侧边栏展开/折叠 + 亮/暗主题

| 项 | 证据 |
|---|---|
| 右侧栏标签页 | `sidebar.right.pane.tab#ssh` 注册成功（M0 实测：与 8 个 shipped 标签并存，未占用/遮蔽任何 shipped 座位） |
| 打开入口 | `sidebar.footer.action`（主）+ `conversation.input.left`（次），均为**加法型**列表槽 |
| 展开/折叠/宽度 | `store.js` 的 `setPanel({collapsed,width})` + `persistPanel()` 持久化（view/width/collapsed/showOverlay） |
| 亮/暗主题 | **零硬编码色值**（单测扫描 + `scripts/lint.mjs` 双重门禁，实测精确命中同 0 处）；阴影用 `color-mix(in srgb, var(--dsw-alias-label-primary) N%, transparent)` 派生——**暗色模式下同样可见**（这是本轮把"中性黑 alpha 例外"收紧掉的原因：`rgba(0,0,0,α)` 在深色背景上不产生抬升感） |
| 截图 | `docs/img/session-{terminal,commands,files,logs}-{light,dark}.png`、`docs/img/conn-{list,form}-{light,dark}.png`（共 12 张，亮暗成对） |

**待人工走查**：面板展开/折叠的视觉手感、拖动宽度、主题切换后的观感（自动化只能断言 token 与样式，不能代替人眼）。

## 2. UI 新建连接并连接真实 Linux 服务器

| 项 | 结果 |
|---|---|
| 主链 | `listProfiles → saveProfile → setSecret → connect`（有测试锁定调用顺序，`test/client/conn.test.mjs`） |
| 密码掩码 | `type="password"` + 显示/隐藏切换；stored secret 只显示 host 给的固定掩码 `••••••••` |
| **明文零泄漏** | 断言"任何属性都不得携带明文"，截图内容程序化核对含**明文零泄漏**（测试用 `hunter2` 为探针） |
| 真机连接 | ✅ **实跑通过**：`test/integration/real-target.test.mjs` → `connect, exec uname -a, SFTP round trip in /tmp/dsh-ssh-test`（15.9 s） |
| 主机密钥 | ✅ 真机三把密钥（`ssh-ed25519`/`ecdsa-sha2-nistp256`/`ssh-rsa`）实测序列：accept-new 接受 → `remember` → strict 复验 `exact` → 同类型换钥 → **`SSH_HOSTKEY_MISMATCH`** |
| **UI 全链路（用户实机）** | ✅ **已从"工具路径"升级为"UI 实测"**：真实浏览器里 `connect` 成功、交互式终端**有提示符且 `ls -a` 有真实输出**。证据原文与时间戳见 **§11**。 |

**UI 实测摘要（用户 2026-09-27 实机，完整摘录见 §8）**：console 首行 `[dsh-ssh] client applied: ssh-client-2026-09-26.4-console-clean`；`rpc stream sshPlugin/openShell` 打开（host `streamId st_01M3FYPPRYYBS78D70ZXNPKDKR`），逐键 `shellWrite {"data":"l"/"s"/" "/"-"/"a"/"\r"}` 全部 `ok`；host 日志 `22:52:18 connected to root@203.0.113.10:22 in 712ms (auth=password(••••••••), hostKey=accept-new)` + `22:52:18 session s_01M3FYPP1NHDKF36ZGPNZASCYH ready`；审计 `connect ok`（`durationMs 722`）、`setSecret ok`。

**这三项已由用户 2026-09-27 实机走查通过（原“仍待走查”清单据此撤销）**：
① GUI 内 `top` 全屏刷新与 `q` 退出 —— ✅ 用户走查确认；
② 文件标签**上传/下载进度条** —— ✅ 用户原话「上传：可以发出，传输条出现进度」「也能下载」，逐条日志见 §11.7；
③ 多会话标签切换 + 亮/暗主题 —— ✅ 用户走查确认。

> **证据分级（不混淆）**：② 有 console 原文（`rpc stream sshPlugin/upload|download`、`download open`）；①③ 依据用户本人走查确认（当日未逐条抓取 console 原文），故按“用户确认”而非“日志抓取”记录。

## 3. `uname -a` 正确 + 交互式 `top` 可用

| 项 | 结果 |
|---|---|
| `uname -a` | ✅ 真机返回与 `REAL-TARGET.md` 记录一致（`Linux … 6.8.0-48-generic … x86_64`） |
| **终端在真实 UI 里可用（用户实机）** | ✅ 提示符出现、`ls -a` 有真实结果输出；上行 `shellWrite` 逐键 `ok`、下行流已打开（§11 有原文）。**会话视图布局**与**终端流式**因此从"待走查"变为"已实测覆盖" |
| 交互式 `top`（PTY） | ✅ **真协议端到端**：`test/unit/exec-sshd.test.mjs` 驱动真 `top` → 进备用屏（`?1049`）、连续重绘、`resize(120,40)` 后应用画出新尺寸帧、`q` 退出恢复光标。**GUI 内走查：✅ 用户 2026-09-27 走查确认** |
| console 干净 | ✅ 用户实测无 `Cannot read properties of undefined (reading 'dimensions')` 未捕获错误、无 `has no channel yet` 告警 |
| PTY 不截断（与 exec 有意不同） | 直播不截断（`open.meta.outputLimit='none'`）、replay 窗口受限、越界**必须显式 `gap`**（禁止静默丢帧）——ICD §4.4 冻结，有回归 |
| 帧不变式 | `open → data(seq 严格递增) → exit → end`，**恰好一个 end / 一个 exit**；含"看门狗先结束、`onExit` 迟到"场景 |

## 4. 上传/下载 100MB、进度条正确、校验一致

| 项 | 本地靶机（真协议 sshd double） | 真机（203.0.113.10） |
|---|---|---|
| 上传 100.0 MiB | ✅ 2 202 ms · **45.6 MiB/s** | ✅ **316 383 ms · 100.0 MiB 完整传输** |
| 下载 100.0 MiB | ✅ 1 219 ms · **82.4 MiB/s** | ✅ **350 471 ms · 100.0 MiB 完整传输** |
| 字节一致性 | ✅ 本地 sha256 / 引擎读回 / 远端 `sha256sum` **三方一致** | ✅ **远端 `sha256sum` 与本地比对一致**（`local compare ok`） |
| 进度帧 | ✅ 107 帧、`transferred` 单调递增、末帧 == total、最大并发流 4 | ✅ 110 帧、四阶段（scan/transfer/finalize/verify）、无违反不变式 |
| 断点续传 | ✅ 中断后有 durable offset、`resumable:false` + `resumeHint`（修不回来时**撤回承诺**，绝不跳过空洞） | ✅ 实跑通过：resumed 7 864 320 B 且 **sha256 匹配** |
| 载荷守卫 | — | ✅ 新增 `source unchanged` 阶段（size + inode + sha256 复核） |

**真机 100 MiB 结论：已闭环（3/3 全绿，`test/unit/sftp-real.test.mjs`）。**

```
✔ 100 MiB upload/download round trip with matching checksums  (674 s)
✔ a symlink is reported with its target, and is not followed by default (5.5 s)
✔ an aborted upload resumes from the durable offset (32 s)
ℹ tests 3 / pass 3 / fail 0 / skipped 0
```

**过程中定位并修掉的真实缺陷（都来自这条真机用例）**：
1. **`No response from server`（链路根因）**：读回路径是**单条 100 MB 无界流**、无 deadline，一次抖动带走一批 pending 请求，且失败被归为无从下手的 `SSH_UNKNOWN` → **不触发任何重试**。修：读回改为 **1 MiB 分块 + 每块 deadline + 可中止**；新增链路类失败**有界重试一次**且重试时**降并发 4→1**；失败路径用**新连接**清理远端并断言目录消失。
2. **重试导致进度重复计数**：4 MiB 文件曾报出 4.75 MiB，**违反 ICD §3（单调不减 / 不超过 total）**。修：改为按 **durable 前缀**计数，每字节恰好一次。
3. **晚到的流错误会炸进程**：已 settle 的流收到传输错误 → unhandled `error` → 进程退出。修：每条引擎流挂永久 no-op 监听。
4. **本地源消失时错误指向不清**：原先读起来像传输故障；现在映射为 `{side:'local', path:<本地路径>}`（5 秒定位）。

**一个值得记录的性能事实**：真机吞吐实测 **0.3 MiB/s**，而同一台服务器本地磁盘 `dd` = **158 MB/s**、本地靶机 45–82 MiB/s。**瓶颈完全在国际链路**，不是插件、也不是服务器 I/O。这也解释了早前 89 s/181 s 的耗时波动——断在不同阶段，耗时自然不同。（早前一次表观的 "3.6 MiB/s" 是"传了 28 秒即被外部误删打断"，不是真实吞吐。）

## 5. 10 会话并发互不干扰

| 项 | 结果 |
|---|---|
| 并发上限 | `maxSessions: 10`（config）；超出按 ICD §5 结构化拒绝 |
| 无串扰 | ✅ E2E 第 7 步"10 会话无串扰"通过；集成层有 10 会话隔离用例 |
| 吞吐 | ✅ 10 会话并发合计 40 MiB / 1.3 s · **31.6 MiB/s** |
| 真机 | ✅ sp1 的 27 项真协议用例覆盖复用/单飞/forceNew/上限；`disconnect` 后服务端 `connections == disconnects`（E2E 第 8 步） |

## 6. 凭据永不出现在日志与 UI 明文

| 层 | 证据 |
|---|---|
| 结构化 key 脱敏 | `redact.ts`：`password/passphrase/privateKey/secret/token/key/authorization` |
| 已登记字面量 | `credentials.resolve()` 自动 `track()`；覆盖 URL 编码 / JSON 转义 / base64 / base64url / hex 变体 |
| 对抗性正则 | URL userinfo、`Authorization: Bearer`、`password=`、`--password`、PEM 块、base64/hex 块解码、**跨相邻字段拼接** |
| **消息串也脱敏** | 本轮修掉的真安全缺陷：旧实现只脱敏结构化字段，`logger.info(\`…${password}\`)` 会明文落盘（最常见的泄漏写法） |
| 端到端证据 | `security-capstone.test.mjs` 按 `apply()` 接线后**逐个搜索全部产物**：profiles 文件 / 审计 JSONL / 插件日志 / known_hosts / `ConnProfileView` / `JSON.stringify(secrets)` / `PublicConfig` / `queryAudit` 结果 → **无明文** |
| UI | `ConnProfileView` 只带 `secretRefs`；`ResolvedSecrets.toJSON()` 默认掩码；截图核对明文零泄漏 |
| 日志目录 | `<DSH_HOME>/logs/dsh-ssh/`，审计 JSONL 落盘前即脱敏 |

## 7. 文档与工程质量

| 项 | 结果 |
|---|---|
| 文档 | `README.md`（安装/配置/UI/FAQ）、`docs/ICD.md`（接口契约 v1.0.9，含 10 次实测驱动的修订记录）、`docs/DESIGN.md`、`docs/TESTING.md`、`docs/DEMO.md`、`docs/REAL-TARGET.md`、`CHANGELOG.md`、8 份模块 README |
| Lint | **0 errors**（eslint 10.11.0 + flat config；vendor 目录按 ICD §8.6 排除并说明理由） |
| 构建门禁 | 汇编器**两道硬门**：源文件含 U+FFFD 直接失败（报文件:行号，根因是 PowerShell 管道按 GBK 读写 UTF-8）、产物必须能被 `new Function` 解析（防止"构建成功但页面装载失败"） |
| 覆盖率 | 连接层函数级 **229/250 = 92%**（`errors/ids/index/scrub/semaphore/state/types/sessions` 100%） |
| 一键验证 | `npm run verify:all` = typecheck → lint → build:host → build:client → bundle:check → unit → client → integration → e2e → perf（每层硬超时 + kill 进程树 + 并发自检 + 环境变量清理） |

## 8. ICD 与实现一致

| 项 | 结果 |
|---|---|
| 契约门 | `DSH_SSH_STRICT_ICD=1` 下：§0 包/入口、§0.3 bundle 封套、§5 全 32 错误码（含 `retryable`）、§3 帧不变式（真流上）、**§4 方法表 41/41 存在**（含 §4.7 的 `followActivity`/`clearActivity`）、§6 patch 写出全部默认值、§8.5 双语键集合相等（**143** 个冻结键）。命令与最新数字见 §12 |
| 冻结面 | **44** 个 Remote 方法（**8** 个流式：`followSessions`/`exec`/`openShell`/`upload`/`download`/`followAudit`/`followActivity`/`probeStream`）；`SftpHandle` 的三个增量可选成员（`start?`/`supportsOffsetWrite?()`/`truncate?`）均逐条记录在 ICD。**注意**：44 是 `remoteMethods()` 实测总数，其中 3 个（`probeStream`/`describe`/`reportSpike`）是 M0 诊断方法，不在 §4 方法表内 |
| 编译期防漂移 | `src/exec/compat.ts`、`src/sftp/compat.ts` 做**逐成员双向赋值断言**——本轮实战抓到过一次 ICD 漂移（`endInput`） |
| 实测驱动的修订 | ICD 共 10 次修订全部有"是什么实测/谁发现"的记录（例如 R1.3"扁平原始值规则"来自 4 次一致的浏览器测量：载荷**遇到第一个非原始值即停止复制**） |

## 9. 未通过 / 未验证项（诚实清单）

1. ~~**真机 100 MiB 传输**：唯一未闭环项，修复中~~ → **已闭环**：真机上传/下载各一次 100.0 MiB 完整传输、远端 `sha256sum` 一致、110 帧进度帧合规（见第 4 节）。**边界**：UI 侧的 100 MiB 级传输没有独立抓证，仅有工具路径实测 + UI 小文件（6938 B）实测，故不宣称“UI 端完成 100 MiB 传输”。
2. **`serverBanner`**（§4.2 `testProfile` 可选字段）：未实现——sp1 的冻结 `SessionHandle` 不暴露服务端 banner，本层无可读来源；补它需要给冻结接口加只读属性（跨 3 个模块），已记为**已知缺口**。
3. **`@revoked` 与问题级 `policy`**：sp8 的对拍发现 `verify()` 未拒绝被吊销的密钥、且 `verify({policy})` 未覆盖实例策略；两条在 `DSH_SSH_STRICT_ICD=1` 下转硬失败。产品路径（按 config 构造实例）行为正确。
4. **lint warnings ×16**：`react-hooks/exhaustive-deps` 未安装（已批准但预算用尽），故 3 条 `Unused eslint-disable directive` 仍在。
5. **真机 key 交换后的 known_hosts 是追加而非替换行**：verify 仍命中精确匹配，但文件里会同时存在两行（OpenSSH 本身也不自动替换）。
6. **`ENOTEMPTY` 无专属错误码**：映射为 `SSH_UNKNOWN` + `details.errno`。
7. **机器卫生**：本报告生成期间清理了 **1 440 个**测试残留临时目录（根因：`test/client/harness.mjs` 建临时目录却从不删除）；已改为 best-effort 清理并实测不再增长。

## 10. 复现全部证据的命令

```powershell
$node = 'C:\Users\<user>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
cd C:\Users\<user>\Documents\deepseek-harness\default-workspace\dsh-ssh

& $node node_modules\typescript\bin\tsc -p tsconfig.json --noEmit          # 0 错
& $node --test --test-concurrency=1 --test-force-exit "test/unit/*.test.mjs"      # 522/519/0/3
& $node --test --test-concurrency=1 --test-force-exit "test/client/*.test.mjs"    # 143/143
& $node --test --test-concurrency=1 --test-force-exit "test/integration/*.test.mjs" # 40/37/0/3
& $node test/e2e/run.mjs                                                   # 9/9
& $node scripts/lint.mjs                                                   # 0 errors
& $node scripts/build-client.mjs --check                                   # up to date

# 真机（凭据不入仓库，仅环境变量）
$env:DSH_SSH_TEST_REAL_HOST='203.0.113.10'; $env:DSH_SSH_TEST_REAL_USER='root'
$env:DSH_SSH_TEST_REAL_PASSWORD='<runtime>'
& $node --test --test-concurrency=1 test/integration/real-target.test.mjs  # 2/2
& $node --test --test-concurrency=1 test/unit/sftp-real.test.mjs           # 见第 4 节
```

---

## 11. UI 全链路实测记录（真实浏览器 + 真机，2026-09-27）

> **来源**：用户在同一台机器上对**运行中的 DSH 窗口**实测；以下是原文摘录，路径可直接复现。
> **结论范围**：本次实测覆盖"连接 + 交互式终端读写"，**不覆盖** `top` 全屏、文件 UI 上传下载进度、多会话/主题切换（见 §2 待办③）。

### 8.1 客户端（浏览器 console，首行即构建标记）

```
[dsh-ssh] client applied: ssh-client-2026-09-26.4-console-clean
rpc stream sshPlugin/openShell  →  openShell open
   { streamId: "st_01M3FYPPRYYBS78D70ZXNPKDKR" }        (host 侧 streamId)
shellWrite {"data":"l"} ok
shellWrite {"data":"s"} ok
shellWrite {"data":" "} ok
shellWrite {"data":"-"} ok
shellWrite {"data":"a"} ok
shellWrite {"data":"\r"} ok
```

- **上行通**：`openShell` 流已打开，逐键 `shellWrite` **全部 `ok`**（用户敲的是 `ls -a`）。
- **下行通**：用户确认**终端有提示符、`ls -a` 有真实结果输出**。
- **console 干净**：无 `Cannot read properties of undefined (reading 'dimensions')` 未捕获错误、无 `has no channel yet` 告警（sp6 本轮收尾已由此实测验证）。
- **布局**：终端可见可交互；`shellResize` 的 `rows` 为上轮实测 33，真浏览器几何见 `client/src/session/README.md` §8。
- **复现方法**：打开 SSH 标签 → 终端输入 `ls -a`，在 DevTools console 过滤 `dsh-ssh`；首行 marker 串 `ssh-client-2026-09-26.4-console-clean` 即"新产物已生效"的判据。

### 8.2 host 侧（`%DSH_HOME%\logs\dsh-ssh\plugin.jsonl`）

```
22:52:18 connected to root@203.0.113.10:22 in 712ms (auth=password(••••••••), hostKey=accept-new)
22:52:18 session s_01M3FYPP1NHDKF36ZGPNZASCYH ready
```

- 密码在日志里是固定掩码 `••••••••`（不泄漏长度），主机密钥策略 `accept-new`。
- **复现方法**：`Get-Content "$env:DSH_HOME\logs\dsh-ssh\plugin.jsonl" -Tail 5`，时间戳精确到秒。

### 8.3 审计（`%DSH_HOME%\logs\dsh-ssh\audit.jsonl`）

```
connect   ok   durationMs 722
setSecret ok   "persisted": false, "reason": "no credentials service in this composition"
```

### 8.4 平台能力限制（如实记录，**不是插件缺陷**）

- 当前桌面端组合**没有凭据服务**（日志原文 `no credentials service in this composition` → `"persisted": false`）；
  因此 `setSecret` 只登记**会话期内存**凭据，**每次重启 DSH 后需要重新输入密码**。
- 这是**平台能力缺失**：插件的凭据路径本身已按 ICD §6 实现（`ctx.credentials` 缺失时降级并记录原因，UI 显示来源为会话期输入），
  一旦组合提供凭据服务即自动持久化，无需改代码。
- 相关影响面：`docs/DEMO.md` 的 GUI 走查会在重启后要求重输密码；真机层测试**总是**通过 `DSH_SSH_TEST_REAL_PASSWORD` 环境变量提供，与此限制无关。

### 8.5 已知缺口清单的状态更新（本次实测后）

| 缺口 | 状态 |
|---|---|
| 终端流式（上下行） | ✅ **已由实测覆盖**：`openShell` + 逐键 `shellWrite ok` + 终端真实输出 |
| 进度条 / 日志流 | ✅ 同一流式通道（`sshPlugin/*` 下行 stream）已由实测证明可用；进度帧本身另有 107/110 帧断言（§4） |
| 会话视图布局 | ✅ 终端可见可交互（几何细节见 `client/src/session/README.md` §8） |
| GUI 内 `top` 全屏 | ✅ 用户 2026-09-27 走查确认（自动化另有真协议端到端断言，见 §3） |
| 文件 UI 上传/下载进度 | ✅ 用户实机：目录导航（进入 + `..` 返回）、上传（`sshPlugin/upload` + 传输条进度）、下载（流打开 + 6938 B 文件落地）——见 §11.7 |
| 多会话标签 + 亮/暗主题切换 | ✅ 用户 2026-09-27 走查确认（token/样式与双语键另有自动化断言，见 §1） |

### 11.7 文件页签交互与传输（用户实机，2026-09-27）

| 交互 | 用户原话 | 日志/console 证据（可复现过滤串） |
|---|---|---|
| 目录导航（进入子目录 / 返回上一层） | 「进目录：切换过去了，也可以回到上一层」 | console 过滤 `files: navigate`（单击进入 + `..` 返回）；对应用例见 `test/unit`/`test/client` 的 files 断言 |
| 上传 | 「上传：可以发出，传输条出现进度」 | `rpc stream sshPlugin/upload` → `upload open`；传输条由 `progress` 帧驱动（引擎侧 107 帧断言见 §4） |
| 下载 | 「也能下载」 | `rpc stream sshPlugin/download {remotePath, localPath}` → `download open { hostStreamId: "st_01M3G4FSGFZD0XA96C9993KCAF" }`，**6938 字节落地** `C:\Users\<user>\.dsh\cordis.patch.yml.bak-preset-standard-20260925-222753` |

**复现方法**：打开文件标签 → 双击进入子目录、点 `..` 返回；选本地文件上传（观察传输条）；选远端文件下载（观察落盘）。console 过滤 `files:` 与 `rpc stream sshPlugin/`；host 侧 `Get-Content "$env:DSH_HOME\logs\dsh-ssh\plugin.jsonl" -Tail 20`。

### 11.8 最终状态

**用户十条验收标准全部具备可复现证据（2026-09-27）**：

- 侧边栏/主题、新建连接与真机连接、`uname -a` + 交互式终端与 `top`、命令通道、**文件页签（导航/上传/下载）**、10 会话并发、凭据零泄漏、known_hosts、100 MiB 传输、文档与工程质量 —— 逐条证据见 §1–§8，UI 侧补充见 §11.1–§11.7。
- **证据边界（如实）**：① 100 MiB 级传输的闭环在引擎/工具层（真机 100.0 MiB 实测）；UI 侧实测为小文件（6938 B），**不宣称**“UI 端完成 100 MiB 传输”。② GUI 内 `top` 与多会话/主题两项为用户走查确认，未逐条抓取 console 原文，已按“用户确认”标注。
- 已知缺口与遗留项**仍然有效**，集中在 §9（`serverBanner` 未实现、`@revoked`/问题级 `policy` 未生效、lint warnings、known_hosts 追加行为、`ENOTEMPTY` 映射、机器卫生等），**不因“全通过”而删除**。

---

## 12. ICD §4.7（agent 活动镜像）验收证据（2026-09-27）

> **本节记录的是"ICD §4.7 与实现一致"的**可复现证据**，不是走查观感。**
> 命令一律在本仓库根目录执行；数字为 2026-09-27 实测值，**未重跑**，原样记录以便对照。

| 层 | 命令 | 结果 |
|---|---|---|
| host 类型（第一道门） | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **exit 0** |
| host 单测（聚焦批：`activity-feed` / `activity-api` / `activity-tools` / `api-tools` / `exec-tool` / `sftp-tools` / `service` / `config`，共 8 个文件） | `node --test --test-concurrency=1 --test-force-exit test/unit/activity-feed.test.mjs test/unit/activity-api.test.mjs test/unit/activity-tools.test.mjs test/unit/api-tools.test.mjs test/unit/exec-tool.test.mjs test/unit/sftp-tools.test.mjs test/unit/service.test.mjs test/unit/config.test.mjs`（**逐条列出**：PowerShell 不做 `{}` 展开） | **121 tests / 121 pass / 0 fail** |
| 组件层 | `node --test --test-concurrency=1 --test-timeout=30000 "test/client/*.test.mjs"` | **255 tests / 255 pass / 0 fail**（含活动面 8、会话卡片 13；此前一轮为 234 + 这 21 个新用例） |
| 契约门（ICD ↔ 实现） | `node --test --test-concurrency=1 --test-force-exit --test-timeout=60000 test/integration/icd-conformance.test.mjs` | **7 pass / 1 skip / 0 fail**；§4 方法表 **41/41**（含 `followActivity`/`clearActivity`）；§8.5 **163** 个冻结键在 zh/en 双语中齐全（各 214 键、集合相同）；唯一 skip 为 §4.2「需活的服务实例 + 凭据库配置」，**带理由** |
| 客户端产物确定性 | `node scripts/build-client.mjs --check` | **bundle up to date**（产物与源码一致） |

**§4.7 的验收面覆盖了什么**：

| 契约要点 | 证据 |
|---|---|
| `followActivity`（流）与 `clearActivity`（一元）在 host 真实注册 | 契约门 §4 的 **41/41**；另有 `remoteMethods(instance)` 实测 **44** 个 Remote 方法（含这两个） |
| 帧的三种形状（`activity-snapshot` / `activity` / `activity-reset`）与调度不变式 | `test/unit/activity-feed.test.mjs`（**28** 个用例：环预算、段合并、截断字符边界、幂等 `finish`、订阅者隔离、`clear()` 语义、任何输入都不抛）+ `test/unit/activity-api.test.mjs`（事件→帧映射、首帧即快照）。**交叉核对**：这 8 个文件的 `test()` 静态计数为 28+3+12+15+26+12+14+11 = **121**，与上表实测的 121 一致 |
| 工具侧埋点（**谁写**） | `test/unit/activity-tools.test.mjs` + `api-tools` / `exec-tool` / `sftp-tools`（工具行为未被镜像改变：仍各自返回原 envelope） |
| 配置 `activity.*` | `test/unit/config.test.mjs`（schema 默认值）+ 契约门 6（`cordis.patch.yml` 写出默认值） |
| i18n 与面板文案 | 契约门 §8.5（143 键双语齐全，含 19 个 `ws.activity.*`）；组件层 `test/client/**`（含活动面） |
| 文档 | `docs/ICD.md` §4.7/§6/§12 R10 与代码逐条对照后写成；§4.7 的两个端点已进入契约门的 §4 断言 |

**独立验证者（independent verifier）**：**已返回**（2026-09-27，独立 agent，未参与实现）。它自己写了两份测试，只读产品代码：

| 验证项 | 独立证据 | 结果 |
|---|---|---|
| host 端到端（真实 sshd double + 插件**自己的** `createHostRuntime()` 图 + 注册表里取出的 `ssh_exec`） | `test/integration/activity-e2e.test.mjs` | **8/8 通过** |
| ——命令的输出是否**边跑边到** | 命令 `echo alpha-out; sleep 1.5; echo omega-out; echo beta-err 1>&2; exit 3`；断言"stdout chunk 到达时 tool 尚未 settle" | 到达早于 settle **1512 ms**（阈值实测后还原） |
| ——两条通道 + 退出码 + 拒绝 | `end` 帧 `segments` = `['stdout','stderr']`（stdout 顺序保持），`status ok`/`exitCode 3`；未知 `sessionId` → `status 'refused'` + `SSH_STATE_INVALID`；参数非法 → `SSH_CFG_INVALID`；并发两条命令互不污染；`enabled:false` 不记录且不影响 envelope | 全部通过 |
| `ssh_sessions` schema 回归（缺陷本身） | 真实 session 投影通过声明 schema；把修复前的 `objectNode({})` 换回去 → 12 条拒绝，含原始报错 `"value.sessions[0].sessionId" is not a declared property` | **非空洞**（证明断言有效） |
| client 端到端（**构建产物** `lib/client.js` + 真 bridge + 真 store + 真 `SshWorkspace`/`SessionView`） | `test/client/activity-panel.test.mjs` | **8/8 通过**（修复后；见下条缺陷） |
| 对抗项 | `chunk` 落在 `end` 之后不污染已发布记录；`activity-reset` 保留运行中记录且其 `end` 仍到达；空清除不发 reset 帧；`clearActivity` 单次无载荷；面板交互只产生 `clearActivity`（无 exec/键盘/传输流量） | 全部通过 |

**独立验证者发现并已修复的真实缺陷（client 侧）**：`client/src/session/activity.js` 的 `ensureConnected()` 把 handle 写在 `bridge.stream()` **返回之后**，而同步失败会在 `stream()` 内部先送出终止 `end` 帧（`bridge.js` 同时填好 `state.error`）——于是那具"死 handle"被缓存，`if (handle) return handle` 使其永久失效：**host 半边没有 §4.7（就是本机现在的状态）或载体同步抛错时，活动面本次 bundle 生命周期内再也不会重订阅**，只能刷新页面。修复：拒绝缓存 `state.error` 已置位的 handle，并**只警告一次、且点名原因**（原先只打一句通用 `ended`，把"host 版本旧"伪装成"流断了"）。验证者那份"故意失败以钉住缺陷"的测试在修复后转为**回归测试**（8/8）；其两处断言按修复后的契约更新（首次挂载最多两次尝试：开关的 store 订阅 + 面板挂载效应各一次；重挂载不得丢失尝试），失败模式由 Lead 复核。

**在此之前，本节除上表外的数字均出自实现者自测（self-test）**，上表为独立复现。

**如实边界（本节不覆盖的）**：
1. **没有**真实浏览器里"打开活动面、看着 agent 跑命令"的端到端走查记录；组件层证明的是渲染与交互逻辑，**证明不了**几何与"用户是否看得见"（linkedom 无布局引擎）。
2. 因此 §4.7 的验收结论是**"契约、单元、组件三层一致"**，不是"UI 已走查通过"。

---

## 13. 宿主半边热更新在本机不可用（Windows，实测 2026-09-27）

> **一句话**：重建 host 半边（`src/**` → `lib/**`）**不会**让运行中的 GUI 拿到新代码；本机要生效**只能重启 DSH**。
> toggle `include:dsh-ssh` 行**不是**替代方案：它只让 Loader 用**已缓存**的模块重跑一次 `apply()`。
> 此结论与 ICD §12 R4 的旧表述（"toggle 行即可"）**冲突，以本节为准** —— R4 描述的是"重跑 `apply()`"这一半，漏掉了"模块字节是否重新导入"这一半。

### 13.1 证据（两条数字对不上）

| 观察对象 | 数字 | 取值方式 |
|---|---|---|
| 构建产物 `lib/service.js` | **44** 个 Remote 方法（含 `followActivity`/`clearActivity`） | 构造内建类实例后调 `remoteMethods(instance)`（`@deepseek-ai/dsh-typert-protocol`） |
| 活着的 host 写的 `%DSH_HOME%\logs\dsh-ssh\host-ready.json`（`at: 2026-09-27T04:44:42.447Z`） | **42** 个 Remote 方法，**恰好缺** `followActivity`/`clearActivity` | 该文件由 `src/index.ts` 的 `recordHostReady()` 在**每次 `apply()`** 时写入 |
| 上述标记的生成时机 | 一次**完整的** `plugin_manager` toggle 之后（`include:dsh-ssh` off→on，`application: "applied"`） | 即"重跑过 `apply()`，方法集仍是旧的" |

`host-ready.json` 的 `remoteMethods` 是**这个进程里实际注册的**端点列表，所以它是判断"新代码有没有进来"的**唯一可靠判据**：console 与插件日志都区分不了"`apply()` 没跑"和"`apply()` 跑了但用的是旧模块"。

### 13.2 根因（追到 picomatch 一层）

shipped `hmr` 行的 `ignored` 默认值是 `['**/node_modules', '**/.*', 'cache', 'data']`（`root` 默认 `['.']`，见 `packages/boot/hmr`）。监视谓词比的不是绝对路径，而是**相对 `baseDir` 的路径**：

```js
// 摘自 packages/boot/hmr（为说明而合并了行；原文还有 ...this.config 与 ignoreInitial）
this.baseDir = fileURLToPath(new URL(config.base || '.', ctx.baseUrl))   // = profile 目录
const watchBaseDir = realpathSync(this.baseDir)
const match = picomatch(ignored)
this.watcher = watch(root, { cwd: watchBaseDir, ignored: path => match(relative(watchBaseDir, path)) })
```

本机 `baseDir` 是 profile 目录（`…\.dsh\profiles\desktop`），而监视根是它的**兄弟**目录 `C:\Users\Administrator\.dsh\plugins\dsh-ssh`：

```
relative('C:\Users\Administrator\.dsh\profiles\desktop',
         'C:\Users\Administrator\.dsh\plugins\dsh-ssh\lib\service.js')
  = '..\..\plugins\dsh-ssh\lib\service.js'
```

**picomatch 不把 `\` 当分隔符** ⇒ 整个字符串是**一段**、且以 `.` 开头 ⇒ 默认的 `**/.*` 命中 ⇒ **整棵树每个文件都被忽略**，重建 `lib/**` 一个事件都不产生。实测（`packages/boot/hmr/node_modules/picomatch`）：

| 传入 `picomatch([...默认值])` 的字符串 | 返回 | 含义 |
|---|---|---|
| `..\..\plugins\dsh-ssh\lib\service.js`（Windows 实态） | **`true`** | 被忽略 ⇒ 无 reload 事件 |
| `../../plugins/dsh-ssh/lib/service.js`（同路径、正斜杠） | `false` | **证明**分歧来自"反斜杠不是分隔符"，而非路径本身在忽略列表里 |
| `node_modules/x.js`（profile 内） | `true` | 默认值本身是好的：问题只在"跨目录 + 反斜杠"这个组合 |

（`..` 的层数取决于 profile 与包的相对深度：本机 profile 在 `.dsh\profiles\desktop`、包在 `.dsh\plugins\dsh-ssh`，故为两层。**关键性质是"该相对路径以 `.` 开头的单段"**，与层数无关。）

### 13.3 修复（已写入 profile 的托管块）

`scripts/profile-install.mjs` 的 `hmrBlock()` 现在把监视根**直接指向三个源码树**并**清空 `ignored`**，写在独立托管块 `# >>> dsh-ssh hmr watch (managed by dsh-ssh) >>>` 内：

```yaml
- id: hmr
  config:
    root:
      - <PACKAGE_DIR>/lib          # 实际写出绝对路径、正斜杠
      - <PACKAGE_DIR>/src
      - <PACKAGE_DIR>/client/src
    ignored: []
```

`ignored: []` 在此处安全：这三个树里没有 `node_modules`、也没有点目录，默认规则本就没有要挡的东西；同时绝对路径根用正斜杠，绕开了"相对 profile 的路径以 `..` 开头"这一条。只读核对：

```powershell
node scripts/profile-install.mjs --profile "$env:USERPROFILE\.dsh\profiles\desktop" --status
#   package.json dependency : present
#   cordis.patch.yml row    : present
#   hmr watch block         : present
#   node_modules link       : present
```

> **重要限制（必须如实说）**：这次修复**没有**让新代码进入正在运行的 host —— `hmr` 行是启动时装载的，改 profile patch 不会让已加载的监视器按新配置重来。因此 §13.1 的 **42 vs 44 仍是当前运行实例的事实**，而修复是**为下一次 DSH 启动准备**的（是否真的恢复热更新，判据见 `docs/M0-SPIKE.md` §8.4：重启后改一处 `src/**`、重建，看 `host-ready.json` 的方法集是否跟随）。

**对维护者的操作含义**（同时写进 `docs/TESTING.md` §2.5 与 `README.md` FAQ）：

1. 改 host 后**不要**用"toggle 了行、页面没变化"判断自己的代码有问题 —— 先看 `host-ready.json` 的方法数/字段有没有变。
2. client 半边不受影响：`lib/client.js` 字节变化仍会触发页面重新 `apply()`。
3. **配置值**变更与**模块代码**变更要分开看：前者的载体是每次 `apply()` 都会重新读取的 profile patch，因此 toggle 行有效；后者卡在模块缓存上，toggle 无效。
