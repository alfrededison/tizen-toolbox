'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { startFakeSdbd } = require('./fake-sdbd');
const cdp = require('../apps/ytmod/service/lib/cdp');
const scripts = require('../apps/ytmod/service/lib/scripts');
const storeLib = require('../apps/ytmod/service/lib/store');
const { createInjector } = require('../apps/ytmod/service/lib/injector');
const { createServer } = require('../apps/ytmod/service/lib/server');

const YT = 'https://www.youtube.com';

// ---- fakes -------------------------------------------------------------------

// A DevTools endpoint: /json/list + a WebSocket that answers every command,
// and fires executionContextCreated for YouTube after Page.navigate.
function startFakeDevtools({ evaluateThrows = false } = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
        if (req.url === '/json/list' || req.url === '/json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // Deliberately unreachable host in the URL: the client must rewrite it.
            return res.end(JSON.stringify([
                { type: 'service_worker', webSocketDebuggerUrl: 'ws://inspector.invalid:1/devtools/sw' },
                { type: 'page', url: 'file:///ui/index.html', webSocketDebuggerUrl: 'ws://inspector.invalid:1/devtools/page/1' }
            ]));
        }
        res.writeHead(404);
        res.end();
    });
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
        calls.push({ method: '(connect)', params: { path: req.url } });
        ws.on('message', (data) => {
            const msg = JSON.parse(String(data));
            calls.push(msg);
            let result = {};
            if (msg.method === 'Runtime.evaluate' && evaluateThrows && msg.params.expression.length > 1000) {
                result = { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom\n at x' } } };
            }
            ws.send(JSON.stringify({ id: msg.id, result }));
            if (msg.method === 'Page.navigate') {
                const ev = (ctx) => ws.send(JSON.stringify({ method: 'Runtime.executionContextCreated', params: { context: ctx } }));
                setTimeout(() => {
                    ev({ id: 7, origin: 'https://ads.example', auxData: { isDefault: true } });
                    ev({ id: 8, origin: YT, auxData: { isDefault: false } });
                    ev({ id: 9, origin: YT, auxData: { isDefault: true, frameId: 'main' } });
                }, 20);
            }
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        calls,
        closeClients: () => wss.clients.forEach((c) => c.terminate()),
        close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); wss.close(); server.close(r); })
    })));
}

function startFakeDevApi(device) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ device }));
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}/api/v2/`,
        close: () => new Promise((r) => server.close(r))
    })));
}

// Builds a .tgz with the given { path: content } files (ustar headers).
function makeTgz(files) {
    const blocks = [];
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content);
        const h = Buffer.alloc(512);
        h.write(name, 0, 100);
        h.write('0000644\0', 100);
        h.write('0000000\0', 108);
        h.write('0000000\0', 116);
        h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
        h.write('00000000000\0', 136);
        h.write('        ', 148);
        h.write('0', 156);
        h.write('ustar\0', 257);
        h.write('00', 263);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}

function startFakeRegistry(versions) {
    // versions: { '1.15.1': 'code', ... }; latest = highest
    const names = Object.keys(versions);
    const latest = names.sort(scripts.compareVersions)[names.length - 1];
    const tgzs = {};
    for (const v of names) tgzs[v] = makeTgz({ 'package/package.json': '{}', 'package/dist/userScript.js': versions[v] });
    const hits = [];
    const server = http.createServer((req, res) => {
        hits.push(req.url);
        const base = `http://127.0.0.1:${server.address().port}`;
        const doc = (v) => ({ name: '@foxreis/tizentube', version: v, dist: { tarball: `${base}/tgz/${v}.tgz`, integrity: 'sha512-' + crypto.createHash('sha512').update(tgzs[v]).digest('base64') } });
        let m;
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/@foxreis%2Ftizentube') {
            const vs = {};
            for (const v of names) vs[v] = doc(v);
            vs['2.0.0-beta1'] = doc(latest);
            return res.end(JSON.stringify({ 'dist-tags': { latest }, versions: vs }));
        }
        if ((m = /^\/@foxreis%2Ftizentube\/(latest|[\d.]+)$/.exec(req.url))) {
            const v = m[1] === 'latest' ? latest : m[1];
            if (!tgzs[v]) { res.statusCode = 404; return res.end('{}'); }
            return res.end(JSON.stringify(doc(v)));
        }
        if ((m = /^\/tgz\/([\d.]+)\.tgz$/.exec(req.url))) {
            res.setHeader('Content-Type', 'application/octet-stream');
            return res.end(tgzs[m[1]]);
        }
        res.statusCode = 404;
        res.end('{}');
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () => new Promise((r) => server.close(r))
    })));
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ytmod-')); }

