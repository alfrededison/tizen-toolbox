# tizen-toolbox

Self-made apps for Samsung Tizen TVs that use the **Developer Mode host = 127.0.0.1** trick: with the Host PC IP set to the TV itself, an app on the TV can talk to the TV's own `sdbd` and do what Tizen Studio does from a computer — install packages, launch apps in debug mode, and so on.

Two apps, one shared core:

| Path | What it is | Status |
| --- | --- | --- |
| `apps/installer` | **TV Installer** — install `.wgt`/`.tpk` over your LAN from a phone/computer browser or `npm run push`, list/open/uninstall apps. | v0.1, needs on-TV testing |
| `apps/ytmod` | **YouTube mod** — loads YouTube TV with a pinned, bundled userscript (TizenTube-based) injected over DevTools. | planned |
| `packages/sdb-core` | Minimal SDB client (handshake, shell, `vd_appinstall`, `vd_appuninstall`, `debug`) shared by both apps. | tested against a fake sdbd |

Why: TizenBrew and TizenTube keep breaking, and keeping the host on 127.0.0.1 used to block installing other apps. With the Installer on the TV, the host can stay on 127.0.0.1 permanently and every other app (including the YouTube mod) is installed from the TV itself.

## One-time setup

1. **Build** (on your computer, Node 18+):
   ```sh
   npm install
   npm run build            # -> dist/installer.wgt (signed) or dist/installer-unsigned.wgt
   ```
2. **Install the Installer once** with [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) (Developer Mode on, Host PC IP = your computer). Apps2Samsung re-signs the package, so the unsigned build is fine here.
3. **Switch the TV to 127.0.0.1 for good:** Apps → press `1 2 3 4 5` → Developer Mode ON, Host PC IP `127.0.0.1` → OK → restart the TV (hold power until the logo).
4. Open **TV Installer** on the TV. It shows three green checks, the LAN address (e.g. `http://192.168.1.20:8093`) and a 6-digit PIN.

## Installing apps after that

- **Browser:** open the address shown on the TV, enter the PIN, drop a `.wgt`, or paste a URL / `owner/repo` (installs that repo's latest GitHub release).
- **Command line:**
  ```sh
  npm run push -- dist/ytmod.wgt --tv 192.168.1.20 --pin 123456   # remembered in .tvrc.json
  npm run push -- --url jellyfin/jellyfin-tizen
  ```
- **On the TV:** the app list supports Open and Uninstall with the remote (▲▼, OK, BACK).

The Installer's service starts at boot, so uploads work without opening the app — but the PIN changes on every TV restart, so open the app to read it.

## Signing

On Tizen ≤ 6.5 (2021–2022 TVs), `vd_appinstall` accepts packages signed with any author certificate plus the Tizen **public** distributor certificate. The build signs automatically when it finds your certificate:

```sh
export TIZEN_AUTHOR_KEY=~/path/to/author.p12     # default: certs/author.p12
export TIZEN_AUTHOR_KEY_PW=...
npm run build
npm run sign -- some-app.wgt                     # re-sign any package
```

The distributor certificate comes from the Tizen SDK bundle that [tizen.js](https://github.com/reisxd/tizen.js) downloads into `~/share/.tizen-cert` (override with `TIZEN_DISTRIBUTOR_KEY` / `TIZEN_DISTRIBUTOR_KEY_PW`). The Installer refuses unsigned uploads unless you tick "install anyway".

Tizen 7+ (2023+) TVs need a Samsung certificate tied to the TV's DUID; that flow (from TizenBrewInstaller) is not ported yet.

## How it works

```
phone / laptop ──HTTP + PIN──▶ Installer service (Node, on the TV, :8093)
                                   │ writes package to /home/owner/share/tmp/sdk_tools
                                   ▼
                               sdbd 127.0.0.1:26101 ── "0 vd_appinstall <pkgId> <path>"
```

- sdbd only trusts the configured Host PC IP, so it is never exposed to the LAN; the service's PIN-protected API is the only door. Five wrong PINs lock it for a minute.
- The TV UI (packaged page, no web origin) can call the API without a PIN; web pages — including ones opened in the TV's own browser — cannot.
- The service is bundled with ncc, transpiled to ES5 / Node 4 with Babel, and the build fails if the bundle is not valid ES5, so it runs on old Tizen Node runtimes.

## Development

```sh
npm test                      # sdb-core + installer API + built bundle smoke test (fake sdbd)
npm run build -- installer    # build one app
```

`TBOX_SDB_PORT`, `TBOX_DEVAPI_URL` and `TBOX_TMP_DIR` let you run the built service on a computer against fakes (see `test/`).

## Things still to verify on a real TV

- `vd_appuninstall` output format and exit text (install output is well known; uninstall is assumed to be similar).
- Whether the service's `on-boot` auto-start works with public-level signing.
- Whether the Installer can update itself in place (the install runs in sdbd, so it should survive the app being restarted).

## Credits & license

GPL-3.0-only. Builds on ideas and protocol knowledge from [TizenBrew / TizenBrewInstaller](https://github.com/reisxd/TizenBrewInstaller), [TizenTube](https://github.com/reisxd/TizenTube) and [tizen.js](https://github.com/reisxd/tizen.js) by Reis Can (all GPL-3.0). See `NOTICE`.
