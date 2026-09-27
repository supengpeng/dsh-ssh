# API / wire 端点层（T10）

> 归属：`sp4-security`（Lead 转交 `src/api/**` + `src/service.ts` 接线权）· 契约：`docs/ICD.md` §3/§4/§5/§6/§12
> 写作用域：`src/api/**`、`src/service.ts`、`src/tools/sessions.ts`、`test/unit/api-*.test.mjs`
> 自测：`node --test "test/unit/api-*.test.mjs"` → **61/61 通过**；`tsc --noEmit` → **0 错**；ICD STRICT 门 → **§4 方法表 39/39 存在**

本层把 T1（连接）/T2（命令）/T3（传输）/T4（安全）四个后端模块第一次接到 wire 上。
**39 个 §4 端点 + M0 四件套 + getConfig 共 42 个 `@Remote` 方法**（其中 7 个流式），全部由
`remoteMethods(runtime.service)` 可读（Lead 的 `host-ready.json` 用它判断"host 是否真的注册了 X"）。

---

## 1. 文件与职责

| 文件 | 职责 |
|---|---|
| `runtime.ts` | **对象图**：`createHostRuntime({ctx, config}) → {service, log, parts, dispose}`。先建 redactor，其余模块共享它；构建顺序 logger→store→credentials→knownHosts→audit→registry→pool→exec→transfers→api→tools→service |
| `local-api.ts` | `LocalApi` 门面：把五个分组挂在一起，`service.ts` 只与它交互 |
| `deps.ts` | `ApiDeps`（依赖对象）、`ApiGroup` 基类（审计/时钟）、共享查询（会话、SFTP 客户端、临时档案） |
| `params.ts` | **R1.3 参数解码**：`readParams` + 类型化读取 + `<field>Json` 解码 |
| `frames.ts` | `FrameQueue`：把 push 型来源（exec hub / 注册表 / 审计）变成 `AsyncIterable<Frame>` |
| `profiles.ts` `/ `sessions.ts` `/ `exec-api.ts` `/ `files-api.ts` `/ `audit-api.ts` | §4.2 / §4.3 / §4.4 / §4.5 / §4.6 的实现 |
| `tools.ts` | Agent 工具注册（best-effort，含 `onResult`→审计） |
| `local-fs.ts`（Lead） | 双栏文件管理器的本地半边 |
| `../../src/service.ts` | **wire 表**：42 个 `@Remote` 方法，每个都是"解码 → 委托 → 编码" |

**为什么把 wire 表与实现分开**：`@Remote` 装饰器必须在 `SshPluginService` 的原型上（Gateway 的
source-mode 发现读的是它），而端点逻辑需要能被单测用普通对象直接驱动。分开之后，
`src/service.ts` 保持成一份可逐行审阅的清单，`LocalApi` 可以脱离 Cordis 树测试。

## 2. 端点 → 后端模块对照

| 端点（ICD §4） | 实现位置 | 后端模块 |
|---|---|---|
| `ping` / `probeStream` / `describe` / `reportSpike` | `service.ts`（M0，未改动） | — |
| `getConfig` | `profiles` → `LocalApi.getConfig` | `config.ts` `toPublicConfig` |
| `listProfiles` `saveProfile` `deleteProfile` `duplicateProfile` `testProfile` `setSecret` `clearSecret` | `profiles.ts` | `store.ts`（档案 + 三重防线）、`credentials.ts`（解析/写入/掩码投影）、`connection` pool（`testProfile` 真连一次） |
| `connect` `disconnect` `listSessions` `getSession` `pendingHostKey` `decideHostKey` `followSessions`(S) | `sessions.ts` | `credentials.resolveProfile` → pool.acquire、`sessions.ts`(注册表)、host-key 提示流（transport 的 `onHostKeyPrompt`） |
| `exec`(S) `execWait` `openShell`(S) `shellWrite` `shellResize` `shellSignal` `shellClose` `listStreams` | `exec-api.ts` | `exec/service.ts`（`ExecService` + `StreamHub`）、`sessions.ts` 的 `run()` 并发闸 |
| `listDir` `stat` `mkdir` `rename` `remove` `chmod` | `files-api.ts` | `sftp/client.ts`（`SftpClient` 包 `SftpHandle`） |
| `upload`(S) `download`(S) `cancelTransfer` `listTransfers` | `files-api.ts` | `sftp/manager.ts`（`TransferManager`）→ `sftp/transfer.ts` |
| `listLocalDir` `statLocal` | `files-api.ts` → `local-fs.ts` | `node:fs` + `sftp/format.ts`（与远端栏同一套格式） |
| `queryAudit` `followAudit`(S) `clearAudit` | `audit-api.ts` | `audit.ts`（内存环 + JSONL 水合） |

