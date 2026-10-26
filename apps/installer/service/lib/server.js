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
var signingLib = require('./signing');

var VERSION = '1.0.1';
var MAX_UPLOAD = 200 * 1024 * 1024;
// Re-signing holds the package unpacked in memory several times over.
var MAX_RESIGN = 100 * 1024 * 1024;
var MAX_LOG = 200;
var MAX_PIN_FAILURES = 5;
var LOCK_MS = 60 * 1000;
var DUID_RE = /^[A-Z0-9]{8,32}$/;
// vd_appinstall's messages when the TV rejects a package's signature or certificates.
var CERT_ERROR_RE = /check certificate error|certificate not match/i;
var AUTHOR_MISMATCH_RE = /author certificate not match/i;

// The TV tools' reason for a failure, e.g. "Author certificate not match" from
// "app_id[x] install failed[118, -11], reason: Author certificate not match :".
function failureReason(output) {
    var lines = String(output || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var m = /reason:\s*(.*?)[\s:]*$/i.exec(lines[i]);
        if (m && m[1]) return m[1];
    }
    for (var j = lines.length - 1; j >= 0; j--) {
        if (/fail|error|invalid|denied|not found/i.test(lines[j])) return lines[j].trim();
    }
    return 'see the log';
}

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
    var port = options.port !== undefined ? options.port : 8093; // 0 picks a free port (tests)
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

    // The user's signing certificate; when present, every package is re-signed
    // with it before installing (see signing.js).
    var signing = signingLib.createSigningStore(
        options.signingDir !== undefined ? options.signingDir : signingLib.findPrivateDir(signingLib.defaultCandidates(tv.ownPackageId())),
        options.ownSignatureFile !== undefined ? options.ownSignatureFile : signingLib.findOwnSignature(__dirname));

    // The TV's DUID, which a Samsung distributor certificate must list. Read
    // once over sdb (the REST API's "duid" is a different, UUID-style id).
    var duid = null;
    var duidTriedAt = 0;
    function readDuid() {
        // Status is polled every 1.5 s; retry a failed read at most once a minute.
        if (duid || Date.now() - duidTriedAt < 60000) return Promise.resolve(duid);
        duidTriedAt = Date.now();
        // Status waits for this, so don't let a slow sdbd hold it for sdb-core's 30 s default.
        return sdb.getDuid(Object.assign({}, sdbOpts, { timeoutMs: 5000 })).then(function (out) {
            if (DUID_RE.test(out)) duid = out;
            return duid;
        }, function () { return null; });
    }

    // ---- request helpers -------------------------------------------------

    // The packaged TV UI's requests carry no Origin header at all (seen on a
    // Tizen 6.5 TV). Only those skip the PIN and get it in /api/status. A page
    // in the TV's own browser always sends one, at least "null" (sandboxed
    // frames, redirects), so it can't pass for the TV UI.
    function isLocalApp(req) {
        return isLoopback(req.socket.remoteAddress) && req.headers.origin === undefined;
    }

    // CORS stays open to loopback callers without a web origin ("null",
    // "file://"), in case the TV UI sends one on some requests; they still need
    // the PIN, which the TV UI sends along.
    function allowsCors(req) {
        if (!isLoopback(req.socket.remoteAddress)) return false;
        var origin = req.headers.origin;
        return origin === undefined || !/^https?:\/\//i.test(origin);
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
                    var err = new Error('Upload too large (limit ' + (limit >= 1048576 ? Math.round(limit / 1048576) + ' MB' : Math.round(limit / 1024) + ' KB') + ')');
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

    function readJson(req, limit) {
        return readBody(req, limit || 64 * 1024).then(function (buf) {
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
            var ready = !!(r.devInfo && r.devInfo.devModeEnabled && r.devInfo.hostIsLocal);
            return (ready ? readDuid() : Promise.resolve(duid)).then(function () { return r; });
        }).then(function (r) {
            var info = r.devInfo;
            var out = {
                app: 'tizen-toolbox-installer',
                version: VERSION,
                platformVersion: tv.platformVersion(),
                ownPackageId: tv.ownPackageId(),
                duid: duid,
                signing: shortSigning(),
                devInfo: info,
                devInfoError: r.devInfoError,
                sdbReady: !!(info && info.devModeEnabled && info.hostIsLocal),
                lanUrl: info && info.ip ? 'http://' + info.ip + ':' + boundPort() + '/' : null,
                port: boundPort(),
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

    // What the TV screen needs; the full description is behind the PIN at /api/cert.
    function shortSigning() {
        var s = signing.summary(duid);
        if (!s.configured) return { configured: false, storage: s.storage };
        return {
            configured: true,
            error: s.error || null,
            name: s.label || null,
            coversThisTv: s.coversThisTv === undefined ? null : s.coversThisTv,
            matchesInstaller: s.matchesInstaller === undefined ? null : s.matchesInstaller
        };
    }

    function boundPort() {
        var addr = server.address();
        return addr ? addr.port : port;
    }

    // ---- install pipeline --------------------------------------------------

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
        // Taken once, so replacing or removing the certificate meanwhile doesn't affect this install.
        var keys = null;
        var keysError = null;
        try { keys = signing.load(); } catch (e) { keysError = e; }
        var resign = !!keys;
        log('Install requested from ' + source + ' (' + Math.round(buffer.length / 1024) + ' KB)');

        return pkg.inspectPackage(buffer).then(function (i) {
            info = i;
            state.current.packageId = info.packageId;
            state.current.name = info.name;
            step('Package ' + info.packageId + ' "' + (info.name || '?') + '" v' + (info.version || '?') + ' (' + info.type + ')');
            if (!sdb.PKG_ID_RE.test(info.packageId)) {
                throw new Error('Package id "' + info.packageId + '" is not a valid 10-character Tizen package id');
            }
            if (keysError) {
                throw new Error('The signing certificate on this TV cannot be opened (' + keysError.message + '). Upload it again, or remove it to install packages as they are.');
            }
            if (resign && buffer.length > MAX_RESIGN) {
                var big = new Error('Re-signing on the TV is limited to ' + Math.round(MAX_RESIGN / 1048576) + ' MB of package. Sign this one on your computer (npm run sign) and install it with the certificate removed.');
                big.status = 413;
                throw big;
            }
            if (!info.signed && !force && !resign) {
                var e = new Error('Package is not signed. Upload your signing certificate to the Installer (npm run push -- --cert), sign it on your computer (npm run sign -- file.wgt), or retry with "install anyway".');
                e.status = 422;
                e.code = 'UNSIGNED';
                throw e;
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
            if (!resign) return null;
            step('Signing with your certificate...');
            return signing.signPackage(buffer, keys).then(function (signed) { buffer = signed; });
        }).then(function () {
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
            if (result.ok || !CERT_ERROR_RE.test(result.output)) return result;
            if (AUTHOR_MISMATCH_RE.test(result.output)) {
                // Only blame the stored certificate when it isn't known to match the Installer's.
                result.hint = info.packageId === tv.ownPackageId() && resign && signing.summary(null).matchesInstaller !== true
                    ? 'The TV Installer was installed with a different author certificate than the one it signs with. Upload the certificate ' +
                      'it was installed with (for Apps2Samsung, the folder chosen in its Certificate setting), then update again.'
                    : (info.name || info.packageId) + ' is already installed with a different author certificate. Uninstall it first, then install it again.';
                return result;
            }
            return readDuid().then(function (id) {
                var tvId = id ? ' ' + id : '';
                result.hint = (resign
                    ? 'The TV rejected the package signed with your certificate. Check that its distributor certificate lists this TV\'s DUID' + tvId +
                      ' (npm run cert -- add-tv), then upload it again (npm run push -- --cert).'
                    : 'This TV only installs packages signed with a Samsung distributor certificate that lists its DUID' + tvId +
                      '. Upload yours to the Installer (npm run push -- --cert) and it signs every package for you.') +
                    ' If the app is already installed with a different author certificate, uninstall it first.';
                return result;
            });
        }).then(function (result) {
            try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            var summary = {
                ok: result.ok,
                action: 'install',
                packageId: info.packageId,
                name: info.name,
                version: info.version,
                error: result.ok ? null : failureReason(result.output),
                output: result.output,
                hint: result.hint,
                at: new Date().toISOString()
            };
            log(result.ok ? 'Installed ' + info.packageId + ' successfully.' : 'Install of ' + info.packageId + ' failed (see output above).');
            if (result.hint) log(result.hint);
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

    // appId: PKG.App, which vd_appuninstall needs (a bare package id fails).
    function uninstallApp(appId) {
        var packageId = appId.split('.')[0];
        if (state.busy) return Promise.reject(Object.assign(new Error('Another operation is in progress'), { status: 409 }));
        if (packageId === tv.ownPackageId()) {
            return Promise.reject(Object.assign(new Error('The Installer cannot uninstall itself; use the TV settings.'), { status: 400 }));
        }
        state.busy = true;
        state.current = { what: 'uninstall', packageId: packageId, step: 'starting' };
        step('Uninstalling ' + appId + '...');
        return Promise.resolve().then(function () {
            return sdb.uninstall(appId, {
                // Below the TV UI's 120 s request timeout, so its answer arrives first.
                timeoutMs: 90000,
                port: sdbOpts.port,
                host: sdbOpts.host,
                onOutput: function (text) {
                    var lines = text.split(/\r?\n/);
                    for (var k = 0; k < lines.length; k++) if (lines[k].trim()) log('  ' + lines[k].trim());
                }
            });
        }).then(function (result) {
            var error = result.ok ? null : failureReason(result.output);
            log(result.ok ? 'Uninstalled ' + appId + '.' : 'Uninstall of ' + appId + ' failed: ' + error);
            state.lastResult = { ok: result.ok, action: 'uninstall', packageId: packageId, appId: appId, error: error, output: result.output, at: new Date().toISOString() };
            state.busy = false;
            state.current = null;
            return state.lastResult;
        }, function (err) {
            log('Error: ' + err.message);
            state.lastResult = { ok: false, action: 'uninstall', packageId: packageId, appId: appId, error: err.message, at: new Date().toISOString() };
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

    // Each distinct Origin header seen on loopback requests, logged once, so
    // what the TV UI sends shows up in the log (see isLocalApp).
    var seenLocalOrigins = {};

    function handle(req, res) {
        var local = isLocalApp(req);
        if (isLoopback(req.socket.remoteAddress)) {
            var originKey = String(req.headers.origin);
            if (!seenLocalOrigins[originKey]) {
                seenLocalOrigins[originKey] = true;
                log('Loopback request with Origin: ' + (req.headers.origin === undefined ? '(none)' : JSON.stringify(req.headers.origin)) +
                    (local ? ' (treated as the TV UI)' : ' (needs the PIN)'));
            }
        }
        res._cors = allowsCors(req);
        var urlPath = req.url.split('?')[0];
        var query = req.url.indexOf('?') !== -1 ? req.url.slice(req.url.indexOf('?') + 1) : '';
        var force = /(^|&)force=1(&|$)/.test(query);

        if (req.method === 'OPTIONS') {
            var h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-PIN', 'Access-Control-Max-Age': '600' };
            if (res._cors) h['Access-Control-Allow-Origin'] = '*';
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
                if (typeof body.appId === 'string' && sdb.APP_ID_RE.test(body.appId)) return uninstallApp(body.appId);
                if (typeof body.packageId !== 'string' || !sdb.PKG_ID_RE.test(body.packageId)) throw Object.assign(new Error('Invalid appId'), { status: 400 });
                // Older clients send the package id; uninstall goes by an app of it.
                return tv.listApps().then(function (apps) {
                    for (var i = 0; i < apps.length; i++) if (apps[i].packageId === body.packageId) return uninstallApp(apps[i].id);
                    throw Object.assign(new Error('No installed app in package ' + body.packageId), { status: 404 });
                });
            });
        } else if (req.method === 'GET' && urlPath === '/api/cert') {
            p = readDuid().then(function (id) { return signing.summary(id); });
        } else if (req.method === 'POST' && urlPath === '/api/cert') {
            p = readJson(req, 256 * 1024).then(function (body) {
                return readDuid().then(function (id) {
                    var s = signing.save(body, id);
                    log('Signing certificate saved: ' + s.label + ' (TVs: ' + (s.distributor.duids.join(', ') || 'none') + ')');
                    for (var w = 0; w < s.warnings.length; w++) log('Warning: ' + s.warnings[w]);
                    return s;
                });
            });
        } else if (req.method === 'POST' && urlPath === '/api/cert/remove') {
            req.resume();
            signing.remove();
            log('Signing certificate removed; packages are installed as they are.');
            p = Promise.resolve({ ok: true });
        } else if (req.method === 'POST' && urlPath === '/api/launch') {
            p = readJson(req).then(function (body) {
                if (!sdb.APP_ID_RE.test(String(body.appId || ''))) throw Object.assign(new Error('Invalid appId'), { status: 400 });
                log('Opening ' + body.appId + '...');
                return tv.launch(body.appId).then(function () {
                    log('Opened ' + body.appId + '.');
                    return { ok: true };
                }, function (err) {
                    log('Could not open ' + body.appId + ': ' + err.message);
                    throw err;
                });
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
                log(signing.dir ? 'Signing certificate storage: ' + signing.dir : 'Found no private storage for a signing certificate; packages are installed as they are.');
                log(signing.own ? 'The Installer was installed with the certificate ' + signing.own.name + '.' : 'Could not read the Installer\'s own signature.');
                // After start-up: opening the stored certificate is slow on a TV CPU.
                setTimeout(function () {
                    var s = signing.summary(null);
                    if (s.configured && s.matchesInstaller === false) {
                        log('Warning: the stored certificate ' + s.label + ' is not the one the Installer was installed with (' + signing.own.name + '); it can\'t update itself.');
                    }
                }, 0);
                if (cb) cb(server.address().port);
            });
            return server;
        },
        close: function (cb) { server.close(cb); }
    };
}

module.exports = { createInstallerServer: createInstallerServer, VERSION: VERSION };
