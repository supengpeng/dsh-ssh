# 安全、审计与配置（SP4 / task-4）

> 归属：`sp4-security` · 冻结契约：`docs/ICD.md` §4.2 / §5 / §6 / §7.3 / §12
> 写作用域：`src/{config,logger,redact,credentials,known-hosts,audit,store}.ts`、`examples/**`、`test/unit/security*.test.mjs`、`test/unit/config*.test.mjs`

本模块是**全插件的安全底座**：它是唯一能接触明文凭据的地方，也是唯一能决定
"什么能进日志/审计/UI"的地方。SP1（连接）、SP2（命令）、SP3（传输）都从这里拿
已解析的凭据、主机密钥校验器、脱敏器与审计器。

---

## 1. 模块与接口一览

| 文件 | 对外接口（冻结签名见 ICD §7.3 / §6） | 消费方 |
|---|---|---|
| `src/config.ts` | `Config`（Schemastery）、`resolveConfig`、`resolveDshHome`、`toPublicConfig`/`PublicConfig`、`RetryConfig` | Lead（`getConfig` 端点）、SP1 |
| `src/redact.ts` | `Redactor`（`scrub`/`track`/`forgetAll`）、`createRedactor`、`SECRET_MASK`、`matchesRedactKey`、`scrubOnce` | 全体 |
| `src/logger.ts` | `createLogger` → `PluginLogger`、`JsonlWriter`、`HostLoggerFace` | 全体 |
| `src/credentials.ts` | `CredentialResolver`（`resolve`/`set`/`clear`/`describe`）+ `resolveProfile`/`envNameFor`/`refFor`/`forgetAll`、`CredentialStoreFace` | SP1、Lead（`setSecret`/`clearSecret`/`testProfile`） |
| `src/known-hosts.ts` | `KnownHostsVerifier`（`verify`/`remember`/`fingerprint`）、`parseKnownHosts`、`knownHostsLine`、`hashHostName`、`keyTypeOfBlob`、`blobOf` | SP1 |
| `src/audit.ts` | `Auditor`（`record`/`query`/`subscribe`/`flush`）+ `clear()`、`createAuditor` | Lead（`queryAudit`/`followAudit`/`clearAudit`）、全体 |
| `src/store.ts` | `ConnProfile`/`ConnProfileInput`/`ConnProfilePatch`/`ConnProfileView`/`ResolvedProfile`、`ProfileStore`、`normalizeProfile`、`toConnProfileView`、`newProfileId`、`monotonicUlid` | SP1、SP5（经络由 Lead 的 API 层） |

**契约稳定性**：ICD §7.3 的四个接口按原文实现，未改名、未改参数；实现类在冻结签名
之外只做**加法**（返回对象多带字段、多若干便捷方法），因此把实现塞进 SP1 声明的
结构化端口（`src/connection/types.ts`）时无需适配层。

---

## 2. 「凭据不在日志与 UI 明文中出现」的证据链

这是用户的十条验收标准之一，因此拆成四层可断言的不变式。

### 2.1 落盘层：`profilesFile` 只存引用（三重防线）

| # | 机制 | 位置 | 对应测试 |
|---|---|---|---|
| 1 | **白名单序列化**：持久化时逐字段重建，未列出的键（表单里混进来的 `password`/`secret`/`token`）直接被丢弃 | `store.ts` `serialize()` | `unknown fields on the input are dropped, never persisted` |
| 2 | **引用名文法校验**：`secretRefs.password/passphrase` 必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，否则 `SSH_CFG_INVALID`；**报错信息不回显该值**（拒绝一个密码却把它写进日志，等于没拒绝） | `store.ts` `assertCredentialRef()` | `a plaintext smuggled into secretRefs is rejected, and the message does not quote it` |
| 3 | **`defaultEnv` 拒绝 secret 形 key**：`{ PASSWORD: '…' }` 这类"顺手放进环境变量"的写法是最可能的泄漏路径，直接拒绝（复用 `logging.redactKeys` 的 key 匹配） | `store.ts` `normalizeEnv()` | `defaultEnv refuses secret-shaped keys` |

