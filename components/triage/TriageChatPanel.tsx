"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles, Send, Loader2, ShieldCheck, Lock, AlertTriangle, RefreshCw,
  ListChecks, Lightbulb, MessageCircleQuestion, AlertOctagon, FileText,
} from "lucide-react";
import type { TriageResult, TicketStatus, SubmissionReceipt } from "@/lib/types";
import { ConfidenceBadge } from "@/components/ui/Badge";
import { pushToast } from "@/components/ui/Toast";
import { ChatBubble } from "@/components/triage/ChatBubble";
import { EditableField, EditableTextarea } from "@/components/triage/EditableField";
import { StepIndicator, type StepState } from "@/components/triage/StepIndicator";

interface Props {
  ticketId: number;
  ticketStatus: TicketStatus;
  ticketSummary: string;
  autotriage?: boolean;
}

interface ChatTurn {
  id: string;
  // Free-form payload; render decides how to display
  kind: "ticket-loaded" | "ai-thinking" | "ai-classification" | "ai-rootcauses"
       | "ai-missing-info" | "ai-next-steps" | "ai-escalation" | "ai-internal-summary"
       | "ai-customer-summary" | "ai-comment-draft" | "user-followup" | "ai-error"
       | "approval-card" | "success-receipt" | "system";
  data?: Record<string, unknown>;
  time: string;
}

