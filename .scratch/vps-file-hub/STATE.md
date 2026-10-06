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

**第 0 步 `setup` 已完成；第 1 步 `grill-with-docs` 进行中（已锁定 D1–D35）；分叉 A `prototype` 已建并已部署到真实 Cloudflare，等待真机 SSH 结论。**

**2026-10-07 更新（本次会话）**：Worker `linkbin` 已用 CLI 部署上线，D1/R2 已自动供给，`SSH_MASTER_KEY` 已设置，schema 已应用。**SSH 通道的真机验证是现在唯一的阻塞项**——它无法在本机验证（`wrangler dev` 拒绝连内网地址），所以"部署"就是这道验证的前置，而不是跳过流程。

按 §2.3，**在 ssh-probe 给出可运行答案之前，仍不得进入第 3 步 `to-spec`。**

## 已完成（产物 + 证据）

- [x] **第 0 步 setup** → `docs/agents/issue-tracker.md`（本地 markdown）、`docs/agents/triage-labels.md`（默认五角色；`triage` 已安装故本节成立）、`docs/agents/domain.md`（单上下文）、根 `AGENTS.md` 的 `## Agent skills` 块。依据：`~/.agents/skills/setup-matt-pocock-skills/SKILL.md`。
- [x] **仓库初始化** → `git init`（`main`），初始提交 `c9af21c` 含本续接卡与登记簿。依据：`git log --oneline`。
- [x] **远端建立并推送** → `origin` = `git@github.com:medicagooo/LinkBin.git`（**PUBLIC**，默认分支已为 `main`）。`origin/main` = `cf8c415`，与本地一致、无分歧，普通 fast-forward 推送、无需强制。依据：`git ls-remote origin`、`gh repo view`、`gh api .../git/trees/main?recursive=1`（远端树 14 个 blob 全部就位）。
- [x] **工具链核实** → 36 个 skill 目录（mattpocock 27 + 腾讯 RTC 9）均含 `SKILL.md`；`git` 2.56 / `gh` 2.102（账号 `medicagooo`，SSH 协议，含 `repo` scope）在 PATH；**Node/pnpm/Python 不在 PATH**（须用 DSH 自带运行时）；无 Docker。
- [x] **网络环境核实** → `web_fetch` 在本机**不可用**：公网域名（含 `example.com`、`developers.cloudflare.com`）解析到非公网 TUN 地址 `198.18.0.203`，请求在发出前即被拒绝。**但这不是断网**——已验证可用替代路径：用 `Invoke-WebRequest` 抓文档页的 **`.md` 变体**（`<path>/index.md`）可拿到干净 Markdown 与 `dateModified`。`web_search` 亦可用但只返回来源与摘要。故平台限值必须显式标注"未核实"。**更正**：此前记为本机"完全无法访问网络"不准确，现已修正。
- [x] **架构因果核实** → Cloudflare Workers 无长驻进程、不能主动建 SSH/SFTP 长连接，故"worker 拉取 vps"在实现上必须变为 **VPS 侧 agent 主动推送**（协议层必然，非文档依赖）。**⚠️ 此条结论已被 D14 修正**：用户选择 Worker 直连 SSH，采集方向回到"Worker 主动拉取"；协议层事实不变（无官方 SSH 客户端），风险改由 `prototype` 前置承担。
- [x] **第 1 步 grill（第 1–2 轮，未完）** → `GLOSSARY.md`（已建，含"非关系数据库"术语退役）、`docs/adr/0001-d1-for-metadata-r2-for-bytes.md`、`docs/adr/0002-chunked-ingest-multipart-state-in-d1.md`；锁定 D14–D20。
- [x] **工具链可运行性（子 agent 实证）** → Node v24.21.0 / pnpm 11.7.0 可用；**npm 不存在**；wrangler **4.147.0 实测运行**；本地 D1+R2 仿真完整可用（含 R2 分片与范围读）；`@cloudflare/vitest-plugin` 提供全离线 TDD。→ D19、D20。
- [x] **分叉 A · prototype 已建成并已部署到真实 Cloudflare（2026-10-07）** → probe 路由 `GET /probe/exec`、`GET /probe/list`、`GET /probe/read` 与 `POST /api/hosts/test` 已随主 Worker 上线。**仍未取得真机结论**：需要一个真实主机凭据才能跑。**这仍是进入第 3 步的前置。**
- [ ] **分叉 A · 真机验证（唯一的下一步）** → 在 UI 添加主机 → 跑 probe → 从 `wrangler tail` 或 Workers Logs 读实测 CPU → 把 PASS/FAIL 回写本文件。
- [ ] 第 3 步 to-spec → `.scratch/vps-file-hub/spec.md`

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
- **D28 部署方式 = Cloudflare Workers Builds（GitHub 集成）**。用户要求"部署项目要先 push main，然后 worker 通过 github 来部署"。已核实事实：Workers Builds **必须先在 Cloudflare 仪表盘把仓库连上**（`Workers & Pages` → Worker → `Settings` → `Build`），这一步 AI 在仪表盘之外**无法完成，只有用户能做**（已核查：Cloudflare 未提供连接仓库的 CLI/API 路径；Terraform provider 的 `builds` 支持仍是未合并 PR）。连上后可配：**production branch** 触发 `deploy` 命令（默认 `npx wrangler deploy`），**非 production 分支**触发 **preview build**（`npx wrangler preview`，给出 Preview URL）。→ **纠正一个关键误解：push 到 main 本身不触发部署，"连仓库"才是开关。** 另：Workers Builds **不读** `wrangler.jsonc` 里的 Custom Builds 配置。**已因此把 Worker 移到仓库根**（`src/index.ts`、`wrangler.jsonc`、`package.json` 在根；`prototype/ssh-probe/` 只留文档），使 Root directory 可留空。
- **D29 仓库公开 ⇒ 主机清单不外泄**。`wrangler.jsonc` 中 `PROBE_HOST`/`PROBE_USER` 留**占位符**，真实值走仪表盘的**加密变量**；`PROBE_PASSWORD` 为 secret。本地开发用 `.dev.vars`（已 gitignore）。**已扫描确认密码与 VPS IP 均不在跟踪树内。**
- **D30 测试目标与凭据卫生**。测试 VPS 由用户提供（`root@<test-host, configured dashboard-side>`，密码经对话给出）。**该密码已进入会话记录，而仓库为公开——实验结束后建议轮换该机 root 密码。** 实验对目标机**只读**。
- **D31 ✅ 资源可自动配置——更正我此前的一个错误结论**。我先前断言"D1 必须在部署前手工创建、`database_id` 是必填"。**这是错的。** 官方文档 [Workers configuration → Automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/)：`wrangler deploy` **可自动创建资源**，覆盖 **KV / R2 / D1** / Flagship / AI Search / Agent Memory / Dispatch Namespaces / Queues；用法是**在配置里写绑定但不写资源 ID**（R2 连 bucket 名也不写），资源以 Worker 名作前缀创建。**注意行为差异**：`wrangler dev` 自动建本地资源并持久化；`wrangler deploy` 建资源并**把 ID 写回配置文件**；但**从仪表盘部署（即 Workers Builds / GitHub 路径）会创建资源却不把 ID 写回仓库**，ID 只能在仪表盘看。→ 已照此改写 `wrangler.jsonc`：D1 绑定无 `database_id`、R2 绑定无 `bucket_name`。**用户口述正确，文档核实通过。**
- **D32 单一密钥 + 主机全为运行时数据（用户 2026-10-07 指定）**。部署侧**只存一个密钥** `SSH_MASTER_KEY`；**VPS 的地址、端口、密码/私钥全部经该密钥加密后存 D1**；主机与"要拉取的目录位置"都通过**网页前端在运行时添加**，加机器不需要重新部署。加密实现细节（勿简化）：**AES-GCM 256 位、WebCrypto**、每次加密用**全新随机 12 字节 IV**、**把 host id 与字段名作为 additionalData 绑定**（密文无法被搬到别的行或列）、**失败一律抛错**不回退。界面**永不接收凭据**，只接收**指纹**。**诚实边界**：同时拿到 D1 与 `SSH_MASTER_KEY` 者可解出全部凭据；本设计买到的是"**单库泄露无所得**"。
- **D33 目录规则的"统一 + 分开"用数据模型表达，不用优先级标志**。`source_rules.host_id` 为 `NULL` = **全局规则**（对所有主机生效）；非 NULL = **该主机专属**。收集时两者**并集**，且**排除先于包含求值**——因此"全局收 `/var/log/*.log`"+"某机排除 `/var/log/noisy.log`"的行为符合直觉，**无需引入覆盖/优先级语义**。
- **D34 无 CLI 的部署必须能自建表**。因部署走 Workers Builds（GitHub），发布物旁边**没有 CLI**，故 Worker 自带 `POST /api/admin/apply-schema`：把 `migrations/0001_init.sql` 作为 `Text` 模块导入（wrangler 默认把 `.sql` 映射为字符串），**用 `db.batch()` 分批应用**（D1 唯一有原子保证的单元），每条语句均为 `CREATE ... IF NOT EXISTS` 故**可重复执行**。**schema 因此只有一份真源**，CLI 路径与 Worker 路径共用同一文件。
- **D35 当前 UI 无鉴权（已知限制，必须显式处理）**。任何能访问 Worker 的人都能管理主机与加密凭据。**上线前必须置于 Cloudflare Access 之下或加入 API token**；在补上之前只能当私人工具用。此限制已写入 [README.md](README.md)。
- **D36 部署已实际执行，且走的是 CLI 路径而非 D28 的 Workers Builds（2026-10-07，用户明示授权）**。执行：`wrangler r2 bucket create linkbin-files` → `wrangler deploy --secrets-file .env.deploy` → `POST /api/admin/apply-schema`。产出：Worker **`linkbin`**，版本 `1c7a2112-eaaa-42bd-8768-fcfeb935b657`，`https://linkbin.cyc-xiaochen.workers.dev`；D1 **`linkbin-db`**（自动供给）；R2 **`linkbin-files`**；`masterKeySet=true`、`r2Bound=true`、schema ready（12 条语句 / 4 张表）。**这不推翻 D28**——D28 仍是既定的发布路径，事后可在仪表盘把仓库连到这个已存在的 Worker 上。**两条实测与文档不符，必须记录**：① 官方 changelog 称 CLI 部署会把资源 ID 回写配置文件，**实测未回写**（`git diff` 只有我自己的编辑），故仓库保持无账号资源 ID，符合用户要求；② 因此 `database_id` 只能从 `wrangler d1 list` 取，且 `wrangler d1 execute|migrations --remote` 在本仓库不可用（本仓库不需要，走 Worker 内 apply-schema）。
- **D37 用户对"部署"的授权已变更（2026-10-07）**。此前（D6/授权边界）为"可部署：否"。用户本次明确授权**部署本项目 Worker 到自己的 Cloudflare 账号**并已执行。**部署到任何 VPS 仍然明确不授权。** 另：用户知情并接受当前无鉴权 UI 的风险。
- **D38 资源命名与"不写死 ID"的落地方式（用户指定）**。`r2_buckets` 写死 `bucket_name: "linkbin-files"`——名字即 bucket 的身份，写死它使后续部署绑定同一个 bucket 而非另建一个；`d1_databases` 写死 `database_name: "linkbin-db"` 但**故意不写 `database_id`**。依据：官方 changelog 原话 "resources will stay linked across future deploys even without adding the resource IDs to the config file"（[Automatic resource provisioning, 2025-10-24](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)）。目的：公开仓库里不带账号相关资源 ID。
- **⚠️ D39 `/probe*` 是无鉴权的远程命令执行与任意文件读取入口（高危，必须显式处理）**。`src/index.ts` 的 probe 路由在**未鉴权**时可被任何人调用。若把 `PROBE_HOST`/`PROBE_USER`/`PROBE_PASSWORD` 设为变量，则**任何人**访问 `/probe/exec` 即可在目标机执行命令、访问 `/probe/read` 即可读取该机任意文件并写入 R2。**故一律不设置 `PROBE_*`**，探针只经"UI 添加主机 → 测完立即删除该行"驱动。**在补上鉴权（D35）之前，这条必须当作未修复的暴露面看待。**