补充：加载时若发现**历史文件**里存了明文（第 2 条规则的漏网者），该条记录被
**跳过**而不是"加载后原样再写回去"（fail closed，其余记录照常可用）。

### 2.2 解析层：明文只在内存，且立刻登记脱敏

- `CredentialResolver.resolve()` 是唯一把引用变成明文的代码路径；解析成功后**立即**
  `redactor.track(明文)`（含 URL 编码 / JSON 转义 / base64 / base64url / hex 变体），
  调用方即使忘了脱敏，后续日志也会命中该字面量。对应测试：
  `every resolved secret is registered with the redactor automatically`。
- `ResolvedSecrets` 带 `toJSON()`：`JSON.stringify(secrets)` 输出掩码而非明文，
  防止"随手序列化"把密码写进响应或日志（`a resolved secret cannot be serialised by accident`）。
- 凭据值永不写入 profile、审计、会话信息；`SessionInfo` 由 SP1 维护，本模块不向其写入任何 secret 字段。

### 2.3 脱敏层：三层防御（`src/redact.ts`）

| 层 | 覆盖的形态 | 对抗性测试 |
|---|---|---|
| ① 结构化 key | `password`/`privateKey`/`API_KEY`/`Authorization`/`db.password`…（大小写、分隔符、camelCase 不敏感；短模式只在词边界匹配，避免误伤 `keys`/`monkey`） | `a secret-named key is masked whatever its value type`、`key matching respects word boundaries for short patterns` |
| ② 已登记字面量 | 明文出现在**任意**字符串里：**完整 URL**、**堆栈**、**JSON 串**、作为**更长 token 的子串**、多次出现 | `a secret inside a URL/stack trace/embedded JSON ...`、`a secret is masked as a substring of a longer token` |
| ③ 对抗性正则 | 没人告诉过我们的密文：`scheme://user:pw@host`、`Authorization: Bearer …`、`password=…`、`--password …`、PEM 私钥块、**base64/hex 块解码后含已知密文**、**跨相邻字段拼接**的密文 | `secret-shaped patterns nobody registered are still masked`、`a secret inside a base64 blob is masked by decoding the blob`、`a secret split across adjacent fields is masked in both halves` |

不变式：掩码恒为 `SECRET_MASK`（**固定 8 个点**，ICD §4.2「不泄漏长度」）；`scrub()`
**不修改入参**；容忍循环引用；保留 `Error`/`Map`/`Set`/`Date`/`Buffer` 类型；
幂等（`scrub(scrub(x)) === scrub(x)`）；`forgetAll()` 清空字面量但保留 key 规则。

### 2.4 UI 层：`ConnProfileView` 永不出现明文

```ts
secrets: { password: { present, source, masked }, passphrase: {…}, privateKeyPath? }
```
`masked` = 存在时固定 8 点、不存在时 `''`；`source` ∈ `env | keychain | profile | none`。

**ICD v1.0.5 追加（Lead 批准）**：`ConnProfileView` 同时携带兄弟字段 `secretRefs`
（只有引用名，无明文）。原因：UI 把编辑后的 view 回传 `saveProfile` 时若拿不到引用名，
已存凭据的引用会被抹掉、解析静默退化为"派生 env 名"，用户以为密码还在而实际上连接会失败。

**合并语义（冻结）**：`saveProfile` 在 `secretRefs` **缺省**时保留原有引用；
清空凭据只能走 `clearSecret`，不能用"省略字段"表达——同一个字段不能有两种相反含义。

---

## 3. 凭据解析顺序（ICD §6 冻结）

```
DSH_SSH_<PROFILE_SLUG>_PASSWORD   ← 启动环境变量（只读，source: 'env'）
        ↓ 未命中
ctx.credentials.resolve(secretRefs.password)  ← 凭据库（source: 'keychain'）
        ↓ 未命中
setSecret(persist:false) 写入的会话内存        ← source: 'profile'
        ↓ 未命中
connect 的 secrets 一次性输入                  ← source: 'profile'，仅本次连接
        ↓ 未命中
undefined                                      ← source: 'none'
```

