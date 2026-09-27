# SP7 · 多会话标签、状态栏、i18n 与主题（`client/src/chrome/**`）

> 归属：**sp7-chrome-i18n**（task-7）· 契约：`docs/ICD.md` §8.3（组件 props）、§8.4（快捷键）、§8.5（i18n 键）、§8.6（主题）
> 本文件是 SP7 的交付说明与自测报告。所有组件 props 均按 ICD 冻结签名实现，额外能力一律以**可选 props / 独立导出**的形式追加，不改变冻结字段。

---

## 1. 交付物

| 文件 | `@module` / `@order` | 内容 |
|---|---|---|
| `client/src/chrome/index.js` | `ssh.chrome` / 74 | 聚合入口：`install()`、`components()`、各模块再导出 |
| `client/src/chrome/tabs.js` | `ssh.chrome.tabs` / 68 | `TabStrip`（冻结 props）、状态圆点、拖动/键盘排序、关闭确认 |
| `client/src/chrome/statusbar.js` | `ssh.chrome.statusbar` / 70 | `StatusBar`（冻结 props）、时长/字节/速率/ETA 格式化 |
| `client/src/chrome/shortcuts.js` | `ssh.chrome.shortcuts` / 72 | §8.4 命令表、`ctx.shortcuts` 注册、面板内局部按键兜底、`ShortcutHelp` |
| `client/src/chrome/confirm.js` | `ssh.chrome.confirm` / 66 | `ConfirmDialog`（冻结 props）、`ConfirmHost`、危险操作策略（`danger()`） |
| `client/src/chrome/toast.js` | `ssh.chrome.toast` / 64 | `ToastStack`/`ToastHost`、toast 控制器（可脱离 React 调用） |
| `client/src/chrome/i18n.js` | `ssh.i18n` / 60 | 语言解析、`t()`、`useT()`、`registerLocale(ctx)`、`err.<CODE>` |
| `client/src/chrome/theme.js` | `ssh.chrome.theme` / 62 | 样式装载、token 校验工具、终端字号持久化（`dsh-ssh.termFontSize`） |
| `client/src/chrome/locale.gen.js` | `ssh.i18n.dict` / 58 | **生成物**：由 `locale/*.json` 编译进 bundle 的字典 |
| `client/src/chrome/theme.gen.js` | `ssh.chrome.theme.css` / 56 | **生成物**：由 `client/src/theme.css` 编译进 bundle 的样式 |
| `client/src/chrome/gen-locale.mjs` | — | 生成器：`locale/{zh,en}.json` → `locale.gen.js`（支持 `--check`） |
| `client/src/chrome/gen-theme.mjs` | — | 生成器：`client/src/theme.css` → `theme.gen.js`（支持 `--check`） |
| `locale/zh.json`、`locale/en.json` | — | i18n 真源（171 键 × 2 语言，flat 键，命名空间 `ssh`） |
| `client/src/theme.css` | — | 主题真源：**只引用 `--dsw-*` token** |
| `test/client/chrome.test.mjs` | — | 26 个用例：组件/i18n/主题/编码门禁 |
| `test/client/chrome-shortcuts.test.mjs` | — | 13 个用例：快捷键表、注册、`resolve` 归属、兜底 |

### 1.1 为什么有「生成物」而不是手写两份

浏览器 bundle 不能 fetch `locale/*.json`，也不能加载外部 CSS，字典和样式必须**编译进 `lib/client.js`**。为了让「可人工编辑的真源」和「bundle 内的副本」不产生漂移，两份副本都由生成器产出，并且**测试逐字节比对**（`expectedMirror()` vs 磁盘内容）。改真源后忘了重新生成 → 测试红，并直接给出要跑的命令。

```bash
node client/src/chrome/gen-locale.mjs     # 改 locale/*.json 之后
node client/src/chrome/gen-theme.mjs      # 改 client/src/theme.css 之后
```

生成器是 `.mjs`：汇编器只收集 `client/src/**/*.js`，所以生成器本身不会进 bundle。

---

## 2. 与 shell 既有 UI 的**组合**关系（ICD §11 C2/C3/C5）

右侧栏的 dock 标签条（`sidebar.right.pane.tab.title` 占用者）由 shipped 侧栏渲染，**不是我们的座位**，我们没有注册它，也不去改它。两层标签的职责划分是：

| 层 | 回答的问题 | 归属 |
|---|---|---|
| dock 标签（shell） | **哪个功能**打开了（SSH / 终端 / 文件 / 浏览器…） | shipped `sidebar-right`，我们只提供一个类型 `ssh` |
| `TabStrip`（本模块） | SSH 这一个面板里，**10 个并发会话**当前看的是哪一个 | 本模块，渲染在我们自己的 pane 内部 |

因此 `TabStrip` 不是对 dock 标签的重复实现，而是它做不到的那一层：会话级状态圆点（绿/黄/红）、拖动与键盘排序、关闭其他、以及「关闭活动会话」的二次确认。README 在此明确记录这一结论，避免后续被当成冗余代码删除。

其余组合点：

