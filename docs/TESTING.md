# 测试与验证手册（@local/dsh-ssh）

> 本文是**唯一**的"怎么跑测试"权威来源。契约本身见 `docs/ICD.md`；验收走查见 `docs/DEMO.md`。
> 交付纪律：每个里程碑结束时 `node scripts/verify-all.mjs` 必须退出 0（真机层除外，它是显式可选项）。

---

## 0. 一分钟版本

```powershell
node scripts/verify-all.mjs                 # lint + 类型 + 构建 + 单测 + 组件 + 集成 + E2E + 性能
node scripts/verify-all.mjs --skip-perf     # 迭代期（跳过 100MB 性能层）
node scripts/verify-all.mjs --real          # 追加真机层（需 DSH_SSH_TEST_REAL_* 环境变量）
node scripts/verify-all.mjs --coverage      # 追加覆盖率层（不进入主流程）
node scripts/verify-all.mjs --list          # 列出层与超时
```

`verify-all` 的每条层都有**硬超时**：超时会 kill 进程树、标记 `TIMEOUT`、打印该层输出尾部，并以非零码退出 —— 目标是"失败"而不是"永远跑不完"。若沙箱拒绝 Node 的管道（EPERM），该层会自动以 `stdio:'inherit'` 重跑并注明"未捕获输出"，不会误判为失败。

## 1. 测试分层（ICD §9）

| 层 | 位置 | 命令 | 归属 |
|---|---|---|---|
| 类型（第一道门） | `tsconfig.json` | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | SP8 |
| Lint | `eslint.config.js` | `node scripts/lint.mjs` | SP8 |
| 构建 host | `src/**` → `lib/**` | `node node_modules/typescript/bin/tsc -p tsconfig.json` | SP8 |
| 构建 client | `client/src/**` → `lib/client.js` | `node scripts/build-client.mjs`（+ `--check` 校验确定性） | SP5 |
| 单元（host） | `test/unit/*.test.mjs` | `node --test --test-concurrency=1 --test-force-exit "test/unit/*.test.mjs"` | 各 owner |
| 组件（client） | `test/client/*.test.mjs` | `node --test --test-concurrency=1 --test-force-exit "test/client/*.test.mjs"` | SP5/6/7 |
| 集成 | `test/integration/*.test.mjs` | `node --test --test-concurrency=1 --test-force-exit "test/integration/*.test.mjs"` | SP8 |
| E2E | `test/e2e/run.mjs` | `node test/e2e/run.mjs` | SP8 |
| 性能 | `test/perf/*.test.mjs` | `node --test --test-concurrency=1 --test-force-exit "test/perf/*.test.mjs"` | SP8 |
| 真机 | `test/integration/real-target.test.mjs` | `node --test --test-concurrency=1 --test-force-exit test/integration/real-target.test.mjs`（或 `pnpm test:real`） | SP8 |

## 2. 关键约定

### 2.1 单一 tsc 工程
本包是一个 TypeScript 工程：**任一文件类型错误会挡住全包 `lib/` 产出**，所以 `tsc --noEmit` 是 `verify-all` 的第一道门，早失败、快反馈。提交前必须 0 错。

### 2.2 一次只跑一份全仓测试（ICD §12 R9）
套件本身很快（**449 项 host 单测约 33.7 秒**，实测）。出现"某个测试文件卡住 20 分钟"时：

1. **先怀疑并发**：`Get-Process node | Select-Object Id,StartTime,CPU`（Windows）或 `pgrep -fa "node --test"`。两份全仓测试 + 注入的 `NODE_OPTIONS`（profiling/coverage）是已确认的元凶。
2. 再怀疑句柄泄漏（长跑 `setInterval`、未 `end()` 的 ssh2 客户端、未关闭的流）。
3. 定位手段：`node --test --test-force-exit --test-timeout=60000 <单个文件>` 逐文件二分，配合 `node --test-reporter=spec`。

`verify-all` 因此在启动前自检并发（检测到另一份测试运行即拒绝启动并打印原因，`--allow-concurrent` 可跳过），并对每层清理 `NODE_OPTIONS`/`NODE_V8_COVERAGE` 等注入变量；**所有 `node --test` 调用都带 `--test-force-exit`**（防止"测试跑完但进程不退"）。

**禁止**为了让套件跑完而删除/跳过测试。确实慢就先测量（`test:perf` 层）再优化；较重的规模用环境变量降级（见 §5）。

