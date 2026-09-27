# `src/connection/**` —— SSH 连接与会话核心（SP1 / task-1）

> 冻结契约见 `docs/ICD.md` §5（错误码）、§6（配置）、§7.1（后端核心 API）。本目录是 §7.1 的**唯一实现**，
> 也是 SP2（`src/exec`）、SP3（`src/sftp`）与 Lead 的 `src/api/**` 消费的稳定面。

---

## 1. 模块职责与文件

| 文件 | 职责 |
|---|---|
| `types.ts` | **冻结面**：`SessionHandle` / `ExecHandle` / `ShellHandle` / `ConnectionPool` / `AcquireInput` / `ExecRequest` / `ShellRequest`（逐字对应 ICD §7.1），以及消费其它模块的**结构化端口**（`CredentialSourcePort` / `KnownHostsVerifierPort` / `RedactorPort` / `LoggerPort` / `SshClientPort` / `SftpProvider` / `SftpChannelSource`）与档案镜像（`ConnProfile` / `ResolvedSecrets` / `ResolvedProfile`） |
| `pool.ts` | `ConnectionPool`：复用 / 单飞 / `maxSessions` 上限 / 重试退避 / 状态回调 / 错误分类与脱敏；`disposeAll` 供 `ctx.effect` 卸载回收 |
| `session.ts` | `SessionHandle`：状态机、`SessionInfo` 投影、通道集合、SFTP 懒创建、`SftpChannelSource`（SP3 的注入缝） |
| `channel.ts` | `ExecHandle` / `ShellHandle`：数据/终止事件、`write`/`endInput`/`signal`/`cancel`/`resize`、超时升级（TERM→KILL）、订阅前缓冲 |
| `transport.ts` | 唯一与 `ssh2` 的 `Client` 打交道的地方：建连参数、host key 策略、通道打开、SFTP 子系统、优雅关闭 |
| `auth.ts` | 三种认证方式的**预先规划**：密码 / 私钥（含加密私钥与 passphrase）/ ssh-agent，失败映射为精确错误码 |
| `errors.ts` | 失败分类表：`ssh2` 错误、socket errno、abort、未知异常 → ICD §5 码（绝不发明新码） |
| `retry.ts` | 指数退避 + ±25% 抖动 + 可中断 sleep |
| `state.ts` | 会话状态机（`idle→connecting→authenticating→connected→closing→closed`，`error` 可从任一活动态进入，`error→connecting` 允许重试） |
| `scrub.ts` | 按 key 名剥离凭据、已知密文扫描（供测试与投影防泄漏） |
| `semaphore.ts` | 每会话并发闸门（超限由 `SessionRegistry.run` 转成 `SSH_LIMIT_QUEUE_FULL`） |
| `ids.ts` | `s_`/`st_`/`op_`/`p_` + ULID（Crockford base32，48 位时间 + 80 位随机） |
| `index.ts` | 公开 barrel：`import { createConnectionPool, type SessionHandle } from './connection/index.js'` |

`src/sessions.ts`（同属 SP1）实现 `SessionRegistry`：投影存储 + 订阅 + 每会话并发闸门。

---

## 2. 关键设计决策（含被 Lead 批准的项）

### 2.1 认证：先规划，再连接

`planAuth()` 在**任何 TCP 连接之前**判定认证可行性，因此错误码是精确的、而不是等 15 秒后得到
"authentication failed"：

| 情形 | 错误码 |
|---|---|
| 选了 password 但没有密码 | `SSH_CFG_INVALID`（`details.field='password'`） |
| 私钥文件不存在 / 不可读 / 格式错误 | `SSH_AUTH_KEY_UNREADABLE`（`details.path`） |
| 私钥已加密但未提供 passphrase | `SSH_AUTH_PASSPHRASE_REQUIRED` |
| passphrase 错误 | `SSH_AUTH_PASSPHRASE_REQUIRED`（不是"密钥损坏"） |
| 选 agent 但 `$SSH_AUTH_SOCK` 不存在（POSIX） | `SSH_AUTH_AGENT_UNAVAILABLE` |
| 用户名为空 / auth 取值非法 | `SSH_CFG_INVALID` |