- `PROFILE_SLUG` = 档案名大写、非字母数字折叠为 `_`（`profileSlug()`）；档案显式写了
  `secretRefs.password: MY_REF` 时用 `MY_REF` 本身。
- `secrets.provider: 'env'` 时**完全不读凭据库**，且 `setSecret(persist:true)` 明确
  抛 `SSH_CFG_INVALID`（"这个部署只从环境读凭据"），而不是静默存到别处。
- `ctx.credentials` 用**结构化类型** `CredentialStoreFace` 消费，不 `import`
  `@deepseek-ai/dsh-credentials`：host 树运行自己的副本，且凭据服务缺席时插件仍要能加载。
- 降级策略：凭据库报错 → 记 warn 并按"未配置"继续（最终由 SP1 报 `SSH_AUTH_FAILED` /
  `SSH_AUTH_PASSPHRASE_REQUIRED`），不把无关错误抛给用户。
- 环境变量被启动环境提供时凭据库拒绝写入（read-only）→ 值留在会话内存并在返回值里
  标 `persisted: false` + `reason`，UI 可以如实显示"本次有效、未持久化"。

---

## 4. 主机密钥（`src/known-hosts.ts`）

| policy | 未知主机 | 指纹变了 |
|---|---|---|
| `strict` | 拒绝 `SSH_HOSTKEY_UNKNOWN` | 拒绝 `SSH_HOSTKEY_MISMATCH` |
| `accept-new` | **接受并写入 known_hosts**（OpenSSH 同义） | 拒绝 |
| `insecure` | 接受（**完全不读不写** known_hosts） | 接受 |

- **OpenSSH 兼容指纹**：`SHA256:` + `base64(sha256(<SSH wire 公钥 blob>))` **去掉 `=` padding**；
  `key` 参数必须是 `ParsedKey.getPublicSSH()` 的 blob（不是 PEM、不是 hex）。
  测试用 Python `hashlib` 独立算出的向量校验，而非用本实现自证。
- **文件格式 OpenSSH 兼容**：`[markers] host[,host] keytype base64blob`；非 22 端口写
  `[host]:port`（读时也接受显式的 `[host]:22`）；支持 `*`/`?` 通配、`!` 取反、
  `@revoked`（一律拒绝）、以及 `HashKnownHosts yes` 的 `|1|salt|hmac` 哈希条目
  （可读可写）。
- 写入 best-effort：known_hosts 不可写只记 warn，**不能因此让用户登不上**；
  `rememberNew()` 返回是否真的写了新行，`verify()` 在 accept-new 下回带 `remembered`。
- 缓存以 `mtime+size` 为键：别的进程（`ssh-keyscan`）新增的条目会被发现；
  文件不可读时按"空文件"处理（`strict` 下 fail closed）。

---

## 5. 审计与日志

- **审计**（`audit.ts`）：JSONL 逐行 append，`record()` 同步、`void` 返回、**永不抛出**
  （"磁盘满不能挡住 SSH 操作"）；写失败时记录进有界 pending 缓冲，由 `flush()` 重试。
  条目在**进入任何可观察位置之前**就已脱敏，因此内存环、文件、`followAudit` 订阅者
  看到的是同一份已脱敏对象。查询：`sessionId`/`kinds`(按 `op`)/`since`/`limit`/`offset`，
  **newest first**，`total` 为分页前命中数；磁盘文件保留完整历史，内存环有界（默认 2000，
  超出计入 `dropped`）。首次查询时从文件尾部**水合**，插件重载后审计标签不为空。
- **日志**（`logger.ts`）：`plugin.jsonl`（`dirname(auditFile)/plugin.jsonl`，**不新增配置字段**），
  级别过滤、结构化字段脱敏、**消息字符串同样脱敏**（`logger.info(\`…${password}\`)` 是最常见的
  泄漏路径）、转发给 `ctx.logger` 的那一行也是脱敏后的。全部 best-effort，日志/宿主
  logger 抛错都不影响调用方。

