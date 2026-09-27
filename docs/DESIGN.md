# SSH Plugin 总体设计（@local/dsh-ssh）

> 状态：**待用户确认后冻结**（本文件与 `ICD.md` 是 8 个子代理协作的基准）
> 版本：v1.0.0-draft · 主代理（Lead）所有

---

## 1. 目标与范围

在 DSH 右侧侧边栏提供完整的 SSH 可视化能力：连接管理、会话工作区（终端 / 命令 / 文件 / 日志）、多会话标签、状态栏、i18n 与主题对齐；后端提供 SSH 连接、命令执行、SFTP 文件传输能力，并同时以 Agent 工具形式暴露给模型。

**非目标**（本期不做）：跳板机 / ProxyJump 多跳、端口转发（本地/远程/动态）、SFTP 以外的传输协议（SCP/rsync）、密钥生成与管理 UI、Windows 目标机的 PowerShell 语义适配。

---

## 2. 关键架构决策（含依据）

| # | 决策 | 依据 |
|---|---|---|
| D1 | 插件形态：**一个本地插件包** `@local/dsh-ssh`，含 **host 半边**（Node/Cordis）+ **client 半边**（浏览器 bundle），通过 profile 的 bundle patch 装载 | 与已验证的本地插件模板 `@local/dsh-python` 同构；DSH `clientModules` 会把 `dsh.client` 声明编译成 `/plugins` 下的可加载 bundle |
| D2 | **语言/运行时：Node.js（DSH 自带 Node 24）**，不用 Python/Go | host 半边必须是与 DSH 同进程的 Cordis 插件，只有 Node 可选；Python/Go 需旁路进程，违背"同进程、随插件卸载回收"的设计 |
| D3 | SSH 库：**`ssh2`**（纯 JS，client + server + SFTP 全支持） | 用户给定的候选之一；同时它自带 **Server 实现**，在无 Docker 环境下可自建协议级真 sshd 测试靶机 |
| D4 | 终端：**vendor 打包 `@xterm/xterm`** 进 client bundle（自包含，零 external）；失败则退化为 `@xterm/headless` + 自研 DOM 渲染 | 保证 `top` 类全屏交互正确；平台基线模块表只保证 React/Cordis 可用，不能假设 xterm 在表内 |
| D5 | UI 组件库：**DSH 内置 `@deepseek-ai/dsh-client-ui-primitives` 的设计语言 + 自研轻量组件** | 该包是 shipped 静态 UI 库，但不保证在动态 bundle 的基线模块表内；自研组件 + `--dsw-*` 主题变量可 100% 对齐亮/暗色且零 external 风险 |
| D6 | 通信：**DSH Remote RPC（`ctx.typert` 运行时注册 + 客户端 `ctx.connection.rpc`）** 为主；若 M0 spike 证明不可行，退回到**同一认证栅栏内的 exact-route**（不使用 `webServer` 公开路由） | 浏览器到 host 的唯一受认证通道是 `/api` remote.mux；SSH 凭据敏感，**不允许**走未认证的公开 HTTP 路由 |
| D7 | 状态管理：**自研 store（`useSyncExternalStore` 语义）+ React hooks**，不引入 Zustand/Pinia | client bundle 必须零 external 才能自包含；store 需求简单（会话列表/标签/流缓冲），自研 < 150 行 |
| D8 | 配置：**Schemastery Config**（loader 行内 `config`）+ `cordis.patch.yml` 全量默认值；**凭据**走 `ctx.credentials`，**连接档案**走 `ctx.storage` | 与 DSH 配置体系一致；凭据永不进配置文件与日志 |
| D9 | 客户端 bundle 构建：**自研无依赖汇编器** `scripts/build-client.mjs`（IIFE + `SSH.define/require` 注册表），不用 tsdown/rolldown | 平台 bundle 格式是 `window.__ModuleLoader__.load({id, factory(require)})` 的 lazy-CJS，可手写；DSH 的构建预设不在本机 checkout 内，无法复用 |
| D10 | 客户端源码**多文件分工、单文件产物**：各 UI 子代理写互不重叠的 `client/src/**` 文件，由汇编器合成唯一 `lib/client.js` | `dsh.client` 只接受每个包一个 client bundle，但 8 个子代理要并行写 → 用"多源单产物"解决写冲突 |
| D11 | **Agent 活动镜像**（ICD §4.7）：host 侧一个有界内存环（`src/activity/feed.ts` 的 `ActivityFeed`）记录模型经 `ssh_*` 工具做过的事，经 `sshPlugin/followActivity`（流，**无参数**）交给「终端」标签的第二面；`sshPlugin/clearActivity` 清**全局**历史 | 工具调用不经过 client 发起的任何流，所以模型干活时「终端」标签只能是空白；镜像让"模型做了什么"可见。**有界**（`activity.*`，默认 200 条 / 64 KiB 每条 / 1 MiB 全局）是刻意的：它持有的是内存里的**远端原始输出**，是**视图不是日志** —— durable 且脱敏的记录始终是审计文件（ICD §4.6、§12 R10） |

