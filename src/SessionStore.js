'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ProxySession = require('./ProxySession');

const ID_RE = /^[a-f0-9]{32}$/;

class SessionStore {
    constructor(proxy, config) {
        this.proxy = proxy;
        this.config = config;
        this.dir = config.sessionDir;

        fs.mkdirSync(this.dir, { recursive: true });

        this.timer = setInterval(() => this.maintain(), config.sessionSaveIntervalMs);
        this.timer.unref();
    }

    static isValidId(id) {
        return typeof id === 'string' && ID_RE.test(id);
    }

    _file(id) {
        return path.join(this.dir, id + '.json');
    }

    create() {
        const id = crypto.randomBytes(16).toString('hex');
        const session = new ProxySession(id);

        this._open(session);
        this._save(session);

        return session;
    }

    exists(id) {
        if (!SessionStore.isValidId(id))
            return false;

        return this.proxy.openSessions.has(id) || fs.existsSync(this._file(id));
    }

    // Returns an opened session, loading it from disk if necessary.
    get(id) {
        if (!SessionStore.isValidId(id))
            return null;

        let session = this.proxy.openSessions.get(id);

        if (!session) {
            let data;

            try {
                data = JSON.parse(fs.readFileSync(this._file(id), 'utf8'));
            }
            catch {
                return null;
            }

            session = new ProxySession(id, data);
            this._open(session);
        }

        session.touch();

        return session;
    }

    delete(id) {
        if (!SessionStore.isValidId(id))
            return false;

        const session = this.proxy.openSessions.get(id);

        if (session)
            this.proxy.closeSession(session);

        try {
            fs.unlinkSync(this._file(id));
            return true;
        }
        catch {
            return !!session;
        }
    }

    _open(session) {
        // NOTE: Proxy#openSession returns a proxied URL built from the default server info,
        // which we don't use since URLs are built per-request from the Host header.
        this.proxy.openSession('about:blank', session, this.config.upstreamProxy || null);
    }

    _save(session) {
        try {
            fs.writeFileSync(this._file(session.id), JSON.stringify(session.serialize()));
            session.dirty = false;
        }
        catch (err) {
            console.error(`[sessions] failed to save ${session.id}:`, err.message);
        }
    }

    maintain() {
        const now = Date.now();

        for (const session of this.proxy.openSessions.values()) {
            if (session.dirty)
                this._save(session);

            if (now - session.lastUsed > this.config.sessionIdleUnloadMs)
                this.proxy.closeSession(session);
        }

        let files = [];

        try {
            files = fs.readdirSync(this.dir);
        }
        catch {
            return;
        }

        for (const file of files) {
            const id = path.basename(file, '.json');

            if (!SessionStore.isValidId(id) || this.proxy.openSessions.has(id))
                continue;

            try {
                const { mtimeMs } = fs.statSync(this._file(id));

                if (now - mtimeMs > this.config.sessionMaxAgeMs)
                    fs.unlinkSync(this._file(id));
            }
            catch {
                // ignore races with concurrent deletes
            }
        }
    }

    saveAll() {
        for (const session of this.proxy.openSessions.values())
            this._save(session);
    }
}

module.exports = SessionStore;
