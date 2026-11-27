'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

const bridge = path.join(__dirname, '..', 'bridge.js');
const source = fs.readFileSync(bridge, 'utf8').split('// ---------- 入口 ----------')[0];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-model-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    agent: 'codex', codexExe: process.execPath, allowedOpenId: 'ou_owner',
    codexModel: 'gpt-6.2-sol', codexEffort: 'medium', quickModel: 'gpt-6.2-sol',
    progressAfterSeconds: 0,
  }));
  fs.copyFileSync(path.join(__dirname, '..', 'system-prompt.md'), path.join(root, 'system-prompt.md'));
  let n = 0;
  function open() {
    const requests = [];
    const replies = [];
    const status = { failNext: false };
    const context = vm.createContext({
      require: createRequire(bridge), __dirname: root, process, Buffer, console,
      requests, replies, status,
    });
    vm.runInContext(source + '\n' + [
      'log = () => {};',
      'ackStart = ackEnd = async () => {};',
      'sendReply = async (_target, reply) => { replies.push(reply); };',
      'runProcess = async (_exe, args, { onStdout }) => {',
      '  requests.push(args);',
      '  if (status.failNext) {',
      '    status.failNext = false;',
      '    return { code: 1, stdout: "", stderr: "model not found on this account" };',
      '  }',
      '  const lines = [{type:"thread.started", thread_id:"test-thread"},',
      '    {type:"item.completed", item:{type:"agent_message", text:"answer"}},',
      '    {type:"turn.completed"}];',
      '  onStdout(Buffer.from(lines.map(JSON.stringify).join("\\n") + "\\n"));',
      '  return { code: 0 };',
      '};',
      'globalThis.accept = handleEventLine;',
      'globalThis.drain = (id) => chatOf(id).chain;',
    ].join('\n'), context, { filename: bridge });
    return {
      requests, replies, status,
      async message(content, chat = 'oc_first', sender = 'ou_owner') {
        await context.accept(JSON.stringify({
          message_id: 'om_test' + ++n, chat_type: 'p2p', chat_id: chat,
          sender_id: sender, sender_type: 'user', message_type: 'text', content,
        }));
        await context.drain(chat);
      },
    };
  }
  return { open };
}

function assertModel(args, model, effort, resumed = true) {
  assert.equal(args[1] === 'resume', resumed);
  if (resumed) assert.equal(args.at(-2), 'test-thread');
  assert.equal(args[args.indexOf('-m') + 1], model);
  assert.ok(args.includes('model_reasoning_effort="' + effort + '"'));
}

test('switching model resumes the same chat and persists across reloads', async t => {
  const { open } = fixture(t);
  const bot = open();
  await bot.message('先聊一轮');
  await bot.message('/model astra');
  assert.equal(bot.requests.length, 1);
  assert.match(bot.replies.at(-1), /gpt-6\.2-astra.*high/);
  await bot.message('接着聊');
  assertModel(bot.requests.at(-1), 'gpt-6.2-astra', 'high');

  const restarted = open();
  await restarted.message('/model');
  assert.match(restarted.replies.at(-1), /gpt-6\.2-astra.*high/);
  await restarted.message('继续');
  assertModel(restarted.requests.at(-1), 'gpt-6.2-astra', 'high');
  await restarted.message('另一个聊天', 'oc_second');
  assertModel(restarted.requests.at(-1), 'gpt-6.2-sol', 'medium', false);
});

test('quick mode and reset use their configured settings and invalid commands do not change the choice', async t => {
  const bot = fixture(t).open();
  await bot.message('/model astra xhigh');
  await bot.message('/model astra bogus');
  await bot.message('/model sol', 'oc_first', 'ou_other');
  assert.equal(bot.requests.length, 0);
  await bot.message('/q 简单问题');
  assertModel(bot.requests.at(-1), 'gpt-6.2-sol', 'low', false);
  await bot.message('开始聊天');
  assertModel(bot.requests.at(-1), 'gpt-6.2-astra', 'xhigh', false);
  await bot.message('/model default');
  await bot.message('接着聊');
  assertModel(bot.requests.at(-1), 'gpt-6.2-sol', 'medium');
});

test('an unavailable model is not mistaken for a missing conversation', async t => {
  const bot = fixture(t).open();
  await bot.message('第一轮');
  await bot.message('/model astra');
  bot.status.failNext = true;
  await bot.message('尝试切换');
  assert.equal(bot.requests.length, 2);
  assert.match(bot.replies.at(-1), /model not found/);
  await bot.message('/model sol');
  await bot.message('继续原对话');
  assertModel(bot.requests.at(-1), 'gpt-6.2-sol', 'medium');
});