- **浮层**：`shell.overlay` 整层 click-through（M0-SPIKE §4 C4）。`theme.css` 里 `.dsh-ssh-toasts{pointer-events:none}`（让空白处继续穿透）、`.dsh-ssh-toast{pointer-events:auto}`、`.dsh-ssh-confirm-backdrop`/`.dsh-ssh-shortcuts-backdrop{pointer-events:auto}`。有测试断言这四条规则存在，否则按钮点不动。
- **抬升感（elevation）**：ICD v1.0.8 起**取消**「中性黑 alpha 例外」——`rgba(0,0,0,α)` 在暗色模式下几乎不可见。本模块的阴影全部 token 派生：`color-mix(in srgb, var(--dsw-alias-label-primary) N%, transparent)`，三档透明度 16%（toast）/ 20%（快捷键参考）/ 22%（确认对话框，最"模态"）。第一方代码**零硬编码色值**是唯一规则（`client/src/vendor/**` 按 §8.6 排除）。
- **快捷键**：走 shell 的 `ctx.shortcuts`（见 §4），不抢全局 keydown。
- **终端**：字号只作用于我们自己的终端（`ownPaneOnly`），shipped 终端的 `Ctrl+L`/`Ctrl+W`/`Ctrl+R` 保持原样。

---

## 3. 组件接口

### 3.1 冻结 props（ICD §8.3）

```js
TabStrip({ tabs:[{id,sessionId,title,state:'connected'|'connecting'|'error'}], activeId,
           onChange, onClose, onCloseOthers, onReorder })
StatusBar({ info:{ host,user,port,sessionState,rttMs,connectedFor,bytesIn,bytesOut,transfer }, 
            onDisconnect, onReconnect, onToggleLog })
ShortcutHelp({ open, onClose, bindings })
ConfirmDialog({ open, title, body, danger, confirmText, cancelText, onConfirm, onCancel, requireType })
```

补充约定（均为**新增可选 props/参数**，冻结字段语义不变）：

| 位置 | 追加项 | 说明 |
|---|---|---|
| `TabStrip` | `onNew` | 渲染 `+`；不传则不渲染 |
| `TabStrip` | `confirmDanger:false` | 跳过关闭确认（测试或由宿主自行确认时用） |
| `TabStrip.onReorder` | 入参 `{ id, fromIndex, toIndex, order }` | `order` 是排序后的完整 id 列表，store 可直接替换 |
| `StatusBar` | `confirmDanger:false` | 同上，作用于 `onDisconnect` |
| `ConfirmDialog` | `kind` | 透传到 DOM 的 `data-kind`，便于策略层区分三类操作 |
| `ToastStack` | `{ toasts, onClose, onExpand }` | 纯展示；`toasts` 形状同 ICD §8.2 的 `toast` |
| `ShortcutHelp.bindings` | `[{ id, group, label, keys[], source, note }]` | 由 `describeShortcuts()` 产出；`source ∈ shell\|local\|conflict` |

### 3.2 危险操作策略（安全验收项）

`ssh.chrome.confirm` 把「什么必须二次确认、用户要输入什么」做成**纯函数**，再包一层 promise：

```js
const danger = SSH.require('ssh.chrome').danger
if (!(await danger('closeSession', { label: tab.title }))) return   // 关闭活动会话
if (!(await danger('deletePath',   { path, recursive }))) return    // 删除远端路径
if (!(await danger('overwrite',    { path, size }))) return         // 覆盖已存在远端文件
```

- 三个 case 的 `requireType` 分别是**会话名 / 路径 basename / 路径 basename**，`ConfirmDialog` 在输入匹配前禁用确认按钮（错误的大小写与首尾空格都不放行）。
- `TabStrip` 关闭 `state!=='error' && state!=='idle'` 的标签、`StatusBar` 断开活动会话，**都已经走这条策略**（`onClose`/`onDisconnect` 只在用户确认后才被调用）。
- `danger()` 由 `ConfirmHost` 渲染（`install()` 把它注册在 `shell.overlay` 的 `ssh-confirm`），一次只弹一个，串行排队。

### 3.3 i18n

```js
const { t, useT, registerLocale, getI18n } = SSH.require('ssh.i18n')
t('conn.new')                                  // 组件外
const t2 = useT()                              // 组件内（语言切换会重渲染）
getI18n().t('err.SSH_HOSTKEY_MISMATCH')        // §5 错误码
```

语言解析顺序：`dsh-ssh.locale` 显式覆盖 → DSH locale 服务 → `<html lang>`/`navigator.language` → 字典首个语言（zh）。`registerLocale(ctx)` 返回 `{ok, keys, dispose}`，并且把 disposer **返回给 `ctx.effect`**，所以卸载即注销。

`ensureRegistered()` 会在首个组件渲染时补一次注册，因此在 `plugin.js` 改成调用本模块之前，完整字典也已经生效（M0 版 `plugin.js` 只注册了 3 个键）。

---

## 4. 快捷键（ICD §8.4）——注册方式与一处已上报的偏差

### 4.0 客户端 → host 通道：本 build 的真实形态（2026-09-26 追加，事故排查）

排查"面板里所有字符串都是键名 + 连接列表报 `no working client→host carrier`"时，从本机 asar 读出的**决定性事实**：

| 事实 | 证据 |
|---|---|
| 客户端的 host 调用由 **API Gateway 客户端面**提供，服务名 `remote` | `@deepseek-ai/dsh-api-remotes/lib/client.js` 的 `const inject = ['remote']` |
| 该面**只挂载 build 期生成的 contribution**，运行时不会发现 host 的服务 | 同文件 `apply()`：对固定的 23 个 `TYPERT_REMOTE*` 逐个 `await ctx.remote.$mount(contribution)`；README 首段亦写明"capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime" |
| 挂载后按 **descriptor** 安装命名空间 | `@deepseek-ai/dsh-api-gateway/lib/client.js`：`mountContribution()` → `installNamespace(namespace, descriptors)`；校验要求每个参数 codec `mode === 'strict'`（`requireStrictInputs`） |
| 客户端面没有"裸调用"入口 | 该面只有 `$mount` / `$stream` / `$on` / `$host` 与已安装命名空间的方法（**没有** `$call(namespace, method, params)`） |

