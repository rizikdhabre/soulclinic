const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const { createHash } = require('node:crypto');
const { root, resolveRuntime } = require('./runtime.cjs');

// This process can only serve static, in-memory artifacts. No outbound connection is allowed.
function denied() { throw new Error('OTP harness forbids outbound network connections'); }
net.Socket.prototype.connect = denied;
tls.connect = denied;
globalThis.fetch = denied;

async function main() {
  const esbuild = require(resolveRuntime('esbuild'));
  const postcss = require(require.resolve('postcss', { paths: [root] }));
  const tailwind = require(require.resolve('tailwindcss', { paths: [root] }));
  const mockSdk = path.join(__dirname, 'sdk.mock.js');
  const sourceHashes = {};
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(__dirname, 'harness.jsx')],
    bundle: true, write: false, metafile: true, format: 'iife', platform: 'browser',
    jsx: 'automatic', sourcemap: 'inline', logLevel: 'warning',
    alias: { '@': path.join(root, 'src') },
    define: {
      'process.env.NODE_ENV': '"development"',
      'process.env.NEXT_PUBLIC_FIREBASE_API_KEY': '"mock-public-key"',
      'process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN': '"otp-mock.invalid"',
      'process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID': '"otp-mock-project"',
      'process.env.NEXT_PUBLIC_FIREBASE_APP_ID': '"otp-mock-app"',
      'process.env': '{}',
    },
    plugins: [{ name: 'otp-sidecar-import-boundary', setup(build) {
      build.onResolve({ filter: /^firebase\/(app|auth)$/ }, () => ({ path: mockSdk }));
      build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: path.join(__dirname, 'navigation.mock.js') }));
      build.onResolve({ filter: /^(firebase-admin|twilio|mongodb|dotenv|server-only|@google-cloud\/|node:)/ }, args => ({ errors: [{ text: `Forbidden server/provider dependency: ${args.path}` }] }));
      build.onLoad({ filter: /\.[jt]sx?$/ }, args => {
        const relative = path.relative(root, args.path).replaceAll('\\', '/');
        if (!relative.startsWith('src/')) return undefined;
        const contents = fs.readFileSync(args.path, 'utf8');
        sourceHashes[relative] = createHash('sha256').update(contents).digest('hex');
        return { contents, loader: path.extname(args.path) === '.js' ? 'jsx' : path.extname(args.path).slice(1) };
      });
    } }],
  });
  const inputs = Object.keys(result.metafile.inputs);
  if (inputs.some(input => /node_modules[\\/](?:@firebase|firebase|firebase-admin|twilio|mongodb)[\\/]|src[\\/]app[\\/]api[\\/]/.test(input))) {
    throw new Error('Real provider or API module reached browser bundle');
  }
  for (const file of ['src/components/ui/LoginPage.jsx', 'src/components/ui/AppointmentForm.jsx', 'src/hooks/usePhoneOtp.js', 'src/lib/otp/client.js', 'src/lib/otp/firebaseClient.js']) {
    if (!inputs.includes(file)) throw new Error(`Real production component missing from bundle: ${file}`);
  }
  const css = postcss.parse(fs.readFileSync(path.join(root, 'src/app/globals.css'), 'utf8'));
  // Keep actual application CSS, omitting its external Google Fonts request.
  css.walkAtRules('import', rule => { if (/https?:/.test(rule.params)) rule.remove(); });
  const styles = await postcss([tailwind({
    ...require(path.join(root, 'tailwind.config.js')),
    content: [path.join(root, 'src/**/*.{js,jsx,ts,tsx}'), path.join(__dirname, 'harness.jsx')],
  })]).process(css, { from: undefined });
  const artifacts = path.join(__dirname, 'artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'bundle-manifest.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    playwright: require(resolveRuntime('playwright/package.json')).version,
    esbuild: esbuild.version,
    mockedImports: ['firebase/app', 'firebase/auth', 'next/navigation'],
    sources: sourceHashes,
    providerInputs: inputs.filter(input => /sdk\.mock/.test(input)),
    nextServerStarted: false, databaseConnected: false,
  }, null, 2));
  const assets = new Map([
    ['/harness.js', ['text/javascript; charset=utf-8', result.outputFiles[0].contents]],
    ['/styles.css', ['text/css; charset=utf-8', styles.css]],
    ['/health', ['application/json', JSON.stringify({ isolated: true, sdkMocked: true, productionComponents: true })]],
  ]);
  const html = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/harness.js"></script></body></html>';
  for (const route of ['/login', '/booking', '/both', '/appointments']) assets.set(route, ['text/html; charset=utf-8', html]);
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') { response.writeHead(405); response.end('No API or database exists in this harness'); return; }
    const asset = assets.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!asset) { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': asset[0] }); response.end(asset[1]);
  });
  server.listen(0, '127.0.0.1', () => {
    process.send?.({ baseURL: `http://127.0.0.1:${server.address().port}` });
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