## 3. 必须知道的 wire 约定

### 3.1 R1.3：扁平原始值 + `<field>Json`

浏览器→host 的载荷**遇到第一个非原始值就停止复制**（M0 §7.2 四次实测）。因此端点入参必须是
`string|number|boolean|null` 的扁平对象，嵌套结构走 `<field>Json` 字符串：

```
{ profileId: 'p_…' }                       ← 扁平
{ profileJson: '{"name":"prod",…}' }       ← 嵌套（键名 = 字段名 + 'Json'）
{ secretsJson: '{"password":"…"}' }
{ envJson: '{"LANG":"C.UTF-8"}' }
{ kindsJson: '["exec","upload"]' }
```

`params.ts` 同时接受"直接传对象"（进程内调用者，如 agent 工具），但**首次遇到时记一条 warn**
（`<field> arrived as a nested object; the wire convention is <field>Json`），因为这种写法在
浏览器里会静默丢字段——那是"点了没反应"类 bug 的根源。解码失败一律 `SSH_CFG_INVALID`，
绝不退化成 `undefined`。

### 3.2 流式端点的三件套与交接信息

- 每条流 `open → data(seq 严格递增) → exit → end`，恰一个 `end`（§3）——由 `FrameQueue` 保证
  "注册完成前到达的帧不丢"。
- **`upload`/`download` 的 `{opId, resumedFrom}` 在 `open.meta` 里**（§4.5 的返回值描述的是流本身，
  而流式方法的返回值就是帧序列）。UI 可在第一帧就标注"从 34% 续传"——`resumedFrom` 是 manager
  在传输开始前就算好的。
- **`sinceSeq` 越界 → 显式 `end{reason:'error', error.code:'SSH_LIMIT_OUTPUT_TRUNCATED'}`**。绝不静默
  少帧：终端重连后看到 seq 空洞却无从察觉，是这类 bug 最坏的形态。有测试锁定
  （`api-session.test.mjs` → "a replay gap becomes an explicit terminal error"）。
- `exec` 的 `pty:true`（ICD v1.0.9）已透传；**PTY 把远端 stderr 合并进 stdout**，所以 `pty:true` 时只
  会有 `channel:'stdout'` 的 `data` 帧——这是远端行为，不是我们丢帧。

### 3.3 并发闸与失败形态

- `exec`/`execWait`/`openShell` 都经 `SessionRegistry.run()` 取槽；**槽在整条流存续期间持有**，
  所以 `SSH_LIMIT_QUEUE_FULL` 的含义是"该会话正在跑的操作已达上限"，而不是"启动得太密"。
- 失败经 `asWireError` 重建：`code`/`retryable`/`details`/`retryAfterMs` 都成为**自有可枚举属性**，
  因此即使 carrier 用"复制自有键"的方式序列化错误，客户端仍拿到 §2 冻结的 `ErrorInfo`
  （`SshError.retryable` 本是原型 getter，不这样做会丢）。
- `execWait` 对 **超时与截断正常返回**（`timedOut`/`truncated` 是数据，不是异常，§4.4）；
  只有真正的失败（未知会话、通道错误…）才 reject。

### 3.4 凭据与主机密钥（安全相关，UI 需知道）

- `setSecret` 返回 `{ref, masked, persisted, reason?}`：**`persisted:false` 是正常降级**——启动环境
  已经提供了该引用时，凭据库拒绝写入（只读），值仅本次进程有效。UI 应显示"本次会话有效、未持久化"，
  不要报错。`masked` 恒为 8 点，`ref` 是引用名（非密文）。
- `describe`/`listProfiles` 的 `secrets` 成员只含 `present`/`source`/`masked`；明文永不出现在任何
  `result` 中（有测试逐字搜索）。
