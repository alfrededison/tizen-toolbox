'use strict';

// The launch flow, as a small state machine whose steps the TV UI shows:
//
//   devmode  Developer Mode on with Host PC IP 127.0.0.1 (sdbd trusts us)
//   script   userscript resolved (bundled / npm / cache)
//   -- the UI exits itself here --
//   exit     the UI app has closed
//   debug    sdbd "0 debug <app>" relaunched it with a DevTools port
//   devtools connected to the page over the Chrome DevTools Protocol
//   inject   YouTube TV loaded and the userscript ran in it
//
// Same technique as TizenTube's standalone injector (GPL-3.0), rebuilt on
// sdb-core with the userscript resolved locally instead of from a CDN.

var sdb = require('../../../../packages/sdb-core');
var cdpLib = require('./cdp');
var scripts = require('./scripts');

var STEPS = [
    ['devmode', 'Developer Mode (host 127.0.0.1)'],
    ['script', 'Userscript'],
    ['exit', 'Hand over to debug mode'],
    ['debug', 'Relaunch in debug mode'],
    ['devtools', 'Connect to DevTools'],
    ['inject', 'Load YouTube and inject']
];

var MAX_LOG = 150;

function toastSnippet(message, color) {
    return '(function(m,c){function show(){var d=document.createElement("div");d.textContent=m;' +
        'd.style.cssText="position:fixed;right:48px;bottom:48px;z-index:2147483647;padding:16px 28px;border-radius:12px;' +
        'font:24px/1.3 Roboto,Arial,sans-serif;color:#fff;background:"+c+";box-shadow:0 6px 24px rgba(0,0,0,.5)";' +
        '(document.body||document.documentElement).appendChild(d);setTimeout(function(){if(d.parentNode)d.parentNode.removeChild(d)},6000)}' +
        'if(document.body)show();else document.addEventListener("DOMContentLoaded",show)})(' +
        JSON.stringify(message) + ',' + JSON.stringify(color) + ')';
}