---

## 3. 模块划分

```
dsh-ssh/
├── package.json / tsconfig.json / cordis.patch.yml / dsh.plugin.json / icon.svg   [Lead]
├── docs/{DESIGN.md,ICD.md,ARCHITECTURE.md,DEMO.md,TESTING.md,ACCEPTANCE.md,img/*} [Lead / SP5 / SP6 / SP8]
│
├── src/                              ← HOST 半边（TypeScript → tsc → lib/）
│   ├── protocol.ts                   冻结的 wire 类型 + 错误码表            [Lead]
│   ├── index.ts                      Cordis 插件入口（name/inject/Config/apply）[Lead]
│   ├── api/                          Remote 端点表 + LocalApi 门面（薄委托层）[Lead]
│   ├── api/activity-api.ts           §4.7 活动镜像的读侧：事件→帧、clearActivity [Lead]
│   ├── activity/feed.ts              Agent 活动镜像：有界内存环 + 事件广播     [镜像 owner]
│   ├── config.ts                     Schemastery Config schema              [SP4]
│   ├── logger.ts / redact.ts         结构化日志 + 脱敏                      [SP4]
│   ├── credentials.ts                凭据引用（ctx.credentials / env）       [SP4]
│   ├── known-hosts.ts                known_hosts 校验（strict/accept-new/insecure）[SP4]
│   ├── audit.ts                      审计日志（JSONL）+ 查询                [SP4]
│   ├── store.ts                      连接档案持久化（ctx.storage）           [SP4]
│   ├── connection/                   连接池 / 认证 / keepalive / 重试 / 状态机 [SP1]
│   ├── sessions.ts                   多会话注册表 + 并发信号量               [SP1]
│   ├── exec/                         单命令 + PTY shell + 流式输出 + 超时中断  [SP2]
│   ├── sftp/                         传输 / 递归 / 分块 / 断点续传 / chmod     [SP3]
│   └── tools/                        Agent 工具（ssh_exec / ssh_upload …）    [SP2 + SP3]
│
├── client/                           ← CLIENT 半边（无构建的 ESM 风格源码 → lib/client.js）
│   ├── src/index.js                  客户端插件入口：标签类型 + 面板注册      [SP5]
│   ├── src/bridge.js                 RPC 绑定 + 信封 + 流分用（唯一传输耦合点）[SP5]
│   ├── src/store.js                  客户端状态 store + hooks                [SP5]
│   ├── src/conn/**                   连接列表 / 新建编辑表单 / 搜索分组 / 掩码  [SP5]
│   ├── src/session/**                终端 / 命令面板 / 文件管理 / 日志          [SP6]
│   ├── src/session/activity.js       终端标签的第二面：Agent 活动镜像（只读）  [SP6]
│   ├── src/vendor/xterm.js           vendor 的 xterm                          [SP6]
│   ├── src/chrome/**                 标签栏 / 状态栏 / 快捷键 / 二次确认 / toast [SP7]
│   ├── src/theme.css                 --dsw-* 主题对齐样式                     [SP7]
│   └── src/styles.css                布局样式                                [SP5]
│
├── locale/{zh.json,en.json}          i18n 资源（命名空间 ssh）                [SP7]
├── scripts/build-client.mjs          客户端汇编器                            [SP5]
├── scripts/vendor-xterm.mjs          xterm vendor 脚本                      [SP6]
├── scripts/verify-all.mjs            一键 lint+test+build                    [SP8]
├── examples/config/*.yml             配置示例（全可配项 + 默认值）             [SP4]
├── test/unit/*.test.mjs              单元测试（按模块前缀分文件）              [各 owner]
├── test/support/sshd.mjs             基于 ssh2 Server 的本地真协议 sshd         [SP8]
├── test/client/**                    组件测试（Node + React + linkedom）       [SP5/SP6/SP7]
├── test/integration/**               集成测试（对 sshd 靶机）                  [SP8]
├── test/e2e/**                       端到端（真实 GUI 走查脚本）               [SP8]
├── README.md / CHANGELOG.md                                                  [SP8]
└── lib/{index.js,client.js}          构建产物（提交入库，DSH 直接消费）
```

