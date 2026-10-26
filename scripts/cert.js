#!/usr/bin/env node
'use strict';

// Manages the Samsung certificate in certs/ that the build signs with.
// Samsung TVs only install packages whose distributor certificate is issued by
// Samsung for their DUID, and only accept an update signed with the same author
// certificate as the installed copy, so keep certs/ backed up.
//
//   npm run cert                                     # show what is in certs/
//   npm run cert -- import [dir] [--force]           # copy an Apps2Samsung certificate
//   npm run cert -- add-tv <DUID>[,<DUID>...] --email you@example.com [--name "Your Name"]
//                         [--partner | --public] [--new-author]
//
// add-tv signs in to your Samsung account and asks Samsung for a distributor
// certificate listing the new DUIDs plus those already in certs/distributor.p12,
// at the same privilege level unless --partner / --public says otherwise.
// It keeps certs/author.p12 (it must be Samsung-issued), creating one with
// --name if there is none, or replacing it with --new-author.
// Get a TV's DUID from the TV Installer screen, or `sdb shell 0 getduid`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { loadTizenJs, loadP12, CERTS_DIR } = require('./lib/sign');

const FILES = {
    author: path.join(CERTS_DIR, 'author.p12'),
    distributor: path.join(CERTS_DIR, 'distributor.p12'),
    password: path.join(CERTS_DIR, 'password.txt'),
};
const SIGN_IN_URL = 'https://account.samsung.com/accounts/TDC/signInGate?clientId=v285zxnl3h&tokenType=TOKEN';
const DUID_RE = /^[A-Z0-9]{8,32}$/;
const USAGE = 'Usage: npm run cert [-- show | import [dir] [--force] | ' +
    'add-tv <DUID>[,...] --email <email> [--name <name>] [--partner | --public] [--new-author]]';

function parseArgs(argv) {
    const out = { positional: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--force') out.force = true;
        else if (a === '--partner') out.partner = true;
        else if (a === '--public') out.public = true;
        else if (a === '--new-author') out.newAuthor = true;
        else if (a === '--email') out.email = argv[++i];
        else if (a === '--name') out.name = argv[++i];
        else out.positional.push(a);
    }
    return out;
}

function readPassword() {
    if (process.env.TIZEN_AUTHOR_KEY_PW) return process.env.TIZEN_AUTHOR_KEY_PW;
    try { return fs.readFileSync(FILES.password, 'utf8').trim() || null; } catch (e) { return null; }
}

function certsOf(forge, p12) {
    const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    return bags.map((b) => b.cert);
}

// The leaf is the certificate whose public key matches the private key.
function leafOf(forge, p12) {
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
    const key = keyBags[0] && keyBags[0].key;
    const certs = certsOf(forge, p12);
    return certs.find((c) => key && c.publicKey.n.equals(key.n)) || certs[0];
}

function loadLeaf(lib, file, password) {
    return leafOf(lib.forge, loadP12(lib.forge, file, password));
}

const cnOf = (attrs) => (attrs.getField('CN') || {}).value || '?';

// Samsung issues author certificates from "Samsung VD Author CA" and
// distributor certificates from "VD DEVELOPER Public/Partner CA Class".
function isSamsungIssued(cert) {
    return /samsung|\bVD\b/i.test(cnOf(cert.issuer));
}

function privilegeOf(cert) {
    const issuer = cnOf(cert.issuer);
    if (/partner/i.test(issuer)) return 'Partner';
    if (/public/i.test(issuer)) return 'Public';
    return null;
}

function duidsOf(cert) {
    const san = cert.getExtension('subjectAltName');
    return ((san && san.altNames) || [])
        .map((n) => /^URN:tizen:deviceid=(.+)$/.exec(n.value || ''))
        .filter(Boolean)
        .map((m) => m[1]);
}

function describe(cert) {
    return `${cnOf(cert.subject)}, issued by ${cnOf(cert.issuer)}, expires ${cert.validity.notAfter.toISOString().slice(0, 10)}`;
}

