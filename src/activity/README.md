# `src/activity` —— Agent 活动镜像（ICD §4.7）

> 归属：本模块 owner（`src/activity/**`）· 契约来源：`docs/ICD.md` §4.7（正文见 §5 遗留问题）、§3（帧）、§6（`activity.*` 配置）· 语言：代码/注释英文，文档中文

本模块提供 `ActivityFeed`：一个**有界的内存环**，记录模型经 `ssh_*` 工具做过什么，
并把「开始 / 一段输出 / 结束 / 历史被清空」投射成 §3 的活动事件。
它**不**碰传输：事件到帧的映射与订阅由 Lead 的 `src/api/activity-api.ts` 负责，
工具的埋点在 `src/tools/*.ts`，两侧都只依赖 `feed.ts` 的公开接口。

---

## 1. 文件与职责

| 文件 | 职责 |
|---|---|
| `feed.ts` | `ActivityFeed` + `ActivityHandle`：记录生命周期、段合并、两级文本预算、记录淘汰、订阅广播。**唯一**产出 `ActivityEvent` 的地方 |
| `../../src/api/activity-api.ts`（Lead） | `followActivity`（先发 `activity-snapshot` 再转发事件）、`clearActivity` |
| `../../src/api/runtime.ts`（Lead） | 按 `config.activity` 构造 feed；插件卸载时 `activity.dispose()` |
| `../../src/tools/*.ts`（peer） | 调用点：`begin` / `chunk` / `finish` |

## 2. 一条记录的一生

```
begin(input)                     chunk(channel, text)…            finish(input)
   │                                   │                              │
   ├─ id = act-N（单调，永不复用）      ├─ 同频道相邻段合并             ├─ status/endedAt/durationMs
   ├─ status:'running'                 ├─ 超出 maxRecordBytes →        │  /exitCode/signal/code/note
   ├─ startedAt = now()                │  丢尾部 + truncated = true    ├─ truncated 只置位、不清除
   ├─ segments: []                     ├─ 无空间可留 → 不追加、不广播   ├─ text → 单独一个 info 段
   └─ 事件 begin（深拷贝）              └─ 事件 chunk（只带留下的文本）  └─ 事件 end（整条记录）
                                                                            │
                                                        finish 之后一切写入被忽略（记录已封存）
```

- **`begin` 之后**：记录立刻可被 `snapshot()` 读到（早于任何输出），UI 不会等到命令结束才看见它。
- **`finish` 之后**：`chunk` 被忽略（不抛错、不入环、不广播）。`finish` 幂等：第二次调用不改任何字段、不发第二个 `end`。
- **`clear()`**：只丢**已结束**的记录，返回丢掉的条数；正在跑的留在环里。
- **`dispose()`**：不再产出（`begin` 发惰性句柄、事件不再投递），并**释放**已捕获的文本。

## 3. 关键设计决定（附理由）

### 3.1 三条预算，因为三个方向的膨胀都要挡住

| 预算 | 默认 | 挡住的场景 |
|---|---|---|
| `maxRecords` | 200 | agent 反复调用短命令：记录条数无限增长 |
| `maxRecordBytes` | 65536 | 一条命令输出打不完（`tail -f`、构建日志）：单条记录的文本无限增长 |
| `maxTotalBytes` | 1048576 | 每条都「不算大」但条数多：整个 feed 的文本无限增长 |

三者都来自 `config.activity`（§6），不在这里写死常量——这是**唯一**在内存里持有远端原始输出的地方，
上限属于部署决策。

### 3.2 淘汰只动「已结束」的记录，且字节预算**不清空环**

- 记录是否算「已结束」看 `endedAt !== null`，**不看 `status`**：调用方完全可能传
  `status:'running'` 进 `finish`（类型允许），若按 status 判定，这条记录会永远不可淘汰。
- 环满时按「最老的已结束记录」先走；**正在跑的永远不是候选**——用户此刻正盯着它。
- 字节预算额外多一条：**当环里只剩一条记录时停止淘汰**。单条记录大于整个 feed 预算时它必须留下
  （否则用户刚看到的记录会被自己的体积立刻抹掉，面板直接空白）。代价是内存可能短暂超过
  `maxTotalBytes`，上限由 `maxRecordBytes` 兜住：最多 `maxRecordBytes` 级别的超出。
- **淘汰是静默的**（不发任何事件）：它每天都在发生，广播会让面板抖动。真正宣告「你的副本过期了」
  的操作只有 `clear()`，见 §3.6。

