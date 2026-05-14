"use client";

import { CheckCircle2, Circle, Loader2 } from "lucide-react";

export type WorkflowStep = "select" | "triage" | "review" | "refine" | "approve" | "submit";

export const STEP_ORDER: WorkflowStep[] = ["select", "triage", "review", "refine", "approve", "submit"];

const STEP_LABEL: Record<WorkflowStep, string> = {
  select: "Selected",
  triage: "AI triage",
  review: "Review",
  refine: "Refine",
  approve: "Approve",
  submit: "Submit",
};

export interface StepState {
  step: WorkflowStep;
  status: "idle" | "active" | "done" | "skipped";
}

export function StepIndicator({ steps }: { steps: StepState[] }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      {steps.map((s, i) => {
        const isLast = i === steps.length - 1;
        return (
          <div key={s.step} className="flex items-center gap-1 shrink-0">
            <StepDot state={s} />
            <span className={`text-[10px] uppercase tracking-wider font-medium
              ${s.status === "done" ? "text-emerald-300" :
                s.status === "active" ? "text-accent-glow" :
                s.status === "skipped" ? "text-slate-600" : "text-slate-500"}`}>
              {STEP_LABEL[s.step]}
            </span>
            {!isLast && (
              <div className={`w-4 h-px mx-1
                ${s.status === "done" ? "bg-emerald-500/40" : "bg-bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StepDot({ state }: { state: StepState }) {
  if (state.status === "done") {
    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
  }
  if (state.status === "active") {
    return <Loader2 className="w-3.5 h-3.5 text-accent-glow animate-spin shrink-0" />;
  }
  return <Circle className="w-3.5 h-3.5 text-slate-600 shrink-0" />;
}
