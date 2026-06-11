import { Sparkles } from "lucide-react";

// process.env.NEXT_PUBLIC_APP_VERSION is injected at build time by
// next.config.mjs from package.json#version, so it's always the actual
// shipped version — even in dev mode. Falls back to "?" if the env-var
// substitution somehow failed (shouldn't happen in practice).
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "?";

export function Logo({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-accent to-fuchsia-600 flex items-center justify-center shadow-[0_0_20px_-2px_rgba(59,130,246,0.5)]">
          <Sparkles className="w-5 h-5 text-white" strokeWidth={2.5} />
        </div>
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold text-slate-100 flex items-center gap-1.5">
          Zilla Copilot
          <span
            className="text-[10px] font-mono font-normal text-slate-500 bg-bg-hover/60 ring-1 ring-bg-border/50 px-1.5 py-px rounded"
            title={`Zilla Copilot v${APP_VERSION}`}
          >
            v{APP_VERSION}
          </span>
        </div>
        <div className="text-[11px] text-slate-500">{subtitle || "5G RedCap · 4G LTE Engineering Support"}</div>
      </div>
    </div>
  );
}
