'use strict';

// Keeps the user's signing certificate on the TV and re-signs packages with it,
// so any package installs on a Samsung TV whose DUID the certificate lists.
// The files live in the app's private data directory (only this app can read
// it) and are never sent back over the API; only a description is.

var fs = require('fs');
var path = require('path');
var tizenSign = require('../../../../packages/tizen-sign');

var FILES = { author: 'author.p12', distributor: 'distributor.p12', password: 'password.txt' };

function bufFromBase64(s) {
    if (typeof Buffer.from === 'function' && Buffer.from !== Uint8Array.from) return Buffer.from(s, 'base64');
    return new Buffer(s, 'base64');
}

function httpError(status, message) {
    var e = new Error(message);
    e.status = status;
    return e;
}

// The first candidate where this app can create files, or null.
function findPrivateDir(candidates) {
    for (var i = 0; i < candidates.length; i++) {
        var base = candidates[i];
        if (!base || !fs.existsSync(base)) continue;
        var dir = path.join(base, 'signing');
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, 448); // 0700
            var probe = path.join(dir, '.probe');
            fs.writeFileSync(probe, '');
            fs.unlinkSync(probe);
            return dir;
        } catch (e) { /* try the next one */ }
    }
    return null;
}

// Tizen web apps' private storage ("wgt-private") is <apps_rw>/<pkgId>/data.
function defaultCandidates(packageId) {
    if (process.env.TBOX_DATA_DIR) return [process.env.TBOX_DATA_DIR];
    if (!packageId) return [];
    return [
        '/home/owner/apps_rw/' + packageId + '/data',
        '/opt/usr/home/owner/apps_rw/' + packageId + '/data'
    ];
}

