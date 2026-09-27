# `src/sftp` —— SFTP 文件传输模块（SP3）

> 归属：T3 / `sp3-sftp`。源码语言 English，文档中文。
> 契约来源：`docs/ICD.md` §3（流式帧）、§4.5（方法表）、§5（错误码）、§6（`sftp.*` 配置）、§7.2（进程内 API）。

本模块提供：SFTP 句柄适配器、分块并发传输引擎、断点续传、进度合并、递归目录传输、
`sha256` 校验、`chmod`/`list/stat/mkdir/rename/remove`，以及三个模型工具
`ssh_upload` / `ssh_download` / `ssh_list_dir`。

---

## 1. 文件清单与职责

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `types.ts` | ICD §7.2 契约：`SftpHandle` / `TransferRequest`；引擎词汇：`TransferProgress`、`TransferOutcome`、`TransferTaskRecord`、`TransferEventSink` | `SftpHandle`、`TransferRequest`、`TransferEntryResult`、`TransferOutcome` |
| `format.ts` | `DirEntry`/`FileInfo` 的唯一构造入口 + 八进制 `mode` 格式化。**本地栏与远端栏共用**（Lead 的 `src/api/**` 也用它） | `formatMode`、`parseMode`、`typeOfStat`、`normalizeMtime`、`mtimeMsOf`、`entryOf`、`fileInfoOf`、`missingFileInfo`、`isHiddenName`、`naturalCompare`、`compareEntries` |
| `paths.ts` | 远端路径一律 POSIX；本地路径按平台。任何调用点都不需要自己 join 远端路径 | `remoteJoin/Dirname/Basename/Normalize`、`remoteRelativeUnder`、`localJoin/Basename/Dirname` |
| `errors.ts` | 把「SFTP 层抛出的任何东西」映射成 §5 错误码 | `toSftpError`、`codedError`、`abortedTransfer`、`cancelledTransfer`、`targetExists`、`verifyMismatch`、`isAbortError` |
| `progress.ts` | 进度合并（≥200 ms 或 ≥1 MiB）+ 速率/ETA + §3 帧映射；时钟可注入 | `ProgressReporter`、`toProgressFrame`、`systemProgressClock` |
| `adapter.ts` | **真实 `SftpHandle`**：把一个 ssh2 `SFTPWrapper` 适配成 ICD 句柄；并提供 `PoolOptions.sftp` 工厂 | `createSftpHandle`、`createSftpProvider` |
| `client.ts` | 句柄之上的校验/规范化门面 + 递归 `walk()`（符号链接策略、深度护栏） | `SftpClient` |
| `local.ts` | 本地文件系统（唯一碰 `node:fs` 的文件）：定位读写、递归列举、流式 sha256 | `listLocalTree`、`readExactly`、`writeExactly`、`sha256OfFile`、`sha256OfReadable` |
| `transfer.ts` | **传输引擎**：规划 → 建目录 → 分区 → 并发写 → 收尾 → 校验；中止时恢复 durable 长度 | `TransferEngine`、`buildRanges`、`durableOffset`、`resolveTransferOptions` |
| `manager.ts` | §4.5 的有状态半边：`opId` 注册表、取消、`listTransfers`、`{streamId, opId, resumedFrom}` 握手 | `TransferManager` |
| `compat.ts` | 编译期漂移断言（不产生运行期代码） | 若干 `Expect<Assignable<…>>` 类型 |
| `index.ts` | 对外稳定导入面（Lead 的 `src/api/**`、`src/service.ts` 从这里导入） | 全部 |
| `../tools/files.ts` | 模型工具三件套 | `fileTools`、`filesToolFactories`、`FILES_TOOL_NAMES` |

---

## 2. 关键设计决策（含「为什么」）

### 2.1 并发 = 连续区间，不是交错分块

一个文件被切成 `concurrency` 条**连续区间**（默认 4 条），每条区间由一个 worker 从自己的
偏移起**顺序**写入。这样换来三个性质，交错分块拿不到：

1. 每个 worker 已提交的字节必然构成它那条区间的**连续前缀**，于是整个文件的
   durable 前缀 = `第一条未完成区间的 start + 已提交字节`，**可精确重算**（`durableOffset`）；
2. 远端每条区间只开一个写流（不是每块开关一次），ssh2 会按序 ACK；
3. 内存上限 = `chunkBytes × concurrency`（默认 256 KiB × 4 = 1 MiB），**与文件大小无关** ——
   这是 100 MiB 能安全跑的前提。

### 2.2 断点续传的**不变式**：目标文件长度 == durable 前缀

