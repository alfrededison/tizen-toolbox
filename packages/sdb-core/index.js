'use strict';

// Minimal SDB (Samsung's fork of the ADB protocol) client for talking to the
// TV's own sdbd from an app running on the TV. Works only when Developer Mode
// is on and "Host PC IP" is 127.0.0.1, because sdbd only accepts connections
// from the configured host address.
//
// Written to run on old Tizen Node runtimes after Babel transpilation, so it
// avoids newer runtime APIs (no async/await, no Buffer.alloc requirement).

var net = require('net');
var http = require('http');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var SDB_PORT = 26101;
var DEV_API_URL = 'http://127.0.0.1:8001/api/v2/';
var VERSION = 0x01000000;
var MAX_PAYLOAD = 4096;

function cmdCode(name) {
    return name.charCodeAt(0) | (name.charCodeAt(1) << 8) | (name.charCodeAt(2) << 16) | ((name.charCodeAt(3) << 24) >>> 0);
}

var CMD = {
    SYNC: cmdCode('SYNC') >>> 0,
    CNXN: cmdCode('CNXN') >>> 0,
    AUTH: cmdCode('AUTH') >>> 0,
    OPEN: cmdCode('OPEN') >>> 0,
    OKAY: cmdCode('OKAY') >>> 0,
    CLSE: cmdCode('CLSE') >>> 0,
    WRTE: cmdCode('WRTE') >>> 0
};

function bufAlloc(n) {
    if (typeof Buffer.alloc === 'function') return Buffer.alloc(n);
    var b = new Buffer(n);
    b.fill(0);
    return b;
}

function bufFrom(str) {
    if (typeof Buffer.from === 'function' && Buffer.from !== Uint8Array.from) return Buffer.from(str, 'utf8');
    return new Buffer(str, 'utf8');
}

function checksum(data) {
    var sum = 0;
    if (!data) return 0;
    for (var i = 0; i < data.length; i++) sum = (sum + data[i]) >>> 0;
    return sum;
}

function encodePacket(command, arg0, arg1, data) {
    var payload = data || null;
    if (typeof payload === 'string') payload = bufFrom(payload + '\0');
    var len = payload ? payload.length : 0;
    var buf = bufAlloc(24 + len);
    buf.writeUInt32LE(command >>> 0, 0);
    buf.writeUInt32LE(arg0 >>> 0, 4);
    buf.writeUInt32LE(arg1 >>> 0, 8);
    buf.writeUInt32LE(len, 12);
    buf.writeUInt32LE(checksum(payload), 16);
    buf.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
    if (len) payload.copy(buf, 24);
    return buf;
}

// Incremental packet decoder. Feed it socket chunks; it emits whole packets.
function PacketReader(onPacket) {
    this._buf = bufAlloc(0);
    this._onPacket = onPacket;
}

PacketReader.prototype.push = function (chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (this._buf.length >= 24) {
        var len = this._buf.readUInt32LE(12);
        if (this._buf.length < 24 + len) break;
        var packet = {
            command: this._buf.readUInt32LE(0),
            arg0: this._buf.readUInt32LE(4),
            arg1: this._buf.readUInt32LE(8),
            data: this._buf.slice(24, 24 + len)
        };
        this._buf = this._buf.slice(24 + len);
        this._onPacket(packet);
    }
};

// One SDB connection (one TCP socket) that can carry several streams.
function SdbConnection(opts) {
    EventEmitter.call(this);
    opts = opts || {};
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port || Number(process.env.TBOX_SDB_PORT) || SDB_PORT;
    this.connectTimeoutMs = opts.connectTimeoutMs || 5000;
    this._socket = null;
    this._nextLocalId = 1;
    this._streams = {};
    this._connected = false;
    this._closed = false;
    this.maxPayload = MAX_PAYLOAD;
    this.banner = null;
}
util.inherits(SdbConnection, EventEmitter);

SdbConnection.prototype.connect = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
        var settled = false;
        function fail(err) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            self.close();
            reject(err);
        }
        var timer = setTimeout(function () {
            var err = new Error('Timed out connecting to sdbd at ' + self.host + ':' + self.port);
            err.code = 'ETIMEDOUT';
            fail(err);
        }, self.connectTimeoutMs);

        var reader = new PacketReader(function (p) { self._onPacket(p); });
        var socket = net.connect(self.port, self.host);
        self._socket = socket;
        socket.on('connect', function () {
            socket.write(encodePacket(CMD.CNXN, VERSION, MAX_PAYLOAD, 'host::'));
        });
        socket.on('data', function (chunk) { reader.push(chunk); });
        socket.on('error', function (err) {
            if (!settled) return fail(err);
            self._failAll(err);
        });
        socket.on('close', function () {
            self._connected = false;
            if (!settled) {
                var err = new Error('sdbd closed the connection before the handshake');
                err.code = 'ECONNRESET';
                return fail(err);
            }
            self._failAll(new Error('SDB connection closed'));
        });
        self.once('_cnxn', function () {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(self);
        });
        self.once('_auth', function () {
            var err = new Error('sdbd asked for authentication (not supported)');
            err.code = 'EAUTH';
            fail(err);
        });
    });
};

