'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { resolveGitHubRelease } = require('../packages/fetch-lite');

const asset = (name) => ({ name, browser_download_url: 'https://dl/' + name });

// Releases newest first, like the GitHub API.
function fakeGitHub(releases, latestTag) {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/repos/me/tools/releases/latest') {
            return res.end(JSON.stringify(releases.find((r) => r.tag_name === latestTag)));
        }
        if (req.url === '/repos/me/tools/releases?per_page=30') return res.end(JSON.stringify(releases));
        res.statusCode = 404;
        res.end('{}');
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}

test('owner/repo uses the Latest release; owner/repo:name finds the newest release with that package', async (t) => {
    const gh = await fakeGitHub([
        { tag_name: 'ytmod-v0.3.0-rc1', prerelease: true, assets: [asset('ytmod-unsigned.wgt')] },
        { tag_name: 'ytmod-v0.2.0', assets: [asset('ytmod-unsigned.wgt')] },
        { tag_name: 'v1.0.1', assets: [asset('notes.txt'), asset('installer-unsigned.wgt')] },
        { tag_name: 'ytmod-v0.1.1', assets: [asset('ytmod-unsigned.wgt')] },
        { tag_name: 'v1.0.0', assets: [asset('installer-unsigned.wgt'), asset('ytmod-unsigned.wgt')] }
    ], 'v1.0.1');
    process.env.TBOX_GITHUB_API = gh.url;
    t.after(async () => { delete process.env.TBOX_GITHUB_API; await gh.close(); });

    assert.deepStrictEqual(await resolveGitHubRelease('me/tools'), { url: 'https://dl/installer-unsigned.wgt', name: 'installer-unsigned.wgt', tag: 'v1.0.1' });
    assert.deepStrictEqual(await resolveGitHubRelease('me/tools:YTMOD'), { url: 'https://dl/ytmod-unsigned.wgt', name: 'ytmod-unsigned.wgt', tag: 'ytmod-v0.2.0' });
    assert.strictEqual((await resolveGitHubRelease('me/tools:installer')).tag, 'v1.0.1');
    await assert.rejects(resolveGitHubRelease('me/tools:jellyfin'), /No release of me\/tools has a \.wgt\/\.tpk matching "jellyfin" \(found: ytmod-unsigned\.wgt, installer-unsigned\.wgt\)/);
    await assert.rejects(resolveGitHubRelease('not a repo'), /Expected owner\/repo/);
});

test('several packages in the Latest release: the first is used and the log says how to pick', async (t) => {
    const gh = await fakeGitHub([{ tag_name: 'v2', assets: [asset('a.wgt'), asset('b.wgt')] }], 'v2');
    process.env.TBOX_GITHUB_API = gh.url;
    t.after(async () => { delete process.env.TBOX_GITHUB_API; await gh.close(); });
    const logs = [];
    assert.strictEqual((await resolveGitHubRelease('me/tools', (m) => logs.push(m))).name, 'a.wgt');
    assert.match(logs.join('\n'), /several packages/);
});
