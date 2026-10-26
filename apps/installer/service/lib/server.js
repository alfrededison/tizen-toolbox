'use strict';

// HTTP API of the installer service. Serves:
//   - the LAN upload page at "/" (phone/computer browsers, PIN protected)
//   - a JSON API used by both the LAN page and the TV UI
//
// Security model: sdbd only trusts 127.0.0.1, so this server is the only way
// to reach it from the network. Every request that is not from the TV
// itself must carry the PIN shown on the TV screen (X-PIN header).

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var sdb = require('../../../../packages/sdb-core');
var pkg = require('./pkg');
var dl = require('./download');
var tv = require('./tv');

var VERSION = '0.1.0';
var MAX_UPLOAD = 200 * 1024 * 1024;
var MAX_LOG = 200;
var MAX_PIN_FAILURES = 5;
var LOCK_MS = 60 * 1000;

function mkdirp(dir) {
    if (fs.existsSync(dir)) return;
    mkdirp(path.dirname(dir));
    fs.mkdirSync(dir);
}

function randomPin() {
    var n = crypto.randomBytes(4).readUInt32LE(0) % 1000000;
    var s = String(n);
    while (s.length < 6) s = '0' + s;
    return s;
}

function isLoopback(addr) {
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function createInstallerServer(options) {
    options = options || {};
    var tmpDir = options.tmpDir || process.env.TBOX_TMP_DIR || '/home/owner/share/tmp/sdk_tools';
    var webDir = options.webDir || path.join(__dirname, '..', 'web');
    var port = options.port || 8093;
    var sdbOpts = options.sdb || {};
    var devInfoOpts = options.devInfo || {};

    var state = {
        pin: options.pin || randomPin(),
        log: [],
        busy: false,
        current: null,
        lastResult: null,
        pinFailures: 0,
        lockedUntil: 0
    };

    function log(msg) {
        var line = { t: new Date().toISOString(), msg: String(msg) };
        state.log.push(line);
        if (state.log.length > MAX_LOG) state.log.shift();
        if (!options.quiet) console.log('[installer] ' + line.msg);
    }

    function step(text) {
        if (state.current) state.current.step = text;
        log(text);
    }

    // ---- request helpers -------------------------------------------------

    function isLocalApp(req) {
        if (!isLoopback(req.socket.remoteAddress)) return false;
        // A web page in the TV's own browser has an http(s) origin; the
        // packaged TV UI does not. Only the latter skips the PIN.
        var origin = req.headers.origin;
        return !origin || !/^https?:\/\//i.test(origin);
    }

    function send(res, status, body, headers) {
        var data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
        var h = headers || {};
        if (!h['Content-Type']) h['Content-Type'] = 'application/json; charset=utf-8';
        h['Cache-Control'] = 'no-store';
        if (res._cors) {
            h['Access-Control-Allow-Origin'] = '*';
        }
        res.writeHead(status, h);
        res.end(data);
    }

    function readBody(req, limit) {
        return new Promise(function (resolve, reject) {
            var chunks = [];
            var total = 0;
            var aborted = false;
            req.on('data', function (c) {
                if (aborted) return;
                total += c.length;
                if (total > limit) {
                    aborted = true;
                    var err = new Error('Upload too large (limit ' + Math.round(limit / 1048576) + ' MB)');
                    err.status = 413;
                    reject(err);
                    req.resume();
                    return;
                }
                chunks.push(c);
            });
            req.on('end', function () { if (!aborted) resolve(Buffer.concat(chunks)); });
            req.on('error', reject);
        });
    }

    function readJson(req) {
        return readBody(req, 64 * 1024).then(function (buf) {
            if (!buf.length) return {};
            try { return JSON.parse(buf.toString('utf8')); } catch (e) {
                var err = new Error('Invalid JSON body');
                err.status = 400;
                throw err;
            }
        });
    }

    function checkPin(req) {
        if (isLocalApp(req)) return null;
        var now = Date.now();
        if (state.lockedUntil > now) {
            return { status: 429, error: 'Too many wrong PINs. Try again in ' + Math.ceil((state.lockedUntil - now) / 1000) + 's.' };
        }
        var given = String(req.headers['x-pin'] || '');
        var a = Buffer.from ? Buffer.from(given) : new Buffer(given);
        var b = Buffer.from ? Buffer.from(state.pin) : new Buffer(state.pin);
        var ok = a.length === b.length && crypto.timingSafeEqual ? crypto.timingSafeEqual(a, b) : given === state.pin;
        if (ok) {
            state.pinFailures = 0;
            return null;
        }
        state.pinFailures++;
        if (state.pinFailures >= MAX_PIN_FAILURES) {
            state.pinFailures = 0;
            state.lockedUntil = now + LOCK_MS;
            log('Too many wrong PINs from ' + req.socket.remoteAddress + '; locked for 60s');
        }
        return { status: 401, error: 'Wrong or missing PIN. It is shown on the TV screen in the Installer app.' };
    }

    // ---- status ------------------------------------------------------------

    function getStatus(local) {
        return sdb.getDevInfo(devInfoOpts).then(function (info) {
            return { devInfo: info, devInfoError: null };
        }, function (err) {
            return { devInfo: null, devInfoError: err.message };
        }).then(function (r) {
            var info = r.devInfo;
            var out = {
                app: 'tizen-toolbox-installer',
                version: VERSION,
                platformVersion: tv.platformVersion(),
                ownPackageId: tv.ownPackageId(),
                devInfo: info,
                devInfoError: r.devInfoError,
                sdbReady: !!(info && info.devModeEnabled && info.hostIsLocal),
                lanUrl: info && info.ip ? 'http://' + info.ip + ':' + port + '/' : null,
                port: port,
                busy: state.busy,
                current: state.current,
                lastResult: state.lastResult,
                locked: state.lockedUntil > Date.now(),
                log: state.log.slice(-60)
            };
            if (local) out.pin = state.pin;
            return out;
        });
    }

    // ---- install pipeline --------------------------------------------------

    function platformMajor() {
        var v = tv.platformVersion();
        return v ? Number(String(v).split('.')[0]) : null;
    }

    function installBuffer(buffer, source, force) {
        if (state.busy) {
            var busyErr = new Error('Another operation is in progress: ' + (state.current && state.current.what));
            busyErr.status = 409;
            return Promise.reject(busyErr);
        }
        state.busy = true;
        state.current = { what: 'install', source: source, step: 'starting', packageId: null };
        var info;
        var filePath;
        log('Install requested from ' + source + ' (' + Math.round(buffer.length / 1024) + ' KB)');

        return pkg.inspectPackage(buffer).then(function (i) {
            info = i;
            state.current.packageId = info.packageId;
            state.current.name = info.name;
            step('Package ' + info.packageId + ' "' + (info.name || '?') + '" v' + (info.version || '?') + ' (' + info.type + ')');
            if (!sdb.PKG_ID_RE.test(info.packageId)) {
                throw new Error('Package id "' + info.packageId + '" is not a valid 10-character Tizen package id');
            }
            if (!info.signed && !force) {
                var e = new Error('Package is not signed. Sign it on your computer first (npm run sign -- file.wgt), or retry with "install anyway".');
                e.status = 422;
                e.code = 'UNSIGNED';
                throw e;
            }
            var major = platformMajor();
            if (major !== null && major >= 7) {
                log('Note: Tizen ' + major + ' usually requires packages signed with a Samsung certificate for this TV.');
            }
            if (info.packageId === tv.ownPackageId()) {
                log('This is an update of the Installer itself; it will restart when done.');
            }
            return sdb.getDevInfo(devInfoOpts).catch(function () { return null; });
        }).then(function (dev) {
            if (dev && (!dev.devModeEnabled || !dev.hostIsLocal)) {
                var e = new Error('Developer Mode must be ON with Host PC IP 127.0.0.1 (currently: ' +
                    (dev.devModeEnabled ? 'host ' + (dev.hostIp || 'unset') : 'off') + '). Change it in Apps > 12345, then reboot the TV.');
                e.status = 412;
                throw e;
            }
            mkdirp(tmpDir);
            filePath = path.join(tmpDir, 'tbox-' + info.packageId + '.' + info.type);
            fs.writeFileSync(filePath, buffer);
            step('Installing with vd_appinstall...');
            return sdb.install(filePath, info.packageId, {
                port: sdbOpts.port,
                host: sdbOpts.host,
                onOutput: function (text) {
                    var lines = text.split(/\r?\n/);
                    for (var k = 0; k < lines.length; k++) if (lines[k].trim()) log('  ' + lines[k].trim());
                }
            });
        }).then(function (result) {
            try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            var summary = {
                ok: result.ok,
                action: 'install',
                packageId: info.packageId,
                name: info.name,
                version: info.version,
                output: result.output,
                at: new Date().toISOString()
            };
            log(result.ok ? 'Installed ' + info.packageId + ' successfully.' : 'Install of ' + info.packageId + ' failed (see output above).');
            state.lastResult = summary;
            state.busy = false;
            state.current = null;
            return summary;
        }).catch(function (err) {
            if (filePath) { try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ } }
            log('Error: ' + err.message);
            state.lastResult = { ok: false, action: 'install', packageId: info && info.packageId, error: err.message, at: new Date().toISOString() };
            state.busy = false;
            state.current = null;
            throw err;
        });
    }

    function installFromUrl(input, force) {
        var url = String(input || '').trim();
        if (!url) return Promise.reject(Object.assign(new Error('Missing url'), { status: 400 }));
        var p;
        if (/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/.test(url)) {
            log('Looking up the latest release of ' + url + ' on GitHub...');
            p = dl.resolveGitHubRelease(url, log).then(function (asset) {
                log('Found ' + asset.name + ' (' + asset.tag + ')');
                return asset.url;
            });
        } else {
            p = Promise.resolve(url);
        }
        return p.then(function (u) {
            log('Downloading ' + u);
            return dl.download(u, {}, log).then(function (buf) {
                return installBuffer(buf, u, force);
            });
        }).catch(function (err) {
            if (!state.busy) log('Error: ' + err.message);
            throw err;
        });
    }

    function uninstallPackage(packageId) {
        if (state.busy) return Promise.reject(Object.assign(new Error('Another operation is in progress'), { status: 409 }));
        if (packageId === tv.ownPackageId()) {
            return Promise.reject(Object.assign(new Error('The Installer cannot uninstall itself; use the TV settings.'), { status: 400 }));
        }
        state.busy = true;
        state.current = { what: 'uninstall', packageId: packageId, step: 'starting' };
        step('Uninstalling ' + packageId + '...');
        return Promise.resolve().then(function () {
            return sdb.uninstall(packageId, {
                port: sdbOpts.port,
                host: sdbOpts.host,
                onOutput: function (text) {
                    var lines = text.split(/\r?\n/);
                    for (var k = 0; k < lines.length; k++) if (lines[k].trim()) log('  ' + lines[k].trim());
                }
            });
        }).then(function (result) {
            log(result.ok ? 'Uninstalled ' + packageId + '.' : 'Uninstall of ' + packageId + ' may have failed (see output).');
            state.lastResult = { ok: result.ok, action: 'uninstall', packageId: packageId, output: result.output, at: new Date().toISOString() };
            state.busy = false;
            state.current = null;
            return state.lastResult;
        }, function (err) {
            log('Error: ' + err.message);
            state.lastResult = { ok: false, action: 'uninstall', packageId: packageId, error: err.message, at: new Date().toISOString() };
            state.busy = false;
            state.current = null;
            throw err;
        });
    }

    // ---- routing -------------------------------------------------------------

    function serveWeb(res, file, type) {
        fs.readFile(path.join(webDir, file), function (err, data) {
            if (err) return send(res, 404, { error: 'Not found' });
            send(res, 200, data, { 'Content-Type': type });
        });
    }

    function handle(req, res) {
        var local = isLocalApp(req);
        res._cors = local;
        var urlPath = req.url.split('?')[0];
        var query = req.url.indexOf('?') !== -1 ? req.url.slice(req.url.indexOf('?') + 1) : '';
        var force = /(^|&)force=1(&|$)/.test(query);

        if (req.method === 'OPTIONS') {
            var h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-PIN', 'Access-Control-Max-Age': '600' };
            if (local) h['Access-Control-Allow-Origin'] = '*';
            res.writeHead(204, h);
            return res.end();
        }

        if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
            return serveWeb(res, 'index.html', 'text/html; charset=utf-8');
        }
        if (req.method === 'GET' && urlPath === '/api/status') {
            return getStatus(local).then(function (s) { send(res, 200, s); });
        }

        // Everything below needs the PIN when called from the network.
        var pinError = checkPin(req);
        if (pinError) {
            req.resume();
            return send(res, pinError.status, { error: pinError.error });
        }

        var p;
        if (req.method === 'GET' && urlPath === '/api/apps') {
            p = tv.listApps().then(function (apps) { return { apps: apps }; });
        } else if (req.method === 'POST' && urlPath === '/api/install') {
            p = readBody(req, MAX_UPLOAD).then(function (buf) {
                if (!buf.length) throw Object.assign(new Error('Empty upload'), { status: 400 });
                return installBuffer(buf, 'upload from ' + req.socket.remoteAddress, force);
            });
        } else if (req.method === 'POST' && urlPath === '/api/install-url') {
            p = readJson(req).then(function (body) { return installFromUrl(body.url, force || body.force === true); });
        } else if (req.method === 'POST' && urlPath === '/api/uninstall') {
            p = readJson(req).then(function (body) {
                if (!sdb.PKG_ID_RE.test(String(body.packageId || ''))) throw Object.assign(new Error('Invalid packageId'), { status: 400 });
                return uninstallPackage(body.packageId);
            });
        } else if (req.method === 'POST' && urlPath === '/api/launch') {
            p = readJson(req).then(function (body) {
                if (!sdb.APP_ID_RE.test(String(body.appId || ''))) throw Object.assign(new Error('Invalid appId'), { status: 400 });
                log('Launching ' + body.appId);
                return tv.launch(body.appId).then(function () { return { ok: true }; });
            });
        } else {
            req.resume();
            return send(res, 404, { error: 'Not found' });
        }

        p.then(function (result) {
            send(res, 200, result);
        }, function (err) {
            send(res, err.status || 500, { error: err.message, code: err.code || null });
        });
    }

    var server = http.createServer(function (req, res) {
        try {
            handle(req, res);
        } catch (err) {
            log('Internal error: ' + err.message);
            try { send(res, 500, { error: err.message }); } catch (e) { /* ignore */ }
        }
    });

    return {
        server: server,
        state: state,
        log: log,
        listen: function (host, cb) {
            server.on('error', function (err) {
                log('Server error: ' + err.message + (err.code === 'EADDRINUSE' ? ' (port ' + port + ' is already used by another app)' : ''));
            });
            server.listen(port, host || '0.0.0.0', function () {
                log('Installer service v' + VERSION + ' listening on port ' + server.address().port);
                if (cb) cb(server.address().port);
            });
            return server;
        },
        close: function (cb) { server.close(cb); }
    };
}

module.exports = { createInstallerServer: createInstallerServer, VERSION: VERSION };