也就是说：**本插件是运行时注册的，命名空间不在那份 build 期清单里，所以 `ctx.remote.sshPlugin` 永远不会自己出现**——"多等一会儿"不会让通道出现。可行的自装路径是**客户端自己构造 contribution 并 `$mount`**（网关的 `$mount` 接受运行时对象），`bridge.js` 的 `remote-mount` 策略现在按此实现：

1. 先看 `ctx.remote.sshPlugin` / `ctx.get('remote.sshPlugin')` / `ctx.typert.remotes.sshPlugin`（装配已经提供时直接用）；
2. 再 `$mount()`（应用自身的挂载，向后兼容 M0 的探测）；
3. 最后 `$mount(我们自己的 contribution)`：从 §4 的方法表生成 descriptor（`namespace:'sshPlugin'`、`invocation:{kind:'direct'}`、单参数 `{wire:'params', codec:{mode:'strict'}}`，对应 ICD §12 R1 甲式），三种变体（带参数/不带参数/含 stream）逐个尝试，**用真实 ping 往返判定成败**；失败原因（含网关原文）逐条进入 `bridge.diagnostics()` 与 console。

⚠️ **未闭环的部分（诚实记录）**：真实网关上 descriptor 的 codec 不只要通过校验，还要能编解码。本项目 bundle 的唯一外部依赖是 `react`，无法 import 网关的 codec 工厂，所以本模块声明的是"形态正确的最小 strict codec"。**它是否被真实网关接受、以及调用能否成功，必须在用户页面里用 console 的一行 `[dsh-ssh] carrier resolved: …` 来确认**；若网关报 `no strict codec` 之类的错误，就会出现在 `[dsh-ssh] carrier attempts:` 的明细里（这条日志就是为此加的）。备选方案是 ICD §1.2 的认证栅栏内 exact-route。

#### 保留方法名：`remove` → `removePath`（用户 console 实测后修正）

用户 console 给出的决定性证据是网关的拒绝原因：

```
variant 1: client api: method "sshPlugin/remove" conflicts with its namespace service
```

查 `@deepseek-ai/dsh-api-gateway/lib/client.js` 得到完整规则——Gateway 把每个 Remote 方法**装到 `RemoteNamespaceService` 实例上**，名字已存在即拒绝：

| 规则 | 名字 |
|---|---|
| `REMOTE_NAMESPACE_FIELDS` | `ctx` `empty` `invokeRemote` `methods` `name` `namespace` |
| 该类自身 prototype | `assertMethodAvailable` `has` `install` `installDirect` `installScoped` **`remove`** `constructor` |
| 实例上已有的其它成员 | `Object.prototype` 一族（`toString` `valueOf` `hasOwnProperty` `isPrototypeOf` `propertyIsEnumerable` `toLocaleString` `__proto__` `__defineGetter__` `__defineSetter__` `__lookupGetter__` `__lookupSetter__`）以及任何 cordis `Service` 成员 |

**39 个端点里只有 `remove` 命中**（`remove` 是网关卸载已装方法的实现名）。因此按 Lead 授权做端到端改名：ICD §4.5 行 → `src/service.ts` 的 `@Remote` 方法 → 客户端 façade 与 wire 字符串 → 契约门与单测；**ICD §7 的进程内 `SftpHandle.remove` 保持不变**（那是另一层接口）。`bridge.js` 现导出 `RESERVED_METHOD_NAMES`（含 cordis 版本相关的保守超集），并有两道测试：descriptor 表**恰好等于** ICD §4 全表、且不含保留名。

顺带发现并修掉一处**同类漂移**：`bridge.js` 的 descriptor 表原先只有 31 个一元端点，缺 `listLocalDir` / `statLocal`（sp3/sp6 后加的 §4 行）——那两个端点在客户端**永远调不通**。现在 `chrome-carrier.test.mjs` 直接解析 `docs/ICD.md` §4 做等价断言（39 = 33 + 6），未来任何新增/改名都会在 CI 里红。

#### 真正的客户端→host 通道：`connection.rpc.call('/api', …)`（读源码得到，非试错）

用户 console 第二轮给出 `variant 1..3: Cannot read properties of undefined (reading 'length')`。逐层追下去（全部有行号依据）：

| 层 | 位置 | 结论 |
|---|---|---|
| `$mount(contribution)` | `dsh-api-gateway/lib/client.js:1664` | `mountContribution` → `validateContribution()` → **`callerCtx.typert.remotes.register(contribution)`** |
| typert 注册表 | `dsh-typert-registry/lib/client.js:933-936` | `RemoteStore.register()` 只校验 `package` + `descriptors`，随后 `DescriptorStore.validate(descriptors)` |
| 描述符校验 | 同上 `:1314+` `validateInvocation()` | 每个 descriptor 还要 `id` / `service` / `result`（codec）——**这是 `undefined.length` 的来源：它遍历我们没提供的数组** |
| host 解析参数 | `dsh-api-gateway/lib/index.js:1014-1041` `srcDescriptor()` | **host 端 wire 字段 = 方法源码里的形参名**：`{name, wire: name, source:'json', codec:{mode:'src-json'}}` |
| 参数严格性 | 同上 `:1488-1499` `assertExactArguments()` | 多一个字段即 `gateway/arguments-invalid`；缺一个 src-json 参数**可以接受** |
| **实际调用** | `dsh-api-gateway/lib/client.js:1792` | **`connection.rpc.call('/api', '<ns>/<method>', { args }, signal)`** |
| 传输实现 | `dsh-client-connection/lib/client.js:1212` / `:1317` | `POST api/<ns>/<method>`，`assertTarget` 按 `/` 分段校验（`sshPlugin/ping` 合法），返回 server 信封的 `result`（`{ok,value}` / `{ok,error}`） |

