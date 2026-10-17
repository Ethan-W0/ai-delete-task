# ai-delete-task.js — Qoder / ZCode / Claude Code / pi / DeepSeek Harness / Kimi Code 会话数据一键清理（需 Node 22+，用内置 `node:sqlite`）

- `node ai-delete-task.js`：交互模式 → 选目标(Qoder/ZCode/Claude Code/pi/DeepSeek Harness/Kimi Code) → 列本地对话（编号可多选：`1 3 5` / `1,3,5` / `2-4`）→ 逐个回显落盘位置 → 一次输 `yes` 全部删除 → 复扫验证。
- `node ai-delete-task.js qoder|zcode|claude|pi|dsh|kimi`：跳过目标选择（`dsh` 亦写作 `deepseek`）；`node ai-delete-task.js <会话ID>`：跳过菜单直接处理。
  Qoder、Claude、pi 的会话ID都是 UUID，无法据此区分产品，需同时给目标参数：`node ai-delete-task.js claude <会话ID>`（zcode 的 `sess_xxx`、dsh 的 `session-<uuid>`、kimi 的 `session_<uuid>` 可自动识别）。
- 执行前先完全退出对应客户端（含托盘），否则数据库写入可能失败或行被写回；删除不可恢复，云端同步的对话可能下次同步重新出现。

## Claude Code（`~/.claude`）

无数据库索引，会话列表由 `projects/<工作目录slug>/<会话ID>.jsonl` 直接推导；标题取记录里的 `aiTitle`，缺失时回退到首条用户消息（自动跳过 `<local-command-caveat>` 等命令包装）。按会话ID清理的位置：

| 位置 | 内容 |
| --- | --- |
| `projects/<slug>/<ID>.jsonl` | 对话正文 |
| `projects/<slug>/<ID>/` | 子代理 / workflow 产物 |
| `session-env/<ID>/`、`file-history/<ID>/`、`todos/<ID>-agent-*.json` | 会话环境、文件历史快照、待办 |
| `telemetry/1p_failed_events.<ID>.*.json` | 上报失败事件缓存 |
| `sessions/<pid>.json` + `<pid>.*.key` | 活跃进程注册表（命中说明该会话仍在运行，整删而非挖字段，菜单里标「正在运行」） |

注意：`file-history/<ID>/` 是该会话改过的文件的历史快照，删掉后不能再靠它回滚（工作区文件本身不受影响）。若整个 `projects/<slug>` 里的会话都被选中，会连项目目录一起删。

## pi（`~/.pi`）

`@earendil-works/pi-coding-agent` 同样无数据库索引。会话正文只有一处：`agent/sessions/<工作目录编码>/<ISO时间戳>_<会话ID>.jsonl`。列表由 jsonl 首行的 `session` 头记录推导，标题取最后一条 `session_info.name`（即 `--name` / `/name` 设的名字），缺失时回退首条用户消息。

