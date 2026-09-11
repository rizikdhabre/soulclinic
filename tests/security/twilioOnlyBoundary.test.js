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

it("contains no removed auth SDK, reCAPTCHA, or runtime fixed-code path", () => {
  for (const file of sources(path.join(root, "src"))) {
    const code = fs.readFileSync(file, "utf8");
    expect(code, file).not.toMatch(/recaptcha|firebase-admin|firebase\/auth|firebase\/app|OTP_DEV_CODE|NEXT_PUBLIC_FIREBASE|sendFirebase|safeCompareDevelopmentCode|123456/i);
    if (!file.endsWith(`${path.sep}cloudStorage.js`)) expect(code, file).not.toMatch(/firebase/i);
  }
});

it("has no removed provider dependencies, including transitive lockfile entries", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  expect(Object.keys(manifest.dependencies)).not.toEqual(expect.arrayContaining(["firebase", "firebase-admin"]));
  expect(Object.keys(lock.packages).filter((key) => /(?:^|\/)node_modules\/(?:@firebase\/|firebase(?:-admin)?$)/.test(key))).toEqual([]);
  expect(manifest.dependencies["@google-cloud/storage"]).toBeTruthy();
});

it("keeps storage credentials server-only and removes the secondary-provider endpoint", () => {
  const storage = fs.readFileSync(path.join(root, "src/lib/cloudStorage.js"), "utf8");
  expect(storage).toContain('import "server-only"');
  expect(storage).toContain('import("@google-cloud/storage")');
  expect(fs.existsSync(path.join(root, "src/app/api/otp/fallback/route.js"))).toBe(false);
  expect(fs.existsSync(path.join(root, "src/app/api/otp/send/route.js"))).toBe(true);
});
