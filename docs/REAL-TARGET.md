# 真实 Linux 靶机（M4 真机验收目标）

> **凭据绝不入仓库**。本文件只记录**非机密**目标事实；密码只从环境变量或用户在 UI 里的一次性输入获得。
> 环境变量名遵循 ICD §6 的约定：`DSH_SSH_<PROFILE_SLUG>_PASSWORD` / `_PASSPHRASE`。

## 1. 连接参数

| 项 | 值 |
|---|---|
| host | `203.0.113.10` |
| port | `22` |
| user | `root` |
| 认证方式 | 密码（密码不在此文件中；见 `DSH_SSH_ROOT_PASSWORD`） |

## 2. 实测目标事实（Lead 于 M1 用 ssh2 直接探测，脚本跑完即删）

| 项 | 实测值 | 对验收的意义 |
|---|---|---|
| 认证 | 密码认证成功，握手+认证 788 ms | 「UI 连接真实 Linux 服务器」有目标 |
| 发行版 | **Ubuntu 24.04.5 LTS**（kernel 6.8.0-48-generic，x86_64） | 真 Linux，非 Windows/WSL |
| CPU / 内存 | 8 vCPU / 7939 MB | 10 会话并发压力有余量 |
| 磁盘 | `/dev/vda1` 29G，已用 4.1G，**可用 25G**；`/tmp` 同盘 | 100MB 上下行 + 校验一致有余量 |
| 工具 | `top`、`bash`、`sha256sum`、`md5sum`、`python3` 均在 | `uname -a` 与**交互式 `top`** 可验收；校验可用 sha256sum |
| SFTP | sshd 配置 `Subsystem sftp /usr/lib/openssh/sftp-server`；实测**打开子系统/列目录/写 14B/读回/删除**全部成功 | 文件传输可验收 |
| 主机密钥 | `/etc/ssh/ssh_host_{ecdsa,ed25519,rsa}_key.pub` 三把都在 | known_hosts 的 **strict / accept-new / insecure** 三档都能真机覆盖 |

## 3. 使用纪律（全体子代理必须遵守）

1. **默认不连真机**：任何测试若要连真机，必须**显式**通过环境变量开启，例如
   ```
   DSH_SSH_TEST_REAL_HOST=203.0.113.10 DSH_SSH_TEST_REAL_USER=root DSH_SSH_TEST_REAL_PASSWORD=… \
     node --test test/integration/real-target.test.mjs
   ```
   缺少环境变量时必须 **skip 且给出明确理由**（不允许静默跳过、更不允许失败）。理由：CI 不能依赖外部主机与真实凭据，也不能把真机当每次跑测试的靶子。
2. **绝不把密码写进仓库**：不得出现在源码、测试、配置、注释、README、CHANGELOG、截图、会话导出文件中。
3. **写操作限制在 `/tmp` 下的临时路径**，测试结束必须清理；不要动服务器现有配置、服务与用户数据。
4. **不要修改服务器 sshd 配置**（SFTP 子系统已可用，无需改动）。
5. **测试数据量**：100MB 用例的远端路径固定为 `/tmp/dsh-ssh-test/**`，并在用例结束时删除；避免反复堆积占用（当前可用 25G）。
6. 密码已出现在本次会话记录中（用户明确选择直接提供）。**项目结束后建议轮换该密码**；本插件自身不应依赖它——UI 演示走「新建连接 → 输入密码 → 仅存引用（`ctx.credentials`/一次性内存）」。

## 4. M4 真机验收走查（Lead 执行，对应用户十条验收标准）

1. 打开右侧栏 → 新建连接（host/port/user/密码，掩码可见切换）
2. 连接成功；顶部状态栏显示连接信息 / 延迟 / 时长
3. 终端执行 `uname -a` → 与本文 Ubuntu 24.04.5 事实一致
4. 交互式 `top` → 全屏刷新、按键响应（验证 PTY 不截断 + `?1049` 备用屏）
5. 上传 100MB → 进度条准确；远端 `sha256sum` 与本地一致
6. 下载同一文件 → 校验一致
7. 10 会话并发互不干扰；标签切换流畅
8. 断开；检查编辑期日志/审计/UI 中**不出现**明文凭据
9. 亮/暗主题截图；ICD 一致性核对
10. 汇总为 `docs/ACCEPTANCE.md`
