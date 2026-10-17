#!/usr/bin/env node
'use strict';
/**
 * ZCode / Qoder / Claude Code / pi / DeepSeek Harness / Kimi Code 会话数据一键清理工具
 *
 * 流程:
 *   node ai-delete-task.js               选择目标 (Qoder / ZCode / Claude Code / pi / DeepSeek Harness / Kimi Code) ->
 *     列出本地对话 -> 输入编号选择 -> 自动扫描该产品的全部数据落盘目录,
 *     找出该对话存在的所有位置并回显 -> 输入 yes 确认 -> 一键删除 ->
 *     复扫验证(区分"自身数据"与"他处引用")
 *   node ai-delete-task.js qoder|zcode|claude|pi|dsh|kimi   跳过目标选择 (dsh 亦写作 deepseek)
 *   node ai-delete-task.js <会话ID>      跳过菜单直接处理
 *     (zcode: sess_xxx, dsh: session-<uuid>, kimi: session_<uuid>)
 *     Qoder / Claude / pi 的会话ID同为 UUID, 无法据此区分产品, 需同时给出目标参数:
 *     node ai-delete-task.js claude <会话ID>
 *   交互列表编号支持多选: 1 3 5 / 1,3,5 / 2-4, 一次确认删除多个对话
 *
 * 扫描范围 (自动定位, 无需手动指定):
 *   ZCode:  ~/.zcode                                 (任务索引 + 会话数据)
 *   Qoder:  ~/.qoder-cn                              (projects 对话记录/状态, tasks, file-history, logs)
 *           %APPDATA%/com.qodercn.app.stable         (main.sqlite 客户端会话索引 + 运行日志)
 *   Claude: ~/.claude                                (projects 对话记录与子代理产物, session-env,
 *                                                     file-history 文件快照, telemetry, sessions 进程注册表)
 *           Claude Code 无数据库索引, 会话列表由 projects/<slug>/<会话ID>.jsonl 直接推导
 *   pi:     ~/.pi                                    (agent/sessions/<cwd编码>/<时间戳>_<会话ID>.jsonl)
 *           受 PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR 影响时会跟随环境变量;
 *           bin(fd/rg 二进制)、themes、tools 不存会话, 已排除在扫描外
 *           pi 同样无数据库索引, 会话列表由 jsonl 头记录 + session_info 名推导
 *   dsh:    ~/.dsh                                   (DeepSeek Harness: sessions/<工作区slug>/session-<ID>/
 *                                                     session.v4.jsonl.zstd 正文, storages/session_projcache
 *                                                     标题缓存, storages/workspace.json 全局索引)
 *           正文为 zstd 压缩, 字节扫描扫不到内容, 归属靠目录名整目录删除;
 *           dsh-runtimes(运行时二进制)、profiles(桌面端配置)与 Electron 壳缓存不纳入扫描
 *   kimi:   ~/.kimi-code                             (Kimi Code: sessions/<工作区slug>/session_<ID>/
 *                                                     state.json + agents/main/wire.jsonl 正文,
 *                                                     session_index.jsonl 会话索引, server/events 事件流,
 *                                                     files/f_<uuid> 上传附件 + file/index.json 登记表)
 *           同样无数据库索引, 会话列表由 sessions 下的 session_<ID> 目录 + state.json 标题推导;
 *           cache/query-store(搜索索引)与 sessions/.index-cache(列表扫描缓存)是派生数据,
 *           无法只剔单条, 命中即整目录删除, 客户端下次启动重建;
 *           workspaces.json / file-history/<工作区slug> 按工作区而非会话组织, 不含会话ID
 *
 * 注意:
 *   - 执行删除前请完全退出对应客户端(含托盘), 否则数据库写入可能失败或行被写回
 *   - 删除不可恢复; 云端同步的对话可能在下次同步时重新出现
 *   - 若选中的是当前正在进行的对话, 请先聊完再删
 *   - Claude 的 file-history/<会话ID>/ 是该会话改过的文件的历史快照, 删掉后不能再靠它回滚
 *     (工作区里的文件本身不受影响)
 *   - pi 的压缩/分支/fork 会派生新会话文件, 其头记录含父会话ID; 选中父会话时会
 *     级联删掉整条派生链, 否则子会话的头行会被逐行剔除逻辑破坏
 *   - kimi 的上传附件落在全局 files/f_<uuid>, 文件名与内容都不含会话ID, 扫描扫不到;
 *     按会话正文里的引用级联删除, 且仍被未选中会话引用的附件会保留
 *   - auth.json / oauth.json / models-store.json / kimi-code.json / server.token 等凭据文件
 *     即便命中会话ID也只报告不改写
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

/* ---------------- 目标与根目录 ---------------- */
const ZCODE_ROOT = path.join(os.homedir(), '.zcode');
const QODER_ROOT = path.join(os.homedir(), '.qoder-cn');
const QODER_APPDATA = path.join(os.homedir(), 'AppData', 'Roaming', 'com.qodercn.app.stable');
const CLAUDE_ROOT = path.join(os.homedir(), '.claude');
const DSH_ROOT = path.join(os.homedir(), '.dsh'); // DeepSeek Harness
const KIMI_ROOT = path.join(os.homedir(), '.kimi-code'); // Kimi Code
const qoderDb = () => path.join(QODER_APPDATA, 'main.sqlite');
const TASKS_DB = path.join(ZCODE_ROOT, 'v2', 'tasks-index.sqlite');
const SELF = path.resolve(__filename);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// DeepSeek Harness 的会话ID带 session- 前缀, 与 zcode 的 sess_ 一样可据此自动识别目标
const DSH_SESSION_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Kimi Code 的会话ID是 session_<uuid>(下划线), 与 dsh 的 session- 区分
const KIMI_SESSION_RE = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const underDir = (p, d) => p === d || p.startsWith(d + path.sep);

// 凭据文件: 即便字节命中会话ID也绝不外科改写, 只在计划里说明
const CRED_FILES = new Set(['auth.json', 'oauth.json', 'models-store.json', 'credentials.json', '.credentials.json', '.credentials.yaml', 'kimi-code.json', 'server.token']);

/* pi (@earendil-works/pi-coding-agent) 的路径以其源码定义为准:
   agentDir = $PI_CODING_AGENT_DIR || ~/.pi/agent
   sessions = $PI_CODING_AGENT_SESSION_DIR || <agentDir>/sessions */
const PI_ROOT = path.join(os.homedir(), '.pi');
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ? path.resolve(expandHome(process.env.PI_CODING_AGENT_DIR)) : path.join(PI_ROOT, 'agent');
const PI_SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR ? path.resolve(expandHome(process.env.PI_CODING_AGENT_SESSION_DIR)) : path.join(PI_AGENT_DIR, 'sessions');
function piRoots() {
  // bin 是自带的 fd.exe/rg.exe(数 MB 二进制), themes/tools 是主题与自定义工具, 都不存会话
  const roots = [{ dir: PI_ROOT, prune: new Set(['bin', 'themes', 'tools', 'node_modules', '.git']) }];
  // 会话目录被环境变量指到 ~/.pi 之外时, 单独作为一个扫描根
  if (!underDir(PI_SESSIONS_DIR, PI_ROOT)) roots.push({ dir: PI_SESSIONS_DIR, prune: new Set() });
  return roots;
}