function makeBundledDir(version = '9.9.9', code = 'window.__tt = "bundled"; /* ' + 'x'.repeat(2000) + ' */') {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'tizentube.js'), code);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version }));
    return dir;
}

const fakeTv = (launched = []) => ({
    uiAppId: () => 'TboxYtMod1.YouTube',
    packageId: () => 'TboxYtMod1',
    platformVersion: () => '6.5',
    waitUntilClosed: () => Promise.resolve(true),
    launch: (id) => { launched.push(id); return Promise.resolve(); }
});

function waitFor(fn, ms = 5000) {
    const end = Date.now() + ms;
    return new Promise((resolve, reject) => {
        (function poll() {
            let v;
            try { v = fn(); } catch (e) { /* retry */ }
            if (v) return resolve(v);
            if (Date.now() > end) return reject(new Error('waitFor timed out'));
            setTimeout(poll, 20);
        })();
    });
}

function withEnv(t, vars) {
    const old = {};
    for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; }
    t.after(() => { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
}

// ---- cdp ---------------------------------------------------------------------

test('findTarget picks the page target and rewrites its WebSocket host', async (t) => {
    const dt = await startFakeDevtools();
    t.after(() => dt.close());
    const found = await cdp.findTarget(['10.255.255.1', '127.0.0.1'].reverse(), dt.port, { timeoutMs: 3000 });
    assert.strictEqual(found.host, '127.0.0.1');
    assert.strictEqual(found.wsUrl, `ws://127.0.0.1:${dt.port}/devtools/page/1`);
});

test('findTarget gives a clear error when nothing answers', async () => {
    await assert.rejects(cdp.findTarget(['127.0.0.1'], 1, { timeoutMs: 300, intervalMs: 50 }), { code: 'ENOTARGET' });
});

test('CdpClient sends commands and receives events', async (t) => {
    const dt = await startFakeDevtools();
    t.after(() => dt.close());
    const c = new cdp.CdpClient(`ws://127.0.0.1:${dt.port}/devtools/page/1`);
    await c.connect();
    const created = [];
    c.on('Runtime.executionContextCreated', (p) => created.push(p.context.id));
    await c.send('Page.navigate', { url: YT + '/tv' });
    await waitFor(() => created.length === 3);
    assert.deepStrictEqual(created, [7, 8, 9]);
    c.close();
});

// ---- scripts -----------------------------------------------------------------

test('tar extraction finds dist/userScript.js', () => {
    const tgz = makeTgz({ 'package/package.json': '{}', 'package/dist/userScript.js': 'hello()' });
    assert.strictEqual(scripts.extractFromTgz(tgz, 'package/dist/userScript.js').toString(), 'hello()');
    assert.strictEqual(scripts.extractFromTgz(tgz, 'package/missing.js'), null);
});

test('npm source downloads, verifies and caches; offline falls back to cache then bundled', async (t) => {
    const reg = await startFakeRegistry({ '1.15.1': 'v1151()', '1.15.2': 'v1152()' });
    t.after(() => reg.close());
    withEnv(t, { TBOX_NPM_REGISTRY: reg.url });
    const cacheDir = path.join(tmpDir(), 'userscripts');
    const ctx = { bundledDir: makeBundledDir('1.0.0'), cacheDir };

    const latest = await scripts.resolveScript({ source: 'npm', version: 'latest' }, ctx);
    assert.strictEqual(latest.code, 'v1152()');
    assert.strictEqual(latest.from, 'npm');
    const pinned = await scripts.resolveScript({ source: 'npm', version: '1.15.1' }, ctx);
    assert.strictEqual(pinned.code, 'v1151()');
    const again = await scripts.resolveScript({ source: 'npm', version: '1.15.1' }, ctx);
    assert.strictEqual(again.from, 'cache');

    const list = await scripts.listVersions();
    assert.deepStrictEqual(list, { latest: '1.15.2', versions: ['1.15.2', '1.15.1'] });

    process.env.TBOX_NPM_REGISTRY = 'http://127.0.0.1:1';
    const offlineLatest = await scripts.resolveScript({ source: 'npm', version: 'latest' }, ctx);
    assert.strictEqual(offlineLatest.code, 'v1152()');
    assert.match(offlineLatest.warning, /cached 1\.15\.2/);
    const offlineUnknown = await scripts.resolveScript({ source: 'npm', version: '1.0.5' }, ctx);
    assert.strictEqual(offlineUnknown.from, 'bundled');
    assert.match(offlineUnknown.warning, /bundled 1\.0\.0/);
});

test('settings store sanitizes and persists', () => {
    const dir = tmpDir();
    const s = storeLib.createStore(dir);
    assert.deepStrictEqual(s.get(), { source: 'bundled', version: 'latest' });
    s.set({ source: 'npm', version: '1.15.1', evil: '$(x)' });
    assert.deepStrictEqual(storeLib.createStore(dir).get(), { source: 'npm', version: '1.15.1' });
    assert.deepStrictEqual(s.set({ source: 'url', version: '../../x' }), { source: 'bundled', version: 'latest' });
});

// ---- injector ------------------------------------------------------------------

async function setupFlow(t, { device, devtools } = {}) {
    const dt = await startFakeDevtools(devtools || {});
    const sdbd = await startFakeSdbd([[/^0 debug TboxYtMod1\.YouTube$/, `... successfully launched pid = 4242 with debug 1 port: ${dt.port}\n`]], { keepOpen: true });
    const devApi = await startFakeDevApi(device || { developerMode: '1', developerIP: '127.0.0.1', ip: '127.0.0.1' });
    const launched = [];
    const inj = createInjector({
        tv: fakeTv(launched),
        store: storeLib.createStore(tmpDir()),
        bundledDir: makeBundledDir('1.15.2'),
        sdb: { port: sdbd.port },
        devInfo: { url: devApi.url },
        youtubeUrl: YT + '/tv',
        devtoolsTimeoutMs: 3000,
        quiet: true
    });
    t.after(async () => { inj.reset(); await dt.close(); await sdbd.close(); await devApi.close(); });
    return { dt, sdbd, inj, launched };
}

test('full flow: dev mode -> script -> debug relaunch -> DevTools -> YouTube -> inject once in the main frame', async (t) => {
    const { dt, sdbd, inj } = await setupFlow(t);
    await inj.prepare();
    assert.strictEqual(inj.state.phase, 'handover');
    await inj.launchDebug();
    await waitFor(() => inj.state.phase === 'running');

    assert.deepStrictEqual(sdbd.commands, ['shell:0 debug TboxYtMod1.YouTube']);
    const methods = dt.calls.map((c) => c.method);
    assert.deepStrictEqual(methods.slice(0, 5), ['(connect)', 'Runtime.enable', 'Page.enable', 'Page.setBypassCSP', 'Page.navigate']);
    assert.strictEqual(dt.calls[4].params.url, YT + '/tv');
    const evals = dt.calls.filter((c) => c.method === 'Runtime.evaluate');
    assert.strictEqual(evals[0].params.contextId, 9, 'only the YouTube main-frame context gets the script');
    assert.match(evals[0].params.expression, /window\.__tt = "bundled"/);
    await waitFor(() => dt.calls.filter((c) => c.method === 'Runtime.evaluate').length === 2);
    assert.match(dt.calls.filter((c) => c.method === 'Runtime.evaluate')[1].params.expression, /YT Mod: TizenTube 1\.15\.2 \(bundled\)/);
    assert.deepStrictEqual(inj.state.steps.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);

    // YouTube exits -> DevTools closes -> idle again.
    dt.closeClients();
    await waitFor(() => inj.state.phase === 'idle');
});

test('wrong Developer Mode host fails before the UI exits', async (t) => {
    const { inj, sdbd } = await setupFlow(t, { device: { developerMode: '1', developerIP: '192.168.1.5', ip: '192.168.1.20' } });
    await assert.rejects(inj.prepare(), /127\.0\.0\.1/);
    assert.strictEqual(inj.state.phase, 'error');
    assert.strictEqual(inj.state.steps[0].status, 'fail');
    assert.strictEqual(sdbd.commands.length, 0);
});

test('a throwing userscript is reported and a red toast is shown', async (t) => {
    const { dt, inj } = await setupFlow(t, { devtools: { evaluateThrows: true } });
    await inj.prepare();
    await inj.launchDebug();
    await waitFor(() => inj.state.phase === 'error');
    assert.match(inj.state.error, /Userscript threw: TypeError: boom/);
    await waitFor(() => dt.calls.some((c) => c.method === 'Runtime.evaluate' && /#b8352e/.test(c.params.expression)));
});

test('a failed debug launch brings the UI back to show the error', async (t) => {
    const { inj, launched, sdbd } = await setupFlow(t);
    await sdbd.close();
    await inj.prepare();
    await assert.rejects(inj.launchDebug());
    assert.strictEqual(inj.state.steps.find((s) => s.key === 'debug').status, 'fail');
    assert.deepStrictEqual(launched, ['TboxYtMod1.YouTube']);
});

// ---- local API -----------------------------------------------------------------

function call(port, method, p, { json, origin } = {}) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (origin) headers.Origin = origin;
        if (json) headers['Content-Type'] = 'application/json';
        const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
            let s = '';
            res.on('data', (c) => (s += c));
            res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
        });
        req.on('error', reject);
        if (json) req.write(JSON.stringify(json));
        req.end();
    });
}