#### 2.2.1 「整套挂住」的一个已复现成因：上次中断留下的进程

实测记录（2026-09-27）：`test/unit/**` 聚合运行两次 **>10 分钟不结束**，但——

| 观察 | 结果 |
|---|---|
| 34 个文件**逐个**跑 | **全部通过**，最慢 `sftp-adapter` 16.7s、`sftp-transfer` 10.6s，合计约 75s |
| 残留进程状态 | CPU 仅 0.6s / 0.3s ⇒ **在等待，不是在自旋** |
| 清理残留 `node` 进程后**重跑聚合** | **51.3s 正常结束**（540 tests / 537 pass / 0 fail / 3 skipped） |

结论：**不是套件缺陷，而是中断/被杀掉的运行留下进程占着资源**（sshd 桩的监听端口），使下一次聚合运行停等。

判据与处置：

1. **判据**：进程 **CPU 极低 + 时间很长** ⇒ 等待；**CPU 飙高** ⇒ 死循环。二者病因不同。
2. **处置**：先清残留（`Get-Process node | Where-Object { $_.StartTime -lt (Get-Date).AddMinutes(-3) } | Stop-Process -Force`），再重跑一次；**不要在残留进程还在时下结论**。
3. **预防**：中断测试后**务必**确认无残留进程；`verify-all` 的并发自检只覆盖"另一份测试在跑"，覆盖不了"上次的孤儿进程"。

这条与 §2.2 正文是同一条纪律的两面：**并发**与**孤儿进程**都会表现为"套件卡住"。

### 2.3 本地靶机（无 Docker / 无 WSL）
本机没有 Docker、没有 WSL，因此"对真实 Linux 服务器验证"在自动化里由 `test/support/sshd.mjs` 承担：基于 `ssh2` 的 **Server API** 搭出的真协议 sshd（真实 TCP/密钥交换/加密/通道/SFTP 子系统），只有**命令执行**是在进程内解释的（`test/support/minish.mjs`，不依赖 Windows 的 `cmd`）。API 与命令集见 `test/support/README.md`，自测见 `test/integration/sshd-double.test.mjs`（13/13）。

真机层是**显式可选**的（见 §4），日常与 CI 必须自足。

### 2.4 已知 lint 缺口
- `eslint-plugin-react-hooks` **未安装**：flat config 里把 `react-hooks/exhaustive-deps` 注册为**显式 no-op**（保留源码中 disable 注释的语义），因此 hooks 依赖**不做静态检查**。若需要该信号，装插件后把 `rules-of-hooks` 设为 `error`、`exhaustive-deps` 设为 `warn`（按 Lead 裁定：warn 级，避免逼出无意义改动）。
- 口径：**errors = 正确性（挡门），warnings = 风格（不挡门）**；M4 的"lint 零错误"= **0 errors**。
- TypeScript 由 `tsc --noEmit` 负责（ESLint core 不能解析 TS；不为插件包引入 typescript-eslint 依赖）。

### 2.5 宿主半边在本机（Windows）**不能**热更新 —— 实测结论（2026-09-27）

**结论先说**：在这台机器上，**重建 `lib/**` 不会让运行中的 GUI 拿到新代码**；让新代码生效**必须重启 DSH**。
toggle `include:dsh-ssh` 行（`plugin_manager` 关→开）**不是**替代方案：它只让 Loader 用**已缓存**的模块重跑一次 `apply()`，模块字节不会被重新导入。

**证据（两条数字对不上，就是没热更新）**：

| 观察对象 | 数字 | 说明 |
|---|---|---|
| 构建产物 `lib/service.js` | **44** 个 Remote 方法 | 构造内建类后调 `remoteMethods(instance)` 得到，含 `followActivity`/`clearActivity` |
| 活着的 host 写的 `<DSH_HOME>\logs\dsh-ssh\host-ready.json`（`2026-09-27T04:44:42.447Z`） | **42** 个 Remote 方法 | `remoteMethods` 列表里**恰好缺** `followActivity`/`clearActivity` |
| 上述标记的生成时机 | 一次完整的 toggle 之后（`application: "applied"`） | 即"重跑过 `apply()` 仍是旧方法集" |

`host-ready.json` 由 `src/index.ts` 的 `recordHostReady()` 在每次 `apply()` 时写入，`remoteMethods: [...]` 就是**这个进程里实际注册的**端点列表 —— 因此它是"新代码有没有进来"的**唯一可靠判据**（比 console 与日志都可靠：它们看不到"apply 没跑"与"apply 跑了但用了旧模块"的区别）。