const TARGETS = {
  zcode: {
    label: 'ZCode',
    roots: [{ dir: ZCODE_ROOT, prune: new Set() }],
    client: 'ZCode 客户端',
    containerZones: [],
  },
  qoder: {
    label: 'Qoder',
    roots: [
      // bin/.bin/app/entry 是程序本体与二进制, 不存会话数据, 剪枝以加速扫描
      { dir: QODER_ROOT, prune: new Set(['bin', '.bin', 'app', 'entry', '.git', 'node_modules']) },
      // Cache/GPUCache/Network 等是浏览器内核缓存与凭据, 不存会话数据
      { dir: QODER_APPDATA, prune: new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Service Worker', 'Crashpad', 'updates', 'Dictionaries', 'Network']) },
    ],
    client: 'Qoder 客户端',
    // projects/<slug> 与 logs/sessions/<slug> 按工作目录命名, 需判断能否整目录删
    containerZones: [path.join(QODER_ROOT, 'projects'), path.join(QODER_ROOT, 'logs', 'sessions')],
  },
  claude: {
    label: 'Claude Code',
    roots: [
      // skills/plugins/statsig/shell-snapshots 是技能、插件与外壳快照, 与会话无关且可能很大
      { dir: CLAUDE_ROOT, prune: new Set(['skills', 'plugins', 'statsig', 'shell-snapshots', 'node_modules', '.git']) },
    ],
    client: 'Claude Code',
    containerZones: [path.join(CLAUDE_ROOT, 'projects')],
    // sessions/<pid>.json 是活跃进程注册表, 内容里带 sessionId; 命中时整删该注册项而非挖字段
    liveRegistry: path.join(CLAUDE_ROOT, 'sessions'),
  },
  pi: {
    label: 'pi',
    roots: piRoots(),
    client: 'pi',
    // sessions/<cwd编码> 按工作目录命名(如 --C--Users-username--), 需判断能否整目录删
    containerZones: [PI_SESSIONS_DIR],
  },
  dsh: {
    label: 'DeepSeek Harness',
    roots: [
      // dsh-runtimes 是运行时二进制, profiles 是桌面端配置, 都不存会话;
      // Electron 壳(%APPDATA%\@deepseek-ai\dsh-desktop)只有浏览器缓存, 不纳入扫描
      { dir: DSH_ROOT, prune: new Set(['dsh-runtimes', 'profiles', 'node_modules', '.git']) },
    ],
    client: 'DeepSeek Harness 桌面端',
    // sessions/<工作区slug> 按工作区路径命名, 需判断能否整目录删
    containerZones: [path.join(DSH_ROOT, 'sessions')],
  },
  kimi: {
    label: 'Kimi Code',
    roots: [{ dir: KIMI_ROOT, prune: new Set(['node_modules', '.git']) }],
    client: 'Kimi Code',
    // sessions/<wd_slug> 按工作目录命名, 需判断能否整目录删
    containerZones: [path.join(KIMI_ROOT, 'sessions')],
    // cache/query-store 是按会话内容建的搜索索引, sessions/.index-cache 是列表扫描缓存,
    // 均为派生数据且无法外科剔除单条, 命中时整目录删除, 客户端下次启动重建
    cacheZones: [path.join(KIMI_ROOT, 'cache'), path.join(KIMI_ROOT, 'sessions', '.index-cache')],
  },
};

let TARGET = null; // 'qoder' | 'zcode' | 'claude' | 'pi' | 'dsh' | 'kimi', 由选择框或命令行确定
let ROOTS = [];    // 当前目标的扫描根 [{ dir, prune }]
const clientName = () => TARGETS[TARGET].client;

const argv = process.argv.slice(2);
const targetArg = argv.find((a) => /^(qoder|zcode|claude|pi|dsh|deepseek|kimi)$/i.test(a));
const idArg = argv.find((a) => /^sess_[\w.-]+$/.test(a) || DSH_SESSION_RE.test(a) || KIMI_SESSION_RE.test(a) || UUID_RE.test(a)) || '';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const fmtTime = (v) => {
  if (!v) return '-';
  return new Date(v > 1e12 ? v : v * 1000).toLocaleString();
};
const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const HOME = os.homedir();
const normSep = (s) => (process.platform === 'win32' ? s.replace(/\//g, '\\') : s);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 主目录会以路径形态出现, 也会以 Qoder projects/<slug> 的编码形态(分隔符换成 '-')
// 嵌在字符串中间, 故两种形态都匹配全部出现位置; 边界断言避免误伤同前缀目录名
const HOME_RES = [HOME, HOME.replace(/[:/\\]/g, '-')].map((h) => new RegExp(reEsc(h) + '(?:$|(?=[/\\\\-]))', 'g'));
const maskPath = (p) => {
  if (typeof p !== 'string' || !p) return p;
  let q = normSep(p);
  for (const re of HOME_RES) q = q.replace(re, '~');
  return q;
};
const rel = (p) => {
  let best = p;
  for (const r of ROOTS) {
    const x = path.relative(r.dir, p);
    if (x && !x.startsWith('..') && !path.isAbsolute(x) && x.length < best.length) best = x;
  }
  return maskPath(best);
};
const dirSize = (p) => {
  let bytes = 0, files = 0;
  const stack = [p];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) stack.push(q);
      else { try { bytes += fs.statSync(q).size; files++; } catch {} }
    }
  }
  return { bytes, files };
};

/* ---------------- 1. 任务列表 ---------------- */
function readTasks() {
  try {
    const db = new DatabaseSync(TASKS_DB, { readOnly: true });
    const rows = db
      .prepare('SELECT task_id, title, task_status, archived, deleted, updated_at FROM tasks ORDER BY updated_at DESC')
      .all();
    db.close();
    return rows;
  } catch (e) {
    console.error('无法读取任务索引: ' + e.message);
    return [];
  }
}

/* ---------------- 1b. Qoder 任务列表 (客户端索引 + 磁盘孤儿) ---------------- */
function orphanTitle(jsonl, skip) {
  // 孤儿会话无索引, 从对话记录里提取第一条用户消息作为标题
  // skip: 可选谓词, 用于跳过不适合作标题的文本(如命令包装)
  try {
    const fd = fs.openSync(jsonl, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'user' || !o.message) continue;
      const c = o.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x && x.type === 'text') || {}).text || '' : '';
      if (text && !(skip && skip(text))) return text;
    }
  } catch {}
  return '';
}

function readQoderTasks() {
  const list = [];
  const seen = new Set();
  try {
    const db = new DatabaseSync(qoderDb(), { readOnly: true });
    const rows = db.prepare('SELECT session_id, title, cwd, archived, deleted_at, updated_at FROM chat_sessions ORDER BY updated_at DESC').all();
    db.close();
    for (const r of rows) {
      seen.add(r.session_id);
      list.push({ task_id: r.session_id, title: r.title, task_status: '', archived: r.archived, deleted: r.deleted_at ? 1 : 0, updated_at: r.updated_at || 0, cwd: r.cwd });
    }
  } catch (e) {
    console.error('无法读取客户端会话索引 (main.sqlite): ' + e.message);
  }
  // 磁盘上存在但客户端索引里没有的"孤儿"对话 (如重装/索引重置后残留)
  const projDir = path.join(QODER_ROOT, 'projects');
  let slugs = [];
  try { slugs = fs.readdirSync(projDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch {}
  for (const s of slugs) {
    let files = [];
    try { files = fs.readdirSync(path.join(projDir, s.name)); } catch { continue; }
    for (const f of files) {
      const m = f.match(/^([0-9a-f-]{36})\.jsonl$/i);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const full = path.join(projDir, s.name, f);
      let mt = 0;
      try { mt = fs.statSync(full).mtimeMs; } catch {}
      list.push({ task_id: m[1], title: orphanTitle(full), task_status: '孤儿(不在客户端索引)', archived: 0, deleted: 0, updated_at: mt, cwd: s.name });
    }
  }
  list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return list;
}

/* ---------------- 1c. Claude Code 会话列表 (无索引库, 由 transcript 与残留目录推导) ---------------- */
// 单个 transcript 可能上百 MB, 只取首尾各 128KB: cwd 在开头几条记录里, aiTitle 是后续追加的
function readEdges(file, edge = 131072) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { head: '', tail: '' }; }
  const fd = fs.openSync(file, 'r');
  try {
    const headLen = Math.min(edge, size);
    const head = Buffer.alloc(headLen);
    if (headLen) fs.readSync(fd, head, 0, headLen, 0);
    let tail = '';
    if (size > edge) {
      const tailLen = Math.min(edge, size - edge);
      const t = Buffer.alloc(tailLen);
      fs.readSync(fd, t, 0, tailLen, size - tailLen);
      tail = t.toString('utf8');
    }
    return { head: head.toString('utf8'), tail };
  } finally { fs.closeSync(fd); }
}

function claudeMeta(jsonl) {
  let title = '', cwd = '';
  try {
    const { head, tail } = readEdges(jsonl);
    // 尾部第一行可能被截断, 丢掉
    const lines = head.split('\n').concat(tail ? tail.split('\n').slice(1) : []);
    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!cwd && o.cwd) cwd = o.cwd;
      if (o.aiTitle) title = o.aiTitle; // 多次生成时取最后一次
    }
  } catch {}
  // Claude 的用户消息里混有 <local-command-caveat> / <command-name> 等包装文本, 不适合当标题
  if (!title) title = orphanTitle(jsonl, (t) => t.trimStart().startsWith('<'));
  return { title: title.replace(/\s+/g, ' ').trim(), cwd };
}

