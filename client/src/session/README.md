# 会话工作区 UI（SP6 / T6）

右侧栏 SSH 标签的**会话工作区**：终端、命令面板、双栏文件管理、审计日志四个标签页，
以及它们依赖的终端宿主与数据面。所有组件都是 props 的纯函数，props 形状严格遵循
`docs/ICD.md` §8.3（冻结），由 SP5 的工作区容器挂载、SP7 的标签栏切换。

## 1. 文件与模块

| 文件 | `@module` / `@order` | 职责 |
|---|---|---|
| `styles.js` | `ssh.session.styles` / 200 | 工作区样式表（只引用 `--dsw-*` token） |
| `ui.js` | `ssh.session.ui` / 210 | 原语解析（优先 `SSH.ui`）、本地 i18n 兜底、格式化、路径工具、内联图标 |
| `vt.js` | `ssh.session.vt` / 300 | 精简 VT/ANSI 屏幕模型（降级渲染器与测试可读的屏幕） |
| `runtime.js` | `ssh.session.runtime` / 310 | **数据面**：流缓冲、目录缓存、传输进度、审计、危险操作确认、全部 host 调用 |
| `term.js` | `ssh.session.term` / 330 | 终端宿主：优先 vendored xterm.js，失败则内置屏幕；键编码、主题、fit |
| `terminal.js` | `ssh.session.terminal` / 400 | `TerminalTab` |
| `command.js` | `ssh.session.command` / 420 | `CommandPanel`（含纯函数 `historyStep`） |
| `files.js` | `ssh.session.files` / 440 | `FileManager`（含 `sortEntries` / `hasEntry` / `modeError`） |
| `logs.js` | `ssh.session.logs` / 460 | `LogTab`（含 `redactEntry` / `exportEntries`） |
| `index.js` | `ssh.session` / 480 | 集成面：`configure()` + `components()` + `StandaloneWorkspace` |
| `../vendor/*.module.js` | `ssh.vendor.xterm`(5) / `ssh.vendor.fit`(6) / `ssh.vendor.xterm.css`(7) | vendor 的 xterm.js 5.5.0 + addon-fit 0.10.0（见 §5） |

`ssh.session` 的用法（SP5 的插件体/容器只需这两行）：

```js
const session = SSH.require('ssh.session')
session.configure({ bridge, app })            // 一次；把传输与 store 交给数据面
const { TerminalTab, CommandPanel, FileManager, LogTab } = session.components()
```

## 2. 分层规则（为什么组件不碰 bridge）

- **组件只读 props + `ssh.session.runtime`**，绝不直接调用 `bridge`。
- **runtime 的每个动作先找 `app.actions.<同名>`**（SP5 拥有连接/会话策略），只有 store 没有该动作时，
  才使用 `configure({ bridge, app })` 注入的 bridge。没有接线时动作返回结构化
  `SSH_STATE_INVALID`（可读的"未接线"提示），不抛异常、不留白屏。
- **帧摄取**是客户端侧调度不变式的唯一执行点：`data.seq` 去重（重连用 `sinceSeq` 续订会重放尾部）、
  每条流只产生一次终态、`progress.transferred` 单调不减（ICD §3）。

## 3. 与冻结 props 的关系（ICD §8.3）

四个组件的冻结 props 全部实现，未改名、未删除。除此之外有一组**可选**的附加 props，
用于"容器自己已经持有数据"的场景（不传则回落到 runtime）：

| 组件 | 可选附加 props | 说明 |
|---|---|---|
| `TerminalTab` | `session`（`SessionInfo`，仅用于标题） | 数据一律来自 `streamId` 对应的流缓冲 |
| `CommandPanel` | `streamId`、`autoFocus` | 传 `streamId` 时直接读该 exec 流的输出；否则用 `result` |
| `FileManager` | `localEntries` / `remoteEntries` / `activePane` | 传了就优先于 runtime 目录缓存 |
| `LogTab` | `onLevelFilterChange`、`loading` | `levelFilter` 为受控值；不传回调时组件内部维护筛选 |

反向的数据缺口已按 Lead 裁决处置：本地栏走新增的 host 方法
`sshPlugin/listLocalDir { path } → { entries, cwd }`（ICD v1.0.2 §4.5），未实现时降级为
"本地目录列表不可用"的说明态，绝不假装目录为空。

## 4. 关键行为

- **终端**：流式帧渲染、复制/粘贴、字号缩放（`Ctrl/Cmd + = / - / 0`，持久化键
  `dsh-ssh.termFontSize`）、清屏（`Ctrl/Cmd + L`）、重连（`onReconnect` 优先，否则
  `runtime.actions.reconnectShell` 用 `sinceSeq` 续订，不重放历史）、退出码回调 `onExit`、
  `onDirtyChange`（有新输出且终端未聚焦时置位）。
- **命令面板**：`↑`/`↓` 走历史（`↑` 从最新一条开始，`↓` 越过最新一条恢复半成品草稿），
  Enter 执行、运行中 `Ctrl+C` 取消；stdout/stderr 分区渲染 + 退出码 + 耗时 + 截断提示。
- **文件管理**：双栏（本地/远端）、面包屑导航、排序、隐藏文件开关、上传/下载（含覆盖确认）、
  新建/重命名/删除/chmod、传输进度条（0/50/100%），危险操作**先确认后执行**：
  删除目录需要在确认框里输入目录名（`requireType`）。
- **危险操作确认**：优先使用 SP7 的 `ssh.chrome.confirm`（存在则用），否则使用冻结原语
  `SSH.ui.ConfirmDialog`；程序化路径 `runtime.requestConfirm()` **无确认器时一律拒绝**（fail-closed）。