`resumedFrom = 目标已存在的大小` 只有在「文件长度 == 已知良好字节数」时才安全。并发区间下这
**不会自动成立**：若区间 2 先落盘、区间 1 只写了一半，文件就比 durable 前缀长，下一次续传会
越过一个空洞。

因此传输失败/被中止时，引擎会先把所有 worker **等完**（`Promise.allSettled`，不是 `all`），
再把目标截断回 durable 前缀：

- **上传**：优先用句柄的 `truncate()`（我们的适配器走 `setstat(path,{size})`，OpenSSH 的服务端
  就是 `truncate()` 语义）；若句柄**不支持** `truncate`，则上传强制退化为**单区间顺序写**——
  顺序写天然满足该不变式，根本不需要截断。
- **下载**：本地文件用 `node:fs` 截断，因此下载**永远并发、永远可续传**。

**修不回来就如实说**：如果截断本身也失败（典型场景：链路先断了，`setstat` 发不出去），
文件可能比 durable 前缀长，此时错误里给 `details.resumable: false` + `details.resumeHint`
（提示用 `overwrite: true` 重传），`resumedFrom` 归 0 —— **绝不承诺一次会跳过空洞的续传**。

### 2.3 能力声明 → 行为探测 → 安全降级

`createWriteStream(path, { start })` 是 ICD v1.0.3 新增的能力（Lead 已批准，sp1 确认
`openSftpChannel()` 返回**原始 wrapper**、不挑字段）。引擎按以下顺序确定它是否可用：

1. 句柄声明 `supportsOffsetWrite()` → 直接用（我们的适配器返回 `true`，ssh2 的
   `WriteStream` 构造里确实 `this.pos = options.start`）；
2. 没声明 → **每个句柄探测一次**：在目标目录写一个 8 字节头 + 偏移 8 处的标记再读回，
   临时文件在 `finally` 里删除；任何异常（含目录不可写）都判为「不支持」；
3. 判为不支持 → 上传退化为**单区间顺序写**，`resumedFrom` 强制 0，并在冲突时
   `details.resumable: false`（**不承诺做不到的续传**）。

### 2.4 进度：两条件取先到 + 阶段必达

`ProgressReporter` 保证（`test/unit/sftp-progress.test.mjs` 用手动时钟逐条断言）：

- `transferred` 单调不减；`totalBytes` 一旦确定**不再变化**（ICD §3）；
- 每 ≥1 MiB **或** ≥200 ms 发一次，二者取先到；`scan` 阶段用 `touch()` 保活（不伪造字节）；
- **阶段切换永远是即时帧**，不会被合并掉；
- `stop()` 补发最后一帧；
- sink（帧发送方）抛异常只计数、绝不打断传输。

`toProgressFrame(streamId, p)` 是 §3 的一一映射，字段同名，wire 层 `spread` 即可。

### 2.5 冲突判定靠 `stat()`，不靠异常

SFTP v3 的状态码只到 8（`OK/EOF/NO_SUCH_FILE/PERMISSION_DENIED/FAILURE/BAD_MESSAGE/
NO_CONNECTION/CONNECTION_LOST/OP_UNSUPPORTED`），**没有 EEXIST**：`open(EXCL)` 已存在只会得到
`FAILURE(4)` + 文本。因此：

- `overwrite:false` 且目标存在 → `SSH_SFTP_TARGET_EXISTS`（`details` 带两侧 size 与 `resumable`），
  UI 二次确认后重发（ICD §4.5 语义）；
- 提供 `onConflict` 时按 `overwrite|skip|rename|cancel` 决策：`skip` 的文件**不计入 totalBytes**
  （进度条不会卡在 99%），`rename` 自动找 `name (1).ext`；
- 目标与源**等长**时视为「已传完」，不做字节搬运，交给 `verify` 判定对错。

### 2.6 校验

- `verify:'sha256'`：传输后**独立**读两侧（本地文件用 `node:fs`，远端用 SFTP 读流）各自算
  digest 再比对；不一致 → `SSH_SFTP_VERIFY_MISMATCH`（`details` 带两侧 digest 与 size）。
  这也是唯一能验证「续传前缀是否正确」的检查。
- `verify:'size+mtime'`：**只能强制 size**。ICD §7.2 的句柄没有 `utimes`/`setstat`，
  目的端 mtime 永远是「写入时刻」，比较 mtime 没有意义。这是一个**已知缺口**，见 §5。

### 2.7 递归语义

- 源是目录 → 递归；**目标根 = 源目录的「内容」**（不额外套一层源目录名），每个条目按
  `relPath` 映射到目标根，从而保留相对结构（与 FileZilla / `cp -r src/. dst` 一致）。
