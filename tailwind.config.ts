import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#0a0e1a",
          panel: "#0f1524",
          card: "#141b2d",
          hover: "#1a2238",
          border: "#1f2940",
        },
        accent: {
          DEFAULT: "#3b82f6",
          dim: "#1e40af",
          glow: "#60a5fa",
        },
        severity: {
          blocker: "#dc2626",
          critical: "#ea580c",
          major: "#f59e0b",
          normal: "#64748b",
          minor: "#475569",
        },
        status: {
          new: "#3b82f6",
          progress: "#8b5cf6",
          analysis: "#06b6d4",
          waiting: "#f59e0b",
          analyzed: "#a855f7",
          verification: "#10b981",
          resolved: "#22c55e",
          closed: "#64748b",
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
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-up": "slideUp 0.3s ease-out",
        "pulse-glow": "pulseGlow 2s ease-in-out infinite",
        "shimmer": "shimmer 2s linear infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseGlow: {
          "0%, 100%": { opacity: "1", boxShadow: "0 0 0 0 rgba(59,130,246,0.4)" },
          "50%": { opacity: "0.85", boxShadow: "0 0 0 8px rgba(59,130,246,0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