私钥用 `ssh2.utils.parseKey()` 预解析（与握手同一解析器，不会自相矛盾），所以"加密未给口令"与
"口令错误"能区分开。agent 来源优先级：`secrets.agentSocket` > `$SSH_AUTH_SOCK` > Windows `pageant`。

### 2.2 Host key 三档策略

- `insecure`：直接接受，**不读 known_hosts**；
- `strict`：未知 → `SSH_HOSTKEY_UNKNOWN`；已知且一致 → 通过；不一致 → `SSH_HOSTKEY_MISMATCH`；
- `accept-new`：未知 → 交给 SP4 verifier（它按 OpenSSH 语义**自动 remember**）；不一致 → **必须二次确认**
  （`onHostKeyPrompt`），任何策略下都不会静默接受变更过的密钥。

被接受的密钥指纹（`SHA256:` + base64(sha256(blob)) 去 padding，与 `ssh-keygen -lf` 一致）记录在
`SessionHandle.hostKeyFingerprint`（非冻结扩展），供 `testProfile` 的 `hostKeyFingerprint` 字段使用。
未注入 `knownHosts` 时：`strict` 失败关闭，`accept-new` 降级接受并 `warn`（见"已知缺口"）。

### 2.3 keepalive 与 RTT

`keepaliveIntervalMs` / `keepaliveCountMax` 直接映射到 `ssh2` 原生 keepalive（`keepalive@openssh.com` 全局请求）；
ssh2 在连续 `countMax` 次未被应答后抛 `level='client-timeout'` + `Keepalive timeout`，本模块映射为
**`SSH_TIMEOUT_IDLE`**（ICD §5 的"keepalive 连续失败判定链路死亡"）。

`rttMs()` 是**实测往返的指数移动平均**（权重 0.3），样本来自每次 exec/shell/SFTP 通道打开的
"请求→确认"耗时；没有样本时返回 `undefined`（ICD 语义），不使用 TCP 建连耗时冒充 RTT。

### 2.4 复用 / 单飞 / 上限

- 复用键：`profile.id`，为空时退化为 `user@host:port#auth`；
- `forceNew !== true` 时：已有 `connected` 会话 → 直接复用；正在建连 → **共享同一个 Promise（单飞）**；
- `maxSessions` 统计的是**活连接**（`connecting` + 非 `error`/`closed` 的会话）：一个链路已死的会话仍
  留在池里（便于 UI 显示红色状态并让用户关闭），但**不再占用额度**，否则用户会被永久卡住；
- 超限 → `SSH_LIMIT_POOL_EXHAUSTED`（`retryable: true`，带 `retryAfterMs`）。

### 2.5 重试

每个失败先分类成 ICD §5 码，再由策略决定是否重放：`max` 次、`backoffBaseMs * 2^n`、上限 `backoffMaxMs`、
`jitter` 时 ±25%（上限作用于指数值，抖动叠加其上，故最多超出上限 25%）。
**永不重放**：认证与 host key 判定（是决定，不是抖动）、`SSH_CANCELLED`／`SSH_STATE_INVALID`／`SSH_CFG_INVALID`、
池/队列满（重试不会凭空腾出额度）。重试前检查 `AbortSignal`，退避 sleep 可被中断。

### 2.6 通道语义（ICD §4.4 / v1.0.4）

- **超时升级**：`timeoutMs` 到达 → `SIGTERM`；`+graceKillMs` → `SIGKILL` 并强制关闭通道；此后
  `exit.timedOut === true`。该升级**幂等**，exec 层同时执行也不会重复产生终止事件（Lead 已裁定：
  终止帧以本 handle 的 `onExit` 为唯一来源）。
- **不截断**：`ExecHandle` 把**全部**字节交给 `onData`（ICD §3 禁止静默丢 data）；head+tail 截断与
  `truncated` 标志归 SP2。`maxOutputBytes` 本层只接收不处理。
- **订阅前缓冲**：首个订阅者挂上之前到达的数据先缓冲（上限 4 MiB，正常永不触发；真超限会 `error` 日志
  报出丢弃字节数），订阅时立即补发——保证"先拿到 handle、后挂监听"不会丢开头。
- **`endInput()`**（v1.0.4）：透传 `channel.end()` 发 EOF；此后 `write()` 抛 `SSH_STATE_INVALID`
  （通道已关闭时同样抛），**绝不静默丢弃**。
