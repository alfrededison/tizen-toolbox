'use strict';

// Small HTTP(S) downloader (shared by the Installer and the YouTube mod) with redirect support and a size cap. Uses only
// core modules so it runs on old Tizen Node runtimes.

var http = require('http');
var https = require('https');
var urlLib = require('url');

var MAX_BYTES = 200 * 1024 * 1024;

function get(url, opts, redirectsLeft) {
    opts = opts || {};
    if (redirectsLeft === undefined) redirectsLeft = 6;
    return new Promise(function (resolve, reject) {
        var parsed = urlLib.parse(url);
        var mod = parsed.protocol === 'http:' ? http : https;
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return reject(new Error('Only http(s) URLs are supported: ' + url));
        }
        var reqOpts = {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.path,
            method: 'GET',
            headers: {
                'User-Agent': 'tizen-toolbox-installer',
                'Accept': opts.accept || '*/*'
            }
        };
        if (opts.insecure) reqOpts.rejectUnauthorized = false;
        var req = mod.request(reqOpts, function (res) {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
                var next = urlLib.resolve(url, res.headers.location);
                return resolve(get(next, opts, redirectsLeft - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
            }
            var chunks = [];
            var total = 0;
            res.on('data', function (c) {
                total += c.length;
                if (total > MAX_BYTES) {
                    req.abort();
                    return reject(new Error('Download larger than ' + MAX_BYTES + ' bytes'));
                }
                chunks.push(c);
            });
            res.on('end', function () { resolve(Buffer.concat(chunks)); });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(opts.timeoutMs || 60000, function () {
            req.abort();
            reject(new Error('Timed out downloading ' + url));
        });
        req.end();
    });
}

// Some older TVs ship outdated root certificates. Retry without verification
// only if the failure is a certificate problem, and say so in the log.
function download(url, opts, log) {
    return get(url, opts).catch(function (err) {
        var certProblem = /certificate|CERT_|self.signed|unable to verify/i.test(String(err && (err.code || err.message)));
        if (!certProblem || (opts && opts.insecure)) throw err;
        if (log) log('TLS verification failed (' + (err.code || err.message) + '); retrying without verification');
        var o = {};
        for (var k in opts) o[k] = opts[k];
        o.insecure = true;
        return get(url, o);
    });
}

// "owner/repo"      -> the first .wgt/.tpk asset of the repo's "Latest" release.
// "owner/repo:part" -> the first .wgt/.tpk whose name contains "part", from the
//                      newest published release that has one (so repos that
//                      release several apps separately work, e.g.
//                      "alfrededison/tizen-toolbox:ytmod").
var RELEASE_SPEC_RE = /^([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)(?::([A-Za-z0-9_.\-]+))?$/;

function githubApi(path) {
    return (process.env.TBOX_GITHUB_API || 'https://api.github.com') + path;
}

function packagesOf(release) {
    return (release.assets || []).filter(function (a) { return /\.(wgt|tpk)$/i.test(a.name); });
}

function resolveGitHubRelease(spec, log) {
    var m = RELEASE_SPEC_RE.exec(String(spec));
    if (!m) return Promise.reject(new Error('Expected owner/repo or owner/repo:name, got ' + spec));
    var repo = m[1];
    var filter = m[2] ? m[2].toLowerCase() : null;
    var opts = { accept: 'application/vnd.github+json' };

    if (!filter) {
        return download(githubApi('/repos/' + repo + '/releases/latest'), opts, log).then(function (buf) {
            var release = JSON.parse(buf.toString('utf8'));
            var packages = packagesOf(release);
            if (!packages.length) throw new Error('Latest release of ' + repo + ' has no .wgt or .tpk asset');
            if (packages.length > 1 && log) {
                log('Release has several packages (' + packages.map(function (a) { return a.name; }).join(', ') + '); using the first. Pick one with ' + repo + ':<part of the name>.');
            }
            return { url: packages[0].browser_download_url, name: packages[0].name, tag: release.tag_name };
        });
    }

    return download(githubApi('/repos/' + repo + '/releases?per_page=30'), opts, log).then(function (buf) {
        var releases = JSON.parse(buf.toString('utf8'));
        var seen = [];
        for (var i = 0; i < releases.length; i++) {
            var r = releases[i];
            if (r.draft || r.prerelease) continue;
            var packages = packagesOf(r);
            for (var j = 0; j < packages.length; j++) {
                if (seen.indexOf(packages[j].name) === -1) seen.push(packages[j].name);
                if (packages[j].name.toLowerCase().indexOf(filter) !== -1) {
                    return { url: packages[j].browser_download_url, name: packages[j].name, tag: r.tag_name };
                }
            }
        }
        throw new Error('No release of ' + repo + ' has a .wgt/.tpk matching "' + filter + '"' + (seen.length ? ' (found: ' + seen.join(', ') + ')' : ''));
    });
}

module.exports = { download: download, resolveGitHubRelease: resolveGitHubRelease, RELEASE_SPEC_RE: RELEASE_SPEC_RE };
