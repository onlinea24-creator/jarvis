// Output 1/2 — patch_secure_apikey_v1.js
"use strict";

const fs = require("fs");
const path = require("path");

function tsTag() {
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

function backup(filePath) {
  const tag = tsTag();
  const bak = `${filePath}.bak_${tag}`;
  fs.copyFileSync(filePath, bak);
  return bak;
}

function readUtf8(p) {
  return fs.readFileSync(p, "utf8");
}

function writeUtf8(p, s) {
  fs.writeFileSync(p, s, "utf8");
}

function ensureContains(hay, needle, label) {
  if (!hay.includes(needle)) {
    throw new Error(`PATCH_FAIL_MISSING(${label}): ${needle}`);
  }
}

function patchMainJS(root) {
  const p = path.join(root, "main.js");
  let s = readUtf8(p);

  const bak = backup(p);

  // 1) Add safeStorage to electron destructuring import (exact replace)
  const importOld =
    'const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, dialog, globalShortcut, screen } = require("electron");';
  const importNew =
    'const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, dialog, globalShortcut, screen, safeStorage } = require("electron");';

  if (s.includes(importOld)) s = s.replace(importOld, importNew);

  // 2) Insert secure API key store helpers once
  const marker = "// -------------------- API KEY (secure store, OS-encrypted) --------------------";
  if (!s.includes(marker)) {
    const re = /function runnerPermsPath\(\)\s*\{\s*return\s+path\.join\(userDataRoot\(\),\s*"jarvis_permissions\.json"\);\s*\}\s*\n/;
    ensureContains(s, 'function runnerPermsPath() { return path.join(userDataRoot(), "jarvis_permissions.json"); }', "main.runnerPermsPath");
    const snippet =
`\n${marker}
function apiKeyStorePath() { return path.join(userDataRoot(), "jarvis_api_key.enc"); }

function canEncryptApiKey() {
  try {
    return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable());
  } catch (_) {
    return false;
  }
}

function setStoredApiKey(apiKey) {
  try {
    const k = String(apiKey || "").trim();
    safeMkdir(userDataRoot());
    const fp = apiKeyStorePath();

    if (!k) {
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
      try { auditEvent("APIKEY_STORE", { action: "cleared" }); } catch (_) {}
      return { ok: true, cleared: true };
    }

    if (!canEncryptApiKey()) {
      try { auditEvent("APIKEY_STORE", { action: "failed", reason: "ENCRYPTION_UNAVAILABLE" }); } catch (_) {}
      return { ok: false, error: "ENCRYPTION_UNAVAILABLE" };
    }

    const buf = safeStorage.encryptString(k);
    fs.writeFileSync(fp, buf.toString("base64"), "utf8");
    try { auditEvent("APIKEY_STORE", { action: "set" }); } catch (_) {}
    return { ok: true };
  } catch (e) {
    try { auditEvent("APIKEY_STORE", { action: "failed", reason: String(e && e.message ? e.message : e) }); } catch (_) {}
    return { ok: false, error: "WRITE_FAILED" };
  }
}

function getStoredApiKey() {
  try {
    const fp = apiKeyStorePath();
    if (!fs.existsSync(fp)) return "";
    if (!canEncryptApiKey()) return "";
    const b64 = String(fs.readFileSync(fp, "utf8") || "").trim();
    if (!b64) return "";
    const buf = Buffer.from(b64, "base64");
    return safeStorage.decryptString(buf);
  } catch (_) {
    return "";
  }
}

function hasStoredApiKey() {
  try { return !!String(getStoredApiKey() || "").trim(); } catch (_) { return false; }
}
\n`;
    s = s.replace(re, (m) => m + snippet);
  }

  // 3) Insert IPC handlers once (right after IPC header)
  const ipcHeader = "// -------------------- IPC --------------------";
  ensureContains(s, ipcHeader, "main.ipcHeader");
  if (!s.includes('ipcMain.handle("jarvis:setApiKey"')) {
    const ipcSnippet =
`\nipcMain.handle("jarvis:setApiKey", (_e, payload) => {
  const apiKey = payload && payload.apiKey ? payload.apiKey : "";
  return setStoredApiKey(apiKey);
});
ipcMain.handle("jarvis:hasApiKey", () => {
  return { ok: true, has: hasStoredApiKey(), encryption: canEncryptApiKey() };
});
\n`;
    s = s.replace(ipcHeader, ipcHeader + ipcSnippet);
  }

  // 4) Patch jarvis:start handler to auto-fill apiKey from secure store or env when empty
  const startNeedle = 'ipcMain.handle("jarvis:start"';
  ensureContains(s, startNeedle, "main.ipcStart");
  const startRe = /ipcMain\.handle\("jarvis:start",[\s\S]*?\n\}\);\n/;
  const startBlockNew =
`ipcMain.handle("jarvis:start", (_e, payload) => {
  const taskText = payload && payload.taskText ? payload.taskText : "";
  let apiKey = payload && payload.apiKey ? payload.apiKey : "";
  const history = payload && Array.isArray(payload.history) ? payload.history : [];
  const rulesText = payload && typeof payload.rulesText === "string" ? payload.rulesText : "";

  apiKey = String(apiKey || "").trim();
  if (!apiKey) apiKey = String(getStoredApiKey() || "").trim();
  if (!apiKey) apiKey = String(process.env.OPENAI_API_KEY || process.env.JARVIS_OPENAI_API_KEY || "").trim();

  return runner.start(taskText, apiKey, history, rulesText);
});
`;
  s = s.replace(startRe, startBlockNew + "\n");

  writeUtf8(p, s);
  return { file: "main.js", backup: bak };
}