function dirLatest(p) {
  let latest = 0;
  const stack = [p];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) stack.push(q);
      else { try { const m = fs.statSync(q).mtimeMs; if (m > latest) latest = m; } catch {} }
    }
  }
  return latest;
}

function claudeRunningIds() {
  // sessions/<pid>.json 是活跃进程注册表, 有条目即说明该会话仍被某个 claude 进程持有
  const ids = new Set();
  let files = [];
  try { files = fs.readdirSync(TARGETS.claude.liveRegistry); } catch { return ids; }
  for (const f of files) {
    if (!/\.json$/i.test(f)) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(TARGETS.claude.liveRegistry, f), 'utf8'));
      if (o && o.sessionId) ids.add(o.sessionId);
    } catch {}
  }
  return ids;
}

const ID_PREFIX_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const UUID_IN_NAME_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function readClaudeTasks() {
  const found = new Map(); // 会话ID -> { jsonl, mt, cwd, residue }
  const touch = (id, extra) => {
    const cur = found.get(id) || { jsonl: '', mt: 0, cwd: '', residue: false };
    const mt = Math.max(cur.mt, extra.mt || 0);
    Object.assign(cur, extra);
    cur.mt = mt;
    found.set(id, cur);
  };
  const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

  const projDir = path.join(CLAUDE_ROOT, 'projects');
  let slugs = [];
  try { slugs = fs.readdirSync(projDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch {}
  for (const s of slugs) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(projDir, s.name), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const stem = e.name.replace(/\.jsonl$/i, '');
      if (!UUID_RE.test(stem)) continue;
      const full = path.join(projDir, s.name, e.name);
      if (e.isFile() && /\.jsonl$/i.test(e.name)) touch(stem, { jsonl: full, mt: mtime(full), cwd: s.name });
      else if (e.isDirectory()) touch(stem, { mt: dirLatest(full), cwd: s.name, residue: true }); // 子代理/workflow 产物
    }
  }
  // transcript 之外按会话ID命名的目录/文件: 只剩这些也算一个待清理的会话
  // todos 的文件名形如 <会话ID>-agent-<子代理ID>.json, 故取前缀UUID
  for (const zone of ['session-env', 'file-history', 'todos']) {
    const base = path.join(CLAUDE_ROOT, zone);
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const m = e.name.match(ID_PREFIX_RE);
      if (!m) continue;
      const full = path.join(base, e.name);
      touch(m[1], { mt: e.isDirectory() ? dirLatest(full) : mtime(full), residue: true });
    }
  }

  // telemetry 缓存的文件名形如 1p_failed_events.<会话ID>.<事件ID>.json, 会话ID不在开头,
  // 取文件名里第一个 UUID; transcript 已不在的"孤儿残留"因此也能进菜单被选中
  const teleDir = path.join(CLAUDE_ROOT, 'telemetry');
  let tfiles = [];
  try { tfiles = fs.readdirSync(teleDir); } catch {}
  for (const f of tfiles) {
    const m = f.match(UUID_IN_NAME_RE);
    if (!m) continue;
    touch(m[0], { mt: mtime(path.join(teleDir, f)), residue: true });
  }

  const running = claudeRunningIds();
  const list = [];
  for (const [id, v] of found) {
    let title = '', cwd = v.cwd;
    if (v.jsonl) {
      const m = claudeMeta(v.jsonl);
      title = m.title;
      cwd = m.cwd || cwd;
    }
    if (!title) title = v.jsonl ? '(无标题)' : '(无对话记录, 仅剩残留目录)';
    list.push({
      task_id: id,
      title,
      task_status: running.has(id) ? '正在运行' : (v.jsonl ? '' : '仅残留'),
      archived: 0,
      deleted: 0,
      updated_at: v.mt,
      cwd,
    });
  }
  list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return list;
}

/* ---------------- 1d. pi 会话列表 (无索引库, 由 sessions/<cwd编码>/*.jsonl 头记录推导) ----------------
   文件名: <ISO时间戳(: 与 . 换成 -)>_<会话ID>.jsonl
   头记录: {type:"session",version,id,timestamp,cwd,parentSessionId?,legacyParentSessionPath?}
   会话名: 最后一条 {type:"session_info",name} (pi 的 --name / /name), 缺失时回退首条用户消息 */
const PI_FILE_RE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
let piIndexCache = null;

function piMeta(file) {
  let cwd = '', parentId = '', name = '', firstUser = '';
  try {
    const { head, tail } = readEdges(file);
    const headLines = head.split('\n');
    try {
      const h = JSON.parse(headLines[0]);
      if (h && h.type === 'session') {
        cwd = h.cwd || '';
        // 旧格式存的是父会话的文件路径, 从路径里取回会话ID
        const legacy = h.legacyParentSessionPath;
        parentId = h.parentSessionId || (legacy ? (String(legacy).match(UUID_IN_NAME_RE) || [''])[0] : '');
      }
    } catch {}
    const scan = (lines) => {
      for (const line of lines) {
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'session_info' && typeof o.name === 'string' && o.name.trim()) name = o.name.trim();
        if (!firstUser && o.type === 'message' && o.message && o.message.role === 'user') {
          const c = o.message.content;
          const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x && x.type === 'text') || {}).text || '' : '';
          if (t.trim()) firstUser = t;
        }
      }
    };
    scan(headLines);
    if (tail) scan(tail.split('\n').slice(1)); // 尾部第一行可能被截断, 丢掉
  } catch {}
  return { cwd, parentId: parentId.toLowerCase(), title: (name || firstUser).replace(/\s+/g, ' ').trim() };
}

