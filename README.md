# Rammerclone

A session-based web proxy in the style of [Rammerhead](https://github.com/binary-person/rammerhead), built on
[testcafe-hammerhead](https://github.com/DevExpress/testcafe-hammerhead), the same URL-rewriting engine Rammerhead uses.

- **Full page rewriting**: HTML, CSS, JS, iframes, forms, `fetch`/XHR, WebSockets and workers are all routed back through the proxy.
- **Persistent sessions**: each session has its own cookie jar, saved to disk, so logins survive server restarts and work across devices (share the session ID).
- **Single port, any domain**: proxied URLs are built from the request's `Host` header, so it works on `localhost`, a LAN IP, or behind a reverse proxy with HTTPS.
- **Real tab titles and new tabs**: hammerhead's TestCafe-specific title mangling is patched out, and `target="_blank"` opens real tabs.

Proxied URLs look like `http://your-host/<sessionId>/https://example.com/`.

## Running

Requires Node.js 20+.

```sh
npm install
npm start
```

Open http://localhost:8080, type a URL or a search term, and press **Go**. A session is created automatically.

### Docker

```sh
docker build -t rammerclone .
docker run -p 8080:8080 -v rammerclone-data:/app/data rammerclone
```

## Configuration

All settings are environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `PASSWORD` | _(none)_ | If set, creating a session requires this password |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-Proto`/`X-Forwarded-Host`. Enable behind nginx, Caddy, Cloudflare, etc. |
| `UPSTREAM_PROXY` | _(none)_ | Send outgoing traffic through an HTTP proxy, e.g. `user:pass@10.0.0.2:3128` |
| `SESSION_DIR` | `./data/sessions` | Where session cookie jars are stored |
| `SESSION_MAX_AGE_HOURS` | `72` | Delete sessions unused for this long |
| `SESSION_IDLE_MINUTES` | `15` | Unload idle sessions from memory (they stay on disk) |
| `SESSION_SAVE_SECONDS` | `30` | How often modified sessions are flushed to disk |

### Behind a reverse proxy (HTTPS)

Example nginx config. WebSocket upgrade headers are required:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
}
```

Then start the proxy with `TRUST_PROXY=true`.

## How it works

```
browser ──> /<sessionId>/https://site.com/page
              │
              ├─ RammerProxy (src/RammerProxy.js)
              │    single HTTP server; builds hammerhead "server info" per request from Host header,
              │    serves the home page + /api, loads sessions lazily from disk
              │
              └─ hammerhead request pipeline
                   fetches https://site.com/page with the session's cookie jar, rewrites every URL in
                   the response to point back at the proxy, and injects hammerhead.js, which hooks
                   DOM/JS APIs in the page so runtime-created URLs get rewritten too
```

- `src/ProxySession.js`: hammerhead `Session` subclass with serialisable cookies and an error page.
- `src/SessionStore.js`: creates, loads, saves, unloads and expires sessions.
- `public/`: the home page. Session IDs are remembered in `localStorage`.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/config` | `{ passwordRequired }` |
| `POST` | `/api/sessions` | Body `{ password? }` → `{ id }` |
| `GET` | `/api/sessions/:id` | `{ exists }` |
| `DELETE` | `/api/sessions/:id` | `{ deleted }` |

## Limitations

Like Rammerhead, this is a rewriting proxy, so heavily obfuscated or very new sites may break. Some sites
also block known proxy/datacenter IPs or need captchas the proxy can't solve. Only use it on networks where
you're allowed to.