**边界规则**：`src/protocol.ts` 与 `docs/ICD.md` 是唯一的跨模块真源，Lead 独占写入；`src/api/**` 与 `src/index.ts` 为集成缝，Lead 独占；`client/src/bridge.js` 是客户端唯一传输耦合点，SP5 独占。任何子代理**禁止**改他人 scope 内的文件或修改签名；需要变更必须先回报 Lead。

---

## 4. 数据模型（关键实体）

```ts
type ProfileId = string        // 'p_' + ulid
type SessionId = string        // 's_' + ulid
type StreamId  = string        // 'st_' + ulid
type OpId      = string        // 'op_' + ulid

type AuthKind = 'password' | 'privateKey' | 'agent'

interface ConnProfile {
  id: ProfileId; name: string; host: string; port: number; user: string
  auth: AuthKind
  secretRefs: { password?: string; passphrase?: string; privateKeyPath?: string }  // 仅引用，非明文
  connectTimeoutMs: number; keepaliveIntervalMs: number; keepaliveCountMax: number
  retries: { max: number; backoffBaseMs: number; backoffMaxMs: number; jitter: boolean }
  hostKeyPolicy: 'strict' | 'accept-new' | 'insecure'
  group?: string; tags: string[]; defaultCwd?: string; defaultEnv?: Record<string,string>
  createdAt: string; updatedAt: string; lastUsedAt?: string
}

type SessionState = 'idle'|'connecting'|'authenticating'|'connected'|'closing'|'closed'|'error'

interface SessionInfo {
  id: SessionId; profileId?: ProfileId; label: string
  host: string; port: number; user: string
  state: SessionState; since: string
  metrics: { connectMs?: number; rttMs?: number; bytesIn: number; bytesOut: number }
  capabilities: { shell: boolean; sftp: boolean }
  error?: ErrorInfo
}

interface ExecResult { streamId: StreamId; exitCode: number|null; signal?: string
  stdout: string; stderr: string; truncated: { stdout: boolean; stderr: boolean }
  durationMs: number; timedOut: boolean }

interface TransferTask { opId: OpId; direction: 'upload'|'download'
  localPath: string; remotePath: string; totalBytes?: number; transferred: number
  phase: 'scan'|'transfer'|'finalize'|'verify'|'done'|'cancelled'|'error'
  bytesPerSec: number; etaMs?: number; resumeFrom?: number; error?: ErrorInfo }

interface AuditEntry { at: string; op: string; sessionId?: SessionId; profileId?: ProfileId
  outcome: 'ok'|'denied'|'error'; durationMs?: number
  target?: { host: string; port: number; user: string }
  detail?: Record<string, unknown> }   // 已脱敏

// —— Agent 活动镜像（ICD §4.7）：模型经 ssh_* 工具做过什么的**只读投影** ——
type ActivityKind = 'exec'|'upload'|'download'|'listDir'|'stat'|'connect'|'disconnect'|'sessions'
type ActivityStatus = 'running'|'ok'|'error'|'timeout'|'cancelled'|'refused'
type ActivityChannel = 'stdout'|'stderr'|'info'
interface ActivityChunk { channel: ActivityChannel; text: string }

interface ActivityView {
  id: string                      // 'act-N'：feed 内单调，clearActivity 后不复用
  kind: ActivityKind; sessionId: SessionId|null; target: string|null   // 每条记录自带归属
  subject: string; cwd: string|null; label: string|null
  startedAt: number; endedAt: number|null; durationMs: number|null
  status: ActivityStatus; exitCode: number|null; signal: string|null
  code: string|null; note: string|null
  segments: ActivityChunk[]       // 到达序；同频道相邻段已合并
  truncated: boolean              // 丢过字节才为 true；短输出 ≠ 没输出
}   // 有界视图：非 durable、不脱敏（ICD §4.7、§12 R10）
```