**判断：不再试"另造一个 contribution"，改走上面这条 RPC 通道。** 依据：
1. 它就是网关**自己**调用 Remote 的路径（`:1792`），因此是同一条受认证的 `/api` 栅栏，**不新增路由、不新增鉴权面**；
2. 不需要任何生成物（schemas / 真 codec / typcert 编译器产物），因此 `@local/dsh-ssh` 这种本地插件也能用；
3. **用户上一条 console 已经证明它可达**：我们的插件上下文里 `connection.rpc` 存在（旧代码走到了 `rpc.request` 才报 "not a function"），只是**签名写错了**——旧代码用 `rpc(NS, method, params)`，真实签名是 `rpc.call('/api', '<ns>/<method>', { args }, signal)`。

实现要点（`client/src/bridge.js` 的 `connection-rpc`）：
- `args` 形状按 host 的**形参名**表 `WIRE_ARG_BY_METHOD` 生成（`ping→params`、`reportSpike→payload`、`followSessions→_raw`、四个零参端点→`{}`、其余→`raw`），并由测试**从 `src/service.ts` 反推**校验，防止漂移；
- 猜错时以 `gateway/arguments-invalid` 为信号依次试 `raw/_raw/params/payload`（末位补 `{}`），命中后**按方法记忆**，此后零探测；
- 信封归一化：`{ok:true,value}` 取 value，`{ok:false,error}` 抛带 code 的错误（保留 `details` 供 UI 分支）；
- 流式端点走同一通道的 `rpc.open('/api', …)`。

**exact-route（ICD §1.2）因此降级为 Plan B**：只有在页面 console 显示 `connection` 服务在我们的插件上下文里不可见的**情况下**才需要它——而那与已观察到的证据相反。

#### 形状自检（Lead 要求：宁可自报缺字段，也不要 `undefined.length`）

`bridge.js` 的 `missingContributionFields()` 按上面两处校验器的**必需字段清单**（`package`、`descriptors[].{id,service,namespace,method,invocation.kind,result,parameters[].{wire,codec.mode:'strict'}}`）在 `$mount` **之前**自检，缺什么就在 console 打印什么；同时把合成 contribution 的尝试**只做一次**（`syntheticMountRefused`），不再每 250ms 重复同一句报错。我们自己的 descriptor 已补齐 `id`/`service`/`result` 与严格 codec（`{mode:'strict',typeSymbol,schema:{parse}}`，无需 zod），所以即使走挂载路径形状也是完整的。

### 4.3 主题开关（用户走查发现「无主题切换按钮」后补）

面板一直**跟随** shell 主题（`docs/img/session-terminal-dark.png` 是实测暗色截图），但用户**没有任何可操作的入口**，于是这条验收标准他无法自行验证——"能渲染但无法操作"与 M0 的"座位注册成功但用户看不到入口"是同一类问题。

**实现**（`client/src/chrome/theme.js` 的 `ThemeToggle`）：读 shell 的 `theme` 服务（契约见 `@deepseek-ai/dsh-cordis-client-runner/lib/client.js:1399-1416`：`getTheme(): ThemeSnapshot` / `setTheme(id)`，未知 id 抛错；快照形状见 `@deepseek-ai/dsh-client-ui-theme/lib/client.js:1487-1499` 的 `buildSnapshot()`）：

| 需求 | 做法 |
|---|---|
| 反映当前主题 | `data-theme` = `preference`、`aria-pressed` = 解析后的外观、可见文字 = 当前主题名 |
| 轮换而非硬编码 | `nextThemeId(snapshot)` 走 **`snapshot.themes`（注册表列表）** 取下一个 id 并回绕；第三方主题注册即进入轮换，列表缺失才退回 light↔dark |
| 跟随别处改动 | 订阅 **`theme/change`**（文档指定的连续同步通道），设置页改主题时按钮同步 |
| 稳定引用 | `revision`+`preference`+主题数相同则复用上次快照——`useSyncExternalStore` 要求引用稳定，否则撞 React update-depth 上限 |
| 降级 | 无服务 → 渲染 `null`（不是死按钮）并 `onUnavailable(reason)` 上报一次；缺 `setTheme` → 只显示状态、点击 no-op；被拒 id → 返回 `null` 不抛 |
| i18n | `chrome.theme.toggle/light/dark/system`（zh+en，跑生成器），`aria-label`/`title` 是完整句子 |
| token-only | 只用 ICD §8.6 的 `--dsw-*`；hover 底色 `color-mix(brand-primary 8%, bg-layer-2)`，按下态阴影 `color-mix(label-primary 16%, transparent)`。**踩过一次**：最初写了 `--dsw-alias-bg-layer-3`，被 token 测试当场抓住 |
| 可发现性 | 放在**会话工具栏**（与「SSH 快捷键」同一排），且在 `.dsh-ssh-session-help` **之外**——`@container (max-width:320px) { .dsh-ssh-session-help { display:none } }` 会隐藏快捷键按钮，而最窄侧栏正是用户实际工作的宽度，主题开关**不能被一起隐藏** |

**BUILD_MARKER**：`ssh-chrome-2026-09-27.2-theme-late-mount`，`install()` 与延迟解析两处打印：
```
[dsh-ssh] ssh-chrome-2026-09-27.2-theme-late-mount theme-service=pending      ← 首次查找未见（仍在等）
[dsh-ssh] ssh-chrome-2026-09-27.2-theme-late-mount theme-service=ready (late mount, switch enabled)
```
`absent` **只在真的等满 15s 后**才出现（并附可行动 warn）；`incomplete` = 服务存在但无 `setTheme`。