**根因（实测到 picomatch 一层）**：shipped `hmr` 行的 `ignored` 默认值是
`['**/node_modules', '**/.*', 'cache', 'data']`（`packages/boot/hmr`，`root` 默认 `['.']`），而监视谓词不是直接拿每个 pattern 去比绝对路径，而是比**相对 `baseDir` 的路径**：

```js
// 摘自 packages/boot/hmr（为说明合并了行；原文另有 ...this.config 与 ignoreInitial）
this.baseDir = fileURLToPath(new URL(config.base || '.', ctx.baseUrl))   // = profile 目录
const watchBaseDir = realpathSync(this.baseDir)
const match = picomatch(ignored)
this.watcher = watch(root, { cwd: watchBaseDir, ignored: path => match(relative(watchBaseDir, path)) })
```

本机 `baseDir` 是 profile 目录（`…\.dsh\profiles\desktop`），而监视根是它的**兄弟**目录 `C:\Users\Administrator\.dsh\plugins\dsh-ssh`。于是 Windows 上

```
relative('C:\Users\Administrator\.dsh\profiles\desktop',
         'C:\Users\Administrator\.dsh\plugins\dsh-ssh\lib\service.js')
  = '..\..\plugins\dsh-ssh\lib\service.js'
```

**picomatch 不把 `\` 当分隔符**，所以整个字符串是**一段**、且以 `.` 开头 ⇒ 默认的 `**/.*` 命中 ⇒ **整棵树每个文件都被忽略**，重建 `lib/**` 一个事件都不产生。实测（`packages/boot/hmr/node_modules/picomatch`）：

| 输入 | `picomatch(['**/node_modules','**/.*','cache','data'])` | 含义 |
|---|---|---|
| `..\..\plugins\dsh-ssh\lib\service.js`（Windows 实态） | **`true`** | 被忽略 ⇒ 没有 reload 事件 |
| `../../plugins/dsh-ssh/lib/service.js`（同路径、正斜杠） | `false` | **证明**分歧来自"反斜杠不是分隔符" |
| `node_modules/x.js`（profile 内） | `true` | 默认值本身工作正常，问题只在跨目录+反斜杠 |

**修复（已写进 profile 的托管块）**：`scripts/profile-install.mjs` 的 `hmrBlock()` 现在把监视根**直接指向三个源码树**，并**清空 `ignored`**：

```yaml
# >>> dsh-ssh hmr watch (managed by dsh-ssh) >>>
- id: hmr
  config:
    root:
      - <PACKAGE_DIR>/lib          # hmrBlock() 写出绝对路径、并用正斜杠
      - <PACKAGE_DIR>/src
      - <PACKAGE_DIR>/client/src
    ignored: []
# <<< dsh-ssh hmr watch <<<
```

**为什么 `ignored: []` 是安全的**：这三个树里没有 `node_modules`、也没有点目录，默认忽略规则在此处没有要挡的东西；而**用正斜杠的绝对根**同时绕开了"相对 profile 的路径以 `..` 开头"这一条。`--status` 会核对托管块是否存在：

```powershell
node scripts/profile-install.mjs --profile "$env:USERPROFILE\.dsh\profiles\desktop" --status
#   hmr watch block         : present
```

> **注意生效时机**：托管块是**为下一次 DSH 启动准备**的 —— `hmr` 行在启动时装载，改 profile patch 不会让已加载的监视器按新配置重来。因此 **2026-09-27 这次修复并没有让新代码进入正在运行的实例**（它仍是 42 方法集，见 `docs/ACCEPTANCE.md` §13.3）。

**对所有人的操作含义**：
1. 改 host 半边后，**不要**用"toggle 了行 + 页面没变化"来判断自己的改动没写对 —— 先看 `host-ready.json` 的方法数/字段是否变过。
2. 本机要验证 host 改动，**只能重启 DSH**（这不是插件缺陷，是 Windows 上 `relative()` 路径分隔符与 picomatch 的交互）。
3. 组件层（`client/src/**`）不受影响：那条路径仍由 `lib/client.js` 的字节变化触发页面重新 `apply()`（见 §7 第 3 条）。
4. 相关记录：`src/index.ts` 头部（写给下一位维护者）、`docs/ACCEPTANCE.md` §13（验收留痕）、`docs/M0-SPIKE.md` §8（当年 §7.3 的"未确认"结案）。

