'use strict';

// Small HTTP(S) downloader with redirect support and a size cap. Uses only
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

// "owner/repo" -> URL of the first .wgt/.tpk asset of the latest release.
function resolveGitHubRelease(repo, log) {
    var api = 'https://api.github.com/repos/' + repo + '/releases/latest';
    return download(api, { accept: 'application/vnd.github+json' }, log).then(function (buf) {
        var release = JSON.parse(buf.toString('utf8'));
        var assets = release.assets || [];
        var asset = null;
        for (var i = 0; i < assets.length; i++) {
            if (/\.(wgt|tpk)$/i.test(assets[i].name)) { asset = assets[i]; break; }
        }
        if (!asset) throw new Error('Latest release of ' + repo + ' has no .wgt or .tpk asset');
        return { url: asset.browser_download_url, name: asset.name, tag: release.tag_name };
    });
}

module.exports = { download: download, resolveGitHubRelease: resolveGitHubRelease };
