# YT Mod

YouTube's own TV web app (`https://www.youtube.com/tv`) with the [TizenTube](https://github.com/reisxd/TizenTube) userscript injected: ad blocking, SponsorBlock, DeArrow, speed control and the rest of TizenTube's settings. No TizenBrew, and no CDN at runtime.

It needs Developer Mode with Host PC IP **127.0.0.1**, the same setup as the TV Installer.

## Install

```sh
npm install
npm run build -- ytmod                              # -> dist/ytmod-unsigned.wgt (or ytmod.wgt if certs/ is set up)
npm run push -- dist/ytmod-unsigned.wgt             # the Installer re-signs it with your certificate
```

Or install the latest release: paste `alfrededison/tizen-toolbox:ytmod` in the TV Installer's browser page, or `npm run push -- --url alfrededison/tizen-toolbox:ytmod`.

To publish a release: `npm run bump:ytmod -- patch`, commit to `main`, then push a `ytmod-v<version>` tag (see [Releasing](../../README.md#releasing)).

## Using it

Open **YT Mod**. A splash shows for 1.5 s, then YouTube opens with a short "YT Mod: TizenTube x.y.z" toast in the corner.

- **▲ or GREEN on the splash** opens *Userscript source*:
  - **Bundled** (default): the TizenTube build pinned into the package. Works offline and never changes behind your back.
  - **Latest from npm**: the newest `@foxreis/tizentube`, downloaded from the npm registry (tarball, sha512-verified) and cached on the TV.
  - **A specific version**: roll back to a release that worked when a new one breaks. Also cached.
  If npm can't be reached, it falls back to the cached copy, then to the bundled one, and the toast says so.
- **If anything fails**, the app shows each step with ✓/✗ and the log instead of a blank screen: OK retries, GREEN opens settings, BACK exits.

TizenTube's own settings live inside YouTube as before (its menu in the YouTube sidebar).

## How it works

```
YT Mod UI ──POST /api/launch──▶ YT Mod service (127.0.0.1:8094)
   │ exits                          │ checks Developer Mode + resolves the userscript
   ▼                                ▼
                         sdbd: "0 debug TboxYtMod1.YouTube" → DevTools port
                                    │
                         DevTools: Runtime.enable, Page.setBypassCSP,
                                   Page.navigate https://www.youtube.com/tv
                                    │
                         on every YouTube main-frame context: Runtime.evaluate(userscript)
```

1. The UI registers the remote's media/colour keys and turns the screensaver off (app-wide settings that survive the hand-off), then asks the service to start.
2. The service checks Developer Mode and resolves the userscript *while the UI is still on screen*, so setup problems are shown there.
3. The UI exits; the service has sdbd relaunch it in debug mode, finds the DevTools target (trying 127.0.0.1, then the TV's LAN IP), navigates it to YouTube TV and injects the userscript into every new YouTube main-frame context (reloads included).
4. When YouTube is closed, DevTools disconnects and the service goes idle until the next launch.

This is the same technique as TizenTube's standalone injector (GPL-3.0), rebuilt on `packages/sdb-core` with a bundled, pinned userscript. The local API only answers the app's own UI (127.0.0.1, no web origins).

## Updating TizenTube

- On the TV: pick a version in *Userscript source*.
- In the package: bump `@foxreis/tizentube` in `apps/ytmod/package.json`, `npm install`, rebuild. `apps/ytmod/prepare.js` copies `dist/userScript.js` into the package at build time.

## Not done yet

- Casting from the phone's YouTube app (TizenTube runs a DIAL server for this; not ported).
- A custom userscript URL (e.g. your own TizenTube fork on GitHub Pages).
- Tizen 3 (2017) TVs: the DevTools client uses `ws@8`, which needs a newer Node than Tizen 3 ships.
