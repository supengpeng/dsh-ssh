# `test/support` —— 本地 SSH 靶机与夹具

> 本目录是**全项目共用的确定性测试目标**。本机没有 Docker、没有 WSL，所以"对真实 Linux 服务器验证"在 CI/日常开发里由这里基于 `ssh2` 的 **Server API** 搭出的真协议 sshd 承担：真实 TCP 套接字、真实密钥交换与加密、真实 `session`/`exec`/`shell`/`sftp` 通道，只有 **命令执行**部分是在进程内由 `minish.mjs` 解释的（不依赖 Windows 的 `cmd.exe`）。

## 1. 三个文件

| 文件 | 作用 |
|---|---|
| `sshd.mjs` | 靶机主体：`startSshd()` / `withSshd()`、认证、exec/shell/sftp 处理、故障注入、统计与事件时间线 |
| `minish.mjs` | 进程内 POSIX 风格命令解释器 + 交互式 shell（`openShell` 的行为就来自这里） |
| `fixtures.mjs` | 临时目录、夹具树、可复现随机负载、指纹/known_hosts 行、`waitFor` 等工具 |

自测：`node --test --test-concurrency=1 test/integration/sshd-double.test.mjs`（13 例，覆盖本文件描述的全部能力）。

## 2. 最小用法

```js
import { withSshd, Client, collectExec, withSftp } from '../support/sshd.mjs'
import { seededBuffer, sha256Hex, waitFor } from '../support/fixtures.mjs'

await withSshd(async (server) => {          // 结束时自动 stop() 并删除临时 root
  const client = await server.connect()     // 已 ready 的 ssh2 Client（密码认证）
  const r = await collectExec(client, 'uname -a')
  // r = { stdout, stderr, code, signal }
  await withSftp(client, (sftp) => new Promise((resolve, reject) =>
    sftp.readdir(server.home, (e, list) => (e ? reject(e) : resolve(list)))))
  client.end()
})
```

也可以手动管理生命周期（需要跨多个 `test()` 复用一个靶机时）：

```js
const server = await startSshd()
// ... 多个用例 ...
await server.stop()
```

## 3. `server` 句柄

**连接信息**：`host`（`127.0.0.1`）、`port`（临时端口）、`user`（默认 `sshuser`）、`password`（默认 `sshpass`）、`config`（密码认证的 ssh2 配置）、`keyConfig`（公钥认证，内联私钥）、`target`（`host:port`）、`ident`、`banner`。

**文件与路径**：`root`（临时夹具根目录）、`home`（`/home/sshuser`）、`sandbox`（虚拟路径 ↔ 真实路径映射）、`hostname`、`stop()`。

**密钥材料**：`identityFile` / `identityFileEncrypted`（真实文件，0600，供插件的 `privateKeyPath` 用例）、`userPrivateKey` / `userPublicKey` / `userEncryptedPrivateKey`、`keyPassphrase`、`hostKey`（PEM，可回传给下一次 `startSshd({ hostKey })` 以复用同一主机身份）、`hostKeyType`、`hostKeyBlob`、`hostKeyFingerprint`（`SHA256:…`）、`knownHostsLine`。

**故障注入**：
| 方法 | 模拟 |
|---|---|
| `dropAll()` | 链路被重置（客户端 `ECONNRESET` → `SSH_NET_RESET`） |
| `freeze()` / `unfreeze()` | 链路黑洞：socket 暂停、不再应答 keepalive（→ `SSH_TIMEOUT_IDLE`） |
| `setAllowedMethods([...])` | 服务端只提供部分认证方式（→ `SSH_AUTH_METHOD_UNSUPPORTED`） |
| `denyPath(vpath, 'r'/'w')` / `allowPath()` | 确定性 EACCES（→ `SSH_PERM_DENIED`），不依赖 Windows ACL |
| `waitForIdle()` | 等待所有 exec/shell 运行结束 |

端口拒绝：先 `await server.stop()`，再用同一端口连接即 `ECONNREFUSED`（→ `SSH_NET_REFUSED`）。DNS 失败：连接不存在的主机名。

**观测**：`stats`（`connections` / `authAttempts` / `authFailures` / `authSuccesses` / `sessions` / `execs` / `shells` / `ptys` / `sftpSessions` / `sftpRequests` / `bytesIn` / `bytesOut` / `lastEnv` / `lastPty` / `lastExec` / `commands`）、`events`（时间线，含 `auth-reject` / `exec` / `exec-exit` / `shell` / `pty` / `window-change` / `signal` / `sftp-*` / `freeze` / `stop` …）、`snapshotStats()`。

**便捷方法**：`connect(overrides)`、`execOnce(command)`、`log(event, data)`。

## 4. 认证

