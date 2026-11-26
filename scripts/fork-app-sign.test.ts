// @effect-diagnostics nodeBuiltinImport:off - Drives the macOS signing script against temporary keychains and bundles.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const signScript = NodePath.join(repoRoot, "scripts", "fork-app-sign.sh");

const runChecked = (command: string, args: ReadonlyArray<string>) => {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
};

const createTempSigningKeychain = (dir: string, commonNames: ReadonlyArray<string>) => {
  const keychainPath = NodePath.join(dir, "test.keychain-db");
  const password = "test-keychain-password";
  runChecked("security", ["create-keychain", "-p", password, keychainPath]);
  runChecked("security", ["unlock-keychain", "-p", password, keychainPath]);

  const sha1List: string[] = [];
  for (const [index, cn] of commonNames.entries()) {
    const extPath = NodePath.join(dir, `ext-${index}.cnf`);
    const keyPath = NodePath.join(dir, `key-${index}.pem`);
    const certPath = NodePath.join(dir, `cert-${index}.pem`);
    const p12Path = NodePath.join(dir, `id-${index}.p12`);
    NodeFS.writeFileSync(
      extPath,
      `[req]
distinguished_name = dn
x509_extensions = codesign
prompt = no
[dn]
CN = ${cn}
[codesign]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:FALSE
`,
    );
    runChecked("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "30",
      "-config",
      extPath,
    ]);
    const legacyExport = NodeChildProcess.spawnSync(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-legacy",
        "-inkey",
        keyPath,
        "-in",
        certPath,
        "-out",
        p12Path,
        "-passout",
        `pass:${password}`,
      ],
      { encoding: "utf8" },
    );
    if (legacyExport.status !== 0) {
      runChecked("openssl", [
        "pkcs12",
        "-export",
        "-inkey",
        keyPath,
        "-in",
        certPath,
        "-out",
        p12Path,
        "-passout",
        `pass:${password}`,
      ]);
    }
    runChecked("security", [
      "import",
      p12Path,
      "-k",
      keychainPath,
      "-P",
      password,
      "-T",
      "/usr/bin/codesign",
    ]);
    const fp = runChecked("openssl", ["x509", "-in", certPath, "-noout", "-fingerprint", "-sha1"]);
    const sha1 = fp.stdout.split("=")[1]?.trim().replaceAll(":", "").toUpperCase();
    assert.isDefined(sha1);
    sha1List.push(sha1!);
  }

  runChecked("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    password,
    keychainPath,
  ]);

  const cleanup = () => {
    NodeChildProcess.spawnSync("security", ["delete-keychain", keychainPath], { encoding: "utf8" });
  };
  return { keychainPath, sha1List, cleanup };
};

