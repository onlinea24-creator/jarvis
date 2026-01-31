"use strict";

const fs = require("fs");
const path = require("path");

function tsCompact() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "_" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function backupFile(fp, tag) {
  const b = fp + `.bak_${tag}`;
  fs.copyFileSync(fp, b);
  return b;
}

function patchIndexHtml(src) {
  let out = src;

  // Ensure modalSave is async (needed for await setApiKey/hasApiKey)
  out = out.replace("modalSave.onclick = () => {", "modalSave.onclick = async () => {");

  // Find APIKEY modal block and inject setApiKey call
  const reBlock = /if\s*\(\s*modalKind\s*===\s*["']apikey["']\s*\)\s*\{[\s\S]*?\n\s*return;\s*\n\s*\}/m;
  const m = out.match(reBlock);
  if (!m) throw new Error("index.html: apikey block not found");

  let block = m[0];
  if (!block.includes("jarvis.setApiKey") && !block.includes("APIKEY_SECURE_STORED")) {
    const injection =
`        // Secure store (main process) — do not persist key in localStorage
        try {
          if (window.jarvis && typeof window.jarvis.setApiKey === "function") {
            await window.jarvis.setApiKey(v);
            if (typeof window.jarvis.hasApiKey === "function") {
              const has = await window.jarvis.hasApiKey();
              cfg.hasApiKey = !!has;
            } else {
              cfg.hasApiKey = !!v;
            }
            LS.save(cfg);
            pushDiag("APIKEY_SECURE_STORED");
          } else {
            pushDiag("APIKEY_SECURE_STORE_FAIL: jarvis.setApiKey missing");
          }
        } catch (e) {
          pushDiag("APIKEY_SECURE_STORE_FAIL: " + (e && e.message ? e.message : "ERR"));
        }
`;

    // Insert just before closeModal()/return in that block
    block = block.replace(
      /\s*closeModal\(\);\s*\n\s*return;\s*/m,
      "\n" + injection + "\n        closeModal();\n        return;\n"
    );
  }

  // Make sure we are not storing plaintext apiKey into localStorage
  out = out.replace(/cfg\.apiKey\s*=\s*v;\s*\r?\n/g, "");

  out = out.replace(reBlock, block);
  return out;
}

function patchPreloadJs(src) {
  let out = src;

  // Allow start with empty apiKey if a stored key exists in main process
  const re =
/if\s*\(!apiKey\)\s*\{\s*\r?\n\s*if\s*\(outEl\)\s*outputAppendLine\(outEl,\s*"JARVIS:\s*API key missing\."\);\s*\r?\n\s*return;\s*\r?\n\s*\}/m;

  if (re.test(out)) {
    out = out.replace(
      re,
`if (!apiKey) {
      try {
        const has = (window.jarvis && typeof window.jarvis.hasApiKey === "function")
          ? await window.jarvis.hasApiKey()
          : false;
        if (!has) {
          if (outEl) outputAppendLine(outEl, "JARVIS: API key missing.");
          return;
        }
        if (outEl) outputAppendLine(outEl, "JARVIS: using stored API key.");
      } catch (_) {
        if (outEl) outputAppendLine(outEl, "JARVIS: API key missing.");
        return;
      }
    }`
    );
  }

  return out;
}

function main() {
  const root = __dirname;
  const idx = path.join(root, "index.html");
  const pre = path.join(root, "preload.js");

  if (!fs.existsSync(idx)) throw new Error("Missing index.html");
  if (!fs.existsSync(pre)) throw new Error("Missing preload.js");

  const tag = tsCompact();

  const idxBak = backupFile(idx, tag);
  const preBak = backupFile(pre, tag);

  const idxSrc = fs.readFileSync(idx, "utf8");
  const preSrc = fs.readFileSync(pre, "utf8");

  const idxOut = patchIndexHtml(idxSrc);
  const preOut = patchPreloadJs(preSrc);

  fs.writeFileSync(idx, idxOut, "utf8");
  fs.writeFileSync(pre, preOut, "utf8");

  console.log("PATCH_UI_APIKEY_WIRE_V1_OK");
  console.log("- index.html backup:", idxBak);
  console.log("- preload.js backup:", preBak);
}

try {
  main();
} catch (e) {
  console.error("PATCH_UI_APIKEY_WIRE_V1_FAIL");
  console.error((e && e.stack) ? e.stack : String(e));
  process.exit(2);
}