- **日志**：渲染 §4.6 的审计条目，并**再脱敏一次**（key 名按 ICD §6 `redactKeys` 逐词匹配、
  PEM 私钥块、URL 内嵌凭据），detail 只以脱敏后的 JSON 呈现；导出 JSON/CSV 同样走脱敏副本。

## 5. vendored xterm.js（与 bundle 的关系）

- 由 `scripts/vendor-xterm.mjs` 从 npm tarball 生成 `client/src/vendor/*.module.js`，
  每个都是**普通 `@module` 源**（汇编器无需特例）：`ssh.vendor.xterm` / `ssh.vendor.fit` /
  `ssh.vendor.xterm.css`，顺序 5/6/7。
- 上游 UMD/CSS 字节**逐字保留**在 `/* ---- begin verbatim vendor (…) ---- */` 标记内；
  `node scripts/vendor-xterm.mjs --check` 会把这段载荷从磁盘文件里抠出来重新算 sha256 与
  tarball 摘要比对（`VENDOR.json` 记录两套摘要），所以"逐字"是被验证的。
- 每个 vendor 文件都有**本地 `module`/`exports` 垫片**：UMD 探测到 `exports` 会走 CommonJS 分支，
  若没有垫片它会看到 bundle 自己的 `exports` 并把 `Terminal` 挂上去，从而**毁掉包的导出**。
- 主题覆盖点：`ssh.session.term` 在挂载时读取 `--dsw-alias-bg-base` / `--dsw-alias-label-primary`
  / `--dsw-alias-brand-primary` / `--dsw-alias-state-{error,warn,success}-primary` 覆盖 xterm 自带默认主题
  （`themeFromTokens()`），因此**上游默认色不会出现在界面上**；`client/src/vendor/**` 因此被
  ICD §8.6 的色值扫描排除（vendored 代码保留自带调色板，运行时被 token 覆盖）。

## 6. 自测结果

环境：Windows · Node v24.21.0 · React 19.3.0 · react-dom 19.3.0 · linkedom 0.18.13。

### 6.1 命令与结果

```
$ node --test --test-concurrency=1 "test/client/terminal.test.mjs"
ℹ tests 19   ℹ pass 19   ℹ fail 0

$ node --test --test-concurrency=1 "test/client/session.test.mjs"
ℹ tests 29   ℹ pass 29   ℹ fail 0

$ node scripts/vendor-xterm.mjs --check
vendored xterm is intact (@xterm/xterm@5.5.0, @xterm/addon-fit@0.10.0)

$ node scripts/build-client.mjs && node scripts/build-client.mjs --check
wrote lib/client.js (672020 bytes) / client bundle is up to date

$ node --test --test-concurrency=1 "test/client/*.test.mjs"      # 全量 client 层（含 bundle/chrome）
ℹ tests 105  ℹ pass 105  ℹ fail 0
```

截图（由组件真实渲染结果生成，见 §7 第 6 条）：`docs/img/session-{terminal,commands,files,logs}-{light,dark}.png`
（terminal/commands/files/logs × 亮/暗，共 8 张）。

### 6.2 覆盖到的验收点

| 验收点 | 测试 |
|---|---|
| 终端渲染并流式输出（fake bridge → 屏幕） | `session.test.mjs`：终端流式帧渲染、`uname -a` 输出 |
| `top` 类全屏重绘（真实 xterm 引擎） | `terminal.test.mjs`：`\x1b[2J\x1b[H` + `\x1b[2;1H\x1b[K` 行级重绘、?1049 备用屏往返 |
| 复制/粘贴、字号缩放、清屏、重连 | 终端工具栏 + `Ctrl/Cmd` 快捷键测试；`encodeKey` 表；`shellWrite` 到达主机 |
| 命令历史上下翻 | `session.test.mjs`（真实 keydown）+ `historyStep` 纯函数 |
| stdout/stderr/退出码/耗时/截断 | 命令面板渲染测试 |
| 双栏 + 上传下载 + mkdir/rename/delete/chmod | 双栏渲染、覆盖确认、重命名对话框、chmod 校验 |
| 进度条 0/50/100% | `data-percent="0|50|100"` + `data-status="done"` |
| 危险操作走二次确认 | 删除文件=普通确认；删除目录=需输入名称；未接线确认器时 fail-closed |
| 日志脱敏（不得回流凭据） | 密码/PEM/URL 凭据在 DOM 与导出文本中均不出现 |
| 无硬编码色值 | `client/src/session/**` 扫描 + xterm 主题取自 token |

### 6.3 环境限制（测试侧）

- **DOM 桩**：linkedom 无布局引擎，因此 `terminal.test.mjs` 为 xterm 提供
  `matchMedia` / `requestAnimationFrame` / `getBoundingClientRect` 等桩；emulator 的
  解析与缓冲行为不依赖它们，只有渲染器初始化依赖。
- **must-be-first 顺序**：`react-dom` 必须在 DOM 就绪后加载，并声明 `document.oninput`，
  否则 React 会启用旧的 `input` 事件 polyfill，在 linkedom 下 keydown 会崩
  （`getNodeFromInstance(null)`）。这条已写进测试文件顶部注释。
- **事件必须包在 `act()` 里**：否则读到的 DOM 可能是未 flush 的中间态（历史游标会看起来"走了两步"）。

## 7. 遗留问题与边界