function show(lib) {
    const password = readPassword();
    console.log(`Certificates in ${path.relative(process.cwd(), CERTS_DIR) || '.'}:`);
    for (const [label, file] of [['author', FILES.author], ['distributor', FILES.distributor]]) {
        if (!fs.existsSync(file)) {
            console.log(`  ${label}: none`);
            continue;
        }
        if (!password) {
            console.log(`  ${label}: present, but no password (certs/password.txt or TIZEN_AUTHOR_KEY_PW)`);
            continue;
        }
        try {
            const leaf = loadLeaf(lib, file, password);
            console.log(`  ${label}: ${describe(leaf)}${isSamsungIssued(leaf) ? '' : '  <- not Samsung-issued; Samsung TVs reject it'}`);
            if (label === 'distributor') console.log(`  TVs (DUIDs): ${duidsOf(leaf).join(', ') || 'none'}`);
        } catch (e) {
            console.log(`  ${label}: cannot open (${e.message})`);
        }
    }
}

// Moves an existing file aside so nothing is ever overwritten.
function backup(file) {
    if (!fs.existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/Z$/, '');
    let target = `${file}.bak-${stamp}`;
    for (let n = 2; fs.existsSync(target); n++) target = `${file}.bak-${stamp}-${n}`;
    fs.renameSync(file, target);
    console.log(`  kept the old ${path.basename(file)} as ${path.basename(target)}`);
}

// Stages every new file next to its target first, so a failure while writing
// (e.g. disk full) leaves certs/ untouched; then swaps them in, keeping backups.
function replaceFiles(writes) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
    const staged = writes.map(([file, write]) => {
        const tmp = file + '.new';
        write(tmp);
        return [file, tmp];
    });
    for (const [file, tmp] of staged) {
        backup(file);
        fs.renameSync(tmp, file);
    }
    if (fs.existsSync(FILES.password)) fs.chmodSync(FILES.password, 0o600);
}

function apps2SamsungDirs() {
    const base = process.platform === 'win32'
        ? path.join(process.env.APPDATA || '', 'Apps2Samsung', 'Certificate')
        : path.join(os.homedir(), 'Library', 'Application Support', 'Apps2Samsung', 'Certificate');
    try {
        return fs.readdirSync(base).map((d) => path.join(base, d)).filter((d) => fs.statSync(d).isDirectory());
    } catch (e) {
        return [];
    }
}