#### 4.3.1 竞态修正：一次性查找把「晚挂载」误报成「不支持」（真机 `theme-service=absent`）

真机 console 打出 `theme-service=absent`，但只读 Inspect 的**客户端服务目录里明确有 `theme`** —— 于是按钮按设计不渲染，用户依旧看不到入口。这与 `sidebarRightTabs`、locale 服务是**同一形态**：客户端服务晚于插件 `apply()` 挂载是这个平台的常态。修正必须两半都做：

1. **`install()` 侧**：先同步试一次（在就立刻 `ready`），否则 **250ms 间隔、最多 15s** 轮询；成功后再发布 `ready`，超时才 `absent` + 可行动 warn。测试用 `options.themeTimeoutMs/themeIntervalMs` 注入，不等 15s。
2. **组件侧（关键，否则仍无按钮）**：服务缺失时 `subscribeTheme()` **不再返回空订阅**，而是把 listener 放进 `availabilityWaiters` 并**armed 一个 250ms 轮询**（上限同为 15s）；服务一旦出现就 `notifyAvailability()` 触发 React 重渲染 —— **按钮自己冒出来，无需刷新页面**。只修 install() 而组件仍"一次没找到就永久隐藏"，用户还是看不到按钮。

`availability` 语义因此收紧：`null` 仍在找 / `ready` / `incomplete`（只读）/ `absent`（**确已等满窗口**，绝不再把竞态说成"平台不支持"）。

### 4.1 §8.4 表
**方式：走 shell 的真实服务**（`ctx.shortcuts`，`@deepseek-ai/dsh-client-shortcuts`），不是自建 keydown。这样命令会出现在「设置 → 快捷键」里、可被用户改键、并遵守 shell 的 region/modal 策略。读 shipped bundle 后确认的两条硬约束：

1. `register()` 在**重复 id / 与既有命令组合重叠 / Web 端不接受的组合**时**抛异常**。因此：每行单独 try/catch；Web 端一律声明两个修饰键；`web:linux` 不绑定（该 profile 只接受三个固定组合）。
2. `resolve({target,region})` 返回 `{status:'blocked'}` 会 **preventDefault**。所以「只对我们自己的 pane 有意义」的命令（`terminal.clear`、`font.*`）在不属于自己的元素上返回 `{status:'pass'}` —— shipped 终端不会丢 `Ctrl+L`。

**偏差（已上报 Lead）**：§8.4 的 `Ctrl/Cmd+T`（新建连接）在 `desktop:*` 上被 shipped 的 `browser.new` 占用，注册会被拒绝。实现取 `Ctrl/Cmd+Shift+T`（Web 端仍是 `Ctrl+T`，那里 `browser.new` 用 `Mod+Alt+T`）；`describe()` 与快捷键参考都会显示替代说明。这属于**可测量的事实冲突**，不是静默改契约。

#### 最后一格：参数**必须**是「单字段 + JSON 串」（用户 console 实测）

通道打通后，界面报 `连接失败：参数校验失败`（= 我们的 `err.SSH_CFG_INVALID`）。**这句本身就是通道成功的证据**（请求到达后端并被后端校验拒绝）。根因写在 host 自己的文件头 `src/api/params.ts:1-24`（ICD §12 R1.3）：

> 「源模式端点没有生成的参数 codec，而载波对**富对象**的投递**是有损的**（M0 §7.2：六键对象到达时只剩两键，连嵌套对象**之后**的字符串都丢了）。」

所以：`args` 里必须**恰好一个** wire 字段，值是 **JSON 字符串**（`{args:{raw:"{…}"}}`），富对象直接过线会被丢字段 → host 解析不到 `profile` → `SSH_CFG_INVALID`。我此前把对象直传，正是这一处回归。现已改为 `encodeArg = JSON.stringify(params)`（已是字符串则原样透传），并给流式 `open()` 用同一规则。

同时按 Lead 要求补齐：
- **双向日志**：`[dsh-ssh] rpc send <ns>/<method> {…}` / `rpc recv … ok|error <code>: <message>`（脱敏 `password`/`passphrase`/`secret`/`token` → `«redacted»`）；
- **错误可行动**：`client/src/conn/ui.js` 的 `errorText()` 把 host 的 message 附在字典句子之后（`参数校验失败：profileId or an inline profile is required`），不再只给一句无法行动的话；
- **落盘**：新建 `docs/CARRIER.md`（通道真实形态、保留名集合、`assertExactArguments` 规则、exact-route 三步 Plan B），`bridge.js` 顶部指向它。

| 命令 | desktop | web | 作用域 |
|---|---|---|---|
| `ssh.panel.focus` | `Ctrl/Cmd+Shift+S` | `Ctrl/Cmd+Alt+S` | 全局 |
| `ssh.conn.new` | `Ctrl/Cmd+Shift+T`（替代） | `Ctrl/Cmd+Shift+T` | 全局 |
| `ssh.tab.close` | `Ctrl/Cmd+W` | `Ctrl/Cmd+Alt+W` | 全局 |
| `ssh.tab.next` / `prev` | `Ctrl/Cmd+Tab` / `+Shift+Tab` | `Ctrl/Cmd+Alt+Tab` / `+Shift+Tab` | 全局 |
| `ssh.tab.jump1..9` | `Ctrl/Cmd+1..9` | `Ctrl/Cmd+Alt+1..9` | 全局 |
| `ssh.terminal.clear` | `Ctrl/Cmd+L` | `Ctrl/Cmd+Alt+L` | 仅本插件终端 |
| `ssh.font.up/down/reset` | `Ctrl/Cmd+=` / `-` / `0` | 加 `Alt` | 仅本插件终端 |
| `↑` / `↓`、`Esc` | 裸键（不可注册为全局命令） | 同 | 面板内局部（`createLocalKeyHandler`） |

