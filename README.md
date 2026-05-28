# HelloApps

A packaged Cribl App ready to install into a Cribl instance. This repository contains the **built, distributable form** of the app — the manifest, platform configuration, and prebuilt static assets — not the source code.

---

## What's in this package

```
package.json              — Cribl app manifest
default/
  proxies.yml             — External API allowlist
static/
  index.html              — App entry point loaded by the Cribl platform
  favicon.svg             — App favicon
  icons.svg               — Icon sprite sheet
  assets/
    index-CoKUWqhm.js     — Bundled JavaScript (React app)
    index-C5WKzbFa.css    — Bundled styles
```

### `package.json`

The Cribl app manifest. The `cribl` block identifies this as an installable app and pins the create-app script version it was built against.

```1:10:package.json
{
  "name": "helloapps",
  "version": "1.0.1",
  "displayName": "HelloApps",
  "author": "Cribl Apps Team",
  "cribl": {
    "type": "app",
    "createAppScriptVersion": "0.1.0"
  }
}
```

### `default/proxies.yml`

Declares every external domain the app is allowed to reach. Admins review this file at install time, so each entry should be precise about paths and intent.

This app declares one external domain — the free, no-auth Open-Meteo weather API — scoped to a single allowlisted path:

```14:17:default/proxies.yml
api.open-meteo.com:
  paths:
    allowlist:
      - /v1/forecast
```

At runtime, the platform rewrites `fetch()` calls to external URLs so they route through the app's proxy endpoint. The browser never forwards auth headers directly; use `headers.inject` in this file to attach secrets stored in the KV store when an API requires authentication.

### `static/index.html`

The HTML document the Cribl platform loads inside the app's sandboxed iframe. It sets a development app id, mounts a `#root` element, and pulls in the hashed JS and CSS bundles from `static/assets/`.

### `static/assets/`

The compiled React application:
- `index-CoKUWqhm.js` — the full app bundle (UI, KV helpers, weather widget, REST API calls)
- `index-C5WKzbFa.css` — bundled styles for the card-based layout

These are output artifacts. Filenames are content-hashed and change every time the app is rebuilt.

### `static/favicon.svg` and `static/icons.svg`

Image assets served alongside the app — the favicon shown in browser tabs, and an SVG icon sprite referenced by the UI.

---

## Installing this app

Package this directory into a `.tgz` and upload it to your Cribl instance under **Apps**:

```bash
tar -czf helloapps-1.0.1.tgz package.json default static
```

Then open your Cribl UI → **Apps** → **Install App** and upload the resulting tarball.

---

## What the app does

Once installed, HelloApps demonstrates the core building blocks of the Cribl App Platform:
- Running inside a sandboxed iframe with platform globals (`window.CRIBL_API_URL`, `window.CRIBL_APP_ID`)
- Persisting state via the platform KV store (`GET`/`PUT`/`DELETE ${CRIBL_API_URL}/kvstore/<key>`)
- Calling a read-only Cribl REST API and degrading gracefully when the user lacks permission
- Calling an allowlisted external API (Open-Meteo) through the platform proxy
