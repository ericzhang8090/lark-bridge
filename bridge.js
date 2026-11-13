#!/usr/bin/env node
// 飞书私人机器人 <-> Claude Code 桥接程序
//   lark-cli event consume im.message.receive_v1 --as bot   (长连接收消息)
//   -> 过滤（仅单聊 + 指定 open_id）
//   -> claude -p（只允许调用 lark-cli）
//   -> lark-cli im +messages-send --as bot                   (回复)
// 用法：node bridge.js          常驻运行
//       node bridge.js --check  自检（路径、飞书身份、claude）
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

// ---------- 路径 ----------
const ROOT = __dirname;
const WORK_DIR = path.join(ROOT, 'work');
const OUTBOX_DIR = path.join(WORK_DIR, 'outbox');
const LOG_DIR = path.join(ROOT, 'logs');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');
const SYSTEM_PROMPT_FILE = path.join(ROOT, 'system-prompt.md');
const EVENT_KEY = 'im.message.receive_v1';
const LARK_REL = path.join('node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe');

for (const d of [WORK_DIR, OUTBOX_DIR, LOG_DIR, STATE_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- 配置 ----------
const DEFAULTS = {
  allowedOpenId: '',
  larkCliExe: '',
  claudeExe: '',
  skillsDir: '',
  claudeModel: '',
  claudeTimeoutMinutes: 10,
  ackText: '收到，处理中…',
  maxReplyChars: 4000,
  maxMessageAgeMinutes: 30,
  sessionIdleResetHours: 24,
  allowGroups: true, // 群聊里 @机器人 时也处理（仍然只认白名单发送者）
  botOpenId: '', // 留空则启动时自动获取
  groupAckEmoji: 'OnIt', // 群聊里用表情回应代替"处理中"文字，留空则不回应
};

function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  return JSON.parse(raw.replace(/^﻿/, '')); // 文件存在但格式错误时直接报错
}

const cfg = Object.assign({}, DEFAULTS, readJson(path.join(ROOT, 'config.json'), {}));
if (!/^ou_[0-9a-z]+$/i.test(cfg.allowedOpenId)) {
  console.error('config.json 不存在或 allowedOpenId 无效：请把 config.example.json 复制为 config.json，并填写 allowedOpenId');
  process.exit(3);
}

// ---------- 日志 ----------
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function log(level, ...args) {
  const d = new Date();
  const line = `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} [${level}] ${util.format(...args)}`;
  (level === 'ERROR' || level === 'WARN' ? console.error : console.log)(line);
  try { fs.appendFileSync(path.join(LOG_DIR, `bridge-${localDate(d)}.log`), line + os.EOL); } catch { /* ignore */ }
}
const preview = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

// ---------- 可执行文件定位 ----------
function firstExisting(list) {
  for (const p of list) if (p && fs.existsSync(p)) return p;
  return null;
}
function otherUserHomes() {
  const base = path.dirname(os.homedir());
  try { return fs.readdirSync(base).map((n) => path.join(base, n)).filter((p) => p !== os.homedir()); } catch { return []; }
}

function resolveLark() {
  return firstExisting([
    cfg.larkCliExe,
    path.join(process.env.APPDATA || '', 'npm', LARK_REL),
    ...otherUserHomes().map((h) => path.join(h, 'AppData', 'Roaming', 'npm', LARK_REL)),
  ]);
}

function resolveClaude() {
  if (cfg.claudeExe) return fs.existsSync(cfg.claudeExe) ? cfg.claudeExe : null;
  const w = spawnSync('where.exe', ['claude.exe'], { encoding: 'utf8', windowsHide: true });
  if (w.status === 0) {
    const p = w.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (p) return p;
  }
  const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(local)) return local;
  // VS Code 扩展自带的 claude.exe（扩展更新后目录会变，所以每次调用都重新找）
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const found = fs.readdirSync(extDir)
      .filter((n) => /^anthropic\.claude-code-/i.test(n))
      .map((n) => path.join(extDir, n, 'resources', 'native-binary', 'claude.exe'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (found[0]) return found[0];
  } catch { /* ignore */ }
  return null;
}

function resolveSkillsDir() {
  if (cfg.skillsDir) return fs.existsSync(cfg.skillsDir) ? cfg.skillsDir : null;
  const hit = firstExisting([os.homedir(), ...otherUserHomes()].map((h) => path.join(h, '.agents', 'skills', 'lark-shared')));
  return hit ? path.dirname(hit) : null;
}

// 子进程环境：把 lark-cli.exe 所在目录、npm 目录、node 目录放到 PATH 最前面，
// 这样 Claude 在 PowerShell 里写 `lark-cli` 能直接找到原生 exe（也兼容 lark-cli.cmd）。
function childEnv() {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
  const extra = [];
  const lark = resolveLark();
  if (lark) {
    const binDir = path.dirname(lark);
    extra.push(binDir, path.resolve(binDir, '..', '..', '..', '..'));
  }
  extra.push(path.dirname(process.execPath));
  env[key] = [...extra, env[key] || ''].join(';');
  return env;
}

// ---------- 进程工具 ----------
const running = new Set();

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

// 直接以参数数组启动 exe，不经过 cmd.exe，避免 & | ^ % " 等字符被解释
function runProcess(exe, args, { input = null, cwd = WORK_DIR, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = spawn(exe, args, { cwd, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ code: -1, stdout: '', stderr: String(e), timedOut: false });
    }
    const out = [];
    const err = [];
    let timedOut = false;
    running.add(child);
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs) : null;
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      clearTimeout(timer); running.delete(child);
      finish({ code: -1, stdout: Buffer.concat(out).toString('utf8'), stderr: String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer); running.delete(child);
      finish({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
    });
    if (input != null) child.stdin.end(input, 'utf8'); else child.stdin.end();
  });
}