- 符号链接**默认不跟随**（`sftp.followSymlinks=false`）：被标记为 `skip` 并写明原因；
  开启后按目标类型决定是否递归（远端需要 `readlink` 才能解析）。
- **显式指定的根**即使是符号链接也会被跟随（用户点它就是要它的内容）。
- 隐藏文件（点文件）**照传**：`showHidden` 是 UI 关注点，不是传输策略；递归同时受
  `maxDepth`（默认 64）护栏保护，避免链接环挂死。
- 目标端目录用 `mkdir -p` 预建；单文件传输**不**自动创建父目录（避免掩盖路径笔误）。

### 2.8 不变量：失败路径**永远有终点**

三个只有在**真实协议实现**上才会暴露的坑，都已经补上（细节见 §4.6）：

1. **ssh2 的 SFTP `WriteStream` 从不发 `finish`**（只发 `open/ready/close`，`_final` 直接
   `destroy()`）。只等 `finish` → 每次上传永久挂起。`endStream()`/`writeStreamOnce()` 现在
   接受 `close` **或** `finish`（`node:fs` 流只发后者）。
2. **对端消失时 ssh2 不会回调挂起的写请求**（`cleanupRequests` 覆盖不到的情况已实测到）。
   因此每个分块都有 `chunkTimeoutMs`（默认 60 s）截止：超时 → 销毁流 → 该 worker 失败 →
   内部 controller 立刻中止同批其它 worker。**没有这个截止，一条断链就是一个永不结束的转圈**。
3. **失败后的修复步骤也必须有限**：截断用 `restoreTimeoutMs`（默认 10 s）兜底，
   修不回来就按 §2.2 如实降级为 `resumable: false`。

另外两条「不要让一次网络抖动变成一次数据事故」的措施：

- **晚到的流错误不许炸进程**：已经 settle 的流再收到传输错误（通道关闭时的
  `cleanupRequests`）会变成 unhandled `error` 事件，把进程直接带走。因此引擎创建的每个流都挂一个
  永久的 no-op `error` 监听（不影响自己的错误处理，只兜住"我已经不等它了"之后的错误）。
- **进度按 durable 前缀计数，而不是按写入字节**（`reportDurableProgress`）。重试会重写
  "写过但没变成 durable"的字节，按写入计数会**把同一批字节算两次**（实测：4 MiB 文件报出
  4.75 MiB），直接违反 ICD §3 的「单调不减 / 不超过 total」。按 durable 前缀计数则每个字节恰好
  计一次，且 `transferred ≤ totalBytes` 永远成立。

### 2.9 链路类失败：有界重试 + 降并发（ICD §5「SFTP 传输重试必须从断点续传」）

真机 100 MiB 跑失败后补上的策略（`TransferEngineOptions.linkRetry`，默认
`{ attempts: 1, concurrency: 1 }`）：

- **只重试链路类失败**：`SSH_NET_*` / `SSH_TIMEOUT_OPERATION` / 中断类错误，以及
  **`SSH_UNKNOWN` 且文本形如 "No response from server"** —— 后者正是 ssh2 在「通道带着未完成请求
  被关闭」时的形状（无 code），也正是真机失败报出来的东西。它现在是**中断**
  （`SSH_SFTP_TRANSFER_ABORTED` + `details.causeCode`），而不是一个无从下手的 `SSH_UNKNOWN`。
- **绝不重试**：调用方已 abort（用户说要停）、durable 前缀没修回来（`resumeSafe === false`，
  重试就得跳过不可信的字节）、以及**确定性失败**（冲突/路径不存在/权限/校验不匹配 —— 重试只会浪费用户时间）。
- **重试 = 同一次操作内续传**：从 `durableOffset()` 继续，`totalBytes` 不变、`transferred` 继续单调，
  进度条不会回跳；并发降到 1（正确性优先于吞吐）。
- 真机 100 MiB 的**上传阶段本身是成功的**（两次运行各留下约 100 MB 文件 → 4 路并发在真机链路上可用），
  所以 `sftp.maxConcurrentChunks` **建议保持 4**；重试的降并发只是抖动时的保险。
  若后续证据显示真机确实不适合 4 路，改成 1 是一行配置（权衡：本地靶机 4 路 45/82 MiB/s，
  1 路大约再慢 3–4 倍，仍远高于验收下限）。

### 2.10 列表顺序（两个栏位共用）

`compareEntries`：**目录优先**，然后按名称**大小写不敏感自然序**（`file2` < `file10`），
最后用码元比较兜底以保证全序确定。远端（`SftpClient.listDir`）与本地（Lead 的
`listLocalDir`）必须同序，否则两个栏位会对不上。

