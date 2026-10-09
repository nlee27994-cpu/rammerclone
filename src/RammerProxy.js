'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { Proxy } = require('testcafe-hammerhead');
const loadClientScript = require('testcafe-hammerhead/lib/utils/load-client-script');
const SERVICE_ROUTES = require('testcafe-hammerhead/lib/proxy/service-routes');
const SessionStore = require('./SessionStore');
const { patchDestinationErrors } = require('./patches');

patchDestinationErrors();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
};

// Proxied URLs look like /<sessionId>[*windowId][!resourceType...]/https://example.com/
const SESSION_IN_PATH_RE = /^\/([a-f0-9]{32})(?=[*!/]|$)/;
const VALID_HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i;
const MAX_SERVER_INFOS = 64;

// Response headers from destination sites that must not be applied to the proxy's own origin.
const STRIPPED_RESPONSE_HEADERS = new Set(['strict-transport-security', 'public-key-pins', 'expect-ct']);

function stripResponseHeaders(res) {
    const setHeader = res.setHeader;
    const writeHead = res.writeHead;

    res.setHeader = function (name, value) {
        if (STRIPPED_RESPONSE_HEADERS.has(String(name).toLowerCase()))
            return this;

        return setHeader.call(this, name, value);
    };

    res.writeHead = function (status, ...args) {
        const headers = args[args.length - 1];

        if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
            for (const name of Object.keys(headers)) {
                if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
                    delete headers[name];
            }
        }

        return writeHead.call(this, status, ...args);
    };
}

// When the proxy is served on a default port (e.g. https://proxy.example.com with no ":443"), the
// parsed proxy location in worker scripts has no port, and hammerhead crashes calling .toString()
// on it. That breaks every Web Worker, which takes down apps like Spotify's web player.
function patchMissingPort(script) {
    return script.replace(/([A-Za-z_$][\w$]*)\.port\.toString\(\)/g, '($1.port||"").toString()');
}

