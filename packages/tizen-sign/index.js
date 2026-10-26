'use strict';

// Signs Tizen packages (.wgt/.tpk) with an author and a distributor
// certificate. A port of tizen.js's Signature (reisxd/tizen.js, GPL-3.0) to
// ES5 so it runs inside the TV Installer's service on old Tizen Node runtimes;
// test/tizen-sign.test.js checks the output is byte-identical to tizen.js.
//
// Samsung TVs only accept a package whose distributor certificate is issued by
// Samsung and lists the TV's DUID, so the Installer re-signs every package with
// the user's own certificate before installing it.

var crypto = require('crypto');
var forge = require('node-forge');
var JSZip = require('jszip');

var DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';

// The #prop Object is identical in every signature, so its digest is fixed.
var PROP_DIGEST = {
    AuthorSignature: 'aXbSAVgmAz0GsBUeZ1UmNDRrxkWhDUVGb45dZcNRq429wX3X+x6kaXT3NdNDTSNVTU+ypkysPMGvQY10fG1EWQ==',
    DistributorSignature: '/r5npk2VVA46QFJnejgONBEh4BWtjrtu9x/IFeLksjWyGmB/cMWKSJWQl7aU3YRQRZ3AesG8gF7qGyvKX9Snig=='
};

var SIGNATURE_FILE_RE = /^(author-signature|signature\d+)\.xml$/;

function bufFrom(str) {
    if (typeof Buffer.from === 'function' && Buffer.from !== Uint8Array.from) return Buffer.from(str, 'utf8');
    return new Buffer(str, 'utf8');
}

function wrap76(s) {
    return s.replace(/(.{76})/g, '$1\n');
}

// ---- certificates ----------------------------------------------------------

// Reads a PKCS#12 file into what signing needs: the private key and the
// certificate chain, in the file's own order (as tizen.js emits it).
function loadP12(buffer, password) {
    var der = forge.asn1.fromDer(forge.util.createBuffer(buffer.toString('binary')));
    var p12 = forge.pkcs12.pkcs12FromAsn1(der, false, password);
    var certs = [];
    var keyPem = null;
    for (var i = 0; i < p12.safeContents.length; i++) {
        var bags = p12.safeContents[i].safeBags;
        for (var j = 0; j < bags.length; j++) {
            if (bags[j].type === forge.pki.oids.certBag) certs.push(bags[j].cert);
            else if (bags[j].type === forge.pki.oids.pkcs8ShroudedKeyBag) keyPem = forge.pki.privateKeyToPem(bags[j].key);
        }
    }
    if (!keyPem) throw new Error('The certificate file has no private key');
    if (!certs.length) throw new Error('The certificate file has no certificate');
    var keyN = forge.pki.privateKeyFromPem(keyPem).n;
    var leaf = certs.filter(function (c) { return c.publicKey.n && c.publicKey.n.equals(keyN); })[0] || certs[0];
    return { keyPem: keyPem, certs: certs, leaf: leaf };
}

function cn(attrs) {
    var f = attrs.getField('CN');
    return f ? f.value : '?';
}

function duidsOf(cert) {
    var san = cert.getExtension('subjectAltName');
    var names = (san && san.altNames) || [];
    var out = [];
    for (var i = 0; i < names.length; i++) {
        var m = /^URN:tizen:deviceid=(.+)$/.exec(names[i].value || '');
        if (m) out.push(m[1]);
    }
    return out;
}

// Plain facts about a loaded certificate, safe to show to users.
function describe(loaded) {
    var c = loaded.leaf;
    return {
        name: cn(c.subject),
        issuer: cn(c.issuer),
        samsung: /samsung|\bVD\b/i.test(cn(c.issuer)),
        expires: c.validity.notAfter.toISOString(),
        duids: duidsOf(c)
    };
}

// ---- signature XML -----------------------------------------------------------

function reference(uri, digest) {
    return '<Reference URI="' + uri + '">\n' +
        (uri === '#prop' ? '<Transforms>\n<Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"></Transform>\n</Transforms>\n' : '') +
        '<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha512"></DigestMethod>\n' +
        '<DigestValue>' + wrap76(digest) + '</DigestValue>\n' +
        '</Reference>\n';
}

