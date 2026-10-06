# STATE: vps-file-hub

> **本文件是意图，产物是事实。冲突时永远信产物。**（流程手册 §0.2 硬规则）
> 每完成一步必须更新本文件。流程手册：`D:\proj\idea-to-ship-flow.md`

## 方案确认单

- **特性/项目名**：`vps-file-hub`（仓库 `LinkBin`）
- **场景**：S1 全新项目 · 路径清晰
- **规模感**：多会话，路径清晰（预计 4–8 轮）
- **不确定性**：纸面能定为主；**但有平台硬限值未经核实**（见「未决问题」Q5）
- **协作面**：只有我
- **交付物厚度**：原教旨（spec + 工单）
- **issue tracker**：本地 markdown（`.scratch/`）
- **授权边界**：**可写代码=是；可提交=是；可推 PR=是；可部署 VPS=否**
- **链路**：`setup` → `grill-with-docs` → `to-spec` → `to-tickets` → `implement`
- **明确跳过**：`wayfinder`（雾不厚）、`prototype`（暂无可跑才知道的硬问题）、`triage`（不处理自制工单）
- **开始日期**：2026-10-07
- **当前阶段**：第 0 步 ✅ 完成（2026-10-07）

---

## 当前阶段

**第 0 步 · setup-matt-pocock-skills —— 已完成。**

下一步是 **第 1 步 `grill-with-docs`**（想法 → 共识）。第 1–3 步必须保持在**同一个不断开的上下文窗口**里。

## 已完成（产物 + 证据）

- [x] **第 0 步 setup** → `docs/agents/issue-tracker.md`（本地 markdown）、`docs/agents/triage-labels.md`（默认五角色；`triage` 已安装故本节成立）、`docs/agents/domain.md`（单上下文）、根 `AGENTS.md` 的 `## Agent skills` 块。依据：`~/.agents/skills/setup-matt-pocock-skills/SKILL.md`。
- [x] **仓库初始化** → `git init`（`main`），初始提交 `c9af21c` 含本续接卡与登记簿。依据：`git log --oneline`。
- [x] **远端建立并推送** → `origin` = `git@github.com:medicagooo/LinkBin.git`（**PUBLIC**，默认分支已为 `main`）。`origin/main` = `cf8c415`，与本地一致、无分歧，普通 fast-forward 推送、无需强制。依据：`git ls-remote origin`、`gh repo view`、`gh api .../git/trees/main?recursive=1`（远端树 14 个 blob 全部就位）。
- [x] **工具链核实** → 36 个 skill 目录（mattpocock 27 + 腾讯 RTC 9）均含 `SKILL.md`；`git` 2.56 / `gh` 2.102（账号 `medicagooo`，SSH 协议，含 `repo` scope）在 PATH；**Node/pnpm/Python 不在 PATH**（须用 DSH 自带运行时）；无 Docker。
- [x] **网络环境核实** → `web_fetch` 在本机**完全不可用**（任意公网域名解析为非公网 IP）；`web_search` 可用但只返回来源与摘要。故平台限值必须显式标注"未核实"。
- [x] **架构因果核实** → Cloudflare Workers 无长驻进程、不能主动建 SSH/SFTP 长连接，故"worker 拉取 vps"在实现上必须变为 **VPS 侧 agent 主动推送**（协议层必然，非文档依赖）。

## 已锁定决策（不可回退 / 改动需重开）

- **D1 技术栈**：后端跑在 **Cloudflare Workers**；**D1** 存元数据；**R2** 存文件本体。理由：用户 2026-10-07 明确指定。影响：全部票。
- **D2 术语更正（与原始想法冲突，已确认）**：原始想法说"非关系数据库"，但 **D1 基于 SQLite，是关系型**。用户知悉后仍选定 D1。→ **此后所有产物禁止再用"非关系数据库"描述本项目存储**，须表述为"元数据存 D1（SQLite），文件本体存 R2 对象存储"。影响：GLOSSARY、spec、全部票。*（§2.2 要求显式指出冲突，此处已指出并记录；正式 ADR 待第 1 步落盘。）*
- **D3 数据流方向**：**VPS 侧 agent 主动推送 → Worker ingest API → 写 R2 → 写 D1 元数据 → 消费端凭元数据关联下载**。Worker 侧的定时任务（Cron）只做触发对账/续传，不承担"主动拉取"。
- **D4 同步语义**：**定时增量同步 + 内容哈希去重，只推新增/变更文件**。理由：省带宽、天然幂等、可重跑。（用户选定）
- **D5 无事务约束**：D1 不支持多语句原子提交。设计只用**对象级原子性 + 幂等写 + 补偿动作**，禁止任何"多步作为一个单元成功或失败"的假设。这是全局硬约束。
- **D6 授权边界**：可写代码 / 可本地提交 / **可推 PR 到远端**；**不可部署 VPS**。AI 不得自行认定已获部署授权。
- **D7 流程纪律**：S1 链路，第 1–3 步不断上下文；每步结束更新本文件。

## 未决问题（阻塞项）

