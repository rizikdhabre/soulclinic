const { fork, spawn } = require('node:child_process');
const path = require('node:path');
const { root, resolveRuntime, cleanEnvironment } = require('../firebaseOtpV2/runtime.cjs');
async function main() {
  const server = fork(path.join(__dirname, 'server.cjs'), [], { cwd: root, env: cleanEnvironment(), stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  let child;
  try {
    const baseURL = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Harness startup timed out')), 60000);
      server.once('error', reject);
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Harness startup exit ${code}`)); });
      server.once('message', message => { clearTimeout(timeout); resolve(message.baseURL); });
    });
    console.log(`Isolated customer profile harness: ${baseURL}; no Next server, database or provider.`);
    child = spawn(process.execPath, [path.join(path.dirname(resolveRuntime('playwright/package.json')), 'cli.js'), 'test', '--config', path.join(__dirname, 'playwright.config.cjs'), ...process.argv.slice(2)], { cwd: root, env: { ...cleanEnvironment(), PROFILE_TEST_BASE_URL: baseURL }, stdio: 'inherit', windowsHide: true });
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  } finally { child?.kill(); server.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
