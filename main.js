"use strict";

const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, dialog, globalShortcut, screen, safeStorage } = require("electron");
// --- single instance lock ---
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) {
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
      }
    } catch (e) {}
  });
}
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { runTask } = require("./jarvis_runner");

let win = null;
let tray = null;
let isQuitting = false;

// -------------------- Paths (always computed at runtime) --------------------
function userDataRoot() {
  try { return app.getPath("userData"); } catch (_) { return process.env.APPDATA || process.cwd(); }
}
function proofsRoot() { return path.join(userDataRoot(), "proofs"); }
function auditDir() { return path.join(proofsRoot(), "audit"); }
function auditFilePath() { return path.join(auditDir(), "audit.jsonl"); }
function auditStatePath() { return path.join(auditDir(), "audit_state.json"); }
function cfgPath() { return path.join(userDataRoot(), "jarvis_cfg.json"); }
function runnerPermsPath() { return path.join(userDataRoot(), "jarvis_permissions.json"); }


// -------------------- API KEY (secure store, OS-encrypted) --------------------
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

function safeMkdir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex");
}

// -------------------- Audit log (hash-chained) --------------------
function readAuditState() {
  try {
    const p = auditStatePath();
    if (!fs.existsSync(p)) return { lastHash: "" };
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw);
    return { lastHash: String(j && j.lastHash ? j.lastHash : "") };
  } catch (_) {
    return { lastHash: "" };
  }
}

function writeAuditState(lastHash) {
  try {
    safeMkdir(auditDir());
    fs.writeFileSync(auditStatePath(), JSON.stringify({ lastHash: String(lastHash || "") }, null, 2), "utf8");
  } catch (_) {}
}

function auditEvent(type, data) {
  try {
    safeMkdir(auditDir());
    const st = readAuditState();
    const prev = String(st.lastHash || "");
    const ts = Date.now();
    const payload = {
      ts,
      type: String(type || "UNKNOWN"),
      data: (data && typeof data === "object") ? data : { value: String(data || "") },
      prev_hash: prev,
      hash: ""
    };
    const core = `${payload.ts}|${payload.type}|${JSON.stringify(payload.data)}|${payload.prev_hash}`;
    payload.hash = sha256Hex(core);

    fs.appendFileSync(auditFilePath(), JSON.stringify(payload) + "\n", "utf8");
    writeAuditState(payload.hash);
  } catch (_) {}
}

// -------------------- Config (permission decisions) --------------------
function loadCfg() {
  try {
    const p = cfgPath();
    if (!fs.existsSync(p)) return { permissions: {} };
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return { permissions: {} };
    if (!j.permissions || typeof j.permissions !== "object") j.permissions = {};
    return j;
  } catch (_) {
    return { permissions: {} };
  }
}

function saveCfg(cfg) {
  try {
    const c = cfg && typeof cfg === "object" ? cfg : { permissions: {} };
    if (!c.permissions || typeof c.permissions !== "object") c.permissions = {};
    fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2), "utf8");
  } catch (_) {}
}

function readRunnerPerms() {
  try {
    const p = runnerPermsPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw);
    return (j && typeof j === "object") ? j : null;
  } catch (_) {
    return null;
  }
}

// “Finestrella permessi”: DENY / ALLOW ONCE / ALWAYS ALLOW
async function permRequest(className, whyText) {
  const cfg = loadCfg();
  const key = String(className || "").trim() || "unknown";
  const cur = cfg.permissions[key];

  if (cur === "allow") return { ok: true, decision: "allow", cached: true };
  if (cur === "deny") return { ok: true, decision: "deny", cached: true };

  const why = String(whyText || "").trim();
  const r = await dialog.showMessageBox(win || null, {
    type: "warning",
    title: "JARVIS - Permission Required",
    message: `Allow JARVIS to enable: ${key} ?`,
    detail:
      (why ? (`WHY: ${why}\n\n`) : "") +
      "This enables autonomous actions on your PC for this class.\n" +
      "NO UAC bypass.\n" +
      "Any manual input (mouse move / Space) will trigger takeover + pause.\n\n" +
      "Choose:",
    buttons: ["DENY", "ALLOW ONCE", "ALWAYS ALLOW"],
    defaultId: 0,
    cancelId: 0
  });

  const resp = (r && typeof r.response === "number") ? r.response : 0;

  // 0 deny, 1 allow once, 2 always allow
  if (resp === 2) {
    cfg.permissions[key] = "allow";
    saveCfg(cfg);
    auditEvent("PERMISSION_DECISION", { class: key, decision: "allow", mode: "always" });
    return { ok: true, decision: "allow", cached: false };
  }
  if (resp === 1) {
    auditEvent("PERMISSION_DECISION", { class: key, decision: "allow", mode: "once" });
    return { ok: true, decision: "allow", cached: false, once: true };
  }

  cfg.permissions[key] = "deny";
  saveCfg(cfg);
  auditEvent("PERMISSION_DECISION", { class: key, decision: "deny", mode: "always" });
  return { ok: true, decision: "deny", cached: false };
}