1. **接线：自愈路径是永久设计，不是临时补丁**。数据面首选 `app.actions.<同名>`，其次用
   `configure({ bridge, app })` 注入的 bridge；若两者都没有，`discover()` 会**只读**一次
   `SSH.require('ssh.plugin').currentRuntime()`（即 bundle 已公开的 `introspect` 面）拿 bridge/app，
   所以即使容器漏了那一行，终端也能敲键到主机（有测试覆盖）。显式 `configure()` 永远优先；
   **即使 sp5 补上那一行，自愈路径也保留**——它把"漏一行"从"终端完全不能敲键"降级为"仍能工作"。
   建议 sp5 仍在插件体里加一行，让生命周期显式化：
   `SSH.require('ssh.session.runtime').configure({ bridge, app })`。
2. **本地栏数据源**：host 侧已实现（Lead 的 `src/api/local-fs.ts`：`listLocalDir`/`statLocal`，
   `lstat` 不跟随符号链接、单个不可读条目不拖垮整次列举、缺目录 → `SSH_SFTP_NO_SUCH_FILE`、
   不可读 → `SSH_PERM_LOCAL_DENIED`，格式与远端栏一致）。**尚待 T10 把端点接出去**
   （`sshPlugin/listLocalDir` / `statLocal`，ICD §4.5）。在此之前本地栏显示"本地目录列表不可用"的
   说明态（不是空目录）；端点上线后无需改组件即自动变成真数据。
3. **降级渲染器**：xterm 无法挂载时启用内置屏幕（`ssh.session.vt`），覆盖光标定位/擦除/滚动区/
   SGR/备用屏；不渲染颜色（颜色是 token 决策），也不实现鼠标选择与超链接。
4. **`onExport(text, format, entries)`**：冻结 props 只声明了 `onExport`，实现按
   `(text, format, entries)` 调用；容器只关心第一个参数即可。
5. **`ssh.chrome.confirm` 接口**：组件优先使用它提供的 `ConfirmDialog`/`Confirm`；若 SP7 暴露的
   组件 props 与冻结的 `ConfirmDialog` 不一致，会自动回落到 `SSH.ui.ConfirmDialog`。
6. **截图**（`docs/img/session-*.png`）由组件真实渲染结果生成（服务端渲染 + 代表性 token 值），
   不是 GUI 内截图；真实配色以宿主 shell 的 `--dsw-*` 为准。
7. **`FileManager` 的删除/覆盖/chmod 走二次确认**；清空审计日志同样确认。危险操作的"完全程序化"
   入口 `runtime.requestConfirm()` 在没有任何确认器时**返回 false（fail-closed）**，绝不静默放行。

## 8. 会话视图布局契约（验收级"终端被遮挡"的修复记录）

**症状**：窄右栏下终端只剩 1~4 行高（host 侧收到 `shellResize {rows:1}`），并触发 xterm 未捕获错误
`Cannot read properties of undefined (reading 'dimensions')`。

**根因（两个叠加）**：

1. `client/src/panel.js` 里会话视图的容器类（`dsh-ssh-session-body`、`dsh-ssh-session-status` 以及标签条那一行）
   **当时没有任何 CSS 规则**：终端外层没有 `flex:1 1 auto; min-height:0`，而 Flex 子项默认 `min-height:auto`
   拒绝收缩；其内部 xterm 宿主是 `position:absolute; inset:0`，绝对定位子元素不贡献高度 ⇒ 终端容器塌成 ~0。
2. chrome 的 `StatusBar` 在窄栏里折成 5 行（状态 / user@host / 流量 / 「无传输任务」空态 / 断开），
   把剩下的竖直空间也吃掉了。

**修复（均在 `client/src/panel.js` 的 `LAYOUT_CSS`，token-only）**：

- `.dsh-ssh-session-view / -body` 全链 `min-height:0`；viewport 是唯一 `flex:1 1 auto` 的子项且 `overflow:hidden`；
- 标签条 `flex:0 0 auto; flex-wrap:nowrap; overflow-x:auto`：永不折行、永不压住主体；
- 状态行 `max-height:calc(2 * 1.6em + 10px)`，各 item `white-space:nowrap` + 省略号 ⇒ **恒为 1~2 行**；
- `[data-transfer="idle"] [data-testid="ssh-status-transfer"] { display:none }` ⇒「无传输任务」空态不再占高度
  （真有传输时仍显示）；
- `@container (max-width: 320px)` 隐藏「SSH 快捷键」按钮，保证最窄宽度下四个页签**完整可见**；
- `client/src/session/terminal.js`：容器无尺寸或不足 2 行时**不测量、不 fit**（消除 `rows:1` 与 xterm 崩溃），
  并用 `ResizeObserver` 在容器尺寸变化后重算（折叠右栏、切页签、改窗口、主题切换）；
- `client/src/session/runtime.js`：首个 resize **延后到流收到第 1 个数据帧**（避免 host 侧 "has no channel yet"），
  1.5s 兜底；`warnHostCall` 保留（失败仍可见）；
- `client/src/store.js`：M0 浮层标记**不再持久化**；浮层仅在 `panel.view === 'debug'` 时渲染
  （`position:fixed` + 极高 z-index，绝不允许盖住终端）。

**实测几何（headless Edge + DevTools protocol 实测，非推断）**：

| 配置 | 头部 | 标签条 | viewport | 终端可见 | 状态行 | 无任务空态 |
|---|---|---|---|---|---|---|
| 420px 亮色 | 44px（2 行） | 40px，4 页签不裁切 | 444px | **383px ≈ 26 行** | 48px（2 行，4/5 item 可见） | 隐藏 |
| 240px 最窄 | 44px（2 行） | 40px，4 页签不裁切 | 444px | **353px ≈ 24 行** | 48px（2 行） | 隐藏 |
| 420px 暗色 | 44px | 40px | 444px | **383px ≈ 26 行** | 48px | 隐藏 |

判据：终端可见高度 **≥15 行**（实测 24~26 行）、标签条四个页签完整、状态行 ≤2 行、断开按钮可见。

