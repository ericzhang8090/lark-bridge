#!/usr/bin/env node
// 极简 MCP 服务器（stdio，无 npm 依赖）：只提供一个工具 lark_cli，用参数数组直接启动 lark-cli.exe。
// 给 agent=codex 用：Codex 的 shell 被关掉，只能通过这个工具调用 lark-cli。
// 不经过任何 shell，参数里的 ; | & $ 等字符都只是普通文本，没法拼接或嵌入其他命令。
// 环境变量：LARK_CLI_EXE（必填，lark-cli.exe 路径）、LARK_MCP_CWD（工作目录）、LARKSUITE_CLI_PROFILE（由桥接传入）
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');

const EXE = process.env.LARK_CLI_EXE;
const CWD = process.env.LARK_MCP_CWD || process.cwd();
const TIMEOUT_MS = 180000;
const MAX_OUTPUT = 60000;

const TOOL = {
  name: 'lark_cli',
  description: '执行一条 lark-cli 命令（飞书 / Lark 命令行）。args 是 lark-cli 后面的参数数组，每个参数一项，不要加引号，'
    + '例如 ["calendar", "+agenda", "--as", "user"] 或 ["im", "+messages-send", "--as", "bot", "--chat-id", "oc_xxx", "--text", "你好"]。'
    + '不经过 shell，管道、重定向、拼接命令都不支持；需要处理 JSON 时用 lark-cli 自带的 --jq 参数。'
    + '不确定用法时先查 ["<domain>", "--help"] 或 ["schema", "<service.resource.method>"]。',
  inputSchema: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, description: 'lark-cli 后面的参数，每个参数一项' },
    },
    required: ['args'],
    additionalProperties: false,
  },
};

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function runLark(args) {
  return new Promise((resolve) => {
    if (!EXE) return resolve({ text: '桥接没有提供 LARK_CLI_EXE，无法执行 lark-cli', isError: true });
    let child;
    try {
      child = spawn(EXE, args, { cwd: CWD, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ text: `启动 lark-cli 失败：${e.message}`, isError: true });
    }
    const out = [];
    const err = [];
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, TIMEOUT_MS);
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', (e) => { clearTimeout(timer); resolve({ text: `lark-cli 出错：${e.message}`, isError: true }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const so = Buffer.concat(out).toString('utf8');
      const se = Buffer.concat(err).toString('utf8');
      let text = `exit code: ${code}\n${so}${se ? `\n[stderr]\n${se}` : ''}`;
      if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + '\n…（输出过长已截断，可用 --jq 或分页参数缩小范围）';
      resolve({ text, isError: code !== 0 });
    });
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'lark-bridge', version: '1.0.0' },
    });
  }
  if (id === undefined) return; // 通知（notifications/initialized 等）不需要回复
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: [TOOL] });
  if (method === 'tools/call') {
    if (!params || params.name !== TOOL.name) return fail(id, -32602, `未知工具 ${params && params.name}`);
    const args = params.arguments && params.arguments.args;
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
      return reply(id, { content: [{ type: 'text', text: 'args 必须是字符串数组' }], isError: true });
    }
    const r = await runLark(args);
    return reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
  }
  return fail(id, -32601, `不支持的方法 ${method}`);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, String(e && e.message || e)); });
});