`↑/↓` 只在**面板内的可编辑元素**上生效（终端里的 `↑/↓` 属于 shell 历史）；`Esc` 在 `.dsh-ssh-confirm` 内不重复处理（对话框自己管）。

---

## 5. 接入方式（尚未接线，需 SP5/SP6 或 Lead 落一行）

本模块不修改他人文件。要让它生效，需要：

```js
// client/src/plugin.js  apply() 内（SP5 的文件）
const chrome = SSH.require('ssh.chrome')
const installed = chrome.install(ctx, {
  focusPanel:  () => ctx.get('sidebarRight')?.openTab('ssh', {}),
  newConnection: () => app.actions.setPanel({ view: 'list' }),
  closeTab:    () => app.actions.closeTab(app.store.getState().activeSessionId),
  nextTab:     () => app.actions.cycleTab(1),
  prevTab:     () => app.actions.cycleTab(-1),
  jumpTab:     (index) => app.actions.activateTab(index),
  clearTerminal: () => sessionRuntime.active()?.clear(),
  fontUp:      () => chrome.theme.createFontController().step(1),
  fontDown:    () => chrome.theme.createFontController().step(-1),
  fontReset:   () => chrome.theme.createFontController().reset(),
  historyPrev: () => commandPanel.history(-1),
  historyNext: () => commandPanel.history(1),
  escape:      () => app.actions.dismissOverlays(),
}, { report })
```

`install()` 是幂等的、每个座位独立 try/catch：缺 `slots`、缺 `shortcuts`、缺 `sidebarRight` 都只记录错误，不会中断客户端启动。返回值里 `errors[]` 就是「哪些座位没装上」。

工作区容器（SP6）只需要：

```js
const { TabStrip, StatusBar, ShortcutHelp } = SSH.require('ssh.chrome')
// 危险操作（删除远端路径 / 覆盖已存在文件）走策略层：
const confirm = SSH.require('ssh.chrome.confirm')
if (!(await confirm.danger('deletePath', { path, recursive }))) return
// 需要自己挂载确认浮层时：confirm.Confirm（= ConfirmHost，别名，导出名稳定）
```

**给 SP6 的接口承诺**：`ssh.chrome.confirm` 的导出名 `ConfirmDialog`、`Confirm`（= `ConfirmHost`）、`danger`、`dangerRequest`、`isConfirmationSatisfied`、`createConfirmService`、`getConfirmService` 已冻结为本模块的稳定面；`ConfirmDialog` 的 props 与 ICD §8.3 完全一致，因此把它换成 `SSH.ui.ConfirmDialog` 不需要改调用点（`setDialogComponent()` 可注入）。

---

## 6. 自测结果

环境：Windows 10 · Node v24.21.0 · React 19.3.0 · linkedom 0.18.x

| # | 命令 | 结果 |
|---|---|---|
| 1 | `node client/src/chrome/gen-locale.mjs --check` | ✅ `locale mirror is up to date`（171 键 × 2 语言） |
| 2 | `node client/src/chrome/gen-theme.mjs --check` | ✅ `theme mirror is up to date` |
| 3 | `node scripts/build-client.mjs` | ✅ `lib/client.js`（含 chrome 全部 10 个模块，确定性输出） |
| 4 | `node scripts/build-client.mjs --check` | ✅ `client bundle is up to date` |
| 5 | `node --test --test-concurrency=1 test/client/chrome.test.mjs` | ✅ **32/32**（含 i18n 三条链路、双击 apply、重复声明门禁） |
| 6 | `node --test --test-concurrency=1 test/client/chrome-shortcuts.test.mjs` | ✅ **13/13** |
| 6b | `node --test --test-concurrency=1 test/client/chrome-carrier.test.mjs` | ✅ **21/21**（载体晚到、自装 contribution、拒绝可诊断、无载体快速失败、候选清单、descriptor 表 == ICD §4 全表、无保留名、**wire 字段表 == host 形参名**、**/api RPC 签名与探测**、**错误码透传**、**形状自检**、**39 端点 body 键集合 == {wire} 且值为 JSON 串**、**后端细节进入文案**、**凭据不落日志**、**脱敏三层形状**、**凭据不进 UI**、**流式 5 条**（mux 帧序列、取消释放、中途失败归一化、无流入口的可行动错误、`rpc.open` 优先）） |
| 7 | `node --test --test-concurrency=1 "test/client/*.test.mjs"` | ✅ **193/193**（全仓绿，含 SP5/SP6；本轮新增主题开关 6 条，含晚挂载与"永久缺失"两条竞态回归） |
| 8 | `node --test --test-concurrency=1 "test/unit/*.test.mjs"` | ⚠️ 见「协作状态」：host 侧有**非 SP7** 的红点（SP3 的 SFTP 真机用例挂起/超时） |
| 9 | 源码门禁（`chrome.test.mjs` 内建） | ✅ `client/src/chrome/**`：0 处 U+FFFD，全部可 `new vm.Script` 解析；另覆盖 `client/src/theme.css` 与 `locale/*.json`（汇编器不经过这两个文件） |
| 10 | `node --test --test-concurrency=1 test/unit/build-client.test.mjs` | ⚠️ **12/13**：13 条里唯一失败是「no hardcoded colours」，offenders 恰为 `core.js: rgba(0,0,0,.28)` —— **`client/src/core.js` 不在 SP7 写作用域**（ICD v1.0.8 取消中性 alpha 例外后遗留；已上报 Lead，建议改成 `color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)`）。SP5 新增的两道门禁（U+FFFD 拒绝构建、产物不可解析拒绝写入）与「产物与源码一致」均 ✅ |
| 11 | `node scripts/lint.mjs` | ✅ 我的文件与我改过的文件（`chrome/**`、`plugin.js`、`bridge.js`、5 个测试文件）**0 error 0 warning**；全仓仅剩 1 处 error 在 `test/client/harness.mjs:89`（`const url` 未使用，**非本模块 scope**，已上报 Lead） |
| 12 | `node node_modules/eslint/bin/eslint.js client/src/chrome test/client/chrome*.test.mjs` | ✅ 0 problems（专项复核，排除他人文件的干扰） |
| 13 | `DSH_SSH_STRICT_ICD=1 node --test test/integration/icd-conformance.test.mjs` | ✅ **`§4: 39/39 methods present`**（改名后 ICD §4 全表与 host 服务方法一一对应） |
| 14 | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | ✅ 0 错误（改名后的 host 半边） |
| 15 | `node scripts/lint.mjs` | ✅ **0 errors**（6 条 warning 全部在他人文件中：`session/files.js`、`session/terminal.js`、`connection-pool.test.mjs`、`security-credentials.test.mjs`） |