---

## 6. 配置（`src/config.ts`）

- 全部默认值在 schema 内（`cordis.patch.yml` 删行即回默认），`test/unit/config.test.mjs`
  逐条断言默认值 + 越界钳制。
- `toPublicConfig()` 实现 ICD §6 的对外投影：去掉 `logging.redactKeys`，
  `secrets` 只回 `{ provider, envPrefix }`，其余原样（含三个解析后的绝对路径）。
- 越界值**钳制而非拒绝**：`maxSessions: 0` 之类的手误不该让插件加载失败。
- `resolveConfig` 同时把 `hostKey.knownHostsFile` 解析成绝对路径（ICD 文档化的就是
  这个字段，若只解析顶层的 `knownHostsFile` 别名，消费者读到 `''` 会各自发明路径）。

---

## 7. 已知边界与遗留（诚实清单）

1. **无上下文的裸子串**：若某段文本里既没有 secret 形 key 也没有约定形态（如
   `logger.info('auth failed for ' + pw)` 而 `pw` 从未被 `track()`），任何脱敏器都无法
   判定它是密文。缓解：`credentials.resolve()` 会自动 `track()`，正常链路不会出现
   未登记的明文；但直接调用 logger 传入的任意字符串仍可能漏。
2. **`logging.redact: false`** 会关闭全部脱敏（含审计）——它是运维显式选择，
   等于放弃该验收项；默认必须为 `true`。
3. **跨字段拼接**只覆盖**相邻**的两个字符串兄弟字段（表单/CLI 切片的形状），
   不相邻或跨层级拼接不覆盖。
4. **`privateKeyPath` 不是凭据引用**：它是本地路径（含 `/`、`.`），按路径校验而非
   引用名文法；路径本身不算机密。
5. **known_hosts 哈希条目**用 HMAC-SHA1 复算（与 OpenSSH 一致），但只支持 `|1|`
   版本；未知版本按普通条目解析（不会误匹配）。
6. **`HostKeyVerifyQuestion` 与 ICD §7.1 的 `HostKeyQuestion` 故意不同名**：后者是
   给 `onHostKeyPrompt` 的提问结构（带指纹、无 key 材料），同名会让"提问"被当成
   "验签参数"传错地方。
7. **审计 `total` 的内存上限**：`total` 是"内存环内命中数"；文件保留全部历史，
   需要全量统计时应直接读 JSONL（Lead 的 `queryAudit` 按内存环语义实现）。

---

## 8. 自测结果

环境：Node（DSH 内置）· Windows · 工作目录 `dsh-ssh/`

### 8.1 命令与结果（全部在最终提交前实测）

```bash
# 1) 类型检查（全包；本模块 7 个文件 0 错）
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

# 2) 构建 host 半边（产出 lib/*.js 供单测与运行时消费）
node node_modules/typescript/bin/tsc -p tsconfig.json

# 3) 本模块单测（4 个 security 文件 + config）
node --test --test-concurrency=1 "test/unit/security-*.test.mjs" "test/unit/config.test.mjs"
```

| 测试文件 | 用例数 | 结果 | 覆盖重点 |
|---|---|---|---|
| `test/unit/security-redact.test.mjs` | 24 | **24 pass / 0 fail** | 三层脱敏 + 六类对抗场景（URL / 堆栈 / JSON 串 / base64 / 子串 / 跨字段）+ 六类编码变体 + 幂等/不可变/循环引用 |
| `test/unit/security-credentials.test.mjs` | 35 | **35 pass / 0 fail** | 解析顺序四层边界、describe 掩码、set/clear 降级、`profilesFile` 无明文（三重防线）、合并语义、id 单调唯一、坏文件容错 |
| `test/unit/security-known-hosts.test.mjs` | 23 | **23 pass / 0 fail** | 三档策略 × 未知/已知/变更、独立指纹向量、端口约定、通配/取反/`@revoked`/哈希条目、不可写降级、mtime 缓存刷新 |
| `test/unit/security-audit.test.mjs` | 22 | **22 pass / 0 fail** | JSONL 落盘与查询过滤分页、三处皆脱敏（文件/查询/订阅者）、磁盘不可写降级、水合、日志级别/子作用域/宿主转发/不可写降级、JsonlWriter 轮转与尾部读 |
| `test/unit/security-capstone.test.mjs` | 1 | **1 pass / 0 fail** | **端到端**：按 `apply()` 的方式接好 config+redactor+logger+auditor+store+resolver+known-hosts，然后逐个搜索 **全部产物**（profiles 文件 / audit JSONL / plugin 日志 / known_hosts / view / `JSON.stringify(secrets)` / PublicConfig / queryAudit 结果）确认无明文 |
| `test/unit/config.test.mjs` | 11 | **11 pass / 0 fail** | ICD §6 全量默认值、全量数值钳制、`PublicConfig` 投影 |
| **合计** | **116** | **116 pass / 0 fail** | |

