#!/usr/bin/env node
// Valida el manifest antes de testear/packear: lo que CWS rechaza en el upload.
import { existsSync, readFileSync } from "node:fs";

const fail = (msg) => {
  console.error(`manifest: ${msg}`);
  process.exit(1);
};

const dir = new URL("../extension/", import.meta.url);
let manifest;
try {
  manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));
} catch (err) {
  fail(`invalid JSON: ${err.message}`);
}

if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
for (const key of ["name", "version", "description"]) {
  if (!manifest[key]) fail(`missing ${key}`);
}
for (const perm of ["debugger", "tabs", "alarms", "storage"]) {
  if (!manifest.permissions?.includes(perm)) fail(`missing permission ${perm}`);
}
if (!manifest.background?.service_worker) fail("missing background.service_worker");
for (const size of ["16", "48", "128"]) {
  const icon = manifest.icons?.[size];
  if (!icon) fail(`missing icon ${size}`);
  if (!existsSync(new URL(icon, dir))) fail(`icon file not found: ${icon}`);
}
console.log("manifest ok");