function piSessionIndex() {
  if (piIndexCache) return piIndexCache;
  const map = new Map(); // 会话ID -> { file, slug, mt, cwd, parentId, title }
  let slugs = [];
  try { slugs = fs.readdirSync(PI_SESSIONS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch {}
  for (const s of slugs) {
    let files = [];
    try { files = fs.readdirSync(path.join(PI_SESSIONS_DIR, s.name)); } catch { continue; }
    for (const f of files) {
      const m = f.match(PI_FILE_RE);
      if (!m) continue;
      const full = path.join(PI_SESSIONS_DIR, s.name, f);
      let mt = 0;
      try { mt = fs.statSync(full).mtimeMs; } catch { continue; }
      map.set(m[1].toLowerCase(), Object.assign({ file: full, slug: s.name, mt }, piMeta(full)));
    }
  }
  piIndexCache = map;
  return map;
}

function collectPiChain(id) {
  // 压缩/分支/fork 都会新建会话文件, 头记录指向父会话; 子文件正文含父ID,
  // 只删父会话会让逐行剔除逻辑把子文件的头行也删掉(等于损坏子会话), 故整条链一起处理
  const children = new Map();
  for (const [sid, v] of piSessionIndex()) {
    if (!v.parentId) continue;
    const arr = children.get(v.parentId) || [];
    arr.push(sid);
    children.set(v.parentId, arr);
  }
  const all = [id];
  let frontier = [id];
  while (frontier.length) {
    const next = [];
    for (const p of frontier)
      for (const c of children.get(p) || [])
        if (!all.includes(c)) { all.push(c); next.push(c); }
    frontier = next;
  }
  return all;
}

function readPiTasks() {
  const idx = piSessionIndex();
  // pi 用 uuidv7, 前8位是时间戳, 同期会话完全相同, 故用父会话标题而非ID前缀来标识
  const parentTag = (pid) => {
    const p = idx.get(pid);
    return p && p.title ? `子会话(父: ${p.title.slice(0, 16)})` : `子会话(父 …${pid.slice(-6)})`;
  };
  const list = [];
  for (const [id, v] of idx) {
    list.push({
      task_id: id,
      title: v.title || '(无标题)',
      task_status: v.parentId ? parentTag(v.parentId) : '',
      archived: 0,
      deleted: 0,
      updated_at: v.mt,
      cwd: v.cwd || v.slug,
    });
  }
  list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return list;
}

/* ---------------- 1e. DeepSeek Harness 会话列表 ----------------
   无数据库。全局索引 storages/workspace.json (workspaces -> sessionIds, 另有
   archived/pinned 两个列表); 标题与首条用户输入在投影缓存
   storages/session_projcache/sessions/session-<uuid>.json 的 rows.title / rows.titleInput。
   正文 sessions/<工作区slug>/session-<uuid>/session.v4.jsonl.zstd 是 zstd 压缩的,
   字节扫描扫不到内容, 归属只能靠目录名, 故整目录删除。 */
function dshProj(id) {
  const f = path.join(DSH_ROOT, 'storages', 'session_projcache', 'sessions', id + '.json');
  let mt = 0;
  try { mt = fs.statSync(f).mtimeMs; } catch { return null; }
  let title = '', first = '', cwd = '';
  try {
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rows = (o.record && o.record.rows) || {};
    title = (rows.title && typeof rows.title.val === 'string') ? rows.title.val : '';
    const ti = rows.titleInput && rows.titleInput.val && rows.titleInput.val.first;
    first = (ti && typeof ti.text === 'string') ? ti.text : '';
    cwd = ((o.record && o.record.identity) || {}).cwd || '';
  } catch {}
  return { mt, title: (title || first).replace(/\s+/g, ' ').trim(), cwd };
}

function dshDiskIndex() {
  const bodies = new Set(); // 磁盘上真实存在正文目录的会话ID
  const sdir = path.join(DSH_ROOT, 'sessions');
  let slugs = [];
  try { slugs = fs.readdirSync(sdir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch {}
  for (const s of slugs) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(sdir, s.name), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isDirectory() && DSH_SESSION_RE.test(e.name)) bodies.add(e.name.toLowerCase());
  }
  const projs = new Set();
  const pdir = path.join(DSH_ROOT, 'storages', 'session_projcache', 'sessions');
  let files = [];
  try { files = fs.readdirSync(pdir); } catch {}
  for (const f of files) if (/\.json$/i.test(f) && DSH_SESSION_RE.test(f.replace(/\.json$/i, ''))) projs.add(f.replace(/\.json$/i, '').toLowerCase());
  return { bodies, projs };
}

function readDshTasks() {
  let ws = null;
  try { ws = JSON.parse(fs.readFileSync(path.join(DSH_ROOT, 'storages', 'workspace.json'), 'utf8')); } catch {}
  const g = (ws && ws.global) || {};
  const archived = new Set((g.archivedSessionIds || []).map((x) => x.toLowerCase()));
  const pinned = new Set((g.pinnedSessionIds || []).map((x) => x.toLowerCase()));
  const inIndex = new Map(); // 会话ID -> 工作区路径
  const tables = (ws && ws.tables && ws.tables.workspaces) || {};
  for (const w of Object.values(tables))
    for (const sid of w.sessionIds || []) inIndex.set(String(sid).toLowerCase(), w.path || '');

  const { bodies, projs } = dshDiskIndex();
  const ids = new Set([...inIndex.keys(), ...bodies, ...projs]);
  const list = [];
  for (const id of ids) {
    const proj = dshProj(id);
    const hasBody = bodies.has(id);
    let status = '';
    if (!inIndex.has(id)) status = '孤儿(不在工作区索引)';
    else if (!hasBody && !projs.has(id)) status = '仅索引残留';
    if (pinned.has(id)) status = (status ? status + ', ' : '') + '已置顶';
    list.push({
      task_id: id,
      title: (proj && proj.title) || (hasBody || projs.has(id) ? '(无标题)' : '(无对话记录, 仅剩索引)'),
      task_status: status,
      archived: archived.has(id) ? 1 : 0,
      deleted: 0,
      updated_at: (proj && proj.mt) || 0,
      cwd: (proj && proj.cwd) || inIndex.get(id) || '',
    });
  }
  list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return list;
}

/* ---------------- 1f. Kimi Code 会话列表 ----------------
   无数据库。全局索引是根目录的 session_index.jsonl (每行 {sessionId, sessionDir, workDir});
   会话本体 sessions/<wd_slug>/session_<uuid>/ (state.json 存标题/cwd/时间/archived,
   agents/main/wire.jsonl 是正文), 另有 server/events/session_<uuid>.jsonl 事件流。
   cache/query-store 与 sessions/.index-cache 是派生缓存, 见 TARGETS.kimi.cacheZones。 */
let kimiIndexCache = null;

function kimiSessionIndex() {
  if (kimiIndexCache) return kimiIndexCache;
  const map = new Map();
  const workOf = new Map(); // 索引里的 sessionId -> workDir
  try {
    for (const line of fs.readFileSync(path.join(KIMI_ROOT, 'session_index.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.sessionId) workOf.set(String(o.sessionId).toLowerCase(), o.workDir || '');
      } catch {}
    }
  } catch {}
  const sdir = path.join(KIMI_ROOT, 'sessions');
  let slugs = [];
  try { slugs = fs.readdirSync(sdir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch {}
  for (const s of slugs) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(sdir, s.name), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !KIMI_SESSION_RE.test(e.name)) continue;
      const id = e.name.toLowerCase();
      const dir = path.join(sdir, s.name, e.name);
      let st = null;
      try { st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch {}
      map.set(id, {
        dir,
        title: ((st && st.title) || (st && st.lastPrompt) || '').replace(/\s+/g, ' ').trim(),
        cwd: (st && st.cwd) || workOf.get(id) || '',
        updatedAt: (st && st.updatedAt) || 0,
        archived: st && st.archived ? 1 : 0,
        inIndex: workOf.has(id),
      });
    }
  }
  for (const [id, wd] of workOf)
    if (!map.has(id)) map.set(id, { dir: '', title: '', cwd: wd, updatedAt: 0, archived: 0, inIndex: true });
  kimiIndexCache = map;
  return map;
}

function readKimiTasks() {
  const list = [];
  for (const [id, v] of kimiSessionIndex()) {
    let status = '';
    if (!v.inIndex) status = '孤儿(不在会话索引)';
    else if (!v.dir) status = '仅索引残留';
    list.push({
      task_id: id,
      title: v.title || (v.dir ? '(无标题)' : '(无对话记录, 仅剩索引)'),
      task_status: status,
      archived: v.archived,
      deleted: 0,
      updated_at: v.updatedAt,
      cwd: v.cwd,
    });
  }
  list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return list;
}

/* 上传附件: 正文 wire.jsonl / 事件流里以 f_<uuid> 引用 files/ 下的本体, file/index.json 是登记表。
   会话删掉后附件就成孤儿, 故级联删除; 但同一附件可能被别的会话引用, 删前先确认。 */
const KIMI_FILE_RE = /f_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function kimiAttachmentIds(files) {
  const out = new Set();
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of buf.matchAll(KIMI_FILE_RE)) out.add(m[0]);
  }
  return out;
}

function kimiRecordPaths(ids) {
  const out = [];
  const idx = kimiSessionIndex();
  for (const id of ids) {
    const v = idx.get(id);
    if (v && v.dir) {
      out.push(path.join(v.dir, 'state.json'));
      out.push(path.join(v.dir, 'agents', 'main', 'wire.jsonl'));
    }
    const ev = path.join(KIMI_ROOT, 'server', 'events', id + '.jsonl');
    if (fs.existsSync(ev)) out.push(ev);
  }
  return out;
}

function scrubFileIndex(file, ids) {
  if (!fs.existsSync(file)) return;
  let o;
  try { o = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!o || !Array.isArray(o.files)) return;
  const drop = new Set(ids);
  const before = o.files.length;
  o.files = o.files.filter((f) => !(f && drop.has(f.id)));
  if (o.files.length === before) return;
  fs.writeFileSync(file, JSON.stringify(o, null, 2));
  console.log(`  [json] ${rel(file)}: 移除 ${before - o.files.length} 条已删会话的附件登记`);
}

/* pi 的压缩/分支/fork 都会派生出新的会话文件, 其头记录里写着父会话ID。
   若只删父会话, 逐行剔除会把子会话的头行也删掉(等于损坏子会话), 故整条派生链一起删。 */
function expandChain(ids) {
  if (TARGET !== 'pi') return ids;
  const idx = piSessionIndex();
  const out = [];
  for (const raw of ids) {
    const id = raw.toLowerCase();
    for (const c of collectPiChain(id)) {
      if (out.includes(c)) continue;
      if (c !== id) {
        const v = idx.get(c);
        console.log(`  级联纳入派生会话 ${c}${v && v.title ? ` | ${v.title.slice(0, 24)}` : ''}`);
      }
      out.push(c);
    }
  }
  return out;
}

function printMenu(tasks) {
  console.log('\n========== 本地对话列表 ==========');
  tasks.forEach((t, i) => {
    const marks = [t.archived ? '已归档' : '', t.deleted ? '已删除' : ''].filter(Boolean).join(',');
    // 标题可能带换行(粘贴的多行内容被当成标题), 压平否则菜单错位
    const title = (t.title || '(无标题)').replace(/\s+/g, ' ').trim().slice(0, 38);
    console.log(`  [${i + 1}] ${t.task_id}`);
    console.log(`      ${title}${title.length >= 38 ? '...' : ''} | ${t.task_status || '-'}${marks ? ' | ' + marks : ''} | ${fmtTime(t.updated_at)}`);
    if (t.cwd) console.log(`      目录: ${maskPath(t.cwd)}`);
  });
  console.log('==================================\n');
}

// 多选输入: "1 3 5" / "1,3,5" / "2-4" 混用均可; 任一段非法或越界返回 null
const parseSelection = (input, max) => {
  const out = [];
  for (const tok of input.split(/[\s,，]+/).filter(Boolean)) {
    const m = tok.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const from = Number(m[1]), to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to > max || from > to) return null;
    for (let i = from; i <= to; i++) if (!out.includes(i)) out.push(i);
  }
  return out.length ? out : null;
};

