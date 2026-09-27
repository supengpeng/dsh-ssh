# 配置示例（`examples/config`）

这三个文件是**可直接复制**进 profile `cordis.patch.yml` 的 dsh-ssh 行 `config:` 的片段，
值全部等于 `src/config.ts` 里 Schemastery schema 的默认值/推荐值。
配置项的语义、冻结默认值与安全取舍见 [`../../src/security/README.md`](../../src/security/README.md) §6。

| 文件 | 场景 | 关键点 |
|---|---|---|
| [`default.yml`](./default.yml) | **全量默认值**（ICD §6 镜像） | 每个可配项的默认值与含义；删掉某行即回默认 |
| [`hardened.yml`](./hardened.yml) | 连接生产主机 | `hostKey.policy: strict`、审计独立目录、`sftp.verify: sha256`、不给模型注册工具 |
| [`env-credentials.yml`](./env-credentials.yml) | CI / 容器 / 只读凭据 | `secrets.provider: env`（绝不写凭据库）+ `DSH_SSH_<SLUG>_PASSWORD` 命名规则与优先级 |

## 用法

```yaml
# profiles/<name>/cordis.patch.yml —— 只写你要覆盖的项
- id: dsh-ssh
  name: '@local/dsh-ssh'
  config:
    hostKey:
      policy: strict
      knownHostsFile: /etc/dsh/ssh/known_hosts
    logging:
      level: debug
```

也可以直接在 GUI 的 **Settings → 插件 → SSH** 里改（同一份 schema，改完即生效，无需重启）。

## 三条不可协商的安全约定

1. **配置里永远不写密码/passphrase/私钥内容**。这里只出现*引用名*（如
   `DSH_SSH_PROD_PASSWORD`）；值放在 `~/.dsh/.credentials.yaml` 或启动环境变量中。
   插件会把任何塞进 `secretRefs` 的明文**当作配置错误拒绝**（`SSH_CFG_INVALID`），
   且拒绝信息不回显该值。
2. **`logging.redact` 保持 `true`**。改为 `false` 等于主动放弃验收项
   「凭据不在日志与 UI 明文中出现」（审计日志同样受影响）。
3. **`hostKey.policy` 不要用 `insecure`**，除非是一次性排障。
   `strict`（生产）或 `accept-new`（首次自动记录）都能防中间人；
   `insecure` 不读也不写 known_hosts，等于关掉主机身份校验。
