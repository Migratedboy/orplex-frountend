const postcss = require("postcss");
const fs = require("fs");
const src = fs.readFileSync("src/app/globals.css", "utf8");
try {
  postcss.parse(src, { from: "src/app/globals.css" });
  console.log("parse ok");
} catch (e) {
  const line = e.line || 1;
  const lines = src.split("\n");
  console.log("ERR:", e.message, "=> line", line);
  for (let i = Math.max(0, line - 5); i < Math.min(lines.length, line + 4); i++) {
    console.log(String(i + 1).padStart(4), lines[i].slice(0, 130));
  }
}