// -------------------- AUTOPILOT / Dead-man switch (global) --------------------
let autopilotArmed = false;
let manualOverride = false;
let autopilotArmedAt = 0;

// mouse movement detector
let cursorTimer = null;
let lastCursor = null;
let ignoreMouseUntil = 0; // if AUTOPILOT moves cursor, it should set this window

const MOUSE_DIST = 46;      // threshold (Manhattan distance)
const POLL_MS = 90;
const ARM_GRACE_MS = 1500;

function startCursorWatch() {
  stopCursorWatch();
  lastCursor = screen.getCursorScreenPoint();
  cursorTimer = setInterval(() => {
    try {
      if (!autopilotArmed) return;
      const now = Date.now();
      const p = screen.getCursorScreenPoint();
      if (autopilotArmedAt && (now - autopilotArmedAt) < ARM_GRACE_MS) { lastCursor = p; return; }
      if (!lastCursor) { lastCursor = p; return; }
      const dist = Math.abs(p.x - lastCursor.x) + Math.abs(p.y - lastCursor.y);

      // update baseline
      lastCursor = p;

      if (now < ignoreMouseUntil) return;
      if (dist >= MOUSE_DIST) {
        triggerManualTakeover("MOUSE_MOVE");
      }
    } catch (_) {}
  }, POLL_MS);
}

function stopCursorWatch() {
  if (cursorTimer) {
    try { clearInterval(cursorTimer); } catch (_) {}
    cursorTimer = null;
  }
}

let registeredHotkey = "";
function registerAutopilotHotkey() {
  unregisterAutopilotHotkey();

  // Try Space first. If Electron refuses, fallback to Ctrl+Space.
  const tries = ["Space", "CommandOrControl+Space"];
  for (const accel of tries) {
    try {
      const ok = globalShortcut.register(accel, () => {
        if (autopilotArmed) triggerManualTakeover("SPACE");
      });
      if (ok) {
        registeredHotkey = accel;
        auditEvent("AUTOPILOT_HOTKEY_REGISTERED", { accelerator: accel });
        return true;
      }
    } catch (_) {}
  }

  auditEvent("AUTOPILOT_HOTKEY_REGISTER_FAIL", { tried: tries });
  return false;
}

function unregisterAutopilotHotkey() {
  try {
    if (registeredHotkey) {
      globalShortcut.unregister(registeredHotkey);
      auditEvent("AUTOPILOT_HOTKEY_UNREGISTERED", { accelerator: registeredHotkey });
    }
  } catch (_) {}
  registeredHotkey = "";
}

function setAutopilotArmed(on, why) {
  autopilotArmed = !!on;

  if (!autopilotArmed) {
    unregisterAutopilotHotkey();
    stopCursorWatch();
  } else {
    autopilotArmedAt = Date.now();
    ignoreMouseUntil = autopilotArmedAt + ARM_GRACE_MS;
    try { lastCursor = screen.getCursorScreenPoint(); } catch (_) { lastCursor = null; }
    registerAutopilotHotkey();
    startCursorWatch();
  }

  auditEvent("AUTOPILOT_ARM_STATE", { armed: autopilotArmed, why: String(why || "") });
  runner._setState();
}

