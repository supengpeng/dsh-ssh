# 客户端 → host 通道（carrier）：实测形态、坑位与 Plan B

> 本文是 **SP7 在 i18n/载体事故收尾时的落盘记录**（Lead 上下文交接要求）。
> 适用于 `@local/dsh-ssh`（本地安装、**没有** Typert 编译器生成物）这类插件。
> 结论全部来自读 shipped bundle 源码 + 用户真实 console，**不是试错**；行号按本机 asar 版本。

---

## 1 · 通道的真实形态（我们最终采用的方式）

```js
// client/src/bridge.js → strategy `connection-rpc`
const rpc = ctx.get('connection').rpc
const result = await rpc.call('/api', 'sshPlugin/<method>', { args: { <wire>: <JSON 串> } }, signal)
```

依据（每条都有源码位置）：

| 事实 | 位置 |
|---|---|
| 网关**自己**就是这样调用 Remote 的：`connection.rpc.call('/api', endpoint, { args }, signal)` | `@deepseek-ai/dsh-api-gateway/lib/client.js:1792` |
| 传输实现：`POST api/<ns>/<method>`，信封 `{type:'client-request', rpcId, method, payload}`，返回 server 信封的 `result` | `@deepseek-ai/dsh-client-connection/lib/client.js:1212-1231` |
| 目标校验：`assertTarget` 把 endpoint 按 `/` 分段，每段须匹配 `/^[A-Za-z0-9_$.-]+$/` → `sshPlugin/ping` 是合法两段 | 同上 `:1317-1320` |
| `payload` 必须是**恰好一个** `args` 键的 plain object | `@deepseek-ai/dsh-api-gateway/lib/index.js:802` |
| 返回信封：`{ok:true,value}` / `{ok:false,error:{code,message,details}}` | 同上 `:1795-1806` |

**为什么不用 `$mount()` 自装 contribution**：`$mount(contribution)` 会走两套校验，第二套要求**生成物级**字段——
`dsh-typert-registry/lib/client.js:933` 的 `RemoteStore.register()` → `DescriptorStore.validate()` → `validateInvocation()`（`:1314`）要求每个 descriptor 有 `id` / `service` / `result`(codec)，
而平台自己的描述符来自 **Typert 编译器产物**（`typert.remote-client.js`）。本地插件没有这些产物，
早期症状就是 `Cannot read properties of undefined (reading 'length')`（它遍历我们没提供的数组）。
（我们仍把 descriptor 形状补全并在 `$mount` 前自检，见 §3；但**主通道是上面的 RPC**。）

**为什么不用 exact-route**：见 §4 Plan B——它是备选，因为上面的 RPC 通道已经存在且够用。

### 1.1 参数必须走"单字段 + JSON 串"

```jsonc
// ✅ 正确：args 里恰好一个键，值是 JSON 字符串
{ "args": { "raw": "{\"sessionId\":\"s_1\",\"path\":\"/tmp\"}" } }
// ❌ 错误一：把富对象直接放进去（M0 §7.2 实测会掉字段）
{ "args": { "raw": { "sessionId": "s_1", "path": "/tmp" } } }
// ❌ 错误二：多带字段（网关直接拒）
{ "args": { "raw": "…", "profileJson": "…" } }
```

- **规则来源**：`src/api/params.ts:1-24`（ICD §12 R1.3）——源模式端点没有生成的参数 codec，
  载波对**富对象**的投递是**有损**的（M0 §7.2：六键对象到达时只剩两键，连嵌套对象**之后**的字符串都丢了）。
  因此：payload 是**原始值扁平对象**，嵌套结构以 `<field>Json` **JSON 串**过线，host 端 `decodePayload()` 解析回来。
