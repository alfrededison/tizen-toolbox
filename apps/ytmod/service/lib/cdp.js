'use strict';

// Minimal Chrome DevTools Protocol client: finds the page target that sdbd's
// "debug" launch exposes, opens its WebSocket and offers send() + events.
// Written in ES5 style (Babel only handles syntax) for old Tizen runtimes.

var http = require('http');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var WebSocket = require('ws');

function getJson(host, port, path, timeoutMs) {
    return new Promise(function (resolve, reject) {
        var req = http.get({ host: host, port: port, path: path, agent: false }, function (res) {
            var body = '';
            res.setEncoding('utf8');
            res.on('data', function (c) { body += c; });
            res.on('end', function () {
                if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + path));
                try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Bad JSON from ' + path)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 2000, function () {
            req.abort();
            reject(new Error('Timed out'));
        });
    });
}

function pickTarget(list) {
    if (!Array.isArray(list)) return null;
    var withWs = list.filter(function (t) { return t && t.webSocketDebuggerUrl; });
    for (var i = 0; i < withWs.length; i++) if (withWs[i].type === 'page') return withWs[i];
    return withWs[0] || null;
}

// The inspector may report a WebSocket URL with a host we can't reach
// (e.g. its own interface name); point it at the host:port that answered.
function rewriteWsUrl(wsUrl, host, port) {
    return String(wsUrl).replace(/^(wss?:\/\/)[^\/]+/, '$1' + host + ':' + port);
}

// Tries each host until one answers /json/list (or /json) with a debuggable
// target, retrying until the deadline because the inspector starts a moment
// after the app does.
function findTarget(hosts, port, opts) {
    opts = opts || {};
    var deadline = Date.now() + (opts.timeoutMs || 20000);
    var interval = opts.intervalMs || 250;
    var lastError = null;
    hosts = hosts.filter(function (h, i) { return h && hosts.indexOf(h) === i; });

    function tryHost(i) {
        if (i >= hosts.length) return Promise.resolve(null);
        var host = hosts[i];
        return getJson(host, port, '/json/list', 1500).catch(function () {
            return getJson(host, port, '/json', 1500);
        }).then(function (list) {
            var t = pickTarget(list);
            if (!t) throw new Error('No debuggable page on ' + host + ':' + port);
            return { host: host, port: port, target: t, wsUrl: rewriteWsUrl(t.webSocketDebuggerUrl, host, port) };
        }).catch(function (err) {
            lastError = err;
            return tryHost(i + 1);
        });
    }

    function attempt() {
        return tryHost(0).then(function (found) {
            if (found) return found;
            if (Date.now() >= deadline) {
                var e = new Error('DevTools did not answer on port ' + port + ' (' + hosts.join(', ') + '): ' + (lastError ? lastError.message : 'no response'));
                e.code = 'ENOTARGET';
                throw e;
            }
            return new Promise(function (r) { setTimeout(r, interval); }).then(attempt);
        });
    }
    return attempt();
}

function CdpClient(wsUrl) {
    EventEmitter.call(this);
    this.wsUrl = wsUrl;
    this._ws = null;
    this._nextId = 1;
    this._pending = {};
    this.closed = false;
}
util.inherits(CdpClient, EventEmitter);

CdpClient.prototype.connect = function (timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
        var settled = false;
        var ws = new WebSocket(self.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
        self._ws = ws;
        var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            try { ws.terminate(); } catch (e) { /* ignore */ }
            reject(new Error('Timed out opening ' + self.wsUrl));
        }, timeoutMs || 10000);
        ws.on('open', function () {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(self);
        });
        ws.on('message', function (data) { self._onMessage(data); });
        ws.on('error', function (err) {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                return reject(err);
            }
            self.emit('error', err);
        });
        ws.on('close', function () {
            self.closed = true;
            var ids = Object.keys(self._pending);
            for (var i = 0; i < ids.length; i++) {
                var p = self._pending[ids[i]];
                delete self._pending[ids[i]];
                p.reject(new Error('DevTools connection closed'));
            }
            self.emit('close');
        });
    });
};

CdpClient.prototype._onMessage = function (data) {
    var msg;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    if (msg.id && this._pending[msg.id]) {
        var p = this._pending[msg.id];
        delete this._pending[msg.id];
        if (msg.error) {
            var err = new Error(msg.error.message || 'CDP error');
            err.code = msg.error.code;
            p.reject(err);
        } else {
            p.resolve(msg.result || {});
        }
    } else if (msg.method) {
        this.emit(msg.method, msg.params || {});
        this.emit('event', msg.method, msg.params || {});
    }
};

CdpClient.prototype.send = function (method, params) {
    var self = this;
    if (this.closed || !this._ws) return Promise.reject(new Error('DevTools connection closed'));
    var id = this._nextId++;
    return new Promise(function (resolve, reject) {
        self._pending[id] = { resolve: resolve, reject: reject };
        self._ws.send(JSON.stringify({ id: id, method: method, params: params || {} }), function (err) {
            if (err && self._pending[id]) {
                delete self._pending[id];
                reject(err);
            }
        });
    });
};

CdpClient.prototype.close = function () {
    if (this._ws) {
        try { this._ws.close(); } catch (e) { /* ignore */ }
    }
};

module.exports = {
    findTarget: findTarget,
    pickTarget: pickTarget,
    rewriteWsUrl: rewriteWsUrl,
    CdpClient: CdpClient
};
