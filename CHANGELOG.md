# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构；版本号跟 `package.json`（当前 `0.1.0`）。
接口契约的版本独立演进，见 `docs/ICD.md` 顶部（当前 v1.0.8）。

## [Unreleased]

### Verified（2026-09-27 最终：十条验收全部通过，含 UI 实测）
- 用户完成全部十条验收走查：**文件页签**「进目录：切换过去了，也可以回到上一层」「上传：可以发出，传输条出现进度」「也能下载」——console 证据 `files: navigate`、`rpc stream sshPlugin/upload` → `upload open`、`rpc stream sshPlugin/download {remotePath, localPath}` → `download open { hostStreamId: "st_01M3G4FSGFZD0XA96C9993KCAF" }`，6938 B 落地 `C:\Users\<user>\.dsh\cordis.patch.yml.bak-preset-standard-20260925-222753`；GUI 内 `top` 与多会话/亮暗主题为用户走查确认。
- **证据边界**：100 MiB 级传输闭环于引擎/工具层（真机 100.0 MiB 实测）；UI 侧为小文件实测，不宣称“UI 端完成 100 MiB 传输”。已知缺口清单（`serverBanner`、`@revoked`/问题级 `policy`、lint warnings 等）**保持有效，不因全通过而删除**。
### Verified（2026-09-27：UI 全链路在真机实测打通）
- **UI 端到端可用（真实浏览器 + 真机 `203.0.113.10`）**：客户端 console 首行 marker `ssh-client-2026-09-26.4-console-clean`（新产物已生效）；`rpc stream sshPlugin/openShell` 打开（host `streamId st_01M3FYPPRYYBS78D70ZXNPKDKR`），逐键 `shellWrite {"data":"l"/"s"/" "/"-"/"a"/"\r"}` **全部 `ok`**；终端**有提示符且 `ls -a` 有真实输出**；console 无 `Cannot read properties of undefined (reading 'dimensions')` 未捕获错误、无 `has no channel yet` 告警。host `plugin.jsonl`：`22:52:18 connected to root@203.0.113.10:22 in 712ms (auth=password(••••••••), hostKey=accept-new)`、`22:52:18 session s_01M3FYPP1NHDKF36ZGPNZASCYH ready`；`audit.jsonl`：`connect ok (durationMs 722)`、`setSecret ok`。原文摘要与复现方法见 `docs/ACCEPTANCE.md` §11。
- 状态变化：**终端流式（上下行）**、**进度/日志流所用的同一流式通道**、**会话视图布局** 三项由"待走查"升级为"已实测覆盖"；**仍待用户走查**：GUI 内 `top` 全屏、文件 UI 上传/下载进度观感、多会话标签 + 亮/暗主题切换（**未记为通过**）。

### Platform limitation（如实记录，非插件缺陷）
- 当前桌面端组合**无凭据服务**：`setSecret ok` 的结果是 `"persisted": false, "reason": "no credentials service in this composition"`，凭据仅登记为**会话期内存**，因此**每次重启 DSH 后需要重新输入密码**。插件已按 ICD §6 实现降级路径（记录原因、UI 显示来源），组合一旦提供 `ctx.credentials` 即自动持久化，无需改代码。

### Added（task-11 OpenSSH 真值对拍 + 真机层）
- `test/integration/openssh-interop.test.mjs`（A 层，离线、CI 安全、默认执行）：用真 `ssh-keygen` 作为**实现之外的真值** —— 三把真密钥（ed25519/rsa/ecdsa）的指纹与 `ssh-keygen -lf` **逐字节一致**；我们写出的 known_hosts 行可被 `ssh-keygen -F` 找到；`|1|salt|hmac` 哈希条目**双向**可读且不泄漏主机名；通配/取反/`@cert-authority`/`@revoked` 解析保留；策略矩阵（strict 拒未知、accept-new+remember→`exact`、同类型换钥→`MISMATCH`/`changed`、不同类型→`unknown`、insecure 放行）；解析后再发回的 blob 经 OpenSSH 指纹仍一致（零字节丢失）。`ssh-keygen` 缺失时整文件带理由 skip。
- `test/integration/real-target.test.mjs`（B 层，`DSH_SSH_TEST_REAL_*` gating）：**已对真机 `203.0.113.10` 实跑通过**主机密钥序列（三把真密钥 accept-new → `remember` → strict `exact` → 同类型换钥 → `SSH_HOSTKEY_MISMATCH`）；另有真机 `exec uname -a` + `/tmp/dsh-ssh-test/**` 内的 SFTP 往返与清理断言。凭据缺失时 skip 并给出理由；`ssh-keyscan` 无法协商（本地 OpenSSH 缺 `sntrup761x25519`）时自动回退到我们自己的 ssh2 栈捕获主机密钥。
- `scripts/verify-all.mjs`：集成层改为**按文件名枚举并显式排除** `real-target.test.mjs`，真机层只在 `--real` 下运行。

### Known issues（对拍发现，已派单）
- `@revoked` 条目在 `verify()` 中不生效（OpenSSH 语义必须拒绝）；问题级 `policy` 覆盖未生效。两者在 `DSH_SSH_STRICT_ICD=1` 下转为硬失败，详见 `docs/TESTING.md` §4.1。