// ---------- 状态 ----------
const state = Object.assign({ sessions: {}, seen: [] }, readJson(STATE_FILE, {}));
delete state.sessionId; delete state.sessionUpdatedAt; // 旧版单会话字段
let seen = new Set(state.seen);

// 每个聊天（单聊 / 各个群）各自一个 Claude 会话，互不串上下文
function getSession(chatId) {
  const s = state.sessions[chatId];
  if (!s) return null;
  if (cfg.sessionIdleResetHours > 0 && Date.now() - s.updatedAt > cfg.sessionIdleResetHours * 3600000) {
    log('INFO', `会话空闲超时，${chatId} 开启新会话`);
    delete state.sessions[chatId];
    return null;
  }
  return s.id;
}
function setSession(chatId, id) {
  if (id) state.sessions[chatId] = { id, updatedAt: Date.now() }; else delete state.sessions[chatId];
}

function saveState() {
  if (seen.size > 2000) seen = new Set([...seen].slice(-1000));
  state.seen = [...seen];
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- 单实例锁 ----------
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquireLock() {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
    if (pid && pid !== process.pid && isAlive(pid)) {
      log('ERROR', `已有桥接实例在运行 (pid ${pid})，本进程退出`);
      process.exit(3);
    }
  } catch { /* 没有锁文件 */ }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}
