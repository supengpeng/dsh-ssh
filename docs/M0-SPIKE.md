# M0 传输探针报告（Transport Spike）

> 版本：v1.0.0 · 执行者：主代理（Lead）· 状态：**已打通（等待 UI 侧 ping 结果确认）**
> 本文件是 M0 里程碑的验收证据，也是 ICD v1.0.1 修正的依据。

---

## 1. M0 目标

在派发 8 个子代理**之前**，消除两个会让全体返工的未知：

| 未知 | 风险 | 结果 |
|---|---|---|
| **U1** 非仓库内插件能否把客户端 bundle 载入浏览器并注册到右侧栏 | 整个 UI 方案不可行 | ✅ **已证实可行** |
| **U2** 浏览器 → host 的调用通道形态（DSH Remote RPC 是否可用） | 全部数据交互不可行 | ✅ **主通道已定位**（`ctx.remote.<ns>`，源码模式发现） |
| **U3** 本地插件能否**免重启**装入正在运行的 GUI | 每次迭代需重启（会杀掉会话） | ✅ **证实免重启**（patch 层热重载 + `link:` 依赖） |

---

## 2. 实测证据（不是推断）

### 2.1 host 半边已激活

```
plugin_manager list_plugins →
{ "entryId": "include:dsh-ssh", "moduleName": "@local/dsh-ssh",
  "enabled": true, "fiberPhase": "active", "patchId": "dsh-ssh" }        ← total 192 → 193
```

```
Config.listConfigs { name: "@local/dsh-ssh" } →
{ "id": "include:dsh-ssh", "patchId": "dsh-ssh",
  "name": "@local/dsh-ssh", "status": "schema" }
```

`status: "schema"` 表示该行的 **Config 已被 Loader 用我们自己的 Schemastery schema 投影**，
即 `src/index.ts` 的 `apply()` 已被调用、服务注册成功。**无需重启 DSH。**

### 2.2 客户端半边已在真实页面注册

`client Slots.listSubTree`（由**正在运行的页面**回答）：

```
sidebar.panellist occupants:
  { id: "plugins", order: 0,  active: true }
  { id: "ssh",     order: 60, active: true }      ← 本插件（**随后已移除**，见 C1）

sidebar.right.pane.tab occupants:
  { key: "@deepseek-ai/dsh-client-ui-sidebar-right/guide" }
  { key: "@deepseek-ai/dsh-client-ui-sidebar-documentpreview" }
  { key: "@deepseek-ai/dsh-client-ui-sidebar-terminal" }
  { key: "@deepseek-ai/dsh-client-ui-sidebar-files" }
  { key: "@deepseek-ai/dsh-client-ui-sidebar-browser" }
  { key: "@deepseek-ai/dsh-client-ui-subagent" }
  { key: "@deepseek-ai/dsh-client-ui-deliverables" }
  { key: "@deepseek-ai/dsh-client-ui-plan" }
  { key: "ssh", active: true }                    ← 本插件

shell.overlay occupants:
  { id: "ssh-spike", order: 999, active: true }   ← 诊断浮层
```

三条结论：
1. `lib/client.js` 被 `/plugins` 正确服务并被页面执行 → **手写 lazy-CJS bundle 格式成立**（U1 解除）。
2. `slots.inject` + `slots.register` 在该页面可用，且**新条目被 client-hmr 热装载，无需刷新页面**。
3. 客户端 bundle 的零 external 策略成立（只 `require("react")`）。

### 2.3 主机侧静态验证

