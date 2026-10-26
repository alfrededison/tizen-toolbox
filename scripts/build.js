#!/usr/bin/env node
'use strict';

// Builds every app under apps/ that has a config.xml into dist/<app>.wgt.
//
//   npm run build                 # all apps
//   npm run build -- installer    # one app
//
// Steps per app:
//   1. Bundle the Tizen service with ncc (pulls in packages/* and npm deps).
//   2. Transpile the bundle with Babel down to ES5 / Node 4 so it runs on
//      old Tizen Node runtimes, and verify the result parses as ES5.
//   3. Stage config.xml, icon, ui/, service/web/ and the bundle into build/<app>.
//   4. Zip into a .wgt and sign it if a certificate is configured
//      (see scripts/lib/sign.js); otherwise emit <app>-unsigned.wgt, which
//      Apps2Samsung can still install because it re-signs packages itself.

const fs = require('fs');
const path = require('path');
const ncc = require('@vercel/ncc');
const babel = require('@babel/core');
const acorn = require('acorn');
const JSZip = require('jszip');
const { signZipBuffer, whyCannotSign, describeSigning } = require('./lib/sign');

const ROOT = path.resolve(__dirname, '..');
const APPS_DIR = path.join(ROOT, 'apps');
const BUILD_DIR = path.join(ROOT, 'build');
const DIST_DIR = path.join(ROOT, 'dist');

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function copyDir(src, dest) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

function listFiles(dir, base = dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(p, base));
        else out.push(path.relative(base, p).split(path.sep).join('/'));
    }
    return out.sort();
}

async function bundleService(appDir) {
    const entry = path.join(appDir, 'service', 'index.js');
    if (!fs.existsSync(entry)) return null;
    const { code, assets } = await ncc(entry, { minify: false, sourceMap: false, quiet: true, target: 'es5' });
    const result = babel.transformSync(code, {
        babelrc: false,
        configFile: false,
        sourceType: 'script',
        compact: false,
        comments: false,
        presets: [[require.resolve('@babel/preset-env'), { targets: { node: '4' }, forceAllTransforms: true, modules: false }]]
    });
    if (/regeneratorRuntime/.test(result.code)) {
        throw new Error('Service bundle needs regeneratorRuntime (async/generator code). Avoid async functions in service code or add the runtime.');
    }
    try {
        acorn.parse(result.code, { ecmaVersion: 5, sourceType: 'script' });
    } catch (e) {
        const around = result.code.slice(Math.max(0, e.pos - 120), e.pos + 120);
        throw new Error('Service bundle is not valid ES5 (' + e.message + '):\n' + around);
    }
    return { code: result.code, assets };
}

async function buildApp(name) {
    const appDir = path.join(APPS_DIR, name);
    const configPath = path.join(appDir, 'config.xml');
    if (!fs.existsSync(configPath)) {
        console.log(`- ${name}: no config.xml, skipped`);
        return null;
    }
    const config = fs.readFileSync(configPath, 'utf8');
    const version = (/<widget\b[^>]*\bversion="([^"]+)"/.exec(config) || [])[1] || '0.0.0';
    console.log(`- ${name} v${version}`);

    const stage = path.join(BUILD_DIR, name);
    rmrf(stage);
    fs.mkdirSync(stage, { recursive: true });

    fs.copyFileSync(configPath, path.join(stage, 'config.xml'));
    for (const f of fs.readdirSync(appDir)) {
        if (/\.png$/i.test(f)) fs.copyFileSync(path.join(appDir, f), path.join(stage, f));
    }
    copyDir(path.join(appDir, 'ui'), path.join(stage, 'ui'));
    // service/web/* is picked up by ncc as assets and emitted next to the bundle.

    // Optional per-app hook to add generated files to the package.
    const prepare = path.join(appDir, 'prepare.js');
    if (fs.existsSync(prepare)) {
        const note = await require(prepare)({ stage, appDir, root: ROOT });
        if (note) console.log('  ' + note);
    }

    const bundle = await bundleService(appDir);
    if (bundle) {
        const distDir = path.join(stage, 'service', 'dist');
        fs.mkdirSync(distDir, { recursive: true });
        fs.writeFileSync(path.join(distDir, 'index.js'), bundle.code);
        for (const [assetName, asset] of Object.entries(bundle.assets || {})) {
            const p = path.join(distDir, assetName);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, asset.source);
        }
        console.log(`  service bundle: ${(bundle.code.length / 1024).toFixed(0)} KB (ES5 ok)`);
    }

    const zip = new JSZip();
    for (const rel of listFiles(stage)) {
        zip.file(rel, fs.readFileSync(path.join(stage, rel)), { date: new Date('2020-01-01T00:00:00Z') });
    }
    let buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    fs.mkdirSync(DIST_DIR, { recursive: true });
    const reason = whyCannotSign();
    let outFile;
    if (reason) {
        outFile = path.join(DIST_DIR, `${name}-unsigned.wgt`);
        console.log(`  not signed: ${reason}`);
    } else {
        buffer = await signZipBuffer(buffer);
        outFile = path.join(DIST_DIR, `${name}.wgt`);
        console.log('  signed with ' + describeSigning());
    }
    fs.writeFileSync(outFile, buffer);
    console.log(`  -> ${path.relative(ROOT, outFile)} (${(buffer.length / 1024).toFixed(0)} KB)`);
    return outFile;
}

async function main() {
    const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
    const apps = only.length ? only : fs.readdirSync(APPS_DIR).filter((d) => fs.statSync(path.join(APPS_DIR, d)).isDirectory());
    console.log('Building: ' + apps.join(', '));
    for (const app of apps) await buildApp(app);
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
