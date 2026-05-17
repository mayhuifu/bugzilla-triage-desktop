"use client";

import { ReactNode } from "react";
import { Sparkles, User, Settings, AlertOctagon, CheckCircle2, Send } from "lucide-react";

export type ChatRole = "system" | "ai" | "user" | "success" | "error";

interface ChatBubbleProps {
  role: ChatRole;
  time?: string;
  title?: string;
  subtitle?: string;
  children?: ReactNode;
  highlight?: boolean;   // pulsing border for "live" / current
}

const ROLE_CFG: Record<ChatRole, { icon: typeof Sparkles; iconClass: string; align: "left" | "right" | "center"; bubble: string }> = {
  system: { icon: Settings, iconClass: "text-slate-400", align: "center", bubble: "bg-bg-panel/50 border-bg-border/50" },
  ai: { icon: Sparkles, iconClass: "text-fuchsia-400", align: "left", bubble: "bg-bg-card border-fuchsia-500/20" },
  user: { icon: User, iconClass: "text-accent-glow", align: "right", bubble: "bg-accent/15 border-accent/30" },
  success: { icon: CheckCircle2, iconClass: "text-emerald-400", align: "left", bubble: "bg-emerald-500/5 border-emerald-500/30" },
  error: { icon: AlertOctagon, iconClass: "text-red-400", align: "left", bubble: "bg-red-500/5 border-red-500/30" },
};

export function ChatBubble({ role, time, title, subtitle, children, highlight }: ChatBubbleProps) {
  const cfg = ROLE_CFG[role];
  const Icon = cfg.icon;

  if (role === "system") {
    return (
      <div className="flex items-center gap-2 py-1 text-[11px] text-slate-500 animate-fade-in">
        <div className="flex-1 h-px bg-bg-border/60" />
        <Icon className={`w-3 h-3 ${cfg.iconClass}`} />
        <span>{title || children}</span>
        <div className="flex-1 h-px bg-bg-border/60" />
      </div>
    );
  }

  return (
    <div className={`flex gap-2 animate-slide-up ${role === "user" ? "flex-row-reverse" : ""}`}>
      <div className={`w-7 h-7 rounded-md shrink-0 flex items-center justify-center
        ${role === "ai" ? "bg-gradient-to-br from-fuchsia-500 to-accent" :
          role === "user" ? "bg-accent/20 border border-accent/40" :
          role === "success" ? "bg-emerald-500/20 border border-emerald-500/40" :
          role === "error" ? "bg-red-500/20 border border-red-500/40" : ""}`}>
        <Icon className={`w-3.5 h-3.5 ${role === "ai" ? "text-white" : cfg.iconClass}`} strokeWidth={2.4} />
      </div>
      <div className={`flex-1 min-w-0 max-w-[92%] ${role === "user" ? "items-end" : ""}`}>
        <div className={`text-[10px] mb-0.5 ${role === "user" ? "text-right" : ""}`}>
          <span className={`${cfg.iconClass} font-medium uppercase tracking-wider`}>
            {role === "ai" ? "AI Triage" :
             role === "user" ? "You" :
             role === "success" ? "Posted to Bugzilla" :
             role === "error" ? "Error" : ""}
          </span>
          {time && <span className="text-slate-600 ml-2">{time}</span>}
        </div>
        <div className={`rounded-xl border px-3.5 py-2.5 ${cfg.bubble}
          ${highlight ? "shadow-[0_0_20px_-4px_rgba(168,85,247,0.4)] ring-1 ring-fuchsia-500/30" : ""}`}>
          {title && <div className="text-sm font-semibold text-slate-100 mb-1.5">{title}</div>}
          {subtitle && <div className="text-[11px] text-slate-500 -mt-1 mb-2">{subtitle}</div>}
          <div className="text-sm text-slate-300 leading-relaxed">{children}</div>
        </div>
      </div>
    </div>
  );
}
