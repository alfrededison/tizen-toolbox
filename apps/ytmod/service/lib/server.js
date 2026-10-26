'use strict';

// Local API for the YouTube mod's own TV UI. Listens on 127.0.0.1 only and
// ignores requests from web pages (http/https Origin), so only the packaged
// UI can drive it.

var http = require('http');
var scripts = require('./scripts');

var VERSION = '0.1.1';

function isLocalApp(req) {
    var a = req.socket.remoteAddress;
    if (a !== '127.0.0.1' && a !== '::1' && a !== '::ffff:127.0.0.1') return false;
    var origin = req.headers.origin;
    return !origin || !/^https?:\/\//i.test(origin);
}

function createServer(opts) {
    var injector = opts.injector;
    var store = opts.store;
    var tv = opts.tv;
    var port = opts.port === undefined ? 8094 : opts.port;

    function send(res, status, body) {
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(body));
    }

    function readJson(req) {
        return new Promise(function (resolve, reject) {
            var s = '';
            req.setEncoding('utf8');
            req.on('data', function (c) {
                s += c;
                if (s.length > 16384) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
            });
            req.on('end', function () {
                if (!s) return resolve({});
                try { resolve(JSON.parse(s)); } catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
            });
            req.on('error', reject);
        });
    }

    function stateBody() {
        var s = injector.snapshot();
        s.version = VERSION;
        s.settings = store.get();
        s.persistent = !!store.dataDir;
        s.platformVersion = tv.platformVersion();
        s.appId = tv.uiAppId();
        return s;
    }

    function handle(req, res) {
        var urlPath = req.url.split('?')[0];
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
            return res.end();
        }
        if (!isLocalApp(req)) {
            req.resume();
            return send(res, 403, { error: 'Only the YT Mod app can use this API' });
        }

        var p;
        if (req.method === 'GET' && urlPath === '/api/state') {
            p = Promise.resolve(stateBody());
        } else if (req.method === 'POST' && urlPath === '/api/launch') {
            // Answer as soon as the checks pass so the UI can exit; the debug
            // relaunch needs the UI to be gone.
            p = injector.prepare().then(function () {
                setTimeout(function () {
                    injector.launchDebug().catch(function () { /* recorded in state */ });
                }, 0);
                return { ok: true, exit: true, state: stateBody() };
            });
        } else if (req.method === 'POST' && urlPath === '/api/reset') {
            injector.reset();
            p = Promise.resolve(stateBody());
        } else if (req.method === 'GET' && urlPath === '/api/versions') {
            var bundled = null;
            try { bundled = scripts.readBundled(opts.bundledDir).version; } catch (e) { /* none */ }
            p = scripts.listVersions({ log: injector.log }).then(function (v) {
                return { bundled: bundled, latest: v.latest, versions: v.versions, error: null };
            }, function (err) {
                return { bundled: bundled, latest: null, versions: [], error: err.message };
            });
        } else if (req.method === 'POST' && urlPath === '/api/settings') {
            p = readJson(req).then(function (body) {
                var saved = store.set(body);
                injector.log('Settings: ' + (saved.source === 'npm' ? 'npm ' + saved.version : 'bundled'));
                return { settings: saved };
            });
        } else {
            req.resume();
            return send(res, 404, { error: 'Not found' });
        }

        p.then(function (body) { send(res, 200, body); }, function (err) {
            send(res, err.status || 500, { error: err.message, state: stateBody() });
        });
    }

    var server = http.createServer(function (req, res) {
        try { handle(req, res); } catch (err) {
            try { send(res, 500, { error: err.message }); } catch (e) { /* ignore */ }
        }
    });

    return {
        server: server,
        listen: function (host, cb) {
            server.on('error', function (err) {
                injector.log('Server error: ' + err.message);
            });
            server.listen(port, host || '127.0.0.1', function () {
                injector.log('YT Mod service v' + VERSION + ' listening on port ' + server.address().port);
                if (cb) cb(server.address().port);
            });
            return server;
        },
        close: function (cb) { server.close(cb); }
    };
}

module.exports = { createServer: createServer, VERSION: VERSION };
