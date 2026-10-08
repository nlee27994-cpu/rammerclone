'use strict';

const config = require('./config');
const RammerProxy = require('./RammerProxy');

const proxy = new RammerProxy(config);

proxy.start()
    .then(() => {
        const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;

        console.log(`Proxy listening on http://${shown}:${config.port}`);
    })
    .catch(err => {
        console.error('Failed to start:', err);
        process.exit(1);
    });

function shutdown() {
    console.log('Saving sessions and shutting down...');
    proxy.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', err => console.error('[uncaught]', err));
process.on('unhandledRejection', err => console.error('[unhandled]', err));
