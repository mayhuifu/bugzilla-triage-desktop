"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles, Send, Loader2, ShieldCheck, Lock, AlertTriangle, RefreshCw,
  ListChecks, Lightbulb, MessageCircleQuestion, AlertOctagon, FileText,
  Pencil, BookText,
} from "lucide-react";
import type { TriageResult, TicketStatus, SubmissionReceipt } from "@/lib/types";
import { ConfidenceBadge } from "@/components/ui/Badge";
import { pushToast } from "@/components/ui/Toast";
import { ChatBubble } from "@/components/triage/ChatBubble";
import { EditableField, EditableTextarea } from "@/components/triage/EditableField";
import { StepIndicator, type StepState } from "@/components/triage/StepIndicator";
import { SpecDrawer } from "@/components/triage/SpecDrawer";

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
       | "approval-card" | "manual-card" | "success-receipt" | "system"
       | "retrieval-info";
  data?: Record<string, unknown>;
  time: string;
}

/** Compact retrieval-info turn payload — what BM25 surfaced for this triage,
 *  shown after the ai-classification bubble so the user sees what the model
 *  considered before deciding which clauses (if any) to cite. */
interface RetrievedClauseSummary {
  citation: string;
  title: string;
  parentTitle: string | null;
}

/** Seed for the manual-triage flow. The submit endpoint only reads
 *  bugzillaComment, so the other fields stay empty/zero — they're never
 *  rendered in manual mode. */
