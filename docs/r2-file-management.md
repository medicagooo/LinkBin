# R2 文件管理与 merged-all 处理

实现采用 TypeScript。它是项目内置、可测试的处理算子，不执行上传的脚本。

## 使用

登录后，在“已存文件”选择文件并上传。上传文件、VPS 收集文件和合并结果都通过同一列表浏览、搜索、下载和管理。
同名上传文件替换旧版本；上传来源显示为“上传文件”，不会作为 SSH 主机出现。

每个可用文件提供：

- **下载**：使用当前登录会话下载，不创建公开链接。
- **获取直链**：生成可撤销的固定地址 `/d/<token>`。持有链接即可直接下载；同一来源、同一路径更新后，地址保持不变，下载最新版本。取消后旧地址失效，再获取会生成新地址。
- **分享**：填写至少 8 位密码和有效期。`/s/<token>` 在浏览器显示密码表单，验证后下载，不把密码放进地址。有效期仍为最多 24 小时。
- **删除文件**：确认后删除 R2 字节，下载和分享失效。仍被可用合并结果依赖的来源不能删除，需先删除合并结果。

直链没有自动到期；文件删除、被容量回收或链接取消后无法继续下载。密码分享绑定创建时的版本，文件被替换后分享失效；直链跟随最新版本，两者用途不同。取消直链不会取消独立创建的密码分享。

“合并文件”中的“使用 merged-all 预设”填写输出名称 `merged-all.yaml` 和八个上传文件的路径。若来源来自 VPS，请把路径改成其实际已存路径。预览核对成功后保存规则并运行。来源更新后的成功收集或上传都会尝试自动刷新已保存规则；失败保留上次结果并报告原因。

## 目标配置

`src/proxy-profile.ts:buildProxyProfile` 读取以下八个唯一的文件基名，按顺序输出；相同基名来自多个主机时必须缩小来源范围：

| 文件 | 分组名称中的来源 | 节点前缀 |
| --- | --- | --- |
| bytevirt.yaml | ByteVirt | bytevirt- |
| dartnode.yaml | DartNode | dartnode- |
| rabisu.yaml | Rabisu | rabisu- |
| 56idc.yaml | 56IDC | 56idc- |
| yinyun.yaml | 荫云 | yinyun- |
| racknerd.23.254.219.147.yaml | RackNerd 23.254.219.147 | rn147- |
| racknerd.192.119.78.227.yaml | RackNerd 192.119.78.227 | rn227- |
| racknerd.107.172.99.23.yaml | RackNerd 107.172.99.23 | rn99- |

源文件中的节点参数保留，名称加上述前缀，节点内的 dialer 引用同步更新。源文件的 DNS、分组和规则由目标配置替代。
输出包含每个来源的负载均衡、自动选择、手动选择组，以及两个全局测速/均衡组和“🌍选择代理节点”，共 27 组。
五种已知协议顺序为 vless、vmess、hysteria2、tuic、anytls；其他协议排在后面，保留源顺序。
端口、DNS、路由、组名及成员顺序按现有目标确定。节点数量跟随有效来源内容，不固定为 40。

## 实现关系与兼容

- `src/merge.ts:mergeText` 调用纯函数 `buildProxyProfile`；`src/derived.ts` 接受 `proxy-profile`，原有 concat/YAML union 保持兼容。预览、手动运行、自动刷新使用相同引擎与现有 8 MiB 总输入上限。
- `src/files.ts:manageFiles` 仅在 `src/index.ts` 完成会话检查后调用。上传走 `storeStream`、`withStorageWriter`、`publishVersion`；使用现有 100 MiB/文件、10 GiB 总容量预算，拒绝超额，不主动回收其他文件。上传完成释放锁后才刷新依赖结果。
- `@uploads` 是禁用的内部归属行；`src/db.ts:listHosts` 和主机配额排除它与 `@derived`。文件过滤器仍可选择这两个来源。
- 迁移 `0005_file_links.sql` 只创建表/索引。`file_links` 存储随机 token、来源、路径和撤销时间；唯一索引约束每个身份只有一个未撤销直链。`serveDirectLink` 每次查询当前有效对象，随后用 `downloadFile` 流式输出。管理接口为 `/api/files/upload|download|delete`、`/api/file-links` 和 `/api/file-links/revoke`。
- `src/share-page.ts` 输出转义的收件人表单，限制公开提交大小，密码仅通过 POST 提交。`src/index.ts:serveShare` 保留密码 Header/query 的老客户端兼容、原有 PBKDF2、节流、过期和撤销逻辑。原有 API 仍可创建无密码限时分享；新界面要求密码。
- 管理列表涵盖应用登记的 R2 文件；不提供云控制台级的桶配置或未登记对象导入。

此变更不引入新部署密钥，不假设多语句事务。上传先生成唯一 R2 key，再通过现有可恢复发布协议切换对象；删除先回收字节，再记录删除事实。
线上使用需要发布新 Worker 并应用新迁移。代码构建与离线测试不会执行这两项线上操作。