**截图**（`docs/img/`，2000×1400）：`session-terminal-light.png`、`session-terminal-narrow.png`、
`session-terminal-dark.png`。

**测试边界（如实声明）**：linkedom 没有布局引擎，**纯 CSS 几何无法在单测里断言**。单测锁的是
**结构与 CSS 不变量**（`test/client/conn.test.mjs` 的
`the session view holds a layout contract: strip, viewport, status row, in that order`：容器顺序、
四个页签、`data-transfer` 标记、关键声明存在性、无硬编码色值）；像素级几何由上面的浏览器实测覆盖。

**生效判据**：console 首行须为 `[dsh-ssh] client applied: ssh-client-2026-09-26.3-session-layout`；
或 `Select-String -Path lib\client.js -Pattern '2026-09-26.3-session-layout'`。

## 9. 文件面板"永远加载中"的修复记录（sp5 接手，sp6 已停止）

**症状**：点"文件"页签后，本地与远端两棵目录树**永远停在"加载中"**，无法上传；console 里**看不到**
`sshPlugin/listLocalDir|listDir` 的收发行，也看不到任何失败——即"请求发出后永不 settle"与"根本没发请求"
两种成因在界面上完全同形。

**根因（两个叠加，缺一不可）**：

1. **loading 由"记录缺失"推导，且有兜底为真**：`FileManager` 的 pane 把 `loading` 直接绑目录记录，
   记录不存在时回落 `true`（`localDir.directory ? …loading : true`）。任何"没人发起加载"的 pane
   （远端无 sessionId、本地无 root、或读写键不一致）都永久显示"加载中"。
2. **请求没有出口**：`runtime` 的 `loadRemoteDir/loadLocalDir` **先** `setDirectory({loading:true})`
   再 `await callHost(...)`，而该 await **没有任何超时**。因此"请求已发出但永不 resolve"时记录**存在**
   且 `loading` 恒为 `true`。所以只修第 1 条不够——**超时必须压过记录**。

附带一处键不一致：本地 pane 读取用 `useDirectory(sessionId, 'local', root)`，而写入用
`sessionId ?? 'local'`；`sessionId` 缺失时读键与写键不同 ⇒ 记录永远找不到（再次落到第 1 条）。

**修复（`client/src/session/files.js`，未改 `runtime.js`/契约）**：

```js
const record   = dir?.directory ?? null
const settled  = Boolean(record && (record.loadedAt > 0 || record.error))
const timedOut = Boolean(expired[pane])           // 看门狗
const loading  = !timedOut && (pending[pane] === true || record?.loading === true)
const error    = timedOut ? { code: 'SSH_NET_TIMEOUT', message: t('err.SSH_NET_TIMEOUT') }
                          : (record?.error ?? null)
```

- `loading` 只由**"确实有请求在飞"的证据**驱动（本 pane 的 `pending`，或 runtime 标记的在飞记录），
  不再由"没有记录"推导；
- **看门狗 `useLoadWatchdog`**：`loading` 为真即起表，默认 **8000ms**，到点置 `expired[pane]`
  ⇒ 界面**必然**离开 loading，进入可重试的错误态；`settled`（数据或失败任一落地）清除
  `pending`/`expired`，**迟到但成功的响应会覆盖超时**，不会把已到的数据藏起来；
- 超时值可注入：`props.timeoutMs`（测试用 40ms，不等 8s）；
- 定时器绑在**派生出的 loading** 上而非某一次请求上 ⇒ 覆盖三种入口：本 pane 发起、更早的挂载遗留、
  容器代为发起；`attempt` 票据让**新请求重新起表**，且被顶替的旧请求不允许结算 pane；
- 提供者（容器）自带 `localEntries/remoteEntries/loadingByPane` 时，deadline 归容器所有，
  看门狗不介入（`watchdog` 标志）；
- **重试按钮**：错误分支新增 `ssh-ws-retry-{pane}`（复用既有键 `ws.files.refresh`），
  重新置 pending + 发起同一 pane 的加载 + 清 `expired`；
- **上传禁用给出原因**（`title`，只读既有键，不新增）：无会话/无远端根 ⇒ `err.SSH_STATE_INVALID`、
  目录未加载 ⇒ `ws.files.loading`、列表被拒 ⇒ 该错误自身的 `message`（如 `err.SSH_PERM_DENIED`）、
  未选文件 ⇒ `ws.files.selectFirst`；pane 内原始按钮同时带 `data-reason`；
- **三条生命周期日志**（此前该 pane 全程无声，这是"看不出区别"的根因）：
  `[dsh-ssh] files: loading {scope,path}` / `files: loaded {scope,entries:n}` /
  `files: failed {scope,code,message}`，超时另有一条 `files: timeout {scope,afterMs}`；
- 键一致化：本地 pane 统一按 `sessionId ?? 'local'` 读写；
- `unwired`（原本算了却从未传入渲染）接上：无 sessionId 的远端 pane 显示
  `err.SSH_STATE_INVALID`，不再冒充"空文件夹"（空文件夹会误导用户以为文件真的没了）。

**红线证据（先写红再修）**：把 `loading` 改回 `record ? record.loading : true`、并摘掉看门狗与
上传原因属性后，新增 5 条测试中 **4 条失败**（`never answered`、`retrying after the deadline`、
`a disabled upload states its reason`、`a denied remote listing`），第 5 条（成功路径）两态皆绿——
它守的是"没有回归"。修复还原后 5/5 绿。为此对 `files.js` 做了"备份 → 反向修改 → 跑红 → 还原"的
可逆实验（还原后 sha256 一致）。

**自测结果**（§9 与 §9.1 合并后）：

