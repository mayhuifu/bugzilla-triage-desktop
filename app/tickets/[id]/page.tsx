"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";
import type { TicketDetail } from "@/lib/types";
import { Logo } from "@/components/ui/Logo";
import Link from "next/link";
import { TicketDetailHeader } from "@/components/detail/TicketDetailHeader";
import { TicketDescription } from "@/components/detail/TicketDescription";
import { TicketComments } from "@/components/detail/TicketComments";
import { TicketTimeline } from "@/components/detail/TicketTimeline";
import { TriageChatPanel } from "@/components/triage/TriageChatPanel";

export default function TicketDetailPage() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const id = parseInt(params.id);
  const autotriage = sp.get("autotriage") === "1";

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/tickets/${id}`);
        const data = await res.json();
        if (data.ticket) setTicket(data.ticket);
        else setError(data.error || "Ticket not found");
        if (data.error && data.ticket) setError(`backend warning: ${data.error}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load ticket");
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-bg-border bg-bg-panel/60 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/"><Logo /></Link>
            <div className="text-xs text-slate-500">
              <span className="text-slate-400">Triage Workflow</span>
              <span className="mx-2 text-slate-700">·</span>
              <span>Ticket #{id}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-6 py-6">
        {loading && (
          <div className="card p-12 flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-accent" />
            <div className="text-sm text-slate-400">Loading ticket #{id}…</div>
          </div>
        )}

        {!loading && error && !ticket && (
          <div className="card p-12 text-center space-y-3 border-red-500/30">
            <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
            <div className="text-base text-slate-200 font-medium">Could not load ticket</div>
            <div className="text-sm text-slate-500">{error}</div>
            <Link href="/" className="btn-secondary mt-3 inline-flex">Back to dashboard</Link>
          </div>
        )}

        {!loading && ticket && (
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_440px] gap-5 animate-fade-in">
            {/* Left/main: ticket context */}
            <div className="space-y-4 min-w-0">
              {error && (
                <div className="card border-amber-500/30 bg-amber-950/10 p-3 text-xs text-amber-300">
                  {error}
                </div>
              )}
              <TicketDetailHeader ticket={ticket} />
              <TicketDescription ticket={ticket} />
              <TicketComments comments={ticket.comments} />
              <TicketTimeline history={ticket.history} />
            </div>

            {/* Right: sticky AI triage chat panel */}
            <aside className="xl:sticky xl:top-20 xl:self-start xl:h-[calc(100vh-6rem)]">
              <TriageChatPanel
                ticketId={ticket.id}
                ticketStatus={ticket.status}
                ticketSummary={ticket.summary}
                autotriage={autotriage}
              />
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