### 2.11 错误码映射（§5）

**所有**离开 `SftpHandle` 的失败都带**字符串** ICD 码（Promise 拒绝在每个调用点映射；
流失败由 `translateStreamErrors` 把 `error` 事件参数换掉）——sp8 的集成硬门正是这样断言
「`err.code` 属于 `ERROR_CODES` 且为字符串」的。

| 来源 | 映射 |
|---|---|
| SFTP status 2 | `SSH_SFTP_NO_SUCH_FILE` |
| SFTP status 3 | `SSH_PERM_DENIED`（`local:true` → `SSH_PERM_LOCAL_DENIED`） |
| SFTP status 6/7 | `SSH_NET_RESET` |
| SFTP status 8 | `SSH_SFTP_PROTOCOL` |
| SFTP FAILURE(4) + 文本 | `no space/quota`→`SSH_SFTP_DISK_FULL`；`permission/read-only`→`SSH_PERM_DENIED`；`exists`→`SSH_SFTP_TARGET_EXISTS`；`is a directory`→`SSH_SFTP_IS_A_DIRECTORY`；`broken pipe/connection`→`SSH_NET_RESET`；`timeout`→`SSH_NET_TIMEOUT`；其余→`SSH_SFTP_PROTOCOL` |
| `ENOENT`/`ENOTDIR` | `SSH_SFTP_NO_SUCH_FILE`（附 `details.side:'local'`） |
| `EACCES/EPERM/EROFS/EBUSY` | `SSH_PERM_DENIED`；本地侧 `SSH_PERM_LOCAL_DENIED` |
| `EISDIR` | `SSH_SFTP_IS_A_DIRECTORY` |
| `ENOSPC/EDQUOT` | `SSH_SFTP_DISK_FULL` |
| `ELOOP` | `SSH_CFG_INVALID`（我们的递归深度护栏；配置超限） |
| 传输中被任何原因打断（含断链/超时） | `SSH_SFTP_TRANSFER_ABORTED` + `details.causeCode` 保留原始网络码 + `resumable`；`onConflict→cancel` → `SSH_CANCELLED` |
| 其余 | `SSH_UNKNOWN`（原始 `errno` 放 `details`，绝不猜一个具体码） |

> 为什么断链也报 `ABORTED` 而不是裸 `NET_RESET`：ICD 对 `SSH_SFTP_TRANSFER_ABORTED` 的定义就是
> 「传输中断（可续传）」，而 UI 需要的是**可续传偏移**；网络分类放在 `details.causeCode` 里，
> 信息不丢。

---

## 3. 接线（Lead / 集成方需要的三处）

```ts
// 1) 连接池注入 SP3 的适配器工厂（sp1 的 PoolOptions.sftp）
const pool = new ConnectionPool({ ...cfg, sftp: createSftpProvider({ logger }) })

// 2) §4.5 的有状态管理器（config.sftp 直接喂给 defaults）
const transfers = new TransferManager({ sessions: pool, defaults: config.sftp, logger })

// 3) Agent 工具（listDir/stat 走 SftpClient，transfer 走 TransferManager.run）
ctx.tools.register(...fileTools({
  log: logger,
  defaults: config.sftp,
  getSession: (id) => pool.get(id)?.info,
  listDir: async ({ sessionId, path, showHidden, signal }) =>
    new SftpClient(await pool.get(sessionId)!.sftp(signal)).listDir(path, { showHidden, signal }),
  stat: async ({ sessionId, path, signal }) =>
    new SftpClient(await pool.get(sessionId)!.sftp(signal)).stat(path, signal),
  transfer: (request) => transfers.run(request),
}))
```

§4.5 的 `upload`/`download` 是**流式**方法，帧只有两种：

```ts
const started = await transfers.start({
  sessionId, direction, localPath, remotePath, ...params,
  sink: {
    onProgress: (p) => emit(toProgressFrame(started.streamId, p)),   // §3 progress
    onEnd: (e) => emit({ t: 'end', streamId: started.streamId, reason: e.reason, error: e.error }),
  },
})
// 返回 { streamId, opId, resumedFrom, totalBytes? }
```

**传输流不发 `data` 帧**：文件字节在 host 侧（本地 fs ↔ 远端 SFTP）流动，浏览器只收进度。
因此 §3 的「输出截断 / `SSH_LIMIT_OUTPUT_TRUNCATED` / `sinceSeq` 续订」对传输流**不适用**。

`listTransfers` ← `manager.list()`；`cancelTransfer` ← `manager.cancel(opId)`；
插件卸载 ← `manager.dispose()`。

