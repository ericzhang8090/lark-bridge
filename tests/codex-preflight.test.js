'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCodexStartup } = require('../codex-preflight');

function fixture(overrides = {}) {
  const calls = [];
  const options = {
    larkExe: 'lark-cli.exe', codexExe: 'codex.exe', profile: 'dedicated-bot',
    mcpAvailable: true,
    run: async (exe, args) => {
      calls.push({ exe, args });
      return exe === 'lark-cli.exe'
        ? { code: 0, stdout: JSON.stringify({ ok: true, identities: { bot: { available: true } } }), stderr: '' }
        : { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
    },
    ...overrides,
  };
  return { options, calls };
}

test('missing app profile fails without querying model login or selecting another profile', async () => {
  const commands = [];
  const { options } = fixture({ run: async (exe, args) => {
    commands.push({ exe, args });
    return { code: 1, stdout: '', stderr: JSON.stringify({ ok: false, error: { type: 'config', subtype: 'not_configured', message: 'profile missing' } }) };
  } });
  const result = await checkCodexStartup(options);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'lark_not_configured');
  assert.match(result.issues[0].message, /dedicated-bot/);
  assert.deepEqual(commands.map(c => c.args), [['auth', 'status', '--json']]);
});

test('not-ready bot credentials block startup', async () => {
  const { options } = fixture({ run: async () => ({ code: 0, stdout: JSON.stringify({ identities: { bot: { available: false } } }) }) });
  const result = await checkCodexStartup(options);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'lark_not_ready');
});

test('missing executable produces local setup instructions without starting a process', async () => {
  const { options, calls } = fixture({ codexExe: null });
  const result = await checkCodexStartup(options);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'codex_missing');
  assert.equal(calls.length, 0);
});

test('failed isolated Codex login status cannot pass based on text alone', async () => {
  const { options } = fixture({ run: async exe => exe === 'lark-cli.exe'
    ? { code: 0, stdout: JSON.stringify({ identities: { bot: { available: true } } }) }
    : { code: 1, stderr: 'Not logged in' } });
  const result = await checkCodexStartup(options);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'codex_not_logged_in');
  assert.match(result.issues[0].message, /codex-login/);
});

test('ready deployment uses only read-only status commands', async () => {
  const { options, calls } = fixture();
  const result = await checkCodexStartup(options);
  assert.deepEqual(result, { ok: true, issues: [] });
  assert.deepEqual(calls, [
    { exe: 'lark-cli.exe', args: ['auth', 'status', '--json'] },
    { exe: 'codex.exe', args: ['login', 'status'] },
  ]);
});

test('invalid status output fails closed without echoing provider output', async () => {
  const { options } = fixture({ run: async () => ({ code: 0, stdout: 'private debug output' }) });
  const result = await checkCodexStartup(options);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'lark_invalid_status');
  assert.doesNotMatch(JSON.stringify(result), /private debug/);
});

test('missing MCP bridge blocks startup even with installed CLIs', async () => {
  const { options, calls } = fixture({ mcpAvailable: false });
  const result = await checkCodexStartup(options);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'mcp_missing');
  assert.equal(calls.length, 0);
});

test('exceptions from status checks return actionable setup failures', async () => {
  const { options } = fixture({ run: async () => { throw new Error('private provider detail'); } });
  const result = await checkCodexStartup(options);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'lark_status_failed');
  assert.doesNotMatch(JSON.stringify(result), /private provider/);
});

test('real bridge exits before event subscription when selected profile is missing', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-preflight-'));
  try {
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"commonjs"}');
    for (const file of ['bridge.js', 'codex-preflight.js', 'mail-digest.js']) {
      fs.copyFileSync(path.join(__dirname, '..', file), path.join(directory, file));
    }
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
      allowedOpenId: 'ou_test123', agent: 'codex', larkProfile: 'missing-profile',
      larkCliExe: process.execPath, codexExe: process.execPath, allowGroups: false,
    }));
    fs.writeFileSync(path.join(directory, 'lark-mcp.js'), '// exists for prerequisite validation');
    const hook = path.join(__dirname, 'fixtures', 'missing-profile.cjs');
    const callsFile = path.join(directory, 'calls.jsonl');
    const result = spawnSync(process.execPath, ['--require', hook, path.join(directory, 'bridge.js')], {
      env: { ...process.env, PREFLIGHT_TEST_CALLS: callsFile }, encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 3, result.stderr);
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls, [['auth', 'status', '--json']]);
    assert.match(result.stderr, /lark_not_configured/);
    assert.equal(fs.existsSync(path.join(directory, 'state', 'bridge.lock')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
