'use strict';

const os = require('os');
const { Session } = require('testcafe-hammerhead');

const ERROR_PAGE = (url, message) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Proxy error</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:40px;max-width:700px;margin:auto}
code{background:#222;padding:2px 6px;border-radius:4px;word-break:break-all}a{color:#7cf}</style></head>
<body><h1>Couldn't load this page</h1>
<p>Requested: <code>${escapeHtml(url)}</code></p>
<p>Error: <code>${escapeHtml(message)}</code></p>
<p><a href="/">Back to home</a></p></body></html>`;

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

class ProxySession extends Session {
    constructor(id, data = {}) {
        super([os.tmpdir()], { allowMultipleWindows: true, disablePageCaching: true });

        this.id = id;
        this.createdAt = data.createdAt || Date.now();
        this.lastUsed = data.lastUsed || Date.now();
        this.dirty = !data.createdAt;

        if (data.cookies)
            this.cookies.setJar(data.cookies);
    }

    touch() {
        this.lastUsed = Date.now();
        this.dirty = true;
    }

    serialize() {
        return {
            id: this.id,
            createdAt: this.createdAt,
            lastUsed: this.lastUsed,
            cookies: this.cookies.serializeJar(),
        };
    }

    // --- hammerhead abstract methods ---

    async getIframePayloadScript() {
        return '';
    }

    async getPayloadScript() {
        return '';
    }

    handleFileDownload() {}

    handleAttachment() {}

    getAuthCredentials() {
        return null;
    }

    handlePageError(ctx, err) {
        const message = err && err.message || String(err);

        if (ctx.res.headersSent || ctx.res.writableEnded) {
            ctx.res.destroy?.();
            return;
        }

        ctx.res.statusCode = 502;
        ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
        ctx.res.end(ERROR_PAGE(ctx.dest && ctx.dest.url || '', message));
    }
}

module.exports = ProxySession;