### 6.1 覆盖到的关键行为（不是「渲染不报错」级别）

- **产物级**：测试**真实 import `lib/client.js`**（stub `window.__ModuleLoader__`，同 `test/client/harness.mjs` 语义），只用一行被断言的 hook（`exports.__ssh = SSH`）取到 bundle 内部模块注册表，因此测的是即将被页面执行的字节。
- **危险操作**：点「关闭活动会话」→ 断言 `onClose` **未**被调用 → 输入错误会话名 → 确认按钮仍禁用 → 输入正确名 → 确认 → `onClose` 恰好一次；取消路径同样有断言。`StatusBar` 断连、`deletePath`/`overwrite` 的 `requireType` 与文案同样有断言。
- **拖动/键盘排序**：`moveTab` 纯函数（含越界与不可变输入）+ `Alt+←/→` 事件路径 + `onReorder({id,fromIndex,toIndex,order})` 载荷。
- **快捷键**：测试里按 shipped 源码复刻了服务的 `normalizeBinding`/`isWebBindingAllowed`/冲突规则，并**钉住本 build 已有的 13 组 shipped 组合**；任何默认值与 shipped 冲突、或 Web 端只给一个修饰键，都会在这里失败。
- **归属语义**：`resolve()` 对 `foreign.xterm` 返回 `pass`（不吞键），对自己 pane 返回 `handled` 并执行动作。
- **主题**：`findHardcodedColours()` 扫 `theme.css`、生成的 CSS、以及 `client/src/chrome/*.js` 全部为 0 处硬编码色值；`var(--dsw-*)` 引用逐一断言 ∈ ICD §8.6 的 14 个 token 列表。
- **i18n**：`locale/{zh,en}.json` 键集合相等；§8.5 全清单 + §5 全 32 个错误码存在；两语言占位符集合逐一相等；翻译顺序（覆盖 → 服务 → 环境）、插值、缺键回显为键名；**三条取用链路**（`SSH.i18n` / `ssh.i18n.t` / `ssh.chrome.i18n.t`）逐键断言不是键名，并断言"另一个模块在 `ssh` 命名空间注册的键"（如 M0 的 `spike.title`）经 shell 字典回落解析。
- **载体**：晚到的服务、需要自装 contribution 的网关、被网关拒绝的 contribution（保留其原文用于报告）、完全无载体时的**快速失败 + 后台恢复**、以及 `$mount` 收到的 contribution 形状（`namespace`/`invocation`/`strict` codec）。

### 6.2 已知缺口与工程约束

1. **linkedom 下 React 合成 `onChange` 不触发**（文本输入）。`ConfirmDialog` 的 type-to-confirm 因此用 **ref + 原生 `input` 监听**实现（生产环境同样成立，且省掉受控输入的逐键重渲染）。`onClick`/`onKeyDown` 的合成事件在 linkedom 下正常，其余组件不受影响。这是测试环境缺口，已在代码注释中说明原因。
2. **HTML5 拖动在 linkedom 不存在**（无 `DragEvent`/`DataTransfer`），拖动排序的测试覆盖的是 `moveTab` + 键盘路径；`draggable`/`onDrop` 分支只做了防崩溃处理。真实浏览器的拖动需要人工走查（Lead M5）。
3. **不要用 PowerShell 文本管道改这些文件**：`Get-Content | Set-Content` 在本机按 GBK 往返，会把 `⌘⌥⇧↑↓—` 变成 U+FFFD。本次已因此损坏过一次 `shortcuts.js`（sp6 发现并回滚了 bundle）。事后 SP5 已给汇编器加上**两道门禁**（`U+FFFD` 逐文件拒绝 + `new Function(bundle)` 解析校验），本模块的用例（第 9 项）另外覆盖汇编器看不到的部分：`client/src/theme.css` 与 `locale/*.json`。
4. `dangerRequest` 的「关闭其他标签」用的是通用 `confirm.danger.*` 文案（不显示具体数量），因为 ICD §8.5 没有为它留键；如需计数文案，请走变更流程加键。
5. 终端字号的**真实消费方**是 SP6 的 `TerminalTab`：本模块提供 `createFontController()` / `readTermFontSize()` / `applyTermFontSize(node,size)`（持久化键 `dsh-ssh.termFontSize`）；SP6 若已有自己的字号状态，以它为准，快捷键目标改指向它即可。

---

## 7. 协作状态（写成时的事实）