## 3. 自测结果（交付者填写）

| 层 | 命令 | 结果 |
|---|---|---|
| 类型 | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **exit 0**（2026-09-27，agent 活动镜像落地后；此前的"收敛中"状态已结束） |
| 单测（host 全层） | `node --test --test-concurrency=1 --test-force-exit --test-timeout=60000 "test/unit/*.test.mjs"` | **585 项：582 pass / 0 fail / 3 skip**（2026-09-27 全量复跑）。注：首轮曾在 `test/unit/connection-auth.test.mjs` 出现 1 次与本次改动**无关**的顺序性抖动（`Malformed OpenSSH private key`）——该文件单独跑 **17/17**、全层复跑 **0 fail**，代码路径未被本次改动触碰 |
| 组件（client 全层） | `node --test --test-concurrency=1 --test-timeout=30000 "test/client/*.test.mjs"` | **255 pass / 0 fail**（含活动面 8、会话卡片 13；本功能另新增 `activity` 28、`toolview` 13、独立验证者 16 个用例） |
| Lint | `node scripts/lint.mjs` | 0 errors / 若干 warning（`prefer-const`、未使用 disable 注释）；**4 处第一方硬编码色值**（`client/src/core.js:91`、`client/src/chrome/theme.gen.js:308/392/507`）已派单 sp5/sp7，属预期中间态 |
| 靶机自测 | `node --test --test-concurrency=1 "test/integration/sshd-double.test.mjs"` | **13/13 pass，约 13s，进程正常退出** |
| 契约一致性 | `node --test --test-concurrency=1 --test-force-exit --test-timeout=60000 test/integration/icd-conformance.test.mjs` | **7 pass / 1 skip / 0 fail**（2026-09-27，agent 活动镜像落地后）：§5 全 32 码 + retryable 一致、§3 帧不变式（真流）、**§4 方法表 41/41 存在**（含 §4.7 的 `followActivity`/`clearActivity`）、§8.5 **163 个冻结键**双语齐全（各 214 键、集合相同）、§0 包/入口/bundle、§6 patch 默认值；唯一 skip 是 §4.2「需活的服务实例 + 凭据库」，**带理由**（`DSH_SSH_STRICT_ICD=1` 会把它转硬失败）。命令与逐项数字另见 `docs/ACCEPTANCE.md` §12 |
| 集成 | `node --test --test-concurrency=1 "test/integration/stack.test.mjs"` | 12 例：连接（密码/公钥/内联/文件/加密+passphrase）、失败码映射、host-key 三档 + known_hosts 回读、exec（env/cwd/exit/stderr/超时→exit-signal）、stdin/signal/cancel、PTY（含 resize 与全屏 `top`）、SFTP 全操作 + chmod 回读 + 4MiB 流式一致 + offset 续写、10 会话无串扰、池上限与断链注入 |
| E2E | `node test/e2e/run.mjs` | **9/9 步通过**：新建连接→连接→PTY `uname -a`(+`top` 全屏)→exec 帧不变式→2MiB 上传→下载回读→10 会话并发→断开无残留→日志无凭据 |
| 性能 | `node --test --test-concurrency=1 "test/perf/*.test.mjs"` | 100MiB 上传/下载字节一致；10 会话并发各自哈希匹配；实测见 §5 数字 |

## 4. 真机层（显式开启）

```powershell
$env:DSH_SSH_TEST_REAL_HOST="<host>"; $env:DSH_SSH_TEST_REAL_PORT="22"
$env:DSH_SSH_TEST_REAL_USER="<user>"; $env:DSH_SSH_TEST_REAL_PASSWORD="<password>"
pnpm test:real            # 或 node scripts/verify-all.mjs --real
```

纪律：

- 变量缺失时必须 `t.skip(...)` —— **明确跳过，不静默、不失败**；**绝不**默认连真机；默认路径（CI/日常）不包含真机层（`verify-all` 的集成层按文件名枚举并**显式排除** `real-target.test.mjs`，只有 `--real` / `pnpm test:real` 才跑它）；
- 写操作**只允许** `/tmp/dsh-ssh-test/**`，用例结束必须清理（用例会断言该目录已消失）；不改服务器配置/服务/用户数据；
- **密码绝不写入仓库任何文件**（fixture/注释/README/截图/会话导出）；演示走 UI 输入以顺带验证掩码；
- 用户名/端口等非敏感事实记录在 `docs/REAL-TARGET.md`（不含密码）；
- `ssh-keyscan` / `ssh-keygen` 调用一律用 `execFile` 传参数数组（不拼字符串过 shell）并设超时；网络抖动要报"target unreachable"，不得误判为校验失败。