/* ---------------- 2. 全盘扫描 ---------------- */
function scanAll(id) {
  const needle = Buffer.from(id);
  const namedDirs = [], namedFiles = [], contentHits = [], skipped = [];
  const stack = ROOTS.map((r) => ({ dir: r.dir, prune: r.prune }));
  let count = 0;
  process.stdout.write('  扫描中');
  while (stack.length) {
    const { dir, prune } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (p === SELF) continue;
      if (e.isDirectory()) {
        if (prune.has(e.name)) continue; // 程序本体/内核缓存等无会话数据的重目录
        if (e.name.includes(id)) { namedDirs.push(p); continue; } // 整个目录归属该会话, 不再下钻
        stack.push({ dir: p, prune });
      } else {
        count++;
        if (count % 200 === 0) process.stdout.write('.');
        if (e.name.includes(id)) { namedFiles.push(p); continue; }
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.size > 200 * 1048576) { skipped.push(rel(p)); continue; }
        let buf;
        try { buf = fs.readFileSync(p); } catch { continue; }
        let idx = 0, n = 0;
        while ((idx = buf.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
        if (n) contentHits.push({ p, n, size: st.size });
      }
    }
  }
  process.stdout.write('\n');
  return { namedDirs, namedFiles, contentHits, skipped, count };
}

/* ---------------- 3. 数据库归属分析 ----------------
   区分两种字节命中:
   - 自身数据行: session/tasks 等表中真正属于该会话的行 (需要删除)
   - 他处引用:   其他对话正文里出现了这串ID (如用户粘贴的终端输出, 不能也不应删) */
const LINK_COLS = ['session_id', 'conversation_id', 'task_id', 'target_task_id'];

function collectIds(db, id) {
  // 沿父会话关系收集派生会话:
  //   zcode: session.parent_id (子代理等)
  //   qoder: chat_sessions.origin_session_id / owner_session_id (fork / side-chat)
  const all = [id];
  const hasSession = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session'").get();
  const hasChat = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_sessions'").get();
  if (!hasSession && !hasChat) return all;
  let frontier = [id];
  while (frontier.length) {
    const ph = frontier.map(() => '?').join(',');
    const next = [];
    if (hasSession)
      next.push(...db.prepare(`SELECT id FROM session WHERE parent_id IN (${ph})`).all(...frontier).map((r) => r.id));
    if (hasChat) {
      next.push(...db.prepare(`SELECT session_id FROM chat_sessions WHERE origin_session_id IN (${ph})`).all(...frontier).map((r) => r.session_id));
      next.push(...db.prepare(`SELECT session_id FROM chat_sessions WHERE owner_session_id IN (${ph})`).all(...frontier).map((r) => r.session_id));
    }
    const fresh = next.filter((x) => x && !all.includes(x));
    all.push(...fresh);
    frontier = fresh;
  }
  return all;
}

function countOwn(db, ids) {
  const ph = ids.map(() => '?').join(',');
  const detail = [];
  let total = 0;
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => c.name);
    let n = 0;
    if (t.name === 'session' && cols.includes('id'))
      n += db.prepare(`SELECT COUNT(*) c FROM session WHERE id IN (${ph})`).get(...ids).c;
    for (const col of LINK_COLS)
      if (cols.includes(col))
        n += db.prepare(`SELECT COUNT(*) c FROM "${t.name}" WHERE "${col}" IN (${ph})`).get(...ids).c;
    if (n) { detail.push(`${t.name} ×${n}`); total += n; }
  }
  return { total, detail };
}

function dbOwnRows(file, id) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return countOwn(db, collectIds(db, id)); }
    finally { db.close(); }
  } catch (e) {
    return { total: -1, detail: ['读取失败: ' + e.message] };
  }
}

/* ---------------- 4. 分类清理计划 ---------------- */
function buildPlan(s, id) {
  const creds = [];
  const isCred = (p) => CRED_FILES.has(path.basename(p).toLowerCase());
  const whole = [];
  for (const p of [...s.namedDirs, ...s.namedFiles]) {
    if (isCred(p)) creds.push({ p, n: 0, size: 0 });
    else whole.push(p);
  }
  const dbs = [], dbRefs = [], texts = [], jsons = [], manual = [], live = [];
  const baseDb = (p) => (/\.sqlite(-wal)?$/i.test(p) ? p.replace(/-wal$/i, '') : null);
  const dbSeen = new Set();
  const cacheZones = TARGETS[TARGET].cacheZones || [];
  for (const h of s.contentHits) {
    // 凭据文件即使字节命中也绝不改写, 只报告
    if (isCred(h.p)) { creds.push(h); continue; }
    if (/-shm$/i.test(h.p)) continue; // 共享内存索引, 无正文
    // 派生缓存(kimi 的搜索索引/列表扫描缓存): 无法外科剔除单条, 命中即整目录删, 客户端会重建
    const cz = cacheZones.find((z) => underDir(h.p, z));
    if (cz) { if (!whole.includes(cz)) whole.push(cz); continue; }
    const db = baseDb(h.p);
    if (db) {
      if (dbSeen.has(db)) continue;
      dbSeen.add(db);
      // 同一库可能命中主文件和wal, 只处理一次; 并做归属预检
      const own = dbOwnRows(db, id);
      if (own.total > 0) dbs.push({ file: db, own });
      else dbRefs.push({ file: db, own });
      continue;
    }
    if (/[\\/]crash[\\/]/i.test(h.p)) { whole.push(h.p); continue; } // 崩溃转储可整删
    // 进程注册表(Claude 的 sessions/<pid>.json): 挖掉 sessionId 只会留下残缺注册项,
    // 故连同配套的 <pid>.<hash>.key 一起整删
    const reg = TARGETS[TARGET].liveRegistry;
    if (reg && /\.json$/i.test(h.p) && underDir(h.p, reg)) {
      const dir = path.dirname(h.p), base = path.basename(h.p);
      const stem = base.replace(/\.json$/i, '');
      whole.push(h.p);
      live.push(h.p);
      let sibs = [];
      try { sibs = fs.readdirSync(dir); } catch {}
      for (const f of sibs) if (f !== base && f.startsWith(stem + '.')) whole.push(path.join(dir, f));
      continue;
    }
    const ext = path.extname(h.p).toLowerCase();
    if (ext === '.json') jsons.push(h);
    else if (ext === '.log' || ext === '.txt' || ext === '.jsonl') texts.push(h);
    else if (isJsonBlob(h.p)) jsons.push(h);
    else manual.push(h);
  }
  return { whole: [...new Set(whole)].sort(), dbs, dbRefs, texts, jsons, manual, live, creds };
}