function createInjector(opts) {
    var tv = opts.tv;
    var store = opts.store;
    var youtubeUrl = opts.youtubeUrl || process.env.TBOX_YT_URL || 'https://www.youtube.com/tv';
    var youtubeOrigin = /^(https?:\/\/[^\/]+)/.exec(youtubeUrl)[1];

    var state = {
        phase: 'idle',      // idle | preparing | handover | debugging | connecting | running | error
        steps: [],
        error: null,
        script: null,       // { label, version, from, warning }
        injections: 0,
        devtools: null,     // { host, port }
        updatedAt: Date.now(),
        log: []
    };
    var client = null;
    var script = null;
    var devInfo = null;

    function log(msg) {
        var line = { t: new Date().toISOString(), msg: String(msg) };
        state.log.push(line);
        if (state.log.length > MAX_LOG) state.log.shift();
        if (!opts.quiet) console.log('[ytmod] ' + line.msg);
    }

    function setPhase(p) {
        state.phase = p;
        state.updatedAt = Date.now();
    }

    function resetSteps() {
        state.steps = STEPS.map(function (s) { return { key: s[0], label: s[1], status: 'pending', detail: null }; });
    }

    function mark(key, status, detail) {
        for (var i = 0; i < state.steps.length; i++) {
            if (state.steps[i].key === key) {
                state.steps[i].status = status;
                if (detail !== undefined) state.steps[i].detail = detail;
            }
        }
        state.updatedAt = Date.now();
    }

    function fail(key, err) {
        var msg = err && err.message ? err.message : String(err);
        mark(key, 'fail', msg);
        state.error = msg;
        setPhase('error');
        log('Failed at "' + key + '": ' + msg);
        if (err && err.output) log('  output: ' + String(err.output).trim());
    }

    function closeClient() {
        if (client) {
            var c = client;
            client = null;
            c.removeAllListeners();
            c.close();
        }
    }

    // Step 1-2, while the UI is still on screen so errors are visible there.
    function prepare() {
        if (state.phase === 'preparing' || state.phase === 'handover' || state.phase === 'debugging' || state.phase === 'connecting') {
            return Promise.reject(Object.assign(new Error('Already starting (' + state.phase + ')'), { status: 409 }));
        }
        closeClient();
        resetSteps();
        state.error = null;
        state.injections = 0;
        state.devtools = null;
        setPhase('preparing');
        log('Starting YouTube mod');

        return sdb.getDevInfo(opts.devInfo).then(function (info) {
            devInfo = info;
            if (!info.devModeEnabled || !info.hostIsLocal) {
                throw new Error('Developer Mode must be ON with Host PC IP 127.0.0.1 (currently: ' +
                    (info.devModeEnabled ? 'host ' + (info.hostIp || 'unset') : 'off') + '). Apps → 12345, then restart the TV.');
            }
            mark('devmode', 'ok', 'host ' + info.hostIp);
        }, function (err) {
            throw new Error('Cannot read the TV settings: ' + err.message);
        }).catch(function (err) {
            fail('devmode', err);
            throw err;
        }).then(function () {
            return scripts.resolveScript(store.get(), { bundledDir: opts.bundledDir, cacheDir: store.cacheDir, log: log }).catch(function (err) {
                fail('script', err);
                throw err;
            });
        }).then(function (s) {
            script = s;
            state.script = { label: s.label, version: s.version, from: s.from, warning: s.warning || null, size: s.code.length };
            mark('script', 'ok', s.label);
            if (s.warning) log('Warning: ' + s.warning);
            if (s.patches && s.patches.length) log('Compatibility patches: ' + s.patches.join(', '));
            log('Using ' + s.label + ' (' + Math.round(s.code.length / 1024) + ' KB)');
            setPhase('handover');
            return state;
        });
    }

    // Steps 3-6, after the UI answered and is closing itself.
    function launchDebug() {
        var appId = tv.uiAppId();
        var major = Number(String(tv.platformVersion() || '0').split('.')[0]);
        return tv.waitUntilClosed(appId, opts.exitTimeoutMs || 10000).then(function (closed) {
            mark('exit', closed ? 'ok' : 'skip', closed ? null : 'app still running; continuing');
            setPhase('debugging');
            log('Relaunching ' + appId + ' in debug mode');
            return sdb.debug(appId, { tizen3: major === 3, port: opts.sdb && opts.sdb.port, host: opts.sdb && opts.sdb.host }).catch(function (err) {
                fail('debug', err);
                throw err;
            });
        }).then(function (res) {
            mark('debug', 'ok', 'DevTools port ' + res.port);
            setPhase('connecting');
            var hosts = ['127.0.0.1'];
            if (devInfo && devInfo.ip) hosts.push(devInfo.ip);
            return cdpLib.findTarget(hosts, res.port, { timeoutMs: opts.devtoolsTimeoutMs || 20000 }).then(function (found) {
                state.devtools = { host: found.host, port: found.port };
                client = new cdpLib.CdpClient(found.wsUrl);
                return client.connect();
            }).catch(function (err) {
                fail('devtools', err);
                throw err;
            });
        }).then(function () {
            mark('devtools', 'ok', state.devtools.host + ':' + state.devtools.port);
            log('DevTools connected (' + state.devtools.host + ':' + state.devtools.port + ')');
            attach(client);
            return client.send('Runtime.enable').then(function () {
                return client.send('Page.enable');
            }).then(function () {
                return client.send('Page.setBypassCSP', { enabled: true }).catch(function (err) {
                    log('Page.setBypassCSP not available: ' + err.message);
                });
            }).then(function () {
                log('Opening ' + youtubeUrl);
                return client.send('Page.navigate', { url: youtubeUrl });
            }).catch(function (err) {
                fail('inject', err);
                throw err;
            });
        }).catch(function (err) {
            // The UI is gone (or is the bare debug instance): bring it back so the
            // status screen shows what went wrong.
            if (state.phase === 'error') tv.launch(tv.uiAppId()).catch(function () { });
            throw err;
        });
    }

    function attach(c) {
        var exceptions = 0;
        c.on('Runtime.executionContextCreated', function (p) {
            var ctx = p && p.context;
            if (!ctx || ctx.origin !== youtubeOrigin) return;
            if (ctx.auxData && ctx.auxData.isDefault === false) return;
            inject(c, ctx.id);
        });
        c.on('Runtime.exceptionThrown', function (p) {
            if (exceptions++ >= 5) return;
            var d = p && p.exceptionDetails;
            var text = d ? ((d.exception && d.exception.description) || d.text || 'error') : 'error';
            var where = d && d.url ? ' (' + String(d.url).slice(0, 80) + ':' + ((d.lineNumber || 0) + 1) + ')' : '';
            log('Page error: ' + String(text).split('\n')[0].slice(0, 160) + where);
        });
        c.on('Page.frameNavigated', function (p) {
            var f = p && p.frame;
            if (f && !f.parentId) log('Page: ' + String(f.url).slice(0, 120));
        });
        c.on('Inspector.detached', function (p) { log('DevTools detached: ' + (p && p.reason)); });
        c.on('Inspector.targetCrashed', function () { log('The page crashed'); });
        c.on('close', function () {
            if (client !== c) return;
            client = null;
            log('YouTube closed (DevTools disconnected)');
            if (state.phase === 'running' || state.phase === 'connecting') setPhase('idle');
        });
    }

    // TizenTube's modules expect document.body to exist when they load (some
    // call MutationObserver.observe(document.body) at top level), but a new
    // context is created before the body is parsed. So the script is wrapped:
    // it runs as soon as <body> exists, and records success or the error in
    // window.__ytmodState, which is polled here.
    function wrapScript(code) {
        return '(function(){' +
            'if(window.__ytmodState)return "already";' +
            'window.__ytmodState={status:"waiting"};' +
            'function run(){window.__ytmodState={status:"running"};' +
            'try{(function(){\n' + code + '\n}).call(window);window.__ytmodState={status:"ok"};}' +
            'catch(e){window.__ytmodState={status:"error",error:String(e&&(e.stack||e.message)||e)};}}' +
            'if(document.body)run();else{var t=setInterval(function(){if(document.body){clearInterval(t);run();}},5);}' +
            'return "scheduled";})()';
    }

    var POLL_EXPRESSION = 'window.__ytmodState?JSON.stringify(window.__ytmodState):null';

    function pollResult(c, contextId, deadline) {
        return c.send('Runtime.evaluate', { expression: POLL_EXPRESSION, contextId: contextId, returnByValue: true }).then(function (res) {
            var value = res && res.result && res.result.value;
            var parsed = null;
            try { parsed = value ? JSON.parse(value) : null; } catch (e) { /* keep polling */ }
            if (parsed && (parsed.status === 'ok' || parsed.status === 'error')) return parsed;
            if (Date.now() > deadline) return { status: 'error', error: 'The page never got a <body> (still ' + (parsed ? parsed.status : 'unknown') + ' after 30 s)' };
            return new Promise(function (r) { setTimeout(r, 150); }).then(function () { return pollResult(c, contextId, deadline); });
        });
    }

    function inject(c, contextId) {
        var started = Date.now();
        c.send('Runtime.evaluate', { expression: wrapScript(script.code), contextId: contextId, silent: false }).then(function (res) {
            if (res.exceptionDetails) {
                var d = res.exceptionDetails;
                return { status: 'error', error: (d.exception && d.exception.description) || d.text || 'unknown error' };
            }
            return pollResult(c, contextId, Date.now() + 30000);
        }).then(function (outcome) {
            if (outcome.status === 'error') {
                var first = String(outcome.error).split('\n');
                fail('inject', new Error('Userscript threw: ' + first[0]));
                if (first.length > 1) log('  at ' + first.slice(1, 4).map(function (l) { return l.trim(); }).join(' | '));
                return c.send('Runtime.evaluate', { expression: toastSnippet('YT Mod: ' + script.label + ' failed — open YT Mod again for details', '#b8352e'), contextId: contextId });
            }
            state.injections++;
            mark('inject', 'ok', script.label + (state.injections > 1 ? ' (x' + state.injections + ')' : ''));
            setPhase('running');
            log('Injected ' + script.label + ' in ' + (Date.now() - started) + ' ms');
            if (state.injections === 1) {
                var msg = 'YT Mod: ' + script.label + (script.warning ? ' — ' + script.warning : '');
                return c.send('Runtime.evaluate', { expression: toastSnippet(msg, script.warning ? '#9a6b00' : '#1f6f4a'), contextId: contextId });
            }
        }).catch(function (err) {
            // A navigation can destroy the context mid-poll; the next context retries.
            if (/context/i.test(err.message)) return log('Context went away before the script finished (' + err.message + ')');
            fail('inject', err);
        });
    }

    function reset() {
        closeClient();
        resetSteps();
        state.error = null;
        setPhase('idle');
        log('Reset');
    }

    resetSteps();

    return {
        state: state,
        log: log,
        prepare: prepare,
        launchDebug: launchDebug,
        reset: reset,
        snapshot: function () {
            return JSON.parse(JSON.stringify(state));
        }
    };
}

module.exports = { createInjector: createInjector, STEPS: STEPS, toastSnippet: toastSnippet };