```
$ node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit     # 0 错误
$ node --test --test-concurrency=1 "test/client/session.test.mjs"
  ℹ tests 43   ℹ pass 43   ℹ fail 0            # 含新增 7 条
$ node --test --test-concurrency=1 --test-timeout=30000 "test/client/*.test.mjs"
  ℹ tests 200  ℹ pass 200  ℹ fail 0            # 193 基线 + 7 新增
$ node --test --test-concurrency=1 --test-timeout=30000 "test/unit/*.test.mjs"
  ℹ tests 540  ℹ pass 537  ℹ fail 0  ℹ skipped 3   # skip 为既有的靶机门控项，非本次引入
$ node scripts/build-client.mjs && node scripts/build-client.mjs --check
  wrote lib\client.js (876913 bytes) / client bundle is up to date
$ node scripts/lint.mjs                                        # 0 errors（本文件 0 warning）
```

**生效判据（用户侧）**：刷新页面后挂载"文件"页签，console 应出现

```
[dsh-ssh] ssh-files-2026-09-27.6-pane-load-trigger load-deadline=8000ms local=. remote=/
[dsh-ssh] files: trigger {scope:'local',  path:'.',   hasRecord:false, loadedAt:null, recordLoading:null, reason:'fire'}
[dsh-ssh] files: trigger {scope:'remote', path:'/',   …同左…}
[dsh-ssh] files: loading {scope:'local',  path:'.'}
[dsh-ssh] files: loading {scope:'remote', path:'/'}
[dsh-ssh] files: loaded  {scope:'local',  entries:N}
[dsh-ssh] files: loaded  {scope:'remote', entries:N}      ← 正常链路
```

**只要看到 `files: trigger` 行，触发路径即已走通**；若链路不通，8s 内必然出现
`files: timeout {scope,afterMs:8000}` 并转为 `SSH_NET_TIMEOUT` 错误态 + "Refresh"重试按钮，
**不再有无限"加载中"**，也不会再有"挂载了却什么都没发生"。
或：`Select-String -Path lib\client.js -Pattern 'ssh-files-2026-09-27.6-pane-load-trigger'`。

**仍存的边界（如实声明）**：超时**不取消** host 侧的调用（`runtime.js` 不在本次改动范围），
迟到的响应会被采纳；同一 pane 的看门狗在 `expired` 置位后不再重复触发（重试会重新起表）。
`files.js` 未新增 i18n 键；`err.*` 在无 `ssh.i18n` 的测试环境下渲染为键名本身，真实 bundle 中由
`ssh.i18n` 词典翻译。

## 9.1 触发侧修复：为什么"页签挂载了却一个请求都没发"

**真机证据（决定性）**：console 只打印了 `ssh-files-…-load-deadline` 这一行，**之后什么都没有**——
没有 `files: loading`，也没有 `files: failed`。即：页签确实挂载了，但**触发守卫从未成立**，
所以两个 pane 都没向 host 要过任何东西。而"没有发请求"在旧代码里**不是任何可见状态**。

**根因**：真实调用点是 `client/src/panel.js` 的 `h(FileManager, { sessionId })` ——
**只传了 `sessionId`，从未传 `localRoot`/`remoteRoot`**（该文件不在本次范围，无法改动）。而旧守卫是

```js
if (!providedRemote && sessionId && remoteRoot) { … }   // remoteRoot 为 undefined ⇒ 整段跳过
if (!providedLocal && localRoot) { … }                  // localRoot 为 undefined ⇒ 整段跳过
```

两个分支体都不执行 ⇒ 零请求、零日志。同时 `runtime.actions.listLocalDir` 对**falsy path 直接
`return null`**，host 的 `listDir` 又**要求** `path`，所以"根缺失"必须**补出一个可用的根**，
不能当成"没东西可加载"。

**修复（`client/src/session/files.js`）**：

1. **派生可用根**（`effectiveRoot(pane)`，props 优先，bootstrap 兜底）：
   - 本地：`props.localRoot` → `.`。host 侧 `resolveLocalPath('.')` 会按**它配置的本地根**（或
     `process.cwd()`）解析，并回带**绝对** `cwd`；`..` 在绝对路径回来前只有一个面包屑因而**禁用**，
     所以不会有请求逃出配置根；
   - 远端：`props.remoteRoot` → 该会话 profile 的 `defaultCwd`（只读 store：
     `sessions.items[].profileId` → `profiles.items[].defaultCwd`）→ `/`（绝对、任何服务器都可列）。
2. **触发条件改为基于派生状态**（`trigger()`），不再看 `record.loading`：
   仅当"本挂载有在飞请求（`inflight`）"或"记录已 settled（`loadedAt > 0 || error`）"才 skip；
   **残留的 `{loading:true, loadedAt:0}` 记录不再能挡住触发**（旧守卫正是被它挡掉的）。
3. **触发决策落日志**：`files: trigger {scope, path, hasRecord, loadedAt, recordLoading, reason:'fire'|'skip', skipBy}`
   —— 把判断所用的**实际取值**打出来，使"没发请求"可诊断而非靠猜。
4. **根与读键一致**：`useDirectory` 的读键改用 `effectiveRoot(pane)` / `readSessionId(pane)`
   （本地 `sessionId ?? 'local'`，与 runtime 写入键一致），读键与写键不同则永远看不见自己的答案。
5. **面包屑/传输目标用 host 回带的 `record.cwd`**：`root = record.cwd || effectiveRoot(pane)`，
   于是 `.` 只作引导，真正的绝对路径一旦回来就成为 pane 根（上传目标、`..`、面包屑都据此构建）。
6. **看门狗与重试保持原样**（§9），"一旦发起就必有出口"；`inflight` 在 settle 与超时两处清除。

