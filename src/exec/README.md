# `src/exec` —— 命令执行与交互式终端后端

> 归属：sp2-exec（共享任务 task-2）· 契约来源：`docs/ICD.md` §3、§4.4、§5、§7.1（v1.0.4）· 语言：代码/注释英文，文档中文

本目录实现「单命令执行」与「PTY 交互式 shell」两条通道，并把它们投射成 ICD §3 的流式帧。
它**不**关心传输绑定：帧交给一个持订阅者的 hub，wire 层（Lead 的 `src/api/**`）负责把帧送到页面。

---

## 1. 文件与职责

| 文件 | 职责 |
|---|---|
| `types.ts` | ICD §7.1 的**结构镜像**（`SessionHandleLike`/`ExecHandleLike`/`ShellHandleLike`/`ExecRequestLike`/`ShellRequestLike`）。刻意不 import sp1 的文件 → 可用 fake 单测、不阻塞；结构类型保证真 `SessionHandle` 可赋值 |
| `compat.ts` | **双向编译期赋值断言**（逐成员）。任一侧签名漂移 → 全包 `tsc` 变红。已实战捕获一次真实漂移（ICD v1.0.4 的 `ExecHandle.endInput()`） |
| `frames.ts` | 帧构造 + §3 调度不变式（`FrameWriter`）+ 可复用校验器 `inspectFrameSequence()` |
| `streams.ts` | `StreamHub`：流注册表、`sinceSeq` 重放、`write/resize/signal/close` 路由、`dispose` 兜底终止 |
| `encoding.ts` | UTF-8 边界处理与 base64 兜底（`ChannelDecoder`） |
| `limits.ts` | 头尾截断（`OutputLimiter`，头/尾各 50%） |
| `timeout.ts` | 超时升级（TERM → graceKillMs → KILL → settleMs 兜底）。定时器可注入 → 单测用假时钟精确断言顺序 |
| `pump.ts` | 字节泵：解码 + 限流 + 抓取，exec/shell 共用一份实现 |
| `exec.ts` | 单命令 runner（`startExec`）：帧、超时、截断、stdin、取消 |
| `shell.ts` | PTY runner（`startShell`）：帧、输入、resize、signal、close |
| `service.ts` | `ExecService`：wire 层唯一的门面（§4.4 八个方法 + 订阅/取消/dispose） |
| `toolkit` = `schema.ts` | 工具用 JSON Schema / 文本块构造器 |
| `ids.ts` | `st_` + ULID 形式的流 id |
| `src/tools/exec.ts` | 模型可见工具 `ssh_exec`（参数面、`output.schema`、`render`、卡片） |

## 2. 关键设计决定（附理由）

1. **终止帧只有一个出口。** `settle()` 由 `finished` 守卫；`FrameWriter.exit()/end()` 二次调用会被拒绝并记录违例。
   无论「连接层的 `onExit`」与「本层看门狗」谁先到，线上永远只有 1 个 `exit` + 1 个 `end`（ICD §3）。
   有专门测试覆盖"看门狗先结束、`onExit` 迟到"的场景。
2. **`data.seq` 无空洞靠"只给被保留的帧编号"实现**：被截断丢弃的中间字节从不占用 seq，
   因此 seq 仍是 0,1,2,… 连续，而截断通过标志位 + 终止码显式上报（不静默丢）。
3. **超时是本层的职责，也是最后一道防线。** `timeoutMs` → TERM，`+graceKillMs` → KILL，
   `+settleMs` → 强制 settle。与 sp1 的同类升级**幂等共存**（Lead 已裁决为纵深防御）；
   若 sp1 的升级缺失/回归，流仍一定会终止，不会让 UI 永久转圈。
4. **PTY 直播路径不截断**（Lead 已批准并入 ICD v1.0.4 §4.4）：终端是活屏幕，
   头尾截断会冻结/错乱 `top`、`vim` 的画面，且"尾段"要等 shell 退出才可能存在。
   终端流的**重放窗口**受 `maxOutputBytes` 限制，重连 `sinceSeq` 落在窗口外时
   `subscribe()` 返回 `gap: true` —— 由 wire 层显式转成 `SSH_LIMIT_OUTPUT_TRUNCATED`，禁止静默丢。
   `exec` 流严格按 §4.4：头尾各 50% + `truncated` 标志 + `end{reason:'error', code:'SSH_LIMIT_OUTPUT_TRUNCATED'}`。
5. **非法 UTF-8 走 base64 兜底，且按流式边界处理**：远端 read 边界不是字符边界，
   跨 chunk 的多字节字符会被暂存到续字节到达（否则会把正常中文误判成二进制），
   真正的非法字节才 base64；流结束时残留的半截序列也以 base64 释放，一个字节都不丢。
6. **`execWait` 对 timeout/截断返回结果而不抛错**（Lead 已冻结进 §4.4）：抛错会连带丢掉
   `stdout/stderr`，而命令面板正需要它们；只有启动失败才抛 `SshError`。
