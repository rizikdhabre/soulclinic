const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');

function resolveRuntime(specifier) {
  const bases = [root];
  if (process.env.OTP_TEST_RUNTIME_ROOT) bases.push(process.env.OTP_TEST_RUNTIME_ROOT);
  const cache = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  if (fs.existsSync(cache)) {
    for (const entry of fs.readdirSync(cache).sort()) bases.push(path.join(cache, entry));
  }
  for (const base of bases) {
    try {
      const resolved = require.resolve(specifier, { paths: [base] });
      if (specifier.startsWith('playwright/')) {
        const runtime = require(require.resolve('playwright', { paths: [base] }));
        if (!fs.existsSync(runtime.chromium.executablePath())) continue;
      }
      return resolved;
    } catch {}
  }
  throw new Error(`Missing ${specifier}. No install was attempted. Provide OTP_TEST_RUNTIME_ROOT pointing to an existing runtime, or ask the parent to add the minimal test dependency.`);
}

function cleanEnvironment() {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PLAYWRIGHT_BROWSERS_PATH', 'OTP_TEST_RUNTIME_ROOT'];
  const env = Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  return { ...env, NODE_ENV: 'test', TZ: 'UTC' };
}

module.exports = { root, resolveRuntime, cleanEnvironment };