test('local API: web pages are refused; launch answers before the debug relaunch', async (t) => {
    const { inj, dt } = await setupFlow(t);
    const store = storeLib.createStore(tmpDir());
    const api = createServer({ port: 0, injector: inj, store, tv: fakeTv(), bundledDir: makeBundledDir('1.15.2') });
    const port = await new Promise((r) => api.listen('127.0.0.1', r));
    t.after(() => api.close());

    assert.strictEqual((await call(port, 'GET', '/api/state', { origin: 'https://evil.example' })).status, 403);
    const st = await call(port, 'GET', '/api/state');
    assert.strictEqual(st.body.phase, 'idle');
    assert.deepStrictEqual(st.body.settings, { source: 'bundled', version: 'latest' });

    const saved = await call(port, 'POST', '/api/settings', { json: { source: 'npm', version: '1.15.1' } });
    assert.deepStrictEqual(saved.body.settings, { source: 'npm', version: '1.15.1' });

    const launch = await call(port, 'POST', '/api/launch', { json: {} });
    assert.strictEqual(launch.status, 200);
    assert.strictEqual(launch.body.exit, true);
    await waitFor(() => inj.state.phase === 'running');
    assert.ok(dt.calls.some((c) => c.method === 'Page.navigate'));
});

// ---- built bundle ----------------------------------------------------------------

