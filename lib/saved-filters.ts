// ─────────────────────────────────────────────────────────────────
// Saved-filters storage (localStorage)
//
// Per-user persistence of dashboard filter combinations. Since there's no
// auth surface in this app (assumed to live behind corporate SSO/VPN),
// "per user" effectively means "per browser profile". One JSON array in
// localStorage; we keep the public API surface (load/save/delete) tiny so
// the storage schema can evolve without changing callers.
// ─────────────────────────────────────────────────────────────────

import type { TicketBucket } from "./types";
import type { FilterState } from "@/components/dashboard/TicketFilters";

const STORAGE_KEY = "triage:savedFilters";
const MAX_FILTERS = 20;          // cap to avoid unbounded growth
const SCHEMA_VERSION = 1;

export interface SavedFilter {
  id: string;                    // stable client-generated key
  name: string;
  filters: FilterState;
  bucket: TicketBucket | null;   // captured alongside filters since both
                                 //   drive the table together
  createdAt: string;             // ISO timestamp, useful for sort/UI hints
}

interface StoredEnvelope {
  version: number;
  items: SavedFilter[];
}

function safeRead(): StoredEnvelope {
  if (typeof window === "undefined") return { version: SCHEMA_VERSION, items: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: SCHEMA_VERSION, items: [] };
    const parsed = JSON.parse(raw) as StoredEnvelope;
    // Forward-compatible: if a future version writes here, drop unrecognized
    // entries rather than crashing the dashboard.
    if (parsed.version !== SCHEMA_VERSION) return { version: SCHEMA_VERSION, items: [] };
    return parsed;
  } catch {
    return { version: SCHEMA_VERSION, items: [] };
  }
}

function safeWrite(envelope: StoredEnvelope) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Quota or private-mode failure — silent. UI will just not persist.
  }
}

export function loadSavedFilters(): SavedFilter[] {
  return safeRead().items;
}

export function saveSavedFilter(name: string, filters: FilterState, bucket: TicketBucket | null): SavedFilter {
  const env = safeRead();
  const item: SavedFilter = {
    id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim().slice(0, 60) || "Untitled filter",
    filters,
    bucket,
    createdAt: new Date().toISOString(),
  };
  // Newest first; cap at MAX_FILTERS by dropping the oldest.
  const items = [item, ...env.items].slice(0, MAX_FILTERS);
  safeWrite({ version: SCHEMA_VERSION, items });
  return item;
}

export function deleteSavedFilter(id: string): SavedFilter[] {
  const env = safeRead();
  const items = env.items.filter(f => f.id !== id);
  safeWrite({ version: SCHEMA_VERSION, items });
  return items;
}