- **主机密钥策略**（`hostKey.policy`）：
  - `accept-new`（默认）：首次自动接受**并写入 known_hosts**（OpenSSH 同义）→ 不需要交互。
  - `strict`：未知主机 → `SSH_HOSTKEY_UNKNOWN`，需要 UI 让用户确认。
  - 两种策略下"指纹变了"都一律 `SSH_HOSTKEY_MISMATCH`，必须二次确认。
  - 交互流程：`connect` 挂起 → `pendingHostKey` 拿到 `{sessionId, host, port, keyType, fingerprint,
    knownHostsMatch}` → 用户确认 → `decideHostKey({sessionId, accept, remember})`。
    `remember:true` 会用**本次握手真实的公钥**写 known_hosts（提示里只有指纹，所以密钥材料由运行时
    在 verifier 外面包一层捕获；捕获不到就记 warn 且**不写**——伪造一条 known_hosts 比不写更糟）。
    超时未答复按 `connectTimeoutMs` 拒绝，避免无人答复的提示永久占住连接槽。
  - `testProfile` 没有可供用户答复的会话上下文，所以它对提示一律拒绝并以结构化错误返回；
    想让它通过，请先在 UI 里信任该密钥或用 `accept-new`。

## 4. 未接通 / 已知边界

1. **`serverBanner`（§4.2 `testProfile` 的可选字段）未实现**：sp1 的冻结 `SessionHandle` 不暴露服务端
   banner，本层没有可读来源。字段是可选，UI 忽略即可；要补需先给 `SessionHandle` 增加一个只读属性
   （ICD 变更，交由 Lead 裁决）。
2. **`TransferTask` 未在 `protocol.ts` 声明**：DESIGN §4 有形状但没有落到冻结模块，本层在
   `files-api.ts` 就地声明 `TransferTaskView`（字段与 DESIGN §4 一致）。建议提升到 `protocol.ts`，
   这样客户端半边能直接 import。
3. **known_hosts 变更密钥不做"替换行"**：用户在 `HostKeyPrompt` 上确认变更并 `remember:true` 时，
   新密钥是**追加**一行（旧行保留）。后续 verify 会因命中精确匹配而通过（旧行不致命），但文件里会
   同时存在两行。要做行替换需给 `KnownHostsVerifier` 增加 API（ICD 变更）。
4. **`ssh_sessions` 的旧名字**：ICD 工具清单现在是 7 个
   （`ssh_connect/ssh_disconnect/ssh_sessions/ssh_exec/ssh_upload/ssh_download/ssh_list_dir`），
   `config.tools` 默认值已同步；`src/tools/sessions.ts` 提供前三个。若某个组合没有 tools 注册表，
   注册整批跳过并 warn（激活不失败）。
5. **本地半边的权限面**：`listLocalDir`/`statLocal` 能读运行账号可读的一切（与 shipped 本地文件浏览器
   相同）。UI 只应发出用户键入/导航到的路径；每次调用都进审计。
6. **审计 `queryAudit.total` 是"内存环内命中数"**（默认 2000 条，首次查询从文件尾部水合）；
   完整历史在 `auditFile`（8 MiB 轮转）。需要全量统计请直接读文件。
7. **`clearAudit` 会记录自己**：清空后立刻查会看到一条 `clearAudit`（detail 带 `cleared` 数量）。
   这是有意的——"谁清空了审计"本身必须留痕。

## 5. 自测结果

环境：Node（DSH 内置）· Windows · 工作目录 `dsh-ssh/`

```bash
# 1) 类型检查（全包）
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit      # → 0 错
# 2) 构建（产出 lib/**，DSH 直接消费）
node node_modules/typescript/bin/tsc -p tsconfig.json               # → 0 错
# 3) 端点单测
node --test --test-concurrency=1 "test/unit/api-*.test.mjs"
# 4) ICD 契约门（STRICT）
DSH_SSH_STRICT_ICD=1 node --test "test/integration/icd-conformance.test.mjs"
```

| 测试文件 | 用例数 | 结果 | 覆盖重点 |
|---|---|---|---|
| `test/unit/api-profiles.test.mjs` | 20 | **20 pass / 0 fail** | §4.1 `getConfig`（含"无 runtime 时的降级"与"未接线端点必须显式报错"）、R1.3 解码（JSON 串 / 直接对象 / 非法 JSON / 类型错）、`ErrorInfo` 自有属性、§4.2 全 7 端点、明文三重防线、`setSecret` 的持久化与只读降级、`testProfile` 复用活会话 vs 真连后关闭 |
| `test/unit/api-session.test.mjs` | 21 | **21 pass / 0 fail** | §4.3 全 7 端点（含 host-key 提示挂起→`decideHostKey`→`remember` 用真实密钥、拒绝后不留会话）、§4.4 全 8 端点、**gap → 显式 `SSH_LIMIT_OUTPUT_TRUNCATED`**、`pty` 透传、`execWait` 超时/截断当数据、并发闸 `SSH_LIMIT_QUEUE_FULL` |
| `test/unit/api-files.test.mjs` | 20 | **20 pass / 0 fail** | §4.5 全 12 端点（单路径操作 / 传输流 `open.meta` 交接 / 取消 / 任务投影剔除内部字段 / 本地半边对真实临时目录）、§4.6 全 3 端点（过滤分页、订阅过滤、清空留痕、审计无密文） |
| **合计** | **61** | **61 pass / 0 fail** | |