const BUNDLE = path.join(__dirname, '../build/ytmod/service/dist/index.js');

test('built ES5 bundle boots and injects the real bundled TizenTube end to end', { skip: !fs.existsSync(BUNDLE) }, async (t) => {
    const dt = await startFakeDevtools();
    const sdbd = await startFakeSdbd([[/^0 debug TboxYtMod1\.YouTube$/, `launched with debug port: ${dt.port}\n`]], { keepOpen: true });
    const devApi = await startFakeDevApi({ developerMode: '1', developerIP: '127.0.0.1', ip: '127.0.0.1' });
    const child = spawn(process.execPath, [BUNDLE], {
        env: Object.assign({}, process.env, {
            TBOX_PORT: '18094', TBOX_SDB_PORT: String(sdbd.port), TBOX_DEVAPI_URL: devApi.url, TBOX_DATA_DIR: tmpDir()
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(async () => { child.kill(); await dt.close(); await sdbd.close(); await devApi.close(); });
    await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (c) => { out += c; if (/listening on port/.test(out)) resolve(); });
        child.on('exit', (code) => reject(new Error('bundle exited ' + code + ': ' + out)));
        setTimeout(() => reject(new Error('bundle did not start: ' + out)), 5000);
    });
    const launch = await call(18094, 'POST', '/api/launch', { json: {} });
    assert.strictEqual(launch.status, 200, JSON.stringify(launch.body));
    await waitFor(async () => true);
    const end = Date.now() + 8000;
    let state;
    while (Date.now() < end) {
        state = (await call(18094, 'GET', '/api/state')).body;
        if (state.phase === 'running' || state.phase === 'error') break;
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(state.phase, 'running', JSON.stringify(state.steps));
    const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '../build/ytmod/userscript/meta.json'), 'utf8'));
    assert.strictEqual(state.script.label, `TizenTube ${meta.version} (bundled)`);
    const evaluated = dt.calls.find((c) => c.method === 'Runtime.evaluate');
    assert.ok(evaluated.params.expression.length > 100000, 'the real userscript was sent');
});