### 3.3 每个事件都是深拷贝，`chunk` 只带「真正留下的文本」

`snapshot()`、`view()`、每个事件的载荷都是新对象（含逐段拷贝 `segments`）：调用方怎么改都碰不到环。
这不是洁癖——`followActivity` 的消费者在**另一个线程式的生命期**里（页面的 store），
一旦能改到 host 的对象，host 的 `snapshot()` 与页面显示的就会永久分歧。

同理，`chunk` 事件携带的是**实际追加进环的那一段**：文本被 `maxRecordBytes` 截断时，
广播的是截断后的前缀，一个字都不多。这样「客户端按 delta 打补丁」与 host 的 `snapshot()` 逐字节一致；
若广播了没留下的文本，客户端副本会比 host 大，且再也不会被纠正（`end` 帧虽然会整条替换，
但中间的每一帧都在撒谎）。

### 3.4 段合并规则与「结束即封存」

同频道**且记录仍在运行**时，新文本并入上一段；否则新开一段。
合并让一次 `ls -l` 的输出是 1 个段而不是 200 个段（快照体积直接决定面板的重绘成本）。

「仍在运行」这个条件是**必需**的，不是顺手的：`end` 帧已经把整条记录交给订阅者了，
此后再合并就是**改写订阅者手上的数组**。它同时保证了 `finish({text})` 的文本必然成为
**独立的一段**——接口约定的是「one final `info` segment」，所以 `finish` 先落终态
（`endedAt`）再追加这段文本。

### 3.5 文本按 UTF-8 字节计费，且不切断多字节字符

`maxRecordBytes`/`maxTotalBytes` 的名字就是字节，所以计费走 `Buffer.byteLength(text,'utf8')`，
不是 `String.length`（中文一个字 3 字节、emoji 一个 4 字节，按码元计费会让「64 KiB」的实际线上体积差 3 倍）。

截断点必须落在**字符边界**上：缓冲区停在一个多字节序列中间会解码出 U+FFFD，
等于把用户命令从没打印过的替换字符画进终端画面。实现是回退连续的续字节（`10xxxxxx`），
停在没放下的那个字符的首字节上——留下的每个字符都是对端真的发过的。
（`src/exec/encoding.ts` 处理的是同一类问题的流式版本。）

### 3.6 `clear()` 是唯一会宣告「你的副本过期了」的操作

`ActivityEvent` 里的 `{t:'activity-reset'}` 只有 `clear()` 会发（`src/api/activity-api.ts` 用它转成同名帧）。
两处细节：

- **只在真的丢掉了记录时才发**。一次没丢任何东西的 `clear()` 没有要纠正的东西，
  而此时让客户端清空自己的列表，反而会把它正在画的**运行中**记录也一起抹掉。
- reset 之后客户端手上只剩 host 还留着的运行中记录，这些记录结束时会带**整条记录**的
  `end` 帧回来，视图自行恢复。

### 3.7 `enabled:false` 与 `dispose()` 共用一个惰性路径

`enabled:false` 时 `begin` 直接返回惰性句柄（`chunk`/`finish` 空操作），环保持空，
所以 `snapshot()===[]`、`size()===0`、零事件是**结构性**的，而不是逐处判断出来的。
句柄的 `view()` 仍然回答一份格式合法的「如果记录会怎样」的快照（`status:'running'`、空段），
调用方不需要为关闭状态分支。

`dispose()` 做同一件事，外加释放已捕获的文本：卸载之后没有人再需要它，
而这是唯一在内存里持有远端原始输出的地方。

### 3.8 镜像绝不抛异常

`begin`/`chunk`/`finish` 对**任何**输入都不抛：这是本模块存在的理由——
它观察的是别人的操作，观察者失败绝不能把被观察的操作带下去。

- 调用方给的值要经过词表校验：不在冻结词表里的 `kind` → `exec`；不在词表里的 `status` → `error`
  （**绝不为看不懂的结果报成功**）；不在词表里的 `channel` → `info`（文本是真的，丢掉更糟）；
  非字符串的 `text` 直接忽略（`[object Object]` 画进终端比少一行更糟）。