- **wire 字段名 = host 方法源码里的形参名**（`dsh-api-gateway/lib/index.js:1014-1041` `srcDescriptor()`
  → `{name, wire: name, source:'json', codec:{mode:'src-json'}}`）。我们的对照表（`bridge.js` 的 `WIRE_ARG_BY_METHOD`）：

  | 端点 | wire 字段 |
  |---|---|
  | `ping` | `params` |
  | `reportSpike` | `payload` |
  | `followSessions` | `_raw`（下划线是形参名的一部分） |
  | `getConfig` `listSessions` `listTransfers` `clearAudit` | 无参 → `args: {}` |
  | 其余 §4 端点 | `raw` |

  该表由测试**从 `src/service.ts` 反推**校验（`test/client/chrome-carrier.test.mjs`），host 改签名会在 CI 红。
- **严格性**：`assertExactArguments()`（`dsh-api-gateway/lib/index.js:1488-1499`）
  **多一个字段即拒**（`gateway/arguments-invalid`，报文含 `unexpected "…"`）；
  但缺一个 `src-json` 参数**可以接受**（host 会以 `undefined` 调用，由我们的 API 层给出 `SSH_CFG_INVALID`）。

---

## 2 · 网关保留名集合（方法名不能撞）

`RemoteNamespaceService.assertMethodAvailable`（`dsh-api-gateway/lib/client.js:1919-1934`）在装配每个 Remote 方法前检查，
名字已存在即拒：`client api: method "sshPlugin/<name>" conflicts with its namespace service`。

保留名 = 三条规则的并集：

1. `REMOTE_NAMESPACE_FIELDS`（`:2032`）：`ctx` `empty` `invokeRemote` `methods` `name` `namespace`
2. 该类自身 prototype：`assertMethodAvailable` `has` `install` `installDirect` `installScoped` **`remove`** `constructor`
3. 实例上已有的其它成员：`Object.prototype` 一族（`toString` `valueOf` `hasOwnProperty` `isPrototypeOf`
   `propertyIsEnumerable` `toLocaleString` `__proto__` `__defineGetter__` `__defineSetter__`
   `__lookupGetter__` `__lookupSetter__`）以及任何 cordis `Service` 成员

**实测命中**：ICD §4.5 的 `remove`（网关用它卸载已装方法）→ 已端到端改名 **`removePath`**
（ICD §4.5、`src/service.ts`、`src/api/files-api.ts` 注释、`client/src/session/runtime.js`、
`client/src/bridge.js`、单测）。**ICD §7 的进程内 `SftpHandle.remove` 不变**（不是 wire 名）。
`bridge.js` 导出 `RESERVED_METHOD_NAMES`（含 cordis 版本相关的保守超集），并有测试断言 descriptor 不含保留名。

---

## 3 · 形状自检与诊断（不要让别人再看 `undefined.length`）

- `bridge.js` 的 `missingContributionFields()`：按两套校验器的必需字段清单
  （`package`、`descriptors[].{id,service,namespace,method,invocation.kind,result,parameters[].{wire,codec.mode:'strict'}}`）
  在 `$mount` **之前**自检，缺什么打印什么。
- 合成 contribution 只尝试**一次**（`syntheticMountRefused` + `syntheticMountError` 在后续轮次重放原因），
  不再每 250ms 刷同一句错误。
- 每次调用有**两个方向的日志**（**值经脱敏**，见 §3.1）：
  ```
  [dsh-ssh] rpc send sshPlugin/testProfile {"args":{"raw":"{\"profileId\":\"p_01M3F91\"}"}}
  [dsh-ssh] rpc recv sshPlugin/testProfile ok
  [dsh-ssh] rpc send sshPlugin/setSecret {"args":{"raw":"{\"profileId\":\"p_01M3F91\",\"field\":\"password\",\"value\":\"«redacted»\",\"persist\":true}"}}
  [dsh-ssh] rpc recv sshPlugin/setSecret error SSH_AUTH_FAILED: …
  ```
- UI 侧：`client/src/conn/ui.js` 的 `errorText()` 现在把 host 的 message 附在字典句子之后
  （`参数校验失败：profileId or an inline profile is required`），不再只给一句无法行动的文案。

### 3.1 凭据脱敏（**安全红线，改动日志前必读**）