## 未决问题（阻塞项）

**开放问题必须在第 1 步 `grill-with-docs` 中全部关闭；有任何问题悬着就不得进 `to-spec`（§2.2 判据）。**

- **Q1（阻塞 spec）** VPS 侧 agent 的形态：语言（Python / Go / 纯 shell + curl）、安装方式、是否需要常驻、如何配置"指定位置"。→ 判定维度：纸面可定，但影响票切分。
- **Q2（阻塞 spec · 已被研究收窄）** 摄取传输路径。**事实已定**（D8）：大文件**不能**经 Worker 一次性上传，必须分片，且分片状态存 D1。**仍需你定**的是 agent 侧复杂度取舍：
  - **(a) agent 分片后逐片 PUT 到 Worker ingest API，Worker 转写 R2 multipart**（Worker 全程在场，鉴权与元数据写入简单；但每片都过一次 Worker，受 6 连接与 100 MB 上限约束）
  - **(b) agent 用预签名 URL / 临时凭据直传 R2，Worker 只发凭据与收元数据**（绕开 Worker 体量上限，吞吐最好；但预签名有 D11 的硬边界，临时凭据需在可信环境本地签 JWT）
  - **(c) 小文件走 (a)、超阈值走 (b) 的混合**
- **Q3（阻塞 spec）** 元数据模型：需要哪些字段（VPS 标识 / 路径 / 大小 / 内容哈希 / mtime / 版本代际 / 软删）。**已被研究加上硬约束**：行 ≤2 MB、≤100 列、SQL 语句 ≤100 KB、每调用 ≤1000 次查询，且**必须含分片会话表**（D8）。
- **Q4（阻塞 spec）** 消费端形态与下载授权路径。**已被研究收窄为二选一**（D11）：预签名 URL（7 天上限、不支持自定义域名）vs 公开 bucket + WAF/Access。另需定：纯 HTTP 下载是否够，还是要 Web 浏览/搜索界面。
- **Q5 ✅ 已解决** 平台硬限值已核实并落盘：`docs/research/cloudflare-platform-limits.md`（943 行、31 个唯一官方 URL、11 处显式"unverified"标注、11 节 Design implications）。**遗留未核实项 10 条**（真机 SFTP 可行性、cron 投递保证、Worker 内预签名等），需要时按该文件 §10 逐条处理，**禁止凭记忆补数字**。
- **Q6 ✅ 大部分已解决（2026-10-07）** 账号侧已核实：wrangler **4.147.0** 已安装，OAuth 登录态有效（账号 `cyc_xiaochen@outlook.com`，token 含 `workers:write`/`d1:write`/`k2.write`），**无需用户重新登入**。资源已就绪：D1 **`linkbin-db`**、R2 **`linkbin-files`**、Worker **`linkbin`**。**D1 的 database_id 故意不写入本仓库**（D38）——需要时用 `wrangler d1 list` 取。**遗留一项未核实**：该 D1 是 Free 还是 Paid 套餐（决定每调用 50 还是 1000 次查询）——未核实，需要时查仪表盘。
- **Q7** 上游 VPS 清单与要采集的具体路径（数量、总量级、单文件最大体积）。→ 由用户提供。**单文件体积直接决定 Q2 走哪条路**。

