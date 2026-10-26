# ytmod (planned)

YouTube TV with ad blocking and SponsorBlock, without TizenBrew.

Plan (forked from TizenTube's standalone injector, 127.0.0.1 path only):

1. The app's service calls `sdb-core` `debug(<own app id>)` to relaunch itself in debug mode and get a DevTools port.
2. It attaches over the Chrome DevTools Protocol, navigates to `https://www.youtube.com/tv`, and injects the userscript into every new execution context.
3. The userscript is **bundled into the .wgt and pinned**, instead of loading the latest `@foxreis/tizentube` from jsDelivr at runtime. An on-TV setting chooses the source: bundled, a specific npm version, or a custom URL (e.g. your own GitHub Pages build).
4. A status screen shows which step failed (sdb, debug launch, DevTools attach, script load, script error).

Install it with the TV Installer: `npm run build -- ytmod && npm run push -- dist/ytmod.wgt`.
