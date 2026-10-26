#!/usr/bin/env node
'use strict';

// Sends a .wgt/.tpk to the TV Installer over the LAN.
//
//   npm run push -- dist/ytmod.wgt --tv 192.168.1.20 --pin 123456
//   npm run push -- --url owner/repo          # TV downloads the latest GitHub release
//   npm run push -- --cert                    # upload certs/ so the TV signs every install
//
// --tv and --pin can also come from TV_HOST / TV_PIN, or from .tvrc.json
// (created on first successful push, git-ignored).

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const RC = path.join(ROOT, '.tvrc.json');
const { signingConfig } = require('./lib/sign');

function parseArgs(argv) {
    const out = { files: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--tv') out.tv = argv[++i];
        else if (a === '--pin') out.pin = argv[++i];
        else if (a === '--url') out.url = argv[++i];
        else if (a === '--force') out.force = true;
        else if (a === '--cert') out.cert = true;
        else out.files.push(a);
    }
    return out;
}

function request(opts, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(Object.assign({ agent: false }, opts), (res) => {
            let s = '';
            res.on('data', (c) => (s += c));
            res.on('end', () => {
                let json = {};
                try { json = JSON.parse(s); } catch (e) { /* ignore */ }
                resolve({ status: res.statusCode, body: json });
            });
        });
        req.on('error', reject);
        req.setTimeout(240000, () => req.destroy(new Error('Timed out talking to the TV')));
        if (body) req.write(body);
        req.end();
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let rc = {};
    try { rc = JSON.parse(fs.readFileSync(RC, 'utf8')); } catch (e) { /* none yet */ }
    const tv = args.tv || process.env.TV_HOST || rc.tv;
    const pin = args.pin || process.env.TV_PIN || rc.pin;
    if (!tv || !pin) {
        console.error('Usage: npm run push -- <file.wgt> --tv <TV IP> --pin <PIN shown on the TV>');
        process.exit(2);
    }
    const [host, port] = tv.includes(':') ? tv.split(':') : [tv, '8093'];
    const q = args.force ? '?force=1' : '';

    let res;
    if (args.cert) {
        const c = signingConfig();
        if (c.samsung === false) throw new Error('No Samsung distributor certificate in certs/ (run npm run cert first).');
        if (!c.authorPwd || c.authorPwd !== c.distributorPwd) throw new Error('The TV keeps one password for both certificates; put it in certs/password.txt.');
        for (const f of [c.authorKey, c.distributorKey]) if (!fs.existsSync(f)) throw new Error('Missing ' + f);
        console.log(`Uploading the signing certificate to ${host}:${port} ...`);
        const body = Buffer.from(JSON.stringify({
            author: fs.readFileSync(c.authorKey).toString('base64'),
            distributor: fs.readFileSync(c.distributorKey).toString('base64'),
            password: c.authorPwd,
        }));
        res = await request({ host, port, method: 'POST', path: '/api/cert', headers: { 'X-PIN': pin, 'Content-Type': 'application/json', 'Content-Length': body.length } }, body);
        if (res.status === 200) {
            const b = res.body;
            console.log(`The TV now signs every install with ${b.author.name} / ${b.distributor.name} (TVs: ${b.distributor.duids.join(', ') || 'none'}).`);
            for (const w of b.warnings || []) console.warn('Warning: ' + w);
            fs.writeFileSync(RC, JSON.stringify({ tv, pin }, null, 2));
            return;
        }
    } else if (args.url) {
        console.log(`Asking the TV to install ${args.url} ...`);
        const body = Buffer.from(JSON.stringify({ url: args.url }));
        res = await request({ host, port, method: 'POST', path: '/api/install-url' + q, headers: { 'X-PIN': pin, 'Content-Type': 'application/json', 'Content-Length': body.length } }, body);
    } else {
        const file = args.files[0];
        if (!file || !fs.existsSync(file)) {
            console.error('File not found: ' + (file || '(none given)'));
            process.exit(2);
        }
        const data = fs.readFileSync(file);
        console.log(`Uploading ${path.basename(file)} (${(data.length / 1024).toFixed(0)} KB) to ${host}:${port} ...`);
        res = await request({ host, port, method: 'POST', path: '/api/install' + q, headers: { 'X-PIN': pin, 'Content-Type': 'application/octet-stream', 'Content-Length': data.length } }, data);
    }

    if (res.status === 200 && res.body.ok) {
        console.log(`Installed ${res.body.name || ''} ${res.body.packageId} v${res.body.version || '?'}`);
        fs.writeFileSync(RC, JSON.stringify({ tv, pin }, null, 2));
        return;
    }
    console.error(`Failed (HTTP ${res.status}): ${res.body.error || 'see output'}`);
    if (res.body.output) console.error(res.body.output);
    if (res.body.hint) console.error(res.body.hint);
    process.exit(1);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
