#!/usr/bin/env node
import { readFileSync } from "node:fs";
JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url)));
console.log("manifest ok");