// Hammerhead (built for TestCafe) replaces the page's real <title> with "<sessionId>*<windowId>"
// so TestCafe can identify windows. Patch that out so tabs show the site's actual title.
function patchTitle(script) {
    const patches = [
        // Don't overwrite the native title with the session/window id.
        [/(_setProxiedTitleValue\s*=\s*function\s*\(\)\s*\{)/, '$1return;'],
        // When the page sets document.title, also update the title shown in the browser tab.
        [
            /(setTitle\s*=\s*function\s*\((\w+)\)\s*\{\s*\2\s*=\s*String\(\2\)\s*[,;]\s*this\._setValueForFirstTitleElement\(\2\))/,
            '$1;try{__rcNativeTitleSetter&&__rcNativeTitleSetter.call(this._document,$2)}catch(_){}',
        ],
    ];

    for (const [re, replacement] of patches) {
        if (!re.test(script)) {
            console.warn('[client] could not apply title patch, tab titles may show the session id');
            return script;
        }

        script = script.replace(re, replacement);
    }

    const prelude = 'var __rcNativeTitleSetter=typeof Document!=="undefined"&&' +
        '(Object.getOwnPropertyDescriptor(Document.prototype,"title")||{}).set;\n';

    return prelude + script;
}

function sendJSON(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

function readJSON(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];

        req.on('data', chunk => {
            size += chunk.length;

            if (size > limit) {
                reject(new Error('Body too large'));
                req.destroy();
            }
            else
                chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
            }
            catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();

    return crypto.timingSafeEqual(ha, hb);
}

/**
 * A single-port hammerhead proxy. Unlike stock hammerhead (which listens on two ports and
 * bakes a fixed hostname into every rewritten URL), this builds the "server info" for each
 * request from its Host header, so it works behind reverse proxies and on any domain.
 */
class RammerProxy extends Proxy {
    constructor(config) {
        super();

        this.config = config;
        this.serverInfos = new Map();
        this.sessions = new SessionStore(this, config);
    }

    start() {
        const { host, port } = this.config;

        this.proxyOptions = {
            hostname: 'localhost',
            port1: port,
            port2: port,
            developmentMode: false,
            cache: false,
            nativeAutomation: false,
            disableCrossDomain: true,
        };

        this._prepareDNSRouting();

        this.wss = new WebSocket.Server({ noServer: true });
        this.wss.on('connection', (ws, req) => this._onServiceWebSocketConnection(ws, this._getServerInfo(req)));

        // Default server info, used by hammerhead internals that don't have a request at hand.
        this.server1Info = this._createServerInfo('http:', 'localhost', port);
        this.server2Info = this.server1Info;

        this.server1 = http.createServer({ maxHeaderSize: Proxy.MAX_REQUEST_HEADER_SIZE }, (req, res) => {
            try {
                this._handle(req, res);
            }
            catch (err) {
                console.error('[request]', err);

                if (!res.headersSent)
                    res.writeHead(500, { 'content-type': 'text/plain' });

                res.end('Internal proxy error');
            }
        });
        this.server1.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
        this.server1.on('connection', socket => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });

        this._registerServiceRoutes(false);

        // Serve patched versions of hammerhead's client scripts.
        const clientScripts = [
            [SERVICE_ROUTES.hammerhead, script => patchTitle(patchMissingPort(script))],
            [SERVICE_ROUTES.transportWorker, patchMissingPort],
            [SERVICE_ROUTES.workerHammerhead, patchMissingPort],
        ];

        for (const [route, patch] of clientScripts) {
            this.GET(route, {
                contentType: 'application/x-javascript',
                content: patch(loadClientScript(route, false)),
            });
        }

        return new Promise((resolve, reject) => {
            this.server1.once('error', reject);
            this.server1.listen(port, host, () => resolve());
        });
    }

    close() {
        this.sessions.saveAll();
        super.close();
    }

    // --- server info ---

    _createServerInfo(protocol, hostname, port) {
        return {
            hostname,
            port,
            crossDomainPort: port,
            protocol,
            cacheRequests: false,
            domain: `${protocol}//${hostname}:${port}`,
            wss: this.wss,
        };
    }

    _getServerInfo(req) {
        const headers = req.headers;
        const trust = this.config.trustProxy;

        let protocol = req.socket.encrypted ? 'https' : 'http';
        let host = headers.host || '';

        if (trust && headers['x-forwarded-proto'])
            protocol = String(headers['x-forwarded-proto']).split(',')[0].trim().toLowerCase();
        if (trust && headers['x-forwarded-host'])
            host = String(headers['x-forwarded-host']).split(',')[0].trim();

        if (protocol !== 'https')
            protocol = 'http';
        if (!VALID_HOST_RE.test(host))
            host = `localhost:${this.config.port}`;

        const key = protocol + '://' + host.toLowerCase();
        let info = this.serverInfos.get(key);

        if (!info) {
            const url = new URL(key);
            const port = url.port ? parseInt(url.port, 10) : protocol === 'https' ? 443 : 80;

            info = this._createServerInfo(protocol + ':', url.hostname, port);

            if (this.serverInfos.size >= MAX_SERVER_INFOS)
                this.serverInfos.delete(this.serverInfos.keys().next().value);

            this.serverInfos.set(key, info);
        }

        return info;
    }

    // --- session loading ---

    _sessionIdFromUrl(url) {
        if (!url)
            return null;

        try {
            const pathname = url.startsWith('/') ? url : new URL(url).pathname;
            const match = SESSION_IN_PATH_RE.exec(pathname);

            return match ? match[1] : null;
        }
        catch {
            return null;
        }
    }

    // Make sure any session referenced by this request (directly or via its referer,
    // e.g. for service messages and task scripts) is loaded into hammerhead.
    _ensureSessionLoaded(req) {
        const id = this._sessionIdFromUrl(req.url) || this._sessionIdFromUrl(req.headers.referer);

        if (id)
            return this.sessions.get(id);

        return null;
    }

    // --- request handling ---

    _handle(req, res) {
        const pathname = (req.url || '/').split('?')[0];

        if (pathname.startsWith('/api/'))
            return this._handleApi(req, res, pathname);

        const pathSessionId = this._sessionIdFromUrl(req.url);

        this._ensureSessionLoaded(req);

        if (pathSessionId && !this.openSessions.has(pathSessionId)) {
            // Unknown or expired session: send the user home.
            res.writeHead(302, { location: '/?expired=1' });
            res.end();
            return;
        }

        const serverInfo = this._getServerInfo(req);

        if (this._route(req, res, serverInfo))
            return;

        if (!pathSessionId && this._serveStatic(req, res, pathname))
            return;

        if (!pathSessionId) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('Not found');
            return;
        }

        stripResponseHeaders(res);
        this._onRequest(req, res, serverInfo);
    }

    _handleUpgrade(req, socket, head) {
        socket.on('error', () => {});
        this._ensureSessionLoaded(req);

        const serverInfo = this._getServerInfo(req);

        if (head && head.length)
            socket.unshift(head);

        this._onRequest(req, socket, serverInfo);
    }

    _serveStatic(req, res, pathname) {
        if (req.method !== 'GET' && req.method !== 'HEAD')
            return false;

        if (pathname === '/')
            pathname = '/index.html';

        let decoded;

        try {
            decoded = decodeURIComponent(pathname);
        }
        catch {
            return false;
        }

        const file = path.normalize(path.join(PUBLIC_DIR, decoded));

        if (!file.startsWith(PUBLIC_DIR + path.sep))
            return false;

        let stat;

        try {
            stat = fs.statSync(file);
        }
        catch {
            return false;
        }

        if (!stat.isFile())
            return false;

        res.writeHead(200, {
            'content-type': MIME[path.extname(file)] || 'application/octet-stream',
            'content-length': stat.size,
            'cache-control': 'no-cache',
        });

        if (req.method === 'HEAD')
            res.end();
        else
            fs.createReadStream(file).pipe(res);

        return true;
    }

    async _handleApi(req, res, pathname) {
        try {
            if (pathname === '/api/config' && req.method === 'GET')
                return sendJSON(res, 200, { passwordRequired: !!this.config.password });

            if (pathname === '/api/sessions' && req.method === 'POST') {
                const body = await readJSON(req);

                if (this.config.password && !safeEqual(body.password || '', this.config.password))
                    return sendJSON(res, 401, { error: 'Wrong password' });

                const session = this.sessions.create();

                return sendJSON(res, 200, { id: session.id });
            }

            const match = /^\/api\/sessions\/([^/]+)$/.exec(pathname);

            if (match) {
                const id = match[1];

                if (req.method === 'GET')
                    return sendJSON(res, 200, { exists: this.sessions.exists(id) });

                if (req.method === 'DELETE')
                    return sendJSON(res, 200, { deleted: this.sessions.delete(id) });
            }

            return sendJSON(res, 404, { error: 'Not found' });
        }
        catch (err) {
            return sendJSON(res, 400, { error: err.message });
        }
    }
}

module.exports = RammerProxy;