| 检查 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit` | 通过（0 错误） |
| `remoteMethods(service)` | `ping`(direct)、`probeStream`(direct+stream)、`describe`(direct) —— **@Remote 标准装饰器标记成立** |
| 单元测试 `test/unit/**` | **33/33 通过** |
| 组件/契约测试 `test/client/**` | **17/17 通过** |
| bundle 重汇编一致性 | `build-client.mjs --check` 通过（确定性） |

---

## 3. 关键技术结论（供 8 个子代理直接使用）

1. **客户端 bundle 契约**（已实证）：
   `window.__ModuleLoader__.load({ id: '@local/dsh-ssh', factory: (require) => {...} })`，
   唯一外部依赖 `react`。不用 tsdown/rolldown，用自研汇编器 `scripts/build-client.mjs`。
2. **安装方式**（已实证，免重启）：profile 的 `package.json` 加 `link:` 依赖 → `pnpm install`
   → profile 的 `cordis.patch.yml` 加 insert 行。**不要**同时加入 `dsh.profile.bundles`（会产生重复行）。
   工具与回滚：`scripts/profile-install.mjs`（支持 `--step deps|patch`、`--status`、`--uninstall`、`--dry-run`）。
3. **Remote 端点**：host 侧 `bindTypertRemote(this, 'sshPlugin', { namespace: 'sshPlugin' })`
   + 标准装饰器 `@Remote` / `@Remote({ mode: 'stream' })`；
   客户端候选通道按序探测（`ctx.remote.<ns>` → `ctx.typert.remotes[<ns>]` → `ctx.connection.rpc`），
   **以真实 ping 往返为准**，全部尝试记录在 `bridge.diagnostics()`。
   > 选择 `bindTypertRemote` 而不继承 `TypertRemoteService`：后者继承的是**本包**安装的 cordis `Service` 类，
   > 而 host 树运行的是宿主自己的副本，跨副本类身份不可靠。
4. **升级路径**：`src/config.ts` 的 Config 已被 Loader 投影 → 配置项可随 `cordis.patch.yml` 覆盖。

---

## 4. ICD 修正（v1.0.0 → v1.0.1）

| # | 原 ICD 描述 | 实测修正 | 影响 |
|---|---|---|---|
| C1 | `sidebar.panellist` 作为 SSH 面板入口 | 该 slot 的 id 寻址**主栏面板**（"Each list id addresses the matching main panel"），点它会让主栏切到不存在的主面板 `ssh`；而 `conversation.session.header.corner` 是 **single** 槽位且**已被 shipped 侧栏展开按钮占用**（`replaceRisk: shadows-shipped-ui`），注册即替换，**禁止使用** | **SP5**：入口改用**加法型 list 槽位** —— 主入口 `sidebar.footer.action`（侧栏底部、Settings 旁，`replaceRisk: none`），次入口 `conversation.input.left`（composer 工具行）。`sidebar.panellist` 的注册已在 M0 收尾时**移除**（它会破坏主栏且无法打开我们的标签） |
| C2 | tab body 的 key 语义 | key = **标签类型的 `id`**（`tab.kind` → 生效类型 → 该类型的 `id`）；shipped 占用者以包名为 key | 我们的 `id: 'ssh'` 与 key `'ssh'` 一致，**保持** |
| C3 | 未知 | tab body 占用者会收到 `standardProps`：`sessionId`、`useChat`、`useConversation`、`useProjection`、`useTrajectory`、`useInput`、`inputActions`、`useSession`…，以及 `slotInject: SidebarRightTabInjected`（含 owner 声明的 `hooks.tabInfo`） | **SP6**：可直接用 `sessionId`/hooks，无需自造 |
| C4 | 未知 | `shell.overlay` **整层是 click-through**，占用者必须自行 `pointer-events:auto`，否则按钮不可点 | **SP5/SP7**：toast 栈与浮层必须设 `pointer-events:auto`（本插件已修） |
| C5 | 未知 | DSH 已自带 `dsh-client-ui-sidebar-terminal` 与 `dsh-client-ui-sidebar-files` 两个右侧栏标签（面向本地 workspace） | **SP6**：本插件的差异化是**远端主机 + 多会话**；视觉与交互**对齐** shipped 标签的既有范式，避免另起一套 |
| C6 | panel icon props | owner 传入 `{ size, active }` | **SP5**：图标必须用 `size`，不能写死 16px（已修） |

---

## 5. 尚未由主代理闭环的一项

**U2 的最终确认**：`bridge.resolve()` 的探测结果发生在**页面内**，主代理无法从 host 侧读取。
证据链已具备到"通道候选已就位、页面已执行我们的 apply"，剩下的一跳需要看页面上的诊断卡（浮层
右下角 "SSH plugin · transport spike"）或右侧栏 SSH 标签内的 `Run ping` 结果。

- 若显示 `carrier: remote-mount` + `pong: true` → 主通道成立，按 ICD 推进。
- 若显示其它 carrier id → 该 carrier 成立，`bridge.js` 已是最终形态（无需改 UI）。
- 若显示 `carrier: unresolved` → 退回到 ICD §1 的备用方案（认证栅栏内 exact-route），
  信封与帧格式不变，仅替换 `bridge.js` 内部实现。

---

## 6. 遗留与下一步

| 项 | 处置 |
|---|---|
| 浮层诊断卡（`ssh-spike`）是**临时**的 | M2 起改由日志标签页承载，M5 前移除浮层 |
| `/plugins/<pkg>/client.js` 直接 GET 返回 404 | 非阻塞：页面已成功装载该 bundle；URL 形态由 bundle rev/combo 决定，不做依赖 |
| `ssh2` 的 `cpu-features` 原生构建被 pnpm 策略跳过 | 非阻塞：ssh2 自动回退纯 JS 加密；若 100MB 传输成为瓶颈，再申请 `pnpm approve-builds` |
| 真实 Linux 靶机 | 等待用户提供 host/port/user 与认证方式（密码或私钥）；M1 起用于集成测试与 100MB 验收 |

---

## 7. 第二轮实测发现（对 8 个子代理影响最大的一节）

### 7.1 ✅ 传输**确实打通**（U2 关闭）

客户端**成功调用了 host 端点**并使其执行：`sshPlugin/reportSpike` 在 host 侧写出了
`<DSH_HOME>/logs/dsh-ssh/client-transport.json`（两次：22:33:03、22:34:11）。
即：`ctx.remote.sshPlugin.*` 这条候选通道在真实页面里可用。**这是 M0 最关键的结论。**

### 7.2 ⚠️ 参数保真度不足（**新的硬约束**）

客户端发送了一个 **6 键对象** `{carrier, ok, transport, attempts, serviceShapes, userAgent}`，
host 实收：

```json
{ "receivedType": "object", "receivedKeys": ["carrier", "ok"], "receivedIsNull": false,
  "parsedOk": true, "carrier": null, "ok": false,
  "transport": null, "attempts": [], "serviceShapes": null, "userAgent": null }
```

即：**只有两个标量键到达，`transport`（对象）、`attempts`（数组）、`serviceShapes`（对象）、
`userAgent`（字符串）全部丢失**。源码模式（`src-json` 弱编解码）下，"一个富对象参数"这条路径
不可信。

**因此 ICD §12 新增硬性规则**：M0.5 必须先确定并冻结一种"参数能完整到达"的约定，之后全体子代理
只允许按该约定写 wire。三个候选（按优先级）：

1. **单参数 JSON 字符串**：`call(method, JSON.stringify(params))`，host 侧 `JSON.parse`。
   已实现（`reportSpike(payload: unknown)` 同时接受对象与字符串），**待一次页面刷新验证**。
2. **注册严格描述符**：`ctx.typert.register(contribution)`（`@deepseek-ai/dsh-typert-registry` 的
   `InvocationDescriptor` 已在本地 `node_modules` 中，字段完整可读），让 Gateway 使用严格生成编解码。
3. **每字段独立标量参数**：最笨但最稳（已验证标量与 `null`/`false` 能到达）。

### 7.3 ⚠️ 宿主侧热更新语义未确认（dev loop 关键）

观察到的现象：
- 端点**行为**在两次重建后跟随了新代码（22:33、22:34 两次记录的字段结构不同）；
- 但 `apply()` 里的面包屑 `host-ready.json` 与模块级面包屑 `module-eval.json` **始终没有出现**；
- 改动 profile patch 中的**真实配置值**（420 → 421）也**没有**触发 `apply()` 重跑。

结论（待确认）：host 半边可能**不是**通过重跑 `apply()` 更新，而是端点解析时重新读取模块/源码。
对子代理的含义：**不要假设"改完 `src/**` 就一定生效"**；M1 第一项任务必须先确定 dev loop
（是否需要重启、是否需要 toggle 行），否则 8 路并行会互相误判"我的改动没生效"。

### 7.4 ⚠️ profile patch 是**共写**文件（协作风险）

工作期间 **DSH 自己重写了** `profiles/desktop/cordis.patch.yml`（22:27:53，安装 `preset-standard`
与 `agent-preset-registry`，文件 6.5KB → 15.2KB，并留下自己的备份 `bak-preset-standard-*`）。
我们**带标记的托管块存活了下来**（第 180–192 行，位置被推到中间），再次证明：

> **禁止整文件重写 profile patch。** 一切变更必须走 `scripts/profile-install.mjs` 的
> `# >>> dsh-ssh >>>` / `# <<< dsh-ssh <<<` 标记块增删，否则会吃掉用户/DSH 的其他配置。

### 7.5 其他

- 用普通 `js-yaml` 解析该文件会报 `unknown tag !<tag:yaml.org,2002:js>`——这是 DSH 的 `!!js`
  扩展（文档明确允许），**不是文件损坏**；校验时需容忍该 tag。
- 临时诊断面包屑（`module-eval.json` / `host-ready.json` / `client-transport.json`）保留至 M1
  接线加固完成，M2 起移除。

---

## 8. 补充（2026-09-27）：§7.3「宿主侧热更新语义未确认」**已结案**

§7.3 当年记录的是"端点**行为**看起来跟随了新代码，但 `host-ready.json` / `module-eval.json` 面包屑**始终没有出现**"，并把结论留成"待确认（host 可能不是通过重跑 `apply()` 更新，而是端点解析时重新读取模块/源码）"。

今天用**可复现的数字**查清了这件事 —— **结论与当年的猜测不同**。

### 8.1 测到了什么

| 观察对象 | 数字 | 取值方式 |
|---|---|---|
| 构建产物 `lib/service.js` | **44** 个 Remote 方法（含 `followActivity`/`clearActivity`） | 构造内建类实例后调 `remoteMethods(instance)` |
| 活着的 host 写的 `host-ready.json`（`at: 2026-09-27T04:44:42.447Z`，**在一次完整的 `plugin_manager` toggle 之后**） | **42** 个，**恰好缺** `followActivity`/`clearActivity` | 该文件由 `src/index.ts` 的 `recordHostReady()` 在每次 `apply()` 时写入 |

即：**重建的 host 半边没有进入运行中的 GUI**。那次完整 toggle 的结果是 `application: "applied"`，说明 `apply()` **确实重跑过**；但它重跑用的是**已缓存的旧模块**。所以当年"端点行为跟随新代码"的观察，更可能来自当时端点解析路径上的其它变量（含 §7.2 的富参数丢字段），**不是**"模块被重新导入"。

### 8.2 根因（与 §7.3 的猜测无关：是监视根本没生效）

shipped `hmr` 行的 `ignored` 默认值为 `['**/node_modules', '**/.*', 'cache', 'data']`，而监视谓词比较的是 `relative(baseDir, path)`，其中 `baseDir` 是 **profile 目录**、监视根却是它的**兄弟**目录（`…\.dsh\plugins\dsh-ssh`）。于是 Windows 上的相对路径形如

