#!/usr/bin/env node
'use strict';

// Bumps an app's version everywhere it is recorded: config.xml (what the TV
// sees), its package.json, the VERSION its service reports, and the matching
// package-lock.json entry.
//
//   npm run bump:installer -- patch     # 1.0.0 -> 1.0.1
//   npm run bump:ytmod -- minor         # 0.1.1 -> 0.2.0
//   node scripts/bump.js ytmod 0.3.0
//
// Then tag the release: v<version> for the Installer, ytmod-v<version> for YT Mod.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APPS = {
    installer: { label: 'Installer', tag: (v) => `v${v}` },
    ytmod: { label: 'YT Mod', tag: (v) => `ytmod-v${v}` },
};

// Tizen widget versions are x.y.z with x, y <= 255 and z <= 65535.
const LIMITS = [255, 255, 65535];

function parse(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '');
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    return parts.every((n, i) => n <= LIMITS[i]) ? parts : null;
}

function next(current, arg) {
    const [major, minor, patch] = parse(current);
    if (arg === 'major') return `${major + 1}.0.0`;
    if (arg === 'minor') return `${major}.${minor + 1}.0`;
    if (arg === 'patch') return `${major}.${minor}.${patch + 1}`;
    return arg;
}

// Replaces the single match of `re` (whose group 1 is the version) in `file`.
function textEdit(file, re) {
    const text = fs.readFileSync(file, 'utf8');
    const matches = text.match(new RegExp(re.source, re.flags + 'g')) || [];
    if (matches.length !== 1) throw new Error(`Expected one version in ${path.relative(ROOT, file)}, found ${matches.length}`);
    return {
        file,
        current: re.exec(text)[1],
        apply: (v) => text.replace(re, (whole, old) => whole.replace(old, v)),
    };
}

function lockEdit(file, LOCK_KEY) {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = lock.packages && lock.packages[LOCK_KEY];
    if (!entry) throw new Error(`No "${LOCK_KEY}" entry in package-lock.json`);
    return {
        file,
        current: entry.version,
        apply: (v) => { entry.version = v; return JSON.stringify(lock, null, 2) + '\n'; },
    };
}

function main() {
    const [appName, arg] = process.argv.slice(2);
    const app = APPS[appName];
    if (!app || !arg) {
        console.error(`Usage: node scripts/bump.js <${Object.keys(APPS).join('|')}> <patch|minor|major|x.y.z>`);
        process.exit(2);
    }
    const APP_DIR = path.join(ROOT, 'apps', appName);

    const edits = [
        textEdit(path.join(APP_DIR, 'config.xml'), /<widget\b[^>]*\bversion="([^"]+)"/),
        textEdit(path.join(APP_DIR, 'package.json'), /^ {2}"version": "([^"]+)"/m),
        textEdit(path.join(APP_DIR, 'service', 'lib', 'server.js'), /^var VERSION = '([^']+)';/m),
        lockEdit(path.join(ROOT, 'package-lock.json'), `apps/${appName}`),
    ];

    const current = edits[0].current;
    const mismatched = edits.filter((e) => e.current !== current);
    if (mismatched.length) {
        throw new Error('Versions are out of sync:\n' +
            edits.map((e) => `  ${path.relative(ROOT, e.file)}: ${e.current}`).join('\n'));
    }
    if (!parse(current)) throw new Error(`Current version ${current} is not x.y.z`);

    const version = next(current, arg);
    if (!parse(version)) throw new Error(`Invalid version "${arg}": use patch, minor, major or x.y.z (max 255.255.65535)`);
    if (version === current) throw new Error(`Already at ${current}`);

    // Compute every file before writing any, so a failure leaves nothing half-bumped.
    const outputs = edits.map((e) => [e.file, e.apply(version)]);
    for (const [file, text] of outputs) fs.writeFileSync(file, text);
    console.log(`${app.label} ${current} -> ${version}`);
    console.log(`Release it: commit, merge to main, then  git tag ${app.tag(version)} && git push origin ${app.tag(version)}`);
}

try {
    main();
} catch (err) {
    console.error(err.message);
    process.exit(1);
}