export function TriageChatPanel({ ticketId, ticketStatus, ticketSummary, autotriage }: Props) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [followupText, setFollowupText] = useState("");
  const [followupLoading, setFollowupLoading] = useState(false);
  const [approved, setApproved] = useState(false);
  const [transitionTo, setTransitionTo] = useState<TicketStatus>("IN_ANALYSIS");
  const [isPrivate, setIsPrivate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);
  const autoRanRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function addTurn(t: Omit<ChatTurn, "id" | "time">) {
    setTurns(prev => [...prev, { ...t, id: `t${Date.now()}_${prev.length}`, time: now() }]);
  }

  // Initial "ticket loaded" turn
  useEffect(() => {
    addTurn({ kind: "ticket-loaded", data: { ticketId, summary: ticketSummary } });
    // Suggest triage
    addTurn({
      kind: "system",
      data: { text: "Ready to draft AI triage" },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  // Auto-run triage on entry if ?autotriage=1
  useEffect(() => {
    if (autotriage && !autoRanRef.current) {
      autoRanRef.current = true;
      setTimeout(runTriage, 300);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autotriage]);

  // Auto-scroll to bottom
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns, loading, followupLoading]);

  // ── Workflow steps ─────────────────────────────────────────────
  const steps: StepState[] = useMemo(() => [
    { step: "select", status: "done" },
    { step: "triage", status: triage ? "done" : loading ? "active" : "idle" },
    { step: "review", status: receipt ? "done" : triage ? "active" : "idle" },
    { step: "refine", status: turns.some(t => t.kind === "user-followup") ? "done" : "idle" },
    { step: "approve", status: receipt ? "done" : approved ? "active" : "idle" },
    { step: "submit", status: receipt?.success ? "done" : submitting ? "active" : "idle" },
  ], [triage, loading, receipt, turns, approved, submitting]);

  // ── Actions ────────────────────────────────────────────────────
  async function runTriage() {
    if (loading) return;
    setLoading(true);
    setApproved(false);
    setReceipt(null);
    setTriage(null);
    addTurn({ kind: "ai-thinking", data: { stage: "classifying" } });

    try {
      const res = await fetch(`/api/tickets/${ticketId}/triage`, { method: "POST" });
      const data = await res.json();
      // Remove the "thinking" turn
      setTurns(prev => prev.filter(t => t.kind !== "ai-thinking"));
      if (data.triage) {
        applyTriageToChat(data.triage, /* refined */ false);
        pushToast("info", "Triage drafted", "Review and edit before submitting.");
      } else {
        addTurn({ kind: "ai-error", data: { msg: data.error || "Unknown error" } });
        pushToast("error", "Triage failed", data.error);
      }
    } catch (err) {
      setTurns(prev => prev.filter(t => t.kind !== "ai-thinking"));
      const msg = err instanceof Error ? err.message : "unknown";
      addTurn({ kind: "ai-error", data: { msg } });
    } finally {
      setLoading(false);
    }
  }

  function applyTriageToChat(t: TriageResult, refined: boolean) {
    setTriage(t);
    // Trim chat turns that came from a previous triage run, keep ticket-loaded + user-followups
    setTurns(prev => prev.filter(turn =>
      turn.kind === "ticket-loaded" || turn.kind === "system" ||
      turn.kind === "user-followup" || turn.kind === "ai-error"
    ));

    if (refined) {
      addTurn({ kind: "system", data: { text: "Refined draft" } });
    }
    addTurn({ kind: "ai-classification", data: { triage: t } });
    addTurn({ kind: "ai-rootcauses", data: { triage: t } });
    if (t.missingInformation.length) addTurn({ kind: "ai-missing-info", data: { triage: t } });
    addTurn({ kind: "ai-next-steps", data: { triage: t } });
    addTurn({ kind: "ai-escalation", data: { triage: t } });
    addTurn({ kind: "ai-internal-summary", data: { triage: t } });
    addTurn({ kind: "ai-customer-summary", data: { triage: t } });
    addTurn({ kind: "ai-comment-draft", data: { triage: t } });
    addTurn({ kind: "approval-card" });
  }

  async function sendFollowup() {
    if (!followupText.trim() || followupLoading) return;
    const userText = followupText;
    setFollowupText("");
    addTurn({ kind: "user-followup", data: { text: userText } });
    setFollowupLoading(true);
    addTurn({ kind: "ai-thinking", data: { stage: "refining" } });

    try {
      const res = await fetch(`/api/tickets/${ticketId}/triage/followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: userText }),
      });
      const data = await res.json();
      setTurns(prev => prev.filter(t => t.kind !== "ai-thinking"));
      if (data.triage) {
        applyTriageToChat(data.triage, true);
        setApproved(false);
      } else {
        addTurn({ kind: "ai-error", data: { msg: data.error || "Unknown" } });
      }
    } catch (err) {
      setTurns(prev => prev.filter(t => t.kind !== "ai-thinking"));
      addTurn({ kind: "ai-error", data: { msg: err instanceof Error ? err.message : "unknown" } });
    } finally {
      setFollowupLoading(false);
    }
  }

  async function submit() {
    if (!triage || !approved || submitting) return;
    setSubmitting(true);
    addTurn({ kind: "system", data: { text: "Submitting to Bugzilla via MCP…" } });
    try {
      const res = await fetch(`/api/tickets/${ticketId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comment: triage.bugzillaComment,
          isPrivate,
          transitionTo: transitionTo !== ticketStatus ? transitionTo : undefined,
        }),
      });
      const data: SubmissionReceipt = await res.json();
      setReceipt(data);
      if (data.success) {
        addTurn({ kind: "success-receipt", data: { receipt: data } });
        pushToast("success", "Submitted via MCP", `Comment #${data.commentId} posted.`);
      } else {
        addTurn({ kind: "ai-error", data: { msg: data.message } });
        pushToast("error", "Submission failed", data.message);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      addTurn({ kind: "ai-error", data: { msg } });
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render helpers ─────────────────────────────────────────────
  function renderTurn(turn: ChatTurn): React.ReactNode {
    const t = triage;
    const updateTriage = (patch: Partial<TriageResult>) => setTriage(prev => prev ? { ...prev, ...patch } : prev);

    switch (turn.kind) {
      case "ticket-loaded":
        return (
          <ChatBubble role="system" key={turn.id} title={`Ticket #${ticketId} loaded`} />
        );

      case "system":
        return (
          <ChatBubble role="system" key={turn.id} title={(turn.data?.text as string) || ""} />
        );

      case "ai-thinking":
        return (
          <ChatBubble role="ai" key={turn.id} time={turn.time}>
            <div className="flex items-center gap-2 text-slate-300">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-fuchsia-400" />
              <span className="text-sm">
                {turn.data?.stage === "refining"
                  ? "Re-applying analysis with your follow-up instruction…"
                  : "Classifying domain · reading attachment context · building hypothesis tree…"}
              </span>
            </div>
          </ChatBubble>
        );

      case "ai-classification":
        return t && (
          <ChatBubble
            key={turn.id} role="ai" time={turn.time} highlight={false}
            title="Initial classification" subtitle="Editable — click any field"
          >
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <ConfidenceBadge confidence={t.confidence} />
              <span className="badge bg-bg-panel/60 ring-1 ring-bg-border text-slate-300 font-mono">
                {t.domain}
              </span>
            </div>
            <EditableTextarea value={t.issueSummary} onChange={v => updateTriage({ issueSummary: v })} rows={2} />
            {t.specReferences.length > 0 && (
              <div className="mt-2 text-[11px] text-slate-500">
                <span className="text-slate-400 font-medium">Specs:</span> {t.specReferences.join("; ")}
              </div>
            )}
          </ChatBubble>
        );

      case "ai-rootcauses":
        return t && (
          <ChatBubble key={turn.id} role="ai" time={turn.time} title={`Likely root causes (${t.rootCauses.length})`} subtitle="Ranked by likelihood">
            <div className="space-y-2">
              {t.rootCauses.map((rc, i) => (
                <div key={i} className="bg-bg-panel/40 rounded-lg p-2.5 border border-bg-border/40">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-mono text-slate-400">H{rc.rank}</span>
                    <span className={`badge text-[10px] ${
                      rc.likelihood === "high" ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30" :
                      rc.likelihood === "medium" ? "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30" :
                      "bg-slate-500/15 text-slate-400 ring-1 ring-slate-500/30"
                    }`}>{rc.likelihood}</span>
                  </div>
                  <EditableField
                    value={rc.label}
                    onChange={v => {
                      const next = [...t.rootCauses]; next[i] = { ...rc, label: v }; updateTriage({ rootCauses: next });
                    }}
                  />
                  <EditableTextarea
                    value={rc.rationale}
                    onChange={v => {
                      const next = [...t.rootCauses]; next[i] = { ...rc, rationale: v }; updateTriage({ rootCauses: next });
                    }}
                    rows={2} className="text-xs text-slate-400 mt-1"
                  />
                </div>
              ))}
            </div>
          </ChatBubble>
        );

      case "ai-missing-info":
        return t && (
          <ChatBubble key={turn.id} role="ai" time={turn.time} title="Missing information">
            <ul className="space-y-1">
              {t.missingInformation.map((m, i) => (
                <li key={i} className="flex gap-2 text-xs text-slate-300">
                  <span className="text-amber-400 mt-0.5">•</span>
                  <EditableField
                    value={m}
                    onChange={v => {
                      const next = [...t.missingInformation]; next[i] = v;
                      updateTriage({ missingInformation: next });
                    }}
                    className="flex-1 text-xs"
                  />
                </li>
              ))}
            </ul>
          </ChatBubble>
        );

      case "ai-next-steps":
        return t && (
          <ChatBubble key={turn.id} role="ai" time={turn.time} title="Recommended next steps">
            <div className="space-y-2">
              {t.nextSteps.map((step, i) => (
                <div key={i} className="bg-bg-panel/40 rounded-lg p-2.5 border border-bg-border/40">
                  <div className="flex items-center gap-2 mb-1 text-[11px]">
                    <span className="text-slate-500">Owner</span>
                    <EditableField
                      value={step.owner}
                      onChange={v => {
                        const next = [...t.nextSteps]; next[i] = { ...step, owner: v }; updateTriage({ nextSteps: next });
                      }}
                      className="font-mono text-slate-200"
                    />
                  </div>
                  <EditableTextarea
                    value={step.action}
                    onChange={v => {
                      const next = [...t.nextSteps]; next[i] = { ...step, action: v }; updateTriage({ nextSteps: next });
                    }}
                    rows={2} className="text-xs text-slate-300"
                  />
                  <div className="text-[10px] text-slate-500 mt-1">Pass/fail criterion</div>
                  <EditableTextarea
                    value={step.passFail}
                    onChange={v => {
                      const next = [...t.nextSteps]; next[i] = { ...step, passFail: v }; updateTriage({ nextSteps: next });
                    }}
                    rows={2} className="text-xs text-slate-400 italic"
                  />
                </div>
              ))}
            </div>
          </ChatBubble>
        );

      case "ai-escalation":
        return t && (
          <ChatBubble key={turn.id} role="ai" time={turn.time} title="Escalation / dispatch">
            <EditableTextarea
              value={t.escalationRecommendation}
              onChange={v => updateTriage({ escalationRecommendation: v })}
              rows={2}
            />
          </ChatBubble>
        );

      case "ai-internal-summary":
        return t && (
          <ChatBubble key={turn.id} role="ai" time={turn.time} title="Engineer-facing summary" subtitle="For internal stakeholders">
            <EditableTextarea
              value={t.internalSummary}
              onChange={v => updateTriage({ internalSummary: v })}
              rows={3}
            />
          </ChatBubble>
        );

      case "ai-customer-summary":
        return t && (
          <ChatBubble key={turn.id} role="ai" time={turn.time} title="Customer-safe summary" subtitle="Sanitized for external sharing">
            <EditableTextarea
              value={t.customerSummary}
              onChange={v => updateTriage({ customerSummary: v })}
              rows={3}
            />
          </ChatBubble>
        );

      case "ai-comment-draft":
        return t && (
          <ChatBubble key={turn.id} role="ai" time={turn.time}
            title="Bugzilla comment draft"
            subtitle={`Auto-prefixed with "Analyzed by Claude:" on submission. ${t.bugzillaComment.length} chars.`}
          >
            <EditableTextarea
              value={t.bugzillaComment}
              onChange={v => updateTriage({ bugzillaComment: v })}
              rows={10}
              className="font-mono text-xs"
            />
          </ChatBubble>
        );

      case "user-followup":
        return (
          <ChatBubble key={turn.id} role="user" time={turn.time}>
            <div className="text-sm">{(turn.data?.text as string) || ""}</div>
          </ChatBubble>
        );

      case "ai-error":
        return (
          <ChatBubble key={turn.id} role="error" time={turn.time} title="Analysis error">
            <div className="text-xs text-red-300 break-words">{(turn.data?.msg as string) || "Unknown error"}</div>
          </ChatBubble>
        );

      case "approval-card":
        return triage && (
          <ChatBubble
            key={turn.id} role="ai" time={turn.time}
            title="Ready for your approval"
            subtitle="Nothing is sent to Bugzilla until you check and confirm below."
            highlight={!approved && !receipt}
          >
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Transition to</div>
                  <select
                    value={transitionTo}
                    onChange={e => setTransitionTo(e.target.value as TicketStatus)}
                    className="input text-xs"
                  >
                    <option value={ticketStatus}>{ticketStatus} (no change)</option>
                    <option value="IN_ANALYSIS">IN_ANALYSIS</option>
                    <option value="IN_PROGRESS">IN_PROGRESS</option>
                    <option value="WAITING_FOR_INFO">WAITING_FOR_INFO</option>
                    <option value="ANALYZED">ANALYZED</option>
                  </select>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Visibility</div>
                  <button
                    onClick={() => setIsPrivate(!isPrivate)}
                    className={`input flex items-center justify-center gap-2 text-xs ${isPrivate ? "text-amber-300" : "text-slate-300"}`}
                  >
                    <Lock className="w-3 h-3" />
                    {isPrivate ? "Private" : "Public"}
                  </button>
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none p-2 rounded-md bg-bg-panel/60 hover:bg-bg-panel border border-bg-border/40">
                <input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} className="w-4 h-4 accent-emerald-500" />
                <ShieldCheck className={`w-4 h-4 ${approved ? "text-emerald-400" : "text-slate-500"}`} />
                <span className="text-xs text-slate-200">I have reviewed every section and approve this for posting</span>
              </label>

              <button
                onClick={submit}
                disabled={!approved || submitting || !!receipt}
                className="btn-success w-full justify-center text-sm"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {submitting ? "Posting via MCP…" : "Submit to Bugzilla via MCP"}
              </button>
            </div>
          </ChatBubble>
        );

      case "success-receipt":
        const r = turn.data?.receipt as SubmissionReceipt | undefined;
        return r && (
          <ChatBubble key={turn.id} role="success" time={turn.time} title="Posted via MCP">
            <div className="text-xs space-y-1 font-mono">
              <div>Ticket <span className="text-slate-100">#{r.ticketId}</span></div>
              <div>Comment ID <span className="text-slate-100">#{r.commentId}</span></div>
              {r.newStatus && <div>Status → <span className="text-emerald-300">{r.newStatus}</span></div>}
              <div className="text-slate-500">Posted at {new Date(r.postedAt).toLocaleString()}</div>
              <div className="text-[10px] text-slate-500 italic mt-1.5">{r.message}</div>
            </div>
          </ChatBubble>
        );

      default:
        return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="glass rounded-xl p-3 mb-3 space-y-2 sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-accent to-fuchsia-600 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" strokeWidth={2.5} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-100">AI Triage Workflow</div>
            <div className="text-[10px] text-slate-500">Chat-style step-by-step · human approval required</div>
          </div>
          {triage && !receipt && (
            <button onClick={runTriage} disabled={loading} className="btn-ghost text-xs py-1 px-2" title="Re-run from scratch">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          )}
        </div>
        <StepIndicator steps={steps} />
      </div>

      {/* Chat scroll */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1 pb-2 min-h-0">
        {turns.map(renderTurn)}

        {!triage && !loading && (
          <div className="flex justify-center">
            <button onClick={runTriage} className="btn-primary text-sm shadow-[0_0_30px_-6px_rgba(168,85,247,0.4)]">
              <Sparkles className="w-4 h-4" />
              Run AI Triage
            </button>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Chat input bar */}
      <div className="glass rounded-xl p-2.5 mt-3 sticky bottom-0">
        <div className="flex items-end gap-2">
          <textarea
            value={followupText}
            onChange={e => setFollowupText(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                sendFollowup();
              }
            }}
            placeholder={triage
              ? "Refine the analysis… e.g. 'focus on warm-restart path' (⌘+Enter)"
              : "Run triage first, then refine with follow-up instructions here…"}
            disabled={!triage || followupLoading}
            rows={2}
            className="input flex-1 text-xs resize-none disabled:opacity-50"
          />
          <button
            onClick={sendFollowup}
            disabled={!followupText.trim() || followupLoading || !triage}
            className="btn-primary py-2 px-3 shrink-0"
            title="Refine (⌘+Enter)"
          >
            {followupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
        {!triage && !loading && (
          <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-slate-500">
            <AlertTriangle className="w-3 h-3 text-amber-400" />
            Every AI draft is reviewed and approved by you before anything is written to Bugzilla.
          </div>
        )}
      </div>
    </div>
  );
}