/* ---------------- 4b. 容器目录整体提升 (Qoder / Claude / pi) ----------------
   projects/<slug> (Qoder 另有 logs/sessions/<slug>, pi 为 sessions/<cwd编码>) 按工作目录
   命名, 名称本身不含会话ID, 靠内部文件才能归属。若容器内所有会话都属于本次
   删除对象(含派生会话), 则整目录删除(含项目级 memory), 做到删干净;
   存在其他会话时只删归属本会话的项, 不误伤邻居。 */
// 从文件名反解会话ID: 多数产品直接用 <会话ID>.jsonl, pi 用 <时间戳>_<会话ID>.jsonl,
// DeepSeek Harness 用 session-<会话ID> 作目录名、session-<会话ID>.json 作投影缓存名
function idFromName(name) {
  const stem = name.replace(/\.jsonl$/i, '');
  if (UUID_RE.test(stem)) return stem.toLowerCase();
  const m = name.match(PI_FILE_RE);
  if (m) return m[1].toLowerCase();
  const d = name.match(/^(session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.json)?$/i);
  if (d) return d[1].toLowerCase();
  const k = name.match(/^(session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i);
  return k ? k[1].toLowerCase() : '';
}

function promoteContainers(plan, idSet) {
  const zones = TARGETS[TARGET].containerZones || [];
  const owned = new Set(idSet.map((x) => x.toLowerCase()));
  const inZone = (p) => zones.some((z) => {
    const r = path.relative(z, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r);
  });
  const containers = new Set();
  for (const p of plan.whole) {
    const sid = idFromName(path.basename(p));
    if (!sid || !owned.has(sid)) continue; // 只有能反解出会话ID的项才能锚定容器
    const parent = path.dirname(p);
    if (inZone(parent)) containers.add(parent);
  }
  const promoted = [];
  for (const c of containers) {
    let entries;
    try { entries = fs.readdirSync(c, { withFileTypes: true }); } catch { continue; }
    const hasForeign = entries.some((e) => {
      const sid = idFromName(e.name);
      return sid && !owned.has(sid);
    });
    if (!hasForeign) promoted.push(c);
  }
  if (!promoted.length) return;
  const under = (p, d) => p === d || p.startsWith(d + path.sep);
  const subsumed = (p) => promoted.some((d) => under(p, d));
  plan.whole = plan.whole.filter((p) => !subsumed(p));
  plan.texts = plan.texts.filter((h) => !subsumed(h.p));
  plan.jsons = plan.jsons.filter((h) => !subsumed(h.p));
  plan.manual = plan.manual.filter((h) => !subsumed(h.p));
  plan.dbs = plan.dbs.filter((d) => !subsumed(d.file));
  plan.whole = [...new Set([...plan.whole, ...promoted])].sort();
}

function showPlan(plan) {
  let bytes = 0;
  console.log('\n---------- 该对话的数据分布在以下位置 ----------');
  if (plan.whole.length) {
    console.log('\n[整文件/整目录删除] (专属于该对话):');
    for (const p of plan.whole) {
      let sz = 0, extra = '';
      try {
        if (fs.statSync(p).isDirectory()) { const d = dirSize(p); sz = d.bytes; extra = ` (${d.files} 个文件)`; }
        else sz = fs.statSync(p).size;
      } catch {}
      bytes += sz;
      console.log(`   ${rel(p)}${extra} - ${fmtBytes(sz)}`);
    }
  }
  if (plan.live && plan.live.length) {
    console.log('\n[!] 该会话似乎仍在运行 (命中进程注册表), 注册文件与配套密钥已一并纳入删除:');
    for (const p of plan.live) console.log(`   ${rel(p)}`);
    console.log(`   建议先完全退出 ${clientName()} 再执行, 否则注册项可能被重新写回。`);
  }
  if (plan.dbs.length) {
    console.log('\n[SQLite 数据库] (清除该会话自身数据行 + VACUUM 收缩文件):');
    for (const d of plan.dbs)
      console.log(`   ${rel(d.file)} - 自身数据 ${d.own.detail.join(', ')}; 当前 ${fmtBytes(fs.statSync(d.file).size)}`);
  }
  if (plan.dbRefs.length) {
    console.log('\n[数据库中仅有"引用", 无自身数据] (无需删除, 仅说明):');
    for (const d of plan.dbRefs)
      console.log(`   ${rel(d.file)} - 字节命中来自其他对话正文里引用了这串ID(如粘贴的终端输出),`);
    console.log('   这些引用会随宿主对话的删除而自然消失, 不是本会话的残留。');
  }
  if (plan.texts.length) {
    console.log('\n[文本/日志] (逐行剔除含该会话ID的行):');
    for (const h of plan.texts) { bytes += h.size; console.log(`   ${rel(h.p)} - ${h.n} 处, ${fmtBytes(h.size)}`); }
  }
  if (plan.jsons.length) {
    console.log('\n[JSON 配置] (剔除引用该会话的字段):');
    for (const h of plan.jsons) { bytes += h.size; console.log(`   ${rel(h.p)} - ${h.n} 处, ${fmtBytes(h.size)}`); }
  }
  if (plan.manual.length) {
    console.log('\n[!] 以下二进制文件包含该会话ID但无法安全外科清理, 请人工确认:');
    for (const h of plan.manual) console.log(`   ${rel(h.p)} - ${h.n} 处, ${fmtBytes(h.size)}`);
  }
  if (plan.creds.length) {
    console.log('\n[凭据文件] (命中该会话ID, 但绝不改写/删除, 仅告知):');
    for (const h of plan.creds) console.log(`   ${rel(h.p)}`);
    console.log('   这些文件保存登录凭据, 里面出现会话ID只是历史记录, 动它会导致需要重新登录。');
  }
  const czs = TARGETS[TARGET].cacheZones || [];
  const hitCz = czs.length ? plan.whole.filter((p) => czs.some((z) => underDir(p, z))) : [];
  if (hitCz.length) {
    console.log('\n[派生缓存] 以下目录是按会话内容建的索引/缓存, 无法只剔单条, 整目录删除后客户端下次启动重建:');
    for (const p of hitCz) console.log(`   ${rel(p)}`);
  }
  if (plan.fileIndex && plan.fileIndex.length)
    console.log(`\n[附件登记] ${rel(plan.fileIndexFile)} 将同步移除 ${plan.fileIndex.length} 条已删会话的附件记录。`);
  if (plan.dbRefs.length && !plan.dbs.length && !plan.whole.length && !plan.texts.length && !plan.jsons.length)
    console.log('\n结论: 该会话自身数据已全部清除, 磁盘上只剩其他对话对它的引用。');
  else
    console.log(`\n直接可释放约 ${fmtBytes(bytes)}${plan.dbs.length ? '; 数据库收缩量取决于其中该会话占比' : ''}。`);
}

/* ---------------- 5. 执行删除 ---------------- */
function scrubDb(file, id) {
  // 同批次更早的会话可能已把该库所在容器目录整删
  if (!fs.existsSync(file)) return;
  // 只读预检(客户端运行中也能执行), 自身行已为0则跳过写库
  const pre = dbOwnRows(file, id);
  if (pre.total === 0) {
    console.log(`  [db] ${rel(file)}: 该会话自身无数据行, 跳过 (字节命中为他处引用)`);
    return;
  }
  if (pre.total < 0) throw new Error('无法读取数据库');

  const db = new DatabaseSync(file);
  try {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    const ids = collectIds(db, id);
    const ph = ids.map(() => '?').join(',');
    let removed = 0;
    const detail = [];
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => c.name);
      if (t.name === 'session' && cols.includes('id')) {
        const n = db.prepare(`DELETE FROM session WHERE id IN (${ph})`).run(...ids).changes;
        if (n) { detail.push(`session ×${n}`); removed += n; }
      }
      for (const col of LINK_COLS) {
        if (!cols.includes(col)) continue;
        const n = db.prepare(`DELETE FROM "${t.name}" WHERE "${col}" IN (${ph})`).run(...ids).changes;
        if (n) { detail.push(`${t.name} ×${n}`); removed += n; }
      }
    }
    // 全文索引兜底重建: 外部内容型 fts5 表与已删行重新同步 (正常由触发器随 DELETE 联动)
    for (const v of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5(%'").all()) {
      try { db.exec(`INSERT INTO "${v.name}"("${v.name}") VALUES('rebuild')`); } catch {}
    }
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    db.exec('VACUUM'); // 重写数据库文件, 真正抹去已删内容
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    // 删后立即复查, 捕捉"客户端在运行中把行写回"的情况
    const post = countOwn(db, collectIds(db, id));
    console.log(`  [db] ${rel(file)}: 清除 ${removed} 行 (${detail.join(', ')})` + (post.total > 0 ? `  [!] 删后复查仍有 ${post.total} 行, 客户端可能在运行中写回, 请退出客户端后重跑` : ''));
  } finally {
    db.close();
  }
}

