"use client";

import { useState } from "react";
import { MessageSquare, Lock, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import type { TicketComment } from "@/lib/types";

// Show this many chars of a long comment by default. The "Show more"
// button reveals the rest. Picked to comfortably fit a short paragraph
// without forcing the user to expand every short comment, while still
// keeping the panel scrollable for a long thread.
const COLLAPSE_THRESHOLD = 800;

export function TicketComments({ comments }: { comments: TicketComment[] }) {
  // Track which comments the user has explicitly expanded. Keyed by
  // comment id (not index) so adding/removing comments in the parent
  // doesn't shift the expansion state to a different row.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Skip the first comment (it's the description, already shown above)
  const conversation = comments.slice(1);

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
      <div className="space-y-3 max-h-[640px] overflow-y-auto pr-2">
        {conversation.map(c => {
          // Heuristic for "this comment was AI-authored". Matches the current
          // "Analyzed by AI Triage Bot:" prefix AND the legacy "Analyzed by
          // Claude:" / "Auto Triggered by Claude" prefixes so historical
          // tickets still render with the AI styling.
          const isAiAuthored =
            c.author.includes("claude") ||
            c.author.includes("ai-triage") ||
            c.text.startsWith("Analyzed by AI Triage Bot:") ||
            c.text.startsWith("Analyzed by Claude:") ||
            c.text.startsWith("Auto Triggered by Claude");

          const isLong = c.text.length > COLLAPSE_THRESHOLD;
          const isExpanded = expanded.has(c.id);
          // When the comment is long AND not expanded, show only the
          // first COLLAPSE_THRESHOLD characters. We try to cut at the
          // last newline within the threshold so we don't slice mid-
          // word; if there's no newline (rare for long ticket comments)
          // fall back to a hard slice.
          const displayText = (() => {
            if (!isLong || isExpanded) return c.text;
            const window = c.text.slice(0, COLLAPSE_THRESHOLD);
            const lastNL = window.lastIndexOf("\n");
            return lastNL > COLLAPSE_THRESHOLD * 0.6
              ? window.slice(0, lastNL)
              : window;
          })();

          return (
            <div
              key={c.id}
              className={`rounded-lg border p-3 ${isAiAuthored ? "bg-fuchsia-500/10 border-fuchsia-500/30" : "bg-bg-panel/40 border-bg-border/40"}`}
            >
              <div className="flex items-center justify-between mb-2 text-[11px]">
                <div className="flex items-center gap-2">
                  {isAiAuthored && <Sparkles className="w-3 h-3 text-fuchsia-400" />}
                  <span className={`font-medium ${isAiAuthored ? "text-fuchsia-300" : "text-slate-300"}`}>
                    {isAiAuthored ? "AI Triage Bot" : c.author.split("@")[0]}
                  </span>
                  {c.isPrivate && <Lock className="w-3 h-3 text-amber-400" />}
                </div>
                <span className="text-slate-600">{new Date(c.time).toLocaleString()}</span>
              </div>
              <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
                {displayText}
                {isLong && !isExpanded && (
                  <span className="text-slate-500">{"\n… (truncated, click below to read full text)"}</span>
                )}
              </pre>
              {isLong && (
                <button
                  type="button"
                  onClick={() => toggle(c.id)}
                  className={`mt-2 inline-flex items-center gap-1 text-[11px] ${
                    isAiAuthored
                      ? "text-fuchsia-300 hover:text-fuchsia-200"
                      : "text-accent-glow hover:text-accent"
                  } transition-colors`}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? (
                    <>
                      <ChevronUp className="w-3 h-3" /> Show less
                    </>
                  ) : (
                    <>
                      <ChevronDown className="w-3 h-3" /> Show full comment
                      <span className="text-slate-500">({c.text.length.toLocaleString()} chars)</span>
                    </>
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
