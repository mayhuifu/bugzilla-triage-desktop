"use client";

import { FileText, Paperclip, Image as ImageIcon, Link as LinkIcon } from "lucide-react";
import type { TicketDetail } from "@/lib/types";

export function TicketDescription({ ticket }: { ticket: TicketDetail }) {
  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <FileText className="w-4 h-4 text-accent" />
        <div className="text-sm font-medium text-slate-200">Description</div>
      </div>
      <pre className="text-sm text-slate-300 whitespace-pre-wrap font-mono leading-relaxed bg-bg-panel/60 rounded-lg p-4 border border-bg-border/60 max-h-96 overflow-auto">
        {ticket.description || <span className="text-slate-500">(no description)</span>}
      </pre>

      {(ticket.blocks.length > 0 || ticket.dependsOn.length > 0) && (
        <div className="grid grid-cols-2 gap-3 text-xs">
          {ticket.dependsOn.length > 0 && (
            <div className="bg-bg-panel/40 rounded-lg p-3 border border-bg-border/40">
              <div className="flex items-center gap-1 text-slate-500 mb-1.5">
                <LinkIcon className="w-3 h-3" />
                Depends on
              </div>
              <div className="font-mono text-slate-300">{ticket.dependsOn.join(", ")}</div>
            </div>
          )}
          {ticket.blocks.length > 0 && (
            <div className="bg-bg-panel/40 rounded-lg p-3 border border-bg-border/40">
              <div className="flex items-center gap-1 text-slate-500 mb-1.5">
                <LinkIcon className="w-3 h-3" />
                Blocks
              </div>
              <div className="font-mono text-slate-300">{ticket.blocks.join(", ")}</div>
            </div>
          )}
        </div>
      )}

      {ticket.attachments.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Paperclip className="w-3.5 h-3.5" />
            Attachments ({ticket.attachments.length})
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ticket.attachments.map(a => (
              <div key={a.id} className="bg-bg-panel/40 rounded-lg p-3 border border-bg-border/40 flex items-center gap-3">
                <div className="w-10 h-10 rounded-md bg-bg-hover flex items-center justify-center text-slate-500">
                  {a.contentType.startsWith("image/") ? <ImageIcon className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-200 truncate">{a.fileName}</div>
                  <div className="text-[11px] text-slate-500">
                    {a.contentType} · {fmtBytes(a.size)} · {a.creator.split("@")[0]}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-slate-600 italic">
            Attachments are referenced for context. Actual file content is fetched on demand via the MCP backend during triage.
          </div>
        </div>
      )}
    </div>
  );
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