function filterLines(file, id) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const kept = lines.filter((l) => !l.includes(id));
  if (kept.length === lines.length) return;
  fs.writeFileSync(file, kept.join('\n'));
  console.log(`  [文本] ${rel(file)}: 剔除 ${lines.length - kept.length} 行`);
}

/* 无扩展名的落盘文件也可能整个就是一段 JSON (kimi 把 file-history/<工作区slug> 存成裸 JSON,
   里面按会话ID记录哪些会话动过文件)。能解析就交给外科剔除, 解析不动才退回"人工确认"。 */
function isJsonBlob(p) {
  try {
    if (fs.statSync(p).size > 8 * 1024 * 1024) return false;
    const raw = fs.readFileSync(p, 'utf8');
    if (!/^\s*[[{]/.test(raw)) return false;
    JSON.parse(raw);
    return true;
  } catch { return false; }
}

/* 数组元素常是"某个会话的一条记录"(如 {id: session_X, touchedAt: ...})。这种元素要整条摘掉:
   只挖掉 id 字段会留下 {touchedAt: ...} 这类认不出归属的残缺项。
   只对数组元素生效, 顶层对象仍按字段逐个清理, 免得把整个配置文件清空。 */
const isSessionRecord = (x, id) => !!x && typeof x === 'object' && !Array.isArray(x) &&
  Object.entries(x).some(([k, v]) => typeof v === 'string' && v.includes(id) && /id|session|task/i.test(k));

function deepClean(v, id) {
  if (typeof v === 'string') return v.includes(id) ? undefined : v;
  if (Array.isArray(v)) return v.filter((x) => !isSessionRecord(x, id)).map((x) => deepClean(x, id)).filter((x) => x !== undefined);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      const c = deepClean(val, id);
      if (c !== undefined) o[k] = c;
    }
    return o;
  }
  return v;
}

function scrubJson(file, id) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  let obj;
  try { obj = JSON.parse(raw); } catch { return filterLines(file, id); }
  const cleaned = deepClean(obj, id);
  if (JSON.stringify(cleaned) === JSON.stringify(obj)) return;
  fs.writeFileSync(file, JSON.stringify(cleaned, null, 2));
  console.log(`  [json] ${rel(file)}: 已剔除引用该会话的字段`);
}

function doDelete(plan, id) {
  console.log('\n开始删除...');
  for (const p of plan.whole) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`  [删除] ${rel(p)}`);
    } catch (e) {
      console.error(`  [失败] ${rel(p)}: ${e.message}`);
    }
  }
  for (const d of plan.dbs) {
    try { scrubDb(d.file, id); }
    catch (e) {
      console.error(`  [失败] ${rel(d.file)}: ${e.message} (客户端是否仍在运行?)`);
    }
  }
  for (const h of plan.texts) { try { filterLines(h.p, id); } catch (e) { console.error(`  [失败] ${rel(h.p)}: ${e.message}`); } }
  for (const h of plan.jsons) { try { scrubJson(h.p, id); } catch (e) { console.error(`  [失败] ${rel(h.p)}: ${e.message}`); } }
  if (plan.fileIndex && plan.fileIndex.length) {
    try { scrubFileIndex(plan.fileIndexFile, plan.fileIndex); }
    catch (e) { console.error(`  [失败] ${rel(plan.fileIndexFile)}: ${e.message}`); }
  }
}

/* ---------------- 5b. 回收空容器目录 ----------------
   批量删除时容器提升是在计划阶段判定的(那时同 slug 的邻居会话还在), 全批删完后
   projects/<slug> 往往只剩空目录壳(含空的 memory/)。只有整棵子树一个文件都不剩时
   才自底向上 rmdir; 只要还有任何文件(别的会话、项目级 memory)就一律不动。 */
function subtreeHasFile(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) stack.push(q);
      else return true;
    }
  }
  return false;
}

