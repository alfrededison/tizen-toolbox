'use strict';

// A tiny fake sdbd for tests. It speaks just enough of the protocol:
// CNXN handshake, OPEN of "shell:<cmd>", WRTE replies and CLSE.
// `handlers` maps a shell command (string or RegExp) to output text, an
// array of chunks, or a function(cmd) returning those. Unknown commands are
// refused with CLSE (like sdbd does for unknown services).

const net = require('net');
const { PacketReader, encodePacket, CMD } = require('../packages/sdb-core');

function startFakeSdbd(handlers, opts = {}) {
    const commands = [];
    const server = net.createServer((socket) => {
        let nextRemote = 1000;
        const reader = new PacketReader((p) => {
            if (p.command === CMD.CNXN) {
                if (opts.requireAuth) {
                    socket.write(encodePacket(CMD.AUTH, 1, 0, Buffer.alloc(20)));
                    return;
                }
                socket.write(encodePacket(CMD.CNXN, 0x01000000, 4096, 'device::ro.product.name=fake;'));
                return;
            }
            if (p.command === CMD.OPEN) {
                const service = p.data.toString('utf8').replace(/\0+$/, '');
                const localId = p.arg0;
                const cmd = service.replace(/^shell:/, '');
                commands.push(service);
                let out = null;
                for (const [key, value] of handlers) {
                    if (typeof key === 'string' ? key === cmd : key.test(cmd)) {
                        out = typeof value === 'function' ? value(cmd) : value;
                        break;
                    }
                }
                if (out === null) {
                    socket.write(encodePacket(CMD.CLSE, 0, localId));
                    return;
                }
                const remoteId = nextRemote++;
                socket.write(encodePacket(CMD.OKAY, remoteId, localId));
                const chunks = Array.isArray(out) ? out : [out];
                let i = 0;
                const sendNext = () => {
                    if (i < chunks.length) {
                        socket.write(encodePacket(CMD.WRTE, remoteId, localId, Buffer.from(chunks[i++])));
                        setTimeout(sendNext, 5);
                    } else if (!opts.keepOpen) {
                        socket.write(encodePacket(CMD.CLSE, remoteId, localId));
                    }
                };
                setTimeout(sendNext, 5);
            }
        });
        socket.on('data', (c) => reader.push(c));
        socket.on('error', () => {});
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: server.address().port,
                commands,
                close: () => new Promise((r) => server.close(r))
            });
        });
    });
}

module.exports = { startFakeSdbd };
