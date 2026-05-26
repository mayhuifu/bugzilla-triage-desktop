"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { User, X, Loader2, Search } from "lucide-react";

// Typeahead search for the assignee filter. Replaces the old dropdown
// (which only listed assignees observed in the currently-loaded 25-row
// page window). Hits /api/users → Bugzilla /rest/user?match=<x> so the
// user can pick ANY engineer in the system, then filters the ticket
// list to their queue.
//
// Behaviour:
//   - Empty input + focused → show `recentSuggestions` (assignees from
//     the loaded ticket window) as quick presets. Mirrors the old
//     dropdown's behaviour for users who don't want to type.
//   - >= 2 chars typed → debounce 300 ms, then call /api/users?match=…
//     to fetch live suggestions. Loading indicator while in flight.
//   - Click a suggestion or hit Enter on the highlighted row → calls
//     onSelect(email). Parent stores the email in FilterState.assignee.
//   - Clear button (×) when there's a selected value → onSelect("").
//
// Disabled state (e.g. "My Tickets" is on): the whole control greys
// out and the keyboard handler bails early.

export interface AssigneeFilterProps {
  /** Currently-selected assignee email (state.assignee). Empty = no
   *  filter. The input renders the username part of this when not
   *  being actively typed in. */
  value: string;
  /** Called with the new assignee email (or "" to clear). */
  onChange: (email: string) => void;
  /** Assignees observed in the loaded ticket window. Shown as initial
   *  suggestions when the input is empty + focused — gives one-click
   *  access to common picks without having to type. */
  recentSuggestions: string[];
  /** When true, the whole control greys out (used by the parent when
   *  My Tickets is on — those two are mutually exclusive). */
  disabled?: boolean;
  /** Tooltip shown when disabled. */
  disabledReason?: string;
}

interface UserMatch {
  id: number;
  name: string;       // email / login
  realName: string;   // "Joachim Wehinger"
}

// Same threshold as /api/users — saves a round-trip for inputs that
// would just return [] anyway. Bugzilla itself requires >=3 chars in
// some installs, but the typeahead is more responsive at 2.
const MIN_QUERY = 2;
const DEBOUNCE_MS = 300;
const MAX_VISIBLE = 10;

