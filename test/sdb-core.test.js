'use strict';

const test = require('node:test');
const assert = require('node:assert');
const sdb = require('../packages/sdb-core');
const { startFakeSdbd } = require('./fake-sdbd');

test('packet encode/decode round trip', () => {
    const packets = [];
    const reader = new sdb.PacketReader((p) => packets.push(p));
    const buf = Buffer.concat([
        sdb.encodePacket(sdb.CMD.OPEN, 7, 0, 'shell:ls'),
        sdb.encodePacket(sdb.CMD.OKAY, 1, 7)
    ]);
    // Feed byte by byte to exercise partial reads.
    for (const b of buf) reader.push(Buffer.from([b]));
    assert.strictEqual(packets.length, 2);
    assert.strictEqual(packets[0].command, sdb.CMD.OPEN);
    assert.strictEqual(packets[0].data.toString(), 'shell:ls\0');
    assert.strictEqual(packets[1].arg0, 1);
    assert.strictEqual(packets[1].arg1, 7);
});

test('CMD codes match ASCII names', () => {
    assert.strictEqual(sdb.CMD.CNXN, Buffer.from('CNXN').readUInt32LE(0));
    assert.strictEqual(sdb.CMD.WRTE, Buffer.from('WRTE').readUInt32LE(0));
});

test('shell collects multi-chunk output until CLSE', async () => {
    const fake = await startFakeSdbd([['echo hi', ['h', 'i', '\n']]]);
    try {
        const out = await sdb.shell('echo hi', { port: fake.port });
        assert.strictEqual(out, 'hi\n');
    } finally { await fake.close(); }
});

test('refused service rejects with EREFUSED', async () => {
    const fake = await startFakeSdbd([]);
    try {
        await assert.rejects(sdb.shell('nope', { port: fake.port }), { code: 'EREFUSED' });
    } finally { await fake.close(); }
});

test('install sends vd_appinstall and resolves on "spend time" even if stream stays open', async () => {
    const out = 'app_id[AbCdE12345] installing[ 50%]\napp_id[AbCdE12345] install completed\nspend time for wascmd is [1234]ms\n';
    const fake = await startFakeSdbd([[/^0 vd_appinstall /, out]], { keepOpen: true });
    try {
        const res = await sdb.install('/home/owner/share/tmp/sdk_tools/x.wgt', 'AbCdE12345', { port: fake.port });
        assert.strictEqual(res.ok, true);
        assert.deepStrictEqual(fake.commands, ['shell:0 vd_appinstall AbCdE12345 /home/owner/share/tmp/sdk_tools/x.wgt']);
    } finally { await fake.close(); }
});

test('install reports failure output', async () => {
    const out = 'app_id[AbCdE12345] install failed[118, -12], reason: Signature verification failed\nspend time for wascmd is [99]ms\n';
    const fake = await startFakeSdbd([[/^0 vd_appinstall /, out]]);
    try {
        const res = await sdb.install('/tmp/x.wgt', 'AbCdE12345', { port: fake.port });
        assert.strictEqual(res.ok, false);
        assert.match(res.output, /Signature verification failed/);
    } finally { await fake.close(); }
});

test('install refuses shell-injection in ids and paths', () => {
    assert.throws(() => sdb.install('/tmp/x.wgt', 'AbC; rm -rf /'), { code: 'EINVAL' });
    assert.throws(() => sdb.install('/tmp/x.wgt;reboot', 'AbCdE12345'), { code: 'EINVAL' });
    assert.throws(() => sdb.uninstall('../../etc'), { code: 'EINVAL' });
});

test('debug parses the DevTools port', async () => {
    const fake = await startFakeSdbd([[/^0 debug /, '... successfully launched pid = 1234 with debug 1 port: 34567\n']], { keepOpen: true });
    try {
        const res = await sdb.debug('AbCdE12345.MyApp', { port: fake.port });
        assert.strictEqual(res.port, 34567);
    } finally { await fake.close(); }
});

test('AUTH request is reported clearly', async () => {
    const fake = await startFakeSdbd([], { requireAuth: true });
    try {
        await assert.rejects(sdb.shell('x', { port: fake.port }), { code: 'EAUTH' });
    } finally { await fake.close(); }
});

test('connection refused surfaces ECONNREFUSED', async () => {
    await assert.rejects(sdb.shell('x', { port: 1 }), { code: 'ECONNREFUSED' });
});
