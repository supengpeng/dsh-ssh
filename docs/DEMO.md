# 验收走查脚本（Demo）

> 目标：**照着做就能复现用户十条验收标准**。分两部分：
> **A. 自动化部分**（一条命令，任何人可复现）；**B. GUI 走查**（需在真实 DSH 窗口里点，由 Lead/用户执行，因为本会话禁止重启 DSH）。
> 每一步都标注了"看什么/什么算过"。截图见 `docs/img/`。

---

## A. 自动化走查（无头，可复现）

```powershell
cd <repo>\dsh-ssh
node test/e2e/run.mjs                 # 9 步验收走查（本地真协议 sshd 靶机）
node scripts/verify-all.mjs           # 全层：lint/类型/构建/单测/组件/集成/E2E/性能
node scripts/verify-all.mjs --real    # 追加真机层（需 DSH_SSH_TEST_REAL_*）
```

`test/e2e/run.mjs` 的 9 步与用户验收标准一一对应：

| 步骤 | 对应验收 | 通过标准（脚本自动断言） |
|---|---|---|
| 1. 新建连接 | 连接管理 | profile 校验通过并产出 `s_…` 会话 |
| 2. 连接 | 连接可用 | 状态机到 `connected`；`SessionInfo` 的 host/port/user 与靶机一致 |
| 3. 终端执行 `uname -a` | 终端可用 + 全屏程序 | PTY 回显 `Linux dsh-test 6.1.0-dshsshd …`；`top` 进入备用屏并按 `q` 退出；`exit 0` 退出码正确 |
| 4. 命令通道 | 命令执行 | `exit=3`、stdout/stderr 分离、§3 帧序列合法 |
| 5. 上传 | 文件传输 | 2 MiB 上传后**远端 sha256 与本地一致**，进度单调 |
| 6. 下载 | 文件传输 | 回读 sha256 一致、远端 size 匹配 |
| 7. 10 会话并发 | 多会话 | 10 个会话各自输出自己的编号，互不串扰 |
| 8. 断开 | 优雅断开 | 池清空；服务端 `connections == disconnects`（无残留） |
| 9. 凭据 | 安全 | 插件日志中不含口令/私钥明文 |

预期输出（节选）：

```
  PASS  3. 终端：PTY shell 执行 uname -a 得到内核行 — uname -a + 全屏 top + 正常退出
  PASS  5. 上传：2 MiB 字节一致 + 进度单调 — 2097152 bytes, sha256 ffdec0be6836…
  PASS  7. 10 会话并发：无串扰 — 10 会话并发，输出互不串扰
E2E: OK — 9 steps
```

性能验收（100 MiB）：

```powershell
node --test --test-concurrency=1 --test-force-exit "test/perf/*.test.mjs"
# 实测：上传 100 MiB 2.9s = 34.4 MiB/s；下载 100 MiB 5.0s = 20.1 MiB/s；10 会话并发 31.6 MiB/s 聚合
```

---

## B. GUI 走查（真实窗口，逐步）

> 前置：插件已装入运行中的 profile（`node scripts/profile-install.mjs --status` 显示 ready），`lib/client.js` 为最新构建（`node scripts/build-client.mjs --check` 通过）。
> 靶机：优先用真机（把 `docs/REAL-TARGET.md` 的 host/port/user 填进表单；密码由用户当面输入，**不要**写进任何文件）；也可用本地靶机（见 §C）。

### B1. 打开侧边栏 → 新建连接
1. 点侧栏底部 **SSH** 动作（Settings 旁）；或会话输入框左侧的 SSH 图标；或 `Ctrl/Cmd+Shift+S`。
2. 右侧栏出现 **SSH** 标签，面板为连接列表（空列表显示 `conn.list.empty` 文案）。
3. 按 `Ctrl/Cmd+T` 或点"新建连接"：填写 名称/主机/端口/用户/认证方式。
   - ✅ 端口非法（>65535 / 非数字）会即时标红（`SSH_CFG_INVALID` 语义）。
   - ✅ 密码输入框显示为掩码；回显开关切换后仍是掩码形式（固定 8 点，不泄漏长度）。
4. 点 **测试连接**：显示延迟、服务端 banner、主机密钥指纹。首次连接若策略为 `strict` → 弹指纹确认；`accept-new` → 自动记住。