export function AssigneeFilter({
  value,
  onChange,
  recentSuggestions,
  disabled = false,
  disabledReason,
}: AssigneeFilterProps) {
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<UserMatch[]>([]);
  // Keyboard navigation cursor — index into the visible suggestion
  // list. -1 = none highlighted (Enter does nothing).
  const [cursor, setCursor] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // What the input displays. While the user is typing we show `typed`;
  // when they aren't (no focus, no edits), fall back to the selected
  // assignee's username part. Empty string when nothing's selected.
  const displayValue = useMemo(() => {
    if (typed !== "") return typed;
    return value ? value.split("@")[0] : "";
  }, [typed, value]);

  // ── Fetch live suggestions when the user types ──────────────────
  // Debounced so we don't fire a /rest/user request per keystroke.
  // Cancellation token via the AbortController prevents stale
  // responses from clobbering newer ones if the user keeps typing.
  useEffect(() => {
    const q = typed.trim();
    if (q.length < MIN_QUERY) {
      setMatches([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const ac = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/users?match=${encodeURIComponent(q)}`,
          { signal: ac.signal },
        );
        const data = await res.json();
        if (ac.signal.aborted) return;
        if (data.error) setError("Search failed");
        setMatches(Array.isArray(data.users) ? data.users : []);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setError("Search failed");
        setMatches([]);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [typed]);

  // ── Outside-click dismissal ─────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setTyped("");   // discard half-typed input on dismiss
        setCursor(-1);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // ── What the dropdown shows ─────────────────────────────────────
  // When `typed` is non-empty: server-fetched matches.
  // When `typed` is empty (and we're focused): recentSuggestions
  // mapped into the same shape so the click handler is uniform.
  const visible = useMemo<UserMatch[]>(() => {
    if (typed.trim().length >= MIN_QUERY) return matches.slice(0, MAX_VISIBLE);
    return recentSuggestions.slice(0, MAX_VISIBLE).map(email => ({
      id: 0,
      name: email,
      realName: "",
    }));
  }, [typed, matches, recentSuggestions]);

  // Reset cursor when the visible list changes.
  useEffect(() => { setCursor(-1); }, [typed, matches, recentSuggestions]);

  const pick = useCallback((email: string) => {
    onChange(email);
    setTyped("");
    setOpen(false);
    setCursor(-1);
    inputRef.current?.blur();
  }, [onChange]);

  const clear = useCallback(() => {
    onChange("");
    setTyped("");
    setOpen(false);
    setCursor(-1);
    inputRef.current?.focus();
  }, [onChange]);

  // Keyboard nav: ↑/↓ moves cursor, Enter picks, Esc closes.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (visible.length > 0) setCursor(c => Math.min(c + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (visible.length > 0) setCursor(c => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor >= 0 && cursor < visible.length) {
        pick(visible[cursor].name);
      } else if (typed.trim() && typed.includes("@")) {
        // Power-user fallback: pasted a full email + Enter → accept
        // verbatim. Avoids the round-trip when they already know the id.
        pick(typed.trim());
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setTyped("");
      setCursor(-1);
      inputRef.current?.blur();
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative w-52"
      title={disabled ? disabledReason : undefined}
    >
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          className="input pl-8 pr-8 disabled:opacity-40"
          placeholder="Search assignee…"
          value={displayValue}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={e => {
            setTyped(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {(value || typed) && !disabled && (
          <button
            type="button"
            onClick={clear}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-bg-hover"
            title="Clear assignee filter"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && !disabled && (
        <div className="absolute top-full left-0 right-0 mt-1 z-30 max-h-72 overflow-y-auto rounded-lg border border-bg-border bg-bg-panel shadow-xl">
          {/* Header — explains where the suggestions came from. Small
              UX hint so the user knows when the loaded-tickets list is
              showing vs. the live Bugzilla search. */}
          <div className="sticky top-0 px-3 py-1.5 border-b border-bg-border bg-bg-panel text-[10px] uppercase tracking-wider text-slate-500 flex items-center justify-between">
            <span>
              {typed.trim().length >= MIN_QUERY
                ? `Bugzilla user search · "${typed.trim()}"`
                : "Recent assignees (from loaded tickets)"}
            </span>
            {loading && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
          </div>

          {/* Body — list of clickable suggestions. */}
          {visible.length === 0 && !loading && (
            <div className="px-3 py-3 text-xs text-slate-500">
              {typed.trim().length >= MIN_QUERY
                ? error || `No users matched "${typed.trim()}"`
                : typed.trim().length === 0
                  ? "Start typing to search Bugzilla users…"
                  : `Type at least ${MIN_QUERY} characters`}
            </div>
          )}

          {visible.map((u, i) => {
            const isCursor = i === cursor;
            const isSelected = u.name === value;
            return (
              <button
                key={`${u.id || u.name}-${i}`}
                type="button"
                onMouseDown={e => e.preventDefault()}    // keep input focused
                onClick={() => pick(u.name)}
                onMouseEnter={() => setCursor(i)}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs border-b border-bg-border/30 last:border-b-0 ${
                  isCursor
                    ? "bg-accent/15 text-accent-glow"
                    : isSelected
                      ? "bg-bg-hover/60 text-slate-200"
                      : "text-slate-300 hover:bg-bg-hover/40"
                }`}
              >
                <User className="w-3 h-3 shrink-0 text-slate-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    {u.realName || u.name.split("@")[0]}
                  </div>
                  {u.realName && (
                    <div className="text-[10px] text-slate-500 truncate">
                      {u.name}
                    </div>
                  )}
                </div>
                {isSelected && <span className="text-[10px] text-accent">✓</span>}
              </button>
            );
          })}

          {/* Footer — explicit hint that more matches may exist
              beyond MAX_VISIBLE. Encourages the user to refine. */}
          {typed.trim().length >= MIN_QUERY && matches.length > MAX_VISIBLE && (
            <div className="px-3 py-1.5 text-[10px] text-slate-500 border-t border-bg-border bg-bg-panel/80">
              Showing first {MAX_VISIBLE} of {matches.length}+ matches — keep typing to narrow.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