## 授权边界

- 可写代码：**是**　可推 PR：**是**　可部署（本项目 Worker → 用户自己的 CF 账号）：**是（2026-10-07 起，见 D37）**　可部署到 VPS：**否**
- 其他约束：
  - **不部署到任何 VPS。** Cloudflare 线上资源（D1/R2/Worker）的创建与部署已于 2026-10-07 获用户明确授权并执行（D36）；此后的新增资源或破坏性操作**仍需单独说明目标与影响**。
  - 公开仓库内**不得出现账号相关资源 ID**（D38）。
  - `web_fetch` 不可用时**禁止凭记忆写平台限值**，一律标注"未核实"。
  - D1 无事务（D5）。
  - VPS 侧 agent 部署在本仓库控制之外的机器上，ingest API 一旦发布须保持向后兼容。

## 下一个动作（精确到可执行）

- **动作**：**在已上线的 Worker 上跑真机 SSH 探针**——打开 `https://linkbin.cyc-xiaochen.workers.dev`，在 UI 里添加测试主机（label / address / port / username / 密码），然后：
  1. `POST /api/hosts/test` 带 `{"id":"<host-id>"}` —— 拿连接耗时与规则求值；
  2. `GET /probe/list?path=/etc` 与 `GET /probe/read?path=/etc/hostname` —— 拿 SFTP 列目录与文件读取；
  3. **并行开一个 `wrangler tail linkbin`** 读实测 CPU 时间（判据是 CPU 而非"请求成功"）；
  4. **测完立即删除该主机行**（`POST /api/hosts/delete`）。
  然后按 `acceptance` 判 PASS/FAIL，回写本文件 D14 段落与 `.branch-records/ssh-probe/state.json`。
- **⛔ 绝对不要设置 `PROBE_HOST`/`PROBE_USER`/`PROBE_PASSWORD` 变量**（见 D39：那会把无鉴权的远程命令执行入口直接暴露到公网）。
- **前置**：需要一个真实可 SSH 的主机凭据（来自用户，Q7）。本机无法替代——`wrangler dev` 拒绝连内网地址。
- **验证方式**：拿到实测 CPU 数值 + `sha256` 与独立计算的哈希一致 → PASS；`exceededCpu`/错误 1102 / 算法协商失败 / 哈希不符 → FAIL。**两种结果都是有效结论，都必须落盘。**

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
