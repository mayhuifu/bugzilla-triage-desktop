import { Sparkles } from "lucide-react";

export function Logo({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-accent to-fuchsia-600 flex items-center justify-center shadow-[0_0_20px_-2px_rgba(59,130,246,0.5)]">
          <Sparkles className="w-5 h-5 text-white" strokeWidth={2.5} />
        </div>
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold text-slate-100">Bugzilla AI Triage</div>
        <div className="text-[11px] text-slate-500">{subtitle || "5G RedCap · 4G LTE Engineering Support"}</div>
      </div>
    </div>
  );
}
