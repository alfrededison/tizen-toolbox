/* YT Mod launcher UI. Plain ES5 so it runs on every Tizen web engine.
 *
 * Normal launch: splash (1.5 s, or open settings) -> POST /api/launch -> the
 * service checks Developer Mode and the userscript -> this app exits -> the
 * service relaunches it in debug mode and navigates it to YouTube TV.
 * Debug relaunch: this page loads again for a moment; the state says
 * "debugging"/"connecting", so it just shows "Starting YouTube…".
 */
(function () {
    'use strict';

    var API = 'http://127.0.0.1:8094';
    var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, GREEN: 404, G: 71 };
    var SPLASH_MS = 1500;
    var LOADING_WATCHDOG_MS = 30000;

    var screen = null;
    var splashTimer = null;
    var splashStart = 0;
    var watchdog = null;
    var pollTimer = null;
    var settingsItems = [];
    var settingsFocus = 0;
    var lastState = null;

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function request(method, path, body, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, API + path, true);
        xhr.timeout = 25000;
        if (body) xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function () {
            var data = {};
            try { data = JSON.parse(xhr.responseText); } catch (e) { /* empty */ }
            if (xhr.status >= 200 && xhr.status < 300) cb(null, data);
            else cb(new Error(data.error || ('HTTP ' + xhr.status)), data);
        };
        xhr.onerror = function () { cb(new Error('Service not reachable')); };
        xhr.ontimeout = function () { cb(new Error('Service timed out')); };
        xhr.send(body ? JSON.stringify(body) : null);
    }

    // ---- TV integration ----------------------------------------------------

    function registerKeys() {
        if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
        // Registered here, before YouTube takes over the page: key registration
        // is per app and survives the navigation.
        var keys = ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
            'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
            'MediaFastForward', 'MediaRewind', 'MediaTrackNext', 'MediaTrackPrevious'];
        for (var i = 0; i < keys.length; i++) {
            try { tizen.tvinputdevice.registerKey(keys[i]); } catch (e) { /* not on this model */ }
        }
    }

    function keepScreenOn() {
        try {
            webapis.appcommon.setScreenSaver(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
        } catch (e) { /* no webapis */ }
    }

    function startService() {
        if (typeof tizen === 'undefined') return;
        try {
            var pkgId = tizen.application.getCurrentApplication().appInfo.packageId;
            tizen.application.launchAppControl(
                new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
                pkgId + '.YtModService',
                function () { },
                function () { }
            );
        } catch (e) { /* desktop */ }
    }

    function exitApp() {
        try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
    }

    // ---- screens -------------------------------------------------------------

    function show(name) {
        screen = name;
        var all = ['splash', 'loading', 'settings', 'status'];
        for (var i = 0; i < all.length; i++) $(all[i]).className = 'screen' + (all[i] === name ? '' : ' hidden');
        if (name !== 'splash') stopSplash();
        if (name !== 'loading' && watchdog) { clearTimeout(watchdog); watchdog = null; }
    }

    function sourceLabel(settings) {
        if (!settings || settings.source !== 'npm') return 'TizenTube (bundled)';
        return 'TizenTube ' + (settings.version === 'latest' ? 'latest' : settings.version) + ' from npm';
    }

    function startSplash() {
        show('splash');
        $('splashScript').textContent = sourceLabel(lastState && lastState.settings);
        splashStart = Date.now();
        stopSplash();
        splashTimer = setInterval(function () {
            var p = Math.min(1, (Date.now() - splashStart) / SPLASH_MS);
            $('splashBar').style.width = Math.round(p * 100) + '%';
            if (p >= 1) {
                stopSplash();
                launch();
            }
        }, 50);
    }

    function stopSplash() {
        if (splashTimer) { clearInterval(splashTimer); splashTimer = null; }
    }

    function showLoading(text) {
        show('loading');
        $('loadingText').textContent = text || 'Starting YouTube…';
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(function () {
            // Still on this page: the hand-over to YouTube did not happen.
            request('GET', '/api/state', null, function (err, s) {
                if (!err && s.phase === 'error') return showStatus(s);
                request('POST', '/api/reset', null, function () {
                    showStatus(s || {}, 'YouTube did not open within ' + (LOADING_WATCHDOG_MS / 1000) + ' s.');
                });
            });
        }, LOADING_WATCHDOG_MS);
    }

    function showStatus(s, extraError) {
        show('status');
        s = s || {};
        var failed = s.phase === 'error' || extraError;
        $('statusTitle').textContent = failed ? 'YT Mod could not start' : 'YT Mod status';
        var err = extraError || s.error || '';
        $('statusError').className = err ? 'error' : 'hidden';
        $('statusError').textContent = err;
        var icons = { ok: '✓', fail: '✗', pending: '·', skip: '–' };
        var html = '';
        var steps = s.steps || [];
        for (var i = 0; i < steps.length; i++) {
            var st = steps[i];
            html += '<div class="step ' + st.status + '"><span class="icon">' + icons[st.status] + '</span>' + esc(st.label) +
                (st.detail && st.detail !== err ? '<span class="detail">' + esc(st.detail) + '</span>' : '') + '</div>';
        }
        $('steps').innerHTML = html;
        var lines = [];
        var log = s.log || [];
        for (var j = Math.max(0, log.length - 10); j < log.length; j++) lines.push(log[j].t.slice(11, 19) + '  ' + log[j].msg);
        $('statusLog').textContent = lines.join('\n') || 'No log yet.';
    }

    // ---- settings --------------------------------------------------------------

    function openSettings() {
        show('settings');
        settingsItems = [{ label: '▶  Start YouTube', action: 'start' }];
        renderSettings('Loading versions from npm…');
        request('GET', '/api/versions', null, function (err, v) {
            v = v || {};
            var current = (lastState && lastState.settings) || { source: 'bundled', version: 'latest' };
            var items = [{ label: '▶  Start YouTube', action: 'start' }];
            items.push({ label: 'Bundled', tag: v.bundled ? 'TizenTube ' + v.bundled + ' · offline' : 'offline', settings: { source: 'bundled', version: 'latest' }, current: current.source !== 'npm' });
            items.push({ label: 'Latest from npm', tag: v.latest ? 'now ' + v.latest : '', settings: { source: 'npm', version: 'latest' }, current: current.source === 'npm' && current.version === 'latest' });
            var versions = v.versions || [];
            for (var i = 0; i < versions.length; i++) {
                items.push({ label: 'TizenTube ' + versions[i], tag: versions[i] === v.bundled ? 'same as bundled' : 'npm', settings: { source: 'npm', version: versions[i] }, current: current.source === 'npm' && current.version === versions[i] });
            }
            settingsItems = items;
            if (settingsFocus >= items.length) settingsFocus = 0;
            renderSettings(err || v.error ? 'Could not reach npm (' + esc((err && err.message) || v.error) + '). Bundled still works.' : '');
        });
    }

    function renderSettings(note) {
        var visible = 9;
        var start = Math.max(0, Math.min(settingsFocus - 4, settingsItems.length - visible));
        var html = '';
        for (var i = start; i < Math.min(settingsItems.length, start + visible); i++) {
            var it = settingsItems[i];
            html += '<div class="item' + (i === settingsFocus ? ' focus' : '') + (it.current ? ' current' : '') + '">' +
                '<span class="name">' + esc(it.label) + '</span><span class="tag">' + esc(it.tag || '') + '</span></div>';
        }
        $('settingsList').innerHTML = html;
        if (note !== undefined) $('settingsNote').innerHTML = note;
    }

    function chooseSetting() {
        var it = settingsItems[settingsFocus];
        if (!it) return;
        if (it.action === 'start') return launch();
        request('POST', '/api/settings', it.settings, function (err, res) {
            if (err) return renderSettings('Could not save: ' + esc(err.message));
            if (lastState) lastState.settings = res.settings;
            for (var i = 0; i < settingsItems.length; i++) settingsItems[i].current = i === settingsFocus;
            renderSettings('Saved. YouTube will use ' + esc(sourceLabel(res.settings)) + '.');
        });
    }

    // ---- flow --------------------------------------------------------------------

    function launch() {
        showLoading('Checking setup…');
        request('POST', '/api/launch', {}, function (err, res) {
            if (err) {
                if (res && res.state) lastState = res.state;
                return showStatus(lastState, lastState && lastState.phase === 'error' ? null : err.message);
            }
            showLoading('Starting YouTube…');
            // The service relaunches this app in debug mode once it has exited.
            setTimeout(exitApp, 150);
        });
    }

    function decide(s) {
        lastState = s;
        var p = s.phase;
        if (p === 'debugging' || p === 'connecting' || p === 'handover') {
            // We are the debug-mode instance; DevTools is about to take over.
            showLoading('Starting YouTube…');
            pollWhileLoading();
            return;
        }
        if (p === 'error' && Date.now() - s.updatedAt < 120000) return showStatus(s);
        startSplash();
    }

    function pollWhileLoading() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(function () {
            if (screen !== 'loading') { clearInterval(pollTimer); pollTimer = null; return; }
            request('GET', '/api/state', null, function (err, s) {
                if (!err && s.phase === 'error') {
                    clearInterval(pollTimer);
                    pollTimer = null;
                    lastState = s;
                    showStatus(s);
                }
            });
        }, 1000);
    }

    function waitForService(tries) {
        request('GET', '/api/state', null, function (err, s) {
            if (!err) return decide(s);
            if (tries <= 0) return showStatus({}, 'The YT Mod service did not start. Reinstall the app or restart the TV.');
            setTimeout(function () { waitForService(tries - 1); }, 300);
        });
    }

    // ---- keys ----------------------------------------------------------------------

    document.addEventListener('keydown', function (e) {
        var k = e.keyCode;
        var back = k === KEY.BACK || k === KEY.ESC;
        if (screen === 'splash') {
            if (back) { e.preventDefault(); return exitApp(); }
            if (k === KEY.UP || k === KEY.GREEN || k === KEY.G) { e.preventDefault(); settingsFocus = 0; return openSettings(); }
            if (k === KEY.ENTER) { stopSplash(); return launch(); }
        } else if (screen === 'settings') {
            e.preventDefault();
            if (back) return startSplash();
            if (k === KEY.UP) { settingsFocus = Math.max(0, settingsFocus - 1); return renderSettings(); }
            if (k === KEY.DOWN) { settingsFocus = Math.min(settingsItems.length - 1, settingsFocus + 1); return renderSettings(); }
            if (k === KEY.ENTER) return chooseSetting();
        } else if (screen === 'status') {
            e.preventDefault();
            if (back) return exitApp();
            if (k === KEY.ENTER) return launch();
            if (k === KEY.GREEN || k === KEY.G || k === KEY.UP) { settingsFocus = 0; return openSettings(); }
        } else if (screen === 'loading') {
            if (back) { e.preventDefault(); exitApp(); }
        }
    });

    registerKeys();
    keepScreenOn();
    startService();
    showLoading('Starting…');
    waitForService(40);
})();