```
..\..\plugins\dsh-ssh\lib\service.js
```

picomatch **不把 `\` 当分隔符** ⇒ 整串是"一段以 `.` 开头的路径" ⇒ 被 `**/.*` 命中 ⇒ **整棵树被忽略**，重建 `lib/**` **不产生任何 reload 事件**。

三条对照测量（正斜杠同路径**不**被忽略；profile 内的 `node_modules/x.js` 被忽略 ⇒ 默认值本身是好的）见 `docs/ACCEPTANCE.md` §13.2 与 `docs/TESTING.md` §2.5。修复已写进 `scripts/profile-install.mjs` 的 `hmrBlock()`：把监视根**直接指向三个源码树**并 `ignored: []`（独立托管块 `# >>> dsh-ssh hmr watch >>>`）。

### 8.3 对 §7.3 那条"给子代理的含义"的修正（更强，不是推翻）

§7.3 的结论"**不要假设改完 `src/**` 就一定生效**"**依然正确，而且更强**：

- 本机（Windows）上 **host 半边不会热更新**；**要生效必须重启 DSH**。
- toggle `include:dsh-ssh` 行只让 Loader 用**已缓存的模块**重跑一次 `apply()`，**模块字节不会重新导入** —— 因此它能生效的只有**配置值**变更（`apply()` 会重新读取 profile patch），不能生效的是**代码**变更。
- dev loop 的判据从"看面包屑有没有出现"升级为 **看 `host-ready.json` 的 `remoteMethods` 数字**：它能区分"`apply()` 没跑"与"`apply()` 跑了但用的是旧模块"，而 console / 日志做不到。
- 相应纪律已写进 `docs/TESTING.md` §2.5 与 §7 第 8 条、`README.md` 的 FAQ、以及 `src/index.ts` 头部（写给下一位维护者）。

### 8.4 仍待确认的一项（如实）

`hmrBlock()` 写进 profile 的修复**尚未在"重启后的 host"上验证过**：改 profile patch 不会重载已加载的 `hmr` 行，所以本次运行实例仍是 42 方法集。**下一次 DSH 重启后的判据**：改一处 `src/**` → 重建 → 若 `host-ready.json` 的方法数/字段随之变化，则本机热更新恢复；若仍不变，则需继续排查（此时 `ignored: []` 已排除，怀疑方向应转向"该行是否真的被重新装载"）。
