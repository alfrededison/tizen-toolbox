/* TV UI of the Installer. Plain ES5 so it runs on every Tizen web engine. */
(function () {
    'use strict';

    var API = 'http://127.0.0.1:8093';
    var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27 };

    var apps = [];
    var focusIndex = 0;
    var actionMode = false;
    var actionIndex = 0;
    var confirmUninstall = false;
    var serviceOk = false;
    // The service sends the PIN only to requests without an Origin header, as
    // the TV UI's are; it goes back with every request in case some of ours
    // (e.g. POSTs) carry an Origin and so need it.
    var pin = '';

    function $(id) { return document.getElementById(id); }

    function request(method, path, body, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, API + path, true);
        // Opening an app may take up to 30 s and uninstalling longer; status polls stay short.
        xhr.timeout = method === 'POST' ? 120000 : 15000;
        if (body) xhr.setRequestHeader('Content-Type', 'application/json');
        if (pin) xhr.setRequestHeader('X-PIN', pin);
        xhr.onload = function () {
            var data = null;
            try { data = JSON.parse(xhr.responseText); } catch (e) { data = {}; }
            if (xhr.status >= 200 && xhr.status < 300) cb(null, data);
            else cb(new Error(data.error || ('HTTP ' + xhr.status)), data);
        };
        xhr.onerror = function () { cb(new Error('Service not reachable')); };
        xhr.ontimeout = function () { cb(new Error('Service timed out')); };
        xhr.send(body ? JSON.stringify(body) : null);
    }

    // ---- service bootstrap -------------------------------------------------

    function startService() {
        if (typeof tizen === 'undefined') return;
        try {
            var pkgId = tizen.application.getCurrentApplication().appInfo.packageId;
            tizen.application.launchAppControl(
                new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
                pkgId + '.InstallerService',
                function () { },
                function (e) { showLocalLog('Could not start the service: ' + e.message); }
            );
        } catch (e) {
            showLocalLog('Could not start the service: ' + e.message);
        }
    }

    function registerKeys() {
        if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
        var keys = ['ColorF0Red', 'ColorF1Green'];
        for (var i = 0; i < keys.length; i++) {
            try { tizen.tvinputdevice.registerKey(keys[i]); } catch (e) { /* ignore */ }
        }
    }

    // ---- rendering -----------------------------------------------------------

    var localLog = [];
    function showLocalLog(msg) {
        localLog.push(msg);
        if (!serviceOk) $('log').textContent = localLog.join('\n');
    }

    function badge(ok, text) {
        return '<span class="' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✓ ' : '✗ ') + text + '</span>';
    }

    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderStatus(s) {
        var d = s.devInfo || {};
        $('ver').textContent = 'v' + s.version + (s.platformVersion ? ' · Tizen ' + s.platformVersion : '') + (s.duid ? ' · DUID ' + s.duid : '');
        var sig = s.signing || {};
        $('checks').innerHTML =
            badge(true, 'Service') +
            badge(!!d.devModeEnabled, 'Developer mode') +
            badge(!!d.hostIsLocal, 'Host 127.0.0.1') +
            badge(sig.configured && !sig.error && sig.coversThisTv !== false,
                !sig.configured ? 'No signing certificate' : sig.error ? 'Certificate error' :
                    sig.coversThisTv === false ? 'Certificate not for this TV' : 'Signing: ' + esc(sig.name));
        $('lanUrl').textContent = s.lanUrl || 'TV IP unknown';
        if (s.pin) pin = s.pin;
        $('pin').textContent = s.pin || '······';

        var setup = '';
        if (s.devInfoError) {
            setup = 'Cannot read TV settings: ' + esc(s.devInfoError);
        } else if (!d.devModeEnabled || !d.hostIsLocal) {
            setup = 'Installing needs Developer Mode with Host PC IP <b>127.0.0.1</b>.<br>' +
                'Open <b>Apps</b>, press <b>1 2 3 4 5</b>, turn Developer Mode ON, set Host PC IP to 127.0.0.1, then restart the TV ' +
                '(hold the power button until the logo appears).';
        }
        $('setupText').innerHTML = setup;
        $('setup').className = setup ? '' : 'hidden';

        var lines = [];
        for (var i = 0; i < s.log.length; i++) lines.push(s.log[i].t.slice(11, 19) + '  ' + s.log[i].msg);
        var logEl = $('log');
        logEl.textContent = lines.slice(-9).join('\n');
    }

    function renderApps() {
        var box = $('apps');
        if (!apps.length) {
            box.innerHTML = '<div class="appRow">No apps listed yet</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < apps.length; i++) {
            var a = apps[i];
            // While the action bar is open the bar gets the strong highlight, the row a muted one.
            var cls = i !== focusIndex ? '' : actionMode ? ' picked' : ' focus';
            html += '<div class="appRow' + cls + '">' +
                '<span class="name">' + esc(a.name) + '<span class="id">' + esc(a.id) + '</span></span>' +
                '<span class="ver">' + esc(a.version) + '</span></div>';
        }
        box.innerHTML = html;
        renderActions();
        scrollToFocus(box);
    }

    // Keeps the focused row inside the list box (its height depends on the setup
    // warning and the action bar), with one neighbouring row visible when possible.
    function scrollToFocus(box) {
        var row = box.children[focusIndex];
        if (!row) return;
        var pad = row.offsetHeight;
        var top = row.offsetTop - pad;
        var bottom = row.offsetTop + row.offsetHeight + pad;
        if (top < box.scrollTop) box.scrollTop = Math.max(0, top);
        else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
    }

    // One line under the list for what Open/Uninstall are doing and how it went.
    var noticeTimer = null;
    function notice(text, kind) {
        var el = $('notice');
        el.textContent = text;
        el.className = kind || '';
        clearTimeout(noticeTimer);
        if (kind === 'ok') noticeTimer = setTimeout(function () { el.className = 'hidden'; }, 8000);
    }

    function renderActions() {
        var bar = $('actions');
        bar.className = actionMode ? '' : 'hidden';
        var btns = bar.getElementsByClassName('btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].className = 'btn' + (btns[i].getAttribute('data-act') === 'uninstall' ? ' danger' : '') + (i === actionIndex ? ' focus' : '');
            if (btns[i].getAttribute('data-act') === 'uninstall') {
                btns[i].textContent = confirmUninstall ? 'Press OK again to uninstall' : 'Uninstall';
            }
        }
    }

    // ---- data ------------------------------------------------------------------

    function pollStatus() {
        request('GET', '/api/status', null, function (err, s) {
            if (err) {
                serviceOk = false;
                $('checks').innerHTML = badge(false, 'Service starting…');
                return;
            }
            var first = !serviceOk;
            serviceOk = true;
            renderStatus(s);
            if (first) loadApps();
        });
    }

    function loadApps() {
        request('GET', '/api/apps', null, function (err, data) {
            if (err) return;
            var keepId = apps[focusIndex] && apps[focusIndex].id;
            apps = data.apps || [];
            focusIndex = 0;
            for (var i = 0; i < apps.length; i++) if (apps[i].id === keepId) focusIndex = i;
            renderApps();
        });
    }

    function doAction(act) {
        var app = apps[focusIndex];
        if (!app) return;
        if (act === 'cancel') {
            actionMode = false;
            confirmUninstall = false;
            return renderApps();
        }
        if (act === 'launch') {
            actionMode = false;
            renderApps();
            notice('Opening ' + app.name + '…');
            return request('POST', '/api/launch', { appId: app.id }, function (err) {
                if (err) notice('Could not open ' + app.name + ': ' + err.message, 'bad');
                else notice('Opened ' + app.name, 'ok');
            });
        }
        if (act === 'uninstall') {
            if (!confirmUninstall) {
                confirmUninstall = true;
                return renderActions();
            }
            confirmUninstall = false;
            actionMode = false;
            renderApps();
            notice('Uninstalling ' + app.name + '…');
            request('POST', '/api/uninstall', { appId: app.id }, function (err, data) {
                if (err || !data.ok) notice('Could not uninstall ' + app.name + ': ' + (err ? err.message : data.error), 'bad');
                else notice('Uninstalled ' + app.name, 'ok');
                loadApps();
            });
        }
    }

    // ---- keys --------------------------------------------------------------------

    document.addEventListener('keydown', function (e) {
        var k = e.keyCode;
        if (k === KEY.BACK || k === KEY.ESC) {
            e.preventDefault();
            if (actionMode) { actionMode = false; confirmUninstall = false; return renderApps(); }
            try { tizen.application.getCurrentApplication().exit(); } catch (err) { /* desktop */ }
            return;
        }
        if (actionMode) {
            if (k === KEY.LEFT) actionIndex = Math.max(0, actionIndex - 1);
            else if (k === KEY.RIGHT) actionIndex = Math.min(2, actionIndex + 1);
            else if (k === KEY.ENTER) {
                return doAction($('actions').getElementsByClassName('btn')[actionIndex].getAttribute('data-act'));
            } else return;
            if (actionIndex !== 1) confirmUninstall = false;
            return renderActions();
        }
        if (k === KEY.UP) focusIndex = Math.max(0, focusIndex - 1);
        else if (k === KEY.DOWN) focusIndex = Math.min(apps.length - 1, focusIndex + 1);
        else if (k === KEY.ENTER && apps.length) { actionMode = true; actionIndex = 0; confirmUninstall = false; }
        else return;
        renderApps();
    });

    registerKeys();
    startService();
    pollStatus();
    setInterval(pollStatus, 1500);
    setInterval(loadApps, 15000);
})();
