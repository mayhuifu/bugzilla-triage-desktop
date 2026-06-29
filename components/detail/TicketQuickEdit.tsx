"use client";

// TicketQuickEdit — stage-and-save editor for a ticket's component, priority,
// assignee, CC list, and an optional comment. Collapsed to a single button by
// default; when expanded the user stages changes and clicks "Save changes",
// which commits everything in ONE atomic PATCH /api/tickets/[id] (one Bugzilla
// change-set, one audit row per field). Nothing is written until Save. On
// success the parent refetches the ticket (onSaved) and this panel re-syncs to
// the new truth and collapses.

import { useEffect, useMemo, useState } from "react";
import {
  Pencil, X, Check, Loader2, UserCog, Users, MessageSquarePlus, RotateCcw,
} from "lucide-react";
import type { TicketDetail } from "@/lib/types";
import { UserPicker } from "@/components/ui/UserPicker";

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const user = (email: string) => email.split("@")[0];

export function TicketQuickEdit({
  ticket, componentOptions, priorityOptions, onSaved,
}: {
  ticket: TicketDetail;
  componentOptions: string[];
  priorityOptions: string[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [component, setComponent] = useState(ticket.component);
  const [priority, setPriority] = useState(ticket.priority);
  const [assignee, setAssignee] = useState(ticket.assignee);
  const [ccAdd, setCcAdd] = useState<string[]>([]);
  const [ccRemove, setCcRemove] = useState<string[]>([]);
  const [comment, setComment] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Re-sync to the ticket whenever its editable fields change externally —
  // i.e. after a successful save → parent refetch. Also clears staging and
  // collapses, so the panel always reflects the live ticket.
  const sig = `${ticket.component}|${ticket.priority}|${ticket.assignee}|${ticket.cc.join(",")}`;
  useEffect(() => {
    setComponent(ticket.component);
    setPriority(ticket.priority);
    setAssignee(ticket.assignee);
    setCcAdd([]); setCcRemove([]); setComment(""); setError(null);
    setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const compOpts = useMemo(() => {
    const s = new Set(componentOptions);
    if (ticket.component) s.add(ticket.component);
    return Array.from(s).sort();
  }, [componentOptions, ticket.component]);

  const prioOpts = useMemo(() => {
    const s = new Set(priorityOptions);
    if (ticket.priority) s.add(ticket.priority);
    return Array.from(s);
  }, [priorityOptions, ticket.priority]);

  const componentChanged = component !== ticket.component;
  const priorityChanged = priority !== ticket.priority;
  const assigneeChanged = !eq(assignee, ticket.assignee);
  const dirty =
    componentChanged || priorityChanged || assigneeChanged ||
    ccAdd.length > 0 || ccRemove.length > 0 || comment.trim().length > 0;

  // ── CC staging helpers ──
  const addCc = (email: string) => {
    if (ccRemove.some(e => eq(e, email))) { setCcRemove(p => p.filter(e => !eq(e, email))); return; }
    if (ticket.cc.some(e => eq(e, email))) return;     // already on the ticket
    if (ccAdd.some(e => eq(e, email))) return;          // already staged
    setCcAdd(p => [...p, email]);
  };
  const toggleRemoveExisting = (email: string) =>
    setCcRemove(p => p.some(e => eq(e, email)) ? p.filter(e => !eq(e, email)) : [...p, email]);
  const unstageAdd = (email: string) => setCcAdd(p => p.filter(e => !eq(e, email)));

  const ccExclude = useMemo(
    () => [...ticket.cc.filter(e => !ccRemove.some(r => eq(r, e))), ...ccAdd],
    [ticket.cc, ccRemove, ccAdd],
  );

  function cancel() {
    setComponent(ticket.component); setPriority(ticket.priority); setAssignee(ticket.assignee);
    setCcAdd([]); setCcRemove([]); setComment(""); setError(null); setOpen(false);
  }

  async function save() {
    if (!dirty || saving) return;
    const body: Record<string, unknown> = {};
    if (componentChanged) body.component = component;
    if (priorityChanged) body.priority = priority;
    if (assigneeChanged) body.assignedTo = assignee;
    if (ccAdd.length) body.ccAdd = ccAdd;
    if (ccRemove.length) body.ccRemove = ccRemove;
    if (comment.trim()) body.comment = comment.trim();

    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticket.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.success === false) {
        setError(d.message || d.error || `Save failed (${res.status})`);
        setSaving(false);
        return;
      }
      const changed: string[] = Array.isArray(d.changed) ? d.changed : Object.keys(body);
      setSavedNote(`Saved: ${changed.join(", ")}`);
      setOpen(false);
      setCcAdd([]); setCcRemove([]); setComment("");
      onSaved();   // parent refetch → sig changes → panel re-syncs to truth
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <button
          onClick={() => { setOpen(true); setSavedNote(null); }}
          className="btn-secondary text-xs py-1.5 px-3"
        >
          <Pencil className="w-3.5 h-3.5" />
          Edit fields / CC / comment
        </button>
        {savedNote && (
          <span className="text-xs text-emerald-400 inline-flex items-center gap-1 animate-fade-in">
            <Check className="w-3.5 h-3.5" /> {savedNote}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="card p-4 space-y-4 ring-1 ring-accent/30 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-100 inline-flex items-center gap-2">
          <Pencil className="w-3.5 h-3.5 text-accent" /> Edit ticket #{ticket.id}
        </div>
        <button onClick={cancel} className="text-slate-500 hover:text-slate-300" title="Cancel"><X className="w-4 h-4" /></button>
      </div>

      {/* Component + Priority */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Component" changed={componentChanged}>
          <select className="input text-sm w-full" value={component} onChange={e => setComponent(e.target.value)}>
            {compOpts.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Priority" changed={priorityChanged}>
          <select className="input text-sm w-full" value={priority} onChange={e => setPriority(e.target.value)}>
            {prioOpts.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
      </div>

      {/* Assignee */}
      <Field label="Assignee" changed={assigneeChanged} icon={UserCog}>
        {assigneeChanged ? (
          <div className="flex items-center gap-2">
            <span className="badge bg-accent/15 text-accent-glow ring-1 ring-accent/40">{user(assignee)}</span>
            <span className="text-[11px] text-slate-500">(was {user(ticket.assignee)})</span>
            <button onClick={() => setAssignee(ticket.assignee)} className="text-slate-500 hover:text-slate-300 inline-flex items-center gap-1 text-[11px]">
              <RotateCcw className="w-3 h-3" /> revert
            </button>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="text-xs text-slate-400">Current: <span className="text-slate-200">{user(ticket.assignee)}</span></div>
            <UserPicker onPick={email => setAssignee(email)} placeholder="Reassign to…" excludeEmails={[assignee]} />
          </div>
        )}
      </Field>

      {/* CC */}
      <Field label="CC" icon={Users} changed={ccAdd.length > 0 || ccRemove.length > 0}>
        <div className="space-y-2">
          {(ticket.cc.length > 0 || ccAdd.length > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {ticket.cc.map(email => {
                const removing = ccRemove.some(e => eq(e, email));
                return (
                  <span key={email} className={`badge ring-1 inline-flex items-center gap-1 ${removing ? "bg-red-500/10 text-red-300 ring-red-500/30 line-through" : "bg-bg-hover/60 text-slate-300 ring-bg-border"}`}>
                    {user(email)}
                    <button onClick={() => toggleRemoveExisting(email)} title={removing ? "keep" : "remove from CC"} className="hover:text-white">
                      {removing ? <RotateCcw className="w-3 h-3" /> : <X className="w-3 h-3" />}
                    </button>
                  </span>
                );
              })}
              {ccAdd.map(email => (
                <span key={email} className="badge bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30 inline-flex items-center gap-1">
                  + {user(email)}
                  <button onClick={() => unstageAdd(email)} title="don't add" className="hover:text-white"><X className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
          )}
          <UserPicker onPick={addCc} placeholder="Add someone to CC…" excludeEmails={ccExclude} />
        </div>
      </Field>

      {/* Comment */}
      <Field label="Comment (optional)" icon={MessageSquarePlus} changed={comment.trim().length > 0}>
        <textarea
          className="input text-sm w-full min-h-[72px] resize-y"
          placeholder="Add a comment — posted as-typed (no AI prefix). Explains this change, or stands alone."
          value={comment}
          onChange={e => setComment(e.target.value)}
        />
      </Field>

      {error && <div className="text-xs text-red-400 bg-red-500/10 ring-1 ring-red-500/30 rounded px-3 py-2">{error}</div>}

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={!dirty || saving} className="btn-primary text-xs disabled:opacity-40">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button onClick={cancel} disabled={saving} className="btn-ghost text-xs">Cancel</button>
        {dirty && !saving && <span className="text-[11px] text-slate-500">Nothing is written until you save.</span>}
      </div>
    </div>
  );
}

function Field({
  label, children, changed, icon: Icon,
}: {
  label: string;
  children: React.ReactNode;
  changed?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1">
        {Icon && <Icon className="w-3 h-3" />}
        {label}
        {changed && <span className="text-accent-glow normal-case tracking-normal">· changed</span>}
      </div>
      {children}
    </div>
  );
}