- 路径跟随 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`（含 `--session-dir`）；未设置时即 `~/.pi/agent/sessions`，会话目录被指到 `~/.pi` 之外时会单独作为一个扫描根。
- `bin`（自带的 fd.exe / rg.exe）、`themes`、`tools` 不存会话，已排除在扫描外。
- **级联删除**：压缩（compact）、分支、fork 都会新建会话文件，其头记录带 `parentSessionId`（旧版是 `legacyParentSessionPath`）。子文件正文含父ID，只删父会话会让逐行剔除把子文件的头行也删掉，等于损坏子会话，所以选中父会话时整条派生链一起删，菜单里子会话标「子会话(父: 标题)」。
- 若整个 `sessions/<工作目录编码>` 里的会话都被选中，会连目录一起删；批删后只剩空壳的目录自动回收。
- pi 没有活跃进程注册表，无法像 Claude 那样标「正在运行」；pi 开着时删它的当前会话，pi 会继续 append 把文件写回来。

## DeepSeek Harness（`~/.dsh`）

会话数据全在 `~/.dsh`；Electron 壳 `%APPDATA%\@deepseek-ai\dsh-desktop` 只有浏览器缓存（其 `Local Storage/leveldb` 里虽有会话ID，但逐行改写会弄坏 leveldb 且应用会自愈，故不纳入扫描）。会话ID带 `session-` 前缀。

| 位置 | 内容 |
| --- | --- |
| `sessions/<工作区slug>/session-<ID>/session.v4.jsonl.zstd` | 对话正文（zstd 压缩的 jsonl v4；压缩内容扫不到字节，靠目录名归属、整目录删除） |
| `storages/session_projcache/sessions/session-<ID>.json` | 投影缓存：标题 `rows.title.val`、首条用户输入、token 用量、cwd、createdAt |
| `storages/workspace.json` | 全局索引：workspaces→`sessionIds`、`archivedSessionIds`、`pinnedSessionIds`（外科剔除该ID） |

- `dsh-runtimes`（运行时二进制）、`profiles`（桌面端配置）不存会话，已排除在扫描外。
- 菜单标记：`已归档` / `已置顶` 来自全局索引；索引之外只剩文件的标「孤儿(不在工作区索引)」。
- `.credentials.yaml` 属凭据文件，命中会话ID只报告、绝不改写或删除。
- 若整个 `sessions/<工作区slug>` 里的会话都被选中，会连目录一起删。
- 删除前需退出 `DeepSeek Harness.exe`（Electron 多进程），否则 `workspace.json` 可能被写回。

## Kimi Code（`~/.kimi-code`）

无数据库索引。会话正文在 `sessions/<工作区slug>/session_<ID>/`（注意是**下划线** `session_`，与 dsh 的 `session-` 区分）；列表由这些目录 + `state.json` 推导，标题取 `title`，缺失时回退 `lastPrompt`。按会话ID清理的位置：

| 位置 | 内容 |
| --- | --- |
| `sessions/<slug>/session_<ID>/` | `state.json` 元信息、`agents/main/wire.jsonl` 对话正文、`attachments/`、`logs/`、`notify/` |
| `server/events/session_<ID>.jsonl` | 该会话的事件流 |
| `server/events/__global__.jsonl`、`session_index.jsonl`、`logs/*.log` | 混着别的会话，逐行剔除含该ID的行 |
| `file-history/<工作区slug>` | 无扩展名的裸 JSON，记录哪些会话动过文件；按 `sessions[].id` 整条摘除 |
| `files/f_<uuid>` + `file/index.json` | 上传的附件与登记表（见下） |
| `cache/query-store/`、`sessions/.index-cache/` | 派生缓存，整目录删除（见下） |

- **附件级联**：上传的文件落在全局 `files/f_<uuid>`，文件名和内容都不含会话ID，全盘扫描扫不到。脚本改为读会话正文（`state.json` / `wire.jsonl` / `server/events/<ID>.jsonl`）里的 `f_<uuid>` 引用来级联删除，并同步从 `file/index.json` 摘掉登记项。**仍被未选中会话引用的附件会保留**，所以多个会话共用同一份上传文件时不会误删。
- **派生缓存**：`cache/query-store` 是自建的 LSM 搜索索引（`db.wal` 魔数 `MD\x03`，不是 sqlite），`sessions/.index-cache` 是列表扫描缓存。两者都无法只剔单条，命中即整目录删除，客户端下次启动重建。
- `workspaces.json`、`file-history/<slug>` 按工作区而非会话组织；`sessions/.index-dirty` 是客户端自己的空标记目录，回收空容器时会跳过所有点开头的目录。
- `server/instances/<ULID>.json` 是活跃进程注册表，但里面只有 pid 和心跳、**不含会话ID**，所以无法像 Claude 那样标「正在运行」。Kimi Code 开着时删当前会话，它可能把 `state.json` 写回来。
- 菜单标记：索引之外只剩目录的标「孤儿(不在会话索引)」，只剩索引没有目录的标「仅索引残留」。
- 删除前需退出 Kimi Code（含托盘），否则 `session_index.jsonl` 可能被写回。

## Qoder 与 ZCode

- Qoder：`~/.qoder-cn`（projects 对话记录/状态、tasks、file-history、logs）+ `%APPDATA%/com.qodercn.app.stable`（`main.sqlite` 会话索引与运行日志）。会沿 `origin_session_id` / `owner_session_id` 连带清理 fork、侧聊等派生会话。
- ZCode：`~/.zcode`（`v2/tasks-index.sqlite` 任务索引 + 会话数据）。会沿 `session.parent_id` 连带清理子代理会话。
- 两者的数据库清理只删归属该会话的行，随后 `VACUUM` 收缩文件；其他对话正文里引用了这串ID的字节命中会单独标注为「引用，非残留」，不做外科修改。

## 通用行为

- **凭据保护**：`auth.json` / `oauth.json` / `models-store.json` / `credentials.json` / `.credentials.yaml` / `kimi-code.json` / `server.token` 即便字节命中会话ID也只报告、绝不改写或删除（复扫时归入「凭据文件，有意保留」，不算残留）。
- **JSON 外科剔除**：`.json` 按字段清理；无扩展名但整体能 `JSON.parse` 的文件（如 kimi 的 `file-history/<slug>`）同样按 JSON 处理，解析不动才退回「二进制，请人工确认」。数组元素若是「某会话的一条记录」（身份字段名含 `id`/`session`/`task` 且值命中被删ID），整条摘掉，不留 `{touchedAt: …}` 这种认不出归属的残缺项；身份字段无关的对象仍只逐字段清理。
- 同批次交叉引用去重：若某文件已在本批次被整删，就不再对它逐行剔除（避免先改写再删除、或因文件已不存在而报失败）。
- 复扫验证区分三类命中：真残留（建议退出客户端后重跑）、引用型命中（非残留）、凭据文件（有意保留）。