第一版日志**按键名**脱敏，结果**明文泄露了真密码**：`setSecret` 把密钥放在**通用键** `value` 里，由同级 `field` 命名——

```json
{ "profileId": "p_01M3F91", "field": "password", "value": "example-not-a-real-secret", "persist": true }
```

`value` 不在脱敏名单里，于是密码原样进了 console（用户截图/贴日志即外泄；验收标准第 6 条禁止凭据出现在日志或 UI 明文）。现在 `bridge.js` 的 `redactForLog()` 用**三层规则**，缺一不可：

| 规则 | 覆盖 | 例子 |
|---|---|---|
| ① 按键名递归（`pass`/`secret`/`token`/`privatekey`/`credential`/`apikey`，大小写无关，任意深度） | 常见命名 | `password`、`passphrase`、`secrets.token`、`api_key` |
| ② 按结构：对象里 `field` 命名了密钥且带 `value` | `setSecret` 形状 | `{field:'password', value:'…'}` |
| ③ **按值**：①②替换掉的值登记进 `loggedSecretValues`，此后**每一行日志**都扫描并替换这些字面量 | 密钥从**任何**其它路径出现（嵌套串、host 报错回显、后续调用） | `{note: "the password is …"}` |

另外：`raw` 是 JSON **字符串**，日志前**先解析**再按键名递归脱敏（对序列化文本做替换等于瞎猜）；日志限长 400 字符；UI 侧 `errorText()` 也过同一个 scrubber（host 句子可能回显提交值）。

**回归门**（`test/client/chrome-carrier.test.mjs`）：`the diagnostic log never carries a credential`、`the redactor handles every shape a credential can arrive in`、`a credential can neither be logged nor rendered in the UI` —— 构造带密码的 `setSecret`/`connect` 调用并回显式 host 报错，断言**日志与 UI 文本都不含**该密码。**任何新增日志都必须先过 `redactForLog`。**

---

## 3.2 流式（`openShell` / `exec` / 传输进度 / 实时日志）

**平台的真实流式入口有两个，网关自己就是这个顺序**（`dsh-api-gateway/lib/client.js:1651-1655`）：

```js
const local = connection.rpc.open?.('/api', endpoint, payload, signal, uplink)
return local === void 0 ? this.streams.open(endpoint, payload, signal, uplink) : normalizeConnectionStream(local)
```

| # | 入口 | 本 build 是否存在 | 依据 |
|---|---|---|---|
| 1 | `connection.rpc.open('/api', endpoint, payload, signal, uplink)` | ❌ **不存在**（纯 Web 组合没有 in-process opener；`rpc.open` 仅在构造时传入了 `openStream` 才有） | `dsh-client-connection/lib/client.js:1233`：`...openStream === void 0 ? {} : { open(channel, endpoint, payload, signal, uplink) { … } }` |
| 2 | `ctx.remote.streams.open(endpoint, payload, signal, uplink)` | ✅ **这就是我们要用的** | 网关自有 `RemoteStreamMuxClient`（`:325`，注释：*"Keep one physical WebSocket and share it among independently cancellable Remote streams. A carrier that supplies an in-process stream opener never starts one."*）；`streams = new RemoteStreamMuxClient()`（`:1591`），且**当 `connection.rpc.open === void 0` 时网关自己 `this.streams.start()`**（`:1600`）；`open()` 是 `async *` 生成器（`:374`），产出 host 的 ICD §3 帧（`open`/`data`/`exit`/`end`/`error`），按 `streamId` 复用（`:586`） |

所以 `bridge.js` 的 `open()`：先试 `rpc.open`（有则用），否则用 `ctx.remote.streams.open`，两者都拿到**同一个 `(endpoint, payload, signal, uplink)` + `{args: 单字段 JSON 串}` 规则**，返回 async iterable 直接喂给 `bridge.stream()` 既有的 `for await` 泵（含 `streamId` 绑定、`seq` 去重、`end` 终止、`cancel()` 触发 `generator.return()` → 复用 socket 的订阅释放）。

