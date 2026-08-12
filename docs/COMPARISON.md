# omp Agent vs Zed Agent：功能对比

Zed 1.14 的 Agent Panel 有两种代理来源：**Zed Agent**（内置，Zed 托管模型/工具/计费）与 **External Agent**（ACP 协议接入，如 Claude、Codex、Gemini、omp）。omp-acp 把 omp 以 External Agent 接入，同时用 MCP 桥把 omp 的能力暴露给内置 Zed Agent 调用。

以下矩阵对比 **Zed Agent（内置）** 与 **OMP Agent（本插件，`omp acp`）** 在同一 Agent Panel 里的能力差异。

## 能力矩阵

| 维度 | Zed Agent（内置） | OMP Agent（omp-acp） |
|---|---|---|
| 模型与认证 | Zed 账户 / API key / 本地模型（LLM Providers） | **omp 自己的认证**（`~/.omp`，Anthropic/OpenAI/Gemini/OpenCode/OpenRouter…几十家 provider） |
| 模型切换 | 面板模型选择器 + 收藏 | omp 侧：`/model`、Ctrl+P 循环、`--model` 模糊匹配 |
| 工具 | 内置：read/edit/terminal/grep/diagnostics/skills/web_search 等 | omp 工具集：read/bash/edit/write/grep/glob/lsp/python/notebook/inspect_image/browser/task/todo/web_search/ask…（可通过 `--tools` 裁剪） |
| 工具许可 | `agent.tool_permissions.default`（confirm/allow/deny + 按工具规则） | omp 侧 `--approval-mode`（always-ask/write/yolo）；经桥委派时默认拒绝 omp 弹窗（`autoConfirm: false`） |
| 上下文注入 | `@`-mention 文件/符号/诊断/skills/URL、选区、图片 | omp 侧：`@文件`、CLAUDE.md/AGENTS.md 类规则、skills、rules、MCP 客户端（.omp/mcp.json、.claude 等兼容发现） |
| 多线程/并行 | Threads Sidebar、每项目多线程、worktree 隔离 | omp 侧并行由线程外触发（无 Zed 面板集成）；omp 内部有 task 子代理/并行 agents |
| 检查点（Checkpoint） | **有**：每次编辑可 Restore Checkpoint | 无原生 Zed 集成；omp 的 git/undo 类恢复靠其自身工作流（`session-tree`、git） |
| 自动压缩（Compaction） | Zed 按 token 阈值自动压缩 + `/compact` | omp 自己的 auto-compaction + `/compact`（各自独立计算） |
| 线程历史/恢复 | Zed 线程历史、导入外部线程 | omp 会话历史在 `~/.omp/agent/sessions`，可经 `omp_continue` 桥工具续接；Zed 的 Thread History 也能导入 omp（ACP 会话） |
| 消息队列/Steer | 队列消息；**Steer 仅 Zed Agent 可用**（外部代理无法检测轮次边界） | 外部代理限制：无 Steer；omp 内部有 steering/follow-up 队列机制 |
| MCP 转发 | Zed 配置的 MCP 直接使用 | Zed 的 MCP 经 ACP 转发给 omp；omp 也可读自己的原生 MCP 配置 |
| 终端线程 | Agent Panel 内置终端线程 | 无对应物（omp 是纯 CLI/代理） |
| 委派（本插件扩展） | 无 | **omp_run / omp_continue / omp_status / omp_models / omp_sessions**：内置 Zed Agent 可把任务委派给 omp 执行，双向打通 |
| 计费/隐私 | Zed 托管模型按 Zed 计费；数据走 Zed/所选 provider | 全部走 omp 及用户自己的 provider 凭据；Zed 不参与 |
| 扩展生态 | 依赖 Zed 扩展市场 | 依赖 omp 的扩展/插件市场（npm 插件、marketplace、hooks、skills） |

## 差异要点

1. **生态归属不同**：Zed Agent 的能力由 Zed 扩展生态决定；omp 的能力由 omp 生态（provider、插件、skills、MCP）决定。omp-acp 的作用是"把两边接上"，不重复造轮子。
2. **Steer 不可用**（ACP 外部代理通用限制）：omp 线程里排队消息不能像 Zed Agent 那样打断当前生成，只能等轮次结束；omp 自身的 `--thinking`/`abort` 流程不受影响。
3. **Checkpoint 归属**：Zed 的编辑检查点只跟踪 Zed Agent 自己的编辑。omp 线程里的编辑是 omp 进程做的，Zed 不提供 Restore Checkpoint（可用 Zed 的 git 面板/时间线兜底）。
4. **委派桥的方向性**：`omp_run` 是"Zed Agent → omp"单向委派（同步等待结果）。omp 反向调用 Zed 工具（host tools）未启用——桥不注册 host tools，omp 用自己的工具集完成委派任务。
5. **性能/成本**：omp 线程与 Zed 线程并行运行互不阻塞；各自独立计费。委派运行受 `timeoutMs` 约束，超时返回部分结果并中止。

## 怎么选

- **要 Zed 原生体验**（checkpoints、steer、多线程、@-mention）→ 用 Zed Agent（配置任意 provider 即可）。
- **要 omp 的完整工具链/生态、已有 omp 认证与配置** → 用 OMP 线程。
- **混合**：主线程用 Zed Agent，遇到大任务用 `omp_run` 委派给 omp——这正是本插件的定位。