---

## 5. 通信协议（摘要，完整见 ICD.md）

**单向信封**，与传输绑定解耦：请求 `{ id, method, params }`；响应 `{ id, ok:true, result }` 或 `{ id, ok:false, error:{ code, message, details?, retryable } }`。

**流式帧**（终端输出、命令 stdout/stderr、传输进度、会话状态、审计）统一为 `Frame` 判别联合：`data | exit | progress | state | audit | end`。**禁止轮询**：所有持续输出用流端点；UI 只在流中断时按指数退避重连。
§4.7 的活动镜像另加三种帧（`activity-snapshot | activity | activity-reset`，正文见 ICD §4.7）：它同样走流端点，但 **host 不为它发 `open`/`end`** —— 订阅以 `activity-snapshot` 开始，取消订阅即结束。客户端在传输层结束时仍会收到一个 `end` 帧（`bridge.js` 在载体结束时补发/转发的结束语义），`ssh.session.activity` 用它清掉订阅句柄而**保留已收到的记录**。

**方法集**（命名空间 `sshPlugin/*`）：`ping`、`listProfiles`、`saveProfile`、`deleteProfile`、`duplicateProfile`、`testProfile`、`connect`、`disconnect`、`listSessions`、`openShell`、`shellWrite`、`shellResize`、`shellClose`、`exec`(流)、`execWait`(一元)、`listDir`、`stat`、`mkdir`、`rename`、`removePath`、`chmod`、`upload`(流)、`download`(流)、`cancelTransfer`、`queryAudit`、`followAudit`(流)、`pendingHostKey`、`decideHostKey`、`followActivity`(流，§4.7)、`clearActivity`(一元，§4.7)。

**命名冲突规避**：DSH 已存在 host Service `ssh`（远程主机传输用，非本插件），本插件端点命名空间用 `sshPlugin/*`，自有 host service 用 `ctx.provide('sshPlugin', …)`，**不注册名为 `ssh` 的服务**。

### 5.1 Agent 活动镜像：谁写、谁读（ICD §4.7）

```
ssh_* 工具（src/tools/*.ts）
   │  begin / chunk / finish        ← 唯一写入方：只有工具知道"要做什么"和"看到了什么"
   ▼
ActivityFeed（src/activity/feed.ts）  ← 有界内存环 + 订阅广播（无队列、无重放、无背压）
   │  snapshot() + 事件（begin/end 整条、chunk 增量、reset）
   ▼
ActivityApi.follow()（src/api/activity-api.ts）  ← 事件→帧的唯一转换点
   │  帧（activity-snapshot / activity / activity-reset）
   ▼
bridge.stream('followActivity')  →  ssh.session.activity 的 store  →  AgentActivityPane
```