- 密码：`server.user` + `server.password`（可 `startSshd({ user, password })` 覆盖）。
- 公钥：`server.keyConfig`，或自己传 `privateKey: readFileSync(server.identityFile)`。
- 加密私钥：`identityFileEncrypted` + `passphrase: server.keyPassphrase`；passphrase 错误时 ssh2 客户端会**同步抛错**（`Cannot parse privateKey: …`），测试里请用 `try/catch` 包住 `client.connect()`。
- 两把用户公钥都在 `authorized_keys` 内（普通 + 加密那把），两种密钥都能登录。
- 未知用户 / 错误口令 / 未启用的认证方式一律 `ctx.reject(剩下的方法列表)`。

## 5. `exec` 与交互式 shell

`exec` 走非 PTY 通道：stdout / stderr 分离，退出码来自 `stream.exit(code)`；`env` 请求会被记录；信号（`stream.signal('INT')`）会真实中断运行中的命令并以 `128+signum` 退出（INT→130、TERM→143）。

**命令集**（`minish.mjs`；`server` 侧可用 `startSshd({ builtins })` 扩展）：

```
echo printf pwd cd env printenv export unset whoami id hostname uname date
true false exit sleep cat head tail wc ls mkdir rmdir rm touch mv cp ln
chmod stat readlink realpath find grep sort uniq seq yes sha256sum md5sum
clear top sh bash which dirname basename test [ 
```

支持管道 `|`、`;`、`&&`、`||`、重定向 `>` `>>` `<` `2>` `2>&1` `1>&2`、引号、`$VAR`/`${VAR}`/`$?`、通配 `*` `?`、`cd`/`export`。`uname -a` 输出固定：

```
Linux dsh-test 6.1.0-dshsshd #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux
```

文件名/权限位是**虚拟化**的（Windows 只支持只读位）：文件默认 `0644`、目录 `0755`，`chmod` 后 `ls -l` / `stat` / SFTP `stat` 都能精确回读。

交互式 shell（`client.shell({ term, cols, rows })`）：MOTD + 提示符 `sshuser@dsh-test:~$ `、逐字符回显、行编辑（Backspace / ←→ / Home / End / Ctrl+A / Ctrl+E / Ctrl+U / Ctrl+K / Ctrl+W / Ctrl+L）、历史（↑/↓）、Tab 补全（命令名与路径）、Ctrl+C（行内或中断运行中命令）、Ctrl+D 退出、`exit N` 设定退出码；`window-change` 会实时改变后续输出中的终端尺寸。PTY 下输出按真实终端语义把 `\n` 转成 `\r\n`。

**假全屏应用 `top`**（供交互式终端用例）：进入备用屏（`ESC[?1049h`），每 250ms 重绘一帧，帧内包含 `top - frame <n>` 与 `term: <term> size: <cols>x<rows>`，按 `q` 退出并写 `ESC[?1049l`。断言建议：`size: 100x30`（resize 后）与退出序列，而不是依赖时序。

## 6. SFTP

虚拟路径以 `/` 为根（等价于 chroot）：`server.home` = `/home/sshuser`，夹具还提供 `/etc`、`/tmp`、`/var/log`、`~/docs/*`。`REALPATH` 返回虚拟路径。

已实现：`OPEN` `READ` `WRITE` `CLOSE` `FSTAT` `FSETSTAT` `STAT` `LSTAT` `SETSTAT` `OPENDIR` `READDIR` `REMOVE` `MKDIR` `RMDIR` `RENAME` `READLINK` `SYMLINK` `REALPATH` 与 `posix-rename@openssh.com`；其余扩展返回 `OP_UNSUPPORTED`。

- `READ`/`WRITE` 支持任意 offset（分块并发、断点续传安全）。
- 错误码：`NO_SUCH_FILE=2`、`PERMISSION_DENIED=3`、`FAILURE=4`（目录非空 / ENOTDIR / EXCL 命中已存在文件，message `SSH_FX_FILE_ALREADY_EXISTS`）、`OP_UNSUPPORTED=8`。
- `READDIR` 分批返回（默认每批 64 条，`startSshd({ readdirBatch: 2 })` 可强制多批）。
- 大文件：`createWriteStream/createReadStream` 走真实分块读写；`seededBuffer(bytes, seed)` 生成可复现负载，`sha256Hex()` 校验。预置大文件：`startSshd({ tree: { '/tmp/big.bin': seededBuffer(100 * 1024 * 1024) } })`。

## 7. 编写用例的注意事项

1. **不要断言"缓冲里出现过"，要断言"标记之后出现过"**：交互式输出的既有提示符会让 `waitFor(/prompt/)` 立即命中。请用 `mark()` + `waitForNew(pattern)`（参见 `test/integration/sshd-double.test.mjs`）。
2. **显式结束连接**：`client.end()`；带 `keepaliveInterval` 的客户端不结束会让测试进程无法退出（`verify-all` 每层还有强制超时兜底）。
3. 靶机命令集是进程内解释器，不是 Windows shell；需要真实二进制时请走**真机层**（`test/integration/real-target.test.mjs`，受环境变量 gating）。
4. `withSshd` 会删除临时 root；需要保留现场时用 `startSshd({ keepRoot: true })`。