function patchPreloadJS(root) {
  const p = path.join(root, "preload.js");
  let s = readUtf8(p);

  const bak = backup(p);

  // 1) Expose setApiKey / hasApiKey
  if (!s.includes('setApiKey: (apiKey) => ipcRenderer.invoke("jarvis:setApiKey"')) {
    const anchor = 'state: () => ipcRenderer.invoke("jarvis:state"),';
    ensureContains(s, anchor, "preload.anchorState");
    s = s.replace(
      anchor,
      anchor +
        '\n\n  setApiKey: (apiKey) => ipcRenderer.invoke("jarvis:setApiKey", { apiKey }),\n  hasApiKey: () => ipcRenderer.invoke("jarvis:hasApiKey"),'
    );
  }

  // 2) Remove hard-block when apiKey empty in doStart()
  const oldBlock =
`    if (!apiKey) {
      if (outEl) outputAppendLine(outEl, "JARVIS: API key missing.");
      return;
    }
`;
  const newBlock =
`    if (!apiKey) {
      if (outEl) outputAppendLine(outEl, "JARVIS: API key empty (using saved/env key).");
    }
`;
  if (s.includes(oldBlock)) s = s.replace(oldBlock, newBlock);

  writeUtf8(p, s);
  return { file: "preload.js", backup: bak };
}

function patchIndexHTML(root) {
  const p = path.join(root, "index.html");
  let s = readUtf8(p);

  const bak = backup(p);

  // 1) Purge legacy cfg.apiKey from localStorage object (one-time)
  const cfgLoad = "const cfg = LS.load();";
  ensureContains(s, cfgLoad, "index.cfgLoad");
  if (!s.includes("Security: API key is NOT stored in localStorage")) {
    const purge =
`\n    // Security: API key is NOT stored in localStorage. If legacy key exists, purge it.
    try { if (cfg.apiKey) { delete cfg.apiKey; LS.save(cfg); pushDiag("APIKEY_PURGED_LOCALSTORAGE"); } } catch (_) {}
`;
    s = s.replace(cfgLoad, cfgLoad + purge);
  }

  // 2) Never populate apiKey from localStorage
  s = s.replace('$("apiKey").value = cfg.apiKey || "";', '$("apiKey").value = "";');

  // 3) Replace modal save for API key to store via secure IPC, not localStorage
  const apikeyOld =
`      if (modalKind === "apikey") {
        const v = (document.getElementById("m_apiKey")?.value || "").trim();
        $("apiKey").value = v;
        cfg.apiKey = v;
        LS.save(cfg);
        pushDiag("APIKEY_SAVED");
        closeModal();
        return;
      }`;
  const apikeyNew =
`      if (modalKind === "apikey") {
        const v = (document.getElementById("m_apiKey")?.value || "").trim();

        // Never keep the key in renderer storage/fields
        $("apiKey").value = "";

        cfg.hasApiKey = !!v;
        LS.save(cfg);

        try {
          if (window.jarvis && typeof window.jarvis.setApiKey === "function") {
            window.jarvis.setApiKey(v)
              .then((r) => {
                if (r && r.ok) pushDiag("APIKEY_SAVED_SECURE");
                else pushDiag("APIKEY_SAVE_FAILED:" + (r && r.error ? r.error : "UNKNOWN"));
              })
              .catch((e) => pushDiag("APIKEY_SAVE_FAILED:" + (e && e.message ? e.message : "ERR")));
          } else {
            pushDiag("APIKEY_SAVE_FAILED:NO_BRIDGE");
          }
        } catch (e) {
          pushDiag("APIKEY_SAVE_FAILED:" + (e && e.message ? e.message : "ERR"));
        }

        closeModal();
        return;
      }`;
  if (s.includes(apikeyOld)) {
    s = s.replace(apikeyOld, apikeyNew);
  } else {
    // fallback: ensure at least we don't store cfg.apiKey anymore
    s = s.replace(/cfg\.apiKey\s*=\s*v\s*;\s*\n\s*LS\.save\(cfg\)\s*;\s*/g, "cfg.hasApiKey = !!v;\n        LS.save(cfg);\n");
  }

  writeUtf8(p, s);
  return { file: "index.html", backup: bak };
}

// ---- run patch ----
(function main() {
  const root = process.cwd();
  const must = ["main.js", "preload.js", "index.html"];
  for (const f of must) {
    const fp = path.join(root, f);
    if (!fs.existsSync(fp)) throw new Error("MISSING_FILE: " + fp);
  }

  const results = [];
  results.push(patchMainJS(root));
  results.push(patchPreloadJS(root));
  results.push(patchIndexHTML(root));

  console.log("PATCH_SECURE_APIKEY_V1_OK");
  for (const r of results) console.log(`- ${r.file} | backup: ${r.backup}`);
})();
// Output 2/2 — (vuoto: tutto il file è già in Output 1/2)
