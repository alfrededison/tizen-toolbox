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
const { makeP12, PASSWORD } = require('./certs');

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

async function setup(t, { device, sdbHandlers, sdbOpts, ownSignatureFile = null } = {}) {
    const fake = await startFakeSdbd(sdbHandlers || [[/^0 vd_appinstall /, 'app_id[AbCdE12345] install completed\nspend time for wascmd is [10]ms\n']], sdbOpts || {});
    const devApi = await startFakeDevApi(device || { developerMode: '1', developerIP: '127.0.0.1', ip: '192.168.1.50', name: 'Frame' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbox-'));
    const signingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbox-signing-'));
    const inst = createInstallerServer({ port: 0, pin: '123456', tmpDir, signingDir, ownSignatureFile, sdb: { port: fake.port }, devInfo: { url: devApi.url }, quiet: true });
    const port = await new Promise((r) => inst.listen('127.0.0.1', r));
    t.after(async () => { inst.close(); await fake.close(); await devApi.close(); });
    return { fake, port, tmpDir, signingDir, inst };
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
    for (let i = 0; i < 5; i++) await call(port, 'GET', '/api/apps', { origin: 'http://x' });
    const notLocked = await call(port, 'GET', '/api/apps', { origin: 'http://x', pin: '123456' });
    assert.strictEqual(notLocked.status, 200, 'a repeated or missing PIN is not a new guess');
    // A wrong PIN keeps counting across repeats and missing PINs: the fifth distinct one locks.
    const wrong = ['000000', '000001', '000000', '', '000002', '000003'];
    for (const pin of wrong) await call(port, 'GET', '/api/apps', { origin: 'http://x', pin });
    assert.strictEqual((await call(port, 'GET', '/api/status')).body.locked, false);
    await call(port, 'GET', '/api/apps', { origin: 'http://x', pin: '__proto__' });
    assert.strictEqual((await call(port, 'GET', '/api/status')).body.locked, true);
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

test('status reports the DUID read over sdb', async (t) => {
    const { port } = await setup(t, { sdbHandlers: [['0 getduid', 'BDCI6YW6SR6YO\n']] });
    const res = await call(port, 'GET', '/api/status');
    assert.strictEqual(res.body.duid, 'BDCI6YW6SR6YO');
});

test('a certificate rejection explains which certificate the TV needs', async (t) => {
    const { port } = await setup(t, {
        sdbHandlers: [
            [/^0 vd_appinstall /, 'app_id[AbCdE12345] install failed[118, -12], reason: Check certificate error : :Invalid signature.:<-4>\nspend time for wascmd is [9]ms\n'],
            ['0 getduid', 'BDCI6YW6SR6YO\n'],
        ],
    });
    const res = await call(port, 'POST', '/api/install', { body: await makeWgt() });
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.hint, /Samsung distributor certificate that lists its DUID BDCI6YW6SR6YO/);
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
    const unApp = await call(port, 'POST', '/api/uninstall', { json: { appId: 'AbCdE12345.x;reboot' } });
    assert.strictEqual(unApp.status, 400);
    const unList = await call(port, 'POST', '/api/uninstall', { json: { appId: ['AbCdE12345.App'] } });
    assert.strictEqual(unList.status, 400);
    assert.strictEqual(fake.commands.length, 0);
});

test('uninstall runs vd_appuninstall with the app id', async (t) => {
    const { port, fake } = await setup(t, { sdbHandlers: [[/^0 vd_appuninstall /, 'app_id[ZzZzZ12345.App] uninstall completed\nspend time for wascmd is [5]ms\n']] });
    const res = await call(port, 'POST', '/api/uninstall', { json: { appId: 'ZzZzZ12345.App' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(fake.commands, ['shell:0 vd_appuninstall ZzZzZ12345.App']);
});

test('a failed uninstall reports the TV\'s reason', async (t) => {
    const { port } = await setup(t, { sdbHandlers: [[/^0 vd_appuninstall /, 'uninstall ZzZzZ12345.App\nwas get app info failed\nspend time for wascmd is [7]ms\n']] });
    const res = await call(port, 'POST', '/api/uninstall', { json: { appId: 'ZzZzZ12345.App' } });
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.error, 'was get app info failed');
});

test('uninstall by package id looks up an app of the package', async (t) => {
    const { port, fake } = await setup(t);
    const res = await call(port, 'POST', '/api/uninstall', { json: { packageId: 'ZzZzZ12345' } });
    assert.strictEqual(res.status, 404); // no TV apps outside a TV
    assert.match(res.body.error, /No installed app in package ZzZzZ12345/);
    assert.strictEqual(fake.commands.length, 0);
});

test('an update signed by another author says to uninstall first', async (t) => {
    const { port } = await setup(t, { sdbHandlers: [[/^0 vd_appinstall /, 'app_id[AbCdE12345] install failed[118, -11], reason: Author certificate not match :\nspend time for wascmd is [9]ms\n']] });
    const res = await call(port, 'POST', '/api/install', { body: await makeWgt() });
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.error, 'Author certificate not match');
    assert.match(res.body.hint, /Demo is already installed with a different author certificate\. Uninstall it first/);
});

test('LAN page is served at /', async (t) => {
    const { port } = await setup(t);
    const res = await call(port, 'GET', '/');
    assert.strictEqual(res.status, 200);
    assert.match(String(res.body), /TV Installer/);
});

const certBody = (duids) => ({
    author: makeP12({ cn: 'Jelly2Sams', issuer: 'Samsung VD Author CA' }).toString('base64'),
    distributor: makeP12({ cn: 'TizenSDK', issuer: 'VD DEVELOPER Public CA Class', duids }).toString('base64'),
    password: PASSWORD,
});

test('built ES5 bundle boots and installs end to end', { skip: !fs.existsSync(path.join(__dirname, '../build/installer/service/dist/index.js')) }, async (t) => {
    let installed = null;
    const fake = await startFakeSdbd([[/^0 vd_appinstall /, (cmd) => {
        installed = fs.readFileSync(cmd.split(' ').pop());
        return 'install completed\nspend time for wascmd is [1]ms\n';
    }]]);
    const devApi = await startFakeDevApi({ developerMode: '1', developerIP: '127.0.0.1', ip: '10.0.0.2' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbox-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbox-data-'));
    const child = spawn(process.execPath, [path.join(__dirname, '../build/installer/service/dist/index.js')], {
        env: Object.assign({}, process.env, { TBOX_SDB_PORT: String(fake.port), TBOX_DEVAPI_URL: devApi.url, TBOX_TMP_DIR: tmpDir, TBOX_DATA_DIR: dataDir, TBOX_PORT: '18093' }),
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

    // The transpiled signer (node-forge included) re-signs on the TV.
    const cert = await call(18093, 'POST', '/api/cert', { json: certBody(['BDCI6YW6SR6YO']) });
    assert.strictEqual(cert.status, 200, JSON.stringify(cert.body));
    const signed = await call(18093, 'POST', '/api/install', { body: await makeWgt({ signed: false }) });
    assert.strictEqual(signed.body.ok, true, JSON.stringify(signed.body));
    const zip = await JSZip.loadAsync(installed);
    assert.match(await zip.files['signature1.xml'].async('string'), /<Reference URI="author-signature.xml">/);
});


test('certificate upload needs the PIN, checks the password and never returns the files', async (t) => {
    const { port, signingDir } = await setup(t, { sdbHandlers: [['0 getduid', 'BDCI6YW6SR6YO\n']] });
    const web = { origin: 'http://192.168.1.50:8093' };
    const body = certBody(['BDCI6YW6SR6YO']);
    assert.strictEqual((await call(port, 'POST', '/api/cert', { ...web, json: body })).status, 401);

    const wrong = await call(port, 'POST', '/api/cert', { ...web, pin: '123456', json: { ...body, password: 'nope' } });
    assert.strictEqual(wrong.status, 400);
    assert.match(wrong.body.error, /password/);
    assert.deepStrictEqual(fs.readdirSync(signingDir), []);

    const ok = await call(port, 'POST', '/api/cert', { ...web, pin: '123456', json: body });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.author.name, 'Jelly2Sams');
    assert.strictEqual(ok.body.coversThisTv, true);
    assert.deepStrictEqual(ok.body.warnings, []);
    assert.deepStrictEqual(fs.readdirSync(signingDir).sort(), ['author.p12', 'distributor.p12', 'password.txt']);
    assert.strictEqual(fs.statSync(path.join(signingDir, 'password.txt')).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(ok.body).includes(PASSWORD));

    const status = await call(port, 'GET', '/api/status', web);
    assert.deepStrictEqual(status.body.signing, { configured: true, error: null, name: 'Jelly2Sams (Public)', coversThisTv: true, matchesInstaller: null });

    const removed = await call(port, 'POST', '/api/cert/remove', { ...web, pin: '123456' });
    assert.strictEqual(removed.status, 200);
    assert.deepStrictEqual(fs.readdirSync(signingDir), []);
    assert.strictEqual((await call(port, 'GET', '/api/cert', { ...web, pin: '123456' })).body.configured, false);
});

test('a certificate that does not list this TV is saved with a warning', async (t) => {
    const { port } = await setup(t, { sdbHandlers: [['0 getduid', 'BDCI6YW6SR6YO\n']] });
    const res = await call(port, 'POST', '/api/cert', { json: certBody(['OTHERTV12345']) });
    assert.strictEqual(res.body.coversThisTv, false);
    assert.match(res.body.warnings.join(' '), /does not list this TV \(DUID BDCI6YW6SR6YO\)/);
});

test('with a certificate, every package is re-signed before installing, even unsigned ones', async (t) => {
    let installed = null;
    const { port, fake } = await setup(t, {
        sdbHandlers: [[/^0 vd_appinstall /, (cmd) => {
            installed = fs.readFileSync(cmd.split(' ').pop());
            return 'app_id[AbCdE12345] install completed\nspend time for wascmd is [10]ms\n';
        }]],
    });
    await call(port, 'POST', '/api/cert', { json: certBody(['BDCI6YW6SR6YO']) });
    const res = await call(port, 'POST', '/api/install', { body: await makeWgt({ signed: false }) });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(fake.commands.filter((c) => c.includes('vd_appinstall')).length, 1);

    const zip = await JSZip.loadAsync(installed);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    assert.deepStrictEqual(names, ['author-signature.xml', 'config.xml', 'index.html', 'signature1.xml']);
    const authorXml = await zip.files['author-signature.xml'].async('string');
    assert.ok(authorXml.includes('<Reference URI="config.xml">'));
});

test('a password with surrounding spaces still works after a restart', async (t) => {
    const password = '  spaced pw ';
    const { port, signingDir } = await setup(t);
    const body = {
        author: makeP12({ cn: 'Jelly2Sams', issuer: 'Samsung VD Author CA', password }).toString('base64'),
        distributor: makeP12({ cn: 'TizenSDK', issuer: 'VD DEVELOPER Public CA Class', duids: ['BDCI6YW6SR6YO'], password }).toString('base64'),
        password,
    };
    assert.strictEqual((await call(port, 'POST', '/api/cert', { json: body })).status, 200);

    const again = createInstallerServer({ port: 0, pin: '123456', tmpDir: os.tmpdir(), signingDir, quiet: true });
    const port2 = await new Promise((r) => again.listen('127.0.0.1', r));
    t.after(() => again.close());
    const res = await call(port2, 'GET', '/api/cert');
    assert.strictEqual(res.body.error, undefined, JSON.stringify(res.body));
    assert.strictEqual(res.body.author.name, 'Jelly2Sams');
});

test('a stored certificate that no longer opens is reported, and installs say how to fix it', async (t) => {
    const { port, signingDir, fake } = await setup(t);
    await call(port, 'POST', '/api/cert', { json: certBody(['BDCI6YW6SR6YO']) });
    fs.writeFileSync(path.join(signingDir, 'password.txt'), 'changed');

    const again = createInstallerServer({ port: 0, pin: '123456', tmpDir: os.tmpdir(), signingDir, sdb: { port: fake.port }, quiet: true });
    const port2 = await new Promise((r) => again.listen('127.0.0.1', r));
    t.after(() => again.close());
    const status = await call(port2, 'GET', '/api/status');
    assert.deepStrictEqual([status.body.signing.configured, typeof status.body.signing.error], [true, 'string']);
    const res = await call(port2, 'POST', '/api/install', { body: await makeWgt() });
    assert.strictEqual(res.status, 500);
    assert.match(res.body.error, /cannot be opened .*Upload it again, or remove it/);
});

test('oversized certificate uploads are refused with the limit in KB', async (t) => {
    const { port } = await setup(t);
    const res = await call(port, 'POST', '/api/cert', { json: { author: 'x'.repeat(300 * 1024) } });
    assert.strictEqual(res.status, 413);
    assert.match(res.body.error, /limit 256 KB/);
});

test('each distinct loopback Origin is logged once', async (t) => {
    const { port, inst } = await setup(t);
    await call(port, 'GET', '/api/status');
    await call(port, 'GET', '/api/status');
    await call(port, 'GET', '/api/status', { origin: 'null' });
    const lines = inst.state.log.map((l) => l.msg).filter((m) => m.startsWith('Loopback request with Origin'));
    assert.deepStrictEqual(lines, ['Loopback request with Origin: (none) (treated as the TV UI)', 'Loopback request with Origin: "null" (needs the PIN)']);
});

test('only requests without an Origin pass for the TV UI; "null" origins need the PIN', async (t) => {
    const { port, signingDir } = await setup(t);
    await call(port, 'POST', '/api/cert', { json: certBody(['BDCI6YW6SR6YO']) });

    // e.g. a sandboxed iframe in the TV's browser
    const status = await call(port, 'GET', '/api/status', { origin: 'null' });
    assert.strictEqual(status.body.pin, undefined);
    const remove = await call(port, 'POST', '/api/cert/remove', { origin: 'null' });
    assert.strictEqual(remove.status, 401);
    const replace = await call(port, 'POST', '/api/cert', { origin: 'null', json: certBody(['EVIL12345678']) });
    assert.strictEqual(replace.status, 401);
    assert.strictEqual(fs.readdirSync(signingDir).length, 3);

    // With the PIN (the TV UI sends it along), such requests work and get CORS headers.
    const withPin = await call(port, 'GET', '/api/cert', { origin: 'null', pin: '123456' });
    assert.strictEqual(withPin.status, 200);
    assert.strictEqual(withPin.headers['access-control-allow-origin'], '*');
});

// An author-signature.xml like the one installed with the Installer, holding `p12`'s certificates.
function ownSignature(p12) {
    const sign = require('../packages/tizen-sign');
    const xml = (loaded) => '<Signature><KeyInfo><X509Data>' + loaded.certs.map((c) => '<X509Certificate>\n' + sign.certificateBase64(c) + '\n</X509Certificate>').join('') + '</X509Data></KeyInfo></Signature>';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbox-own-'));
    fs.writeFileSync(path.join(dir, 'author-signature.xml'), xml(sign.loadP12(p12, PASSWORD)));
    const distributor = makeP12({ cn: 'TizenSDK', issuer: 'VD DEVELOPER Partner CA Class', duids: ['BDCI6YW6SR6YO'] });
    fs.writeFileSync(path.join(dir, 'signature1.xml'), xml(sign.loadP12(distributor, PASSWORD)));
    return path.join(dir, 'author-signature.xml');
}

test('a certificate that is not the one the Installer was installed with is flagged', async (t) => {
    const installedWith = makeP12({ cn: 'Jelly2Sams', issuer: 'Samsung VD Author CA' });
    const { port } = await setup(t, { ownSignatureFile: ownSignature(installedWith), sdbHandlers: [['0 getduid', 'BDCI6YW6SR6YO\n']] });

    const other = await call(port, 'POST', '/api/cert', { json: certBody(['BDCI6YW6SR6YO']) });
    assert.strictEqual(other.body.matchesInstaller, false);
    assert.match(other.body.warnings.join(' '), /installed with Jelly2Sams \(Partner\), a different certificate/);
    assert.strictEqual((await call(port, 'GET', '/api/status')).body.signing.matchesInstaller, false);

    const same = await call(port, 'POST', '/api/cert', { json: { ...certBody(['BDCI6YW6SR6YO']), author: installedWith.toString('base64') } });
    assert.strictEqual(same.body.matchesInstaller, true);
    assert.deepStrictEqual(same.body.warnings, []);
    assert.strictEqual(same.body.label, 'Jelly2Sams (Public)');
});

test('a refused self-update with the matching certificate does not blame the certificate', async (t) => {
    const installedWith = makeP12({ cn: 'Jelly2Sams', issuer: 'Samsung VD Author CA' });
    const { port } = await setup(t, {
        ownSignatureFile: ownSignature(installedWith),
        sdbHandlers: [[/^0 vd_appinstall /, 'app_id[TboxInst01] install failed[118, -11], reason: Author certificate not match :\nspend time for wascmd is [9]ms\n']],
    });
    await call(port, 'POST', '/api/cert', { json: { ...certBody(['BDCI6YW6SR6YO']), author: installedWith.toString('base64') } });
    const res = await call(port, 'POST', '/api/install', { body: await makeWgt({ pkg: 'TboxInst01', name: 'TV Installer' }) });
    assert.doesNotMatch(res.body.hint, /Upload the certificate it was installed with/);
});

test('a refused self-update says to upload the certificate the Installer was installed with', async (t) => {
    const { port } = await setup(t, { sdbHandlers: [[/^0 vd_appinstall /, 'app_id[TboxInst01] install failed[118, -11], reason: Author certificate not match :\nspend time for wascmd is [9]ms\n']] });
    await call(port, 'POST', '/api/cert', { json: certBody(['BDCI6YW6SR6YO']) });
    const res = await call(port, 'POST', '/api/install', { body: await makeWgt({ pkg: 'TboxInst01', name: 'TV Installer' }) });
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.hint, /Upload the certificate it was installed with/);
});