function triggerManualTakeover(why) {
  if (!autopilotArmed) return;

  manualOverride = true;
  auditEvent("MANUAL_TAKEOVER", { why: String(why || "") });

  // HARD RULE: disarm autopilot + pause runner immediately
  setAutopilotArmed(false, "manual_takeover");
  try { runner.pause(); } catch (_) {}
  try { runner._log(`MANUAL TAKEOVER -> PAUSE (${why})`); } catch (_) {}

  runner._send("jarvis:log", { ts: Date.now(), line: `MANUAL TAKEOVER -> PAUSE (${why})` });
  runner._send("jarvis:state", runner.state());
}

// This is how AUTOPILOT actions should avoid self-pausing on mouse moves.
function setInjectedIgnoreWindow(ms) {
  const v = Number(ms || 0);
  if (v > 0) {
    ignoreMouseUntil = Date.now() + Math.min(4000, v);
    auditEvent("AUTOPILOT_INJECT_IGNORE", { ms: v });
  }
}

// -------------------- Runner --------------------
const runner = {
  running: false,
  paused: false,
  stopRequested: false,
  taskText: "",
  steps: [],
  error: "",
  nextAction: "",
  lastReport: "",
  proofJsonPath: "",
  _promise: null,

  _send(ch, payload) {
    try {
      if (win && win.webContents) win.webContents.send(ch, payload);
    } catch (_) {}
  },

  _log(line) {
    this._send("jarvis:log", { ts: Date.now(), line: String(line) });
  },

  _pushStep(title, status, proof) {
    const step = { ts: Date.now(), title, status, proof: proof || "" };
    this.steps.push(step);
    this._send("jarvis:step", step);
  },

  _setState() {
    this._send("jarvis:state", this.state());
  },

  _makeStopReport(reason) {
    const last5 = this.steps
      .slice(-5)
      .map((s) => `- ${s.title} :: ${s.status}${s.proof ? " | " + s.proof : ""}`);

    const report =
      `TASK: ${this.taskText || "(none)"}\n\n` +
      `LAST 5 STEPS:\n${last5.length ? last5.join("\n") : "(no steps)"}\n\n` +
      `ERROR/BLOCK: ${this.error || reason || "(none)"}\n\n` +
      `NEXT ACTION: ${this.nextAction || "Retry after resolving the block or providing authorization."}\n\n` +
      `PROOF JSON: ${this.proofJsonPath || "(none)"}`;

    this.lastReport = report;
    return report;
  },

  _showStopReport(reason) {
    const report = this._makeStopReport(reason);

    dialog.showMessageBox(win || null, {
      type: "warning",
      title: "JARVIS - STOP REPORT",
      message: "Task stopped. Report below:",
      detail: report,
    });

    try {
      const n = new Notification({
        title: "JARVIS - STOP",
        body: "Task stopped. Open the app to see the report.",
      });
      n.show();
    } catch (_) {}

    this._send("jarvis:report", { ts: Date.now(), report });
  },

  start(taskText, apiKey, history, rulesText) {
    const t = String(taskText || "").trim();
    const k = String(apiKey || "").trim();

    const hist = Array.isArray(history) ? history : [];
    const rules = typeof rulesText === "string" ? rulesText : "";

    if (!t) {
      this._log("No task text provided.");
      return { ok: false, error: "EMPTY_TASK" };
    }
    if (!k) {
      this._log("API key missing.");
      return { ok: false, error: "NO_API_KEY" };
    }
    if (this.running) {
      this._log("Already running.");
      return { ok: false, error: "ALREADY_RUNNING" };
    }

    this.running = true;
    this.paused = false;
    this.stopRequested = false;
    this.taskText = t;
    this.steps = [];
    this.error = "";
    this.nextAction = "";
    this.lastReport = "";
    this.proofJsonPath = "";

    this._log("START: " + this.taskText);
    this._pushStep("Input received", "ok", "api_key_present=true");
    this._setState();

    const baseRoot = path.resolve(__dirname, "..");
    const proofsDir = proofsRoot();

    this._promise = (async () => {
      try {
        const res = await runTask({
          apiKey: k,
          taskText: t,
          baseRoot,
          proofsDir,
          history: hist,
          rulesText: rules,
          onLog: (line) => this._log(line),
          onStep: (s) => this._pushStep(s.title, s.status, s.proof || ""),
        });

        if (this.stopRequested) {
          this._log("Result ignored because STOP was requested.");
          this.running = false;
          this.paused = false;
          this._setState();
          this._showStopReport(this.error || "STOP requested by user.");
          return;
        }

        if (!res || !res.ok) {
          this.error = res && res.error ? res.error : "RUN_FAILED";
          this.nextAction = "Check API key / network and retry.";
          this.running = false;
          this.paused = false;
          this._setState();
          this._showStopReport(this.error);
          return;
        }

        this.proofJsonPath = res.proofJsonPath || "";
        this._pushStep("Answer ready", "ok", this.proofJsonPath ? `proof=${this.proofJsonPath}` : "");

        const answerText = res && res.answer ? String(res.answer) : "";

        this._send("jarvis:answer", {
          ts: Date.now(),
          taskText: this.taskText,
          answer: answerText,
          proofJsonPath: this.proofJsonPath,
        });

        if (answerText) {
          this._log("ANSWER (top):");
          this._log(answerText.slice(0, 2500));
        }

        this.running = false;
        this.paused = false;
        this._setState();

        const report =
          `TASK: ${this.taskText}\n\n` +
          `STATUS: DONE\n\n` +
          `PROOF JSON: ${this.proofJsonPath || "(none)"}\n\n` +
          `OUTPUT (full):\n${answerText || "(none)"}`;

        this.lastReport = report;
        this._send("jarvis:report", { ts: Date.now(), report });
        return;
      } catch (e) {
        if (this.stopRequested) {
          this.running = false;
          this.paused = false;
          this._setState();
          this._showStopReport(this.error || "STOP requested by user.");
          return;
        }
        this.error = e && e.message ? e.message : "EXCEPTION";
        this.nextAction = "Retry. If it persists, check network/firewall and API key.";
        this.running = false;
        this.paused = false;
        this._setState();
        this._showStopReport(this.error);
      }
    })();

    return { ok: true };
  },

  pause() {
    if (!this.running) return { ok: false, error: "NOT_RUNNING" };
    this.paused = true;
    this._log("PAUSE requested (note: API call cannot be paused in V1).");
    this._setState();
    return { ok: true };
  },

  resume() {
    if (!this.running) return { ok: false, error: "NOT_RUNNING" };
    this.paused = false;
    this._log("RESUME requested.");
    this._setState();
    return { ok: true };
  },

  stop(reason) {
    this.stopRequested = true;
    this.error = this.error || (reason || "STOP pressed by user.");
    this.nextAction = this.nextAction || "If you want me to proceed, re-run with explicit authorization where needed.";

    if (!this.running) {
      this._log("STOP (no active run).");
      this._showStopReport(this.error);
      this._setState();
      return { ok: true };
    }

    this._log("STOP requested. If an API call is running, it will finish then be ignored.");
    this.running = false;
    this.paused = false;
    this._setState();
    this._showStopReport(this.error);
    return { ok: true };
  },

  state() {
    return {
      running: this.running,
      paused: this.paused,
      taskText: this.taskText,
      stepsCount: this.steps.length,
      proofJsonPath: this.proofJsonPath,
      autopilotArmed,
      hotkey: registeredHotkey || "",
      manualOverride,
    };
  },
};

