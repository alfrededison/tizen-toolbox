# tizen-toolbox

Self-made apps for Samsung Tizen TVs that use the **Developer Mode host = 127.0.0.1** trick: with the Host PC IP set to the TV itself, an app on the TV can talk to the TV's own `sdbd` and do what Tizen Studio does from a computer — install packages, launch apps in debug mode, and so on.

Two apps, one shared core:

| Path | What it is | Status |
| --- | --- | --- |
| `apps/installer` | **TV Installer** — install `.wgt`/`.tpk` over your LAN from a phone/computer browser or `npm run push`, list/open/uninstall apps. | v1.0.0, tested on a Tizen 6.5 TV |
| `apps/ytmod` | **YT Mod** — YouTube TV with the TizenTube userscript (ad blocking, SponsorBlock) injected over DevTools; bundled + pinned, switchable to any npm version on the TV. See [apps/ytmod](apps/ytmod/README.md). | v0.1.0, needs on-TV testing |
| `packages/sdb-core` | Minimal SDB client (handshake, shell, `vd_appinstall`, `vd_appuninstall`, `debug`) shared by both apps. | tested against a fake sdbd |
| `packages/fetch-lite` | Small HTTP(S) downloader shared by both apps (redirects, size cap, GitHub release lookup). | |

Why: TizenBrew and TizenTube keep breaking, and keeping the host on 127.0.0.1 used to block installing other apps. With the Installer on the TV, the host can stay on 127.0.0.1 permanently and every other app (including the YouTube mod) is installed from the TV itself.

## One-time setup

Samsung TVs only install packages whose **distributor certificate is issued by Samsung and lists the TV's DUID**; anything else fails with `Check certificate error : :Invalid signature …`. They also only accept an update signed with the **same author certificate** as the installed copy. So the Installer is installed once with your Samsung certificate, and then signs everything it installs with that same certificate.

