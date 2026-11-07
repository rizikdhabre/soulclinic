// Exercises the actual Next/Workflow runtime against a disposable loopback DB.
// No .env files or production credentials are copied into this fixture.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const root = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const base = path.join(root, 'docs/previews');
  fs.mkdirSync(base, { recursive: true });
  const target = fs.mkdtempSync(path.join(base, 'ordering-workflow-'));
  for (const name of ['src', 'public', 'package.json', 'package-lock.json', 'jsconfig.json', 'next.config.mjs', 'postcss.config.mjs', 'tailwind.config.js']) {
    fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(target, 'node_modules'), 'junction');
  const mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  const dbClient = await new MongoClient(mongo.getUri()).connect();
  const db = dbClient.db('soul');
  const treatmentId = new ObjectId('111111111111111111111111');
  await db.collection('treatments').insertMany([
    { _id: treatmentId, title: 'test', services: [{ _id: 's1', title: 'one' }, { _id: 's2', title: 'two' }, { _id: 's3', title: 'three' }] },
    { _id: new ObjectId('222222222222222222222222'), title: 'second', services: [] },
  ]);
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const allowed = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT'];
  const env = Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', MONGO_URI: mongo.getUri(), JWT_SECRET: 'isolated-ordering-test',
    WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_LOCAL_BASE_URL: origin, WORKFLOW_LOCAL_DATA_DIR: path.join(target, '.workflow-data'), PORT: String(port) });
  const logPath = path.join(target, 'runtime.log');
  const log = fs.openSync(logPath, 'w');
  const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: target, env, windowsHide: true, stdio: ['ignore', log, log] });
  const token = jwt.sign({ role: 'admin', adminId: 'fixture-admin' }, env.JWT_SECRET);
  async function send(key, order, sequence) {
    const response = await fetch(`${origin}/api/admin/treatments/${key === 'main' ? 'reorder' : 'services/reorder'}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: `token=${token}` },
      body: JSON.stringify({ ...(key === 'main' ? {} : { treatmentId: String(treatmentId) }), order, clientId: 'fixture-client', sequence, owner: 'fixture-admin' }),
    });
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
  }
  async function until(check, timeout = 90000) {
    const deadline = Date.now() + timeout;
    while (!await check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for durable workflow'); await delay(200); }
  }
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Next exited ${child.exitCode}`);
      return fs.readFileSync(logPath, 'utf8').includes('Ready in');
    });
    // The HTTP request finishes here. No browser/client needs to stay connected.
    await send('main', ['222222222222222222222222', String(treatmentId)], 1);
    await until(async () => (await db.collection('treatmentOrdering').findOne({ _id: 'main' }))?.order?.[0] === '222222222222222222222222');
    console.log('Main order applied by durable worker after the initiating request ended.');
    await send('services', ['s2', 's1', 's3'], 2);
    await delay(2000);
    await send('services', ['s3', 's2', 's1'], 3);
    await delay(3500);
    assert.deepEqual((await db.collection('treatments').findOne({ _id: treatmentId })).services.map(s => s._id), ['s1', 's2', 's3']);
    await until(async () => (await db.collection('treatments').findOne({ _id: treatmentId })).services[0]._id === 's3');
    console.log('Subtreatment worker waited for the latest drag deadline and applied without further client requests.');
  } catch (error) {
    console.error(fs.readFileSync(logPath, 'utf8').slice(-9000));
    throw error;
  } finally {
    if (process.platform === 'win32') {
      await new Promise(resolve => spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('exit', resolve));
    } else child.kill();
    fs.closeSync(log);
    await dbClient.close();
    await mongo.stop();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
