import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cwd = fileURLToPath(new URL("../../", import.meta.url));

function runLambdaNode(source) {
  const env = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "Path", "TEMP", "TMP"]
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  return spawnSync(process.execPath, ["--no-experimental-require-module", "--no-experimental-detect-module", "-e", source], {
    cwd, env, encoding: "utf8", windowsHide: true, timeout: 15000,
  });
}

describe("real Firebase Admin under Lambda module restrictions", () => {
  it("loads Auth and rejects malformed proof without credentials or provider calls", () => {
    const result = runLambdaNode(`
      (async () => {
        const assert = require('node:assert/strict');
        const { initializeApp, deleteApp } = await import('firebase-admin/app');
        const { getAuth } = await import('firebase-admin/auth');
        const app = initializeApp({ projectId: 'isolated-runtime-test' });
        await assert.rejects(getAuth(app).verifyIdToken('malformed-test-proof'),
          error => error.code === 'auth/argument-error');
        await deleteApp(app);
        console.log('auth-loaded-and-invalid-proof-rejected');
      })().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
    `);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("auth-loaded-and-invalid-proof-rejected");
  });

  it("resolves real JWKS signing keys and rejects a mismatched signature", () => {
    const result = runLambdaNode(`
      (async () => {
        const assert = require('node:assert/strict');
        const { generateKeyPairSync } = require('node:crypto');
        const { createRequire } = require('node:module');
        const adminRequire = createRequire(require.resolve('firebase-admin/app'));
        const jwks = adminRequire('jwks-rsa');
        const jwt = require('jsonwebtoken');
        const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'isolated-key', alg: 'RS256', use: 'sig' };
        const client = jwks({ cache: false, rateLimit: false, fetcher: async () => ({ keys: [jwk] }) });
        const key = await client.getSigningKey('isolated-key');
        const token = jwt.sign({ sub: 'isolated-user' }, pair.privateKey, { algorithm: 'RS256' });
        assert.equal(jwt.verify(token, key.getPublicKey(), { algorithms: ['RS256'] }).sub, 'isolated-user');
        const invalid = jwt.sign({ sub: 'isolated-user' }, wrong.privateKey, { algorithm: 'RS256' });
        assert.throws(() => jwt.verify(invalid, key.getPublicKey(), { algorithms: ['RS256'] }), /invalid signature/);
        console.log('jwks-signature-checks-passed');
      })().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
    `);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("jwks-signature-checks-passed");
  });
});