function pruneEmptyContainers() {
  const zones = TARGETS[TARGET].containerZones || [];
  if (!zones.length) return;
  const removed = [];
  const dropTree = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) if (e.isDirectory() && !dropTree(path.join(dir, e.name))) return false;
    try { fs.rmdirSync(dir); removed.push(dir); return true; } catch { return false; }
  };
  for (const z of zones) {
    let slugs = [];
    try { slugs = fs.readdirSync(z, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
    for (const s of slugs) {
      // 点开头的目录是客户端自己的元数据(kimi 的 .index-cache / .index-dirty), 不是会话容器
      if (s.name.startsWith('.')) continue;
      const p = path.join(z, s.name);
      if (subtreeHasFile(p)) continue;
      dropTree(p);
    }
  }
  if (!removed.length) return;
  console.log('\n回收已空的容器目录:');
  for (const p of removed) console.log(`  [空目录] ${rel(p)}`);
}

/* ---------------- 6. 复扫验证 (区分自身残留与他处引用) ---------------- */
function verify(id) {
  console.log('\n复扫验证中...');
  const left = scanAll(id);
  const leftover = [...new Set([...left.namedDirs, ...left.namedFiles, ...left.contentHits.map((h) => h.p)])];
  if (!leftover.length) {
    console.log('验证通过: 磁盘上已无该会话ID的任何痕迹。');
    return;
  }
  const trueResidue = [], refOnly = [], credOnly = [];
  for (const p of leftover) {
    if (CRED_FILES.has(path.basename(p).toLowerCase())) { credOnly.push(rel(p)); continue; }
    const base = p.replace(/-wal$/i, '');
    if (/\.sqlite$/i.test(base)) {
      const own = dbOwnRows(base, id);
      if (own.total > 0) trueResidue.push(`${rel(base)} (自身数据行未清: ${own.detail.join(', ')})`);
      else refOnly.push(rel(p));
    } else trueResidue.push(rel(p));
  }
  if (credOnly.length) {
    console.log('\n[凭据文件, 有意保留] 以下文件仍能检索到该ID字符串, 但保存的是登录凭据, 本工具绝不改写:');
    for (const p of credOnly) console.log('   ' + p);
  }
  if (refOnly.length) {
    console.log('\n[引用型命中, 非残留] 以下文件仍能检索到该ID字符串, 但其中已无该会话自身的数据行:');
    for (const p of refOnly) console.log('   ' + p);
    console.log('   来源是其他对话正文引用了这串ID(如粘贴的终端输出)或数据库wal旧帧,');
    console.log('   会随宿主对话的删除/下次checkpoint自然消失, 无需处理。');
  }
  if (trueResidue.length) {
    console.log('\n[!] 真残留, 建议完全退出客户端后重跑:');
    for (const p of trueResidue) console.log('   ' + p);
  }
  if (!trueResidue.length && refOnly.length)
    console.log('\n结论: 该会话自身数据已全部清除。');
}

/* ---------------- 主流程 ---------------- */
(async () => {
  console.log('ZCode / Qoder / Claude Code / pi / DeepSeek Harness / Kimi Code 会话数据一键清理工具');

  // 目标选择: 命令行参数优先 (qoder / zcode / claude / pi / dsh / kimi), 否则弹选择框
  // sess_ / session- / session_ 前缀能安全推断目标; Qoder / Claude / pi 的会话ID同为 UUID, 必须让用户选
  if (targetArg) TARGET = /^deepseek$/i.test(targetArg) ? 'dsh' : targetArg.toLowerCase();
  else if (/^sess_/.test(idArg)) TARGET = 'zcode';
  else if (DSH_SESSION_RE.test(idArg)) TARGET = 'dsh';
  else if (KIMI_SESSION_RE.test(idArg)) TARGET = 'kimi';
  else {
    console.log('\n请选择要清理的目标:');
    console.log('  [1] Qoder');
    console.log('  [2] ZCode');
    console.log('  [3] Claude Code');
    console.log('  [4] pi');
    console.log('  [5] DeepSeek Harness');
    console.log('  [6] Kimi Code');
    const a = (await ask('输入编号选择 (回车取消): ')).trim();
    if (a === '1' || /qoder/i.test(a)) TARGET = 'qoder';
    else if (a === '2' || /zcode/i.test(a)) TARGET = 'zcode';
    else if (a === '3' || /claude/i.test(a)) TARGET = 'claude';
    else if (a === '4' || /^pi$/i.test(a)) TARGET = 'pi';
    else if (a === '5' || /deepseek|^dsh$/i.test(a)) TARGET = 'dsh';
    else if (a === '6' || /kimi/i.test(a)) TARGET = 'kimi';
    else { console.log('已取消。'); rl.close(); return; }
  }
  ROOTS = TARGETS[TARGET].roots;

  console.log(`\n目标: ${TARGETS[TARGET].label}`);
  console.log('扫描根目录:');
  for (const r of ROOTS) console.log('  ' + maskPath(r.dir));
  console.log(`提醒: 实际删除前请完全退出 ${clientName()} (含托盘); 删除不可恢复。\n`);

  const tasks = TARGET === 'qoder' ? readQoderTasks()
    : TARGET === 'claude' ? readClaudeTasks()
    : TARGET === 'pi' ? readPiTasks()
    : TARGET === 'dsh' ? readDshTasks()
    : TARGET === 'kimi' ? readKimiTasks()
    : readTasks();
  // 列表为空不一定要退出: 命令行显式给了ID时(如只剩孤零零残留的会话)仍按磁盘扫描处理
  if (!tasks.length && !idArg) { console.log('未找到任何本地对话 (或会话索引不可读), 退出。'); rl.close(); return; }

  let chosenList = [];
  if (idArg) {
    chosenList = expandChain([idArg]);
    if (!tasks.some((t) => t.task_id === idArg)) console.log(`注意: ${idArg} 不在会话索引中, 将按磁盘扫描结果处理。\n`);
  } else {
    printMenu(tasks);
    const a = (await ask('输入编号选择对话, 支持多选(如 1 3 5 或 2-4; 也可直接粘贴会话ID; 回车取消): ')).trim();
    if (!a) { console.log('已取消。'); rl.close(); return; }
    const idxs = parseSelection(a, tasks.length);
    if (idxs) chosenList = expandChain(idxs.map((i) => tasks[i - 1].task_id));
    else {
      const t = tasks.find((x) => x.task_id === a);
      if (!t) { console.log('选择无效, 退出。'); rl.close(); return; }
      chosenList = expandChain([t.task_id]);
    }
    console.log(`\n已选择 ${chosenList.length} 个对话:`);
    for (const id of chosenList) {
      const t = tasks.find((x) => x.task_id === id);
      console.log(`  ${id} | ${((t && t.title) || '(无标题)').slice(0, 30)}`);
    }
    console.log('提示: 若其中包含当前正在进行的对话, 建议先聊完再删。');
  }

  /* kimi 附件级联: 对话里上传的文件落在 files/f_<uuid>, 只被会话正文(state.json /
     wire.jsonl / server/events)按ID引用, 全盘扫描扫不到。先收集本批会话引用的附件,
     再扣掉其他未选中会话仍在引用的, 剩下的才随会话一起删。 */
  let kimiDrop = [];
  let kimiDropReg = [];
  if (TARGET === 'kimi' && chosenList.length) {
    const used = kimiAttachmentIds(kimiRecordPaths(chosenList));
    const kept = kimiAttachmentIds(kimiRecordPaths(
      [...kimiSessionIndex().keys()].filter((x) => !chosenList.includes(x))));
    kimiDrop = [...used].filter((f) => !kept.has(f)).sort();
    // 正文里引用的附件ID不一定都登记在 file/index.json (粘贴的临时图片等), 登记数按实际
    // 存在的算, 免得回显"移除 N 条"和真正摘掉的数量对不上
    const reg = new Set();
    try {
      const o = JSON.parse(fs.readFileSync(path.join(KIMI_ROOT, 'file', 'index.json'), 'utf8'));
      for (const f of (o && o.files) || []) if (f && f.id) reg.add(f.id);
    } catch {}
    kimiDropReg = kimiDrop.filter((f) => reg.has(f));
  }
  let kimiDropAssigned = false;

  const plans = [];
  for (const chosen of chosenList) {
    console.log(`\n开始全盘扫描 [${chosen}], 检索该对话存在于哪些文件...`);
    const s = scanAll(chosen);
    console.log(`已扫描 ${s.count} 个文件; 命名命中 ${s.namedDirs.length} 个目录 + ${s.namedFiles.length} 个文件, 内容命中 ${s.contentHits.length} 个文件${s.skipped.length ? `; 跳过超大文件 ${s.skipped.length} 个` : ''}`);

    const plan = buildPlan(s, chosen);
    if ((TARGETS[TARGET].containerZones || []).length) {
      // 项目目录按工作目录命名(不含会话ID), 需单独判断能否整目录删除
      // 派生会话与本会话算同一批: qoder 查 main.sqlite, pi 查会话文件头记录; claude 无派生关系
      let ids = [chosen];
      if (TARGET === 'qoder') {
        try {
          const db = new DatabaseSync(qoderDb(), { readOnly: true });
          try { ids = collectIds(db, chosen); } finally { db.close(); }
        } catch {}
      } else if (TARGET === 'pi') ids = collectPiChain(chosen);
      promoteContainers(plan, ids);
    }
    if (!plan.whole.length && !plan.dbs.length && !plan.dbRefs.length && !plan.texts.length && !plan.jsons.length && !plan.manual.length) {
      if (plan.creds.length) {
        console.log('仅在凭据文件里命中该会话ID, 这类文件不做任何修改:');
        for (const h of plan.creds) console.log('   ' + rel(h.p));
      }
      console.log('未在磁盘上找到该对话的可删数据, 跳过。');
      continue;
    }
    if (kimiDrop.length && !kimiDropAssigned) {
      // 附件登记只在一个计划里挂一次: scrubFileIndex 幂等, 但每个计划都挂会重复回显
      kimiDropAssigned = true;
      for (const f of kimiDrop) {
        const p = path.join(KIMI_ROOT, 'files', f);
        if (fs.existsSync(p) && !plan.whole.includes(p)) plan.whole.push(p);
      }
      plan.fileIndex = kimiDropReg;
      plan.fileIndexFile = path.join(KIMI_ROOT, 'file', 'index.json');
    }
    plans.push({ id: chosen, plan });
  }

  /* 同批次交叉引用去重: 一个会话的正文里常出现另一个会话的ID(pi 的父子链、
     粘贴到对话里的终端输出等)。若那个文件本身已在本批次里被整删, 就不必再逐行
     剔除 —— 否则等于先改写再删除, 白做功, 顺序反过来还会因文件已不存在而报失败。 */
  const doomed = [];
  for (const { plan } of plans) doomed.push(...plan.whole);
  if (doomed.length > 1) {
    const isDoomed = (p) => doomed.some((d) => underDir(p, d));
    for (let i = plans.length - 1; i >= 0; i--) {
      const { id, plan } = plans[i];
      for (const k of ['texts', 'jsons', 'manual']) plan[k] = plan[k].filter((h) => !isDoomed(h.p));
      if (!plan.whole.length && !plan.dbs.length && !plan.dbRefs.length
        && !plan.texts.length && !plan.jsons.length && !plan.manual.length) {
        console.log(`\n会话 ${id} 的数据只存在于本批次其他会话的文件中, 随之一并清除。`);
        plans.splice(i, 1);
      }
    }
  }

  if (!plans.length) { rl.close(); return; }
  for (const { id, plan } of plans) {
    console.log(`\n########## 会话 ${id} 的数据分布 ##########`);
    showPlan(plan);
  }

  const ok = (await ask('\n确认一键删除以上全部内容? 输入 yes 确认, 其他任意输入取消: ')).trim().toLowerCase();
  if (ok !== 'yes' && ok !== 'y') { console.log('已取消, 未做任何修改。'); rl.close(); return; }

  for (const { id, plan } of plans) doDelete(plan, id);
  pruneEmptyContainers();
  for (const { id } of plans) verify(id);
  console.log(`\n完成。建议重启 ${clientName()} 确认列表; 云端同步的对话可能在下次同步时重新出现。`);
  rl.close();
})().catch((e) => { console.error('发生错误: ' + (e.stack || e.message)); rl.close(); process.exitCode = 1; });