- **写入方只有 agent 工具**（`src/tools/*.ts`）：面板自己发起的 `exec`/`openShell`/上传下载**不进**镜像——它们本来就有自己的流与标签页，镜像因此不会自我循环。
- **读取方是面板**：`followActivity` 是**一个全局订阅**（无参数，每条记录自带 `sessionId`/`target`），因此"另一个主机上的工作"也看得见；`clearActivity` 清的是**全局**历史，两个面板与一次重载后的页面不得对"模型做过什么"各执一词。
- **生命周期归 `runtime.ts`**：按 `config.activity` 构造 feed，插件卸载时 `activity.dispose()` 释放已捕获的文本（host 侧**长期**持有远端原始输出的地方，所以"卸载即不留捕获输出"必须是一个动作，而不是对采集器的期望）。
- **镜像不影响被观察的操作**：`begin`/`chunk`/`finish` 对任何输入都不抛，订阅者抛异常也只记 `warn`（ICD §12 R10）。

### 5.2 「终端」标签的两面与跟随规则（`client/src/panel.js` + `client/src/session/activity.js`）

「终端」标签下面是**两个面**，各有自己的状态；切换器是标签内的一行（`.dsh-ssh-term-switch-row`，组件 `AgentActivitySwitch`）：

| 面 | 渲染 | 是什么 |
|---|---|---|
| `terminal` | `ssh.session.terminal` 的 `TerminalTab` | 交互式 PTY —— **用户**的会话（`openShell` 流） |
| `activity` | `ssh.session.activity` 的 `AgentActivityPane` | **模型**做过什么的只读镜像（全局 feed） |

跟随规则（三条，实现见 `SessionView`）：

1. **有活动的会话直接开在镜像面**：`termFace` 的初值**读 store**（不是等第一帧到达），所以"agent 刚干过活"的会话重新打开时，不会先闪一个空白终端。
2. **新活动自动切到镜像面**，但有两个例外：①用户**正在终端里打字**（判据是决策点上的 DOM 读 `document.activeElement.closest('.ssh-ws-term')`，避免把正在输入的按键切走）；②**用户自己选过面**（`faceChosenByUser`，显式选择不再被自动切换覆盖）。
3. **自动切换只看"本会话"**：`summary.total`/`running` 按 `sessionId` 过滤；另一台主机上的工作只点亮全局未读徽标（`summary.all.unread`），不会抢走当前视图。切到镜像面时标记已读（`markActivitySeen()`）。

镜像面自身的边界：只画最新 200 条（store 保留 400 条）；用户上滚即停止跟随并出现"跳到最新"；`清除` **先清本地**、再**尽力**调用 `clearActivity`（传输不可用时也能清屏，且下一次重载不会把用户刚清掉的历史带回来）。镜像**只渲染、不驱动**：它不发起任何 `exec`、按键或传输。

---

## 6. 8 个子代理分工、写作用域与依赖