### Added（T8 测试基建、文档与 Demo）
- `test/support/sshd.mjs`：基于 `ssh2` **Server API** 的真协议 sshd 靶机（真实 TCP/密钥交换/加密/通道/SFTP 子系统），支持密码 + 公钥（含加密私钥 + passphrase）认证、`exec`（stdout/stderr/退出码/env/cwd/stdin/信号）、PTY `shell`（行编辑/历史/补全/`window-change`/全屏 `top`）、完整 SFTP 操作（含任意 offset 读写与分批 `READDIR`）、故障注入（`dropAll`/`freeze`/`setAllowedMethods`/`denyPath`）与统计时间线。自测 13/13。
- `test/support/minish.mjs`：进程内 POSIX 风格解释器（管道/`;`/`&&`/`||`/重定向/引号/变量/通配/`VAR=value cmd` 前缀）+ 交互式 shell（方向键、Ctrl 组合、历史、Tab 补全、假全屏应用 `top`、ONLCR 换行语义）。
- `test/support/fixtures.mjs` / `host.mjs` / `frames.mjs`：可复现负载、虚拟路径沙箱、ICD §7 门面夹具（连接池/执行/SFTP）、§3 帧不变式校验器。
- `test/integration/sshd-double.test.mjs`：靶机自测（认证三态、exec、PTY、signal、SFTP 全操作、denyPath、freeze→keepalive 超时、dropAll→ECONNRESET）。
- `test/integration/stack.test.mjs`：**对靶机驱动真实 host 模块**的集成层（连接/认证/host-key 三档/exec/PTY/SFTP/10 会话并发/池上限/断链）。
- `test/integration/icd-conformance.test.mjs`：契约门 —— §0 包与入口、§0.3 bundle 封套、§3 帧判别式与不变式（真流）、§4 方法表存在性（未接线时带理由 skip，`DSH_SSH_STRICT_ICD=1` 转硬失败）、§5 全 32 错误码 + `retryable` 与文档一致、§6 patch 默认值、§8.5 双语 i18n 键集合。
- `test/e2e/run.mjs`：9 步无头验收走查（新建连接→连接→PTY `uname -a`+`top`→exec 帧不变式→2 MiB 上传→下载校验→10 会话并发→断开→日志无凭据）。
- `test/perf/perf.test.mjs`：100 MiB 上传/下载字节一致 + 吞吐下限、10 会话并发各自哈希匹配、大流式 exec 完整性；规模与下限可环境变量降级。
- `scripts/verify-all.mjs`：一键验证（typecheck→lint→build→bundle:check→unit→client→integration→e2e→perf→real/coverage 可选），**每层硬超时 + kill 进程树 + 输出尾部**，EPERM 时退化 `stdio:'inherit'` 重跑；启动前**并发自检**并清理注入的 `NODE_OPTIONS` 等变量（ICD §12 R9）。
- `scripts/lint.mjs` + `eslint.config.js`：优先真 eslint（flat config，排除 vendor；errors=正确性/warnings=风格），未安装时退回等价的内建结构检查（`@module`/`@order` 头、client 禁 ESM 语法、第一方禁硬编码色值、禁止 `.only`、skip 必须带理由、全局 U+FFFD 编码门）。
- `README.md`（安装/配置/UI/Agent 工具/FAQ/开发/截图）、`docs/TESTING.md`（分层命令、单一 tsc 工程纪律、并发纪律、真机 gating、性能参数与实测、覆盖矩阵）、`docs/DEMO.md`（自动化 + GUI 逐步走查）、`CHANGELOG.md`、`.gitignore`。

### Fixed（T8 期间发现并修复）
- 靶机：`ssh2` 1.17 三处坑的规避（`generateKeyPairSync('ed25519')` 约 2% 产出畸形公钥 → 校验并重生成；`Server` 的 `'connection'` 事件载荷是 Client 而非 socket → 自持 TCP 服务器 + `injectSocket()`；公钥验签第三参应为 `ctx.hashAlgo`）。
- 靶机：解译器补齐 `VAR=value cmd` 前缀赋值与 `cd -- <path>`（真实实现发送的命令形态）；未知变量在第一次展开时保留字面量，交由按命令环境二次展开。
- 靶机：`chmod`/模式位虚拟化（Windows 只支持只读位），使 `0644/0600/0755` 在 `stat`/`ls -l` 中可精确回读。
- 靶机：信号终止改为发送 `exit-signal`（客户端看到 `code:null, signal:'TERM'`），与 OpenSSH 一致。

### Known issues
- 第一方 4 处硬编码 `rgba()`（`client/src/core.js:91`、`client/src/chrome/theme.gen.js:308/392/507`）违反 ICD §8.6，已派单 sp5/sp7；`verify-all` 的 lint 层会红。
- `src/service.ts` 仍是 M0 切片（`ping`/`probeStream`/`describe`/`reportSpike`），§4 的 39 个端点在 `src/api/**` 接线完成前，契约门以带理由的 skip 报告。
- `SftpHandle` 门面在 `listDir`/`createWriteStream` 失败路径上泄漏 ssh2 原始数字状态码（`2`）而非 ICD §5 字符串码；已记录并在集成层以 `DSH_SSH_STRICT_INTEGRATION=1` 作为硬门待闭合。
- `eslint-plugin-react-hooks` 未安装：`exhaustive-deps` 在 flat config 中为显式 no-op（hooks 依赖不做静态检查），见 `docs/TESTING.md` §2.4。