const makeTestableApp = (appDir: string, bundleId = "com.t3tools.t3code") => {
  const contents = NodePath.join(appDir, "Contents");
  const macos = NodePath.join(contents, "MacOS");
  const resources = NodePath.join(contents, "Resources");
  NodeFS.mkdirSync(macos, { recursive: true });
  NodeFS.mkdirSync(resources, { recursive: true });
  NodeFS.copyFileSync("/usr/bin/true", NodePath.join(macos, "T3 Code (Beta)"));
  NodeFS.chmodSync(NodePath.join(macos, "T3 Code (Beta)"), 0o755);
  NodeFS.writeFileSync(NodePath.join(resources, "marker.txt"), "fork-resource\n");
  NodeFS.writeFileSync(
    NodePath.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>T3 Code (Beta)</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleName</key>
  <string>T3 Code (Beta)</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.13-fork.20261126</string>
</dict>
</plist>
`,
  );
};

describe.skipIf(HostProcess.Platform.defaultValue() !== "darwin")("fork-app-sign.sh", () => {
  it("fails loudly when the requested signing identity is missing", () => {
    const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-sign-missing-"));
    const kc = createTempSigningKeychain(workDir, ["Other Identity"]);
    try {
      const result = NodeChildProcess.spawnSync(
        "bash",
        [
          signScript,
          "--check-identity",
          "--identity",
          "T3 Code Fork",
          "--keychain",
          kc.keychainPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.include(result.stderr, "signing identity 'T3 Code Fork' not found");
    } finally {
      kc.cleanup();
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("fails loudly when multiple identities share the same common name", () => {
    const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-sign-dup-"));
    const kc = createTempSigningKeychain(workDir, ["T3 Code Fork", "T3 Code Fork"]);
    try {
      const result = NodeChildProcess.spawnSync(
        "bash",
        [
          signScript,
          "--check-identity",
          "--identity",
          "T3 Code Fork",
          "--keychain",
          kc.keychainPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.include(result.stderr, "is ambiguous");
    } finally {
      kc.cleanup();
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("signs an app with a stable certificate designated requirement and verifies even without the keychain", () => {
    const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-sign-ok-"));
    const kc = createTempSigningKeychain(workDir, ["T3 Code Fork"]);
    try {
      const appDir = NodePath.join(workDir, "T3 Code (Beta).app");
      makeTestableApp(appDir);

      const signResult = NodeChildProcess.spawnSync(
        "bash",
        [signScript, "--identity", "T3 Code Fork", "--keychain", kc.keychainPath, appDir],
        { encoding: "utf8" },
      );
      assert.equal(
        signResult.status,
        0,
        `stdout:\n${signResult.stdout}\nstderr:\n${signResult.stderr}`,
      );
      assert.include(signResult.stdout, "Authority=T3 Code Fork");

      // Delete the signing keychain to simulate the Pro, which has no signing identity of its own.
      kc.cleanup();

      const verifyResult = NodeChildProcess.spawnSync("bash", [signScript, "--verify", appDir], {
        encoding: "utf8",
      });
      assert.equal(
        verifyResult.status,
        0,
        `stdout:\n${verifyResult.stdout}\nstderr:\n${verifyResult.stderr}`,
      );

      const dvvv = runChecked("codesign", ["-dvvv", appDir]);
      const dvvvText = `${dvvv.stdout}\n${dvvv.stderr}`;
      assert.include(dvvvText, "Identifier=com.t3tools.t3code");
      assert.include(dvvvText, "Authority=T3 Code Fork");
      assert.notInclude(dvvvText, "Signature=adhoc");
      assert.include(dvvvText, "Info.plist entries=");
      assert.include(dvvvText, "Sealed Resources version=");

      const req = runChecked("codesign", ["-d", "-r-", appDir]);
      const reqText = `${req.stdout}\n${req.stderr}`;
      assert.include(reqText, 'designated => identifier "com.t3tools.t3code" and certificate leaf');
      assert.notInclude(reqText, "cdhash");
    } finally {
      kc.cleanup();
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("refuses ad-hoc signed and tampered bundles in --verify mode", () => {
    const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-sign-verify-"));
    const kc = createTempSigningKeychain(workDir, ["T3 Code Fork"]);
    try {
      const adhocApp = NodePath.join(workDir, "Adhoc.app");
      makeTestableApp(adhocApp);
      runChecked("codesign", ["--force", "--deep", "--sign", "-", adhocApp]);

      const adhocVerify = NodeChildProcess.spawnSync("bash", [signScript, "--verify", adhocApp], {
        encoding: "utf8",
      });
      assert.equal(adhocVerify.status, 1);
      assert.include(adhocVerify.stderr, "ad-hoc");

      const signedApp = NodePath.join(workDir, "Signed.app");
      makeTestableApp(signedApp);
      runChecked("bash", [
        signScript,
        "--identity",
        "T3 Code Fork",
        "--keychain",
        kc.keychainPath,
        signedApp,
      ]);
      NodeFS.writeFileSync(
        NodePath.join(signedApp, "Contents", "Resources", "marker.txt"),
        "tampered\n",
      );

      const tamperedVerify = NodeChildProcess.spawnSync(
        "bash",
        [signScript, "--verify", signedApp],
        { encoding: "utf8" },
      );
      assert.equal(tamperedVerify.status, 1);
      assert.include(tamperedVerify.stderr, "codesign --verify --deep --strict");
    } finally {
      kc.cleanup();
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
