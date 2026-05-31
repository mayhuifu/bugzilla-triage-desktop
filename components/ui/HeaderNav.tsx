"use client";

// ──────────────────────────────────────────────────────────────────
// HeaderNav — the top-level workbench tab toggle that turns the app
// from a single triage view into a multi-surface workbench (v0.5).
//
//   • Triage Queue  (/)            — tickets, filters, AI triage
//   • 3GPP Specs    (/spec)        — standalone spec search + browse
//
// Rendered in the sticky header of both surfaces, right after <Logo/>.
// Active state is derived from the pathname so the highlight survives
// deep links (a ticket detail page keeps "Triage Queue" lit; a
// ?clause= spec deep link keeps "3GPP Specs" lit).
// ──────────────────────────────────────────────────────────────────

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ListChecks, BookText } from "lucide-react";

const TABS = [
  {
    href: "/",
    label: "Triage Queue",
    icon: ListChecks,
    // Triage surfaces: dashboard, ticket detail, bulk triage.
    match: (p: string) => p === "/" || p.startsWith("/tickets") || p.startsWith("/bulk-triage"),
  },
  {
    href: "/spec",
    label: "3GPP Specs",
    icon: BookText,
    match: (p: string) => p.startsWith("/spec"),
  },
] as const;

export function HeaderNav() {
  const pathname = usePathname() || "/";
  return (
    <nav className="flex items-center gap-1 ml-2" aria-label="Workbench sections">
      {TABS.map(tab => {
        const active = tab.match(pathname);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors " +
              (active
                ? "bg-accent/15 text-accent-glow ring-1 ring-accent/40"
                : "text-slate-400 hover:text-slate-200 hover:bg-bg-hover/60")
            }
          >
            <Icon className="w-3.5 h-3.5" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
