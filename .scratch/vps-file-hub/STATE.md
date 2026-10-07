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

**第 0 步 `setup` 已完成；第 1 步 `grill-with-docs` 已完成（D1–D45 锁定，Q1–Q7 全部关闭）；分叉 A `prototype` 真机 PASS。**

**2026-10-07 更新**：Worker `linkbin` 已上线；SSH 采集通道**真机验证 PASS**；探针残留已清理，且**探针路由已从代码中删除**（`52edd51`，线上实测 `/probe/*` 全部 404）；部署链路已打通（e033 首次 Workers Builds 构建成功）；迁移已应用（e034，`0002_usage_index`）。

**当前阶段 = 第 5 步 `implement` 进行中（2026-10-07）。票 `01`、`02`、`03` 已完成并推送。**

| 票 | 状态 | 提交 |
|---|---|---|
| `01` 测试设施 + 回执/重要标记/派生来源表 | ✅ resolved | `d8344ba` |
| `02` 鉴权（首访设密码 + 会话 + 登出 + 改密 + 限流 + 前端门 + 调度凭据） | ✅ resolved | `54c227c`, `08fdf3b` |
| `03` 规则与解析（含 `RemoteHost` 端口与排除优先） | ✅ resolved | `3c6ebf1` |
| `04` 100 MB 实测（决定单文件上限） | 🛑 阻塞：需真机+授权 | — |
| `12` 派生对象/合并引擎 | 🟡 引擎已完成（`c5e4e70`），存储侧待 05/08/09 | `c5e4e70` |
| `13` 结构化文档合并 | 🟡 YAML 列表并集+去重已完成，其余待 `12` | `c5e4e70` |
| `06` 大文件流式写入 | 🟡 核心已完成（`f1533d5`，16 测试），分片阈值待 `04` 结论 | `f1533d5` |
| `07` 容量预算与淘汰 | 🟡 策略已完成（`a3ee9c2`，27 测试），执行侧待 `05` | `a3ee9c2` |
| `10` 分享链接 | 🟢 已完成（判定层 + 路由 + **前端面板**） | `16323cb` |
| `09` 回执与问题 | 🟡 读取层 + 路由已完成（`e35778a`），写入侧待 `05`/`08` | `e35778a` |
| `11` 浏览与搜索 | 🟢 已完成（查询层 `614334a` + 面板 `7cd49dd`） | `7cd49dd` |
| `08` 调度与续跑 | 🟡 决策层 + 路由 + 界面触发已完成（`1137a94`/`2a66e23`），执行侧待 `05` | `2a66e23` |
| `09` 回执与问题 | 🟡 读取层 + 路由 + **历史面板**已完成，写入侧待 `05`/`08` | `11d5e35` |

测试：**380 通过 / 0 失败（我方套件）**，另有 4 个对抗审计文件作为回归测试保留。守卫：UI 模板（含**未定义 CSS 变量**检查）+ 迁移（29 条语句 + **登记表一致性**）。构建：`414.27 KiB`。

**票 `10` 已完成**（除"在真实部署上手动点一遍"）。关键性质：

- **密码在打开文件之前校验** —— 拒绝响应里**不含任何文件内容**。"发出去几个字节之后才拒绝"不算拒绝。
- **收件人只被告知文件名、大小、是否需要密码**，**不告知主机、完整源路径与存储键**。收件人拿到的是一份文件，不是别人服务器的目录清单。
- **取消写时间戳而非删行** —— 收件人被告知"链接被停止"，而不是看到"不存在"；运维列表保留历史。
- **下载是流式的** —— 单文件上限远大于本运行时内存，在这里把对象读进变量会**废掉整条写入管线**。

**第六次变异测试：5 个安全关键缺陷全部被抓到**（跳过分享密码校验、完全不校验令牌、创建时允许空密码、创建接口去掉登录要求、元数据泄露完整路径）。

**票 `10` 的判定层已完成**：令牌用 **24 随机字节生成、从不派生**（派生自对象键或计数器的令牌，会让拿到一个链接的人枚举出其余全部）；**取消与过期分别记录**，因为两者把运维引向不同结论；**取消优先于过期**判定；**过期时刻本身即视为过期**（只在那微秒有效的链接，就是活得比它声称的窗口更久）。

**第五次变异测试抓出了我自己两个测试缺陷**：注入 8 个缺陷，**首轮只抓到 6 个**。
- 一个逃逸经**实测**证明：**校验环节的空密码检查根本不是安全边界**——PBKDF2 把空串哈希成一个任何真实密码都不会产生的值，所以"提交空密码"无法匹配任何真实密码。它只是快速路径。**真正的边界在创建时**：空密码会造出一个"界面显示已保护、实际对任何人敞开"的分享。
- 另一个是**真正的弱断言**：它只断言空密码"会产生某个问题"，而移除具体检查后**照样会产生问题**——只是错误信息变成了"至少 4 个字符"，而不是"密码可以留空"。**运维会去加字符，而不是发现密码本可省略。错的解释会把人引向修错的地方。** 现已改为**断言消息内容**。

**票 `07` 的策略（准入判定 + 淘汰选择）已完成**：`src/budget.ts` 是纯逻辑、不碰存储。**`/api/usage` 现在从同一个函数取总数，而不是自己再算一遍**——两处独立计算同一个总数，正是"界面上的数字"和"策略实际依据的数字"产生分歧的方式，而错的那个在越过上限之前一直不可见。

> ⚠️ **`/api/usage` 现在会 JOIN `object_flags`**，所以**未应用 `0003` 迁移时会直接报错**。这与"必须先应用迁移"是同一件事的两个后果，但值得知道：迁移未应用时，用量页不是显示为 0，而是报错。

**第四次变异测试**：向 `src/budget.ts` 注入 6 个故意缺陷，**5 个被抓到**。第 6 个（把"放得下"判断从 `<=` 改成 `<`）经查**是行为等价的、不可能被抓到**——淘汰路径因为"需要腾出 0 字节"而同样接受该情况。**但这次追查挖出了它下面真正的隐患**：淘汰路径本可能为了腾出 0 字节而删除对象；现已加显式守卫使其不可能发生。**我自己的测试算术错了两次**（两个 fixture 实际上并不需要淘汰，却断言了正确结论——对的答案、错的理由），均已修正。

**票 `06` 的核心（有界内存流式写入）已完成且不依赖被阻塞的测量**——阈值是**注入参数**，所以 `04` 的结论到位后是**改配置而不是重写代码**。峰值内存是**实测**的（测试源流会记录"已交出但未被释放"的字节数），不是"看代码觉得应该没问题"。

**第三次变异测试**：向 `src/store.ts` 注入 5 个故意缺陷，**4 个被抓到**。第 5 个（移除废弃分片上传的清理）**没被抓到**，经直接探针确认原因是**本地存储模拟器完全不可见未完成的分片上传**（`list()` 不列出、`get()` 返回 null），所以"清理了"和"没清理"在本地无法区分。**该缺口已写进代码注释和测试注释，而不是含糊过去**；要验证它需要真实 bucket。

**已完成的引擎已用你的八个真实文件验证（只读，未上传任何东西）**：8 个来源、32,742 字节 → 96 条原始条目 → **68 条唯一**，输出可重新解析，**把来源顺序反转后输出逐字节相同**。另做**变异测试**：向引擎注入 4 个故意缺陷，4 个全部被测试抓到 —— 证明测试不是空转的。

**frontier 现在是 `04`**（依赖 `03`，已完成）。`04` 是**测量票**，必须真机跑 —— 结论决定 `05`/`06` 的分片参数，**不可跳过**。

**本轮测试抓出的真实缺陷（都是测试而非阅读代码发现的）**：迁移分割器先切后删注释导致注释正文被当 SQL 执行；`ALTER TABLE ADD COLUMN` 不可重复；限流计数全局化导致可被用来锁死管理员；会话秒级时间戳自毁；**`rulesForHost` 按 `is_exclude` 升序排序，与自身注释相反，使排除规则完全失效**。另有配置缺陷：`.dev.vars` 残留已删除探针路由的 `PROBE_*` 凭据，已清除。
产物：`.scratch/vps-file-hub/spec.md`（**79 条**用户故事）+ `.scratch/vps-file-hub/issues/01..13`（**13 张**垂直切片工单，全部 `ready-for-agent`，共约 147 条验收标准）+ `docs/adr/0003`。
校验：编号 `01–13` 连续无重复；**所有 `Blocked by:` 边都指向更早且存在的票**（无环、无悬挂）；票内无文件路径、无代码块。