- ✅ `lib/client.js` 已重建且**可装载**（`build-client.mjs --check` 通过；105 个 client 用例真实 import 产物）。
- ⏳ **尚未接线**：`client/src/plugin.js`（SP5）还没有调用 `ssh.chrome.install()`；工作区容器（SP5/SP6）也还没挂 `TabStrip`/`StatusBar`。因此本模块目前只在测试中渲染，用户在 GUI 里还看不到标签条/状态栏。已按 §5 给出可直接复制的接线片段（这是 SP7 唯一的阻塞项，且只差一行）。
- ✅ **危险操作确认已被 SP6 采用**：SP6 的文件管理器会**优先调用** `ssh.chrome.confirm`（`ConfirmDialog`/`Confirm`），缺失时才回落冻结原语 `SSH.ui.ConfirmDialog`；因此上文 §5 的导出名承诺必须保持稳定。
- ⚠️ **非本模块 scope 的红点**（已上报 Lead）：
  1. `client/src/core.js:91` 仍有 `rgba(0,0,0,.28)`，使 `test/unit/build-client.test.mjs` 的「no hardcoded colours」失败（12/13）。建议改为 `color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)`（浮层卡片档）。
  2. `test/client/harness.mjs:89` 有 1 处 lint error（`const url` 未使用），使 `node scripts/lint.mjs` 整体退出码为 1。
  3. **host 单测不是全绿**：SP3 的「over real SFTP」用例会**挂起**（未加超时时整套 35 分钟无输出；加 `--test-timeout=60000` 后逐个 60s 超时）：`adapter: listing/stat/mkdir/rename/chmod/recursive remove over real SFTP`、`a symlink is reported as a link`、`engine: 2 MiB round-trip`、`resume works`、`a cancelled transfer is resumable`、`sha256 catches a same-length destination`。原始输出见 `%TEMP%\dsh-unit-run.txt`。

### 7.1 经 Lead 授权落地的跨文件改动（2026-09-26，i18n/载体事故收尾）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `client/src/plugin.js` | `sidebarRightTabs` **先同步试注册**，缺失才进 250ms×15s 退避 | 退避循环 250ms 起跳使"服务在场"也要等一个 tick，`apply()` 返回时 tab 类型还不存在；同步优先既不丢晚到场景，也让断言/其他注册可依赖 |
| `test/client/bundle.test.mjs` | 两条载体断言：`SSH_UNKNOWN` → `SSH_NET_UNREACHABLE`（+`retryable`/`details.reason`），并给"ping 失败"那条传 `resolveTimeoutMs` | 载体未就绪是**可重试**状态，映射到 ICD §5 网络族才能渲染成句子；旧断言锁的是"开发期文案 + 终态" |
| `test/client/bundle.test.mjs` | "缺右侧栏"改为断言**重试期间不算失败**；新增「晚到的右侧栏出现后 tab 类型恰好注册一次」 | 旧断言锁一次性查找；新用例覆盖 Lead 修的那个竞态（原先无覆盖） |
| `test/client/conn.test.mjs` | 末段改为"`SSH.i18n` 注册表级翻译器仍给出句子；未知 code 回落 host 原文" | 旧断言锁"字典查不到"的坏行为，与本次修复目标相反 |
| `client/src/bridge.js` | 10 条 `object-shorthand` warning 清理 | 纯语义等价，降低全仓 lint 噪声 |
| `docs/ICD.md` §4.5 | `sshPlugin/remove` → **`sshPlugin/removePath`** + 保留名说明 | 网关拒绝同名方法；ICD 必须与实现一致（契约门按 ICD 文本断言） |
| `src/service.ts` | `@Remote async remove` → **`removePath`**（含变更原因注释） | `@Remote` 的 wire 名 = 方法名；`lib/service.js` 的装饰器元数据已是 `name: "removePath"` |
| `src/api/files-api.ts` | 仅注释：`ICD §4.5 \`remove\`` → `removePath` | 进程内方法仍叫 `remove`（对齐 ICD §7 的 `SftpHandle.remove`），只有 wire 名受影响 |
| `client/src/session/runtime.js` | `remove(params)` → **`removePath(params)`** + `callHost('removePath', …)` | 客户端唯一的 wire 调用点（删除远端路径） |
| `client/src/bridge.js` | descriptor 表：`remove` → **`removePath`**，并**补上缺失的 `listLocalDir` / `statLocal`**；新增 `RESERVED_METHOD_NAMES` | 表原先只有 31 个一元端点，漏了两个后加的 §4 行 → 那两个端点客户端永远调不通 |
| `test/unit/api-files.test.mjs` | 3 处 `h.service.remove` → `removePath`（含方法名数组） | 跟随 wire 改名 |
| `test/client/chrome-carrier.test.mjs` | 新增两条：descriptor 表 == ICD §4 全表；descriptor 不含保留名 | 让"新增端点忘了同步 descriptor 表"和"撞保留名"都在 CI 里红 |

---

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-25 | 首版：TabStrip / StatusBar / ShortcutHelp / ConfirmDialog / ToastStack / i18n / 主题 + 39 个用例 |
| 2026-09-25 | 修复 PowerShell 重编码与误删 `$` 导致的 `shortcuts.js` 损坏；新增源码语法/编码门禁测试；`registerLocale` 把 disposer 交回 `ctx.effect`；无服务时 `registerShortcuts` 补 `conflicts` 字段 |
| 2026-09-25 | 依 ICD v1.0.8：3 处 `rgba(0,0,0,α)` 阴影改为 `color-mix(... var(--dsw-alias-label-primary) N%, transparent)`（16/20/22%），`findHardcodedColours` 删除中性 alpha 例外；补 `Confirm` 别名；清掉 2 处 lint 死代码（我的文件现在 0 error 0 warning） |
