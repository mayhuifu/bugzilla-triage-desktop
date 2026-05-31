"use client";

// ──────────────────────────────────────────────────────────────────
// SpecSearchBox — the /spec search input. Controlled value + debounced
// onSearch. Accepts free text ("PUSCH DMRS sequence"), a citation
// ("TS 38.211 §7.4.2.2"), or an acronym ("HARQ"). The page decides what
// to do with each; this component just captures input and signals.
// ──────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { Search, X, Loader2 } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Fired after the debounce settles (or immediately on Enter). */
  onSearch: (v: string) => void;
  loading?: boolean;
  debounceMs?: number;
  placeholder?: string;
}

export function SpecSearchBox({
  value, onChange, onSearch, loading, debounceMs = 350, placeholder,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  // Debounced auto-search as the user types. Enter bypasses the debounce.
  useEffect(() => {
    const v = value.trim();
    if (!v) return;
    const t = setTimeout(() => onSearch(v), debounceMs);
    return () => clearTimeout(t);
    // onSearch is stable (useCallback in the page); deliberately not a dep
    // so retyping the same string doesn't refire from an onSearch identity
    // change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, debounceMs]);

  // Focus on mount so the user can type immediately on landing.
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div
      className={
        "flex items-center gap-2 rounded-lg border bg-bg-card px-3 h-12 transition-colors " +
        (focused ? "border-accent/60 ring-1 ring-accent/30" : "border-bg-border")
      }
    >
      {loading
        ? <Loader2 className="w-4 h-4 text-accent animate-spin shrink-0" />
        : <Search className="w-4 h-4 text-slate-500 shrink-0" />}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={e => {
          if (e.key === "Enter") onSearch(value.trim());
          if (e.key === "Escape" && value) { onChange(""); }
        }}
        placeholder={placeholder || "Search 3GPP specs — free text, a citation (TS 38.211 §7.4.2.2), or an acronym (HARQ)"}
        className="flex-1 bg-transparent outline-none text-sm text-slate-100 placeholder:text-slate-600"
        spellCheck={false}
        autoComplete="off"
      />
      {value && (
        <button
          onClick={() => { onChange(""); inputRef.current?.focus(); }}
          className="btn-ghost p-1 shrink-0"
          title="Clear (Esc)"
          aria-label="Clear search"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