**frontier（可立即开工的票）= 只有 `01`**（无阻塞前置，且是其余全部的前置）。`04` 之后分成 `06`/`07`/`10` 三条并行支线，`07` 收敛回 `08`，`08`+`09` 再汇入 `12`（派生对象），最后 `13`。

**2026-10-07 追加的三条用户需求（已折进 spec 与工单，事件 e039）**：
1. **首次访问自设密码**（票 `02` 已改写）：不再是"派生一个 token 让你保存"，而是首访设密码、之后用它登录；**改密码必须结束所有已存在会话**。**仍不新增部署 secret**（只存加盐慢哈希；会话与定时触发凭据从既有主密钥派生）。
2. **分享链接**（票 `10` 已改写并改名 `10-sharing-links.md`）：选文件 → 设有效期 → 可选密码 → 收件人凭链接+密码直接下载；可列出与撤销已发出的分享。
3. **派生对象 / 合并规则**（新增票 `12`、`13` + **ADR-0003**）：把多个已存对象按配置合并成一个新对象。**拒绝执行用户脚本**——该 isolate 握着全部主机凭据与主密钥，沙箱逃逸的后果是全部机器沦陷；本项目已有一次"临时诊断端点变成真实暴露面"的先例。改为**声明式配置**（来源 / 顺序 / 组合方式 / 输出名），代价是表达不出的变换做不了，**补救方式是新增有界算子，而不是开一个执行口子**。

**⚠️ 并发会话现状（2026-10-07，需下一个会话知道）**：另一会话已提交 `75b94d0`（**主机凭据的"密码 / 密钥"二选一**，以及让失败不再静默）并推送到 `main`。**它实现的是主机认证方式选择，不是界面鉴权**——已实测：`/api/hosts`、`/api/rules`、`/api/usage`、`/api/status` 全部**无凭据返回 200**，首页无登录入口。**故 D35 仍然敞开，票 `02` 仍然必要且是最高风险项。** 另：`BRANCHES.md` 有它未提交的改动，我未触碰。

**`to-tickets` 过程中的两处判断需记录**：
1. 用户要求把 **100 MB 实测提到采集之前**（避免按未验证假设建存储路径），因此多出第 `04` 票，并把顺序改为 `01→02→03→04→05` 之后才分叉。**第 `04` 票含一条硬性自我清理要求：测量端点必须鉴权，且必须在本票内删除**——上一次诊断端点因存活过久变成了真实暴露面，这条是防它重演。
2. 用户选择**只保留 1 个测试接缝（HTTP 边缘）**；为不因此丢掉可测性，假远端放在 `env` 的**测试专用绑定**里（见第 `01` 票）。**若有人想把它提升为生产接口，那是偏离该决定，需重开。**

## 已完成（产物 + 证据）

- [x] **第 0 步 setup** → `docs/agents/issue-tracker.md`（本地 markdown）、`docs/agents/triage-labels.md`（默认五角色；`triage` 已安装故本节成立）、`docs/agents/domain.md`（单上下文）、根 `AGENTS.md` 的 `## Agent skills` 块。依据：`~/.agents/skills/setup-matt-pocock-skills/SKILL.md`。
- [x] **仓库初始化** → `git init`（`main`），初始提交 `c9af21c` 含本续接卡与登记簿。依据：`git log --oneline`。
- [x] **远端建立并推送** → `origin` = `git@github.com:medicagooo/LinkBin.git`（**PUBLIC**，默认分支已为 `main`）。`origin/main` = `cf8c415`，与本地一致、无分歧，普通 fast-forward 推送、无需强制。依据：`git ls-remote origin`、`gh repo view`、`gh api .../git/trees/main?recursive=1`（远端树 14 个 blob 全部就位）。
- [x] **工具链核实** → 36 个 skill 目录（mattpocock 27 + 腾讯 RTC 9）均含 `SKILL.md`；`git` 2.56 / `gh` 2.102（账号 `medicagooo`，SSH 协议，含 `repo` scope）在 PATH；**Node/pnpm/Python 不在 PATH**（须用 DSH 自带运行时）；无 Docker。
- [x] **网络环境核实** → `web_fetch` 在本机**不可用**：公网域名（含 `example.com`、`developers.cloudflare.com`）解析到非公网 TUN 地址 `198.18.0.203`，请求在发出前即被拒绝。**但这不是断网**——已验证可用替代路径：用 `Invoke-WebRequest` 抓文档页的 **`.md` 变体**（`<path>/index.md`）可拿到干净 Markdown 与 `dateModified`。`web_search` 亦可用但只返回来源与摘要。故平台限值必须显式标注"未核实"。**更正**：此前记为本机"完全无法访问网络"不准确，现已修正。
- [x] **架构因果核实** → Cloudflare Workers 无长驻进程、不能主动建 SSH/SFTP 长连接，故"worker 拉取 vps"在实现上必须变为 **VPS 侧 agent 主动推送**（协议层必然，非文档依赖）。**⚠️ 此条结论已被 D14 修正**：用户选择 Worker 直连 SSH，采集方向回到"Worker 主动拉取"；协议层事实不变（无官方 SSH 客户端），风险改由 `prototype` 前置承担。
- [x] **第 1 步 grill（第 1–2 轮，未完）** → `GLOSSARY.md`（已建，含"非关系数据库"术语退役）、`docs/adr/0001-d1-for-metadata-r2-for-bytes.md`、`docs/adr/0002-chunked-ingest-multipart-state-in-d1.md`；锁定 D14–D20。
- [x] **工具链可运行性（子 agent 实证）** → Node v24.21.0 / pnpm 11.7.0 可用；**npm 不存在**；wrangler **4.147.0 实测运行**；本地 D1+R2 仿真完整可用（含 R2 分片与范围读）；`@cloudflare/vitest-plugin` 提供全离线 TDD。→ D19、D20。
- [x] **分叉 A · 真机验证 —— ✅ PASS（2026-10-07）** → 在真实主机上跑通完整链路，**证据见下**。**原型闸门已解除，可以进入第 3 步。**
- [x] **探针残留清理（2026-10-07，事件 e025）** → 删除了线上唯一的主机行（`probe2` = `root@<test-host, configured dashboard-side>`，含加密密码）、探针规则与 3 个 R2 对象。**理由**：`/probe*` 无鉴权且会回退到"第一个已启用且带凭据的主机"，于是"无鉴权 UI + 表内存着 root 凭据 + 无鉴权 probe 路由"三者叠加，使公网任何人可 `GET /probe/read?path=…` 以 root 读走该机任意文件并写入 R2——**这是当时真实存在的暴露面**。复核：`GET /api/hosts` 与 `GET /api/rules` 均返回 0。**D30 提醒仍然有效：该机 root 密码进过会话记录，建议轮换。**
- [ ] 第 3 步 to-spec → `.scratch/vps-file-hub/spec.md`

### 原型判定证据（PASS，2026-10-07）

**判定标准（事先立下，未事后放宽）**：`/list` 返回真实条目 **且** SHA-256 与主机侧独立算出的值一致 **且** CPU 时间远低于 Paid 默认 30 秒。→ **三条全部满足。**

实测（部署于 `https://linkbin.cyc-xiaochen.workers.dev`，目标为真实远端主机）：

| 阶段 | 实测耗时 |
|---|---|
| ssh connect + auth | **288–294 ms** |
| sftp list `/etc` | 202 ms（83 个条目） |
| sftp readFile | 214 ms |
| sha256（WebCrypto） | **< 1 ms** |
| r2 put | 217 ms |
| **单文件端到端墙钟** | **约 1.4 s** |

逐字节一致性验证（主机侧用 `sha256sum` **独立**计算，与 Worker 读到的字节比对）：

