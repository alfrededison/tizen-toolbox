'use strict';

// Tizen device API wrappers for the YouTube mod's service. Without `tizen`
// (tests, desktop) they fall back to env vars so the flow can be exercised.

var UI_APP_NAME = 'YouTube';

function hasTizen() { return typeof tizen !== 'undefined'; }

function packageId() {
    if (!hasTizen()) return process.env.TBOX_OWN_PACKAGE || 'TboxYtMod1';
    try { return tizen.application.getAppInfo().packageId; } catch (e) { return null; }
}

// The UI app (the one sdbd relaunches in debug mode), not this service.
function uiAppId() {
    var pkg = packageId();
    return pkg ? pkg + '.' + UI_APP_NAME : null;
}

function platformVersion() {
    if (!hasTizen()) return process.env.TBOX_PLATFORM_VERSION || null;
    try { return tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version'); } catch (e) { return null; }
}

function isRunning(appId) {
    if (!hasTizen()) return Promise.resolve(process.env.TBOX_FAKE_RUNNING === appId);
    return new Promise(function (resolve) {
        try {
            tizen.application.getAppsContext(function (contexts) {
                for (var i = 0; i < contexts.length; i++) if (contexts[i].appId === appId) return resolve(true);
                resolve(false);
            }, function () { resolve(false); });
        } catch (e) { resolve(false); }
    });
}

// Resolves once the app is gone (or after timeoutMs, resolving false).
function waitUntilClosed(appId, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 10000);
    function check() {
        return isRunning(appId).then(function (running) {
            if (!running) return true;
            if (Date.now() >= deadline) return false;
            return new Promise(function (r) { setTimeout(r, 100); }).then(check);
        });
    }
    return check();
}

function launch(appId) {
    if (!hasTizen()) return Promise.resolve();
    return new Promise(function (resolve, reject) {
        try {
            tizen.application.launch(appId, function () { resolve(); }, function (e) { reject(new Error(e && e.message || 'launch failed')); });
        } catch (e) { reject(e); }
    });
}

module.exports = {
    hasTizen: hasTizen,
    packageId: packageId,
    uiAppId: uiAppId,
    platformVersion: platformVersion,
    isRunning: isRunning,
    waitUntilClosed: waitUntilClosed,
    launch: launch
};