- `cancel()`：`SIGTERM` → 750ms 宽限 → 强制关闭并结算终止事件（尽量不丢尾部输出）。
- `cwd`/`env`：exec 使用 `cd -- '<cwd>' && KEY='值' command` 前缀（POSIX 单引号转义；sshd 常拒绝
  `env` 通道请求）；shell 在 PTY 打开后写入 `cd -- '<cwd>'`，env 走 ssh2 的 env 请求（best-effort）。

### 2.7 SFTP 注入缝（Lead 批准的 A 项）

```ts
export interface SftpChannelSource {
  readonly handle: SessionHandle
  openSftpChannel(signal?: AbortSignal): Promise<SFTPWrapper>  // 原始 ssh2 对象，零包装
}
export type SftpProvider = (source: SftpChannelSource, signal?: AbortSignal) => Promise<SftpHandle>
```

`openSftpChannel()` 返回**原样**的 `SFTPWrapper`（身份断言见单测），因此 SP3 的适配器可以把调用方的
`opts`（含 ICD v1.0.3 的 `start`）整体透传给 `wrapper.createWriteStream`。本层**没有任何挑字段的地方**，
这是"并发分块写不会全部落到文件开头"这条不变式的上游保证。

### 2.8 凭据零泄漏

- 明文只存在于 `planAuth()` 返回的 ssh2 connect 配置里，永不进 `SessionInfo`、日志、`details`；
- 建立认证计划时把明文注册进 SP4 的 `Redactor.track()`，所有日志行与错误 message/details 都过
  `scrub()` + `stripSecrets()`（按 key 名剥离 + 深拷贝）；
- `SessionRegistry` 的投影是**白名单形状**（未知键、`password`/`passphrase` 等一律丢弃），而不是透传；
- **`ssh2` 的 `debug` 钩子故意不接日志**（Lead 已批准）：其报文 dump 是二进制，明文脱敏抓不到
  —— 宁可少日志，也不冒泄漏风险。日志里只有主机/端口/认证方式（掩码形式 `password(••••••••)`）等元信息。

### 2.9 与其它模块的交叉校验

SP2 的 `src/exec/compat.ts` 用**逐成员双向编译期断言**把本目录的 `types.ts` 与他的镜像结构锁在一起：
任一方向漂移都会让全包 `tsc` 变红（它已经抓到过 v1.0.4 的 `endInput()`）。本模块的类型是 §7.1 的逐字镜像，
`ConnectionPool` 消费的 SP4 端口则是**结构化子集**，其真实实现由 `test/unit/connection-integration.test.mjs`
用 sp4 已发布的 `createCredentialResolver` / `createKnownHostsVerifier` 在真协议靶机上验证。

---

## 3. 使用示例

```ts
import { createConnectionPool } from './connection/index.js'
import { createSessionRegistry } from './sessions.js'

const registry = createSessionRegistry({ maxConcurrentOpsPerSession: config.maxConcurrentOpsPerSession, logger })
const pool = createConnectionPool({ config, logger, redactor, credentials, knownHosts, sftp, registry })

const session = await pool.acquire({
  profile,                                     // SP4 解析后的档案（含内存明文）
  label: 'prod-web-1',
  onStateChange: (state, error) => emitStateFrame(session?.id, state, error),
  onHostKeyPrompt: (question) => askUser(question),   // pendingHostKey/decideHostKey 端点
})

await registry.run(session.id, 'exec', async (signal) => {
  const handle = await session.exec({ command: 'uname -a', timeoutMs: 10_000, signal? })
  handle.onData((channel, chunk) => send({ t: 'data', channel, chunk: chunk.toString('base64') }))
  handle.endInput()
  const exit = await new Promise((resolve) => handle.onExit(resolve))
  return exit
})

await pool.disposeAll('plugin unload')       // 由 ctx.effect() 调用
```

---

## 4. 自测结果

工具链：Node v24.21.0，`ssh2` 1.17.0，TypeScript 5.9（`tsc -p tsconfig.json`）。

### 4.1 单测（本模块 6 个测试文件 + 1 个共享夹具）