**红线证据（先写红再修，可复核）**：只反向改回两处决策点——
①守卫改回 `record.loading === true` 即跳过、②`effectiveRoot` 去掉 bootstrap 退回原始 props——
新增 2 条测试**双双失败**，失败点正是本案特征：
`a stale record must not be read as work in progress` 与 `both panes start from a usable root and fire`。
还原后 2/2 绿（"备份 → 反向修改 → 跑红 → 还原"，还原后 sha256 一致 `926EE0D7…`）。

**新增测试**（`test/client/session.test.mjs`）：

| 测试 | 断言 |
|---|---|
| `the mount trigger fires even when a leftover half-loaded record exists` | 先手工造出 `{loading:true, loadedAt:0, error:null}` 残留记录 ⇒ 挂载后 `reason:'fire'`、`hasRecord:true`、`recordLoading:true` 且**真的发出** 1 条 `files: loading`；仍由看门狗收尾（error + 重试按钮） |
| `the shape the GUI actually mounts (sessionId only) still loads both panes` | **只传 `sessionId`**（真实调用形态）⇒ 两个 pane 都 `fire`：本地 `path:'.'`、远端 `path:'/var/www'`（取自 profile `defaultCwd`）；两侧都渲染出条目、无错误；且 pane 根改用 host 回带的绝对目录（面包屑出现 `/var/www` 与 `C:\ws`） |

## 9.2 交互侧修复：为什么"切换不了目录 + 上传不了文件"（**本节取代 §9.1 第 4 条的读键口径**）

