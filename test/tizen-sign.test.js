'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const forge = require('node-forge');
const JSZip = require('jszip');
const sign = require('../packages/tizen-sign');

const { makeP12, PASSWORD } = require('./certs');

const author = makeP12({ cn: 'Jelly2Sams', issuer: 'Samsung VD Author CA' });
const distributor = makeP12({ cn: 'TizenSDK', issuer: 'VD DEVELOPER Public CA Class', duids: ['BDCI6YW6SR6YO'] });

function loadTizenJs() {
    try { return require('tizen'); } catch (e) { return null; }
}

test('loadP12 and describe read the certificate facts users see', () => {
    const a = sign.describe(sign.loadP12(author, PASSWORD));
    assert.deepStrictEqual(a, { name: 'Jelly2Sams', issuer: 'Samsung VD Author CA', samsung: true, expires: '2027-09-14T00:00:00.000Z', duids: [] });
    const d = sign.describe(sign.loadP12(distributor, PASSWORD));
    assert.deepStrictEqual(d.duids, ['BDCI6YW6SR6YO']);
    assert.throws(() => sign.loadP12(author, 'wrong'), /Invalid password|MAC/i);
});

test('signatures are byte-identical to tizen.js', { skip: !loadTizenJs() && 'tizen.js not installed' }, async () => {
    const tizen = loadTizenJs();
    const blob = crypto.randomBytes(3000);
    const files = () => [
        { uri: 'config.xml', data: Buffer.from('<widget/>') },
        { uri: encodeURIComponent('js/app (1).js'), data: blob },
        { uri: 'index.html', data: Buffer.from('<html></html>') },
    ];
    const p12 = (buf) => forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(buf.toString('binary'))), false, PASSWORD);

    const theirs = await new tizen.Signature('DistributorSignature',
        await new tizen.Signature('AuthorSignature', files()).sign(p12(author))).sign(p12(distributor));
    const ours = sign.signFiles('DistributorSignature',
        sign.signFiles('AuthorSignature', files(), sign.loadP12(author, PASSWORD)), sign.loadP12(distributor, PASSWORD));

    assert.deepStrictEqual(ours.map((f) => f.uri), theirs.map((f) => f.uri));
    for (let i = 0; i < ours.length; i++) {
        assert.strictEqual(ours[i].data.toString('utf8'), theirs[i].data.toString('utf8'), ours[i].uri);
    }
});

test('signPackage replaces old signatures and keeps unix permissions', async () => {
    const zip = new JSZip();
    zip.file('config.xml', '<widget/>');
    zip.file('bin/app', 'binary', { unixPermissions: 0o100755 });
    zip.file('signature1.xml', 'old');
    zip.file('author-signature.xml', 'old');
    zip.file('signature2.xml', 'old');
    const input = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });

    const out = await JSZip.loadAsync(await sign.signPackage(input, sign.loadP12(author, PASSWORD), sign.loadP12(distributor, PASSWORD)));
    const names = Object.keys(out.files).filter((n) => !out.files[n].dir).sort();
    assert.deepStrictEqual(names, ['author-signature.xml', 'bin/app', 'config.xml', 'signature1.xml']);
    assert.strictEqual(out.files['bin/app'].unixPermissions & 0o777, 0o755);

    const authorXml = await out.files['author-signature.xml'].async('string');
    const digest = crypto.createHash('sha512').update(await out.files['bin/app'].async('nodebuffer')).digest('base64');
    assert.ok(authorXml.includes('<Reference URI="bin%2Fapp">'));
    assert.ok(authorXml.replace(/\s+/g, '').includes(digest), 'author signature covers bin/app');
    const distributorXml = await out.files['signature1.xml'].async('string');
    assert.ok(distributorXml.includes('<Reference URI="author-signature.xml">'));
});

test('signPackage keeps zips without unix permissions as DOS', async () => {
    const zip = new JSZip();
    zip.file('config.xml', '<widget/>');
    const input = await zip.generateAsync({ type: 'nodebuffer', platform: 'DOS' });
    const out = await JSZip.loadAsync(await sign.signPackage(input, sign.loadP12(author, PASSWORD), sign.loadP12(distributor, PASSWORD)));
    assert.strictEqual(out.files['config.xml'].unixPermissions, null);
});