```bash
$ node --test --test-concurrency=1 "test/unit/api-*.test.mjs"
ℹ tests 61
ℹ pass 61
ℹ fail 0

$ DSH_SSH_STRICT_ICD=1 node --test "test/integration/icd-conformance.test.mjs"
✔ ICD §4: the method table exists on the host service     # §4: 39/39 methods present（此前是 skip）
ℹ tests 8   ℹ pass 7   ℹ fail 0   ℹ skipped 1              # 仍 skip 的是 §4.2 投影检查（需活实例）

$ node -e "…remoteMethods(createHostRuntime({ctx:{},config}).service)…"
42 methods（7 个 stream）: cancelTransfer, chmod, clearAudit, clearSecret, connect,
decideHostKey, deleteProfile, describe, disconnect, download(S), duplicateProfile, exec(S),
execWait, followAudit(S), followSessions(S), getConfig, getSession, listDir, listLocalDir,
listProfiles, listSessions, listStreams, listTransfers, mkdir, openShell(S), pendingHostKey,
ping, probeStream(S), queryAudit, remove, rename, reportSpike, saveProfile, setSecret,
shellClose, shellResize, shellSignal, shellWrite, stat, statLocal, testProfile, upload(S)
```

### 5.1 本轮被测试抓出的真实缺陷

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| 1 | `connect` 从 `profile`/`profileJson` 读取内联档案（ICD 的参数名是 **`inline`**） | 浏览器传 `inline` 时被当成"既没有 profileId 也没有 inline" → **连接永远失败**，UI 表现为"点了没反应" | 改读 `inline`/`inlineJson`；`forceNew` 按 ICD 从 `inline.forceNew` 读取 |
| 2 | `sftpClientOf` 的未知会话错误不带可用会话列表 | "没有这个会话"无法据以行动 | `details.sessions` 补上可用会话（与 exec 层一致） |
| 3 | `<field>Json` 直接传对象的告警按**进程**去重 | 单测无法观察；且真实客户端若退化成直接传对象，只有第一次可见 | 导出 `resetDirectNestedWarnings()` 供测试；行为（每字段一次）保持不变 |

### 5.2 与真实后端的联调状态

- **不依赖真机即可验证的部分**：全部 61 条端点测试（用真实 `ProfileStore`/`Auditor`/`SessionRegistry`/
  `SftpClient`，只把 pool/exec/transfers/credentials 换成结构化替身）。
- **需要真机（Lead 已就绪的 Ubuntu 靶机）**：`connect`→`execWait('uname -a')`→`upload`(sha256)→
  `download`→`chmod`/`remove`、`openShell` 的 `top` 全屏与 `resize`、`strict`/`accept-new` 两档在真实
  主机密钥上的行为。这些由 Lead 用 `ssh_*` 工具或 E2E 走查覆盖——工具面已于本轮补齐，因此**不再需要
  人工点击 UI 才能验**。
- **STRICT 门剩余的 1 个 skip 可以关掉**：它要求"活的服务实例 + 已配置的凭据库"。实测
  `createHostRuntime({ ctx: {}, config })`（`DSH_HOME` 指向临时目录）就能建出真实例——不需要凭据服务、
  不需要 Cordis 树、不产生网络/磁盘阻塞：

  ```js
  const { createHostRuntime } = await import('./lib/api/runtime.js')
  const { Config, resolveConfig } = await import('./lib/config.js')
  const rt = await createHostRuntime({ ctx: {}, config: resolveConfig(Config({}), { DSH_HOME: tmp }) })
  // rt.service.saveProfile(...) → view.secrets = {present:false, source:'none', masked:''}
  // rt.parts.tools.skipped → 7 条（无 tools 注册表，干净降级）
  await rt.dispose()   // 幂等
  ```