| 路径 | 字节数 | SHA-256 | 一致 |
|---|---|---|---|
| `/etc/hostname` | 24 | `716ef502a4f9c936c9bb4c40ca4c22702e1e73395cd3efa3ae4f79c20ae118f8` | ✅ |
| `/etc/alpine-release` | 7 | `3965b079ccdfb959e8230ad246ad1342c9ad152d1938c07a017c3ff93c60f3e5` | ✅ |
| `/etc/passwd` | 1226 | `a3d2bef4b2fcda5c3e53341026f5e017f11075faa86808a68d8063bac4ddda6d` | ✅ |

R2 侧核实：`linkbin-files` 中存在 `probe/etc/hostname`(24)、`probe/etc/alpine-release`(7)、`probe/etc/passwd`(1226)，**大小与读取字节数一一相符**。

**因此 D24 记录的 CPU 风险不成立**：握手仅耗 0.29 秒，相对 Paid 套餐 30 秒上限有约 100 倍余量。D14 所选采集通道**可行**。

**加密边界同时得到验证**：直接查询 D1 显示 `password_enc` 为 `v1.<12字节base64 IV>.<密文>`（60 字符），**库中无任何明文**。

## 已锁定决策（不可回退 / 改动需重开）

- **D1 技术栈**：后端跑在 **Cloudflare Workers**；**D1** 存元数据；**R2** 存文件本体。理由：用户 2026-10-07 明确指定。影响：全部票。
- **D2 术语更正（与原始想法冲突，已确认）**：原始想法说"非关系数据库"，但 **D1 基于 SQLite，是关系型**。用户知悉后仍选定 D1。→ **此后所有产物禁止再用"非关系数据库"描述本项目存储**，须表述为"元数据存 D1（SQLite），文件本体存 R2 对象存储"。影响：GLOSSARY、spec、全部票。*（§2.2 要求显式指出冲突，此处已指出并记录；正式 ADR 待第 1 步落盘。）*
- **D3 ⚠️ 已被 D14 取代（2026-10-07，第二轮拷问）**：原决策为"VPS 侧 agent 主动推送 → Worker ingest API"。用户明确否决："本项目不安装到 vps 侧"。**保留此条仅为记录沿革，任何后续产物不得再据此设计。** 取代者见 D14。
- **D4 同步语义**：**定时增量同步 + 内容哈希去重，只推新增/变更文件**。理由：省带宽、天然幂等、可重跑。（用户选定）
- **D5 无事务约束（已被研究证实并细化）**：D1 官方文档措辞为 **"D1 operates in auto-commit"**；唯一有文档保证的原子单元是单次 `db.batch()`（"Batched statements are SQL transactions… aborts or rolls back the entire sequence"）。**`BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` 在 D1 文档中零命中，`D1Database` 也不暴露事务 API**。故：多步摄取状态迁移（created → parts uploaded → completed → verified）必须是**幂等 + 条件写 + 可续跑 + 补偿清理**，不得假设原子性。依据：[docs/research/cloudflare-platform-limits.md](docs/research/cloudflare-platform-limits.md) §7。
- **D6 授权边界**：可写代码 / 可本地提交 / **可推 PR 到远端**；**不可部署 VPS**。AI 不得自行认定已获部署授权。
- **D7 流程纪律**：S1 链路，第 1–3 步不断上下文；每步结束更新本文件。
- **D8 摄取必须分片，且分片状态必须在 Worker 之外**：Workers 入站请求体上限由**zone 套餐**决定（Free/Pro **100 MB**、Business 200 MB、Enterprise 最高 5 GB），而 Worker 每 isolate 只有 **128 MB 内存**——"边缘收下了 100 MB" ≠ "能缓冲 100 MB"。Cloudflare 明确写着 multipart 的 `uploadId` 与已传分片状态 **"needs to be kept track of somewhere outside of the Worker"**。→ **分片状态入 D1 是第一天就要定的 schema 决策，不是后续优化**。参数：分片 **≥5 MiB**（末片除外）、≤10,000 片、单片 ≤5 GiB、对象 ≤4.995 TiB。依据：研究 §1、§4、§5、§11.1–11.2。
- **D9 下载走流式返回 R2 对象，不经过 Worker 内存**：把 `R2ObjectBody.body`（`ReadableStream`）直接作为 `Response` body 是官方文档模式；**响应体无强制大小上限**，HTTP 触发的 Worker 在客户端保持连接期间**无墙钟上限**，且 **R2 出网免费**。范围读（`{offset,length}` / `{suffix}`）支撑断点续传。依据：研究 §5、§11.5。
- **D10 并发预算是硬约束**：**每次调用最多 6 个同时在途连接**，该上限由 `fetch()`、`connect()`、R2 读写、KV、Queues、Cache、出站 WebSocket **共享**（D1 连接同样计入）。→ 扇出与批处理必须按 6 设计，不能按"想开多少开多少"。依据：研究 §11 末尾。
- **D11 预签名 URL 的三个硬边界**：有效期上限 **7 天**、**不能用于自定义域名**（仅 `<ACCOUNT_ID>.r2.cloudflarestorage.com`）、是**不可撤销的 bearer token**（无 IP 绑定、无单次语义）。若消费端要自定义域名下载，官方替代路径是公开 bucket + WAF/Access，且 `r2.dev` 被官方明确降级为**非生产**。→ 消费端下载方案在 Q4 中必须在这两条路里选。依据：研究 §9、§11.6–11.7。
- **D12 读己之写必须显式换取一致性**：D1 副本 "may be arbitrarily out of date"，只有在 `withSession()` 内才有顺序一致性，bookmark 需跨请求传递（官方示例用 `x-d1-bookmark` 头）。→ 消费端读取刚写入的元数据时必须用 `withSession("first-primary")` 或传 bookmark。依据：研究 §7、§11.10。
- **D13 调度是分钟级、UTC-only、弱投递**：五字段 UTC cron，最小粒度 1 分钟；**Free 每账号仅 5 个 Cron Trigger**（Paid 250）；配置变更最多 15 分钟生效；单次 cron 调用墙钟上限 15 分钟、Free CPU 10 ms。→ **触发式对账必须可跨调用续跑，且不得假设"某一分钟不会被跳过"**。依据：研究 §3、§11.8。
- **D14 采集通道 = Worker 直连 SSH（用户 2026-10-07 选定，含原型前置）**：不向 VPS 安装任何组件，由 Worker 通过 `cloudflare:sockets` 的原始 TCP 发起 SSH 连接去拉取文件。**已被明确告知的风险**：Workers 无 shell / 无子进程 / 无长驻进程；官方只有 TCP+TLS 传输层原语，**没有任何 SSH/SFTP 客户端实现或示例**；该路径**无法在本机离线验证**（不同于 D1/R2 可完整本地仿真）。用户知情后仍选定，并同意**先插入 `prototype` 叠加项验证**（§2.3）。**在原型给出可运行答案之前，不得进入第 3 步 `to-spec`。** 影响：全部票；另需确认 D15。
- **D15 密码语义（第一步）**：文件在 R2 中为明文，密码**仅在下载时校验**，作为独立于下载授权的一道访问控制。**真正加密存储（无密码者即使拿到 R2 也解不开）明确列为后续独立票**，因密钥管理做错的危害大于不做。
- **D16 网页前端**：与 Worker **同源托管**（Cloudflare 静态资源 + API），范围限死为——配置 Host 与 Source Rule、手动触发采集、查看采集回执与错误、浏览与搜索元数据、取下载链接、测试下载。**明确排除**用户名/权限分级/审计日志。
- **D17 分片阈值**：单文件 **>25 MB** 走 R2 分片上传（≥5 MiB/片），**不压缩**。理由：100 MB 是 Free/Pro 的请求体上限，25 MB 留 4 倍余量避开 413；压缩会破坏逐字节校验与"消费端直接下载"。
- **D18 初始化与认证**：项目需支持显式初始化命令以创建 R2/D1（用户选定 D1 **Paid** 套餐）。**wrangler 首次认证由用户本人完成**（浏览器登入，AI 无法代劳）。建 bucket/database 属云资源变更，**执行前必须单独确认目标与影响**。
- **D19 本机工具链已实测可用（子 agent 实证，非推断）**：打包 Node **v24.21.0**、pnpm **11.7.0**；**npm 不存在**（node bin 目录只有 `node.exe`，`npm-cli.js` 缺失，故 `npx` 不可用，须用 `pnpm dlx`/`pnpm exec`）；**wrangler 4.147.0 已实际运行成功**。**关键坑**：直接 `pnpm dlx wrangler` 会以 `'node' is not recognized` 失败——必须先 `$env:PATH = "<node bin 目录>;$env:PATH"`（仅对子进程生效，不改系统 PATH）。**本地 D1+R2 可完整仿真**：`wrangler dev` 默认本地绑定，D1 CRUD、JSON1、FTS5、R2 范围读与**完整分片上传**均本地通过，**零真实 Cloudflare 资源**。测试用 `@cloudflare/vitest-plugin`（**已由 `@cloudflare/vitest-pool-workers` 更名而来**，API 不变），需 Vitest ≥4.1，全本地离线。
- **D20 本地 D1 与生产的差异（实测发现，必须写进代码约束）**：本地 D1 是**函数白名单化**的 SQLite——`sqlite_version()`、`PRAGMA journal_mode`、`BEGIN` 均被拒（`SQLITE_AUTH` / `not authorized`）。**代码不得依赖 `sqlite_version()`、`PRAGMA` 或任何 `BEGIN`/`SAVEPOINT`。** 另实证：失败时 `db.batch()` **确实整体回滚**（2 条语句失败后行数为 1）——这是 D5 在真实运行时的确认，而非文档推断。
- **D21 SSH 实现路径：不得使用 `ssh2`（子 agent 一手取证）**。`ssh2` 在 workerd 下**导入即失败**：它在模块初始化时无条件编译 poly1305 WASM，而 workerd 禁止运行时 WASM 编译 → `CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder`（[mscdex/ssh2#1494](https://github.com/mscdex/ssh2/issues/1494)，**仍 open**，2026-04-22，0 评论；报告者只能靠下游打补丁绕过）。且上游维护者已明确关门：[#1401](https://github.com/mscdex/ssh2/issues/1401) 原话 **"I'm not really interested in supporting a non-node socket API."**。社区在 [#1371](https://github.com/mscdex/ssh2/issues/1371) 的最终结论是 "i will try with container then"。**后果：任何以 `ssh2`/`ssh2-sftp-client`/`node-ssh` 为基础的方案一律否决。**
- **D22 采用 Workers 原生纯 TS SSH 栈**。已知唯一"声明支持 Workers 且以可读源码自证"的库是 **`edgeport` 1.0.6**（MIT，2026-08-24，仅 2 个依赖 `@noble/ciphers`+`bcrypt-pbkdf`、无 Node 内建依赖；`src/core/socket.ts` 直接 import `cloudflare:sockets`；其测试经 `@cloudflare/vitest-pool-workers` **在 workerd 内**对真实 Dockerized OpenSSH/Dropbear 跑通密码认证、ed25519 公钥、强制 AES-GCM、SFTP-over-same-session）。另有 4 个独立应用级纯 `crypto.subtle` 实现可作参考（CloudSSH 385★、EdgeSSH 119★、CF-Workers-WebSSH 70★）。**成熟度风险已明确**：edgeport 仅 9 star、月下载约 2.8k、仓库约 3 个月新、单一维护者、**无任何生产使用证据**。故 D22 为**原型候选**而非已定终局——原型必须一并评估其可用性。
- **D23 WASM 与密码学硬约束**。`WebAssembly.instantiate()` 在 Workers **只支持预编译模块**，运行时编译被禁 → **任何依赖运行时 WASM 的库都不可用**。WebCrypto **已有**主流 SSH 套件所需的全部原语：X25519 `deriveBits`、Ed25519/ECDSA/RSA-SHA2 验签、**AES-GCM / AES-CTR**、HMAC-SHA2。**缺 ChaCha20-Poly1305**（需由 `@noble/ciphers` 纯 JS 组装）。`node:crypto` 的流式 AEAD 序列（`createDecipheriv('aes-*-gcm')` → `update` → `setAuthTag` → `final`）在 workerd 下抛 `Error: No auth tag provided`，**故 AEAD 一律走 `crypto.subtle`，不得走 `node:crypto`**。
- **D24 真实 CPU 预算风险（影响可行性）**。Workers CPU 上限：**Free 每次 HTTP 请求 10 ms**，**Paid 默认 30 s（可提至 5 min）**；内存 128 MB/isolate；"等待网络不计入 CPU"。**纯 JS ChaCha20-Poly1305 是最大 CPU 隐患**（edgeport 自己的 README 就此警告）。→ **必须协商 AES-GCM（WebCrypto 原生速度）**，并优先按已核实的目标测量握手 CPU。**含义：Free 套餐很可能连 SSH 握手都过不了——这是个需要用户确认的可行性前提。**
- **D25 6 连接上限的影响被高估，但有一处文档冲突**。官方措辞是"最多 6 个连接**同时等待响应头**"，且"**响应头到达后不再计入**"——SSH 服务端会立即发 banner，故等待窗口很短，**实际不太会咬人**。但 `tcp-sockets` 页另有"每个打开的 TCP socket 都计入可同时打开的最大连接数"的说法，两页**措辞冲突**，对**已建立的长会话**是否计数**标记为未核实**。
- **D26 会话生命周期需要 Durable Object**。在 DO 内创建并保持打开的 TCP socket 会让 DO 常驻内存并计费，**每连接最多 15 分钟**；15 分钟后 socket 不再保活（socket 本身继续工作）。所有严肃实现都把 SSH 会话放在 DO 里并用 alarm 重连。**这引入一个第 3 步必须处理的接缝，且与 D1 无事务约束叠加。**
- **D27 Cloudflare 官方无任何 SSH 客户端先例（取证结论）**。Workers 文档索引 `llms.txt`（541 行）对 `ssh`/`sftp` **零命中**；`cloudflare-docs`、`workers-sdk`、`workerd` 三个仓库检索均无"Worker 作为 SSH 客户端"的页面或示例；Cloudflare 博客无相关文章。唯一提及是 TCP sockets 页那句"包括 SSH 在内的应用层协议需要底层 TCP socket API"。**→ 本项目的 SSH 路径完全建立在第三方实现之上，无官方背书，需自担维护风险。**
- **D28 部署方式 = Cloudflare Workers Builds（GitHub 集成）**。用户要求"部署项目要先 push main，然后 worker 通过 github 来部署"。~~已核实事实：Workers Builds **必须先在 Cloudflare 仪表盘把仓库连上**，这一步 AI **无法完成，只有用户能做**（已核查：Cloudflare 未提供连接仓库的 CLI/API 路径）。~~ **⚠️ 2026-10-07 部分证伪，见 D46**：官方**确实有** Workers Builds REST API 可创建仓库连接与触发器；唯一人工步骤是**安装/授权 Cloudflare GitHub App**（需要在 GitHub 侧授权 OAuth，故 AI 无法代劳）。
- **D29 仓库公开 ⇒ 主机清单不外泄**。`wrangler.jsonc` 中 `PROBE_HOST`/`PROBE_USER` 留**占位符**，真实值走仪表盘的**加密变量**；`PROBE_PASSWORD` 为 secret。本地开发用 `.dev.vars`（已 gitignore）。**已扫描确认密码与 VPS IP 均不在跟踪树内。**
- **D30 测试目标与凭据卫生**。测试 VPS 由用户提供（`root@<test-host, configured dashboard-side>`，密码经对话给出）。**该密码已进入会话记录，而仓库为公开——实验结束后建议轮换该机 root 密码。** 实验对目标机**只读**。
- **D31 ✅ 资源可自动配置——更正我此前的一个错误结论**。我先前断言"D1 必须在部署前手工创建、`database_id` 是必填"。**这是错的。** 官方文档 [Workers configuration → Automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/)：`wrangler deploy` **可自动创建资源**，覆盖 **KV / R2 / D1** / Flagship / AI Search / Agent Memory / Dispatch Namespaces / Queues；用法是**在配置里写绑定但不写资源 ID**（R2 连 bucket 名也不写），资源以 Worker 名作前缀创建。**注意行为差异**：`wrangler dev` 自动建本地资源并持久化；`wrangler deploy` 建资源并**把 ID 写回配置文件**；但**从仪表盘部署（即 Workers Builds / GitHub 路径）会创建资源却不把 ID 写回仓库**，ID 只能在仪表盘看。→ 已照此改写 `wrangler.jsonc`：D1 绑定无 `database_id`、R2 绑定无 `bucket_name`。**用户口述正确，文档核实通过。**
- **D32 单一密钥 + 主机全为运行时数据（用户 2026-10-07 指定）**。部署侧**只存一个密钥** `SSH_MASTER_KEY`；**VPS 的地址、端口、密码/私钥全部经该密钥加密后存 D1**；主机与"要拉取的目录位置"都通过**网页前端在运行时添加**，加机器不需要重新部署。加密实现细节（勿简化）：**AES-GCM 256 位、WebCrypto**、每次加密用**全新随机 12 字节 IV**、**把 host id 与字段名作为 additionalData 绑定**（密文无法被搬到别的行或列）、**失败一律抛错**不回退。界面**永不接收凭据**，只接收**指纹**。**诚实边界**：同时拿到 D1 与 `SSH_MASTER_KEY` 者可解出全部凭据；本设计买到的是"**单库泄露无所得**"。
- **D33 目录规则的"统一 + 分开"用数据模型表达，不用优先级标志**。`source_rules.host_id` 为 `NULL` = **全局规则**（对所有主机生效）；非 NULL = **该主机专属**。收集时两者**并集**，且**排除先于包含求值**——因此"全局收 `/var/log/*.log`"+"某机排除 `/var/log/noisy.log`"的行为符合直觉，**无需引入覆盖/优先级语义**。
- **D34 无 CLI 的部署必须能自建表**。因部署走 Workers Builds（GitHub），发布物旁边**没有 CLI**，故 Worker 自带 `POST /api/admin/apply-schema`：把 `migrations/0001_init.sql` 作为 `Text` 模块导入（wrangler 默认把 `.sql` 映射为字符串），**用 `db.batch()` 分批应用**（D1 唯一有原子保证的单元），每条语句均为 `CREATE ... IF NOT EXISTS` 故**可重复执行**。**schema 因此只有一份真源**，CLI 路径与 Worker 路径共用同一文件。
- **D35 当前 UI 无鉴权（已知限制，必须显式处理）**。任何能访问 Worker 的人都能管理主机与加密凭据。**上线前必须置于 Cloudflare Access 之下或加入 API token**；在补上之前只能当私人工具用。此限制已写入 [README.md](README.md)。
- **D36 部署已实际执行，且走的是 CLI 路径而非 D28 的 Workers Builds（2026-10-07，用户明示授权）**。执行：`wrangler r2 bucket create linkbin-files` → `wrangler deploy --secrets-file .env.deploy` → `POST /api/admin/apply-schema`。产出：Worker **`linkbin`**，版本 `1c7a2112-eaaa-42bd-8768-fcfeb935b657`，`https://linkbin.cyc-xiaochen.workers.dev`；D1 **`linkbin-db`**（自动供给）；R2 **`linkbin-files`**；`masterKeySet=true`、`r2Bound=true`、schema ready（12 条语句 / 4 张表）。**这不推翻 D28**——D28 仍是既定的发布路径，事后可在仪表盘把仓库连到这个已存在的 Worker 上。**两条实测与文档不符，必须记录**：① 官方 changelog 称 CLI 部署会把资源 ID 回写配置文件，**实测未回写**（`git diff` 只有我自己的编辑），故仓库保持无账号资源 ID，符合用户要求；② 因此 `database_id` 只能从 `wrangler d1 list` 取，且 `wrangler d1 execute|migrations --remote` 在本仓库不可用（本仓库不需要，走 Worker 内 apply-schema）。
- **D37 用户对"部署"的授权已变更（2026-10-07）**。此前（D6/授权边界）为"可部署：否"。用户本次明确授权**部署本项目 Worker 到自己的 Cloudflare 账号**并已执行。**部署到任何 VPS 仍然明确不授权。** 另：用户知情并接受当前无鉴权 UI 的风险。
- **D38 资源命名与"不写死 ID"的落地方式（用户指定）**。`r2_buckets` 写死 `bucket_name: "linkbin-files"`——名字即 bucket 的身份，写死它使后续部署绑定同一个 bucket 而非另建一个；`d1_databases` 写死 `database_name: "linkbin-db"` 但**故意不写 `database_id`**。依据：官方 changelog 原话 "resources will stay linked across future deploys even without adding the resource IDs to the config file"（[Automatic resource provisioning, 2025-10-24](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)）。目的：公开仓库里不带账号相关资源 ID。**2026-10-07 双重验证通过**：① Workers Builds 首次构建（从 GitHub，非本机直传）重新部署时**没有另建 D1**，仍绑定同一个 `linkbin-db`；② ~~无 `database_id` 时 `wrangler d1 execute --remote` 不可用（依据 issue #13632）~~ **此条已证伪**——实测 `wrangler d1 execute linkbin-db --remote` **完全可用**，该 issue 的修复（PR #14275，2026-06-16 合并）已在 wrangler 4.147.0 中。故"没有 ID 就用不了 d1 子命令"的顾虑不成立。
- **D39 ✅ SSH 通道真机验证 PASS（2026-10-07）**。Worker 直连 SSH 的采集通道**已被真实主机证实可行**：握手 288–294 ms、SFTP 列目录 202 ms、读文件 214 ms、WebCrypto SHA-256 < 1 ms、R2 写入 217 ms，单文件端到端约 1.4 秒。三个文件（24/7/1226 字节）与主机侧 `sha256sum` **逐字节一致**。**D24 的 CPU 风险不成立**（约 100 倍余量）。证据表见本文件"原型判定证据"。
- **D40 算法偏好必须是数组，且不钉死单一密码套件**。`AlgorithmPrefs.cipher` 是 **`string[]`**；传裸字符串能通过打包（**构建无类型检查**）却在 KEXINIT 构造时抛 `TypeError: names.join is not a function`——**这个错只有真机能暴露**。现取 `['aes256-gcm@openssh.com','aes128-gcm@openssh.com','aes256-ctr','aes192-ctr','aes128-ctr']`：**GCM 优先（WebCrypto 原生速度）、CTR 兜底**（兼容不支持 GCM 的主机）、**明确排除 chacha20-poly1305**（纯 JS，CPU 隐患）。同时**错误响应现在带堆栈**，因为构建不做类型检查时，依赖的形状错误只能在运行时暴露，堆栈把猜测变成行号。
- **⚠️ D41 `/probe*` 是无鉴权的远程命令执行与任意文件读取入口（高危，必须显式处理）**。`src/index.ts` 的 probe 路由在**未鉴权**时可被任何人调用。若把 `PROBE_HOST`/`PROBE_USER`/`PROBE_PASSWORD` 设为变量，则**任何人**访问 `/probe/exec` 即可在目标机执行命令、访问 `/probe/read` 即可读取该机任意文件并写入 R2。**故一律不设置 `PROBE_*`**，探针只经"UI 添加主机 → 测完立即删除该行"驱动。**在补上鉴权（D35）之前，这条必须当作未修复的暴露面看待。**
- **D42 采集运行 = 带游标的预算式扫描（2026-10-07，用户接受）**。cron 与手动触发并存；每次调用按墙钟预算（建议 10 分钟，留 5 分钟余量）尽量多做，把游标（主机 + 路径）写入 D1，下次从游标续跑。目标新鲜度 **15–30 分钟**。理由：**50 台**（e030）× **单次 cron 墙钟上限 15 分钟**（D13）⇒ 一次调用不可能扫完；且 D13 已核实 cron 是**弱投递**（不能假设某一分钟不被跳过）⇒ **可续跑是设计前提，不是容错**。
- **D43 容量策略：自动淘汰 + 重要标记保护 + 满则拒收（2026-10-07，用户指定，覆盖了 agent 先前"永不删除"的建议）**。① **未标记"重要"的文件可被自动删除**，以腾出 10 GB 预算内的空间；② **带重要标记的文件永不删除**；③ **若仅重要文件即占满预算，则停止同步新文件**，而不是驱逐重要文件。→ 实现要求：`objects` 需要**重要标记位**；淘汰候选集必须限定"未被标记"；容量守卫在无未标记文件可淘汰时**拒绝新采集并写回执**。**与既有决定的衔接**：`migrations/0001_init.sql:49-52` 已定**版本历史不进 R2**（旧对象可回收），故"旧版本堆积占满"这条路已被堵住，10 GB 面对的主要是当前活跃文件。
- **D44 下载机制：Worker 签发短时效 token 并流式返回，而非 R2 预签名 URL（2026-10-07，⚠️ PROPOSED——待用户确认）**。用户要"自定义域名 + 2 小时 + 可选密码分享"。**已核实的硬事实**：预签名 URL **不能用于自定义域名**（D11 / 研究 §9.2，[来源](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)）。**故实现改为**：Worker 挂在自定义域名上，**自己签发 2 小时短期 token**，校验通过后流式返回 R2 对象（D9 已定流式返回）。**比预签名严格更好的两点**：**可撤销**（预签名不可撤销）、**能真正落实 D15 的密码校验**（预签名一旦发出就绕过密码这道门）。**代价**：下载占用 Worker 并发与墙钟。
- **D45 采集回执用两张表（2026-10-07，用户同意）**：`collection_runs`（一次运行一行：主机、起止、状态、计数）+ `collection_issues`（每个未成功处置一行：跳过/失败、原因）。理由：D1 单行 **2 MB** 上限排除 JSON 大列；拆行才能按主机/路径查询；每行独立写入符合 D5。**必须涵盖容量拒绝**——否则"这个文件为什么没同步"永远查不到答案。
- **D46 Workers Builds 有 REST API——D28 的"无 API 路径"结论被证伪（2026-10-07，实测）**。官方确有 Workers Builds REST API（[api-reference](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)，2026-09-22 更新），可**用 API 创建仓库连接与触发器**：`PUT /accounts/{id}/builds/repos/connections`、`POST /accounts/{id}/builds/triggers`、`GET /builds/tokens`、`PATCH /builds/triggers/{uuid}/environment_variables`、`POST /builds/triggers/{uuid}/builds`。**唯一无法自动化的一步**是**安装/授权 Cloudflare GitHub App**（需要在 GitHub 侧完成 OAuth 授权）——文档原话："This one-time setup creates the connection between your GitHub account and Cloudflare. **Once complete, you can use the API for everything else.**" **凭据要求（实测，不是文档推断）**：需 **user-scoped** API token，权限 `Workers Builds Configuration: Edit`（+`Workers Scripts: Read`）；**当前 wrangler OAuth token 权限不足**——`GET /builds/tokens` 与 `GET /builds/repos/connections` 实测均返回 **403 / code 10000 Authentication error**；文档另明确 account-scoped token 会报 "Invalid token"，必须 user-scoped。**D28 中仍然有效的部分**：production 分支触发 `deploy` 命令（默认 `npx wrangler deploy`），非 production 分支触发 preview build（`wrangler preview`）；**push 到 main 本身不触发部署，"连仓库"才是开关**；Workers Builds **不读** `wrangler.jsonc` 的 Custom Builds 配置；Worker 已在仓库根，故 Root directory 可留空。**API 调用需要一个不可变的 Worker tag**（非名字），用 `GET /accounts/{id}/workers/scripts` 取；按 D38 的精神**该 tag 不写入本公开仓库**。
- **D47 部署不执行迁移——每次新增 migration 后必须手动应用（2026-10-07，实测踩到）**。`git push` → Workers Builds 跑 `npx wrangler deploy`，**只上传代码，不碰 `migrations/`**。所以 `0002_usage_index.sql` 随 `52edd51` 进了仓库、也随构建上了线，但**从未应用到生产库**，直到手动 `POST /api/admin/apply-schema` 才补上。**表现不是报错而是"UI 卡在 setup 面板"**：`src/ui.ts:378` 用 `status.schema.ready` 决定是否显示建表面板，而自检（`src/index.ts:160-165`）把 `idx_objects_usage` 也列进了必需清单 → `ready=false`。**这不是疏忽而是 D34 的结构性代价**（Workers Builds 旁边没有 CLI，才需要 Worker 自带建表路由）。**尚未缓解**，可考虑的方向：在 README 的部署步骤里把它写成显式第 4 步的强制项，或让 Worker 在自检失败时于 UI 顶部给出显式提示。
- **D48 主机表单改为认证方式二选一，并修掉"点了没反应"（2026-10-07，用户要求）**。表单现在显式选择 **用户名+密码** 或 **用户名+私钥（口令可选）**，只显示并只提交所选方式；用户名两种模式都保留（SSH 必须有用户名，服务端也强制要求）。**Bug 根因（实测定位，非猜测）**：`src/ui.ts` 里 **10 处 API 调用全部没有 `.catch()`**——`fetch` 一旦 reject（连接中断、Worker 正在重新部署），promise 静默失败，**页面上一个字都不显示**；即使服务端返回 4xx/5xx，反馈也只写到页面下方的 `#result` 面板，表单本身毫无变化，从操作者视角就是"没反应"。**修法**：`api()` 统一加 `.catch()` 与 30 秒超时（`AbortController`，不可用时优雅降级），把拒绝/超时/HTTP 失败归一成同一形状；保存路径增加客户端校验并**把结果与原始错误显示在按钮正下方**；失败不再静默。**排查中同时确认服务端无问题**：本地与生产用**完全相同的 payload** 提交均返回 200，生产库 `hosts` 表结构与迁移逐字一致——问题纯粹在客户端。
- **D49 `check-ui-template.mjs` 的守护有漏洞，已补（2026-10-07，自捕获）**。我在 `<script>` 的**注释里写了反引号**，而整个 HTML 是一个模板字面量——**模板内部 `//` 不是注释，只是普通文本**，那两个反引号提前终止了字面量。**guard 没抓到**：它扫描前会 `line.replace(/\/\/.*$/, '')` 剥掉行注释，**在模板内部这样剥是错的**，连反引号一起忽略了。**更糟的是构建通过了**——截断后语法仍合法，`wrangler deploy --dry-run` 退出码 0，直到运行时才抛 `TypeError`，且错误里的标识符是碎片拼成的（`localeencodeURIComponent(...)STYLES...`），极难定位。**修法**：新增一条**绝对规则**（非启发式）——`<script>` 与 `</script>` 之间**禁止任何反引号**，因为那段文本原样输出且内部脚本自身不用模板字面量（实测该区域反引号数为 0）。已用**受控回归测试**验证：注入反引号 → 报错并指名行号；还原 → 通过。**教训**：这个 guard 是启发式的、不是解析器；真正的判据是"页面能否渲染"，所以改动 UI 后必须实际 `GET /` 一次，而不是只看构建退出码。
## 未决问题（阻塞项）

**开放问题必须在第 1 步 `grill-with-docs` 中全部关闭；有任何问题悬着就不得进 `to-spec`（§2.2 判据）。**

- **Q1 ✅ 已解决（2026-10-07，事件 e031）** 原问"VPS 侧 agent 的形态"**已因 D14 作废**——不在主机上装任何东西，语言/安装/常驻三问不存在。**替代问题（触发与运行边界）已定 → D42**：cron 与手动并存；一次运行 = 带游标的预算式扫描；新鲜度 15–30 分钟。
- **Q2 ✅ 已解决（2026-10-07，事件 e031）** 原问"agent 侧分片取舍"**已因 D14 作废**——没有 agent，分片由 Worker 自己写 R2 multipart（D8/D17 已定参数）。**替代问题（10 GB 满了怎么办）已由用户决定 → D43**：自动删除旧文件；**重要标记的文件永不删除**；仅重要文件占满则**停止同步新文件**。**agent 先前"永不自动删除"的建议已被用户明确否决。**
- **Q3 ✅ 已解决（2026-10-07，事件 e031）** 回执数据模型 → **D45**：新增 `collection_runs` + `collection_issues` 两张表。不用 JSON 列的理由是 D1 单行 2 MB 上限；每行独立写入符合 D5。**跳过与失败必须可见**——在 D43 定了"容量拒绝"之后，拒绝本身就是必须留痕的回执。
- **Q4 ✅ 已解决（2026-10-07，事件 e035）** 用户已确认 **D44**：下载走 **Worker 自签短期 token + 流式返回**，而非 R2 预签名 URL（预签名不能配自定义域名，且不可撤销、会绕过 D15 的密码校验）。**Q1–Q7 至此全部关闭。**

## ⏳ 待用户统一确认的生产动作与阻塞（2026-10-07 更新）

### ✅ 已解除：鉴权已生效（本轮实测确认）

线上实测：`/api/hosts`、`/api/rules`、`/api/usage`、`/api/shares` **无凭据一律 401**。**接口密码已设置，门已经锁上**，此前"任何人抢先首次访问即可接管界面"的风险**不再存在**。

### A. 唯一待授权的生产动作：应用 `0003` 迁移

线上 `schema.ready = false`。**这就是本轮修掉的两个缺陷的成因**：`/api/status` 少报缺失对象；`/s/<token>` 直接 500 并**把堆栈和 SQL 回给了匿名调用者**。两者都已修好并推送，但**线上数据表仍需你授权才能创建**（应用迁移 = 改变生产状态）。

- 动作：`POST /api/admin/apply-schema`（幂等，只建表与索引，不读数据）
- 影响：创建 `collection_runs` / `collection_issues` / `object_sources` / `object_flags` / `auth_secret` / `auth_attempts` / `shares` 及索引
- 不做的后果：分享链接、用量页、以及后续所有票都无法工作
- **它当前是公开路由**（因为全新部署必须先建表才能存密码）。**本次应用之后可以考虑把它移到会话之后**——但那会让全新部署无法自助初始化，需要重新设计引导路径。

### B. 阻塞票 `04` 的事项 —— 需要真机与凭据

票 `04` 是**测量票**：实测大文件吞吐，结论决定 `05`/`06` 的分片与单文件上限。**它无法靠读代码或本地测试完成**，原因有二：

- **本地无法连 SSH**：`cloudflare:sockets` 在本地开发环境拒绝连往私有地址，所以 `wrangler dev` 永远测不到真机。
- **本地测出来也没意义**：要验证的是 **Worker 运行时**的墙钟上限（单次调用 15 分钟）、128 MB 内存上限与边缘带宽，这些与我的机器无关。

已核实的结构性风险（**未实测，故标记为 unverified**）：SFTP 读是**固定 32 KiB 分片、严格串行、无 range/无 abort**，因此 100 MB ≈ **3200 个往返**。原型阶段实测的是 24 B / 7 B / 1226 B 三个小文件（ssh 连接+认证 288–294 ms、list 202 ms、readFile 214 ms、R2 put 217 ms、端到端约 1.4 s/文件），**这些数字不能外推到 100 MB**。

**需要你提供或确认**：

1. **在哪台主机上放一个 100 MB 测试文件**（或者授权我在某台已登记主机上生成一个）。
2. **是否授权用 Worker 对它跑一次真实测量**（这会在生产 Worker 上产生一次真实连接与 R2 写入）。
3. **如果实测结果低于 100 MB**：单文件上限是**下调到实测可行值**，还是**保留 100 MB 并接受部分大文件会失败**（D26 的"一般 <100 MB"是假设，不是实测）。

**在拿到答复前，我停在票 `04` 之前**，不猜测、不跳过——`05` 的分片参数直接依赖这个结论。

### C. ✅ 已由我决定并实施：合并时按来源重命名条目（2026-10-08，事件 e057/e058）

**你连续多轮未答复，我按"唯一能复现你手工合并做法"的选项 1 实施了**，理由记录在事件 e057，可被推翻：

- 它**纯粹是增量的**：选项 2、3 仍然可用，本次实施**不排除**它们；
- 它是**有界的声明式算子**（字段 / 作用的键 / 可选的第二字段 / 分隔符 / 顺序 / 替换表），**仍在 ADR-0003 边界内**；
- 等待的成本已经超过了决定错了的成本。

**用你八个真实文件只读验证**：24 个分组、**3 个不同名字 → 24 个不同名字**；来源顺序反转后输出**逐字节相同**；**0 个代理节点被误改名**（作用域约束避免了 40 个节点名被弄坏）。

**过程中纠正了两个我自己的错误**（都记在事件 e058）：
1. 我先前判断"区分分组的字段"是**错的**——我写的是 `hysteria2`/`tuic5`/`vless-reality-vision` 等，那些是分组**内部的节点类型**，不是分组。读真实文件后确认区分字段是 **`type`**（`load-balance`/`url-test`/`select`），**恰好就是你那三个符号的含义**。
2. 第一版实现会重命名**所有**带该字段的条目，**包括 40 个代理节点**（它们的名字里本来就有服务商）——那会让 40 个名字变糟，**而且看起来像是规则生效了**。现在**作用域是必填项**：无法从数据推断，猜错是静默的。

### C-旧. 原问题（保留作沿革）

跑真实文件时量出来的能力缺口，**不是 bug，是声明式配置表达不出来的东西**：

你八个来源里的 `proxy-groups` 名字**全都是通用的**（`负载均衡`、`自动选择`、`🌍选择代理节点`），内容各不相同。引擎**没丢任何数据**（24 条进、24 条出），但你的手工合并版有 **27 条**，因为**你把每条按来源重命名了**（`⚖️ByteVirt 负载均衡`、`⚡DartNode 自动选择`……）——正是这个重命名让它们成为互不冲突、可用的分组。

**声明式规则目前表达不了「用来源名重写这个字段」。** 三条路：

1. **加一个有界算子**（推荐）：配置里写「把 `name` 用来源名重写」，于是 `bytevirt.yaml` 里的 `负载均衡` → `⚖️ByteVirt 负载均衡`。能复现你手工合并的结构，且仍在 ADR-0003 的边界内。
2. **按指定身份去重**：同名条目合并、冲突上报。分组变少，但会丢掉你想要的内容。
3. **保持现状**：要求来源文件自己起不同的名字。

**我不猜。** 其余合并逻辑已经完整可用。
- **Q5 ✅ 已解决** 平台硬限值已核实并落盘：`docs/research/cloudflare-platform-limits.md`（943 行、31 个唯一官方 URL、11 处显式"unverified"标注、11 节 Design implications）。**遗留未核实项 10 条**（真机 SFTP 可行性、cron 投递保证、Worker 内预签名等），需要时按该文件 §10 逐条处理，**禁止凭记忆补数字**。
- **Q6 ✅ 大部分已解决（2026-10-07）** 账号侧已核实：wrangler **4.147.0** 已安装，OAuth 登录态有效（账号 `cyc_xiaochen@outlook.com`，token 含 `workers:write`/`d1:write`/`k2.write`），**无需用户重新登入**。资源已就绪：D1 **`linkbin-db`**、R2 **`linkbin-files`**、Worker **`linkbin`**。**D1 的 database_id 故意不写入本仓库**（D38）——需要时用 `wrangler d1 list` 取。**遗留一项未核实**：该 D1 是 Free 还是 Paid 套餐（决定每调用 50 还是 1000 次查询）——未核实，需要时查仪表盘。
- **Q7 ✅ 已解决（2026-10-07，事件 e030）** 三条硬约束：**设备（主机）数量 ≤ 50**、**单文件 ≤ 100 MB**、**R2 总用量 ≤ 10 GB**。含义有三层：① 100 MB 与 e014 已记的"一般 <100 MB"一致，故**不需要按体积裁掉正常文件**；② **50 台**给"全量扫一遍"设了上界，而 D13 已核实单次 cron 调用墙钟上限 15 分钟 → 一次调用**不可能**扫完 50 台，"跨调用续跑"是**必需项而非优化**；③ **10 GB 是容量预算，不是单文件限制**——它要求系统自己**度量并约束总字节数**，进而强制产生两个此前不存在的设计问题：**淘汰/保留策略**，以及**被取代的旧版本对象是否继续占用 R2**。**当前 schema 与代码既不度量也不强制总字节数**（`objects` 表没有保留策略字段，也没有任何 GC 路径）。

## 授权边界

- 可写代码：**是**　可推 PR：**是**　可部署（本项目 Worker → 用户自己的 CF 账号）：**是（2026-10-07 起，见 D37）**　可部署到 VPS：**否**
- 其他约束：
  - **不部署到任何 VPS。** Cloudflare 线上资源（D1/R2/Worker）的创建与部署已于 2026-10-07 获用户明确授权并执行（D36）；此后的新增资源或破坏性操作**仍需单独说明目标与影响**。
  - 公开仓库内**不得出现账号相关资源 ID**（D38）。
  - `web_fetch` 不可用时**禁止凭记忆写平台限值**，一律标注"未核实"。
  - D1 无事务（D5）。
  - VPS 侧 agent 部署在本仓库控制之外的机器上，ingest API 一旦发布须保持向后兼容。

## 下一个动作（精确到可执行）

> **⚠️ 本节已重写（2026-10-07，事件 e035）。** 上一版写的是"在已上线的 Worker 上跑真机 SSH 探针"，
> 让下一个会话去调 `GET /probe/list` 与 `GET /probe/read`。**那两条路由在提交 `52edd51` 中已被删除，
> 现在返回 404**（探针结论是 PASS，代码已清）。照旧版执行会直接撞墙——这正是"冲突时信产物"要修的情形。

- **动作**：执行**第 5 步 `implement`**，**从票 `01` 开始**（它是 `02` 的前置，且自身无阻塞）。
  读 `C:\Users\medic\.agents\skills\implement\SKILL.md`：为票 `01` 实现，**内部驱动 `tdd`**（一次一个红-绿垂直切片），
  **以 `code-review` 双轴收尾**（Standards + Spec，两个并行子 agent），然后更新本文件。
  **票与票之间 `/clear`**——每票自包含（§2.7）。
- **前置**：✅ 满足——spec 已落盘；11 张工单已发布且阻塞边自洽；接缝已获用户确认。
- **验证方式**：该票的 acceptance criteria 逐条通过；`code-review` 双轴无阻塞项；本文件已更新。
- **注意**：**不要**对这些自制工单跑 `triage`（§2.6 明文禁止）。**不要**修改父 spec。
  **`01` 完成前不要开始 `02`**——`02` 是 `01` 的阻塞后继，`01` 建的是测试设施，后面每票都靠它。

### 已不再适用（保留作沿革）

- ~~跑真机 SSH 探针（`/probe/*`）~~ —— 已完成（D36 PASS）且路由已删除，**不要再调用**。
- ~~设置 `PROBE_HOST`/`PROBE_USER`/`PROBE_PASSWORD`~~ —— 绑定已从 `Env` 接口移除，设了也没有代码会读；这是好事，勿恢复。

## 环境硬事实（下一个会话直接用，不要重测）

| 项 | 值 |
|---|---|
| 项目根 | `D:\proj\LinkBin` |
| git 身份 | **本机全局与本地均未设置**；提交使用仓库本地身份 `DSH <dsh@local>`（可用 `git config user.name/user.email` 覆盖） |
| gh | 账号 `medicagooo`，SSH 协议，scope 含 `repo`/`workflow` |
| 远端 | `origin` = `git@github.com:medicagooo/LinkBin.git`，**PUBLIC**，默认分支 `main` |
| **已部署的 Worker** | `linkbin` → `https://linkbin.cyc-xiaochen.workers.dev`；版本 `1c7a2112-eaaa-42bd-8768-fcfeb935b657`；CF 账号 `f969e0e82bb0b477458e214ce501180c`（`cyc_xiaochen@outlook.com`） |
| 线上资源 | D1 `linkbin-db`；R2 `linkbin-files`；secret `SSH_MASTER_KEY`（值只在 `.env.deploy`，**git-ignored**） |
| wrangler | `D:\proj\LinkBin\node_modules\wrangler\bin\wrangler.js`（4.147.0）；OAuth 登录态在 `%APPDATA%\xdg.config\.wrangler\config\default.toml` |
| ⚠️ 探针红线 | **不要设置 `PROBE_*` 变量**（D39）；测完立即删除主机行 |
| **⚠️ 仓库为公开** | 任何推送内容全球可见。**凭据、VPS 主机清单、内网路径、`.dev.vars` 一律不得入库**（`.gitignore` 已兜底，但需人工复核）。摄取 API 鉴权（Q6 相关）因此是**必需项而非可选项** |
| skill 目录 | `C:\Users\medic\.agents\skills`（36 个） |
| DSH 运行时 | Node：`C:\Users\medic\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`；pnpm：同树 `pnpm\bin\pnpm.mjs`；Python：同树 `python\python.exe`（DSH 自带，**非**系统 Python） |
| 时区 | China Standard Time (+08:00) |

## 会话交接记录

| 时间 | agent/harness | 做了什么 | 留下的产物 |
|---|---|---|---|
| 2026-10-07 02:44 | DSH (deepseek-flash) | 按 §0.2 启动：扫盘确认空仓库 → §1 场景判定为 S1 → 用户确认场景与授权 → 用户改定 Cloudflare 架构（D1/R2）→ 完成第 0 步 setup + 仓库初始化 | `AGENTS.md`、`docs/agents/*.md`、`.scratch/vps-file-hub/STATE.md`、`BRANCHES.md`、`.branch-records/vps-file-hub/*` |
| 2026-10-07 03:20 | DSH (deepseek-flash) | 远端建立并推送（`origin` = `medicagooo/LinkBin`，PUBLIC）；research 子 agent 交付 31 个一手来源的平台限值并折回 D8–D13；修正"本机无法访问网络"的错误结论；修复两次因 `git add -A` 把临时脚本提交进公开 main 的问题（e013）并在 `.gitignore` 层面加白名单根治 | `docs/research/cloudflare-platform-limits.md`、D8–D13、`.gitignore` 白名单 |
| 2026-10-07 03:57 | DSH (deepseek-flash) | **首次真实部署**：确认 wrangler OAuth 可用 → 固定 `bucket_name`/`database_name`（不写死 ID）→ 建 R2 → 部署 Worker + secret → 应用 schema → 全链路核验。**纠正三处陈旧记录**：`state.json` 里已被 D14 取代的"VPS agent 推送"通道、"禁止改动线上 CF 资源"的授权、`ssh-probe` 的"永不合并 main" | D31–D39、`vps-file-hub/state.json` 重写、事件 e023–e024、`BRANCHES.md` C-001 |

## 本轮结束时的仓库状态

- **部署时的 main** = `3880cd5`（`feat: encrypted runtime host management, single-secret deployment`），已与 `origin/main` 一致。
- **本次会话新增的本地改动**（`wrangler.jsonc` 固定资源名、`STATE.md` 更正、登记簿事件与状态）：**已提交，未推送**（本轮未获推送授权）。
- 未入库的本地文件（均已核实被 `.gitignore` 覆盖）：`.env.deploy`（`SSH_MASTER_KEY`）、`.dev.vars`（含陈旧 `PROBE_*`，本次未使用）、`.dry-run/`、`.wrangler/`。
- 提交链（旧）：`c9af21c`（第 0 步 init）→ `cf8c415` → `0ae4c85` → `69048fc` → `4ab3a17`（research + D8–D13）→ `d23e033` → `52e77a4`（清理 + gitignore 根治）→ … → `729e5b8`（合并 prototype）→ `3880cd5`（加密主机管理）。
- **已知残留**：`4ab3a17` 与 `d23e033` 两个提交的历史里各含一个一次性脚本（`tmp-record.ps1`、`fix-tmp.ps1`），当前 tip 已不含它们。**不做 force-push 重写已发布 main**（未获授权，且会破坏已 fetch 者的默认分支）。已在 e013 记录，避免日后被误认为有意内容。
- **下一步之前不要 compact 上下文**：第 1–3 步（grill → spec → 工单）必须共享同一份思考。
