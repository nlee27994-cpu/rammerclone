'use strict';

const { DestinationRequest } = require('testcafe-hammerhead');

const HINTS = {
    ENOTFOUND: 'The server could not look up this domain. Check the server\'s internet connection or DNS settings.',
    EAI_AGAIN: 'DNS lookup timed out. Check the server\'s internet connection or DNS settings.',
    ECONNREFUSED: 'The site refused the connection.',
    ECONNRESET: 'The connection was cut off. A firewall or web filter on the server\'s network is probably blocking this site.',
    EPROTO: 'The secure (TLS) connection failed. A web filter doing HTTPS inspection on the server\'s network is a common cause.',
    ETIMEDOUT: 'The connection timed out. A firewall on the server\'s network may be blocking it.',
};

function describe(err) {
    const code = err.code || (/\b(E[A-Z_]{3,})\b/.exec(err.message || '') || [])[1] || '';
    const hint = HINTS[code] || '';

    return `${err.message || err}${hint ? ` (${hint})` : ''}`;
}

/**
 * Hammerhead reports ECONNREFUSED, ECONNRESET, EPROTO and ENOTFOUND all as "Failed to find a DNS-record",
 * which hides the real cause. Keep the underlying error and show it on the error page and in the log.
 */
function patchDestinationErrors() {
    const proto = DestinationRequest.prototype;
    const onError = proto._onError;
    const fatalError = proto._fatalError;

    proto._onError = function (err) {
        this._lastError = err;
        return onError.call(this, err);
    };

    proto._fatalError = function (msg, url) {
        if (!this.aborted && this._lastError) {
            const details = describe(this._lastError);

            console.error(`[request] ${this.opts.url}: ${details}`);

            const origEmit = this.emit;

            this.emit = function (event, text, ...rest) {
                if (event === 'fatalError')
                    text = `${text} Underlying error: ${details}`;

                return origEmit.call(this, event, text, ...rest);
            };

            try {
                return fatalError.call(this, msg, url);
            }
            finally {
                this.emit = origEmit;
            }
        }

        return fatalError.call(this, msg, url);
    };
}

module.exports = { patchDestinationErrors };
