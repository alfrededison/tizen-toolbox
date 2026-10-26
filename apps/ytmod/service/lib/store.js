'use strict';

// Settings and the userscript cache live in the app's private data folder
// (<apps_rw>/<pkgId>/data, same place the Installer keeps its certificate).
// Without a writable folder everything still works, just not persisted.

var fs = require('fs');
var path = require('path');

var DEFAULTS = { source: 'bundled', version: 'latest' };

function findDataDir(packageId) {
    var candidates = process.env.TBOX_DATA_DIR ? [process.env.TBOX_DATA_DIR] : (packageId ? [
        '/home/owner/apps_rw/' + packageId + '/data',
        '/opt/usr/home/owner/apps_rw/' + packageId + '/data'
    ] : []);
    for (var i = 0; i < candidates.length; i++) {
        var dir = candidates[i];
        try {
            if (!fs.existsSync(dir)) continue;
            var probe = path.join(dir, '.probe');
            fs.writeFileSync(probe, '');
            fs.unlinkSync(probe);
            return dir;
        } catch (e) { /* try next */ }
    }
    return null;
}

function createStore(dataDir) {
    var memory = null;
    var file = dataDir ? path.join(dataDir, 'settings.json') : null;

    function sanitize(s) {
        var out = { source: DEFAULTS.source, version: DEFAULTS.version };
        if (s && (s.source === 'bundled' || s.source === 'npm')) out.source = s.source;
        if (s && typeof s.version === 'string' && (s.version === 'latest' || /^\d+\.\d+\.\d+$/.test(s.version))) out.version = s.version;
        return out;
    }

    return {
        dataDir: dataDir,
        cacheDir: dataDir ? path.join(dataDir, 'userscripts') : null,
        get: function () {
            if (memory) return memory;
            if (file && fs.existsSync(file)) {
                try { memory = sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); return memory; } catch (e) { /* reset */ }
            }
            memory = sanitize(null);
            return memory;
        },
        set: function (s) {
            memory = sanitize(s);
            if (file) {
                try { fs.writeFileSync(file, JSON.stringify(memory, null, 2)); } catch (e) { /* not persisted */ }
            }
            return memory;
        }
    };
}

module.exports = { createStore: createStore, findDataDir: findDataDir, DEFAULTS: DEFAULTS };