function importCert(lib, args) {
    let dir = args.positional[1];
    if (!dir) {
        const found = apps2SamsungDirs();
        const pub = found.filter((d) => / - Public$/.test(d));
        if (pub.length !== 1) {
            throw new Error('Give the certificate folder: npm run cert -- import <dir>' +
                (found.length ? '\nApps2Samsung certificates found:\n' + found.map((d) => '  ' + d).join('\n') : ''));
        }
        dir = pub[0];
    }
    const src = {
        author: path.join(dir, 'author.p12'),
        distributor: path.join(dir, 'distributor.p12'),
        password: path.join(dir, 'password.txt'),
    };
    for (const f of Object.values(src)) {
        if (!fs.existsSync(f)) throw new Error('Missing ' + f);
    }
    const password = fs.readFileSync(src.password, 'utf8').trim();
    // Check before copying anything that the password opens both files.
    loadP12(lib.forge, src.author, password);
    loadP12(lib.forge, src.distributor, password);

    const existing = Object.values(FILES).filter((f) => fs.existsSync(f));
    if (existing.length && !args.force) {
        throw new Error('certs/ already has ' + existing.map((f) => path.basename(f)).join(', ') +
            '.\nRe-run with --force to keep them as .bak files and import anyway.');
    }
    console.log('Importing ' + dir);
    replaceFiles(Object.keys(FILES).map((key) => [FILES[key], (tmp) => fs.copyFileSync(src[key], tmp)]));
    show(lib);
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

async function signIn() {
    console.log('\nSign in to your Samsung account here:\n\n  ' + SIGN_IN_URL + '\n');
    console.log('The page then shows a JSON response. Copy all of it and paste it below.');
    const text = await ask('> ');
    let json;
    try { json = JSON.parse(text); } catch (e) { throw new Error('That is not the JSON response from the sign-in page.'); }
    if (!json.access_token || !json.userId) throw new Error('The JSON response has no access_token / userId.');
    return { accessToken: json.access_token, userId: json.userId };
}

async function addTv(lib, args) {
    const newDuids = args.positional.slice(1).join(',').split(',').map((d) => d.trim().toUpperCase()).filter(Boolean);
    if (!newDuids.length || !args.email) throw new Error(USAGE);
    const bad = newDuids.filter((d) => !DUID_RE.test(d));
    if (bad.length) throw new Error('Not a DUID: ' + bad.join(', ') + ' (it looks like BDCI6YW6SR6YO)');
    if (args.partner && args.public) throw new Error('Use either --partner or --public, not both.');

    // Everything that can fail locally is checked before the Samsung sign-in.
    let password = readPassword();
    const hasAuthor = fs.existsSync(FILES.author);
    const hasDistributor = fs.existsSync(FILES.distributor);
    const keepAuthor = hasAuthor && !args.newAuthor;
    if ((keepAuthor || hasDistributor) && !password) {
        throw new Error('certs/ has certificates but their password is unknown (certs/password.txt or TIZEN_AUTHOR_KEY_PW).');
    }
    if (!keepAuthor && !args.name) {
        throw new Error((hasAuthor ? '--new-author' : 'There is no certs/author.p12 yet, so this') + ' needs --name "Your Name".');
    }
    if (keepAuthor) {
        const author = loadLeaf(lib, FILES.author, password);
        if (!isSamsungIssued(author)) {
            throw new Error(`certs/author.p12 (${describe(author)}) is not issued by Samsung, so Samsung TVs reject packages signed with it.\n` +
                'Either import a Samsung one (npm run cert -- import --force), or replace it with\n' +
                '--new-author --name "Your Name" (apps signed with the old one must then be uninstalled before they can be updated).');
        }
    }

    let duids = newDuids;
    let currentLevel = null;
    if (hasDistributor) {
        const distributor = loadLeaf(lib, FILES.distributor, password);
        duids = [...new Set([...duidsOf(distributor), ...newDuids])];
        currentLevel = privilegeOf(distributor);
    }
    const level = args.partner ? 'Partner' : args.public ? 'Public' : currentLevel || 'Public';
    const newPassword = !password;
    if (newPassword) password = crypto.randomBytes(18).toString('base64url');

    console.log(`Distributor certificate will list: ${duids.join(', ')} (${level} level)`);
    if (currentLevel && level !== currentLevel) console.log(`  note: the current one is ${currentLevel} level`);
    console.log(keepAuthor ? 'Keeping certs/author.p12.' : 'Creating a new author certificate for ' + args.name + '.');

    const access = await signIn();
    const creator = new lib.tizen.SamsungCertificateCreator();
    const info = { name: args.name, email: args.email, password, privilegeLevel: level };
    // tizen.js's createCertificate() always makes a new author key, which would
    // stop updates of installed apps, so drive its steps individually.
    await creator._downloadVDCertificates();
    const writes = [];
    if (!keepAuthor) {
        const author = creator._generateAuthorCert(info);
        const authorP12 = creator._generateAuthorPKCS12(author, await creator._fetchAuthorCert(access, author), info);
        writes.push([FILES.author, (tmp) => fs.writeFileSync(tmp, authorP12, { encoding: 'binary' })]);
    }
    const distributor = creator._generateDistributorCert(info, duids);
    const distributorP12 = creator._generateDistributorPKCS12(distributor, await creator._fetchDistributorCert(access, info, distributor), info);
    writes.push([FILES.distributor, (tmp) => fs.writeFileSync(tmp, distributorP12, { encoding: 'binary' })]);
    if (newPassword) writes.push([FILES.password, (tmp) => fs.writeFileSync(tmp, password + '\n', { mode: 0o600 })]);

    replaceFiles(writes);
    show(lib);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const lib = loadTizenJs();
    if (!lib) throw new Error('tizen.js is not installed (npm install pulls it from GitHub as an optional dependency)');
    const cmd = args.positional[0] || 'show';
    if (cmd === 'show') return show(lib);
    if (cmd === 'import') return importCert(lib, args);
    if (cmd === 'add-tv') return addTv(lib, args);
    console.error(USAGE);
    process.exit(2);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
