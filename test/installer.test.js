'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const JSZip = require('jszip');
const { startFakeSdbd } = require('./fake-sdbd');
const { createInstallerServer } = require('../apps/installer/service/lib/server');
const { inspectPackage } = require('../apps/installer/service/lib/pkg');

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

async function makeWgt({ pkg = 'AbCdE12345', signed = true, name = 'Demo' } = {}) {
    const zip = new JSZip();
    zip.file('config.xml', `<?xml version="1.0"?><widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="1.2.3"><tizen:application id="${pkg}.Demo" package="${pkg}" required_version="3.0"/><name>${name}</name></widget>`);
    zip.file('index.html', '<html></html>');
    if (signed) {
        zip.file('author-signature.xml', '<Signature/>');
        zip.file('signature1.xml', '<Signature/>');
    }
    return zip.generateAsync({ type: 'nodebuffer' });
}

function call(port, method, p, { body, pin, origin, json } = {}) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (pin) headers['X-PIN'] = pin;
        if (origin) headers.Origin = origin;
        let data = body;
        if (json) { data = Buffer.from(JSON.stringify(json)); headers['Content-Type'] = 'application/json'; }
        const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
            let s = '';
            res.on('data', (c) => (s += c));
            res.on('end', () => {
                let parsed = s;
                try { parsed = JSON.parse(s); } catch (e) { /* html */ }
                resolve({ status: res.statusCode, body: parsed, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function setup(t, { device, sdbHandlers, sdbOpts } = {}) {
    const fake = await startFakeSdbd(sdbHandlers || [[/^0 vd_appinstall /, 'app_id[AbCdE12345] install completed\nspend time for wascmd is [10]ms\n']], sdbOpts || {});
    const devApi = await startFakeDevApi(device || { developerMode: '1', developerIP: '127.0.0.1', ip: '192.168.1.50', name: 'Frame' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbox-'));
    const inst = createInstallerServer({ port: 0, pin: '123456', tmpDir, sdb: { port: fake.port }, devInfo: { url: devApi.url }, quiet: true });
    const port = await new Promise((r) => inst.listen('127.0.0.1', r));
    t.after(async () => { inst.close(); await fake.close(); await devApi.close(); });
    return { fake, port, tmpDir, inst };
}

test('inspectPackage reads wgt identity and signature presence', async () => {
    const info = await inspectPackage(await makeWgt());
    assert.strictEqual(info.packageId, 'AbCdE12345');
    assert.strictEqual(info.appId, 'AbCdE12345.Demo');
    assert.strictEqual(info.version, '1.2.3');
    assert.strictEqual(info.name, 'Demo');
    assert.strictEqual(info.signed, true);
    const unsigned = await inspectPackage(await makeWgt({ signed: false }));
    assert.strictEqual(unsigned.signed, false);
});

test('status from the TV UI includes the PIN; from a web origin it does not', async (t) => {
    const { port } = await setup(t);
    const local = await call(port, 'GET', '/api/status');
    assert.strictEqual(local.body.pin, '123456');
    assert.strictEqual(local.body.sdbReady, true);
    assert.strictEqual(local.body.lanUrl, `http://192.168.1.50:${port}/`);
    assert.strictEqual(local.headers['access-control-allow-origin'], '*');
    const web = await call(port, 'GET', '/api/status', { origin: 'https://evil.example' });
    assert.strictEqual(web.body.pin, undefined);
});

test('web-origin requests need the PIN; wrong PINs lock out', async (t) => {
    const { port } = await setup(t);
    const noPin = await call(port, 'GET', '/api/apps', { origin: 'http://192.168.1.50:8093' });
    assert.strictEqual(noPin.status, 401);
    const ok = await call(port, 'GET', '/api/apps', { origin: 'http://192.168.1.50:8093', pin: '123456' });
    assert.strictEqual(ok.status, 200);
    for (let i = 0; i < 5; i++) await call(port, 'GET', '/api/apps', { origin: 'http://x', pin: '000000' });
    const locked = await call(port, 'GET', '/api/apps', { origin: 'http://x', pin: '123456' });
    assert.strictEqual(locked.status, 429);
});

test('upload installs through vd_appinstall and cleans up the temp file', async (t) => {
    const { port, fake, tmpDir } = await setup(t);
    const res = await call(port, 'POST', '/api/install', { body: await makeWgt(), pin: '123456', origin: 'http://tv' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.packageId, 'AbCdE12345');
    assert.deepStrictEqual(fake.commands, [`shell:0 vd_appinstall AbCdE12345 ${path.join(tmpDir, 'tbox-AbCdE12345.wgt')}`]);
    assert.deepStrictEqual(fs.readdirSync(tmpDir), []);
});

test('unsigned packages are refused unless forced', async (t) => {
    const { port, fake } = await setup(t);
    const res = await call(port, 'POST', '/api/install', { body: await makeWgt({ signed: false }) });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.code, 'UNSIGNED');
    assert.strictEqual(fake.commands.length, 0);
    const forced = await call(port, 'POST', '/api/install?force=1', { body: await makeWgt({ signed: false }) });
    assert.strictEqual(forced.status, 200);
});

test('install is blocked with a clear message when host is not 127.0.0.1', async (t) => {
    const { port, fake } = await setup(t, { device: { developerMode: '1', developerIP: '192.168.1.10', ip: '192.168.1.50' } });
    const res = await call(port, 'POST', '/api/install', { body: await makeWgt() });
    assert.strictEqual(res.status, 412);
    assert.match(res.body.error, /127\.0\.0\.1/);
    assert.strictEqual(fake.commands.length, 0);
});

test('malicious package ids never reach the shell', async (t) => {
    const { port, fake } = await setup(t);
    const res = await call(port, 'POST', '/api/install', { body: await makeWgt({ pkg: 'x;reboot' }) });
    assert.strictEqual(res.status, 500);
    assert.strictEqual(fake.commands.length, 0);
    const un = await call(port, 'POST', '/api/uninstall', { json: { packageId: '$(reboot)' } });
    assert.strictEqual(un.status, 400);
});

test('uninstall runs vd_appuninstall', async (t) => {
    const { port, fake } = await setup(t, { sdbHandlers: [[/^0 vd_appuninstall /, 'app_id[ZzZzZ12345] uninstall completed\nspend time for wascmd is [5]ms\n']] });
    const res = await call(port, 'POST', '/api/uninstall', { json: { packageId: 'ZzZzZ12345' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(fake.commands, ['shell:0 vd_appuninstall ZzZzZ12345']);
});

test('LAN page is served at /', async (t) => {
    const { port } = await setup(t);
    const res = await call(port, 'GET', '/');
    assert.strictEqual(res.status, 200);
    assert.match(String(res.body), /TV Installer/);
});

test('built ES5 bundle boots and installs end to end', { skip: !fs.existsSync(path.join(__dirname, '../build/installer/service/dist/index.js')) }, async (t) => {
    const fake = await startFakeSdbd([[/^0 vd_appinstall /, 'install completed\nspend time for wascmd is [1]ms\n']]);
    const devApi = await startFakeDevApi({ developerMode: '1', developerIP: '127.0.0.1', ip: '10.0.0.2' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbox-'));
    const child = spawn(process.execPath, [path.join(__dirname, '../build/installer/service/dist/index.js')], {
        env: Object.assign({}, process.env, { TBOX_SDB_PORT: String(fake.port), TBOX_DEVAPI_URL: devApi.url, TBOX_TMP_DIR: tmpDir, TBOX_PORT: '18093' }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(async () => { child.kill(); await fake.close(); await devApi.close(); });
    await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (c) => { out += c; if (/listening on port/.test(out)) resolve(); });
        child.on('exit', (code) => reject(new Error('bundle exited ' + code + ': ' + out)));
        setTimeout(() => reject(new Error('bundle did not start: ' + out)), 5000);
    });
    const status = await call(18093, 'GET', '/api/status');
    assert.strictEqual(status.body.sdbReady, true);
    const res = await call(18093, 'POST', '/api/install', { body: await makeWgt() });
    assert.strictEqual(res.body.ok, true, JSON.stringify(res.body));
    const page = await call(18093, 'GET', '/');
    assert.match(String(page.body), /TV Installer/);
});
