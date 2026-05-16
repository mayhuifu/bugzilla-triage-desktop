"use client";

// ──────────────────────────────────────────────────────────────────
// Theme manager (added in v0.1.4).
//
// Mounted once at the root via app/layout.tsx. Responsibilities:
//
//   1. On mount, read the user's themeMode from /api/settings (which
//      persists in settings.json so the choice survives restarts).
//   2. Compute the effective theme — "light" or "dark" — by either
//      taking the explicit setting or, when set to "system", reading
//      the OS preference via matchMedia.
//   3. Apply or remove the `dark` class on <html> accordingly.
//   4. When themeMode === "system", subscribe to matchMedia changes so
//      the app re-skins live if the user toggles their OS appearance
//      without restarting.
//   5. Subscribe to a custom 'bugzilla-theme-changed' window event so
//      the Settings page can update the theme immediately on save
//      (otherwise the change wouldn't show until the user reloaded).
//   6. Mirror the chosen mode into localStorage so a no-FOUC inline
//      script in app/layout.tsx can pick the right class on first paint
//      next time. (We never trust localStorage to mutate state; it's a
//      cache only. settings.json is the source of truth.)
//
// Renders nothing.
// ──────────────────────────────────────────────────────────────────

import { useEffect } from "react";

type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "bugzilla-triage-theme-mode";

function applyTheme(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const wantsDark =
    mode === "dark" ||
    (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", wantsDark);
}

export function ThemeManager() {
  useEffect(() => {
    let mediaCleanup: (() => void) | undefined;
    let currentMode: ThemeMode = "system";

    // Apply whatever the inline script already picked, then re-pick once
    // we've fetched the canonical value from settings.json. The settings
    // call is fast on localhost but we still want to avoid a flash, so we
    // start from the localStorage cache the inline script already used.
    const cached = (typeof localStorage !== "undefined"
      ? (localStorage.getItem(STORAGE_KEY) as ThemeMode | null)
      : null) || "system";
    applyTheme(cached);
    currentMode = cached;

    const subscribe = (mode: ThemeMode) => {
      currentMode = mode;
      applyTheme(mode);
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch { /* private mode etc. — ignore */ }

      // Refresh the media-query subscription so "system" tracks live and
      // "light"/"dark" doesn't waste a listener.
      mediaCleanup?.();
      mediaCleanup = undefined;
      if (mode === "system") {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => applyTheme("system");
        mq.addEventListener("change", onChange);
        mediaCleanup = () => mq.removeEventListener("change", onChange);
      }
    };

    // Pull the canonical themeMode from the server.
    fetch("/api/settings")
      .then(r => r.ok ? r.json() : null)
      .then((v: { themeMode?: ThemeMode } | null) => {
        if (v?.themeMode && v.themeMode !== currentMode) subscribe(v.themeMode);
        else subscribe(currentMode);
      })
      .catch(() => subscribe(currentMode));

    // Settings page dispatches this after a successful save so the new
    // mode applies instantly without a reload.
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<{ themeMode?: ThemeMode }>).detail;
      if (detail?.themeMode) subscribe(detail.themeMode);
    };
    window.addEventListener("bugzilla-theme-changed", onCustom);

    return () => {
      window.removeEventListener("bugzilla-theme-changed", onCustom);
      mediaCleanup?.();
    };
  }, []);

  return null;
}