| # | 子代理 | 职责 | 写作用域（互不重叠） | 依赖 |
|---|---|---|---|---|
| 1 | `sp1-connection` | 连接池/复用/上限、密码/私钥/passphrase 认证、keepalive、超时、重试退避、会话状态机、优雅断开、并发信号量 | `src/connection/**`, `src/sessions.ts`, `test/unit/connection*.test.mjs`, `src/connection/README.md` | M0 |
| 2 | `sp2-exec` | 单命令（stdout/stderr/exit code）、PTY shell、stdin、流式推送、超时中断、env 与 cwd、Agent 工具 `ssh_exec` | `src/exec/**`, `src/tools/exec.ts`, `test/unit/exec*.test.mjs`, `test/unit/shell*.test.mjs`, `src/exec/README.md` | M0；真机联调待 SP1 |
| 3 | `sp3-sftp` | 上传/下载、目录递归、大文件分块、断点续传、进度回调、chmod、Agent 工具 `ssh_upload/ssh_download/ssh_list_dir` | `src/sftp/**`, `src/tools/files.ts`, `test/unit/sftp*.test.mjs`, `src/sftp/README.md` | M0；真机联调待 SP1 |
| 4 | `sp4-security` | 凭据（`ctx.credentials`/env）、日志脱敏、known_hosts 三档策略、审计日志、Config schema、连接档案持久化、配置示例 | `src/config.ts`, `src/logger.ts`, `src/redact.ts`, `src/credentials.ts`, `src/known-hosts.ts`, `src/audit.ts`, `src/store.ts`, `examples/**`, `test/unit/security*.test.mjs`, `test/unit/config*.test.mjs`, `src/security/README.md` | M0（埋点在 ICD 已约定） |
| 5 | `sp5-conn-ui` | 侧边栏面板注册、折叠/展开/宽度拖拽/状态持久化、连接列表、新建编辑表单、连接/断开/测试、搜索分组、掩码切换、**bridge + store + 汇编器** | `client/src/index.js`, `client/src/bridge.js`, `client/src/store.js`, `client/src/conn/**`, `client/src/styles.css`, `scripts/build-client.mjs`, `test/client/conn*.test.mjs`, `docs/img/conn-*.png` | M0（传输 spike 完成后定稿 bridge） |
| 6 | `sp6-workspace-ui` | 终端标签（xterm + 复制粘贴 + 字号 + 清屏 + 重连）、命令面板（历史上下翻）、文件管理（双栏/递归/新建/重命名/删除/chmod/进度条）、日志标签 | `client/src/session/**`, `client/src/vendor/**`, `scripts/vendor-xterm.mjs`, `test/client/session*.test.mjs`, `docs/img/session-*.png` | SP5 布局约定 + ICD props |
| 7 | `sp7-chrome-i18n` | 多标签打开/切换/关闭/拖动排序、状态圆点、顶部状态栏（连接信息/延迟/时长）、快捷键、危险操作二次确认、toast、中英 i18n、亮暗主题对齐 | `client/src/chrome/**`, `locale/*.json`, `client/src/theme.css`, `test/client/chrome*.test.mjs` | SP5/SP6 组件接口（ICD 已冻结） |
| 8 | `sp8-test-docs` | 本地真协议 sshd 靶机、集成测试、E2E、lint、覆盖率、10 会话并发与 100MB 性能、README/CHANGELOG/API 文档/UI 说明、最小可运行 demo | `test/support/**`, `test/integration/**`, `test/e2e/**`, `scripts/verify-all.mjs`, `README.md`, `CHANGELOG.md`, `docs/{DEMO.md,TESTING.md}`, `.eslintrc*`, `eslint.config.js` | 框架可先建；集成待 SP1–SP7 |

### 依赖图

```
                 M0  主代理：ICD 冻结 + 脚手架 + 传输 spike + 装载验证
                 │
     ┌───────────┼───────────┬───────────┬───────────┐
     ▼           ▼           ▼           ▼           ▼
    SP1         SP4         SP5         SP8        (SP2/SP3 起步：mock 层)
  连接核心    安全/配置    UI 骨架          测试框架
     │                       │
     ├──────────► SP2       ├──────────► SP6
     ├──────────► SP3       └──────────► SP7
     │                       │
     └───────────┴───────────┴──────────► SP8 集成/E2E/性能
                                              │
                                              ▼
                              M5  主代理：联调 + UI 走查 + 验收报告
```

**并行度**：M1 阶段 SP1/SP2/SP3/SP4/SP5 五路并行（SP2/SP3 先对 ICD 冻结的 `SessionHandle` 接口写 mock 驱动）；M3 阶段 SP6/SP7 并行；SP8 全程在场，先建靶机与测试框架。

---