| 命令 | 结果 |
|---|---|
| `node --test --test-concurrency=1 "test/unit/connection.test.mjs"` | **27/27 通过**（真协议 `ssh2.Server` 靶机） |
| `node --test --test-concurrency=1 "test/unit/connection-pool.test.mjs"` | **28/28 通过**（可编程 ssh2 客户端替身） |
| `node --test --test-concurrency=1 "test/unit/connection-errors.test.mjs"` | **19/19 通过** |
| `node --test --test-concurrency=1 "test/unit/connection-auth.test.mjs"` | **17/17 通过** |
| `node --test --test-concurrency=1 "test/unit/connection-integration.test.mjs"` | **5/5 通过**（sp4 真实实现 + 真协议靶机） |
| `node --test --test-concurrency=1 "test/unit/sessions.test.mjs"` | **16/16 通过** |
| `node --test --test-concurrency=1 "test/unit/connection*.test.mjs" "test/unit/sessions.test.mjs"` | **113/113 通过**，0 失败，进程干净退出（无悬挂句柄） |

`test/unit/connection-fixture.test.mjs` 是共享夹具（**不含用例**）：真协议靶机 `startSshServer()`、可编程
`createFakeClient()`/`createFakeChannel()`、档案与配置工厂、日志/脱敏/known-hosts 替身。靶机自己持有 TCP
监听并用 `server.injectSocket(socket)` 注入（`ssh2` 的 Server 自身 `connection` 事件给的是协议对象而非 socket），
因此 `close()` 能先销毁全部 socket 再关监听，测试进程可以干净退出。

### 4.2 覆盖的能力（按验收点）

- **认证**：密码、内联私钥、加密私钥文件 + passphrase（真靶机 `publickey` 认证全流程）；缺失/错误/不可读
  的凭据各自映射到正确错误码，且**在任何 TCP 连接之前**判定（断言靶机连接数为 0）。
- **连接池**：复用（TCP 连接数 = 1）、并发单飞、`forceNew`、`maxSessions` 上限、建连中占额度、
  死会话不占额度、`disposeAll`、`acquire` 的档案校验、`signal` 预先取消与**建连中取消**（销毁半开 socket）。
- **keepalive/超时**：`keepaliveInterval`/`keepaliveCountMax`/`readyTimeout` 精确透传（含 profile 覆盖配置）；
  keepalive 超时 → `SSH_TIMEOUT_IDLE`；静默 TCP 靶机 → `SSH_TIMEOUT_CONNECT`；
  **永不回应的通道打开 → `SSH_TIMEOUT_OPERATION`**。
- **重试**：退避序列 `[500,1000]`（中性抖动）、非可重试码不重放、`shouldRetry` 收窄、信号中断、
  `onRetry` 观测、第 3 次成功。
- **host key**：`strict` 未知拒绝（且**未向不可信主机提交任何凭据**）、`accept-new` 首次记住、
  不一致必须确认（拒绝 → `SSH_HOSTKEY_MISMATCH`）、无 prompt 处理时失败关闭、`insecure` 完全不校验、
  与 sp4 真 verifier 的 known_hosts 落盘/严格复核/篡改检测。
- **通道**：exec stdout/stderr/exit code、`cwd`+`env` 前缀、`endInput` 后 `write` 抛错、PTY 几何与
  `resize`/`signal` 上行、`cancel`、超时 TERM→KILL→`timedOut`、订阅前缓冲、字节计数、通道打开失败分类、
  `isExecHandle()` 对冻结面的运行时断言。
- **状态与投影**：`connecting→authenticating→connected` 序列、链路死亡 → `error`、关闭 → `closed`、
  监听器抛异常不影响连接、`SessionInfo` 无凭据（`scanForSecrets` 断言）、日志无凭据且认证方式为掩码。
- **registry**：增删改查/订阅/深拷贝隔离、白名单投影、`SSH_LIMIT_QUEUE_FULL`、`remove` 中止在途操作 → `SSH_CANCELLED`、
  `OperationLimiter` 的精确一次释放。

### 4.3 覆盖率（函数级，实测）

本仓库的测试进程环境注入了 `--test-coverage-*=0`，Node 内置的覆盖率表格不会输出，因此用
`NODE_V8_COVERAGE` + 自写汇总脚本测量（跨"每文件一进程"的隔离模式做 OR 合并）：

