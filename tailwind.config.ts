import type { Config } from "tailwindcss";

// ──────────────────────────────────────────────────────────────────
// Dual-theme color system (added in v0.1.4).
//
// Strategy: every "themeable" color reads its value from a CSS variable
// defined in app/globals.css. There are two variable sets — :root (light)
// and :root.dark (dark) — and a single ThemeManager flips the .dark class
// on <html> based on the user's saved preference (or system pref when
// the saved value is "system").
//
// Trick worth knowing: we ALSO override the built-in Tailwind `slate.*`
// scale to read from CSS vars. In light mode the variables invert the
// scale (slate.100 → near-black instead of near-white) so the hundreds
// of existing `text-slate-100`, `text-slate-300`, … usages flip
// automatically without touching any component code. The slate class
// name becomes a SEMANTIC token ("primary-ish text") rather than a
// literal color — that's the deliberate trade-off. Color codes used in
// component CSS that aren't part of the slate scale (fuchsia, emerald,
// amber, red — used for AI accents and severity badges) intentionally
// stay literal in both themes; they're tuned to read well on both light
// and dark backgrounds.
// ──────────────────────────────────────────────────────────────────

const cssVar = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // UI surfaces (page background, panels, cards, hover, borders).
        // All read from CSS vars so they swap with theme.
        bg: {
          base:   cssVar("bg-base"),
          panel:  cssVar("bg-panel"),
          card:   cssVar("bg-card"),
          hover:  cssVar("bg-hover"),
          border: cssVar("bg-border"),
        },

        // Brand blue. Different shades in light vs dark for legibility on
        // the respective backgrounds (light bg needs darker accent text).
        accent: {
          DEFAULT: cssVar("accent"),
          dim:     cssVar("accent-dim"),
          glow:    cssVar("accent-glow"),
        },

        // Severity / status — semantic colors. Same in both themes; they
        // are saturated mid-tones that read well on either background.
        severity: {
          blocker:  "#dc2626",
          critical: "#ea580c",
          major:    "#f59e0b",
          normal:   "#64748b",
          minor:    "#475569",
        },
        status: {
          new:          "#3b82f6",
          progress:     "#8b5cf6",
          analysis:     "#06b6d4",
          waiting:      "#f59e0b",
          analyzed:     "#a855f7",
          verification: "#10b981",
          resolved:     "#22c55e",
          closed:       "#64748b",
        },

        // Slate scale REDEFINED to be themeable. See the file header for
        // the reasoning — this lets existing `text-slate-100` etc. flip
        // automatically with no component edits.
        slate: {
          50:  cssVar("slate-50"),
          100: cssVar("slate-100"),
          200: cssVar("slate-200"),
          300: cssVar("slate-300"),
          400: cssVar("slate-400"),
          500: cssVar("slate-500"),
          600: cssVar("slate-600"),
          700: cssVar("slate-700"),
          800: cssVar("slate-800"),
          900: cssVar("slate-900"),
          950: cssVar("slate-950"),
        },

        // Accent palette overrides (added in v0.1.5 light-mode polish).
        // We only override the SHADES actually used in the codebase as
        // colored text on a faintly-tinted accent background — those
        // shades are tuned for dark mode and look invisible on light.
        // The CSS variables in :root flip them to deeper shades that
        // read on white; :root.dark keeps the canonical values.
        // The -950 shades exist because a handful of places use
        // `bg-red-950/20` etc. — explicit "dark surface" backgrounds
        // that need a light-mode equivalent. The override turns them
        // into `red-50` and friends so light mode gets a soft tint
        // instead of muddy dark on white.
        fuchsia: {
          300: cssVar("fuchsia-300"),
          400: cssVar("fuchsia-400"),
          700: cssVar("fuchsia-700"),
        },
        emerald: {
          300: cssVar("emerald-300"),
          400: cssVar("emerald-400"),
          700: cssVar("emerald-700"),
        },
        amber: {
          300: cssVar("amber-300"),
          400: cssVar("amber-400"),
          700: cssVar("amber-700"),
          950: cssVar("amber-950"),
        },
        red: {
          300: cssVar("red-300"),
          400: cssVar("red-400"),
          700: cssVar("red-700"),
          950: cssVar("red-950"),
        },
        blue: {
          300: cssVar("blue-300"),
          400: cssVar("blue-400"),
          700: cssVar("blue-700"),
        },
        cyan: {
          300: cssVar("cyan-300"),
          400: cssVar("cyan-400"),
          700: cssVar("cyan-700"),
        },
        purple: {
          300: cssVar("purple-300"),
          400: cssVar("purple-400"),
          700: cssVar("purple-700"),
        },
        orange: {
          300: cssVar("orange-300"),
          400: cssVar("orange-400"),
          700: cssVar("orange-700"),
        },
        teal: {
          300: cssVar("teal-300"),
          400: cssVar("teal-400"),
          700: cssVar("teal-700"),
        },
        green: {
          300: cssVar("green-300"),
          400: cssVar("green-400"),
          700: cssVar("green-700"),
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      animation: {
        "fade-in":    "fadeIn 0.2s ease-out",
        "slide-up":   "slideUp 0.3s ease-out",
        "pulse-glow": "pulseGlow 2s ease-in-out infinite",
        "shimmer":    "shimmer 2s linear infinite",
      },
      keyframes: {
        fadeIn: {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%":   { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseGlow: {
          "0%, 100%": { opacity: "1",    boxShadow: "0 0 0 0 rgba(59,130,246,0.4)" },
          "50%":      { opacity: "0.85", boxShadow: "0 0 0 8px rgba(59,130,246,0)" },
        },
        shimmer: {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
