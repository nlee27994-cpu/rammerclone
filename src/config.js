'use strict';

const path = require('path');

function int(name, fallback) {
    const value = parseInt(process.env[name], 10);

    return Number.isFinite(value) ? value : fallback;
}

module.exports = {
    host: process.env.HOST || '0.0.0.0',
    port: int('PORT', 8080),

    // Trust X-Forwarded-Proto / X-Forwarded-Host when running behind a reverse proxy (nginx, Caddy, Cloudflare...).
    trustProxy: process.env.TRUST_PROXY === 'true',

    // Optional upstream HTTP proxy for outgoing requests, e.g. "user:pass@proxy.local:3128".
    upstreamProxy: (process.env.UPSTREAM_PROXY || '').replace(/^https?:\/\//, ''),

    // If set, creating a new session requires this password.
    password: process.env.PASSWORD || '',

    // Where sessions (cookies) are persisted between restarts.
    sessionDir: process.env.SESSION_DIR || path.join(__dirname, '..', 'data', 'sessions'),

    // Sessions not used for this long are deleted from disk.
    sessionMaxAgeMs: int('SESSION_MAX_AGE_HOURS', 72) * 60 * 60 * 1000,

    // Sessions idle in memory for this long are saved and unloaded.
    sessionIdleUnloadMs: int('SESSION_IDLE_MINUTES', 15) * 60 * 1000,

    // How often dirty sessions are flushed to disk and stale ones cleaned up.
    sessionSaveIntervalMs: int('SESSION_SAVE_SECONDS', 30) * 1000,
};