SdbConnection.prototype._send = function (command, arg0, arg1, data) {
    if (!this._socket || this._closed) return;
    this._socket.write(encodePacket(command, arg0, arg1, data));
};

SdbConnection.prototype._onPacket = function (p) {
    var stream;
    switch (p.command) {
        case CMD.CNXN:
            this._connected = true;
            if (p.arg1 && p.arg1 < this.maxPayload) this.maxPayload = p.arg1;
            this.banner = p.data.toString('utf8').replace(/\0+$/, '');
            this.emit('_cnxn');
            break;
        case CMD.AUTH:
            this.emit('_auth');
            break;
        case CMD.OKAY:
            stream = this._streams[p.arg1];
            if (stream) stream._onOkay(p.arg0);
            break;
        case CMD.WRTE:
            stream = this._streams[p.arg1];
            if (stream) {
                this._send(CMD.OKAY, stream.localId, p.arg0);
                stream._onData(p.data);
            } else {
                this._send(CMD.CLSE, 0, p.arg0);
            }
            break;
        case CMD.CLSE:
            stream = this._streams[p.arg1];
            if (stream) {
                delete this._streams[p.arg1];
                if (stream.remoteId) this._send(CMD.CLSE, stream.localId, stream.remoteId);
                stream._onClose();
            }
            break;
        default:
            break;
    }
};

SdbConnection.prototype._failAll = function (err) {
    var ids = Object.keys(this._streams);
    for (var i = 0; i < ids.length; i++) {
        var s = this._streams[ids[i]];
        delete this._streams[ids[i]];
        s._onError(err);
    }
};

// Opens a service stream such as "shell:<cmd>". Returns an SdbStream.
SdbConnection.prototype.open = function (service) {
    var stream = new SdbStream(this, this._nextLocalId++);
    this._streams[stream.localId] = stream;
    this._send(CMD.OPEN, stream.localId, 0, service);
    return stream;
};

SdbConnection.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;
    if (this._socket) {
        try { this._socket.end(); } catch (e) { /* ignore */ }
        try { this._socket.destroy(); } catch (e) { /* ignore */ }
    }
};

function SdbStream(conn, localId) {
    EventEmitter.call(this);
    this.conn = conn;
    this.localId = localId;
    this.remoteId = 0;
    this.closed = false;
}
util.inherits(SdbStream, EventEmitter);

SdbStream.prototype._onOkay = function (remoteId) {
    if (!this.remoteId) {
        this.remoteId = remoteId;
        this.emit('open');
    } else {
        this.emit('_okay');
    }
};
SdbStream.prototype._onData = function (data) { this.emit('data', data); };
SdbStream.prototype._onClose = function () {
    if (this.closed) return;
    this.closed = true;
    // A CLSE before any OKAY means sdbd refused to open the service.
    this.emit('close', !this.remoteId);
};
SdbStream.prototype._onError = function (err) {
    if (this.closed) return;
    this.closed = true;
    this.emit('error', err);
};
SdbStream.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    delete this.conn._streams[this.localId];
    if (this.remoteId) this.conn._send(CMD.CLSE, this.localId, this.remoteId);
};

// Runs a shell command over an existing connection and collects its output.
// opts.doneWhen: RegExp; resolve early once output matches (some TV tools
//   keep the stream open after printing their result).
// opts.timeoutMs: give up after this long (resolves with what we have if
//   opts.resolveOnTimeout, otherwise rejects).
SdbConnection.prototype.shell = function (command, opts) {
    var self = this;
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 30000;
    return new Promise(function (resolve, reject) {
        var output = '';
        var done = false;
        var graceTimer = null;
        var stream = self.open('shell:' + command);
        var timer = setTimeout(function () {
            if (opts.resolveOnTimeout) return finish(null);
            var err = new Error('Timed out waiting for: ' + command);
            err.code = 'ETIMEDOUT';
            err.output = output;
            finish(err);
        }, timeoutMs);

        function finish(err) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (graceTimer) clearTimeout(graceTimer);
            stream.close();
            if (err) reject(err); else resolve(output);
        }

        stream.on('data', function (data) {
            output += data.toString('utf8');
            if (opts.onOutput) opts.onOutput(data.toString('utf8'));
            if (opts.doneWhen && opts.doneWhen.test(output) && !graceTimer) {
                // Give the tool a moment to print anything after the marker.
                graceTimer = setTimeout(function () { finish(null); }, opts.graceMs || 300);
            }
        });
        stream.on('close', function (refused) {
            if (refused) {
                var err = new Error('sdbd refused to open shell for: ' + command);
                err.code = 'EREFUSED';
                return finish(err);
            }
            finish(null);
        });
        stream.on('error', function (err) {
            err.output = output;
            finish(err);
        });
    });
};