## 7. 里程碑与出口标准

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| **M0** | ICD 冻结；包脚手架；`sshPlugin/ping` 一元 + 流端点打通；插件在 GUI 右侧栏出现可点标签 | ✅ **已完成**（证据见 `docs/M0-SPIKE.md`）：host 行 `fiberPhase: active`、无需重启；客户端在真实页面注册 `sidebar.panellist#ssh`、`sidebar.right.pane.tab#ssh`、`shell.overlay#ssh-spike` 全部 active；`tsc` 0 错；单测 33/33 + 客户端 17/17 |
| **M1** | SP1–SP4 host 模块完成（源码 + 单测 + README + 自测报告） | `node --test test/unit/**` 全绿；对本地 sshd 靶机连接/执行/传输通过 |
| **M2** | SP5 UI 骨架 + 连接管理界面完成 | 组件测试全绿；截图；可在 GUI 新建连接并连接靶机 |
| **M3** | SP6 工作区 UI + SP7 多标签/状态栏/i18n/主题完成 | 终端跑 `uname -a` 正确；`top` 类交互可用；亮暗色截图 |
| **M4** | SP8 集成/E2E/性能/覆盖率/文档/demo | 集成与 E2E 全绿；10 会话并发无串扰；100MB 传输校验一致；lint 零错误 |
| **M5** | Lead 联调、UI 走查、验收报告 | `docs/ACCEPTANCE.md` 逐条对照用户十条验收标准，全部通过或明确记录偏差 |

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **R1 传输绑定不确定**：`ctx.typert.register` 运行时注册 Remote 端点未在文档给出完整贡献形状 | 阻塞全部 UI | ✅ **已定位**：`@Remote` 标准装饰器 + `bindTypertRemote` 的**源码模式发现**成立（`remoteMethods()` 实测），客户端候选通道自动探测并以真实 ping 为准（`bridge.js`）；UI 侧另有备份：若主通道在页面内未命中，退 exact-route，信封不变 |
| **R2 无真实 Linux 靶机**：本机无 Docker、无 WSL，仅有 Windows OpenSSH 客户端 | 无法满足"真实 Linux 服务器"验收 | 用户已确认**提供一台真实 Linux 服务器**（待提供 host/port/user + 认证方式）；另建 `ssh2` Server 协议级靶机用于确定性自动化测试 |
| **R3 客户端 bundle 装载细节**：`dsh.client` 读取路径、动态 row 的基线模块表内容、React 版本 | UI 可能整块加载失败 | M0 用最小 bundle 验证；零 external 策略（只 `require("react")`）；打包冒烟测试进 M0 出口标准 |
| **R4 xterm vendor 失败** | 终端体验退化 | 备选 `@xterm/headless` + 自研 DOM 渲染；再退化为"行模式终端"（已定稿的降级接口不变） |
| **R5 手写汇编器引入构建缺陷** | 产物与源码不一致 | 汇编器本身有单测（确定性输出、顺序无关、重复定义报错）；产物带 GENERATED 头；CI 校验"重新汇编 == 入库产物" |
| **R6 修改用户正在使用的 GUI profile** | 影响当前会话 | 需用户授权；改动前备份 `package.json`/`cordis.patch.yml`；提供回滚脚本 |
| **R7 凭据泄漏** | 安全验收失败 | 凭据只以引用形式落盘（`ctx.credentials`）；日志/审计/UI 三层脱敏，脱敏函数有对抗性单测（含正则化尝试） |
| **R8 8 路并行写冲突** | 返工 | 写作用域表 + 共享任务板 `write_scopes`；`protocol.ts` 单一所有者；接口变更必须回报 Lead |

---

## 9. 与用户技术约束的对应

| 用户约束 | 本项目取值 |
|---|---|
| 语言/运行时 | Node.js（DSH 内置 Node 24）——host 半边必须同进程 |
| SSH 库 | `ssh2`（client + server + SFTP） |
| 终端 | `@xterm/xterm`（vendor 进 bundle） |
| 配置 | Schemastery schema + YAML（`cordis.patch.yml`）+ 环境变量（凭据与覆盖） |
| 日志 | 结构化 JSONL + 级别可配 + 三层脱敏 |
| 测试 | 单元（node:test）+ 集成（本地真协议 sshd）+ 组件（React + linkedom）+ E2E |
| 规范 | ESLint（含 TS 与 client 侧）+ `tsc --noEmit` + Prettier（可选） |
| 状态管理 | 自研 store（`useSyncExternalStore` 语义） |
| UI 组件库 | DSH 内置设计语言（`--dsw-*` token）+ 自研轻量组件 |
