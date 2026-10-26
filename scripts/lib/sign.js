'use strict';

// Signs a Tizen package (zip buffer) with an author certificate and a
// distributor certificate, using reisxd/tizen.js (optional dependency).
//
// Samsung TVs only install packages whose distributor certificate is issued by
// Samsung and lists the TV's DUID; `npm run cert` puts one in certs/. Without
// it, the Tizen public distributor is used, which Samsung TVs reject.
//
// Defaults (certs/ is git-ignored):
//   certs/author.p12         author certificate
//   certs/distributor.p12    Samsung distributor certificate, if present
//   certs/password.txt       password for both
//
// Env overrides:
//   TIZEN_AUTHOR_KEY         path to the author .p12
//   TIZEN_AUTHOR_KEY_PW      its password
//   TIZEN_DISTRIBUTOR_KEY    path to a distributor .p12
//   TIZEN_DISTRIBUTOR_KEY_PW its password (default: the author password for
//                            certs/distributor.p12, else the Tizen SDK one)
//   TIZEN_PRIVILEGE          public | partner, for the Tizen public distributor

const fs = require('fs');
const path = require('path');
const os = require('os');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..', '..');
const CERTS_DIR = path.join(ROOT, 'certs');
const TIZEN_SDK_DIST_PW = 'tizenpkcs12passfordsigner';

function loadTizenJs() {
    const candidates = ['tizen'];
    if (process.env.TIZENJS_PATH) candidates.unshift(path.resolve(process.env.TIZENJS_PATH));
    for (const c of candidates) {
        try {
            return { tizen: require(c), forge: require(require.resolve('node-forge', { paths: [path.dirname(require.resolve(c))] })) };
        } catch (e) { /* try next */ }
    }
    return null;
}

function readPasswordFile() {
    try {
        return fs.readFileSync(path.join(CERTS_DIR, 'password.txt'), 'utf8').trim() || undefined;
    } catch (e) {
        return undefined;
    }
}

function signingConfig() {
    const authorKey = path.resolve(ROOT, process.env.TIZEN_AUTHOR_KEY || 'certs/author.p12');
    const authorPwd = process.env.TIZEN_AUTHOR_KEY_PW || readPasswordFile();
    const privilege = process.env.TIZEN_PRIVILEGE || 'public';
    const samsungDistributor = path.join(CERTS_DIR, 'distributor.p12');
    let distributorKey, distributorPwd, samsung;
    if (process.env.TIZEN_DISTRIBUTOR_KEY) {
        distributorKey = path.resolve(process.env.TIZEN_DISTRIBUTOR_KEY);
        distributorPwd = process.env.TIZEN_DISTRIBUTOR_KEY_PW || TIZEN_SDK_DIST_PW;
        samsung = null; // unknown until the certificate is read
    } else if (fs.existsSync(samsungDistributor)) {
        distributorKey = samsungDistributor;
        distributorPwd = process.env.TIZEN_DISTRIBUTOR_KEY_PW || authorPwd;
        samsung = true;
    } else {
        // The pre-2022 "tizen-distributor-signer.p12" expired in October 2022.
        distributorKey = path.join(os.homedir(), 'share/.tizen-cert/distributor/sdk-' + privilege + '/tizen-distributor-signer-new.p12');
        distributorPwd = process.env.TIZEN_DISTRIBUTOR_KEY_PW || TIZEN_SDK_DIST_PW;
        samsung = false;
    }
    return { authorKey, authorPwd, distributorKey, distributorPwd, privilege, samsung };
}

// Returns null when signing is possible, otherwise a human explanation.
function whyCannotSign() {
    const lib = loadTizenJs();
    if (!lib) return 'tizen.js is not installed (npm install pulls it from GitHub as an optional dependency)';
    const c = signingConfig();
    if (!fs.existsSync(c.authorKey)) return 'author certificate not found at ' + c.authorKey + ' (run npm run cert)';
    if (!c.authorPwd) return 'no password: put it in certs/password.txt or set TIZEN_AUTHOR_KEY_PW';
    return null;
}

// One line for build/sign output saying which certificates sign the package.
function describeSigning() {
    const c = signingConfig();
    const author = path.relative(process.cwd(), c.authorKey);
    if (c.samsung === true) return author + ' + Samsung distributor ' + path.relative(process.cwd(), c.distributorKey);
    if (c.samsung === false) return author + ' + Tizen public distributor (Samsung TVs reject this; see npm run cert)';
    return author + ' + distributor ' + c.distributorKey;
}

async function ensureDistributor(lib, c) {
    if (fs.existsSync(c.distributorKey)) return;
    if (c.samsung !== false) throw new Error('Distributor certificate not found: ' + c.distributorKey);
    // tizen.js downloads the Tizen SDK certificate bundle into ~/share/.tizen-cert.
    const creator = new lib.tizen.TizenCertificateCreator();
    await creator._downloadTizenCertificates();
    if (!fs.existsSync(c.distributorKey)) throw new Error('Distributor certificate still missing after download: ' + c.distributorKey);
}

function loadP12(forge, file, password) {
    const der = forge.asn1.fromDer(forge.util.createBuffer(fs.readFileSync(file).toString('binary')));
    return forge.pkcs12.pkcs12FromAsn1(der, false, password);
}

async function signZipBuffer(buffer) {
    const lib = loadTizenJs();
    const reason = whyCannotSign();
    if (reason) throw new Error('Cannot sign: ' + reason);
    const c = signingConfig();
    await ensureDistributor(lib, c);

    const zip = await JSZip.loadAsync(buffer);
    const files = [];
    for (const name of Object.keys(zip.files).sort()) {
        const f = zip.files[name];
        if (f.dir) continue;
        if (name === 'author-signature.xml' || /^signature\d+\.xml$/.test(name)) continue;
        // Same URI encoding as tizen.js / TizenBrewInstaller (proven on TVs).
        files.push({ uri: encodeURIComponent(name), data: await f.async('nodebuffer') });
    }

    const authorP12 = loadP12(lib.forge, c.authorKey, c.authorPwd);
    const distributorP12 = loadP12(lib.forge, c.distributorKey, c.distributorPwd);
    const authorFiles = await new lib.tizen.Signature('AuthorSignature', files).sign(authorP12);
    const signedFiles = await new lib.tizen.Signature('DistributorSignature', authorFiles).sign(distributorP12);

    const out = new JSZip();
    for (const f of signedFiles) out.file(decodeURIComponent(f.uri), f.data);
    return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { signZipBuffer, whyCannotSign, describeSigning, signingConfig, loadTizenJs, loadP12, CERTS_DIR };