**状态（task-11）**：

| 用例 | 需要什么 | 结果 |
|---|---|---|
| `ssh-keyscan keys verify accept-new → exact → changed` | 只需 `DSH_SSH_TEST_REAL_HOST`（+`_PORT`） | ✅ **已对真机 `203.0.113.10` 实跑通过**：取到三把真主机密钥（`ssh-ed25519`/`ecdsa-sha2-nistp256`/`ssh-rsa`）→ accept-new 接受 → `remember` → strict 复验 `exact` → 同类型换钥 → `SSH_HOSTKEY_MISMATCH`/`changed` |
| `connect, exec uname -a, SFTP round trip in /tmp/dsh-ssh-test` | 还需 `_USER` + `_PASSWORD` | 未配置凭据时**明确 skip**；凭据就绪即可跑（写操作限制在 `/tmp/dsh-ssh-test/**`） |

**取主机密钥的两条路径（实测差异）**：Windows 自带 `ssh-keyscan` 与 Ubuntu 24.04（OpenSSH 9.6p1）**协商失败** —— 报 `choose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com`（能收到服务端 banner，是本地工具链缺该 KEX）。因此该用例**先用 `ssh-keyscan`，失败自动回退到我们自己的 ssh2 栈**（`hostVerifier` 捕获真实主机密钥）。回退路径其实证据更强：它拿到的是**我们的传输栈真实收到**的那把密钥，同时顺带验证了插件与真机 KEX/加密套件的互通。两条路径都会在 `t.diagnostic` 标注来源。

### 4.1 OpenSSH 真值对拍（A 层：离线、CI 安全、默认执行）

`test/integration/openssh-interop.test.mjs` 用真 `ssh-keygen` 作为**实现之外的真值**（此前 sp4 的 known_hosts 只有自算向量 = 自证）：

| 断言 | 结果 |
|---|---|
| `fingerprint(keyType, blob)` == `ssh-keygen -lf`（ed25519 / rsa / ecdsa 真密钥） | ✅ 逐字节一致 |
| 我们写出的行能被 `ssh-keygen -F <host> -f <file>` 找到（含 `[host]:port` 形式；错端口找不到） | ✅ |
| `|1|salt|hmac`（HashKnownHosts）条目**双向**可读：OpenSSH `-F` 能解析我们的哈希条目，我们的 verifier 也能验证它，且不泄漏主机名 | ✅ |
| 通配 `*.example.com`、取反 `!bad.example.com`、`@cert-authority`、`@revoked` 标记解析保留 | ✅ |
| 策略矩阵（真密钥）：strict 拒未知、accept-new+remember → `exact`、同类型换钥 → `MISMATCH`/`changed`、**不同类型 → `unknown`（不是 changed）**、insecure 放行 | ✅ |
| 我们解析后再发回的 blob 经 OpenSSH 指纹仍一致（证明解析零字节丢失） | ✅ |

`ssh-keygen` 不存在时整文件 **skip 并给出路径理由**（可用 `DSH_SSH_SSH_KEYGEN` 覆盖路径）。

**对拍发现的两个安全缺口**（已报 Lead；`DSH_SSH_STRICT_ICD=1` 下转硬失败）：

1. **`@revoked` 不生效**：`parseKnownHosts` 保留标记，但 `verify()` 仍接受被吊销的密钥（OpenSSH 语义：无论策略都必须拒绝）；
2. **问题级 `policy` 覆盖未生效**：`accept-new` 实例 + `verify({ policy:'strict' })` 询问未知主机时被接受（ICD §7 把 `policy` 放在问题里）。产品路径（按 `config.hostKey.policy` 构造实例）行为正确，故不影响当前 UI，但契约字面不一致。

## 5. 性能层参数与实测

| 变量 | 默认 | 用途 |
|---|---|---|
| `DSH_SSH_PERF_BYTES` | `104857600`（100 MiB） | 单文件上传/下载规模 |
| `DSH_SSH_PERF_CONCURRENT_BYTES` | `4194304`（4 MiB） | 10 会话并发时每会话规模 |
| `DSH_SSH_PERF_FLOOR_MIBPS` | `3` | 吞吐下限（慢机器可下调，**不要**为此跳过层） |