7. **`done` 永不 reject**：流式端点只拿到 `streamId`，没人可抛；所有失败都以帧 + 结果字段呈现。
8. **PTY 打开期间的键入会被短暂缓存**（上限 `MAX_PENDING_INPUT = 64 KiB`）：打开真实 PTY 需要一个往返，
   用户/UI 往往在通道就绪前就开始打字。缓存按原顺序在通道就绪后投递（保留每次调用的边界），
   超过上限或流已结束才抛 `SSH_STATE_INVALID` —— 不静默丢输入，也不让用户白打一段字。

## 3. 对外接口（wire 层接线用）

```ts
const service = new ExecService({
  resolveSession: (id) => pool.get(id),        // 会话查找（sp1 的 ConnectionPool.get 直接可用）
  listSessions: () => registry.list(),         // 可选：给 ssh_exec 的"可用会话"提示
  defaultSessionId: () => activeSessionId,     // 可选：模型省略 sessionId 时的兜底
  limits: { maxOutputBytes, operationTimeoutMs, graceKillMs },  // 来自 ResolvedConfig
  logger, now, timers, settleMs, replayLimitBytes, maxFinishedStreams,
})
```

| 方法 | 对应 ICD §4.4 | 返回 |
|---|---|---|
| `exec(params, opts?)` | `exec` | `{ streamId, done }`（`opts.signal` = 断流取消） |
| `execWait(params, opts?)` | `execWait` | `Promise<ExecRunResult>`（timeout/截断不抛） |
| `openShell(params)` | `openShell` | `{ streamId, done }` |
| `shellWrite({streamId,data,encoding?})` | `shellWrite` | `{ written }` |
| `shellResize({streamId,cols,rows})` | `shellResize` | `{ resized: true }` |
| `shellSignal({streamId,signal})` | `shellSignal` | `{ sent: true }` |
| `shellClose({streamId})` | `shellClose` | `{ closed: true }` |
| `listStreams({sessionId?})` | `listStreams` | `{ streams: StreamSummary[] }` |
| `cancel(streamId)` | 客户端 abort | `boolean` |
| `subscribe(streamId, onFrame, {sinceSeq?})` | 帧投递 / 续订 | `{ unsubscribe, replayed, gap, finished }` |
| `resolveTargetSession(id?)` | 给 `ssh_exec` 用 | 解析出的 `sessionId`，失败抛 `SSH_CFG_INVALID`（`details.sessions` 带候选） |
| `dispose(reason?)` | 插件卸载 | 终止所有存活流（`end{reason:'peer-closed'}`） |

**wire 层必须处理的一件事**：`subscribe(...)` 返回 `gap: true` 时表示客户端要的帧已不在重放窗口内，
必须显式回 `SSH_LIMIT_OUTPUT_TRUNCATED`（§3 禁止静默丢数据）。

`ssh_exec` 工具按 `@local/dsh-python` 的既有范式注册：

```ts
ctx.effect(() => ctx.tools.register(sshExecTool({ exec: service, onResult: auditHook })))
```

## 4. 自测结果

命令（工作区根目录 `dsh-ssh/`）：

```
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit      # 类型
node node_modules/typescript/bin/tsc -p tsconfig.json               # 构建 lib/
node --test --test-concurrency=1 "test/unit/exec*.test.mjs" "test/unit/shell*.test.mjs"
```

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | **0 错**（含 `src/exec/compat.ts` 的全部逐成员断言） |
| `test/unit/exec-frames.test.mjs` | 22 通过（帧不变式、重放/gap、限流、编解码、流 id） |
| `test/unit/exec.test.mjs` | 30 通过（帧序、超时升级、取消、截断、stdin、错误、listStreams、dispose、迟到 onExit） |
| `test/unit/shell.test.mjs` | 18 通过（PTY、全屏应用、resize/signal/close、二进制安全、早起输入、重放窗口） |
| `test/unit/exec-tool.test.mjs` | 26 通过（`ssh_exec` 参数面、信封+输出 schema 校验、render/卡片、会话解析、pty/stdin） |
| `test/unit/exec-sshd.test.mjs` | 5 通过（**真协议** ssh2 靶机：真命令、真超时杀进程、真 `endInput` EOF、真 PTY、真 `top` 全屏） |
| 合计 | **101 用例全绿**（`node --test` 另把夹具文件 `exec-fakes.test.mjs` 计为 1 项，共报 102） |

`test/unit/exec-sshd.test.mjs` 走的是 **sp8 的协议级 sshd 靶机**（真 KEX/真加密/真通道）**经 sp1 的真实 `ConnectionPool`**，
不是 fake；它证明了三件 fake 证明不了的事：真超时确实杀掉了远端 `sleep 30`（并且流以
`exit{timedOut:true}` + `end{reason:'timeout', error.code:'SSH_TIMEOUT_OPERATION'}` 收尾，整个调用 < 8s）；
真 `endInput()` 让远端 `cat` 拿到 EOF 而正常结束；真 PTY 里 `top` 进入备用屏、连续重绘、
`shellResize(120,40)` 后被应用感知并画出 `size: 120x40` 新帧、按 `q` 退出后恢复光标并离开备用屏。

