'use strict';
// Loaded only by the isolated subprocess test. Never starts a real CLI or bot.
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
require('node:child_process').spawn = (_exe, args) => {
  fs.appendFileSync(process.env.PREFLIGHT_TEST_CALLS, JSON.stringify(args) + '\n');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  process.nextTick(() => {
    child.stderr.end(JSON.stringify({ ok: false, error: { type: 'config', subtype: 'not_configured' } }));
    child.stdout.end();
    child.emit('close', 1);
  });
  return child;
};