实测（本机，`ssh2` 纯 JS 加密回退，`cpu-features` 原生构建被 pnpm 策略跳过；默认 100 MiB 规模）：

| 场景 | 结果 |
|---|---|
| 上传 100 MiB | **2.9s = 34.4 MiB/s** |
| 下载 100 MiB | **5.0s = 20.1 MiB/s** |
| 10 会话并发（每会话 4 MiB，合计 40 MiB） | **1.3s = 31.6 MiB/s 聚合**，逐会话 sha256 各自匹配（无串扰） |
| 流式 exec 输出 2.6 MiB | 69 MiB/s |
| 上传/下载 16 MiB（迭代规模） | 30–34 / 20–23 MiB/s |

三条用例全部字节一致（远端 `sha256sum` 与本地哈希比对），因此吞吐下限 `3 MiB/s` 有 7–11 倍余量；`test/perf/perf.test.mjs` 会把每条吞吐打进 `t.diagnostic`。

## 6. 覆盖矩阵（哪些层证明哪条验收）

| 验收项 | 证据 |
|---|---|
| 连接管理（新建/编辑/删除/测试/掩码） | `test/client/**` 组件测试 + `test/integration/stack.test.mjs`（连接/认证/host-key） |
| 终端可跑 `uname -a` 与 `top` 类交互 | `test/integration/stack.test.mjs`（PTY + resize + 全屏 `top`）、`test/e2e/run.mjs` 第 3 步 |
| 命令执行 stdout/stderr/退出码/env/cwd/超时 | `test/unit/exec*`、`test/integration/stack.test.mjs` |
| 文件传输（上传/下载/进度/续传/校验） | `test/integration/stack.test.mjs`（4 MiB 流式 + offset 续写）、`test/perf/perf.test.mjs`（100 MiB 字节一致） |
| 10 会话并发无串扰 | `test/integration/stack.test.mjs`、`test/e2e/run.mjs` 第 7 步、`test/perf/perf.test.mjs` |
| known_hosts 严格/宽松 | `test/integration/stack.test.mjs`（strict/accept-new/mismatch + 回读）、`test/unit/security*`（OpenSSH 对拍向量） |
| 凭据不泄漏 | `test/e2e/run.mjs` 第 9 步（日志扫描）、`test/unit/security*`（脱敏对抗性用例） |
| 亮/暗主题、i18n | `test/client/**`（token 扫描 + 双语键集合相等）、`test/integration/icd-conformance.test.mjs` §8.5 |
| ICD 契约一致性 | `test/integration/icd-conformance.test.mjs`（§0/§3/§4/§5/§6/§8.5） |

## 7. 提交前检查清单

1. `node scripts/verify-all.mjs` 退出 0（真机层可选）。
2. 新增/修改的测试都带**可复现**的失败信息，skip 一律带理由。
3. 改了 `client/src/**` → 跑过 `node scripts/build-client.mjs` 且 `--check` 通过（产物与源码一致）。
4. 改了 `src/**` → `tsc --noEmit` 0 错，且没有把 `lib/**` 手改（产物只由构建生成）。
5. 文档同步：`README.md`（配置/FAQ）、`docs/TESTING.md`（命令/实测）、`CHANGELOG.md`（变更条目）。
6. 改了**布局 / 可见性**（`client/src/session/**` 的样式或结构）→  组件测试**证明不了几何**（linkedom 无布局引擎，"元素存在 ≠ 元素可见"），必须补一张真实浏览器截图：`npm run docs:shots`（见 [`SCREENSHOTS.md`](./SCREENSHOTS.md)），并在该文件里更新说明。
7. 交付前确认**没有孤儿测试进程**（见 §2.2.1）：残留进程会让下一次聚合运行停等，看起来像"套件挂了"。
8. 改了 **host 半边**（`src/**`）→ 记住本机**不会热更新**（§2.5）：`tsc` 0 错只说明产物是对的，**不说明 GUI 里的实例换了新代码**。判断"进没进去"看 `<DSH_HOME>\logs\dsh-ssh\host-ready.json` 的 `remoteMethods`，要真正生效需重启 DSH；**不要**把"toggle 行后行为没变"当成新代码有 bug 的证据。