- **先读完再落笔**：`begin` 先把输入读完才入环，`finish` 先把所有字段读进局部变量才改记录。
  取值本身抛异常（instrumented tool 代码可能给出带 getter 的对象）时，结果是「什么都没发生」：
  `begin` 回滚并把句柄降级为惰性句柄，`finish` 留下一条仍在运行的记录——而不是一条**已经终态、
  但 `end` 帧从未发出**的记录（那种记录没有任何东西会来纠正它，面板会永久转圈）。
- 订阅者抛异常只计数、只 `logger.warn`，不影响其它订阅者，也不影响产生事件的那次 SSH 调用
  （与 `src/audit.ts` 的订阅规则一致）。
- `logger` 自己抛异常也被吞掉——否则「坏掉的日志」会成为违反上一条的第二条路径。
- `now()` 返回非有限值时退回 `Date.now()`，`endedAt - startedAt` 为负时夹到 0：
  NaN 时间戳与负时长在面板上只能渲染成乱码。

## 4. 对外接口（wire 层 / 工具侧接线用）

```ts
const activity = new ActivityFeed({
  enabled: config.activity.enabled,
  maxRecords: config.activity.maxRecords,
  maxRecordBytes: config.activity.maxRecordBytes,
  maxTotalBytes: config.activity.maxTotalBytes,
  logger: log,                       // 可选
  now: () => Date.now(),             // 可选：只有单测会注入，生产用默认时钟
})
```

| 成员 | 说明 |
|---|---|
| `readonly enabled: boolean` | 关掉时一切记录操作都是空操作 |
| `begin(input): ActivityHandle` | 开一条记录并广播 `begin`；关闭/卸载后返回惰性句柄 |
| `handle.view(): ActivityView` | 该记录的最新深拷贝（惰性句柄返回「未记录」的合法快照） |
| `handle.chunk(channel, text)` | 追加一段输出；空文本、结束后、无空间时都不广播 |
| `handle.finish(input)` | 收尾；幂等；`text` 作为最后一个 `info` 段 |
| `snapshot(): ActivityView[]` | 时间序，最老在前，全是拷贝 |
| `subscribe(listener): () => void` | 返回的退订函数可重复调用 |
| `clear(): number` | 丢已结束记录，返回条数；丢到了就广播 `activity-reset` |
| `size(): number` | 当前保留的记录数（含运行中的） |
| `dispose(): void` | 幂等；释放文本，停止产出 |

**事件 → §3 帧**（`ActivityApi.follow()` 已完成，这里只列映射）：

| feed 事件 | 帧 |
|---|---|
| 订阅时的 `snapshot()` | `{t:'activity-snapshot', activities}`（**第一帧**，避免「订阅与取当前态之间开始的记录永远不被宣告」） |
| `{t:'activity', phase:'begin'\|'end', activity}` | 同名帧 |
| `{t:'activity', phase:'chunk', id, chunk}` | 同名帧 |
| `{t:'activity-reset'}` | 同名帧 |

工具侧的典型用法（peer 的埋点）：

```ts
const handle = activity.begin({ kind: 'exec', sessionId, subject: command, cwd, target })
try {
  for await (const part of output) handle.chunk(part.channel, part.text)
  handle.finish({ status: 'ok', exitCode: 0 })
} catch (error) {
  const info = toErrorInfo(error)
  handle.finish({ status: info.code === 'SSH_CANCELLED' ? 'cancelled' : 'error', code: info.code, note: info.message })
}
```

**本模块不做的事**：不落盘、不脱敏、不做背压、不重放（重连由 `followActivity` 重新订阅 +
`activity-snapshot` 解决）、不决定 UI 策略（是否自动切到活动页属于 §6 `activity.follow` 的配置与视图的决定）。

## 5. 自测结果

命令（工作区根目录 `dsh-ssh/`）：

```
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.json
node --test --test-concurrency=1 --test-force-exit --test-timeout=60000 test/unit/activity-feed.test.mjs
```

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 本模块 **0 错**；同期 `src/api/tools.ts` 有 2 条报错（peer 正在给 `FilesToolDeps`/`SshExecToolDeps` 加 `activity`，不是本模块的文件） |
| `tsc`（构建） | 产出 `lib/activity/feed.js` + `.d.ts`（同上 2 条他人报错，不影响 emit） |
| `test/unit/activity-feed.test.mjs` | **28 用例全绿**（0 fail / 0 skip，≈0.4 s） |
| `eslint test/unit/activity-feed.test.mjs` | 0 问题 |

覆盖到的行为（每条都对应 §3 的一个决定）：

