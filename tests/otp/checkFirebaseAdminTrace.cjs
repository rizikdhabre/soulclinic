const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

// Exercise only the deployment trace, without borrowing the checkout's node_modules.
const root = path.resolve(__dirname, "../..");
const trace = path.join(root, ".next/server/app/api/otp/complete/route.js.nft.json");
const destination = fs.mkdtempSync(path.join(os.tmpdir(), "soulclinic-traced-admin-"));
const links = [];
let count = 0;
function relativeToRoot(source) {
  const relative = path.relative(root, source);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Trace outside project");
  return relative;
}
for (const file of JSON.parse(fs.readFileSync(trace, "utf8")).files) {
  const source = path.resolve(path.dirname(trace), file);
  const target = path.join(destination, relativeToRoot(source));
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) { links.push([source, target]); continue; }
  if (!stat.isFile()) throw new Error("Unexpected trace entry");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  count++;
}
for (const [source, target] of links) {
  const relocated = path.join(destination, relativeToRoot(fs.realpathSync(source)));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(relocated, target, process.platform === "win32" ? "junction" : "dir");
}
const alias = fs.readdirSync(path.join(destination, ".next/node_modules"))
  .find(name => /^firebase-admin-[a-f0-9]+$/.test(name));
if (!alias) throw new Error("Firebase Admin external alias missing from trace");
const source = `for (const module of ${JSON.stringify([`${alias}/app`, `${alias}/auth`])}) {
  try { await import(module); console.log(module + ': OK'); }
  catch (error) { console.error(error.code || error.name); process.exitCode = 1; }
}`;
const env = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "Path", "TEMP", "TMP"]
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
const result = spawnSync(process.execPath, [
  "--no-experimental-require-module", "--no-experimental-detect-module", "--input-type=module", "-e", source,
], { cwd: path.join(destination, ".next"), env, encoding: "utf8", windowsHide: true, timeout: 15000 });
console.log(JSON.stringify({ destination, tracedFiles: count, links: links.length }));
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exitCode = result.status === 0 ? 0 : 1;
