'use strict';

// Build hook (called by scripts/build.js after staging): copies the pinned
// TizenTube userscript from node_modules into the package, so the app works
// without any CDN. Pin the version in apps/ytmod/package.json.

const fs = require('fs');
const path = require('path');

module.exports = async function prepare({ stage, appDir }) {
    const pkgJson = require.resolve('@foxreis/tizentube/package.json', { paths: [appDir] });
    const pkgDir = path.dirname(pkgJson);
    const { version } = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const src = path.join(pkgDir, 'dist', 'userScript.js');
    if (!fs.existsSync(src)) throw new Error('userScript.js not found in @foxreis/tizentube@' + version);

    const out = path.join(stage, 'userscript');
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(src, path.join(out, 'tizentube.js'));
    fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ package: '@foxreis/tizentube', version }, null, 2));
    for (const name of ['LICENSE', 'LICENSE.md']) {
        if (fs.existsSync(path.join(pkgDir, name))) fs.copyFileSync(path.join(pkgDir, name), path.join(out, 'LICENSE'));
    }
    const kb = (fs.statSync(src).size / 1024).toFixed(0);
    return `bundled TizenTube ${version} (${kb} KB)`;
};