```
命令：$env:NODE_V8_COVERAGE=<tmp>; node --test --test-concurrency=1 "test/unit/connection*.test.mjs" "test/unit/sessions.test.mjs"
结果：229/250 functions = 92%
  errors.js 100%  ids.js 100%  index.js 100%  scrub.js 100%  semaphore.js 100%  state.js 100%  types.js 100%  sessions.js 100%
  session.js 93%  auth.js 91%  transport.js 89%  pool.js 88%  retry.js 88%  channel.js 82%
```

未覆盖的都是**防御性/降级路径**，逐条列明以便复核：`pool.ts` 的 `FALLBACK_LOGGER`（仅在未注入 logger 时使用，
生产接线必注入）；`transport.ts` 的 known_hosts 写入失败告警文案（`errorMessage`）与 `get closed`；
`channel.ts` 的 `errorText`（仅 write/signal 抛错时走）与 4 个匿名回调；`session.ts` 的
`get resolvedProfile`/`get negotiated`（供 `src/api/**` 诊断用，无测试消费）；`auth.ts`/`retry.ts` 各 1 个
默认参数闭包。语义覆盖（每个 ICD 错误码可达、每条不变式有断言）见 4.2。

### 4.4 类型与构建

| 命令 | 结果 |
|---|---|
| `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | `src/connection/**` 与 `src/sessions.ts` **0 错** |
| `node node_modules/typescript/bin/tsc -p tsconfig.json` | 产出 `lib/connection/*.js` + `lib/sessions.js` |

> 全仓 `node --test --test-concurrency=1 "test/unit/*.test.mjs" "test/client/*.test.mjs"` 的结果请在 Lead/SP8
> 的最终验收中复核：本模块 113 个用例在上述命令下全部通过（已在合并运行中确认），但该命令同时被多个
> 子代理并发执行，且环境注入了 profiling 类 `NODE_OPTIONS`（`--cpu-prof-interval` 等），单独一个测试文件
> 的子进程可能长时间不退出——**请串行执行、避免并发跑全仓**（详见 §5.8）。


---

## 5. 已知缺口与遗留问题

1. **keyboard-interactive 未支持**：只实现 `password`/`publickey`/`agent`。仅允许
   `keyboard-interactive`（如部分 ChallengeResponse 配置）的服务器会得到 `SSH_AUTH_FAILED`；
   如需支持，应在 `auth.ts` 增加 `tryKeyboard` + `keyboard-interactive` 事件处理（属 ICD 变更范围）。
2. **无 known_hosts 注入时降级**：`strict` 失败关闭（安全），`accept-new` 接受并 `warn`。生产接线必须注入
   sp4 的 verifier（Lead 的 `src/api/**` 已如此接线，`connection-integration.test.mjs` 验证过）。
3. **SFTP 流量不计入 `metrics.bytesIn/bytesOut`**：只统计 exec/shell 通道（SFTP 走独立子系统，字节统计归 SP3）。
4. **`maxOutputBytes` 不在本层生效**：见 §2.6，截断归 SP2。
5. **`cancel()` 有 750ms 宽限**：为尽量保留尾部输出；该值不可配置（如需可提升为 config 项）。
6. **`rttMs()` 依赖通道活动**：空闲会话没有新样本（不做主动 ping；ssh2 的 keepalive 不回传时延）。
   如需常驻 RTT，需要额外的全局请求探测（会引入额外网络流量，未做）。
7. **`SessionInfo.info` 是活对象**：`SessionHandle.info` 的字段会被就地更新以保持状态栏新鲜，
   消费方必须只读；如需不可变快照请从 `SessionRegistry.get()` 取（那是深拷贝）。
8. **全仓测试请串行执行**：`node --test --test-concurrency=1 "test/unit/*.test.mjs" "test/client/*.test.mjs"`
   在并行跑多份时会出现单个测试文件的子进程长时间不退出（已实测：同一时刻有 2–3 份全仓运行在跑，
   且环境注入了 `--cpu-prof-interval`/`--node-snapshot` 等 profiling 类 `NODE_OPTIONS`）。
   本模块的 6 个测试文件单独或成组运行均在数秒内完成并干净退出（113/113）。
   排查方法：`node --test --test-concurrency=1 --test-force-exit <单个文件>` 逐个定位。
