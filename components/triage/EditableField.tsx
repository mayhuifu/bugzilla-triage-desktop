"use client";

import { useEffect, useRef } from "react";
import { Pencil } from "lucide-react";

export function EditableField({
  value, onChange, className, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  return (
    <div className="relative group">
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className={`w-full bg-transparent text-sm text-slate-200 px-2 py-1 -mx-2 -my-1 rounded
                    hover:bg-bg-panel/60 focus:bg-bg-panel border border-transparent
                    focus:border-accent/40 outline-none transition-colors ${className || ""}`}
      />
      <Pencil className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-600 opacity-0 group-hover:opacity-100 pointer-events-none" />
    </div>
  );
}

export function EditableTextarea({
  value, onChange, rows = 3, className, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  className?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-resize to content
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = ref.current.scrollHeight + "px";
    }
  }, [value]);

  return (
    <div className="relative group">
      <textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        className={`w-full bg-transparent text-sm text-slate-200 px-2 py-1.5 -mx-2 -my-1 rounded resize-none
                    hover:bg-bg-panel/60 focus:bg-bg-panel border border-transparent
                    focus:border-accent/40 outline-none transition-colors leading-relaxed ${className || ""}`}
      />
      <Pencil className="absolute right-2 top-2 w-3 h-3 text-slate-600 opacity-0 group-hover:opacity-100 pointer-events-none" />
    </div>
  );
}
