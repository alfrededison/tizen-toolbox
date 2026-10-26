'use strict';

// Where the TizenTube userscript comes from:
//   - "bundled": the copy pinned into the .wgt at build time (always works)
//   - "npm":     a version from the npm registry ("latest" or "x.y.z"),
//                downloaded as the package tarball (not via jsDelivr),
//                verified against the registry's sha512 and cached on the TV.
// Anything that fails falls back to the cache, then to the bundled copy, and
// the returned `warning` says so.

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var crypto = require('crypto');
var fetchLite = require('../../../../packages/fetch-lite');

var PACKAGE = '@foxreis/tizentube';
var FILE_IN_PACKAGE = 'package/dist/userScript.js';

function registry() {
    return (process.env.TBOX_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
}

function packageUrl(suffix) {
    return registry() + '/' + PACKAGE.replace('/', '%2F') + (suffix ? '/' + suffix : '');
}

function getJson(url, log) {
    return fetchLite.download(url, { accept: 'application/json', timeoutMs: 20000 }, log).then(function (buf) {
        return JSON.parse(buf.toString('utf8'));
    });
}

// ---- version helpers -----------------------------------------------------

var VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function isStable(v) { return VERSION_RE.test(v); }

function compareVersions(a, b) {
    var x = VERSION_RE.exec(a);
    var y = VERSION_RE.exec(b);
    for (var i = 1; i <= 3; i++) {
        var d = Number(x[i]) - Number(y[i]);
        if (d) return d;
    }
    return 0;
}

// Newest stable versions first, plus the "latest" dist-tag.
function listVersions(opts) {
    opts = opts || {};
    return fetchLite.download(packageUrl(), { accept: 'application/vnd.npm.install-v1+json', timeoutMs: 20000 }, opts.log).then(function (buf) {
        var doc = JSON.parse(buf.toString('utf8'));
        var versions = Object.keys(doc.versions || {}).filter(isStable).sort(compareVersions).reverse();
        return {
            latest: (doc['dist-tags'] || {}).latest || versions[0] || null,
            versions: versions.slice(0, opts.limit || 15)
        };
    });
}

// ---- tarball extraction -----------------------------------------------------

function readString(buf, start, len) {
    var s = buf.toString('utf8', start, start + len);
    var nul = s.indexOf('\0');
    return nul === -1 ? s : s.slice(0, nul);
}

// Returns the contents of one file inside a .tgz, or null.
function extractFromTgz(tgz, wanted) {
    var tar = zlib.gunzipSync(tgz);
    var offset = 0;
    var longName = null;
    while (offset + 512 <= tar.length) {
        var header = tar.slice(offset, offset + 512);
        var name = readString(header, 0, 100);
        if (!name) break;
        var size = parseInt(readString(header, 124, 12).trim() || '0', 8);
        var type = readString(header, 156, 1);
        var prefix = readString(header, 345, 155);
        var fullName = longName || (prefix ? prefix + '/' + name : name);
        longName = null;
        var dataStart = offset + 512;
        if (type === 'L') {
            longName = readString(tar, dataStart, size);
        } else if ((type === '0' || type === '' || type === '\0') && fullName === wanted) {
            return tar.slice(dataStart, dataStart + size);
        }
        offset = dataStart + Math.ceil(size / 512) * 512;
    }
    return null;
}

function verifyIntegrity(buf, integrity) {
    if (!integrity || integrity.indexOf('sha512-') !== 0) return true;
    var digest = crypto.createHash('sha512').update(buf).digest('base64');
    return 'sha512-' + digest === integrity;
}

// ---- cache ---------------------------------------------------------------------

function cacheFile(cacheDir, version) {
    return cacheDir ? path.join(cacheDir, 'tizentube-' + version + '.js') : null;
}

function readCached(cacheDir, version) {
    var f = cacheFile(cacheDir, version);
    if (!f || !fs.existsSync(f)) return null;
    return fs.readFileSync(f, 'utf8');
}

function newestCached(cacheDir) {
    if (!cacheDir || !fs.existsSync(cacheDir)) return null;
    var versions = fs.readdirSync(cacheDir).map(function (n) {
        var m = /^tizentube-(\d+\.\d+\.\d+)\.js$/.exec(n);
        return m ? m[1] : null;
    }).filter(Boolean).sort(compareVersions);
    return versions.length ? versions[versions.length - 1] : null;
}

function writeCache(cacheDir, version, code) {
    var f = cacheFile(cacheDir, version);
    if (!f) return;
    try {
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
        fs.writeFileSync(f, code);
    } catch (e) { /* cache is best effort */ }
}

// ---- sources ---------------------------------------------------------------------

function readBundled(bundledDir) {
    var file = path.join(bundledDir, 'tizentube.js');
    if (!fs.existsSync(file)) throw new Error('No bundled userscript in ' + bundledDir);
    var meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(bundledDir, 'meta.json'), 'utf8')); } catch (e) { /* optional */ }
    return {
        code: fs.readFileSync(file, 'utf8'),
        version: meta.version || '?',
        from: 'bundled',
        label: 'TizenTube ' + (meta.version || '?') + ' (bundled)'
    };
}

