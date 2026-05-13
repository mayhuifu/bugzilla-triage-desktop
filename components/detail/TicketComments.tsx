"use client";

import { MessageSquare, Lock, Sparkles } from "lucide-react";
import type { TicketComment } from "@/lib/types";

export function TicketComments({ comments }: { comments: TicketComment[] }) {
  // Skip the first comment (it's the description, already shown above)
  const conversation = comments.slice(1);

  if (conversation.length === 0) {
    return (
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <MessageSquare className="w-4 h-4 text-accent" />
          <div className="text-sm font-medium text-slate-200">Comments</div>
        </div>
        <div className="text-sm text-slate-500 italic">No conversation yet.</div>
      </div>
    );
  }

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <MessageSquare className="w-4 h-4 text-accent" />
        <div className="text-sm font-medium text-slate-200">
          Conversation <span className="text-slate-500 font-normal">({conversation.length})</span>
        </div>
      </div>
      <div className="space-y-3 max-h-[480px] overflow-y-auto pr-2">
        {conversation.map(c => {
          const isClaude = c.author.includes("claude") || c.text.startsWith("Analyzed by Claude:") || c.text.startsWith("Auto Triggered by Claude");
          return (
            <div
              key={c.id}
              className={`rounded-lg border p-3 ${isClaude ? "bg-fuchsia-500/5 border-fuchsia-500/20" : "bg-bg-panel/40 border-bg-border/40"}`}
            >
              <div className="flex items-center justify-between mb-2 text-[11px]">
                <div className="flex items-center gap-2">
                  {isClaude && <Sparkles className="w-3 h-3 text-fuchsia-400" />}
                  <span className={`font-medium ${isClaude ? "text-fuchsia-300" : "text-slate-300"}`}>
                    {isClaude ? "Claude (AI Triage)" : c.author.split("@")[0]}
                  </span>
                  {c.isPrivate && <Lock className="w-3 h-3 text-amber-400" />}
                </div>
                <span className="text-slate-600">{new Date(c.time).toLocaleString()}</span>
              </div>
              <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
                {c.text.length > 800 ? c.text.slice(0, 800) + "\n…" : c.text}
              </pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}
