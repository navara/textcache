// Serves the playground page on http://127.0.0.1:8377/ (content scripts do not run on file: pages unless that is allowed per extension).
// Usage: node test/playground/serve.cjs [port]
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const port = Number(process.argv[2]) || 8377;
const page = path.join(__dirname, 'index.html');

http.createServer((request, response) => {
    if (new URL(request.url, 'http://x').pathname !== '/') {
        // 204 for the favicon keeps the page's console free of errors that are not the extension's
        response.writeHead(request.url === '/favicon.ico' ? 204 : 404).end();
        return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(fs.readFileSync(page));
}).listen(port, '127.0.0.1', () => {
    console.log(`TextCache playground: http://127.0.0.1:${port}/  (add ?autorun to start the scenarios on load)`);
});
