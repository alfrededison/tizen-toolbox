'use strict';

// Thin wrappers over the Tizen device APIs available to web service apps.
// Everything degrades gracefully when `tizen` is missing (tests, desktop).

function hasTizen() {
    return typeof tizen !== 'undefined';
}

function ownPackageId() {
    if (!hasTizen()) return process.env.TBOX_OWN_PACKAGE || 'TboxInst01';
    try { return tizen.application.getAppInfo().packageId; } catch (e) { return null; }
}

function platformVersion() {
    if (!hasTizen()) return process.env.TBOX_PLATFORM_VERSION || null;
    try { return tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version'); } catch (e) { return null; }
}

function listApps() {
    if (!hasTizen()) return Promise.resolve([]);
    return new Promise(function (resolve, reject) {
        try {
            tizen.application.getAppsInfo(function (apps) {
                var out = [];
                for (var i = 0; i < apps.length; i++) {
                    var a = apps[i];
                    if (a.show === false) continue;
                    out.push({
                        id: a.id,
                        name: a.name,
                        version: a.version,
                        packageId: a.packageId,
                        iconPath: a.iconPath || null
                    });
                }
                out.sort(function (x, y) { return String(x.name).localeCompare(String(y.name)); });
                resolve(out);
            }, function (err) {
                reject(new Error(err && err.message ? err.message : 'getAppsInfo failed'));
            });
        } catch (e) { reject(e); }
    });
}

var LAUNCH_TIMEOUT_MS = 30000;

function errorText(err, fallback) {
    return err && err.message ? err.message : fallback;
}

// Some apps refuse a plain launch() but start through the default app
// control, so that is tried second. Gives up if the TV never answers.
function launch(appId) {
    if (!hasTizen()) return Promise.reject(new Error('Not running on a TV'));
    return new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
            finish(new Error('The TV did not confirm the app started within ' + LAUNCH_TIMEOUT_MS / 1000 + ' s'));
        }, LAUNCH_TIMEOUT_MS);
        function finish(err) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve();
        }
        function viaAppControl(firstErr) {
            try {
                tizen.application.launchAppControl(
                    new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/default'),
                    appId,
                    function () { finish(); },
                    function (err) { finish(new Error(errorText(firstErr, 'launch failed') + '; via app control: ' + errorText(err, 'failed'))); }
                );
            } catch (e) {
                finish(new Error(errorText(firstErr, 'launch failed') + '; via app control: ' + e.message));
            }
        }
        try {
            tizen.application.launch(appId, function () { finish(); }, viaAppControl);
        } catch (e) {
            viaAppControl(e);
        }
    });
}

module.exports = {
    hasTizen: hasTizen,
    ownPackageId: ownPackageId,
    platformVersion: platformVersion,
    listApps: listApps,
    launch: launch
};