function releaseLock() {
  try { if (parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// ---------- 发送消息 ----------
function splitText(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    let l = line;
    while (l.length > max) {
      if (cur) { parts.push(cur); cur = ''; }
      parts.push(l.slice(0, max));
      l = l.slice(max);
    }
    if (cur && cur.length + 1 + l.length > max) { parts.push(cur); cur = l; } else { cur = cur ? `${cur}\n${l}` : l; }
  }
  if (cur) parts.push(cur);
  return parts;
}

// 单聊：发到会话；群聊：引用回复原消息（在话题里则回复到话题内）
function replyTarget(ev) {
  return ev.chat_type === 'group'
    ? { replyTo: ev.message_id, inThread: !!ev.thread_id }
    : { chatId: ev.chat_id };
}

async function addReaction(messageId, emoji) {
  const lark = resolveLark();
  if (!lark || !emoji) return;
  const r = await runProcess(lark, ['im', 'reactions', 'create', '--as', 'bot',
    '--params', JSON.stringify({ message_id: messageId }),
    '--data', JSON.stringify({ reaction_type: { emoji_type: emoji } })], { timeoutMs: 30000 });
  if (r.code !== 0) log('WARN', `添加表情回应失败 (exit ${r.code})：${preview(r.stderr || r.stdout, 300)}`);
}

async function sendReply(target, text, keyBase) {
  const lark = resolveLark();
  if (!lark) { log('ERROR', '找不到 lark-cli.exe，无法回复'); return false; }
  const head = target.replyTo
    ? ['im', '+messages-reply', '--as', 'bot', '--message-id', target.replyTo, ...(target.inThread ? ['--reply-in-thread'] : [])]
    : ['im', '+messages-send', '--as', 'bot', '--chat-id', target.chatId];
  const chunks = splitText(String(text || '').trim() || '（空）', cfg.maxReplyChars);
  let allOk = true;
  for (let i = 0; i < chunks.length; i++) {
    const body = chunks.length > 1 ? `${chunks[i]}\n\n（${i + 1}/${chunks.length}）` : chunks[i];
    const idem = crypto.createHash('sha1').update(`${keyBase}#${i}`).digest('hex').slice(0, 40);
    // 正文写入文件，用 --markdown @file 传入，彻底避开命令行转义问题
    const name = `${idem}.md`;
    const file = path.join(OUTBOX_DIR, name);
    fs.writeFileSync(file, body, 'utf8');
    let r = await runProcess(lark, [...head,
      '--markdown', `@./outbox/${name}`, '--idempotency-key', idem], { timeoutMs: 120000 });
    if (r.code !== 0) {
      log('WARN', `markdown 发送失败 (exit ${r.code})，改用纯文本：${preview(r.stderr || r.stdout, 300)}`);
      r = await runProcess(lark, [...head,
        '--content', JSON.stringify({ text: body }), '--idempotency-key', `${idem.slice(0, 39)}t`], { timeoutMs: 120000 });
    }
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    if (r.code !== 0) {
      allOk = false;
      log('ERROR', `回复发送失败 (exit ${r.code})：${preview(r.stderr || r.stdout, 500)}`);
    }
  }
  return allOk;
}

// ---------- 调用 Claude ----------
const LARK_ALLOW_RULES = ['PowerShell(lark-cli *)', 'PowerShell(lark-cli.cmd *)', 'PowerShell(lark-cli.exe *)'];

function parseJsonOutput(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  let obj = tryParse(s);
  if (!obj) {
    const last = s.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
    obj = last ? tryParse(last) : null;
  }
  if (Array.isArray(obj)) obj = obj.find((m) => m && m.type === 'result') || null;
  return obj && typeof obj === 'object' ? obj : null;
}

async function runClaude(prompt, sessionId) {
  const exe = resolveClaude();
  if (!exe) return { ok: false, text: '找不到 claude 可执行文件，请在 config.json 里设置 claudeExe。' };
  const skills = resolveSkillsDir();
  const tools = ['PowerShell', ...(skills ? ['Read', 'Glob', 'Grep'] : [])];
  const args = [
    '-p', '--output-format', 'json',
    '--restricted', // 忽略用户/项目 settings，代码执行类工具只保留 --tools 指定的
    '--strict-mcp-config', // 不加载任何 MCP 服务器
    '--permission-mode', 'dontAsk', // 不在白名单里的操作一律拒绝
    '--tools', tools.join(','),
    '--append-system-prompt-file', SYSTEM_PROMPT_FILE,
  ];
  if (cfg.claudeModel) args.push('--model', cfg.claudeModel);
  if (sessionId) args.push('--resume', sessionId);
  args.push('--allowedTools', ...LARK_ALLOW_RULES, ...(skills ? ['Read', 'Glob', 'Grep'] : []));
  if (skills) args.push('--add-dir', skills); // 只读 lark skills 文档

  const t0 = Date.now();
  const r = await runProcess(exe, args, { input: prompt, timeoutMs: cfg.claudeTimeoutMinutes * 60000 });
  const secs = Math.round((Date.now() - t0) / 1000);
  if (r.timedOut) {
    log('WARN', `claude 超时 (${secs}s)`);
    return { ok: false, text: `⏱ 任务超过 ${cfg.claudeTimeoutMinutes} 分钟没有完成，已中止。` };
  }
  const parsed = parseJsonOutput(r.stdout);
  const raw = `${r.stderr}\n${parsed ? parsed.result || '' : r.stdout}`;
  const resumeFailed = !!sessionId && /no conversation found|session[^\n]*not found/i.test(raw);
  log('INFO', `claude 结束 exit=${r.code} ${secs}s subtype=${parsed && parsed.subtype} cost=${parsed && parsed.total_cost_usd}`);
  if (parsed && !resumeFailed) {
    const text = String(parsed.result == null ? '' : parsed.result).trim();
    return {
      ok: !parsed.is_error,
      sessionId: parsed.session_id || sessionId,
      text: text || (parsed.is_error ? `处理出错（${parsed.subtype || 'error'}）` : '（任务已完成，没有文字输出）'),
    };
  }
  return { ok: false, resumeFailed, text: `处理出错（exit ${r.code}）：\n${(r.stderr || r.stdout).trim().slice(-800)}` };
}

// ---------- 消息处理 ----------
let queue = Promise.resolve();
let pending = 0;
let busySince = 0;
const startedAt = Date.now();

function fmtTime(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildPrompt(ev) {
  const meta = [
    `message_id: ${ev.message_id}`,
    `chat_id: ${ev.chat_id}`,
    `message_type: ${ev.message_type}`,
    `time: ${fmtTime(ev.create_time)}`,
  ];
  if (ev.reply_to) meta.push(`reply_to: ${ev.reply_to}`);
  if (ev.root_id) meta.push(`root_id: ${ev.root_id}`);
  if (ev.thread_id) meta.push(`thread_id: ${ev.thread_id}`);
  const others = (ev.mentions || []).filter((m) => m && m.id && m.id !== botOpenId);
  if (others.length) meta.push(`mentions: ${others.map((m) => `${m.name}=${m.id}`).join(', ')}`);
  const where = ev.chat_type === 'group'
    ? '在飞书群聊里 @ 了你。注意：你的回复会以机器人身份引用回复在群里，群成员都能看到'
    : '通过飞书单聊发来一条消息';
  return `用户${where}（附元数据，需要时可用 lark-cli 读取原消息、群聊上下文或下载其中的图片/文件）：\n\nchat_type: ${ev.chat_type}\n${meta.join('\n')}\n\n---\n${ev.text}`;
}

// ---------- 机器人自身 open_id（判断群消息是否 @ 了机器人） ----------
let botOpenId = cfg.botOpenId || null;
let botInfoPromise = null;

function findBotOpenId(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.bot && typeof o.bot.open_id === 'string') return o.bot.open_id;
  // lark-cli 会把 bot 字段展开成 { data: { app_name, open_id, ... } }
  if (o.data && typeof o.data.open_id === 'string' && 'app_name' in o.data) return o.data.open_id;
  for (const v of Object.values(o)) { const f = findBotOpenId(v); if (f) return f; }
  return null;
}
function fetchBotInfo() {
  if (botOpenId) return Promise.resolve(botOpenId);
  if (botInfoPromise) return botInfoPromise;
  botInfoPromise = (async () => {
    const lark = resolveLark();
    if (!lark) return null;
    const r = await runProcess(lark, ['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot'], { timeoutMs: 30000 });
    const id = findBotOpenId(parseJsonOutput(r.stdout));
    if (id) { botOpenId = id; log('INFO', `机器人 open_id=${id}`); }
    else log('WARN', `获取机器人 open_id 失败，群聊 @ 暂不可用：${preview(r.stderr || r.stdout, 300)}`);
    return botOpenId;
  })().finally(() => { botInfoPromise = null; });
  return botInfoPromise;
}

// 去掉正文里 @机器人 的部分，只保留真正的指令
function cleanText(ev) {
  let t = String(ev.content || '');
  if (ev.chat_type === 'group' && botOpenId) {
    for (const m of ev.mentions || []) {
      if (!m || m.id !== botOpenId) continue;
      if (m.name) t = t.split(`@${m.name}`).join(' ');
      if (m.key) t = t.split(m.key).join(' ');
    }
  }
  return t.replace(/[ \t]+/g, ' ').trim();
}

const COMMANDS = {
  '/new': 'new', '/reset': 'new', '新会话': 'new',
  '/status': 'status', '/help': 'help',
};

async function processMessage(ev) {
  const id = ev.message_id;
  const target = replyTarget(ev);
  const cmd = COMMANDS[ev.text.toLowerCase()];
  try {
    if (cmd === 'new') {
      setSession(ev.chat_id, null); saveState();
      await sendReply(target, '已开启新会话，之前的上下文已清空。', id);
      return;
    }
    if (cmd === 'status') {
      const up = Math.round((Date.now() - startedAt) / 60000);
      const sid = getSession(ev.chat_id);
      await sendReply(target, [
        `**桥接状态**`,
        `- 已运行：${up} 分钟`,
        `- 本聊天会话：${sid ? sid.slice(0, 8) + '…' : '（无）'}`,
        `- 排队中：${Math.max(0, pending - 1)} 条`,
      ].join('\n'), id);
      return;
    }
    if (cmd === 'help') {
      await sendReply(target, '直接发任务即可（群里要 @我），我会用 lark-cli 帮你完成。\n\n- `/new` 开启新会话（清空本聊天的上下文）\n- `/status` 查看桥接状态', id);
      return;
    }

    busySince = Date.now();
    const prompt = buildPrompt(ev);
    let res = await runClaude(prompt, getSession(ev.chat_id));
    if (res.resumeFailed) {
      log('WARN', '恢复会话失败，改用新会话重试');
      setSession(ev.chat_id, null);
      res = await runClaude(prompt, null);
    }
    if (res.sessionId) setSession(ev.chat_id, res.sessionId);
    saveState();
    await sendReply(target, res.text, id);
  } catch (e) {
    log('ERROR', `处理 ${id} 失败：`, e && e.stack || e);
    await sendReply(target, `桥接程序内部错误：${e && e.message || e}`, `${id}-err`).catch(() => {});
  } finally {
    busySince = 0;
  }
}

async function handleEventLine(line) {
  if (!line.trim()) return;
  let ev;
  try { ev = JSON.parse(line); } catch { log('WARN', `无法解析事件：${preview(line, 200)}`); return; }
  if (ev.type && ev.type !== EVENT_KEY) return;
  const id = ev.message_id || ev.id;
  if (!id) return;
  ev.message_id = id;

  if (ev.sender_type && ev.sender_type !== 'user') return;
  const isGroup = ev.chat_type === 'group';
  if (ev.chat_type !== 'p2p' && !(isGroup && cfg.allowGroups)) {
    log('INFO', `忽略消息 ${id} (chat_type=${ev.chat_type})`); return;
  }
  if (ev.sender_id !== cfg.allowedOpenId) { log('INFO', `忽略非白名单发送者 ${ev.sender_id} 的消息 ${id}`); return; }
  if (isGroup) {
    if (!botOpenId) await fetchBotInfo();
    if (!botOpenId) { log('WARN', `不知道机器人 open_id，无法判断群消息 ${id} 是否 @ 了机器人，跳过`); return; }
    if (!(ev.mentions || []).some((m) => m && m.id === botOpenId)) return; // 群里没 @ 机器人
  }
  ev.text = cleanText(ev);
  if (seen.has(id)) { log('INFO', `重复消息 ${id}，跳过`); return; }
  seen.add(id); saveState();

  const ageMin = (Date.now() - Number(ev.create_time || Date.now())) / 60000;
  if (cfg.maxMessageAgeMinutes > 0 && ageMin > cfg.maxMessageAgeMinutes) {
    log('INFO', `消息 ${id} 已过期 (${Math.round(ageMin)} 分钟前)，跳过`);
    return;
  }

  log('INFO', `收到${isGroup ? '群聊 @' : '单聊'}消息 ${id} [${ev.message_type}] ${preview(ev.text)}`);
  const isCmd = !!COMMANDS[ev.text.toLowerCase()];
  pending++;
  if (!isCmd) {
    const ahead = pending - 1;
    if (isGroup) {
      // 群里不刷"处理中"文字，用表情回应
      addReaction(id, cfg.groupAckEmoji).catch(() => {});
    } else if (cfg.ackText) {
      sendReply(replyTarget(ev), ahead > 0 ? `${cfg.ackText}（前面还有 ${ahead} 条任务）` : cfg.ackText, `${id}-ack`).catch(() => {});
    }
  }
  queue = queue.then(() => processMessage(ev)).catch((e) => log('ERROR', e)).finally(() => { pending--; });
}

// ---------- 事件订阅（长连接） ----------
let consumer = null;
let shuttingDown = false;
let backoffMs = 5000;

function startConsumer() {
  if (shuttingDown) return;
  const lark = resolveLark();
  if (!lark) { log('ERROR', '找不到 lark-cli.exe，60 秒后重试'); setTimeout(startConsumer, 60000); return; }

  log('INFO', `启动事件订阅：${lark} event consume ${EVENT_KEY} --as bot`);
  // stdin 保持打开：lark-cli 把 stdin EOF 视为退出信号
  const child = spawn(lark, ['event', 'consume', EVENT_KEY, '--as', 'bot'],
    { cwd: WORK_DIR, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  consumer = child;
  let ready = false;
  child.stdin.on('error', () => {});

  readline.createInterface({ input: child.stderr }).on('line', (line) => {
    if (line.includes('[event] ready')) { ready = true; backoffMs = 5000; log('INFO', '事件订阅已就绪，等待消息…'); return; }
    log('LARK', line);
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    handleEventLine(line).catch((e) => log('ERROR', '处理事件异常：', e && e.stack || e));
  });

  child.on('error', (e) => log('ERROR', '事件订阅进程启动失败：', e.message));
  child.on('close', (code) => {
    if (consumer === child) consumer = null;
    if (shuttingDown) return;
    const delay = ready ? 5000 : backoffMs;
    if (!ready) backoffMs = Math.min(backoffMs * 2, 300000);
    log('WARN', `事件订阅进程退出 (exit ${code})，${Math.round(delay / 1000)} 秒后重连`);
    setTimeout(startConsumer, delay);
  });
}

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', `收到 ${sig}，正在退出…`);
  if (consumer) { try { consumer.stdin.end(); } catch { /* ignore */ } }
  for (const c of running) killTree(c.pid);
  releaseLock();
  setTimeout(() => process.exit(0), 3000);
}

// ---------- 自检 ----------
async function check() {
  const lark = resolveLark();
  const claude = resolveClaude();
  const skills = resolveSkillsDir();
  console.log(`运行账户     : ${os.userInfo().username}`);
  console.log(`node         : ${process.execPath} (${process.version})`);
  console.log(`lark-cli.exe : ${lark || '未找到'}`);
  console.log(`claude.exe   : ${claude || '未找到'}`);
  console.log(`lark skills  : ${skills || '未找到（不影响运行）'}`);
  console.log(`白名单 open_id: ${cfg.allowedOpenId}`);
  let ok = !!(lark && claude);
  if (lark) {
    const r = await runProcess(lark, ['auth', 'status'], { timeoutMs: 30000 });
    const j = parseJsonOutput(r.stdout) || parseJsonOutput(r.stderr) || {};
    const bot = j.identities && j.identities.bot;
    const user = j.identities && j.identities.user;
    console.log(`飞书 bot 身份 : ${bot ? `${bot.status}${bot.available ? '' : ' —— ' + bot.message}` : (j.error ? j.error.message : '未知')}`);
    console.log(`飞书 user 身份: ${user ? `${user.status}${user.openId ? ' (' + user.openId + ')' : ''}` : '未知'}`);
    if (!bot || !bot.available) ok = false;
    if (cfg.allowGroups) console.log(`机器人 open_id: ${(await fetchBotInfo()) || '获取失败（群聊 @ 将不可用）'}`);
  }
  if (claude) {
    const r = await runProcess(claude, ['--version'], { timeoutMs: 30000 });
    console.log(`claude 版本  : ${(r.stdout || r.stderr).trim()}`);
  }
  console.log(ok ? '\n自检通过' : '\n自检未通过，请按上面的提示修复');
  return ok ? 0 : 1;
}

// ---------- 入口 ----------
process.on('uncaughtException', (e) => log('ERROR', 'uncaughtException:', e && e.stack || e));
process.on('unhandledRejection', (e) => log('ERROR', 'unhandledRejection:', e && e.stack || e));

if (process.argv.includes('--check')) {
  check().then((c) => process.exit(c));
} else {
  acquireLock();
  log('INFO', `桥接启动 pid=${process.pid} 用户=${os.userInfo().username} lark=${resolveLark()} claude=${resolveClaude()}`);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(sig));
  process.on('exit', releaseLock);
  if (cfg.allowGroups) fetchBotInfo();
  startConsumer();
}