**开放问题必须在第 1 步 `grill-with-docs` 中全部关闭；有任何问题悬着就不得进 `to-spec`（§2.2 判据）。**

- **Q1（阻塞 spec）** VPS 侧 agent 的形态：语言（Python / Go / 纯 shell + curl）、安装方式、是否需要常驻、如何配置"指定位置"。→ 判定维度：纸面可定，但影响票切分。
- **Q2（阻塞 spec）** 摄取传输路径：文件经 Worker 中转上传 vs agent 直传 R2。**受 Workers 请求体大小上限约束，该上限尚未核实**（Q5）。
- **Q3（阻塞 spec）** 元数据模型：需要哪些字段（VPS 标识 / 路径 / 大小 / 内容哈希 / mtime / 版本代际 / 软删）。
- **Q4（阻塞 spec）** 消费端形态：纯 HTTP 下载（预签名 URL 或 Worker 流式返回）是否足够，还是要 Web 浏览/搜索界面。
- **Q5（阻塞 Q2）** **Cloudflare 平台硬限值未核实**：Workers 请求体上限、R2 分片上传的部件尺寸上下限、D1 库大小/行大小上限、Cron 触发上限与最小粒度。→ 已派出后台 research 子 agent 取一手来源；**本机 `web_fetch` 不可用，可能只能拿到"未核实"结论**。
- **Q6** Cloudflare 账号侧凭据与资源就绪情况：R2 bucket、D1 database 是否已创建；`wrangler` 认证方式。→ 影响第 0 步之后的 `wizard` 叠加项。
- **Q7** 上游 VPS 清单与要采集的具体路径（数量、总量级）。→ 由用户提供。

## 授权边界

- 可写代码：**是**　可推 PR：**是**　可部署：**否**
- 其他约束：
  - 不部署到任何 VPS，不动 Cloudflare 线上资源（建 bucket/database 属外部状态变更，需单独确认）。
  - `web_fetch` 不可用时**禁止凭记忆写平台限值**，一律标注"未核实"。
  - D1 无事务（D5）。
  - VPS 侧 agent 部署在本仓库控制之外的机器上，ingest API 一旦发布须保持向后兼容。

## 下一个动作（精确到可执行）

- **动作**：执行**第 1 步 `grill-with-docs`**——读 `C:\Users\medic\.agents\skills\grilling\SKILL.md` 与 `C:\Users\medic\.agents\skills\grill-with-docs\SKILL.md`，就 "VPS 文件汇聚与关联下载" 拷问用户：**一轮 3–5 个问题、每题附推荐答案**，优先关闭 Q1–Q4、Q7。随结论落盘 `GLOSSARY.md` 与 `docs/adr/`（首个 ADR 应固化 D2/D3）。
- **前置**：
  1. 采纳后台 research 子 agent 的结论（或确认其"未核实"标注），把结果写入 `docs/research/cloudflare-platform-limits.md`。
  2. 用 §1.2 叠加项评估是否需要 `prototype`（若 Q2 的直传路径"必须跑起来才知道"）。
- **验证方式**：设计树每个分支都有结论、**没有任何问题悬在 Q1–Q7 上**；`GLOSSARY.md` 与 `docs/adr/` 已按懒创建原则在术语/决策真正确立时才建。

## 环境硬事实（下一个会话直接用，不要重测）

| 项 | 值 |
|---|---|
| 项目根 | `D:\proj\LinkBin` |
| git 身份 | **本机全局与本地均未设置**；提交使用仓库本地身份 `DSH <dsh@local>`（可用 `git config user.name/user.email` 覆盖） |
| gh | 账号 `medicagooo`，SSH 协议，scope 含 `repo`/`workflow` |
| 远端 | `origin` = `git@github.com:medicagooo/LinkBin.git`，**PUBLIC**，默认分支 `main`；`origin/main` = `cf8c415`（2026-10-07 核实一致） |
| **⚠️ 仓库为公开** | 任何推送内容全球可见。**凭据、VPS 主机清单、内网路径、`.dev.vars` 一律不得入库**（`.gitignore` 已兜底，但需人工复核）。摄取 API 鉴权（Q6 相关）因此是**必需项而非可选项** |
| skill 目录 | `C:\Users\medic\.agents\skills`（36 个） |
| DSH 运行时 | Node：`C:\Users\medic\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`；pnpm：同树 `pnpm\bin\pnpm.mjs`；Python：同树 `python\python.exe`（DSH 自带，**非**系统 Python） |
| 时区 | China Standard Time (+08:00) |

## 会话交接记录

| 时间 | agent/harness | 做了什么 | 留下的产物 |
|---|---|---|---|
| 2026-10-07 02:44 | DSH (deepseek-flash) | 按 §0.2 启动：扫盘确认空仓库 → §1 场景判定为 S1 → 用户确认场景与授权 → 用户改定 Cloudflare 架构（D1/R2）→ 完成第 0 步 setup + 仓库初始化 | `AGENTS.md`、`docs/agents/*.md`、`.scratch/vps-file-hub/STATE.md`、`BRANCHES.md`、`.branch-records/vps-file-hub/*` |