**两个都缺失时**（capability gap，不是未知故障）：抛 **`SSH_NET_UNREACHABLE`**（ICD §5 网络族、`retryable: true`、`details.reason = 'no-stream-carrier'`），文案点名受影响的功能与"一元调用仍可用"，并在 console 打 `[dsh-ssh] no stream carrier: …`。**不发明新码**。

#### ⚠️ `signal` 是必填参数（实测踩坑，改动时务必保持）

`RemoteStreamMuxClient.open(endpoint, payload, signal, uplink)` 的**第一句**就是 `signal.throwIfAborted()`（`dsh-api-gateway/lib/client.js:375`），随后 `signal.addEventListener('abort', …)`（`:388`）。把 `signal` 传成 `undefined` 得到：

```
code: SSH_UNKNOWN   message: Cannot read properties of undefined (reading 'throwIfAborted')
```

——**纯客户端失败、host 侧零记录**（这正是"`rpc stream` 已发出、host 却什么都没收到"的真因）。因此 `bridge.js` 的 `openStream()`：

1. 调用方给了 `signal` 就用它，否则**自建 `new AbortController()`**；`signal` 永不为 `undefined`；
2. 包成生成器，`finally` 里 `controller.abort()` —— 消费者 `break`/`cancel()` → `generator.return()` → 中止 → mux 释放复用 socket 上的订阅；
3. 失败时**保留 host 自己的错误码**（中途 `SSH_NET_RESET` 不被改写成 `SSH_NET_UNREACHABLE`），只对完全未知的失败兜底；
4. 错误一律是**真正的 `Error` 实例**（`normaliseError` 已改），否则 console 里只显示折叠的 `Object`；
5. 失败详情带 `streamBaseUrl` / `baseURI` / `muxUrl` + `hint`，并 print 一行 `[dsh-ssh] stream carrier failed …`。
   `streamBaseUrl` 取自 `globalThis.__DSH_TRANSPORT__.streamBaseUrl`；**缺失时**网关退回 `document.baseURI`（`dsh-app://app/` → `ws://app/api/remote.mux`，不可达）。`dsh-client-connection/README.md:28` 明说静态桌面页必须自己提供该 origin。

**BUILD_MARKER**（判据 A 的惯例）：`ssh-bridge-2026-09-27.3-stream-signal`，carrier 解析成功时与 `stream=<入口>` 一起打印：
```
[dsh-ssh] carrier resolved: connection-rpc
[dsh-ssh] ssh-bridge-2026-09-27.3-stream-signal stream=remote.streams
```

## 4 · Plan B：exact-route（ICD §1.2）

**只有在**页面 console 显示 `connection` 服务在插件上下文里不可见时才需要（与已观察到的证据相反：
`ctx.get('connection').rpc` 可达，用户 console 已出现 `[dsh-ssh] carrier resolved: connection-rpc`）。流式缺口**不要**用 exact-route 解决——`ctx.remote.streams` 已经可用（见 §3.2）。

三步：

1. **host**：在 `src/` 注册一条受认证路由（复用现有 auth 栅栏，**不新开鉴权面**），
   端点语义为"单 JSON 串入、单 JSON 串出"（ICD §12 R1 form A），错误按 ICD §5 编码返回。
2. **client**：在 `client/src/bridge.js` 的 `STRATEGIES` 末尾追加第 4 个 strategy `exact-route`：
   `POST` 到该路由，body `{ ns, method, params: <JSON 串> }`，并把返回信封按 `{ok,value}`/`{ok,error}` 归一化
   （复用 `normaliseError`），失败原因照旧进 `diagnostics().attempts`。
3. **契约门**：`test/integration/icd-conformance.test.mjs` 补 §1.2 断言（路由存在 + 错误码集合不变），
   并在 `test/client/*` 补一条"exact-route 可用时优先/回退顺序正确"的用例。

**不要引入任何 bundle 外部依赖**：`lib/client.js` 的唯一外部必须保持 `react`。
