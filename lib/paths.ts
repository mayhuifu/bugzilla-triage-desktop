// lib/paths.ts — OS-appropriate per-user app-data directory. A pure path helper,
// deliberately FREE of the `server-only` marker that lib/settings.ts carries, so
// it can be imported from dev/CLI scripts (e.g. the users self-check) and any
// runtime. lib/settings.ts re-exports `appDataDir` for backward compatibility.
import * as os from "node:os";
import * as path from "node:path";

export const APP_DIR_NAME = "bugzilla-triage-desktop";

/** OS-appropriate per-user app-data directory. Mirrors the convention
 *  Electron's `app.getPath("userData")` produces, so files written by the
 *  hosted server / scripts land where the desktop app would find them too. */
export function appDataDir(): string {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, APP_DIR_NAME);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_DIR_NAME);
  }
  // Linux & friends — XDG_CONFIG_HOME or ~/.config
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdg, APP_DIR_NAME);
}
