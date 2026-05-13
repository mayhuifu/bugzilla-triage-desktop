"use client";

import { useState } from "react";
import {
  Sparkles, RefreshCw, ShieldCheck, Send, AlertTriangle, ChevronDown, ChevronRight,
  Lightbulb, AlertOctagon, ListChecks, Users, MessageCircleQuestion, Loader2, Lock, CheckCircle2,
} from "lucide-react";
import type { TriageResult, TicketStatus, SubmissionReceipt } from "@/lib/types";
import { ConfidenceBadge } from "@/components/ui/Badge";
import { pushToast } from "@/components/ui/Toast";
import { EditableField, EditableTextarea } from "@/components/triage/EditableField";

interface TriagePanelProps {
  ticketId: number;
  ticketStatus: TicketStatus;
  autotriage?: boolean;
}

export function TriagePanel({ ticketId, ticketStatus, autotriage }: TriagePanelProps) {
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [followupText, setFollowupText] = useState("");
  const [followupLoading, setFollowupLoading] = useState(false);
  const [approved, setApproved] = useState(false);
  const [transitionTo, setTransitionTo] = useState<TicketStatus>("IN_ANALYSIS");
  const [isPrivate, setIsPrivate] = useState(false);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);

  // Auto-run triage if requested
  useState(() => {
    if (autotriage) setTimeout(runTriage, 100);
  });

  async function runTriage() {
    setLoading(true);
    setApproved(false);
    setReceipt(null);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/triage`, { method: "POST" });
      const data = await res.json();
      if (data.triage) {
        setTriage(data.triage);
        pushToast("info", "AI triage drafted", "Review and edit before submitting to Bugzilla.");
      } else {
        pushToast("error", "Triage failed", data.error);
      }
    } catch (err) {
      pushToast("error", "Triage failed", err instanceof Error ? err.message : "unknown");
    } finally {
      setLoading(false);
    }
  }

  async function runFollowup() {
    if (!followupText.trim()) return;
    setFollowupLoading(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/triage/followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: followupText }),
      });
      const data = await res.json();
      if (data.triage) {
        setTriage(data.triage);
        setFollowupText("");
        setApproved(false);
        pushToast("info", "Triage refined", "Reviewed with your follow-up instruction.");
      }
    } catch (err) {
      pushToast("error", "Follow-up failed", err instanceof Error ? err.message : "unknown");
    } finally {
      setFollowupLoading(false);
    }
  }

  async function submit() {
    if (!triage || !approved) return;
    setSubmitting(true);
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
        pushToast("success", "Submitted to Bugzilla", `Comment #${data.commentId} posted via MCP.`);
      } else {
        pushToast("error", "Submission failed", data.message);
      }
    } catch (err) {
      pushToast("error", "Submission failed", err instanceof Error ? err.message : "unknown");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Action header */}
      <div className="glass rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-accent to-fuchsia-600 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-slate-100">AI Triage</div>
            <div className="text-[11px] text-slate-500">Draft analysis · human approval required</div>
          </div>
          {triage && <ConfidenceBadge confidence={triage.confidence} />}
        </div>

        {!triage && !loading && (
          <div className="space-y-3">
            <p className="text-xs text-slate-400 leading-relaxed">
              Generate a structured triage draft using ticket context, attachments, and 3GPP domain knowledge.
              Every field is editable before submission. Nothing posts to Bugzilla until you approve.
            </p>
            <button onClick={runTriage} className="btn-primary w-full justify-center">
              <Sparkles className="w-4 h-4" />
              Run AI Triage
            </button>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-3 p-3 bg-bg-panel/60 rounded-lg">
            <Loader2 className="w-4 h-4 animate-spin text-accent" />
            <div className="text-sm text-slate-300">Classifying domain, building hypothesis tree…</div>
          </div>
        )}

        {triage && (
          <div className="space-y-2">
            <div className="text-[11px] text-slate-500">
              Generated {new Date(triage.generatedAt).toLocaleTimeString()} · model <span className="font-mono text-slate-400">{triage.model}</span>
            </div>
            <button onClick={runTriage} disabled={loading} className="btn-secondary w-full justify-center text-xs">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              Re-run triage
            </button>
          </div>
        )}
      </div>

      {/* Editable triage content */}
      {triage && (
        <>
          <Section icon={<Sparkles className="w-4 h-4 text-accent" />} title="Issue summary">
            <EditableTextarea
              value={triage.issueSummary}
              onChange={v => setTriage({ ...triage, issueSummary: v })}
              rows={3}
            />
            <FieldNote>Domain: <span className="text-slate-300">{triage.domain}</span></FieldNote>
            {triage.specReferences.length > 0 && (
              <FieldNote>Specs: <span className="text-slate-300">{triage.specReferences.join("; ")}</span></FieldNote>
            )}
          </Section>

          <Section icon={<Lightbulb className="w-4 h-4 text-amber-400" />} title={`Likely root causes (${triage.rootCauses.length})`}>
            <div className="space-y-2">
              {triage.rootCauses.map((rc, i) => (
                <div key={i} className="bg-bg-panel/40 rounded-lg p-3 border border-bg-border/40">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="text-xs font-medium text-slate-300">H{rc.rank}</div>
                    <span className={`badge text-[10px] ${
                      rc.likelihood === "high" ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30" :
                      rc.likelihood === "medium" ? "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30" :
                      "bg-slate-500/15 text-slate-400 ring-1 ring-slate-500/30"
                    }`}>{rc.likelihood} likelihood</span>
                  </div>
                  <EditableField
                    value={rc.label}
                    onChange={v => {
                      const next = [...triage.rootCauses];
                      next[i] = { ...rc, label: v };
                      setTriage({ ...triage, rootCauses: next });
                    }}
                  />
                  <EditableTextarea
                    value={rc.rationale}
                    onChange={v => {
                      const next = [...triage.rootCauses];
                      next[i] = { ...rc, rationale: v };
                      setTriage({ ...triage, rootCauses: next });
                    }}
                    rows={2}
                    placeholder="Rationale…"
                    className="text-xs text-slate-400 mt-1"
                  />
                </div>
              ))}
            </div>
          </Section>

          {triage.missingInformation.length > 0 && (
            <Section icon={<MessageCircleQuestion className="w-4 h-4 text-amber-400" />} title="Missing information">
              <ul className="space-y-1.5">
                {triage.missingInformation.map((m, i) => (
                  <li key={i} className="flex gap-2 text-xs text-slate-300">
                    <span className="text-amber-400 mt-1">•</span>
                    <span>{m}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section icon={<ListChecks className="w-4 h-4 text-cyan-400" />} title="Recommended next steps">
            <div className="space-y-2">
              {triage.nextSteps.map((step, i) => (
                <div key={i} className="bg-bg-panel/40 rounded-lg p-3 border border-bg-border/40">
                  <div className="flex items-center gap-2 mb-1.5 text-[11px]">
                    <Users className="w-3 h-3 text-slate-500" />
                    <span className="text-slate-400">Owner:</span>
                    <EditableField
                      value={step.owner}
                      onChange={v => {
                        const next = [...triage.nextSteps];
                        next[i] = { ...step, owner: v };
                        setTriage({ ...triage, nextSteps: next });
                      }}
                      className="font-mono text-slate-200"
                    />
                  </div>
                  <EditableTextarea
                    value={step.action}
                    onChange={v => {
                      const next = [...triage.nextSteps];
                      next[i] = { ...step, action: v };
                      setTriage({ ...triage, nextSteps: next });
                    }}
                    rows={2}
                    className="text-xs text-slate-300"
                  />
                  <div className="text-[10px] text-slate-500 mt-1.5">Pass/Fail criterion:</div>
                  <EditableTextarea
                    value={step.passFail}
                    onChange={v => {
                      const next = [...triage.nextSteps];
                      next[i] = { ...step, passFail: v };
                      setTriage({ ...triage, nextSteps: next });
                    }}
                    rows={2}
                    className="text-xs text-slate-400 italic"
                  />
                </div>
              ))}
            </div>
          </Section>

          <Section icon={<AlertOctagon className="w-4 h-4 text-orange-400" />} title="Escalation / Dispatch">
            <EditableTextarea
              value={triage.escalationRecommendation}
              onChange={v => setTriage({ ...triage, escalationRecommendation: v })}
              rows={2}
            />
          </Section>

          <CollapsibleSection title="Internal engineer summary">
            <EditableTextarea
              value={triage.internalSummary}
              onChange={v => setTriage({ ...triage, internalSummary: v })}
              rows={4}
            />
          </CollapsibleSection>

          <CollapsibleSection title="Customer-safe summary">
            <EditableTextarea
              value={triage.customerSummary}
              onChange={v => setTriage({ ...triage, customerSummary: v })}
              rows={4}
            />
            <FieldNote>Sanitized for external sharing — no internal handles, no chip codenames.</FieldNote>
          </CollapsibleSection>

          <Section icon={<Send className="w-4 h-4 text-emerald-400" />} title="Bugzilla comment draft" defaultExpanded>
            <EditableTextarea
              value={triage.bugzillaComment}
              onChange={v => setTriage({ ...triage, bugzillaComment: v })}
              rows={12}
              className="font-mono text-xs"
            />
            <FieldNote>This exact text will be posted to Bugzilla. Prefixed with <span className="text-fuchsia-400">&quot;Analyzed by Claude:&quot;</span> automatically.</FieldNote>
          </Section>

          {/* Follow-up instructions */}
          <Section icon={<MessageCircleQuestion className="w-4 h-4 text-slate-400" />} title="Refine with follow-up instruction">
            <textarea
              className="input min-h-[60px] resize-none text-xs"
              placeholder="e.g., 'focus on thermal corner' or 'consider the RFIC ESD path'…"
              value={followupText}
              onChange={e => setFollowupText(e.target.value)}
            />
            <button
              onClick={runFollowup}
              disabled={!followupText.trim() || followupLoading}
              className="btn-secondary w-full justify-center mt-2 text-xs"
            >
              {followupLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {followupLoading ? "Refining…" : "Refine triage"}
            </button>
          </Section>

          {/* Approval bar */}
          <ApprovalBar
            approved={approved}
            onApprove={setApproved}
            transitionTo={transitionTo}
            onTransitionChange={setTransitionTo}
            isPrivate={isPrivate}
            onPrivacyChange={setIsPrivate}
            currentStatus={ticketStatus}
            submitting={submitting}
            onSubmit={submit}
            receipt={receipt}
          />
        </>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────

function Section({
  icon, title, children, defaultExpanded = true,
}: { icon: React.ReactNode; title: string; children: React.ReactNode; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center gap-2 hover:bg-bg-hover/40 transition-colors"
      >
        {icon}
        <div className="text-sm font-medium text-slate-200 flex-1 text-left">{title}</div>
        {expanded ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
      </button>
      {expanded && <div className="px-4 pb-4 space-y-2 animate-fade-in">{children}</div>}
    </div>
  );
}

function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <Section icon={<Sparkles className="w-4 h-4 text-slate-500" />} title={title} defaultExpanded={false}>{children}</Section>;
}

function FieldNote({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] text-slate-500 italic mt-1">{children}</div>;
}

// ─── Approval Bar ────────────────────────────────────────────

interface ApprovalBarProps {
  approved: boolean;
  onApprove: (v: boolean) => void;
  transitionTo: TicketStatus;
  onTransitionChange: (s: TicketStatus) => void;
  isPrivate: boolean;
  onPrivacyChange: (v: boolean) => void;
  currentStatus: TicketStatus;
  submitting: boolean;
  onSubmit: () => void;
  receipt: SubmissionReceipt | null;
}

function ApprovalBar(props: ApprovalBarProps) {
  if (props.receipt?.success) {
    return (
      <div className="card border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3 animate-slide-up">
        <div className="flex items-center gap-2 text-emerald-300">
          <CheckCircle2 className="w-5 h-5" />
          <div className="font-semibold">Submitted to Bugzilla via MCP</div>
        </div>
        <div className="text-xs text-slate-300 space-y-1 font-mono">
          <div>Ticket: <span className="text-slate-100">#{props.receipt.ticketId}</span></div>
          <div>Comment ID: <span className="text-slate-100">#{props.receipt.commentId}</span></div>
          {props.receipt.newStatus && <div>Status transitioned to: <span className="text-emerald-300">{props.receipt.newStatus}</span></div>}
          <div>Posted at: <span className="text-slate-300">{new Date(props.receipt.postedAt).toLocaleString()}</span></div>
        </div>
        <div className="text-[11px] text-slate-500">{props.receipt.message}</div>
      </div>
    );
  }

  return (
    <div className="card border-accent/30 p-4 space-y-3 sticky bottom-4 shadow-2xl">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="text-xs text-slate-300 leading-relaxed">
          <span className="text-amber-300 font-medium">AI draft requires human approval.</span>{" "}
          Review every section above. Posted text will appear on the live Bugzilla ticket with your account.
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Transition status to</div>
          <select
            value={props.transitionTo}
            onChange={e => props.onTransitionChange(e.target.value as TicketStatus)}
            className="input text-xs"
          >
            <option value={props.currentStatus}>{props.currentStatus} (no change)</option>
            <option value="IN_ANALYSIS">IN_ANALYSIS</option>
            <option value="IN_PROGRESS">IN_PROGRESS</option>
            <option value="WAITING_FOR_INFO">WAITING_FOR_INFO</option>
            <option value="ANALYZED">ANALYZED</option>
          </select>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Visibility</div>
          <button
            onClick={() => props.onPrivacyChange(!props.isPrivate)}
            className={`input flex items-center justify-center gap-2 text-xs ${props.isPrivate ? "text-amber-300" : "text-slate-300"}`}
          >
            <Lock className="w-3 h-3" />
            {props.isPrivate ? "Private comment" : "Public comment"}
          </button>
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none p-2 rounded-md bg-bg-panel/60 hover:bg-bg-panel">
        <input
          type="checkbox"
          checked={props.approved}
          onChange={e => props.onApprove(e.target.checked)}
          className="w-4 h-4 accent-emerald-500"
        />
        <ShieldCheck className={`w-4 h-4 ${props.approved ? "text-emerald-400" : "text-slate-500"}`} />
        <span className="text-sm text-slate-200">
          I have reviewed and approve this analysis for posting
        </span>
      </label>

      <button
        onClick={props.onSubmit}
        disabled={!props.approved || props.submitting}
        className="btn-success w-full justify-center"
      >
        {props.submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        {props.submitting ? "Posting to Bugzilla…" : "Submit to Bugzilla via MCP"}
      </button>

      {props.receipt && !props.receipt.success && (
        <div className="text-xs text-red-400 mt-2">{props.receipt.message}</div>
      )}
    </div>
  );
}
