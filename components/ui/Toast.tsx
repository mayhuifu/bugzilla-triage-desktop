"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, X } from "lucide-react";

export type ToastKind = "success" | "error" | "info";
export interface ToastMessage {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

let toastCounter = 0;
const listeners = new Set<(m: ToastMessage) => void>();

export function pushToast(kind: ToastKind, title: string, description?: string) {
  const msg: ToastMessage = { id: ++toastCounter, kind, title, description };
  listeners.forEach(l => l(msg));
}

export function ToastContainer() {
  const [items, setItems] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const handler = (m: ToastMessage) => {
      setItems(prev => [...prev, m]);
      setTimeout(() => setItems(prev => prev.filter(x => x.id !== m.id)), 5000);
    };
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  return (
    <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2 max-w-md">
      {items.map(t => (
        <div
          key={t.id}
          className={`flex items-start gap-3 glass rounded-xl px-4 py-3 shadow-xl animate-slide-up
            ${t.kind === "success" ? "ring-1 ring-emerald-500/40" : t.kind === "error" ? "ring-1 ring-red-500/40" : "ring-1 ring-accent/40"}`}
        >
          {t.kind === "success" && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />}
          {t.kind === "error" && <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />}
          {t.kind === "info" && <AlertCircle className="w-5 h-5 text-accent shrink-0 mt-0.5" />}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-slate-100">{t.title}</div>
            {t.description && <div className="text-xs text-slate-400 mt-0.5">{t.description}</div>}
          </div>
          <button
            onClick={() => setItems(prev => prev.filter(x => x.id !== t.id))}
            className="text-slate-500 hover:text-slate-300"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
