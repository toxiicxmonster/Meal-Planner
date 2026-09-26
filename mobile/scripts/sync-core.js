// Copies the shared planner rules from the web app (docs/core.js) into the iPhone app,
// so meal types, aisles, merging and family sync behave the same everywhere.
// Runs automatically before `npm start`; run `npm run sync-core` after editing docs/core.js.
const fs = require("fs");
const path = require("path");

const from = path.join(__dirname, "..", "..", "docs", "core.js");
const to = path.join(__dirname, "..", "src", "lib", "core.js");
const banner = "// GENERATED from docs/core.js by scripts/sync-core.js — edit docs/core.js instead.\n";
fs.writeFileSync(to, banner + fs.readFileSync(from, "utf8"));
console.log("Copied docs/core.js -> src/lib/core.js");
