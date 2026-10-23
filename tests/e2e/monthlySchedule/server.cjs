const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const { root, resolveRuntime } = require('../firebaseOtpV2/runtime.cjs');
function denied() { throw new Error('Monthly schedule harness forbids outbound network'); }
net.Socket.prototype.connect = denied;
tls.connect = denied;
globalThis.fetch = denied;

async function main() {
  const esbuild = require(resolveRuntime('esbuild'));
  const postcss = require(require.resolve('postcss', { paths: [root] }));
  const tailwind = require(require.resolve('tailwindcss', { paths: [root] }));
  const result = await esbuild.build({
    absWorkingDir: root, entryPoints: [path.join(__dirname, 'harness.jsx')], bundle: true,
    write: false, metafile: true, format: 'iife', platform: 'browser', jsx: 'automatic',
    logLevel: 'warning', alias: { '@': path.join(root, 'src') },
    define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    plugins: [{ name: 'isolated-monthly-schedule', setup(build) {
      build.onResolve({ filter: /^(firebase|twilio|mongodb|dotenv|server-only|@google-cloud\/|node:)/ }, args => ({ errors: [{ text: `Forbidden dependency ${args.path}` }] }));
      build.onLoad({ filter: /src[\\/].*\.js$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'jsx' }));
    } }],
  });
  const css = postcss.parse(fs.readFileSync(path.join(root, 'src/app/globals.css'), 'utf8'));
  css.walkAtRules('import', rule => { if (/https?:/.test(rule.params)) rule.remove(); });
  const styles = await postcss([tailwind({ ...require(path.join(root, 'tailwind.config.js')), content: [path.join(root, 'src/**/*.{js,jsx}'), path.join(__dirname, 'harness.jsx')] })]).process(css, { from: undefined });
  const assets = new Map([
    ['/harness.js', ['text/javascript; charset=utf-8', result.outputFiles[0].contents]],
    ['/styles.css', ['text/css; charset=utf-8', styles.css]],
  ]);
  const html = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/harness.js"></script></body></html>';
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'");
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' || req.url.startsWith('/api/')) { res.writeHead(404); res.end('No backend in harness'); return; }
    const asset = assets.get(new URL(req.url, 'http://127.0.0.1').pathname) || ['text/html; charset=utf-8', html];
    res.writeHead(200, { 'Content-Type': asset[0] }); res.end(asset[1]);
  });
  const listen = () => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    // Windows can assign a low ephemeral port that browsers reserve (for example 1720).
    if (port < 20000) { server.close(listen); return; }
    process.send?.({ baseURL: `http://127.0.0.1:${port}` });
  });
  listen();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