可选引擎参数（不属 ICD，仅供接线方调优）：`chunkTimeoutMs`（默认 60 s）、
`restoreTimeoutMs`（默认 10 s）、`progressByteThreshold`（默认 1 MiB）、`preserveMode`（默认 off）、
`linkRetry`（默认 `{ attempts: 1, concurrency: 1 }`，链路类失败的有界续传重试，见 §2.9；
`TransferManager` 也接受同名参数并透传）。

---

## 4. 自测结果

> 环境：Windows Server（`win32`），Node `v24`，项目根 `dsh-ssh/`。命令均在项目根执行。

### 4.1 类型与构建

| 命令 | 结果 |
|---|---|
| `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **0 错误**（全包） |
| `node node_modules/typescript/bin/tsc -p tsconfig.json` | 成功产出 `lib/sftp/**`、`lib/tools/files.js`（emit 前先确认 0 错） |
| `node --test --test-concurrency=1 --test-force-exit "test/unit/sftp*.test.mjs"` | **79 项 / 76 pass / 0 fail / 3 skip（真机 opt-in）/ ≈30 s** |
| `node scripts/lint.mjs` | 我的文件 **0 条**（全仓 0 error） |

### 4.2 单元测试（6 个文件）

| 命令 | 结果 |
|---|---|
| `node --test --test-concurrency=1 test/unit/sftp-progress.test.mjs` | **10/10** |
| `node --test --test-concurrency=1 test/unit/sftp-transfer.test.mjs` | **26/26** |
| `node --test --test-concurrency=1 test/unit/sftp-client.test.mjs` | **18/18** |
| `node --test --test-concurrency=1 test/unit/sftp-tools.test.mjs` | **12/12** |
| `node --test --test-concurrency=1 test/unit/sftp-adapter.test.mjs` | **12/12**（对 sp8 的**真实协议** sshd 靶机） |
| `node --test --test-concurrency=1 test/unit/sftp-real.test.mjs` | **0/3 通过，3 跳过**（无环境变量时带理由 skip，见 §4.4） |

**汇总（Lead 的收工命令）：**

```
node --test --test-concurrency=1 --test-force-exit "test/unit/sftp*.test.mjs"
→ tests 79 | pass 76 | fail 0 | skipped 3 | duration_ms ≈ 30 000
```

**总时长回到数十秒量级，无任何 60 s 超时。**

### 4.3 100 MiB 验收（用户硬性验收项）

`test/unit/sftp-transfer.test.mjs`，**真实跑满 104 857 600 字节**（非稀疏、非内存假象）：
本地与「远端」都由真实临时目录承载，块 256 KiB、并发 4、`verify:'sha256'`。

| 方向 | 耗时 | 平均吞吐 | 进度帧 | 最大并发流 | sha256 |
|---|---|---|---|---|---|
| upload | **2751 ms** | 36.5 MiB/s | 44 | 4 | 本地 == 远端 |
| download | **1823 ms** | 55.0 MiB/s | 39 | 4 | 本地 == 远端 |

> 帧数从早期的 107 降到 44/39，是因为进度改为**按 durable 前缀**计数（§2.8）：4 条区间各完成一次
> 才让 durable 前缀前进一次，于是 100 MiB 落在几十帧上。这仍然证明合并生效（不合并会是 400 帧），
> 而且 `transferred` 现在严格等于"本次操作已确证落盘的字节"。

每条用例同时断言：字节数与 `totalBytes` 精确；两侧 sha256 与独立计算的源哈希三方一致；
进度帧**单调不减**、每帧 `totalBytes` 不变、**末帧正好落在 total**；帧数 `>=5 且 <260`
（不合并会是 400 帧，反证合并生效）；阶段含 `scan/transfer/verify`；`maxActiveStreams >= 2`
（真实并发）；成功路径无截断、探测临时文件已清理。数字随机器负载浮动（并发跑时会降到
~20 MiB/s），量级与单调性结论不变。

> 「≥200 ms 或 ≥1 MiB」的**精确**规则由 `sftp-progress.test.mjs` 用手动时钟逐条断言
> （真时钟断言既慢又不稳）。

### 4.4 真机（opt-in）验收

`test/unit/sftp-real.test.mjs` 直连真机（`ssh2` Client → 原始 `SFTPWrapper` → 我们的
`createSftpHandle` → 引擎），三条用例：

1. **100 MiB 上传 + 100 MiB 下载**，三重校验：本地哈希、引擎经 SFTP 读回哈希、
   **远端 `sha256sum` 输出**；并断言进度帧单调、末帧等于 total、阶段齐全；
2. **符号链接**：用 `ln -s` 造链（不用 SFTP SYMLINK —— 见 §4.6），断言适配器把链报为链、
   `readlink` 回填 target、walk 默认不跟随、`followSymlinks` 时按目标类型解析；
3. **中途中止 + 续传**：8 MiB 上传，**第一个 durable 字节落地即 `abort()`**（进度按 durable 前缀
   计数，这是最早且必然处于「传输中」的时刻），断言 `SSH_SFTP_TRANSFER_ABORTED` 且
   `stat(远端).size === details.resumedFrom`，续传后与远端 `sha256sum` 一致。

**每一阶段都有计时与字节数**（`StageLog`）：`mkdir + payload → local sha256 → upload → stat →
remote sha256sum → download → local compare → cleanup`；成功走 `ok`，失败走 `FAIL` 并把阶段名挂在
`error.stage` 上，`after()` 里无论如何都会打印这张表。真机失败不再是「某某 ms 后抛了个传输错误」，
而是「**哪一阶段**、花了多久、传了多少字节」。

**清理在失败路径上也必须成立**（真机吃过亏：两次失败留下 201 MB）：

- `after()` 里总是清理远端，且**用一条新连接**（`cleanupRemote`）——传输用的那条连接往往正是坏掉的那条，
  依赖它的清理就是 201 MB 残留的来源；
- 清理后 `assert` 断言目录真的不存在（不是「命令发出去了」就算）；
- 开跑前扫掉 `/tmp/dsh-ssh-test` 下**超过 120 分钟**的旧目录（`sweepStaleTrees`），并打印剩余占用——
  上一次失败留下的 201 MB 会在下一次真机运行时被自动收走。

**本地临时目录的规则（血泪教训）**：只由创建它的那次运行删除（`clearLocalScratch(localDir)`），
**永不做前缀 glob 回收**。理由不是洁癖：**一个正在传输的目录，对另一个进程来说和"陈旧目录"长得一模一样**。
真机上已经发生过一次——28 秒的上传跑到一半，`%TEMP%\dsh-ssh-real-*` 被按前缀清掉；Node 的
`FILE_SHARE_DELETE` 让已打开的句柄继续工作（所以上传看着还在跑），而验证阶段重新 `open()` 本地源时
拿到 ENOENT，报成一个看起来像传输 bug 的本地错误。因此：

- 每个运行在本地目录写 `.dsh-run-active`（pid + 起始时间），人工/其他 agent 清理前先看标记；
- 各用例的本地前缀互不为前缀（`dsh-ssh-real-100mib-` / `dsh-ssh-real-resume-`）；
- 上传期间**每一帧都校验源文件**（`sourceGuard`：size + inode），消失/被替换立即改写成
  `the local payload could not be read for the whole upload: it vanished (ENOENT) after N bytes`；
- 上传后再验一次 `source unchanged`（size + inode + 重新算 sha256）；
- 引擎侧：verify 阶段本地读失败映射为 `{side:'local', path:<本地路径>}`，不再读起来像传输故障。

运行方式（**必须显式开环境变量**；密码只从环境变量读、绝不落盘）：

```powershell
$env:DSH_SSH_TEST_REAL_HOST='<host>'; $env:DSH_SSH_TEST_REAL_USER='<user>'
$env:DSH_SSH_TEST_REAL_PASSWORD='<password>'   # 或 DSH_SSH_ROOT_PASSWORD
node --test --test-concurrency=1 --test-force-exit --test-timeout=600000 test/unit/sftp-real.test.mjs
```

**本次自测状态：真机用例未执行**（本会话环境无这 4 个变量，密码按纪律不入仓库）。
缺变量时三条用例**带明确理由 skip**，不静默通过。真机事实见 `docs/REAL-TARGET.md`；
写入严格限制在 `/tmp/dsh-ssh-test/<runId>/`，且成功/失败都会清理并断言。

### 4.5 覆盖到的行为（对应验收条款）

| 行为 | 用例 |
|---|---|
| 上传/下载字节一致 | 100 MiB 验收用例；递归用例逐文件哈希；真实协议靶机上的 2 MiB 往返 |
| 进度条正确 | 帧单调、末帧==total、阶段齐全、合并上界；手动时钟精确规则 |
| 校验一致 | `sha256` 双向比对；**故意写坏 1 字节**时 `sha256` 报错而 `size+mtime` 放过 |
| 断点续传 | 上传续传（目标 size）/ 下载续传（本地 size）/ 等长视为已传完；真实靶机上 truncate 后续传 |
| 冲突 | `SSH_SFTP_TARGET_EXISTS` + `overwrite`/`skip`/`rename`/`cancel` 四决策 |
| 中止可续传 | 上传与下载各一条；错误码、`resumable`、`resumedFrom` 对齐、目标长度==durable 前缀、续传后哈希一致 |
| 断链不死等 | 断链后由 `chunkTimeoutMs` 终结并报 `resumable:false` + hint（真实靶机 `dropAll()`）；`neverAckWrites` 假句柄上的快速回归 |
| ssh2 事件语义 | `suppressFinish` 假句柄 + 真实靶机：不依赖 `finish` 也能完成；零字节文件创建路径 |
| 递归目录 | 结构保留、逐文件哈希一致、符号链接默认 skip（含 follow 开启与深度护栏）、真实靶机上往返 |
| 降级路径 | 探测路径（不声明能力→行为探测）、声明 false、无 truncate → 单区间顺序写且结果正确 |
| 契约码 | 每个失败路径 `err.code` 是**字符串**且属于 `ERROR_CODES`（含流 error 事件）；`createWriteStream/createReadStream` 不传 `opts` 也能用 |
| 链路类失败分类 | `SSH_UNKNOWN` + "No response from server" 被识别为**中断**（`ABORTED` + `details.causeCode/causeMessage`），不是无从下手的 UNKNOWN |
| 有界重试 | 假句柄注入一次链路失败 → 恰好重试一次、并发降到 1、`totalBytes` 不变、`transferred` 单调且恰好等于文件大小、续传后哈希一致；确定性失败（冲突）**零次重试** |
| 校验阶段断链 | 真实靶机上在 verify 阶段 `dropAll()`：报 `SSH_SFTP_TRANSFER_ABORTED` + `causeCode`，20 s 内有界结束、进程不崩 |
| 真机分阶段日志 | 每个阶段输出耗时/字节/吞吐；失败时打印阶段表并标出首个失败阶段 |
| 失败路径远端清理 | `after()` 用**新连接**清理并断言目录消失；开跑前扫掉 >120 min 的陈旧目录 |
| 源文件中途消失 | 假句柄：上传中删除本地源 → `SSH_SFTP_NO_SUCH_FILE` + `details.side='local'` + 本地路径（不是"传输故障"） |
| 真机源完整性 | 上传期间逐帧校验源 size+inode，丢帧即报 `it vanished (ENOENT) after N bytes`；上传后再验 `source unchanged`（size+inode+sha256） |
| 工具契约 | 三个工具 schema 通过 `assertSupportedJsonSchema`/`assertObjectJsonSchema`，**每个返回值**通过 `validateJsonSchemaValue` 自校验；拒绝信封、超时中止、调用方取消、列表截断、进度日志节流、抛异常的 logger 不影响结果 |

### 4.6 真实协议靶机逼出来的 3 个坑（价值最高的部分）

`test/unit/sftp-adapter.test.mjs` 对 sp8 的 ssh2 协议级靶机跑，抓到了三个「假句柄永远抓不到」
的问题（因为 `node:fs` 流与内存假象都太理想）：

1. **ssh2 SFTP `WriteStream` 从不发 `finish`** → 每次上传永久挂起。修法：`close` 与 `finish`
   都算完成（`node:fs` 流只发 `finish`）。已加 `suppressFinish` 假句柄回归。
2. **对端消失时 ssh2 不回调挂起的写请求** → worker 永久等待、错误永不上报、文件句柄泄漏到 GC
   告警。修法：`chunkTimeoutMs` 每块截止（默认 60 s，测试里 1.5 s）。
3. **零字节文件的创建路径**（空写 + end）依赖事件语义，与 1 同因，一并回归。

另外：`dropAll()` 断链后 `setstat` 截断不可达 → 首次实现了「修不回来就撤回续传承诺」的语义。

### 4.7 task-13：真机 100 MiB 失败的定位与修复

Lead 的真机实测事实：上传成功（残留 201 MB），失败在**上传之后**，错误是
`SSH_UNKNOWN / "No response from server"`（ssh2 在通道带未完成请求关闭时报的），耗时 89 s / 181 s 波动；
另两条真机用例（符号链接 4.9 s、中止续传 27 s 且 sha256 匹配）通过。

已排除：服务器磁盘 158 MB/s、sshd 无 `ClientAlive*`/`MaxSessions` 覆盖、`ulimit -n` 1024、
本地同规模靶机 45.6/82.4 MiB/s 从不失败 → **引擎逻辑没问题，是长连接在高延迟链路下的交互**。

据此修的点（每条都有回归）：

| 问题 | 修法 | 回归 |
|---|---|---|
| 100 MB 读回是**单条无界流**：链路上任何一次抖动都让它带着一堆 pending 请求掉线，且没有 deadline | `digestRemote` 改为按块（默认 1 MiB）读，每块有 `chunkTimeoutMs` 截止、可中止 | 真实靶机 verify 阶段 `dropAll()` 用例 |
| 「No response from server」被当成 `SSH_UNKNOWN` 汇报，无从下手且**不会触发重试** | `isLinkClassCode()` 把它分类为**链路中断** → `SSH_SFTP_TRANSFER_ABORTED` + `details.causeCode/causeMessage` | 假句柄注入同名错误 |
| 链路抖动直接失败，没有第二次机会 | 有界重试一次 + 并发 4→1，从 durable 偏移续传（`totalBytes` 不变、进度单调） | 注入一次链路失败：恰好重试一次、并发 1、哈希一致 |
| 晚到的流错误 → unhandled `error` → 进程崩 | 引擎创建的每条流挂永久 no-op `error` 监听 | 断链用例（进程存活即证明） |
| 重试会把「写过但未 durable」的字节**重复计数**（4 MiB 报 4.75 MiB） | 进度改为按 **durable 前缀**增量计数（`reportDurableProgress`） | 重试用例断言 `transferred === 文件大小` 且全程单调 |
| 失败路径不做远端清理 → 201 MB 残留 | `after()` 用**新连接**清理 + 断言目录消失 + 开跑前扫 >120 min 陈旧目录 | 真机用例的 cleanup 阶段（会打印在阶段表里） |

---

## 5. 遗留问题与已知缺口

1. **`verify:'size+mtime'` 只能强制 size**。ICD §7.2 的句柄没有 `utimes`/`setstat(path,{mtime})`，
   目的端 mtime 永远是写入时刻，比较 mtime 无意义（`#verify` 内有注释）。
   建议：要么在 ICD 里把该模式明确为「size 校验」（已按此实现），要么给句柄补可选 `utimes?`。
2. **`truncate?` 是 `start`/`supportsOffsetWrite` 之后的第三个增量可选成员**（已向 Lead 报备）。
   未实现时上传退化为单区间顺序写（正确、较慢），不影响任何验收项。
3. **`ENOTEMPTY` 没有对应 ICD 码**：`remove` 非递归删非空目录会映射到 `SSH_UNKNOWN`
   （`details.errno='ENOTEMPTY'`）。建议补码或明确归入 `SSH_PERM_DENIED`。
4. **`resumedFrom` 在目录传输的握手里恒为 0**：单文件会在返回前 `stat` 出精确值；目录若要在
   返回前算出来就得先扫完整棵树（延迟与树规模成正比）。目录的续传量在 `scan` 阶段写进
   `TransferTaskRecord.resumeFrom`，UI 从 `listTransfers` 读。
5. **`preserveMode` 默认关闭**：ICD 的 `upload` 参数里没有该字段，wire 路径用不到；
   仅引擎/工具可选（默认 off）。若 UI 需要「保留权限位」，需要 ICD 加参数。
6. **sp8 靶机的 `READLINK` 目前必失败**：`test/support/sshd.mjs` 里
   `sftp.name(reqid, readlinkSync(realPath))` 传的是字符串，而 ssh2 服务端 `name()` 需要
   对象/数组 → 每次都回 `FAILURE 4 (names is not an object or array)`。已向 Lead 报备；
   我的适配器对此**优雅降级**（仍报 `symlink`，`target` 为 `undefined`，不抛错），
   符号链接 target 的正路径改由真机用例（`ln -s` + OpenSSH）覆盖。
7. **真机 100 MiB 失败（task-13）**：已定位到「上传之后的回读/校验链路中断」，修复见 §2.9
   （分阶段日志、链路类失败分类与有界重试、chunked 读回、晚到错误兜底、失败路径远端清理）。
   **验收复跑仍待凭据执行**（本会话无 4 个环境变量，见 §4.4）；`ssh2` 的 `cpu-features`
   原生构建被跳过，真机吞吐可能低于纯 JS 上限（M0-SPIKE §6 已记录）。
8. **`sftp.maxConcurrentChunks` 建议保持 4**：真机两次运行的上传阶段都成功（各留下约 100 MB），
   证明 4 路区间写在真机链路上可用；失败发生在之后的读回阶段。重试会自动降到 1 路作为保险。
   若真机复跑仍失败，降到 1 是一行配置（代价：本地靶机 4 路 45/82 MiB/s → 约慢 3–4 倍，仍达标）。