**关键不变式的断言位置**（其他 agent 的 E2E/一致性测试可直接复用）：

- `data.seq` 从 0 严格递增、无空洞：`a command produces open → data → exit → end with a gapless seq`、
  `many chunks keep the sequence gapless and never trip an invariant`（500 帧）+ `inspectFrameSequence()`
- 恰好 1 个 `open`/`exit`/`end` 且 `exit` 在 `end` 之前：`a stream carries exactly one exit and exactly one end`、
  `a late exit event after the watchdog fired adds no second terminal frame`
- 超时升级顺序（TERM → grace → KILL → settle）：`timeout escalates TERM then KILL then closes with timedOut and reason timeout`
  （假时钟精确断言：999ms 无信号 / 1000ms TERM / +299ms 仍无 / +300ms KILL / 无残留定时器）
- 截断：`output above maxOutputBytes keeps head+tail, flags it and reports the code`（头 50 + 尾 50 = 100 字节，
  `truncated.stdout=true`，`end{reason:'error', code:'SSH_LIMIT_OUTPUT_TRUNCATED'}`，`execWait` 不抛）
- 非法 UTF-8 → base64 且字节精确：`non-UTF-8 output is shipped as base64 and stays byte-exact`、
  `terminal bytes that are not valid UTF-8 are shipped base64 and stay exact`
- 跨 chunk 多字节字符：`a multi-byte character split across reads is reassembled as utf8`
- **全屏应用可用性**：`a full-screen app drives the terminal: redraw traffic, input, resize, exit`
  —— 假全屏 app 走真实帧路径：备用屏 `?1049h`/清屏/光标寻址/隐藏光标逐字节到达；
  空格键触发重绘；resize(120×40) 到达 app 且产生新全屏重绘；`q` 退出后帧序列以 `exit`→`end` 收尾且无违例
- 终端不被截断：`a long-running full-screen session is never output-truncated on the wire`
  （配置 1 KiB 上限、实际 >100 KiB 全部到达，`end` 无截断错误）

## 5. 遗留问题

1. **用户真机（`docs/REAL-TARGET.md`）的用例尚未加入**：真协议端到端已经由 `test/unit/exec-sshd.test.mjs`
   对 sp8 的 ssh2 靶机覆盖（不受网络影响）；真机用例按该文档 §3 的纪律必须由
   `DSH_SSH_TEST_REAL_*` 环境变量显式开启、缺变量时 skip 并给出理由，计划放在
   `test/unit/exec-real.test.mjs`（本 owner 写作用域内），覆盖真机 `uname -a` 与交互式 `top`。
2. **PTY 流的 `gap` 需要 wire 层配合**：本层只负责报告 `gap: true`；若 wire 层不处理，客户端在重连后会看到 seq 空洞。
   已在 §3 标注为 wire 层必做项。
3. **`ssh_exec` 的 `stdin` 依赖 `endInput()`**：命令"读到 EOF 才结束"（`cat`/`wc -l`/`tar`）需要它。
   ICD v1.0.4 已加入 `ExecHandle.endInput()`，本层按接口调用并保留对旧实现的鸭子类型兜底（`endStdin`/`end`）；
   真协议用例 `a real stdin plus endInput() gives a remote cat its EOF` 已证明它在真通道上生效。
4. **背压**：`data` 帧按到达即发（同步 sink）。当前 wire 层是进程内直通，未做消费者背压；
   若将来出现"客户端消费慢"的量级（>100 MiB 终端回滚），需要在 hub 与传输之间加窗口，而不是在限流层丢数据（§3 禁止静默丢）。
5. **`exec` 的 `pty: true`**（§7.1 `ExecRequest.pty`）本层已支持（数据走 `channel:'term'`、并入 `stdout`），
   但 §4.4 的 wire 方法表没有对应参数；`ssh_exec` 工具暴露了它。若需上 wire，请 Lead 决定是否扩 §4.4 参数面。

## 6. 接口问题（已上报 / 已裁决）

| # | 问题 | 状态 |
|---|---|---|
| 1 | `ExecHandle` 缺 EOF（`cat` 类命令只能等 deadline） | 已上报 → Lead 采纳，ICD v1.0.4 增补 `endInput(): void`；本层已按新接口调用 |
| 2 | PTY 流是否也做头尾截断 | 已上报 → Lead 采纳"终端不截断 + 重放窗口 + 显式 gap"，写入 ICD v1.0.4 §4.4 |
| 3 | 超时升级归属（本层 vs 连接层）双发风险 | 已对齐：升级幂等双方可做；**终止帧唯一产出方 = 本层 `settle()`**（`finished` 守卫，有测试证明） |
| 4 | `src/exec/compat.ts` 断言由红转绿的过程 | 即 ICD v1.0.4 的 `endInput` 增补；断言按成员拆分，报错会直接点名漂移的成员 |
