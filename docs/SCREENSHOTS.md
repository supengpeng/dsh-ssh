# 截图工具链（Screenshots）

本插件的 UI 证据分两类，**两类都需要**：

| 类型 | 工具 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| 组件/结构测试 | `npm test`（node:test + linkedom） | DOM 结构、文本内容、CSS 规则文本、状态机行为 | **任何几何** —— linkedom 没有布局引擎 |
| 截图 | `npm run docs:shots` | 真实浏览器在**真实宽度**下的渲染结果 | 真实宿主的 token 值（见下方限制） |

## 为什么要专门有截图这一步

有一个缺陷只有截图能抓到：文件页签的**文件名全部不可见**。当时

- token-only 门禁**通过**（颜色都是合法的 `--dsw-*`）；
- 组件测试**通过**（名字**确实在 DOM 里**，`textContent` 正确）；
- 而真实原因是**布局**：条目行五行网格的固定列（图标 18 + 大小 76 + 权限 66 + 时间 108 + 间隙）合计需要 **292px**，而名字列写的是 `minmax(0,1fr)`（**可以为 0**）；生产侧栏 420px 被对半分给两个 pane ⇒ 每 pane ≈207px ⇒ **名字列被压到 0px** 并被 `overflow:hidden` 裁掉。

**"元素存在" ≠ "元素可见"。** 这类缺陷只能靠真实渲染暴露，所以截图是证据链的一环，不是装饰。

## 用法

```bash
npm run docs:shots          # 等价于 node scripts/shot-files.mjs
```

输出：

```
docs/img/session-files-light.png
docs/img/session-files-dark.png
```

脚本做的事（`scripts/shot-files.mjs`）：

1. 用与 bundle 相同的 registry 契约**启动真实客户端源码**；
2. **服务端渲染真实的 `FileManager`**，两个 pane 都填入代表性条目；
3. 内联**真实的 `ssh.session.styles`** 样式表与**代表性 `--dsw-*` token 值**；
4. 交给**系统 Edge（headless，2× DPR）** 布局并栅格化。

侧栏宽度取生产默认值（配置 `ui.defaultWidthPx = 420px`），且 `FileManager` 会把它**对半分给两个 pane** —— 也就是说截图正好落在**曾经失效的那个宽度**上。

## 环境要求与边界

- **需要系统 Edge**（Windows 默认路径）；脚本内含多个候选路径，找不到会明确报错。
- 截图输入是 **SSR 产物 + 代表性 token 值**，**不是 GUI 内的实时截图**：真实配色仍以宿主注入的 `--dsw-*` 为准。
- `@container` 规则的实际生效依赖 **Chromium 容器查询**；单测锁的是**规则文本不变量**，像素证据由本脚本产出的 PNG 承担。
- 截图**不进入 CI**：它需要浏览器与 token 值，属于本地/文档证据，而非构建门禁。CI 覆盖的是结构、契约与产物一致性（见 `.github/workflows/ci.yml`）。

## 相关文档

- [ACCEPTANCE.md](./ACCEPTANCE.md) —— 十条验收标准的证据索引（含截图表）
- [../client/src/session/README.md](../client/src/session/README.md) §8/§9.3 —— 布局契约与本次缺陷的根因推导
- [TESTING.md](./TESTING.md) —— 测试分层与运行方式