**真机证据**：`listDir/listLocalDir` 的请求**确实发出并成功**（含 `...\profiles\`、`/sbin.usr-is-merged`、
`/` 等），但整份日志里**没有一条 `sshPlugin/upload`**。⇒ 问题在交互/视图层，不在 loader。

**根因（三个，互相独立）**：

1. **读键永远不变 ⇒ 视图不跟随导航**（"切换不了目录"的主因）。
   `.6` 里 `useDirectory(..., effectiveRoot(pane))`，而 `effectiveRoot` **只由 props 推导**（真实 GUI
   不传根 ⇒ 恒为引导根）。于是：导航把结果写进**新路径**的键，组件仍在读**旧键** ⇒ 请求发出、host 回答、
   **列表一动不动**；`panes[pane].root` 也一直等于引导目录的 cwd（"被打回引导根"）；用户以为没反应而
   **反复点同一行**，于是日志里出现**同一路径的重复请求**（`×8`）——重复是"视图不动"的结果，不是独立的循环。
   **修复**：新增 **per-pane 当前路径状态** `panePath` / `currentPath(pane)`，读、写、导航**统一用它**：
   ```
   const [panePath, setPanePath] = useState({ local: null, remote: null })
   const currentPath = (pane) => panePath[pane] ?? effectiveRoot(pane)
   useDirectory(readSessionId(pane), pane, currentPath(pane))   // 读
   navigate(): setPanePath(...) + loadPane(pane, to)             // 写
   ```
   一旦 `record.cwd` 有值，root **只**用 `record.cwd`（`reason:'record'`），**不再回落引导根**。
2. **`ui.parentPath` 给盘符路径补尾分隔符 ⇒ "上级"成了原地踏步**（"切换不了目录"的第二主因，也是 `×8` 的直接来源）。
   实测（加载真实 `client/src/session/ui.js`）：
   ```
   parentPath("C:\ws\sub")  -> "C:\ws\"           ← 多了尾分隔符
   parentPath("C:\...\profiles\") -> "C:\...\profiles\"   ← 同一目录：按上级永远不动
   ```
   `ui.js` 不在本轮范围，故在 `files.js` 内以 `normalizeDirPath()` **中和**：进入 `navigate`/`loadPane`/
   pane 根的值一律去掉尾分隔符（`/` 与 `C:\` 保持原样）。副作用同时消除：同一目录不再可能同时以
   `C:\x` 与 `C:\x\` 两个键各存一份。**`ui.parentPath` 本身的缺陷仍建议由 ui.js 的所有者修**（其它
   调用方在 Windows 下同样会踩）。
3. **上传只调用了一个可选 prop ⇒ 静默无操作**（"上传不了文件"的主因）。
   `startUpload` 末尾是 `if (typeof onUpload === 'function') onUpload(...)`，而真实调用点
   `h(FileManager, { sessionId })` **从不传 `onUpload`** ⇒ 目标路径算完就**什么都没发生**：无请求、无错误、
   无提示。**修复**：新增 `startTransfer(direction, …)`，容器回调优先，缺省回落到
   `runtime.actions.upload({sessionId, localPath, remotePath})`（即 `bridge.stream('upload', …)` →
   `sshPlugin/upload`）。同类静默失效的 `download/mkdir/rename/removePath/chmod` 一并加了回落
   （`runRemoteOp`）；**local pane 的写操作显式拒绝**（host 只有 `listLocalDir/statLocal`，没有本地写端点），
   给出 `SSH_STATE_INVALID` 而不是误发给远端端点。

**交互语义调整**：目录行**单击即进入**（旧版仅双击进入；在"视图本来就不跟着走"的前提下，单击无反应正是
用户感知到的"切换不了"）。为不牺牲文件夹操作，单击**同时选中**该目录（重命名/删除/chmod 仍作用于用户点的
那个文件夹，确认框会点名），`Ctrl/Cmd+单击`=**只选中不进入**；双击对目录不再重复导航（避免连点进入两级），
对文件保留"直接上传/下载"。

**新增日志**（沿用成功模式）：
`files: navigate {scope,from,to,via:'entry'|'up'|'crumb'|'api'}`、
`files: upload {scope,path,file,bytes,state:'picked'|'started'|'done'|'failed',code?}`、
`files: root {scope,effective,fromRecord,reason:'record'|'path'|'bootstrap'}`、
`files: entry {scope,name,kind,modified,action:'open'|'select'}`、`files: op {op,scope,state,…}`。
其中 `state:'done'` 指**流已被接受并在运行**（进度/结果归传输列表，不是"文件已传完"）。

**红线证据（先写红再修）**：反向改回两处——①读键退回 `effectiveRoot(pane)`（视图不跟随导航）、
②`startTransfer` 去掉 runtime 回落（只调回调）⇒ 新增 3 条中 **2 条失败**，失败文案正是用户症状：
`the subdirectory listing is displayed` 与 `an upload stream is issued`；第 3 条
（`re-rendering … does not re-issue`）两态皆绿，属**防重复触发的回归守卫**（单渲染不改变 deps）。
还原后 3/3 绿（"备份 → 反向 → 跑红 → 还原"，sha256 一致 `58FFC2D3…`）。

**新增测试**：

| 测试 | 断言 |
|---|---|
| `re-rendering the pane does not re-issue the same directory load` | 强制 8 次重渲染 ⇒ 每个 pane 只发 **1** 次 `files: loading`，`listLocalDir`/`listDir` 各只 1 次 |
| `opening a directory moves the pane into it and the bootstrap root does not take it back` | 单击目录 ⇒ `files: navigate{via:'entry',to:'C:\ws\sub'}` 恰 1 次；显示子目录条目、旧条目消失；`files: root` 末条 `reason:'record'`、`effective:'C:\ws\sub'`；再渲染**不**回退引导根（请求序列恰为 `['.', 'C:\ws\sub']`）；远端根 `/` 处 `..` **禁用**、`C:\ws\sub` 处**可用**，点击后 `via:'up'` 且回到 `C:\ws` |
| `the upload control issues an upload stream for the selected local file` | 选中本地文件后点上传 ⇒ 发出 1 条 `upload` 流，参数 `{sessionId:'s_1', localPath:'/local/build.log', remotePath:'/srv/build.log'}`；日志依次 `picked → started → done`，`file`/`bytes` 正确 |

**自测结果**（§9 + §9.1 + §9.2 合并）：

```
$ node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit     # 0 错误
$ node --test --test-concurrency=1 "test/client/session.test.mjs"     # 46 pass / 0 fail
$ node --test --test-concurrency=1 --test-timeout=30000 "test/client/*.test.mjs"
  ℹ tests 203  ℹ pass 203  ℹ fail 0            # 193 基线 + 10 新增
$ node --test --test-concurrency=1 --test-timeout=30000 "test/unit/*.test.mjs"
  ℹ tests 540  ℹ pass 537  ℹ fail 0  ℹ skipped 3
$ node scripts/build-client.mjs && node scripts/build-client.mjs --check
  wrote lib\client.js (888157 bytes) / client bundle is up to date
$ node scripts/lint.mjs                                        # 0 errors（本文件 0 finding）
```

**生效判据（用户侧）**：重启/刷新后点「文件」标签：

```
[dsh-ssh] ssh-files-2026-09-27.7-pane-navigate-upload load-deadline=8000ms local=. remote=/
[dsh-ssh] files: trigger … → files: loading … → files: loaded {entries:N}
[dsh-ssh] files: root {scope:'local', effective:'C:\…', reason:'record'}
```

- **进目录**：单击任一目录行 ⇒ 出现 `files: navigate {via:'entry', to:'…'}` 与一条 `files: loading`，
  列表**随即切换**、面包屑前进；点 `..` 出现 `via:'up'` 且**确实回到上一层**（不再原地重复）。
- **上传**：单击本地文件（选中）⇒ 点「Upload」⇒ 先 `files: upload {state:'picked'}`，随后
  **`rpc stream sshPlugin/upload {localPath, remotePath}`** 与 `state:'started'|'done'`，底部传输条出现进度。
  失败时 `state:'failed'` 带 `code`，并在界面给出可读原因（禁用态 `title` 也写明原因）。
- 过滤串（精确）：`files: navigate`、`files: upload`、`rpc stream sshPlugin/upload`。
- 或：`Select-String -Path lib\client.js -Pattern 'ssh-files-2026-09-27.7-pane-navigate-upload'`。

**仍存的边界**：`ui.parentPath` 的盘符尾分隔符缺陷在 `files.js` 内被中和，**共享 helper 本身未改**（不在本轮范围，建议其所有者修）；超时仍**不取消** host 调用（`runtime.js` 未改）；pane 的 `onNavigate/onRefresh` 等容器回调仍未被真实调用点传入——现在不传也能工作（回落到 runtime），传了则优先使用。

## 9.3 "不显示目录名"：布局把文件名挤成 0 宽（**渲染层，非数据层**）

**症状**：本机与远端两棵树的条目**只剩大小/权限/时间，文件名整体不可见**；数据侧完好（点击处理器的日志里 `name` 是完整文件名）。

**根因（CSS 布局，`client/src/session/styles.js`）**：条目行是五列 grid，列宽写死为

```
grid-template-columns: 18px minmax(0,1fr) 76px 66px 108px;  gap:6px;
```

其中**名字列是 `minmax(0,1fr)`（最小可为 0）**，而三列元数据是固定宽度。固定列合计
`18+76+66+108 = 268px`，加上 4 个 6px 间隙 = **292px 起步**；而 `.ssh-ws-panes` 把侧栏**对半**分给两个
pane，生产默认侧栏 420px ⇒ **每个 pane 约 207px**（条目内边距再吃掉 16px ⇒ 可用约 191px）。
于是名字列被压到 **0px**，再被 `.ssh-ws-entry-name { overflow:hidden }` 完全裁掉 ——
**"大小和时间看得见、文件名全没有"** 正是这个组合的唯一外观；两棵树同时中招，因为两个 pane 同宽。

**为什么既有门禁没抓到**：token-only 扫描只要求颜色来自 `--dsw-*`（颜色确实合法）；组件测试只断言
"能渲染"（名字**确实在 DOM 里**，只是宽 0）；linkedom 无布局引擎，纯 CSS 几何量不出来。
**这条缺陷只有真浏览器渲染能一眼区分"不可见"与"未渲染"。**

**修复（三处，均在 `client/src/session/styles.js`）**：

1. **名字列给硬下限**：`minmax(0,1fr)` → **`minmax(80px,1fr)`**（表头与条目行**同步修改**，否则列错位）。
   名字是唯一必须始终可读的列，因此**不允许**它是先让路的那一列。
2. **窄 pane 丢列而不是挤名字**：`.ssh-ws-pane` 加 `container-type:inline-size`，新增
   `@container (max-width:380px)`：五列 → `18px minmax(64px,1fr) 72px`（图标·名字·大小），
   `:nth-child(n+4)`（权限、时间）在**表头与条目行同时** `display:none`，保持对齐。
3. **名字元素自述语义**：`.ssh-ws-entry-name` 显式 `color:var(--dsw-alias-label-primary)` +
   `min-width:0` —— 排除"用背景族 token 当文字色"（同色不可见）这一类，且不被 `display:none`/`width:0` 隐藏。

**真机截图证据（真实浏览器）**：`scripts/shot-files.mjs` 用系统 Edge（headless）对**真实 SSR 产物 +
真实 `ssh.session.styles` 样式表 + 代表性 `--dsw-*` token 值**、在**生产侧栏宽度 420px**
（⇒ 每 pane ≈207px，正是出问题的宽度）下渲染文件页签：
`docs/img/session-files-light.png` 与 `session-files-dark.png`。两图中**本机与远端两棵树的文件名均可见**
（`build.log`、`cordis.patch.yml.bak-preset-standard-2026…`、`payload.bin`、`scripts` / `etc`、`www`、
`deploy-2026-01-05.tar.gz`、`run.sh`、`current`），与修复前"只剩元数据"的形态形成对照。

**红线证据（先写红再修，可复核）**：把两条 grid 的名字列改回 `minmax(0,1fr)` ⇒
`the row layout cannot squeeze the file name out of the pane` **立刻失败**，失败信息直接点出缺陷：
`saw: 18px minmax(0,1fr) 76px 66px 108px`。还原后绿（"备份→反向→跑红→还原"，sha256 一致）。

**新增测试**（`test/client/session.test.mjs`，headless 可执行）：

| 测试 | 断言 |
|---|---|
| `every entry row renders its name as text, and each column carries a value` | 用 linkedom 解析 SSR 产物：**每一行都有非空 `.ssh-ws-entry-name` 文本**且等于该条目自己的 `name`（不是占位符/翻译键）；同时**大小、权限、时间三列都非空**（只有名字缺失 ⇒ 映射/条件问题；多列全空 ⇒ 整行问题） |
| `the row layout cannot squeeze the file name out of the pane` | 断言样式表不变量：名字列**非零最小宽度**（且不得退回 `minmax(0,…)`）；**表头与条目行共用同一列定义**（防错位）；`.ssh-ws-pane` 有 `container-type:inline-size` 且窄布局规则存在；`.ssh-ws-entry-name` 的颜色取自 **label 族 token**（不得用 `bg` 族）且无 `display:none`/`visibility:hidden`/`width:0` |

**自测结果**（§9–§9.3 合并）：

```
$ node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit     # 0 错误
$ node --test --test-concurrency=1 "test/client/session.test.mjs"     # 48 pass / 0 fail
$ node --test --test-concurrency=1 --test-timeout=30000 "test/client/*.test.mjs"
  ℹ tests 205  ℹ pass 205  ℹ fail 0            # 193 基线 + 12 新增
$ node --test --test-concurrency=1 --test-timeout=30000 "test/unit/*.test.mjs"
  ℹ tests 540  ℹ pass 537  ℹ fail 0  ℹ skipped 3
$ node scripts/build-client.mjs && node scripts/build-client.mjs --check
  wrote lib\client.js (889633 bytes) / client bundle is up to date
$ node scripts/lint.mjs                                        # 0 errors（本目录 0 finding）
$ node scripts/shot-files.mjs                                  # 真机截图（Edge headless）
  wrote docs\img\session-files-light.png / session-files-dark.png
```

**生效判据（用户侧）**：重启/刷新后点「文件」标签 ⇒ console 首行应为
`[dsh-ssh] ssh-files-2026-09-27.8-entry-name-visible load-deadline=8000ms local=… remote=…`；
界面上**两棵树的每一行都应显示文件名**（本机与远端一致），名字过长时以省略号截断而非消失；
窄栏时权限与时间两列让位，名字与大小保留。或：
`Select-String -Path lib\client.js -Pattern 'ssh-files-2026-09-27.8-entry-name-visible'`。

**仍存的边界**：`docs/img/*.png` 为**真实浏览器渲染**，但输入是 SSR 产物 + 代表性 token 值（非 GUI 内
截图），真实配色仍以宿主 `--dsw-*` 为准；`@container` 的实际生效依赖 Chromium 容器查询（Edge 已支持），
单测锁的是**规则文本不变量**而非像素；`ui.parentPath` 的共享缺陷仍只在 `files.js` 内中和。