```bash
# 4) 汇总（本模块）
$ node --test --test-concurrency=1 "test/unit/security-*.test.mjs" "test/unit/config.test.mjs"
ℹ tests 116
ℹ pass 116
ℹ fail 0

# 5) 全包（证明未破坏他人模块）
$ node --test --test-concurrency=1 "test/unit/*.test.mjs" "test/client/*.test.mjs"
ℹ tests 525
ℹ pass 522
ℹ fail 3     ← 全部在 sp3 的 SFTP（sftp 客户端/遍历/manager），与本模块无关；本模块 0 fail
```

### 8.2 本轮被测试抓出并修掉的真实缺陷

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| 1 | 日志**只脱敏结构化字段、不脱敏消息字符串** | `logger.info(\`…${password}\`)` 明文落盘（最常见的泄漏写法） | `logger.ts` 对 message 也走 `redactor.scrub()`，转发给 `ctx.logger` 的行同样用脱敏后的文本 |
| 2 | 哈希 known_hosts 条目解析时**位置解构错位**（`|1|salt|digest`.split('|') → `['','1',salt,digest]`） | `HashKnownHosts yes` 的文件条目被静默丢弃 → `strict` 下连接全部失败 | 改为按索引取 `parts[2]`/`parts[3]` 并校验 |
| 3 | `resolveConfig` 只解析顶层 `knownHostsFile`，`hostKey.knownHostsFile` 仍是 `''` | 消费者读 ICD 文档化的字段会拿到空串，各自发明路径 | 两处都写解析后的绝对路径 |
| 4 | `Config` 未显式注解 `z<Config>` | `declaration: true` 下 TS2742，**全包 `lib/*.d.ts` 产不出来**（Lead 已确认这是隐蔽杀手） | 显式注解，与 `dsh-python` 同款 |
| 5 | `parseKnownHosts` 未校验 base64 字段 | `Buffer.from(x,'base64')` 忽略非法字符 → 垃圾行变成永远匹配不上的幽灵条目 | 增加 base64 字符集校验 |

### 8.3 未覆盖 / 未验证（遗留）

- **真实 `ssh-keygen -lf` 互操作**：本机无可用 OpenSSH 客户端进程可脚本化调用，
  指纹正确性用 Python `hashlib` 独立向量 + 格式断言（`SHA256:` + 43 字符无 padding）
  证明；与真实 `ssh-keyscan`/`ssh-keygen` 的对拍留给 SP8 集成阶段。
- **真实 `ctx.credentials` 服务**：单测用结构化替身（含"被环境遮蔽而拒绝写入"的
  真实语义）；与运行中的 `@deepseek-ai/dsh-credentials-local` 联调属集成阶段。
- **磁盘满**：用"路径是目录"模拟 append 失败（覆盖了错误分支），未做真实满盘注入。
- **审计 8MiB 轮转**：用 1KiB 阈值验证了轮转逻辑，未做 8MiB 实盘演练。
- **`ssh2` 回调路径**：本模块不直接调用 `ssh2`；`ParsedKey.getPublicSSH()` 的 blob
  语义由类型定义确认，需由 SP1 在真机连接中最终验证。
