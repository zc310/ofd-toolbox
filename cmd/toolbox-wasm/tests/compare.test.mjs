// make build-wasm && node --test cmd/toolbox-wasm/tests/compare.test.mjs
// 在隔离的浏览器 Worker 环境跑真实 WASM，禁止借用 Node 的本机文件系统。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));

test('浏览器 Worker 多文件比较、报告导出与资源清理', { timeout: 120000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'toolbox-compare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const generated = spawnSync('go', ['run', './cmd/toolbox-wasm/tests/fixtures.go', dir], { cwd: root, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const messages = [];
  const env = {
    console, WebAssembly, crypto: webcrypto, performance, TextEncoder, TextDecoder,
    Blob, setTimeout, clearTimeout,
    addEventListener() {},
    postMessage(message) { messages.push(message); },
    async fetch() {
      return { ok: true, headers: new Map(), arrayBuffer: async () => readFileSync(process.env.OFD_TOOLBOX_WASM || join(web, 'toolbox.wasm')) };
    },
    importScripts(path) { vm.runInContext(readFileSync(join(web, path), 'utf8'), context, { filename: path }); },
  };
  env.self = env;
  const context = vm.createContext(env);
  vm.runInContext(readFileSync(join(web, 'worker.js'), 'utf8'), context);
  async function waitFor(predicate) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Worker 响应超时：${JSON.stringify(messages)}`);
  }
  await waitFor((message) => message.type === 'ready' || message.type === 'bootError').then((message) => assert.equal(message.type, 'ready', message.error));
  const bytes = (name) => {
    env.fixtureBytes = readFileSync(join(dir, name + '.ofd'));
    return vm.runInContext('new Uint8Array(fixtureBytes)', context);
  };
  const inputs = vm.runInContext('[]', context);
  inputs.push(bytes('inserted'), bytes('base'), bytes('changed'));
  let id = 1;
  function send(command, payload) {
    const request = id++;
    env.onmessage({ data: { id: request, command, payload } });
    return waitFor((message) => message.id === request && (message.type === 'done' || message.error));
  }
  async function stream(command, payload) {
    const message = await send(command, payload);
    assert.equal(message.error, undefined, message.error);
    assert.ok(message.result.blob.size > 0);
    return message.result;
  }
  const mountedPaths = [];
  const originalMount = env.toolboxCompareFS.mount;
  env.toolboxCompareFS.mount = (...args) => {
    const mount = originalMount(...args);
    mountedPaths.push(...mount.paths);
    return mount;
  };
  function assertUnmounted() {
    for (const path of mountedPaths) {
      env.fs.stat(path, (error) => assert.equal(error?.code, 'ENOENT', path));
    }
  }

  await t.test('非首个基准、多目标插页与文字差异、原始文件名', async () => {
    const result = await stream('compare', { inputs, names: ['插页.ofd', '基准.ofd', '<修改>.ofd'], baseline: 1 });
    assert.equal(result.baseline, '基准.ofd');
    assert.equal(result.comparisons.length, 2);
    assert.equal(result.comparisons[0].summary.pages_added, 1);
    assert.equal(result.comparisons[1].equal, false);
    assert.match(await result.blob.text(), /<!DOCTYPE html>/i);
    const exported = await stream('compareExport', { reportId: result.reportId, format: 'json' });
    const report = JSON.parse(await exported.blob.text());
    assert.equal(report.baseline, 2);
    assert.deepEqual(report.inputs.map((input) => input.name), ['插页.ofd', '基准.ofd', '<修改>.ofd']);
    assert.ok(report.comparisons[1].pages.some((page) => page.text_changed));
    assert.ok(report.comparisons[1].files.some((file) => file.xml_changes?.length));
    for (const format of ['markdown', 'text']) {
      const exported = await stream('compareExport', { reportId: result.reportId, format });
      assert.match(await exported.blob.text(), /OFD 对比报告/);
    }
    assertUnmounted();
  });

  await t.test('手工映射、页范围、视觉变化与 PNG 预览', async () => {
    const pair = vm.runInContext('[]', context);
    pair.push(bytes('base'), bytes('changed'));
    const result = await stream('compare', { inputs: pair, visual: true, dpi: 36, pages: '2', pageMap: '2:2' });
    const exported = await stream('compareExport', { reportId: result.reportId, format: 'json' });
    const report = JSON.parse(await exported.blob.text());
    assert.equal(report.comparisons[0].pages.length, 1);
    const page = report.comparisons[0].pages[0];
    assert.equal(page.match.method, 'manual');
    assert.ok(page.visual.changed_pixels > 0);
    assert.match(page.visual.diff_png, /^data:image\/png;base64,/);
    assert.equal(report.inputs[0].pages[0].selected, false);
    assertUnmounted();
  });

  await t.test('错误参数、坏文件与失败后的引擎复用', async () => {
    for (const options of [{ baseline: 3 }, { baseline: 0.5 }, { dpi: NaN }, { pixelTolerance: 256 }, { pageMatch: 'number', pageMap: '1:1' }]) {
      const error = await send('compare', { inputs, ...options });
      assert.ok(error.error);
      assert.equal(error.code, 'failed');
    }
    const bad = vm.runInContext('[new Uint8Array([1]), new Uint8Array([2])]', context);
    assert.ok((await send('compare', { inputs: bad })).error);
    assertUnmounted();
    const pair = vm.runInContext('[]', context);
    pair.push(bytes('base'), bytes('base'));
    const result = await stream('compare', { inputs: pair });
    assert.equal(result.comparisons[0].equal, true);
    assertUnmounted();
  });

  await t.test('取消释放输入且能再次比较', async () => {
    const comparing = send('compare', { inputs, visual: true });
    env.onmessage({ data: { id: id++, command: 'cancel' } });
    const error = await comparing;
    assert.equal(error.code, 'cancelled', error.error);
    assertUnmounted();
    await stream('compare', { inputs });
    assertUnmounted();
  });
});