### B2. 连接
5. 点 **连接**。状态从 `connecting → authenticating → connected`。
   - ✅ 错误口令 → 明确错误提示（`SSH_AUTH_FAILED`），不是静默失败。
   - ✅ 端口写错 → `SSH_NET_REFUSED`；域名写错 → `SSH_NET_DNS`。
6. 连接成功后进入会话工作区，状态栏显示 host/user/port、延迟、已连接时长、流量。

### B3. 终端执行 `uname -a`
7. 切到 **终端** 标签（会话建立时默认打开）。
8. 输入 `uname -a` 回车。
   - ✅ 输出 `Linux <hostname> …`（真机为 Ubuntu 24.04，内核 6.8.0-48）。
9. 再输入 `top`：全屏刷新正常，按 `q` 退回 shell 提示符。
   - ✅ 这是"PTY + 终端仿真正确"的关键证据（行模式终端做不出来）。
10. 试 复制（选中即复制 / `Ctrl+C` 视配置）、粘贴、`Ctrl/Cmd+L` 清屏、`Ctrl/Cmd+= / - / 0` 字号。

### B4. 上传文件
11. 切到 **文件** 标签，左栏本地、右栏远端（进入远端 `~` 或 `/tmp/dsh-ssh-test`）。
12. 选一个本地文件点 **上传**（或拖拽）。
    - ✅ 进度条推进、速率与 ETA 显示；完成后远端目录出现同名文件。
13. 在 **终端** 里 `sha256sum <远端文件>` 与本地 `Get-FileHash` 对比 → 一致。
14. 大文件（≥100 MiB）可再试一次；中断后重传应显示"从断点续传"（`resumedFrom`）。

### B5. 断开
15. 状态栏点 **断开**（或关闭该会话标签，会二次确认 `closing a live session`）。
    - ✅ 会话状态 → `closed`；标签关闭；审计日志留下本次操作记录（已脱敏）。
16. 再点一次 **连接** 可复用档案重连（默认复用策略；`forceNew` 才新建连接）。

### B6. 主题与多标签
17. 切系统/DSH 亮暗主题：面板、终端、表格、进度条颜色随之变化，无硬编码色残留（`node scripts/lint.mjs` 对第一方代码零硬编码色值是硬门）。
18. 连 2–3 台（或同一台多会话）：标签栏出现多个会话标签，圆点表示 `connected/connecting/error`；`Ctrl/Cmd+1..9` 跳转、`Ctrl/Cmd+W` 关闭。

---

## C. 用本地靶机做同样的 GUI 走查

没有真机时，用仓库自带的真协议 sshd 靶机（**无需 Docker/WSL**）：

```powershell
node -e "import('./test/support/sshd.mjs').then(async (m) => { const s = await m.startSshd({ keepRoot: true }); console.log('host', s.host, 'port', s.port, 'user', s.user, 'password', s.password); })"
```

把输出里的 host/port/user/password 填进"新建连接"即可（认证方式选密码）。靶机支持密码与公钥、`exec`/PTY/`top`、完整 SFTP；命令集见 `test/support/README.md`。
> 注意：靶机的命令是进程内解释器（不是真的 Ubuntu），所以 `uname -a` 返回固定的 `Linux dsh-test 6.1.0-dshsshd …`；真实内核信息只在真机上能看到。

---

## D. 已知偏差（走查时需知道）

| 项 | 现状 | 影响 |
|---|---|---|
| `§4` 端点表尚未全部接线到 `src/service.ts` | `icd-conformance.test.mjs` 以带理由的 skip 报告 `39` 个方法中已接线数；`DSH_SSH_STRICT_ICD=1` 转硬失败 | 走查前 Lead 完成接线后，该层自动变为全量断言 |
| 第一方 4 处硬编码 `rgba()`（`client/src/core.js:91`、`client/src/chrome/theme.gen.js:308/392/507`） | 已派单 sp5/sp7 | 暗色模式下阴影对比度不足；lint 层会红 |
| 真机层与 OpenSSH 对拍层 | 见 `docs/TESTING.md` §4 的 gating 说明；层 B 需 `ssh-keyscan` 连通真机 | 未配置环境变量时**明确 skip**，不影响其他层 |