function emptyManualTriage(ticketId: number): TriageResult {
  return {
    ticketId,
    generatedAt: new Date().toISOString(),
    model: "manual",
    confidence: "medium",
    domain: "",
    specReferences: [],
    specExcerpts: [],
    issueSummary: "",
    rootCauses: [],
    missingInformation: [],
    nextSteps: [],
    escalationRecommendation: "",
    internalSummary: "",
    customerSummary: "",
    bugzillaComment: "",
  };
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
  // Workflow mode: "ai" runs the LLM and produces the full structured chain;
  // "manual" drops the user straight into a comment-textarea + approve+submit
  // card with no LLM call (no API key required, no "Analyzed by AI Triage Bot"
  // prefix or label applied on submit). null = user hasn't picked yet.
  const [mode, setMode] = useState<"ai" | "manual" | null>(null);
  const autoRanRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const turnSeqRef = useRef(0);
  // SpecDrawer state: when set, the right-side drawer is open and
  // showing the clause whose citation matches this string. Null = closed.
  const [openClause, setOpenClause] = useState<string | null>(null);

  // Per-triage 3GPP RAG toggle (v0.1.7). Defaults OFF — most tickets
  // are NOT cellular-protocol bugs, and BM25 over arbitrary ticket text
  // surfaces tangential clauses that pollute the model's prompt. Users
  // explicitly opt in per triage; the choice is persisted to
  // localStorage so the next session remembers their preference.
  const RAG_PREF_KEY = "bugzilla-triage-use-rag";
  const [useRag, setUseRag] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    // Only "true" enables it — everything else (null, "false", garbage)
    // leaves RAG off.
    return window.localStorage.getItem(RAG_PREF_KEY) === "true";
  });
  // The corpus card in Settings drives the visibility of the toggle;
  // null = unknown / still polling. Hide the toggle entirely when the
  // corpus isn't installed so it doesn't suggest a non-functional
  // affordance.
  const [corpusInstalled, setCorpusInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/corpus/status").then(r => r.json()).then(d => {
      setCorpusInstalled(Boolean(d?.installed));
    }).catch(() => setCorpusInstalled(false));
  }, []);

  const persistUseRag = useCallback((v: boolean) => {
    setUseRag(v);
    try { window.localStorage.setItem(RAG_PREF_KEY, String(v)); } catch { /* private mode */ }
  }, []);

  const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function addTurn(t: Omit<ChatTurn, "id" | "time">) {
    const id = `t${++turnSeqRef.current}`;
    setTurns(prev => [...prev, { ...t, id, time: now() }]);
  }

  // Initial "ticket loaded" turn
  useEffect(() => {
    addTurn({ kind: "ticket-loaded", data: { ticketId, summary: ticketSummary } });
    addTurn({
      kind: "system",
      data: { text: "Pick AI triage or write your own analysis manually below" },
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

  // Auto-scroll only on new turns. Depending on `loading` / `followupLoading`
  // would yank the viewport whenever the spinner toggled, fighting users who
  // scrolled up to re-read an earlier section.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length]);

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
    setMode("ai");
    setLoading(true);
    setApproved(false);
    setReceipt(null);
    setTriage(null);
    // If we're switching from manual mode, drop the manual-card turn — the
    // structured AI turns will replace it once the response lands.
    setTurns(prev => prev.filter(t => t.kind !== "manual-card"));
    addTurn({ kind: "ai-thinking", data: { stage: "classifying" } });

    try {
      // ?rag=0 disables corpus retrieval+enrichment when the user has
      // flipped off the toggle for this triage. Sending the param is
      // cheap and explicit — the server defaults to enabled when absent.
      const ragQuery = useRag ? "" : "?rag=0";
      const res = await fetch(`/api/tickets/${ticketId}/triage${ragQuery}`, { method: "POST" });
      const data = await res.json();
      // Remove the "thinking" turn
      setTurns(prev => prev.filter(t => t.kind !== "ai-thinking"));
      if (data.triage) {
        applyTriageToChat(data.triage, /* refined */ false, {
          ragEnabled: Boolean(data.ragEnabled),
          retrievedClauses: Array.isArray(data.retrievedClauses)
            ? (data.retrievedClauses as RetrievedClauseSummary[])
            : [],
        });
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

  function startManual() {
    setMode("manual");
    setApproved(false);
    setReceipt(null);
    setTriage(emptyManualTriage(ticketId));
    // Reset to just the initial system turns + the manual card. Avoids
    // stale AI turns hanging around if the user ran AI first then switched.
    setTurns(prev => [
      ...prev.filter(t => t.kind === "ticket-loaded" || t.kind === "system"),
    ]);
    addTurn({ kind: "manual-card" });
  }

  function applyTriageToChat(
    t: TriageResult,
    refined: boolean,
    retrieval?: { ragEnabled: boolean; retrievedClauses: RetrievedClauseSummary[] },
  ) {
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
    // Surface what BM25 retrieved (when RAG was enabled). Shown
    // regardless of whether the model cited from the candidates — gives
    // the user transparency into the retrieval step, especially useful
    // when the model decides the candidates aren't relevant and falls
    // back to training-data citations.
    if (retrieval?.ragEnabled && retrieval.retrievedClauses.length > 0) {
      const cited = new Set((t.specReferences ?? []).map(c => c.trim()));
      addTurn({
        kind: "retrieval-info",
        data: {
          retrievedClauses: retrieval.retrievedClauses,
          citedFromRetrieved: retrieval.retrievedClauses.filter(c => cited.has(c.citation.trim())).length,
          citedTotal: t.specReferences?.length ?? 0,
        },
      });
    }
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
      const ragQuery = useRag ? "" : "?rag=0";
      const res = await fetch(`/api/tickets/${ticketId}/triage/followup${ragQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: userText }),
      });
      const data = await res.json();
      setTurns(prev => prev.filter(t => t.kind !== "ai-thinking"));
      if (data.triage) {
        applyTriageToChat(data.triage, true, {
          ragEnabled: Boolean(data.ragEnabled),
          retrievedClauses: Array.isArray(data.retrievedClauses)
            ? (data.retrievedClauses as RetrievedClauseSummary[])
            : [],
        });
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
    if (!triage.bugzillaComment.trim()) return;
    const isManual = mode === "manual";
    setSubmitting(true);
    addTurn({
      kind: "system",
      data: { text: isManual ? "Submitting manual triage to Bugzilla…" : "Submitting to Bugzilla…" },
    });
    try {
      const res = await fetch(`/api/tickets/${ticketId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comment: triage.bugzillaComment,
          isPrivate,
          transitionTo: transitionTo !== ticketStatus ? transitionTo : undefined,
          manual: isManual,
        }),
      });
      const data: SubmissionReceipt = await res.json();
      setReceipt(data);
      if (data.success) {
        addTurn({ kind: "success-receipt", data: { receipt: data } });
        pushToast(
          "success",
          isManual ? "Manual triage posted" : "AI triage posted",
          `Comment #${data.commentId} posted.`,
        );
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
            title="Initial classification"
            subtitle="Editable — included verbatim in the Bugzilla comment's CLASSIFICATION header"
          >
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <ConfidenceBadge confidence={t.confidence} />
              <span className="badge bg-bg-panel/60 ring-1 ring-bg-border text-slate-300 font-mono">
                {t.domain}
              </span>
            </div>
            <EditableTextarea value={t.issueSummary} onChange={v => updateTriage({ issueSummary: v })} rows={2} />

            {/* Spec references with optional per-clause excerpts. The
                excerpts come from the model's own knowledge of the cited
                clauses (see specExcerpts in TRIAGE_SCHEMA). The user can
                edit a summary to refine it before submission; clauses
                without an excerpt show a hint instead of an empty box. */}
            {t.specReferences.length > 0 && (
              <div className="mt-3 space-y-1.5">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">
                  Spec references ({t.specReferences.length})
                </div>
                {t.specReferences.map((ref, i) => {
                  const excerptIdx = t.specExcerpts.findIndex(e => e.clause === ref);
                  const excerpt = excerptIdx >= 0 ? t.specExcerpts[excerptIdx] : undefined;
                  // Corpus-backed excerpts (M2) carry a clauseId — that
                  // gates the "View clause" button which opens the
                  // SpecDrawer. When the corpus isn't installed or the
                  // citation isn't in it, the button is hidden.
                  const hasCorpus = !!excerpt?.clauseId;
                  // Pre-fill the editable textarea from realText (corpus)
                  // when present, falling back to the model's summary.
                  // This lets the user refine the corpus text inline
                  // before submission, while the drawer always shows
                  // the original full clause.
                  const editableText = excerpt
                    ? (excerpt.realText || excerpt.summary)
                    : "";
                  const sourceTag = excerpt?.source === "corpus" || excerpt?.source === "corpus+model"
                    ? "[corpus]"
                    : excerpt?.source === "model"
                      ? "[ai paraphrase]"
                      : null;
                  return (
                    <div key={`${t.generatedAt}-spec-${i}`} className="bg-bg-panel/40 rounded-lg p-2 border border-bg-border/40">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="text-[11px] font-mono text-slate-300 break-words flex-1 min-w-0">{ref}</div>
                        <div className="flex items-center gap-1 shrink-0">
                          {sourceTag && (
                            <span
                              className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-px rounded ${
                                excerpt?.source?.startsWith("corpus")
                                  ? "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30"
                                  : "bg-bg-hover text-slate-400 ring-1 ring-bg-border"
                              }`}
                              title={
                                excerpt?.source === "corpus+model"
                                  ? "Corpus text + model paraphrase available"
                                  : excerpt?.source === "corpus"
                                    ? "Real text from the local 3GPP Rel-17 corpus"
                                    : "Model-generated paraphrase only — no corpus match"
                              }
                            >
                              {sourceTag}
                            </span>
                          )}
                          {hasCorpus && (
                            <button
                              type="button"
                              onClick={() => setOpenClause(ref)}
                              className="text-[10px] text-accent-glow hover:underline flex items-center gap-0.5"
                              title="View full clause from the local corpus"
                            >
                              <BookText className="w-3 h-3" />
                              View clause
                            </button>
                          )}
                        </div>
                      </div>
                      {/* Show the clause title under the citation when
                          we have it from corpus enrichment. */}
                      {excerpt?.title && (
                        <div className="text-[10px] text-slate-500 mb-1 truncate" title={excerpt.title}>
                          {excerpt.title}
                          {excerpt.parentTitle && ` · ${excerpt.parentTitle}`}
                        </div>
                      )}
                      {excerpt ? (
                        <EditableTextarea
                          value={editableText}
                          onChange={v => {
                            const next = [...t.specExcerpts];
                            // Editing the textarea overwrites whichever
                            // field is currently authoritative — keep
                            // both fields in sync so submission picks up
                            // the user's intent regardless of which
                            // header-builder branch fires.
                            const field = excerpt.realText ? "realText" : "summary";
                            next[excerptIdx] = { ...excerpt, [field]: v };
                            updateTriage({ specExcerpts: next });
                          }}
                          rows={hasCorpus ? 4 : 2}
                          className="text-[11px] text-slate-400 leading-snug"
                        />
                      ) : (
                        <div className="text-[10px] text-slate-500 italic">
                          No summary provided by the model — click below to add one
                          <button
                            type="button"
                            onClick={() => {
                              updateTriage({
                                specExcerpts: [...t.specExcerpts, { clause: ref, summary: "" }],
                              });
                            }}
                            className="ml-2 text-accent-glow hover:underline not-italic"
                          >
                            + add summary
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </ChatBubble>
        );

      case "retrieval-info": {
        // Transparency turn: shows what the local 3GPP corpus surfaced
        // for this ticket via BM25. Helps the user understand WHY the
        // model cited (or didn't cite) specific clauses — especially
        // when the model decided the retrieved set wasn't relevant and
        // fell back to training-data citations.
        const candidates = (turn.data?.retrievedClauses as RetrievedClauseSummary[]) || [];
        const citedFromRetrieved = (turn.data?.citedFromRetrieved as number) ?? 0;
        const citedTotal = (turn.data?.citedTotal as number) ?? 0;
        const citedSet = new Set((triage?.specReferences ?? []).map(c => c.trim()));
        return (
          <ChatBubble
            key={turn.id} role="system" time={turn.time}
            title={`Corpus retrieval · ${candidates.length} candidate clause${candidates.length === 1 ? "" : "s"}`}
            subtitle={
              citedTotal === 0
                ? "Model didn't cite any 3GPP clauses for this ticket."
                : citedFromRetrieved === 0
                  ? `Model cited ${citedTotal} clause${citedTotal === 1 ? "" : "s"} — all from its own training-data knowledge (none of the retrieved candidates fit).`
                  : `Model cited ${citedTotal} clause${citedTotal === 1 ? "" : "s"} · ${citedFromRetrieved} from the candidates below.`
            }
          >
            <ul className="space-y-1 mt-1">
              {candidates.map((c, i) => {
                const wasCited = citedSet.has(c.citation.trim());
                return (
                  <li
                    key={`${turn.id}-cand-${i}`}
                    className={`text-[11px] flex items-start gap-2 rounded-md px-2 py-1 ${
                      wasCited
                        ? "bg-emerald-500/10 ring-1 ring-emerald-500/30"
                        : "bg-bg-panel/40 ring-1 ring-bg-border/40"
                    }`}
                  >
                    <span className={`mt-0.5 text-[10px] font-mono font-bold uppercase tracking-wider shrink-0 ${
                      wasCited ? "text-emerald-300" : "text-slate-500"
                    }`}>
                      {wasCited ? "cited" : "skip"}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="font-mono text-slate-300">{c.citation}</span>
                      {c.title && <span className="text-slate-500"> — {c.title}</span>}
                      {c.parentTitle && (
                        <span className="block text-[10px] text-slate-500 mt-0.5">within: {c.parentTitle}</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </ChatBubble>
        );
      }

      case "ai-rootcauses":
        return t && (
          <ChatBubble key={turn.id} role="ai" time={turn.time} title={`Likely root causes (${t.rootCauses.length})`} subtitle="Ranked by likelihood">
            <div className="space-y-2">
              {t.rootCauses.map((rc, i) => (
                <div key={`${t.generatedAt}-rc-${i}`} className="bg-bg-panel/40 rounded-lg p-2.5 border border-bg-border/40">
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
                <li key={`${t.generatedAt}-mi-${i}`} className="flex gap-2 text-xs text-slate-300">
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
                <div key={`${t.generatedAt}-ns-${i}`} className="bg-bg-panel/40 rounded-lg p-2.5 border border-bg-border/40">
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
            subtitle={
              `Already includes the CLASSIFICATION header (built from the section above) ` +
              `followed by OBSERVED / INFERRED / HYPOTHESIS / NEXT STEPS. ` +
              `Auto-prefixed with "Analyzed by AI Triage Bot:" on submission. ` +
              `${t.bugzillaComment.length} chars.`
            }
          >
            <EditableTextarea
              value={t.bugzillaComment}
              onChange={v => updateTriage({ bugzillaComment: v })}
              rows={12}
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

      case "manual-card":
        return triage && (
          <ChatBubble
            key={turn.id} role="user" time={turn.time}
            title="Manual triage"
            subtitle="Write your analysis. No AI is invoked; the comment is posted as-typed (no &quot;Analyzed by AI Triage Bot&quot; prefix or label)."
            highlight={!approved && !receipt}
          >
            <div className="space-y-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  Bugzilla comment
                </div>
                <EditableTextarea
                  value={triage.bugzillaComment}
                  onChange={v => updateTriage({ bugzillaComment: v })}
                  rows={12}
                  className="font-mono text-xs"
                  placeholder={
                    "OBSERVED:\n  - …\n\nINFERRED:\n  - …\n\nHYPOTHESIS:\n  H1 …\n\nNEXT STEPS:\n  - owner: …\n    action: …\n    pass/fail: …"
                  }
                />
                <div className="mt-1 text-[10px] text-slate-500 text-right">
                  {triage.bugzillaComment.length} chars
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                    Transition to
                  </div>
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
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                    Visibility
                  </div>
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
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={e => setApproved(e.target.checked)}
                  className="w-4 h-4 accent-emerald-500"
                />
                <ShieldCheck className={`w-4 h-4 ${approved ? "text-emerald-400" : "text-slate-500"}`} />
                <span className="text-xs text-slate-200">
                  I have reviewed the comment and approve posting
                </span>
              </label>

              <div className="flex gap-2">
                <button
                  onClick={submit}
                  disabled={!approved || submitting || !!receipt || !triage.bugzillaComment.trim()}
                  className="btn-success flex-1 justify-center text-sm"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {submitting ? "Posting…" : "Submit to Bugzilla"}
                </button>
                <button
                  onClick={runTriage}
                  disabled={loading || submitting || !!receipt}
                  className="btn-ghost text-xs whitespace-nowrap"
                  title="Discard the manual draft and let AI write it instead"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Use AI instead
                </button>
              </div>
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
      {/* SpecDrawer overlay — rendered at the panel root so it covers
          the right aside without disturbing the chat layout below. */}
      <SpecDrawer citation={openClause} onClose={() => setOpenClause(null)} />
      {/* Header */}
      <div className="glass rounded-xl p-3 mb-3 space-y-2 sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-accent to-fuchsia-600 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" strokeWidth={2.5} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-100">Triage Workflow</div>
            <div className="text-[10px] text-slate-500">
              {mode === "manual"
                ? "Manual mode · human-authored · no AI invoked"
                : "AI or manual · human approval required before posting"}
            </div>
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
          <div className="flex flex-col items-center gap-2 py-2">
            <div className="flex flex-wrap justify-center gap-2">
              <button
                onClick={runTriage}
                className="btn-primary text-sm shadow-[0_0_30px_-6px_rgba(168,85,247,0.4)]"
              >
                <Sparkles className="w-4 h-4" />
                Run AI Triage
              </button>
              <button
                onClick={startManual}
                className="btn-secondary text-sm"
                title="Skip the AI — write your own analysis and post directly to Bugzilla"
              >
                <Pencil className="w-4 h-4" />
                Manual Triage
              </button>
            </div>
            <div className="text-[10px] text-slate-500 text-center max-w-xs">
              <span className="text-fuchsia-300">AI</span> drafts the structured analysis ·{" "}
              <span className="text-slate-300">Manual</span> lets you type the comment yourself
            </div>
            {/* 3GPP RAG opt-in. Only shown when the corpus is installed.
                Defaults OFF; the user explicitly enables it for cellular
                tickets where the model would benefit from real spec
                citations. Choice persists via localStorage. */}
            {corpusInstalled && (
              <label
                className="mt-1 flex items-center gap-2 text-[11px] text-slate-400 cursor-pointer select-none px-2.5 py-1 rounded-md bg-bg-panel/40 border border-bg-border/40 hover:bg-bg-panel/60"
                title="When on, the AI receives candidate clauses from the local 3GPP Rel-17 corpus AND its specReferences are looked up in the corpus after triage. Leave off for non-cellular tickets."
              >
                <input
                  type="checkbox"
                  checked={useRag}
                  onChange={e => persistUseRag(e.target.checked)}
                  className="w-3.5 h-3.5 accent-accent"
                />
                <BookText className={`w-3.5 h-3.5 ${useRag ? "text-accent" : "text-slate-500"}`} />
                <span>
                  Use <span className="text-slate-200">3GPP Spec RAG</span>
                </span>
              </label>
            )}
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
            placeholder={
              mode === "manual"
                ? "Refinement is AI-only. Edit the comment directly above, or click 'Use AI instead' to switch."
                : triage
                  ? "Refine the analysis… e.g. 'focus on warm-restart path' (⌘+Enter)"
                  : "Run AI triage first, then refine with follow-up instructions here…"
            }
            disabled={!triage || followupLoading || mode === "manual"}
            rows={2}
            className="input flex-1 text-xs resize-none disabled:opacity-50"
          />
          <button
            onClick={sendFollowup}
            disabled={!followupText.trim() || followupLoading || !triage || mode === "manual"}
            className="btn-primary py-2 px-3 shrink-0"
            title="Refine (⌘+Enter)"
          >
            {followupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
        {!triage && !loading && (
          <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-slate-500">
            <AlertTriangle className="w-3 h-3 text-amber-400" />
            Nothing is written to Bugzilla until you review and approve it below.
          </div>
        )}
      </div>
    </div>
  );
}
