'use strict';

// Test certificates shaped like Samsung's: a leaf plus its CA in one PKCS#12.

const forge = require('node-forge');

const PASSWORD = 'test-password';

// A PKCS#12 like Samsung's: a leaf certificate plus its CA, both in the file.
function makeP12({ cn, issuer, duids, password = PASSWORD }) {
    const caKeys = forge.pki.rsa.generateKeyPair(1024);
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const cert = (subject, issuerName, publicKey, signKey, extensions) => {
        const c = forge.pki.createCertificate();
        c.publicKey = publicKey;
        c.serialNumber = '0' + Math.floor(Math.random() * 1e9);
        c.validity.notBefore = new Date('2025-01-01');
        c.validity.notAfter = new Date('2027-09-14');
        c.setSubject([{ name: 'commonName', value: subject }]);
        c.setIssuer([{ name: 'commonName', value: issuerName }]);
        if (extensions) c.setExtensions(extensions);
        c.sign(signKey, forge.md.sha256.create());
        return c;
    };
    const ca = cert(issuer, issuer, caKeys.publicKey, caKeys.privateKey);
    const san = duids && [{ name: 'subjectAltName', altNames: ['URN:tizen:packageid=', ...duids.map((d) => 'URN:tizen:deviceid=' + d)].map((value) => ({ type: 6, value })) }];
    const leaf = cert(cn, issuer, keys.publicKey, caKeys.privateKey, san);
    const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [leaf, ca], password, { generateLocalKeyId: true, friendlyName: 'UserCertificate' });
    return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

module.exports = { makeP12, PASSWORD };
