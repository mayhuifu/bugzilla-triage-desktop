// ─────────────────────────────────────────────────────────────────
// electron/main.cjs — desktop wrapper for the Next.js dashboard.
//
// In dev mode (ELECTRON_DEV=1, run via `npm run dev:electron`):
//   `next dev` is started separately by concurrently. This main
//   process just waits for it to be ready, then opens a window
//   pointing at http://localhost:3000.
//
// In packaged mode (production, via electron-builder in milestone 5):
//   we spawn `node .next/standalone/server.js` ourselves so the
//   installer is self-contained — no separate Node install required.
//
// Settings storage: settings.json lives in the OS user-data dir.
// We force Electron's userData path to match `lib/settings.ts`'s
// computed path so the Next.js server process and the Electron main
// process see the same file. When safeStorage is added (follow-up),
// it'll encrypt the secret fields in place at this same path.
// ─────────────────────────────────────────────────────────────────

const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

// ── Configuration ────────────────────────────────────────────────

const DEV = process.env.ELECTRON_DEV === "1";
const PORT = parseInt(process.env.PORT || "3000", 10);
const NEXT_URL = `http://localhost:${PORT}`;
const APP_NAME = "bugzilla-triage-desktop";

// Keep the Electron-side userData path aligned with lib/settings.ts's
// appDataDir(). package.json `name` controls this by default; setting it
// explicitly is belt-and-suspenders against the name diverging.
app.setName(APP_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_NAME));

// Single-instance lock — a second launch of the .exe just focuses the
// existing window rather than spinning up a second Next.js subprocess.
// Wrapping the rest of the file in an IIFE because `return` is illegal
// at module top level in CommonJS.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
  // Skip rest of file — the lifecycle handlers won't be needed.
  process.exit(0);
}

// ── Module-level state ───────────────────────────────────────────

/** @type {import("electron").BrowserWindow | null} */
let mainWindow = null;
/** @type {import("node:child_process").ChildProcess | null} */
let nextServer = null;

// ── Start the Next.js server (production-only path) ──────────────
//
// In dev mode, concurrently already started `next dev` for us — we just
// wait for it. In production we spawn the standalone server ourselves
// from inside the packaged app. electron-builder's `extraResources` will
// land the standalone build at <resources>/app/.next/standalone in
// milestone 5.
async function startNextServer() {
  if (DEV) return; // concurrently handles it

  const isPackaged = app.isPackaged;
  const appRoot = isPackaged
    ? path.join(process.resourcesPath, "app")
    : path.join(__dirname, "..");
  const serverPath = path.join(appRoot, ".next", "standalone", "server.js");

  nextServer = spawn(process.execPath, [serverPath], {
    cwd: path.join(appRoot, ".next", "standalone"),
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "production",
      // Tell our standalone Next.js process to read settings.json from
      // Electron's userData (matches what lib/settings.ts already
      // computes, but explicit avoids any platform-edge surprises).
      SETTINGS_PATH: path.join(app.getPath("userData"), "settings.json"),
      // ELECTRON_RUN_AS_NODE makes electron's own binary act as Node —
      // so the packaged app doesn't need a system Node install.
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: "inherit",
  });

  nextServer.on("error", err => {
    console.error("[electron] Next.js server failed to start:", err);
  });
  nextServer.on("exit", code => {
    console.error(`[electron] Next.js server exited with code ${code}`);
    app.quit();
  });
}

// ── Wait until the dev or prod server answers HTTP ───────────────
function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, () => resolve());
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(`Next.js never became ready at ${url}`));
        } else {
          setTimeout(attempt, 300);
        }
      });
      req.setTimeout(1000, () => req.destroy());
    };
    attempt();
  });
}

// ── Open the dashboard window ────────────────────────────────────
async function createWindow() {
  await waitForServer(NEXT_URL);

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 700,
    title: "Bugzilla AI Triage",
    backgroundColor: "#0a0a0f", // matches dashboard's dark theme so there's no white flash
    webPreferences: {
      // Web content runs sandboxed; we don't expose Node APIs to renderer.
      // The Next.js page already has everything it needs via /api routes.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open external links (e.g. Bugzilla ticket links if ever added) in
  // the user's browser instead of inside the Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(NEXT_URL)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(NEXT_URL);

  if (DEV) mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── App lifecycle ────────────────────────────────────────────────

app.on("second-instance", () => {
  // Someone tried to launch a second .exe — focus our existing window.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  try {
    await startNextServer();
    await createWindow();
  } catch (err) {
    console.error("[electron] startup failed:", err);
    app.quit();
  }
});

app.on("activate", async () => {
  // macOS dock-icon click after window was closed — re-create it.
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});

app.on("window-all-closed", () => {
  // Standard macOS behavior keeps the app alive when all windows close;
  // every other OS quits. Same convention for our packaged installer.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (nextServer && !nextServer.killed) {
    nextServer.kill();
  }
});
