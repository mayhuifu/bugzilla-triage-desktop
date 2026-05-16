import type { Metadata } from "next";
import "./globals.css";
import { ToastContainer } from "@/components/ui/Toast";
import { ThemeManager } from "@/components/theme/ThemeManager";

export const metadata: Metadata = {
  title: "Bugzilla AI Triage Dashboard",
  description: "AI-assisted bug triage workflow with human approval and Bugzilla integration via MCP.",
};

// No-FOUC theme bootstrap. Runs synchronously BEFORE React hydrates and
// picks light vs. dark from (priority order):
//   1. localStorage["bugzilla-triage-theme-mode"] — cached from a previous
//      ThemeManager run; present on every visit after the first.
//   2. window.matchMedia("(prefers-color-scheme: dark)") — OS preference.
//   3. Default: dark, matching v0.1.x heritage.
// ThemeManager (mounted in <body>) then re-applies based on the canonical
// settings.json value, but in the common case this guess matches and there
// is no flicker.
const themeBootstrap = `
(function() {
  try {
    var mode = localStorage.getItem('bugzilla-triage-theme-mode') || 'system';
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var wantsDark = mode === 'dark' || (mode === 'system' && prefersDark);
    if (wantsDark) document.documentElement.classList.add('dark');
  } catch (_e) {
    document.documentElement.classList.add('dark');
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <ThemeManager />
        <div className="min-h-screen relative">
          {/* Decorative radial gradient. Strong on dark; muted on light so
              it doesn't muddy the page background. */}
          <div
            className="absolute inset-0 -z-10 opacity-20 dark:opacity-40 pointer-events-none"
            style={{
              backgroundImage:
                "radial-gradient(at 20% 0%, rgba(59,130,246,0.18), transparent 50%), radial-gradient(at 80% 100%, rgba(168,85,247,0.12), transparent 50%)",
            }}
          />
          {children}
          <ToastContainer />
        </div>
      </body>
    </html>
  );
}