// ---------------------------------------------------------------------------
// High-level helpers. Each one opens its own short-lived connection so that
// several apps on the TV can share sdbd without holding sockets open.

function withConnection(opts, fn) {
    var conn = new SdbConnection(opts);
    return conn.connect().then(function () {
        return Promise.resolve(fn(conn)).then(function (result) {
            conn.close();
            return result;
        }, function (err) {
            conn.close();
            throw err;
        });
    });
}

function shell(command, opts) {
    return withConnection(opts, function (conn) { return conn.shell(command, opts); });
}

var PKG_ID_RE = /^[A-Za-z0-9]{10}$/;
var APP_ID_RE = /^[A-Za-z0-9]{10}\.[A-Za-z0-9_\-]{1,52}$/;
var PATH_RE = /^\/[A-Za-z0-9_\-.\/]+$/;

function assertMatch(value, re, what) {
    if (typeof value !== 'string' || !re.test(value)) {
        var err = new Error('Invalid ' + what + ': ' + value);
        err.code = 'EINVAL';
        throw err;
    }
}

function judge(output, okRe) {
    var failed = /fail|error|invalid|denied|not found/i.test(output);
    return okRe.test(output) && !failed;
}

// Installs a .wgt/.tpk that already sits on the TV's filesystem.
function install(packagePath, packageId, opts) {
    assertMatch(packageId, PKG_ID_RE, 'package id');
    assertMatch(packagePath, PATH_RE, 'package path');
    opts = opts || {};
    return shell('0 vd_appinstall ' + packageId + ' ' + packagePath, {
        timeoutMs: opts.timeoutMs || 180000,
        doneWhen: /spend time/i,
        resolveOnTimeout: false,
        onOutput: opts.onOutput,
        port: opts.port,
        host: opts.host
    }).then(function (output) {
        return { ok: judge(output, /install completed|installed/i), output: output };
    });
}

function uninstall(packageId, opts) {
    assertMatch(packageId, PKG_ID_RE, 'package id');
    opts = opts || {};
    return shell('0 vd_appuninstall ' + packageId, {
        timeoutMs: opts.timeoutMs || 120000,
        doneWhen: /spend time/i,
        onOutput: opts.onOutput,
        port: opts.port,
        host: opts.host
    }).then(function (output) {
        return { ok: judge(output, /uninstall completed|uninstalled/i), output: output };
    });
}

// Launches an app in debug mode and returns the Chrome DevTools port.
function debug(appId, opts) {
    assertMatch(appId, APP_ID_RE, 'app id');
    opts = opts || {};
    var extra = opts.tizen3 ? ' 0' : '';
    return shell('0 debug ' + appId + extra, {
        timeoutMs: opts.timeoutMs || 30000,
        doneWhen: /port\s*:\s*\d+/i,
        graceMs: 50,
        port: opts.port,
        host: opts.host
    }).then(function (output) {
        var m = /port\s*:\s*(\d+)/i.exec(output);
        if (!m) {
            var err = new Error('Could not find a debug port in: ' + output.trim());
            err.output = output;
            throw err;
        }
        return { port: Number(m[1]), output: output };
    });
}

function getDuid(opts) {
    return shell('0 getduid', opts).then(function (out) { return out.trim(); });
}

// Reads the TV's own REST API (always on, LAN + localhost) to see whether
// Developer Mode is enabled and which host IP it trusts.
function getDevInfo(opts) {
    opts = opts || {};
    var url = opts.url || process.env.TBOX_DEVAPI_URL || DEV_API_URL;
    return new Promise(function (resolve, reject) {
        var req = http.get(url, function (res) {
            var body = '';
            res.setEncoding('utf8');
            res.on('data', function (c) { body += c; });
            res.on('end', function () {
                var json;
                try { json = JSON.parse(body); } catch (e) { return reject(new Error('Bad JSON from ' + url)); }
                var d = json.device || {};
                var hostIp = d.developerIP || '';
                resolve({
                    devModeEnabled: String(d.developerMode) === '1',
                    hostIp: hostIp,
                    hostIsLocal: hostIp === '127.0.0.1' || hostIp === '1.0.0.127',
                    ip: d.ip || null,
                    model: d.modelName || d.model || null,
                    name: d.name || null,
                    os: d.OS || null,
                    firmwareVersion: d.firmwareVersion || null
                });
            });
        });
        req.on('error', reject);
        req.setTimeout(opts.timeoutMs || 3000, function () {
            req.abort();
            reject(new Error('Timed out reading ' + url));
        });
    });
}

module.exports = {
    SdbConnection: SdbConnection,
    PacketReader: PacketReader,
    encodePacket: encodePacket,
    CMD: CMD,
    shell: shell,
    install: install,
    uninstall: uninstall,
    debug: debug,
    getDuid: getDuid,
    getDevInfo: getDevInfo,
    PKG_ID_RE: PKG_ID_RE,
    APP_ID_RE: APP_ID_RE
};
