'use strict';

// Signs a Tizen package (zip buffer) with an author certificate and a
// distributor certificate, using reisxd/tizen.js (optional dependency).
//
// Env:
//   TIZEN_AUTHOR_KEY         path to the author .p12 (default: ./certs/author.p12)
//   TIZEN_AUTHOR_KEY_PW      its password
//   TIZEN_DISTRIBUTOR_KEY    path to a distributor .p12 (default: Tizen public
//                            distributor from ~/share/.tizen-cert, which tizen.js downloads)
//   TIZEN_DISTRIBUTOR_KEY_PW its password (default: the well-known Tizen SDK one)
//   TIZEN_PRIVILEGE          public | partner (default public)

const fs = require('fs');
const path = require('path');
const os = require('os');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..', '..');
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

function signingConfig() {
    const authorKey = path.resolve(ROOT, process.env.TIZEN_AUTHOR_KEY || 'certs/author.p12');
    const authorPwd = process.env.TIZEN_AUTHOR_KEY_PW;
    const privilege = process.env.TIZEN_PRIVILEGE || 'public';
    const distributorKey = process.env.TIZEN_DISTRIBUTOR_KEY
        ? path.resolve(process.env.TIZEN_DISTRIBUTOR_KEY)
        : path.join(os.homedir(), 'share/.tizen-cert/distributor/sdk-' + privilege + '/tizen-distributor-signer.p12');
    const distributorPwd = process.env.TIZEN_DISTRIBUTOR_KEY_PW || TIZEN_SDK_DIST_PW;
    return { authorKey, authorPwd, distributorKey, distributorPwd, privilege };
}

// Returns null when signing is possible, otherwise a human explanation.
function whyCannotSign() {
    const lib = loadTizenJs();
    if (!lib) return 'tizen.js is not installed (npm install pulls it from GitHub as an optional dependency)';
    const c = signingConfig();
    if (!fs.existsSync(c.authorKey)) return 'author certificate not found at ' + c.authorKey + ' (set TIZEN_AUTHOR_KEY)';
    if (!c.authorPwd) return 'TIZEN_AUTHOR_KEY_PW is not set';
    return null;
}

async function ensureDistributor(lib, c) {
    if (fs.existsSync(c.distributorKey)) return;
    if (process.env.TIZEN_DISTRIBUTOR_KEY) throw new Error('Distributor certificate not found: ' + c.distributorKey);
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

module.exports = { signZipBuffer, whyCannotSign, signingConfig };
