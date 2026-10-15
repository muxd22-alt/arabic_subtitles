const http = require('http');
const config = require('./config.js');

/**
 * Tiny localhost status API so the Android APK (or `arabic-subs status`)
 * can see what the engine is doing without touching Termux internals.
 */
function startStatusServer(state, options = {}) {
    const port = options.port || config.STATUS_PORT;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (url.pathname === '/health') {
            res.end(JSON.stringify({ ok: true, version: config.VERSION }));
            return;
        }

        if (url.pathname === '/status') {
            const snapshot = typeof state === 'function' ? state() : state;
            res.end(JSON.stringify(Object.assign({ version: config.VERSION }, snapshot)));
            return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
    });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
            resolve({
                server,
                port,
                close() {
                    return new Promise((r) => server.close(r));
                }
            });
        });
    });
}

module.exports = { startStatusServer };
