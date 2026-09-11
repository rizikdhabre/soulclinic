const { fork, spawn } = require('node:child_process');
const path = require('node:path');
const { root, resolveRuntime, cleanEnvironment } = require('./runtime.cjs');

async function main() {
  const playwright = path.join(path.dirname(resolveRuntime('playwright/package.json')), 'cli.js');
  const env = cleanEnvironment();
  const server = fork(path.join(__dirname, 'server.cjs'), [], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let child;
  const stop = () => {
    child?.kill();
    server.kill();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const baseURL = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Isolated harness startup timed out')), 60000);
      server.once('error', reject);
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Harness exited during startup: ${code}`)); });
      server.once('message', message => { clearTimeout(timeout); resolve(message.baseURL); });
    });
    console.log(`OTP sidecar: ${baseURL}; SDK imports mocked; all API requests intercepted; no Next server or database.`);
    child = spawn(process.execPath, [playwright, 'test', '--config', 'playwright.otp.config.cjs', ...process.argv.slice(2)], {
      cwd: root, env: { ...env, OTP_TEST_BASE_URL: baseURL }, stdio: 'inherit', windowsHide: true,
    });
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    process.exitCode = exitCode ?? 1;
  } finally {
    child?.kill();
    if (server.exitCode === null) {
      await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
