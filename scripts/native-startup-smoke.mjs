import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// Run under Xvfb at the PC baseline. The fixture deliberately waits five seconds
// before loading the same IPC client Electron uses; GTK must already be visible.
const binary = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Pass the built resources/native/pspore-startup');
const root = await mkdtemp(join(tmpdir(), 'pspore-native-smoke-'));
const fixture = join(root, 'desktop-fixture.mjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error(`Native startup smoke timed out\n${active?.logs() ?? ''}\n${tree()}`);
}
async function text(path) { try { return await readFile(path, 'utf8'); } catch { return ''; } }
function tree() {
  // Ubuntu 20.04 containers default to the ASCII C locale. Without this,
  // xwininfo replaces the Chinese title with a conversion error.
  try { return execFileSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C.UTF-8' }, stdio: ['ignore','pipe','pipe'] }); }
  catch { return ''; } // The window may disappear between QueryTree/GetAttributes.
}
function windowId() {
  const id = tree().match(/(0x[0-9a-f]+) "pSpore · 正在启动"/)?.[1];
  if (!id) return undefined;
  // XCreateWindow/WM_NAME precede XMapWindow. Finding the title alone can
  // observe a valid window before GTK has made it visible, especially in CI.
  try {
    const info = execFileSync('xwininfo', ['-id', id], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C.UTF-8' }, stdio: ['ignore','pipe','pipe'] });
    return info.includes('Map State: IsViewable') ? id : undefined;
  } catch (error) {
    if (/Bad (?:Drawable|Window)/.test(String(error.stderr))) return undefined;
    throw error;
  }
}
let active;
function launch(config, mode = 'handoff') {
  const process_ = spawn(binary, [fixture, 'argument with spaces', 'literal $x;`q`'], {
    env: { ...process.env, GDK_BACKEND: 'x11', XDG_CONFIG_HOME: join(root, config), PROBE: join(root, config), MODE: mode },
    stdio: ['ignore','pipe','pipe'],
  });
  let output = '';
  process_.stdout.on('data', (data) => { output += data; });
  process_.stderr.on('data', (data) => { output += data; });
  process_.result = once(process_, 'exit').then(([code, signal]) => ({ code, signal, output }));
  process_.logs = () => output;
  return process_;
}
try {
  await mkdir(join(root, 'resources', 'icons'), { recursive: true });
  await copyFile(new URL('../src/desktop/assets/pspore.png', import.meta.url), join(root, 'resources/icons/pspore.png'));
  await writeFile(fixture, `#!${process.execPath}
import { writeFile, appendFile } from 'node:fs/promises';
import { connectNativeStartup } from ${JSON.stringify(pathToFileURL(resolve('dist/desktop/native-startup.js')).href)};
await writeFile(process.env.PROBE + '.started', JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }));
const hold = setInterval(() => {}, 1000);
if (process.env.MODE === 'failure') process.exit(17);
if (process.env.MODE === 'cancel') process.on('SIGTERM', () => { clearInterval(hold); process.exit(0); });
await new Promise(r => setTimeout(r, 5000));
const controller = await connectNativeStartup(() => { void appendFile(process.env.PROBE + '.focus', 'focus\\n'); });
if (!controller) throw Error('No native startup controller');
await controller.setMessage('正在打开工作空间…');
await writeFile(process.env.PROBE + '.connected', 'yes');
await new Promise(r => setTimeout(r, 200));
controller.close();
`, { mode: 0o755 });
  const begin = performance.now();
  active = launch('handoff');
  const id = await until(windowId);
  const visible = execFileSync('xwininfo', ['-id', id], { encoding: 'utf8' });
  assert.match(visible, /Map State: IsViewable/);
  assert.match(visible, /Width: 512/); assert.match(visible, /Height: 332/);
  const visibleMs = Math.round(performance.now() - begin);
  await until(async () => await text(join(root, 'handoff.started')));
  assert.match(active.logs(), /first frame .* starting Electron/);
  assert.equal(await text(join(root, 'handoff.connected')), '', 'Native frame must precede the delayed client');
  const child = JSON.parse(await text(join(root, 'handoff.started')));
  assert.deepEqual(child.argv, ['argument with spaces', 'literal $x;`q`']);
  const duplicate = launch('handoff');
  assert.equal((await duplicate.result).code, 0);
  assert.equal(JSON.parse(await text(join(root, 'handoff.started'))).pid, child.pid, 'Duplicate click must reuse the child');
  await until(async () => await text(join(root, 'handoff.connected')));
  await until(() => !windowId());
  const focus = launch('handoff');
  assert.equal((await focus.result).code, 0);
  await until(async () => await text(join(root, 'handoff.focus')));
  active.kill('SIGTERM');
  assert.equal((await active.result).code, 0); active = undefined;
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });

  active = launch('cancel', 'cancel');
  const cancelId = await until(windowId);
  await until(async () => await text(join(root, 'cancel.started')));
  const cancelledChild = JSON.parse(await text(join(root, 'cancel.started'))).pid;
  execFileSync('xdotool', ['windowfocus', cancelId, 'key', 'Escape']);
  const cancelled = await Promise.race([active.result, pause(6000).then(() => { throw Error('Cancel left launcher running'); })]);
  assert.equal(cancelled.code, 0); active = undefined;
  assert.throws(() => process.kill(cancelledChild, 0), { code: 'ESRCH' });
  assert.equal(windowId(), undefined);

  active = launch('failure', 'failure');
  const failedId = await until(windowId);
  await until(() => active.logs().includes('child exited with status'));
  assert.ok(windowId(), 'Failure remains visible until dismissed');
  execFileSync('xdotool', ['windowfocus', failedId, 'key', 'Escape']);
  assert.equal((await active.result).code, 0); active = undefined;
  console.log(JSON.stringify({ viewport: '1920x1080', visibleMs, delayedClientMs: 5000, firstFrameBeforeChild: true, argumentForwarding: true, duplicateReused: true, handoff: true, focus: true, cancellation: true, failureDismissal: true }));
} finally {
  if (active && active.exitCode === null) { active.kill('SIGTERM'); await active.result; }
  await rm(root, { recursive: true, force: true });
}