// -------------------- Window / Tray --------------------
function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));

  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  return win;
}

function showDiagnostics() {
  try {
    const cfg = loadCfg();
    const rp = readRunnerPerms();
    const msg =
      `AUTOPILOT:\n` +
      `- armed: ${autopilotArmed}\n` +
      `- hotkey: ${registeredHotkey || "(none)"}\n` +
      `- manualOverride: ${manualOverride}\n\n` +
      `PERMISSIONS (jarvis_cfg.json):\n` +
      `${JSON.stringify(cfg.permissions || {}, null, 2)}\n\n` +
      `RUNNER FLAGS (jarvis_permissions.json):\n` +
      `${JSON.stringify(rp || {}, null, 2)}\n`;

    auditEvent("DIAGNOSTICS_OPENED", { autopilotArmed, hotkey: registeredHotkey || "", manualOverride: !!manualOverride });

    dialog.showMessageBox(win || null, {
      type: "info",
      title: "JARVIS - Diagnostics",
      message: "Status + permissions",
      detail: msg,
    });
  } catch (_) {}
}

function setupTray() {
  tray = new Tray(path.join(__dirname, "tray.png"));
  tray.setToolTip("JARVIS");

  const menu = Menu.buildFromTemplate([
    {
      label: "ARM AUTOPILOT (OS CONTROL)",
      click: async () => {
        const r = await permRequest("os_control", "Enable global hotkey + dead-man switch.");
        if (!r.ok || r.decision !== "allow") {
          runner._log("AUTOPILOT_ARM denied by permission.");
          return;
        }
        setAutopilotArmed(true, "tray_arm");
        runner._log("AUTOPILOT ARMED. Space or human mouse move -> takeover+pause.");
      },
    },
    {
      label: "DISARM AUTOPILOT",
      click: () => {
        setAutopilotArmed(false, "tray_disarm");
        runner._log("AUTOPILOT DISARMED.");
      },
    },
    { type: "separator" },
    { label: "DIAGNOSTICS", click: () => showDiagnostics() },
    { type: "separator" },
    { label: "PAUSE", click: () => { if (runner.running && !runner.paused) runner.pause(); else if (runner.running && runner.paused) runner.resume(); } },
    { label: "STOP", click: () => runner.stop("STOP pressed from tray.") },
    { type: "separator" },
    {
      label: "OPEN",
      click: () => {
        if (win) { win.show(); win.focus(); }
      },
    },
    {
      label: "QUIT (only if you really want)",
      click: () => {
        isQuitting = true;
        try { globalShortcut.unregisterAll(); } catch (_) {}
        app.quit();
      }
    },
  ]);

  tray.setContextMenu(menu);

  tray.on("click", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// -------------------- App lifecycle --------------------
app.whenReady().then(() => {
  app.setAppUserModelId("JARVIS");
  createWindow();
  setupTray();
  auditEvent("APP_READY", {});
});

app.on("before-quit", () => {
  isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch (_) {}
});

app.on("window-all-closed", (e) => {
  if (e && typeof e.preventDefault === "function") e.preventDefault();
});

// -------------------- IPC --------------------
ipcMain.handle("jarvis:setApiKey", (_e, payload) => {
  const apiKey = payload && payload.apiKey ? payload.apiKey : "";
  return setStoredApiKey(apiKey);
});
ipcMain.handle("jarvis:hasApiKey", () => {
  return { ok: true, has: hasStoredApiKey(), encryption: canEncryptApiKey() };
});


ipcMain.handle("jarvis:start", (_e, payload) => {
  const taskText = payload && payload.taskText ? payload.taskText : "";
  const apiKey = payload && payload.apiKey ? payload.apiKey : "";
  const history = payload && Array.isArray(payload.history) ? payload.history : [];
  const rulesText = payload && typeof payload.rulesText === "string" ? payload.rulesText : "";
  return runner.start(taskText, apiKey, history, rulesText);
});
ipcMain.handle("jarvis:pause", () => runner.pause());
ipcMain.handle("jarvis:resume", () => runner.resume());
ipcMain.handle("jarvis:stop", (_e, reason) => runner.stop(reason));
ipcMain.handle("jarvis:state", () => runner.state());

// Autopilot controls (optional future use)
ipcMain.handle("jarvis:autopilot:arm", async (_e, why) => {
  const r = await permRequest("os_control", why || "IPC request");
  if (!r.ok || r.decision !== "allow") return { ok: true, armed: false, denied: true };
  setAutopilotArmed(true, why || "ipc_arm");
  return { ok: true, armed: true, hotkey: registeredHotkey || "" };
});
ipcMain.handle("jarvis:autopilot:disarm", async (_e, why) => {
  setAutopilotArmed(false, why || "ipc_disarm");
  return { ok: true, armed: false };
});
ipcMain.handle("jarvis:autopilot:injected", async (_e, ms) => {
  setInjectedIgnoreWindow(ms);
  return { ok: true };
});

// Generic permission request (so other modules can ask you later)
ipcMain.handle("jarvis:perm:request", async (_e, className, why) => {
  return permRequest(className, why || "");
});