Download `installer-unsigned.wgt` from the [latest release](https://github.com/alfrededison/tizen-toolbox/releases/latest) (or build it: `npm install && npm run build -- installer`), then install it one of two ways.

### With Apps2Samsung (easiest)

1. Install `installer-unsigned.wgt` with [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) (Developer Mode ON, Host PC IP = your computer). It signs the package with the Samsung certificate it creates for your TV.
2. **Switch the TV to 127.0.0.1 for good:** Apps → press `1 2 3 4 5` → Developer Mode ON, Host PC IP `127.0.0.1` → OK → restart the TV (hold power until the logo).
3. Open **TV Installer** on the TV. It shows its DUID, the LAN address (e.g. `http://192.168.1.20:8093`) and a 6-digit PIN.
4. **Give the Installer that same Apps2Samsung certificate.** Otherwise updates of the Installer, and of apps Apps2Samsung installed, are refused (`Author certificate not match`). Either open the LAN address in a browser and upload `author.p12`, `distributor.p12` and the password from `password.txt` in the *Signing certificate* card, or from a checkout of this repo (see below).
   Use the certificate Apps2Samsung signed with, the one chosen in its *Certificate* setting; its folders are under `Certificate/` in `~/Library/Application Support/Apps2Samsung` on macOS or `%APPDATA%\Apps2Samsung` on Windows. Each certificate there has its own author certificate, and the Installer warns when the uploaded one isn't the one it was installed with.
   ```sh
   npm install
   npm run cert -- import                                    # copies the one Apps2Samsung signs with into certs/
   npm run push -- --cert --tv 192.168.1.20 --pin 123456
   ```
   The TV then shows four green checks, the last one `Signing: <name>`.

### With your own certificate and sdb

On your computer (Node 18+), from a checkout of this repo. The certificate lives in `certs/` (git-ignored); **back it up**: if you lose it, every app signed with it has to be uninstalled before it can be updated.

1. **Get the certificate:**
   ```sh
   npm install
   npm run cert -- add-tv <DUID> --email <your Samsung account email> --name "Your Name"
   npm run cert                                              # shows what is in certs/
   ```
   - `add-tv` signs in to your Samsung account (paste back the JSON the sign-in page shows) and asks Samsung for a distributor certificate for that DUID. Run it again with another DUID to add a TV; it keeps the TVs already listed, their privilege level (override with `--partner` / `--public`) and your author certificate. It refuses an author certificate that Samsung didn't issue; `--new-author` replaces it (apps signed with the old one then need uninstalling before they can be updated).
   - `npm run cert -- import` copies an existing Apps2Samsung certificate instead: the one its *Certificate* setting chooses, found automatically on macOS/Windows, or pass the folder.
   - Get the DUID with `sdb shell 0 getduid` (step 3).
2. **Sign the package:**
   ```sh
   npm run sign -- installer-unsigned.wgt installer.wgt   # or: npm run build -- installer -> dist/installer.wgt
   ```
   It should say `Signed with certs/author.p12 + Samsung distributor …`.
3. **Point the TV at your computer:** Apps → press `1 2 3 4 5` → Developer Mode ON, Host PC IP = your computer's IP → OK → restart the TV (hold power until the logo).
4. **Install it once** with `sdb` (from Tizen Studio or the Tizen VS Code extension):
   ```sh
   sdb connect 192.168.1.20                  # your TV's IP
   sdb shell 0 getduid                       # the DUID for step 1, if you need it
   sdb push installer.wgt /home/owner/share/tmp/sdk_tools/installer.wgt
   sdb shell 0 vd_appinstall TboxInst01 /home/owner/share/tmp/sdk_tools/installer.wgt
   ```
   It prints `install completed` when done. If it was installed before with a different author certificate, remove it first with `sdb shell 0 vd_appuninstall TboxInst01.Installer`.
5. **Switch the TV to 127.0.0.1 for good:** Apps → `1 2 3 4 5` → Host PC IP `127.0.0.1` → OK → restart the TV.
6. Open **TV Installer** on the TV, then **give it your certificate** so it can sign every package it installs:
   ```sh
   npm run push -- --cert --tv 192.168.1.20 --pin 123456
   ```
   (or upload the files and password in the browser page's *Signing certificate* card). The TV then shows four green checks, the last one `Signing: <your name>`.

## Installing apps after that

Any `.wgt` / `.tpk` works, whoever built it: the Installer drops the package's own signatures and signs it with your certificate before installing.

- **Browser:** open the address shown on the TV, enter the PIN, drop a `.wgt`, or paste a URL / `owner/repo` (installs that repo's latest GitHub release; `owner/repo:name` picks the package whose file name contains `name` when a release has several).
- **Command line:**
  ```sh
  npm run push -- dist/ytmod.wgt --tv 192.168.1.20 --pin 123456   # remembered in .tvrc.json
  npm run push -- --url jellyfin/jellyfin-tizen
  ```
- **On the TV:** the app list supports Open and Uninstall with the remote (▲▼, OK, BACK).

The Installer's service starts at boot, so uploads work without opening the app — but the PIN changes on every TV restart, so open the app to read it.

Re-signing means an app is installed under your author certificate. An app that is already on the TV with someone else's signature can't be updated that way: uninstall it once, then install it through the Installer.

## Installing YT Mod

```sh
npm run build -- ytmod
npm run push -- dist/ytmod-unsigned.wgt          # or: npm run push -- --url alfrededison/tizen-toolbox:ytmod
```

Then open **YT Mod** on the TV. Details, settings and troubleshooting: [apps/ytmod/README.md](apps/ytmod/README.md).

## Updating the Installer

The Installer can install a new version of itself; it re-signs it with your certificate like any other package. On the browser page, paste `alfrededison/tizen-toolbox:installer` to install the latest release, or from a checkout:

```sh
npm run push -- --url alfrededison/tizen-toolbox:installer   # latest release
npm run push -- dist/installer.wgt                   # or your own build
```

Releases are unsigned, so anyone can install them with their own certificate.

## Releasing

Each app is released on its own, from `main`, by pushing a tag that matches its version:

| App | Bump | Tag | Release asset |
| --- | --- | --- | --- |
| TV Installer | `npm run bump:installer -- patch` | `v1.0.1` | `installer-unsigned.wgt` (marked *Latest*) |
| YT Mod | `npm run bump:ytmod -- patch` | `ytmod-v0.1.2` | `ytmod-unsigned.wgt` |

```sh
npm run bump:ytmod -- patch          # updates config.xml, package.json, the service VERSION and package-lock
git commit -am "YT Mod 0.1.2" && git push
git tag ytmod-v0.1.2 && git push origin ytmod-v0.1.2
```

The workflow (`.github/workflows/release.yml`) works out the app from the tag, fails if the tag doesn't match `apps/<app>/config.xml`, runs the tests, builds only that app and publishes a GitHub release with its `.wgt`. Installer releases stay the repo's *Latest* release, so `alfrededison/tizen-toolbox` alone still means the Installer; `alfrededison/tizen-toolbox:ytmod` (or `:installer`) picks the newest release that contains that app. Running the workflow by hand on a branch builds and tests everything without releasing.

## Signing

On the TV, the Installer keeps your certificate (uploaded with `npm run push -- --cert` or the browser page) in its private storage (`/home/owner/apps_rw/TboxInst01/data/signing`) and signs every package with it (`packages/tizen-sign`, an ES5 port of tizen.js's signer). The API only ever returns a description of it, never the files or the password; uploading it sends the files and password over your home network unencrypted, like the PIN. Remove it from the browser page to install packages exactly as they are. Re-signing on the TV is limited to packages of 100 MB.

On your computer, `npm run build` and `npm run sign` use `certs/author.p12`, `certs/distributor.p12` and `certs/password.txt` (see [With your own certificate and sdb](#with-your-own-certificate-and-sdb)); `npm run sign -- some-app.wgt` signs a package without the Installer. Without `certs/distributor.p12` the build falls back to the Tizen public distributor, which Samsung TVs reject. Env overrides: `TIZEN_AUTHOR_KEY`, `TIZEN_AUTHOR_KEY_PW`, `TIZEN_DISTRIBUTOR_KEY`, `TIZEN_DISTRIBUTOR_KEY_PW`.

When an install fails with the certificate error, the Installer says which DUID the certificate must list. Without a certificate on the TV, it refuses unsigned uploads unless you tick "install anyway".

## How it works

```
phone / laptop ──HTTP + PIN──▶ Installer service (Node, on the TV, :8093)
                                   │ writes package to /home/owner/share/tmp/sdk_tools
                                   ▼
                               sdbd 127.0.0.1:26101 ── "0 vd_appinstall <pkgId> <path>"
```

- sdbd only trusts the configured Host PC IP, so it is never exposed to the LAN; the service's PIN-protected API is the only door. Five different wrong PINs lock it for a minute.
- The TV UI (packaged page, no web origin) can call the API without a PIN; web pages — including ones opened in the TV's own browser — cannot.
- Services are bundled with ncc, fully transpiled to ES5 with Babel (`forceAllTransforms`), and the build fails if a bundle is not valid ES5, so they run on old Tizen Node runtimes.

## Development

```sh
npm test                      # sdb-core, installer API, YT Mod flow (fake sdbd / DevTools / npm registry), built bundle smoke tests
npm run build -- installer    # build one app
```

`TBOX_SDB_PORT`, `TBOX_DEVAPI_URL` and `TBOX_TMP_DIR` let you run the built service on a computer against fakes (see `test/`).

## Things still to verify on a real TV

- Whether the service's `on-boot` auto-start works with public-level signing.
- How long re-signing a large package takes on the TV's CPU.
- YT Mod: which host the DevTools port answers on (it tries 127.0.0.1, then the TV's LAN IP), and that `Page.setBypassCSP` and key registration behave as in TizenTube's injector.

## Credits & license

GPL-3.0-only. Builds on ideas and protocol knowledge from [TizenBrew / TizenBrewInstaller](https://github.com/reisxd/TizenBrewInstaller), [TizenTube](https://github.com/reisxd/TizenTube) and [tizen.js](https://github.com/reisxd/tizen.js) by Reis Can (all GPL-3.0). Thanks to [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung), which showed that Samsung TVs need a Samsung certificate for their DUID; `npm run cert -- import` reuses the certificates it creates. See `NOTICE`.
