import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "plugins", "factory");
const manifest = JSON.parse(
  fs.readFileSync(path.join(source, ".claude-plugin", "plugin.json"), "utf8"),
);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("Release requires a semantic version in plugin.json");
}
if (manifest.icon && !fs.existsSync(path.join(source, manifest.icon))) {
  throw new Error(`Plugin icon is missing: ${manifest.icon}`);
}

const outIdx = process.argv.indexOf("--out");
const outDir = path.resolve(
  outIdx >= 0 && process.argv[outIdx + 1]
    ? process.argv[outIdx + 1]
    : path.join(root, "dist"),
);
fs.mkdirSync(outDir, { recursive: true });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-factory-package-"));
const bundle = path.join(temp, "factory");
const files = {};

function copyTree(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    throw new Error(`Bundle symlink not allowed: ${src}`);
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src).sort()) {
      if (entry === ".DS_Store" || entry === "node_modules") continue;
      copyTree(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, src.endsWith(".mjs") ? 0o755 : 0o644);
  const rel = path.relative(bundle, dest).split(path.sep).join("/");
  files[rel] = crypto
    .createHash("sha256")
    .update(fs.readFileSync(dest))
    .digest("hex");
}

try {
  copyTree(source, bundle);
  const archive = path.join(outDir, `claude-factory-${manifest.version}.tgz`);
  execFileSync("tar", ["-czf", archive, "-C", temp, "factory"], {
    stdio: "pipe",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  fs.writeFileSync(
    path.join(outDir, `claude-factory-${manifest.version}.sha256.json`),
    JSON.stringify(
      {
        schemaVersion: 1,
        plugin: manifest.name,
        version: manifest.version,
        archive: path.basename(archive),
        sha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(archive))
          .digest("hex"),
        files,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log(archive);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
