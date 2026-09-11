import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const root = process.cwd();
function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
  });
}

it("keeps SDK access in dedicated adapters and forbids runtime fixed-code paths", () => {
  for (const file of sources(path.join(root, "src"))) {
    const code = fs.readFileSync(file, "utf8");
    expect(code, file).not.toMatch(/OTP_DEV_CODE|safeCompareDevelopmentCode|123456|appVerificationDisabledForTesting/);
    if (!file.endsWith(`${path.sep}firebaseClient.js`)) expect(code, file).not.toMatch(/["']firebase\/(?:auth|app)["']/);
    if (!file.endsWith(`${path.sep}firebaseAdminAuth.js`)) expect(code, file).not.toMatch(/["']firebase-admin(?:\/[^"']*)?["']/);
  }
});

it("installs only the required Firebase entry packages while retaining native storage", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  expect(Object.keys(manifest.dependencies)).toEqual(expect.arrayContaining(["firebase", "firebase-admin"]));
  expect(lock.packages["node_modules/firebase"].version).toBeTruthy();
  expect(lock.packages["node_modules/firebase-admin"].version).toBeTruthy();
  expect(manifest.dependencies["@google-cloud/storage"]).toBeTruthy();
});

it("keeps storage credentials server-only and provides controlled provider endpoints", () => {
  const storage = fs.readFileSync(path.join(root, "src/lib/cloudStorage.js"), "utf8");
  expect(storage).toContain('import "server-only"');
  expect(storage).toContain('import("@google-cloud/storage")');
  expect(storage).not.toMatch(/firebase\/storage|firebase-admin/);
  for (const name of ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "FIREBASE_STORAGE_BUCKET"]) expect(storage).toContain(name);
  expect(fs.existsSync(path.join(root, "src/app/api/otp/fallback/route.js"))).toBe(true);
  expect(fs.existsSync(path.join(root, "src/app/api/otp/firebase-send/route.js"))).toBe(true);
  expect(fs.existsSync(path.join(root, "src/app/api/otp/send/route.js"))).toBe(true);
});

it("keeps Firebase Admin credentials outside browser authentication code", () => {
  const admin = fs.readFileSync(path.join(root, "src/lib/otp/firebaseAdminAuth.js"), "utf8");
  expect(admin).toContain('import "server-only"');
  const client = fs.readFileSync(path.join(root, "src/lib/otp/firebaseClient.js"), "utf8");
  expect(client).not.toMatch(/firebase-admin|FIREBASE_PRIVATE_KEY|FIREBASE_CLIENT_EMAIL|localStorage|indexedDB/);
  expect(client).toContain("inMemoryPersistence");
});