function downloadVersion(versionOrTag, ctx) {
    var log = ctx.log;
    return getJson(packageUrl(versionOrTag), log).then(function (meta) {
        var version = meta.version;
        var cached = readCached(ctx.cacheDir, version);
        if (cached) return { code: cached, version: version, from: 'cache', label: 'TizenTube ' + version + ' (npm, cached)' };
        if (!meta.dist || !meta.dist.tarball) throw new Error('Registry entry for ' + version + ' has no tarball');
        if (log) log('Downloading ' + PACKAGE + '@' + version + ' from the npm registry');
        return fetchLite.download(meta.dist.tarball, { timeoutMs: 60000 }, log).then(function (tgz) {
            if (!verifyIntegrity(tgz, meta.dist.integrity)) throw new Error('Integrity check failed for ' + PACKAGE + '@' + version);
            var file = extractFromTgz(tgz, FILE_IN_PACKAGE);
            if (!file) throw new Error(FILE_IN_PACKAGE + ' not found in ' + PACKAGE + '@' + version);
            var code = file.toString('utf8');
            writeCache(ctx.cacheDir, version, code);
            return { code: code, version: version, from: 'npm', label: 'TizenTube ' + version + ' (npm)' };
        });
    });
}

// ---- compatibility patches ---------------------------------------------------
//
// Small, targeted fixes for TizenTube bugs that only show up in YT Mod's
// setting (a fresh YouTube profile inside our own app). Each one is matched
// by a pattern; if a TizenTube version no longer has the bug, the pattern
// doesn't match and nothing changes.

var COMPAT_PATCHES = [
    {
        id: 'recurring-actions-missing',
        // ui/disableWhosWatching.js runs at load and does
        //   JSON.parse(localStorage['yt.leanback.default::recurring_actions'])
        // which throws "Unexpected token u in JSON" until YouTube has created
        // that entry, aborting every module loaded after it. Skip the
        // function until the entry exists (it runs again on the next launch).
        description: "skip TizenTube's who's-watching tweak until YouTube has created its recurring-actions storage",
        pattern: /(function [\w$]+\([\w$]+\)\{)(var [\w$]+=JSON\.parse\(localStorage\["yt\.leanback\.default::recurring_actions"\]\))/g,
        replace: '$1if(!localStorage["yt.leanback.default::recurring_actions"])return;$2'
    }
];

function applyCompatPatches(code) {
    var applied = [];
    for (var i = 0; i < COMPAT_PATCHES.length; i++) {
        var p = COMPAT_PATCHES[i];
        var count = 0;
        code = code.replace(p.pattern, function () {
            count++;
            var args = arguments;
            return p.replace.replace(/\$(\d)/g, function (m, n) { return args[Number(n)]; });
        });
        if (count) applied.push(p.id);
    }
    return { code: code, applied: applied };
}

function withPatches(result) {
    var patched = applyCompatPatches(result.code);
    result.code = patched.code;
    result.patches = patched.applied;
    return result;
}

// settings: { source: 'bundled' | 'npm', version: 'latest' | 'x.y.z' }
// ctx: { bundledDir, cacheDir, log }
function resolveScript(settings, ctx) {
    return resolveRaw(settings, ctx).then(withPatches);
}

function resolveRaw(settings, ctx) {
    settings = settings || {};
    if (settings.source !== 'npm') return Promise.resolve().then(function () { return readBundled(ctx.bundledDir); });

    var wanted = settings.version && settings.version !== 'latest' ? settings.version : 'latest';
    return downloadVersion(wanted, ctx).catch(function (err) {
        var fallbackVersion = wanted === 'latest' ? newestCached(ctx.cacheDir) : (readCached(ctx.cacheDir, wanted) ? wanted : null);
        if (fallbackVersion) {
            return {
                code: readCached(ctx.cacheDir, fallbackVersion),
                version: fallbackVersion,
                from: 'cache',
                label: 'TizenTube ' + fallbackVersion + ' (cached)',
                warning: 'Could not fetch ' + wanted + ' from npm (' + err.message + '); using the cached ' + fallbackVersion
            };
        }
        var bundled = readBundled(ctx.bundledDir);
        bundled.warning = 'Could not fetch ' + wanted + ' from npm (' + err.message + '); using the bundled ' + bundled.version;
        return bundled;
    });
}

module.exports = {
    PACKAGE: PACKAGE,
    resolveScript: resolveScript,
    listVersions: listVersions,
    extractFromTgz: extractFromTgz,
    compareVersions: compareVersions,
    readBundled: readBundled,
    applyCompatPatches: applyCompatPatches,
    COMPAT_PATCHES: COMPAT_PATCHES
};
