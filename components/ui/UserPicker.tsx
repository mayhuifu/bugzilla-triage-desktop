"use client";

// UserPicker — a compact Bugzilla-user typeahead. Hits /api/users →
// /rest/user?match=<x> (key-safe proxy) and calls onPick(email, realName)
// when the user chooses someone. Unlike the dashboard's AssigneeFilter it
// holds no selected value of its own and clears after each pick — the caller
// owns the selection (a single assignee, or a growing CC list). Reused for
// both the Assignee change and the "Add CC" control in the ticket editor.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { User, Loader2, Search } from "lucide-react";

interface UserMatch { id: number; name: string; realName: string }

const MIN_QUERY = 2;
const DEBOUNCE_MS = 300;
const MAX_VISIBLE = 8;

export function UserPicker({
  onPick, placeholder = "Search users…", excludeEmails = [], autoFocus = false,
}: {
  onPick: (email: string, realName: string) => void;
  placeholder?: string;
  /** Emails to hide from results (already-selected / current value). */
  excludeEmails?: string[];
  autoFocus?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<UserMatch[]>([]);
  const [cursor, setCursor] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced live search. AbortController guards against stale responses.
  useEffect(() => {
    const q = typed.trim();
    if (q.length < MIN_QUERY) { setMatches([]); setLoading(false); setError(null); return; }
    setLoading(true); setError(null);
    const ac = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users?match=${encodeURIComponent(q)}`, { signal: ac.signal });
        const data = await res.json();
        if (ac.signal.aborted) return;
        if (data.error) setError("Search failed");
        setMatches(Array.isArray(data.users) ? data.users : []);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setError("Search failed"); setMatches([]);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [typed]);

  // Outside-click dismissal.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) { setOpen(false); setCursor(-1); }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const excluded = useMemo(() => new Set(excludeEmails.map(e => e.toLowerCase())), [excludeEmails]);
  const visible = useMemo(
    () => matches.filter(m => !excluded.has(m.name.toLowerCase())).slice(0, MAX_VISIBLE),
    [matches, excluded],
  );
  useEffect(() => { setCursor(-1); }, [matches]);

  const pick = useCallback((email: string, realName: string) => {
    onPick(email, realName);
    setTyped(""); setMatches([]); setOpen(false); setCursor(-1);
    inputRef.current?.focus();   // keep focus so the user can add several in a row
  }, [onPick]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (visible.length) setCursor(c => Math.min(c + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (visible.length) setCursor(c => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor >= 0 && cursor < visible.length) pick(visible[cursor].name, visible[cursor].realName);
      else if (typed.trim().includes("@")) pick(typed.trim(), "");   // power-user: paste a full email
    } else if (e.key === "Escape") {
      setOpen(false); setCursor(-1); inputRef.current?.blur();
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          className="input pl-8 pr-8 text-sm w-full"
          placeholder={placeholder}
          value={typed}
          autoFocus={autoFocus}
          onFocus={() => setOpen(true)}
          onChange={e => { setTyped(e.target.value); setOpen(true); }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {loading && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-slate-400" />}
      </div>

      {open && typed.trim().length >= MIN_QUERY && (
        <div className="absolute top-full left-0 right-0 mt-1 z-40 max-h-64 overflow-y-auto rounded-lg border border-bg-border bg-bg-panel shadow-xl">
          {visible.length === 0 && !loading && (
            <div className="px-3 py-3 text-xs text-slate-500">
              {error || `No users matched "${typed.trim()}"`}
            </div>
          )}
          {visible.map((u, i) => (
            <button
              key={`${u.id || u.name}-${i}`}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => pick(u.name, u.realName)}
              onMouseEnter={() => setCursor(i)}
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs border-b border-bg-border/30 last:border-b-0 ${
                i === cursor ? "bg-accent/15 text-accent-glow" : "text-slate-300 hover:bg-bg-hover/40"
              }`}
            >
              <User className="w-3 h-3 shrink-0 text-slate-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{u.realName || u.name.split("@")[0]}</div>
                {u.realName && <div className="text-[10px] text-slate-500 truncate">{u.name}</div>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
