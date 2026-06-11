"use client";

// FileTicketDialog — modal for filing a NEW Bugzilla ticket straight from the
// dashboard ("File a Ticket" next to My Tickets). Product/component/version
// options come from the already-loaded /api/products data; the POST goes to
// /api/tickets which creates the bug AS the current user (they become the
// reporter in Bugzilla). On success we navigate to the new ticket's detail
// page so the user can keep working on it (attach files, run AI triage…).

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Send, LoaderCircle } from "lucide-react";
import type { ProductInfo } from "@/lib/types";

export function FileTicketDialog({
  open,
  onClose,
  products,
  typeOptions = [],
  defaultProduct = "",
}: {
  open: boolean;
  onClose: () => void;
  products: ProductInfo[];
  /** Legal values of the install's mandatory "Type" field (cf_type); empty
   *  when the install has no such field (select is hidden, nothing sent). */
  typeOptions?: string[];
  /** Pre-select the dashboard's current product filter when set. */
  defaultProduct?: string;
}) {
  const router = useRouter();
  const [product, setProduct] = useState(defaultProduct);
  const [component, setComponent] = useState("");
  const [version, setVersion] = useState("");
  const [type, setType] = useState("");
  const [severity, setSeverity] = useState("Normal");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form each time the dialog opens (fresh ticket, current filter).
  // Version defaults to the product's FIRST real version — not "unspecified",
  // which many installs (incl. ours: U300 has only A0/B0) don't define and
  // Bugzilla would reject.
  useEffect(() => {
    if (open) {
      const p = defaultProduct || products[0]?.name || "";
      setProduct(p);
      setComponent("");
      setVersion(products.find(x => x.name === p)?.versions?.[0] || "");
      // Change_Request is the dominant type in real tickets — sensible default.
      setType(typeOptions.includes("Change_Request") ? "Change_Request" : typeOptions[0] || "");
      setSeverity("Normal");
      setSummary("");
      setDescription("");
      setError(null);
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = useMemo(() => products.find(p => p.name === product), [products, product]);
  const versionOptions = selected?.versions ?? [];

  if (!open) return null;

  const canSubmit = !!(product && component && summary.trim() && description.trim()) && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product,
          component,
          summary: summary.trim(),
          description: description.trim(),
          version: version || undefined,
          severity,
          type: type || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) {
        setError(data.error || `Bugzilla rejected the ticket (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      onClose();
      router.push(`/tickets/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[8vh] px-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-xl p-5 space-y-4 animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">File a Ticket</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-slate-400 space-y-1">
            <span>Product *</span>
            <select
              className="input w-full"
              value={product}
              onChange={e => {
                setProduct(e.target.value);
                setComponent("");
                setVersion(products.find(x => x.name === e.target.value)?.versions?.[0] || "");
              }}
            >
              <option value="" disabled>Select product…</option>
              {products.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>

          <label className="block text-xs text-slate-400 space-y-1">
            <span>Component *</span>
            <select
              className="input w-full"
              value={component}
              onChange={e => setComponent(e.target.value)}
              disabled={!selected}
            >
              <option value="" disabled>Select component…</option>
              {(selected?.components ?? []).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>

          <label className="block text-xs text-slate-400 space-y-1">
            <span>Version</span>
            <select
              className="input w-full"
              value={version}
              onChange={e => setVersion(e.target.value)}
              disabled={!versionOptions.length}
              title={versionOptions.length ? undefined : 'No versions listed for this product — "unspecified" is sent'}
            >
              {!versionOptions.length && <option value="">unspecified</option>}
              {versionOptions.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>

          <label className="block text-xs text-slate-400 space-y-1">
            <span>Severity</span>
            <select className="input w-full" value={severity} onChange={e => setSeverity(e.target.value)}>
              <option value="Blocker">Blocker</option>
              <option value="Critical">Critical</option>
              <option value="Major">Major</option>
              <option value="Normal">Normal</option>
              <option value="Minor">Minor</option>
            </select>
          </label>

          {typeOptions.length > 0 && (
            <label className="block text-xs text-slate-400 space-y-1">
              <span>Type *</span>
              <select className="input w-full" value={type} onChange={e => setType(e.target.value)}>
                {typeOptions.map(t => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
              </select>
            </label>
          )}
        </div>

        <label className="block text-xs text-slate-400 space-y-1">
          <span>Summary *</span>
          <input
            className="input w-full"
            placeholder="One-line description, e.g. 'RACH failure after handover on U300 SA'"
            value={summary}
            maxLength={255}
            onChange={e => setSummary(e.target.value)}
          />
        </label>

        <label className="block text-xs text-slate-400 space-y-1">
          <span>Description *</span>
          <textarea
            className="input w-full min-h-[140px] font-mono text-xs"
            placeholder={"What happened, expected behavior, steps to reproduce, logs/build info…"}
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
        </label>

        {error && (
          <div className="text-xs text-red-400 bg-red-500/10 ring-1 ring-red-500/30 rounded px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button className="btn-secondary text-xs" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn-primary text-xs"
            onClick={submit}
            disabled={!canSubmit}
            title={canSubmit ? "Create the ticket in Bugzilla (you will be the reporter)" : "Product, component, summary and description are required"}
          >
            {submitting
              ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
              : <Send className="w-3.5 h-3.5" />}
            {submitting ? "Filing…" : "File ticket"}
          </button>
        </div>
      </div>
    </div>
  );
}
