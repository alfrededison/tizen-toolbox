'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { resolveGitHubRelease } = require('../packages/fetch-lite');

function fakeGitHub(assets) {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/repos/me/tools/releases/latest') {
            return res.end(JSON.stringify({ tag_name: 'v1.2.3', assets: assets.map((name) => ({ name, browser_download_url: 'https://dl/' + name })) }));
        }
        res.statusCode = 404;
        res.end('{}');
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}

test('owner/repo picks the first package; owner/repo:name picks by name', async (t) => {
    const gh = await fakeGitHub(['notes.txt', 'installer-unsigned.wgt', 'ytmod-unsigned.wgt']);
    process.env.TBOX_GITHUB_API = gh.url;
    t.after(async () => { delete process.env.TBOX_GITHUB_API; await gh.close(); });
    const logs = [];
    const first = await resolveGitHubRelease('me/tools', (m) => logs.push(m));
    assert.strictEqual(first.name, 'installer-unsigned.wgt');
    assert.match(logs.join('\n'), /several packages/);
    const yt = await resolveGitHubRelease('me/tools:YTMOD');
    assert.deepStrictEqual(yt, { url: 'https://dl/ytmod-unsigned.wgt', name: 'ytmod-unsigned.wgt', tag: 'v1.2.3' });
    await assert.rejects(resolveGitHubRelease('me/tools:jellyfin'), /no \.wgt\/\.tpk matching "jellyfin" \(has: installer-unsigned\.wgt, ytmod-unsigned\.wgt\)/);
    await assert.rejects(resolveGitHubRelease('not a repo'), /Expected owner\/repo/);
});