// files: [{ uri, data }] with uri already percent-encoded. Returns a new list
// with the signature file prepended, like tizen.js's Signature.sign().
function signFiles(id, files, loaded) {
    var refs = '';
    for (var i = 0; i < files.length; i++) {
        refs += reference(files[i].uri, crypto.createHash('sha512').update(files[i].data).digest('base64'));
    }
    refs += reference('#prop', PROP_DIGEST[id]);

    var signedInfo = '<SignedInfo>\n' +
        '<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>\n' +
        '<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha512"></SignatureMethod>\n' +
        refs +
        '</SignedInfo>\n';
    // Exclusive C14N of this SignedInfo only adds the inherited default
    // namespace: it is generated with explicit end tags, one attribute per
    // element, and no characters that need escaping (URIs are percent-encoded).
    var canonical = signedInfo.replace('<SignedInfo>', '<SignedInfo xmlns="' + DSIG_NS + '">').replace(/\n$/, '');
    var signature = crypto.createSign('RSA-SHA512').update(canonical).sign(loaded.keyPem, 'base64');

    var keyInfo = '<KeyInfo>\n<X509Data>';
    for (var j = 0; j < loaded.certs.length; j++) {
        var b64 = wrap76(forge.pki.certificateToPem(loaded.certs[j])
            .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
            .replace(/[\r\n]+/g, ''));
        keyInfo += '\n<X509Certificate>\n' + b64 + '\n</X509Certificate>';
    }
    keyInfo += '\n</X509Data>\n</KeyInfo>\n';

    var role = id === 'AuthorSignature' ? 'author' : 'distributor';
    var xml = '<Signature xmlns="' + DSIG_NS + '" Id="' + id + '">\n' +
        signedInfo +
        '<SignatureValue>\n' + wrap76(signature) + '\n</SignatureValue>\n' +
        keyInfo +
        '<Object Id="prop">' +
        '<SignatureProperties xmlns:dsp="http://www.w3.org/2009/xmldsig-properties">' +
        '<SignatureProperty Id="profile" Target="#' + id + '">' +
        '<dsp:Profile URI="http://www.w3.org/ns/widgets-digsig#profile"></dsp:Profile>' +
        '</SignatureProperty>' +
        '<SignatureProperty Id="role" Target="#' + id + '">' +
        '<dsp:Role URI="http://www.w3.org/ns/widgets-digsig#role-' + role + '"></dsp:Role>' +
        '</SignatureProperty>' +
        '<SignatureProperty Id="identifier" Target="#' + id + '">' +
        '<dsp:Identifier></dsp:Identifier></SignatureProperty></SignatureProperties></Object>\n' +
        '</Signature>\n';

    return [{ uri: id === 'AuthorSignature' ? 'author-signature.xml' : 'signature1.xml', data: bufFrom(xml) }].concat(files);
}

// ---- packages ----------------------------------------------------------------

// Re-signs a package: drops any existing signatures, signs every file with the
// author then the distributor certificate, and zips it again. Unix permissions
// are kept so native (.tpk) executables still run. Resolves with a Buffer.
function signPackage(buffer, author, distributor) {
    var meta = {};
    var unix = false;
    return JSZip.loadAsync(buffer).then(function (zip) {
        var names = Object.keys(zip.files).filter(function (n) {
            return !zip.files[n].dir && !SIGNATURE_FILE_RE.test(n);
        }).sort();
        return Promise.all(names.map(function (n) {
            var f = zip.files[n];
            meta[n] = { unixPermissions: f.unixPermissions, dosPermissions: f.dosPermissions, date: f.date };
            if (f.unixPermissions !== null && f.unixPermissions !== undefined) unix = true;
            return f.async('nodebuffer').then(function (data) {
                // Same URI encoding as tizen.js / TizenBrewInstaller (accepted by TVs).
                return { uri: encodeURIComponent(n), data: data };
            });
        }));
    }).then(function (files) {
        var signed = signFiles('DistributorSignature', signFiles('AuthorSignature', files, author), distributor);
        var out = new JSZip();
        for (var i = 0; i < signed.length; i++) {
            var name = decodeURIComponent(signed[i].uri);
            out.file(name, signed[i].data, meta[name] || {});
        }
        // Stored, not deflated: it is a temporary file on the TV, and deflating
        // in pure JavaScript is the slowest part on a TV CPU. Zips without Unix
        // permissions (e.g. made on Windows) stay that way instead of getting
        // invented modes.
        return out.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: unix ? 'UNIX' : 'DOS' });
    });
}

module.exports = {
    loadP12: loadP12,
    describe: describe,
    signFiles: signFiles,
    signPackage: signPackage,
    SIGNATURE_FILE_RE: SIGNATURE_FILE_RE
};