// The Installer's own author-signature.xml (it records the author certificate
// the Installer was installed with), looked for above the running service.
function findOwnSignature(start) {
    var dir = start;
    for (var i = 0; i < 5; i++) {
        var f = path.join(dir, 'author-signature.xml');
        if (fs.existsSync(f)) return f;
        var up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
}

// The signer certificate of a signature file (the first <X509Certificate>), or null.
function readSigner(file) {
    try {
        var m = /<X509Certificate>([^<]+)<\/X509Certificate>/.exec(fs.readFileSync(file, 'utf8'));
        return m ? tizenSign.certificateFromBase64(m[1]) : null;
    } catch (e) {
        return null;
    }
}

// How a certificate pair is shown to users. A Samsung author certificate's own
// name is often shared by several pairs (e.g. one per privilege level), so the
// distributor's level is added to tell them apart: "Jelly2Sams (Partner)".
function labelOf(author, distributor) {
    return author.name + (distributor && distributor.level ? ' (' + distributor.level + ')' : '');
}

// The author certificate the Installer was installed with, from its own
// author-signature.xml (and its level from signature1.xml next to it).
function readOwnSigner(authorSignatureFile) {
    var author = authorSignatureFile && readSigner(authorSignatureFile);
    if (!author) return null;
    var distributor = readSigner(path.join(path.dirname(authorSignatureFile), 'signature1.xml'));
    return {
        // Re-encoded the same way as ours, so equal certificates compare equal.
        cert: tizenSign.certificateBase64(author),
        name: labelOf(tizenSign.describe({ leaf: author }), distributor && tizenSign.describe({ leaf: distributor }))
    };
}

// ownSignatureFile: the Installer's own author-signature.xml, to warn when the
// stored author certificate differs from the one the Installer was installed
// with (it then can't update itself).
function createSigningStore(dir, ownSignatureFile) {
    var own = readOwnSigner(ownSignatureFile);

    var cached = null;
    // A stored set that fails to open stays broken until replaced or removed;
    // remembering that keeps status polls from re-running the slow PKCS#12 decode.
    var cachedError = null;

    function file(name) { return path.join(dir, name); }

    function configured() {
        return !!dir && fs.existsSync(file(FILES.author)) && fs.existsSync(file(FILES.distributor)) && fs.existsSync(file(FILES.password));
    }

    // The parsed keys, or null when none are stored; throws if they don't open.
    function load() {
        if (cached) return cached;
        if (cachedError) throw cachedError;
        if (!configured()) return null;
        try {
            // Stored exactly as given: passwords may start or end with spaces.
            var password = fs.readFileSync(file(FILES.password), 'utf8');
            cached = {
                author: tizenSign.loadP12(fs.readFileSync(file(FILES.author)), password),
                distributor: tizenSign.loadP12(fs.readFileSync(file(FILES.distributor)), password)
            };
        } catch (e) {
            cachedError = e;
            throw e;
        }
        return cached;
    }

    // duid: this TV's DUID, if known, to say whether the certificate covers it.
    function summary(duid) {
        if (!dir) return { configured: false, storage: false };
        var loaded;
        try { loaded = load(); } catch (e) {
            return { configured: true, storage: true, error: 'Cannot read the stored certificate: ' + e.message };
        }
        if (!loaded) return { configured: false, storage: true };
        var author = tizenSign.describe(loaded.author);
        var distributor = tizenSign.describe(loaded.distributor);
        return {
            configured: true,
            storage: true,
            label: labelOf(author, distributor),
            author: author,
            distributor: distributor,
            coversThisTv: duid ? distributor.duids.indexOf(duid) !== -1 : null,
            // The TV compares an update's signer with the installed copy's signer.
            matchesInstaller: own ? own.cert === tizenSign.certificateBase64(loaded.author.leaf) : null
        };
    }

    // Problems worth telling the user right after an upload.
    function warnings(s, duid) {
        var out = [];
        if (s.author && !s.author.samsung) out.push('The author certificate is not issued by Samsung; Samsung TVs reject packages signed with it.');
        if (s.distributor && !s.distributor.samsung) out.push('The distributor certificate is not issued by Samsung; Samsung TVs reject packages signed with it.');
        if (s.matchesInstaller === false) {
            out.push('The TV Installer was installed with ' + own.name + ', a different certificate, so it can\'t update itself ' +
                'with this one. Upload the certificate it was installed with; for Apps2Samsung, the folder chosen in its Certificate setting.');
        }
        if (s.coversThisTv === false) out.push('The distributor certificate does not list this TV (DUID ' + duid + '); add it with npm run cert -- add-tv ' + duid + '.');
        return out;
    }

    // body: { author, distributor } as base64 .p12 files, plus their password.
    function save(body, duid) {
        if (!dir) throw httpError(500, 'Found no private storage on this TV for the certificate.');
        if (!body || typeof body.author !== 'string' || typeof body.distributor !== 'string' || typeof body.password !== 'string') {
            throw httpError(400, 'Send author and distributor (.p12, base64) and password.');
        }
        var authorBuf = bufFromBase64(body.author);
        var distributorBuf = bufFromBase64(body.distributor);
        var loaded;
        try {
            loaded = {
                author: tizenSign.loadP12(authorBuf, body.password),
                distributor: tizenSign.loadP12(distributorBuf, body.password)
            };
        } catch (e) {
            throw httpError(400, 'Cannot open the certificates (' + e.message + '). Check the password and that both files are .p12.');
        }
        // Write all three before replacing any, so a failed write (e.g. a full
        // disk) leaves the old set intact.
        var writes = [[FILES.author, authorBuf], [FILES.distributor, distributorBuf], [FILES.password, body.password]];
        for (var i = 0; i < writes.length; i++) fs.writeFileSync(file(writes[i][0] + '.new'), writes[i][1], { mode: 384 }); // 0600
        for (var j = 0; j < writes.length; j++) fs.renameSync(file(writes[j][0] + '.new'), file(writes[j][0]));
        cached = loaded;
        cachedError = null;
        var s = summary(duid);
        s.warnings = warnings(s, duid);
        return s;
    }

    function remove() {
        cached = null;
        cachedError = null;
        if (!dir) return;
        for (var k in FILES) {
            try { fs.unlinkSync(file(FILES[k])); } catch (e) { /* not there */ }
        }
    }

    // keys: from load(), taken once when an install starts, so replacing or
    // removing the certificate meanwhile doesn't affect that install.
    function signPackage(buffer, keys) {
        return tizenSign.signPackage(buffer, keys.author, keys.distributor);
    }

    return { dir: dir, own: own, configured: configured, load: load, summary: summary, save: save, remove: remove, signPackage: signPackage };
}

module.exports = { createSigningStore: createSigningStore, findOwnSignature: findOwnSignature, findPrivateDir: findPrivateDir, defaultCandidates: defaultCandidates };
