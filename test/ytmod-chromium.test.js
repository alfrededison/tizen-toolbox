'use strict';

// Runs the YT Mod injector against a real Chromium over DevTools, with a page
// whose <body> arrives late — the situation that broke TizenTube on the TV
// ("Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of
// type 'Node'"). Skipped when no Chromium/Chrome is found (set CHROMIUM_PATH).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { startFakeSdbd } = require('./fake-sdbd');
const storeLib = require('../apps/ytmod/service/lib/store');
const { createInjector } = require('../apps/ytmod/service/lib/injector');

const CANDIDATES = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => fs.existsSync(p));

function freePort() {
    return new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

// /tv: a head script that blocks for a moment, so the first execution context
// exists well before <body> is parsed (like YouTube TV's big head bundle).
function startSite() {
    const server = http.createServer((req, res) => {
        if (req.url.startsWith('/slow.js')) {
            return setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('window.slowLoaded = true;'); }, 700);
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><head><script src="/slow.js"></script></head><body><div id="app">app</div></body></html>');
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}

function startDevApi() {
    const server = http.createServer((req, res) => res.end(JSON.stringify({ device: { developerMode: '1', developerIP: '127.0.0.1', ip: '127.0.0.1' } })));
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((c) => server.close(c)) })));
}

async function runWith(t, scriptCode) {
    const port = await freePort();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-'));
    const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const site = await startSite();
    const devApi = await startDevApi();
    const sdbd = await startFakeSdbd([[/^0 debug /, `launched with debug port: ${port}\n`]], { keepOpen: true });
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-'));
    fs.writeFileSync(path.join(bundledDir, 'tizentube.js'), scriptCode);
    fs.writeFileSync(path.join(bundledDir, 'meta.json'), JSON.stringify({ version: 'test' }));
    const inj = createInjector({
        tv: { uiAppId: () => 'TboxYtMod1.YouTube', platformVersion: () => '6.5', waitUntilClosed: () => Promise.resolve(true), launch: () => Promise.resolve() },
        store: storeLib.createStore(null),
        bundledDir,
        sdb: { port: sdbd.port },
        devInfo: { url: devApi.url },
        youtubeUrl: site.origin + '/tv',
        devtoolsTimeoutMs: 15000,
        quiet: true
    });
    t.after(async () => { inj.reset(); chrome.kill(); await site.close(); await devApi.close(); await sdbd.close(); });
    await inj.prepare();
    await inj.launchDebug();
    const end = Date.now() + 15000;
    while (Date.now() < end && inj.state.phase !== 'running' && inj.state.phase !== 'error') await new Promise((r) => setTimeout(r, 50));
    return inj;
}

test('userscript that observes document.body at load runs once <body> exists', { skip: !CHROME && 'no Chromium found' }, async (t) => {
    const inj = await runWith(t, '!function(){"use strict";new MutationObserver(function(){}).observe(document.body,{childList:true});window.ttLoaded=document.getElementById("app").textContent}();');
    assert.strictEqual(inj.state.phase, 'running', JSON.stringify(inj.state.steps) + '\n' + inj.state.log.map((l) => l.msg).join('\n'));
    assert.strictEqual(inj.state.steps.find((s) => s.key === 'inject').status, 'ok');
});

test('an error thrown by the userscript is reported with its message', { skip: !CHROME && 'no Chromium found' }, async (t) => {
    const inj = await runWith(t, '!function(){throw new TypeError("boom from userscript")}();');
    assert.strictEqual(inj.state.phase, 'error');
    assert.match(inj.state.error, /Userscript threw: TypeError: boom from userscript/);
});