| 要求 | 用例 |
|---|---|
| id 单调、`clear()` 后不复用 | `ids are monotonic per feed and never reused after clear` |
| `begin` 的字段与深拷贝 | `begin retains a running record and announces a deep copy`、`begin normalises the optional fields to null…` |
| 段合并 / 空文本 / 结束后忽略 | `chunks merge into the previous segment…`、`an empty chunk is a no-op`、`chunks after finish are ignored` |
| 单条上限与多字节边界 | `the per-record cap keeps the head, drops the tail and flags it`、`the cap never cuts a multi-byte character in half`（4 字节预算下 `中文字` 只留 `中`；3 字节预算下 emoji 一个都不留） |
| `finish` 字段 / 幂等 / `truncated` 或运算 / 尾段文本 | `finish sets the terminal fields…`、`a failed call keeps its code, signal and status`、`a second finish changes nothing and emits nothing`、`finish ORs the truncated flag…`、`finish text lands as one final info segment…` |
| 条数淘汰、运行中不被淘汰 | `finished records beyond maxRecords are dropped oldest first, running ones stay`、`maxRecords 0 keeps only what is still running` |
| 字节淘汰、单条超预算留下 | `the feed-wide text budget evicts oldest finished records until it fits`、`a single record larger than the whole budget stays`、`eviction never drops a record that is still running` |
| 快照不可变 | `snapshot returns deep copies of records and segments` |
| 订阅者隔离 / 退订幂等 / 坏 logger | `a throwing subscriber breaks neither the producer…`、`unsubscribe stops delivery and is safe to call twice`、`a logger that throws cannot break the operation` |
| `clear()` 语义与 reset 帧 | `clear drops every finished record, keeps running ones and announces the reset` |
| 关闭模式 | `enabled false records nothing and emits nothing` |
| `dispose()` | `dispose is idempotent, finishes nothing and stops delivery` |
| 任何输入都不抛 | `begin, chunk and finish never throw, whatever they are handed`、`an input whose getters throw is recorded as nothing, not as a failure`（proxy 的 getter 抛异常：`begin` 不入环、返回惰性句柄；`finish` 第一个字段就抛与第 N 个字段才抛都不留半个终态，记录之后仍可正常 `finish`）、`timestamps come from the injected clock and a backwards clock is clamped` |

## 6. 遗留问题与已知边界

1. **`docs/ICD.md` 里还没有 §4.7 正文**：协议字面量（`protocol.ts` 的帧与 `ActivityView`）、
   配置（`config.ts` 的 `activity.*`）、端点（`service.ts` 的 `followActivity`/`clearActivity`）
   都已经在仓库里按「§4.7」写好并互相引用，但 ICD 正文（`§4.6` 之后没有 `§4.7`）尚未补上。
   本期写作用域不含 `docs/ICD.md`，已上报 Lead。
2. **淘汰是静默的，客户端可能比 host 记得更多**：被淘汰的已结束记录不会再有任何帧，
   页面会继续显示它，直到用户 `clearActivity` 或重连（重连会拿到新的 `activity-snapshot`）。
   这是 §3.2 与 §3.6 权衡的直接结果：每个会话都广播淘汰会让面板抖动，而 host 的 `snapshot()`
   只承诺「我保留了这些」。
3. **`clear()` 的 `reset` 帧会让页面丢掉运行中记录的**当前**文本**：它们仍会在结束时以整条
   `end` 帧回来（§3.6）。若 UI 希望「清空只清历史」，需要在视图侧区分，host 不额外提供语义。
4. **不做脱敏**（这是刻意的，见模块头注释）：命令把密钥打印到 stdout 时，活动页会显示它；
   脱敏后的 durable 记录是 `src/audit.ts` 的审计文件。若将来要求活动页也脱敏，
   应该在 `chunk()` 入口接 `Redactor`，而不是在各工具调用点各写一遍。
5. **没有背压**：`chunk` 是同步追加 + 同步广播。当前消费者是进程内的帧队列，
   若将来出现「页面消费慢」的量级，要在 `ActivityApi` 与传输之间加窗口，
   而不是在本层丢掉文本（那会让客户端副本与 `snapshot()` 分歧，见 §3.3）。
6. **`maxRecordBytes` 与 `maxTotalBytes` 是字节，`snapshot()` 的 JSON 会更大**
   （JSON 转义、段结构开销）：上限是**内存**护栏，不是线上体积的精确预算。
