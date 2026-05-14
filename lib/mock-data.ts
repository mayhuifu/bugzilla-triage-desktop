// ─────────────────────────────────────────────────────────────────
// Mock data — used when BUGZILLA_URL/BUGZILLA_API_KEY are not set,
// or when the live Bugzilla is unreachable. Lets the dashboard demo
// cleanly end-to-end without any backend dependencies.
// ─────────────────────────────────────────────────────────────────

import type {
  TicketDetail, TicketSummary, Severity, TicketStatus,
  ProductInfo, WhoAmI, DashboardStats,
} from "./types";

function iso(daysAgo: number, hour = 9): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 17, 0, 0);
  return d.toISOString();
}

function ageDays(daysAgo: number) { return daysAgo; }
function risk(sev: Severity, ageD: number, updD: number): "ok" | "warn" | "breach" {
  const high = sev === "Blocker" || sev === "Critical";
  if (high && (ageD > 30 || updD > 14)) return "breach";
  if (high && (ageD > 14 || updD > 7)) return "warn";
  if (ageD > 90 || updD > 30) return "warn";
  return "ok";
}

function makeSummary(
  id: number,
  summary: string,
  product: string,
  component: string,
  severity: Severity,
  status: TicketStatus,
  assignee: string,
  reporter: string,
  ageD: number,
  updD: number,
  opts: Partial<TicketSummary> = {}
): TicketSummary {
  return {
    id,
    summary,
    product,
    component,
    severity,
    priority: opts.priority ?? "P2",
    status,
    assignee,
    reporter,
    creationTime: iso(ageD),
    lastChangeTime: iso(updD, 14),
    ageDays: ageDays(ageD),
    daysSinceUpdate: updD,
    slaRisk: risk(severity, ageD, updD),
    customer: opts.customer,
    label: opts.label,
    keywords: opts.keywords,
  };
}

export const MOCK_SUMMARIES: TicketSummary[] = [
  makeSummary(16026, "frequency offset invalid — AT cmd ignored on 2nd TX activation", "U300", "BBIC", "Normal", "IN_ANALYSIS", "yi.wang@umsemi.com", "haibo.cui@umsemi.com", 3, 1, { customer: "BC-S (Klaus Göbel)", label: "Analyzed by Claude" }),
  makeSummary(15968, "UL constellation shows \"rings\" — EVM degradation on Anritsu tester", "U300", "BBIC", "Critical", "IN_ANALYSIS", "richard.prueller@bc-s.com", "richard.prueller@bc-s.com", 7, 4, { customer: "BC-S", label: "U300_SYSTEM_CCB" }),
  makeSummary(16040, "[sync][pss] dev: pdu1 for connected mode pss fp", "U300", "BBIC", "Normal", "NEW", "ryan.li@umsemi.com", "ryan.li@umsemi.com", 2, 1, { priority: "P2" }),
  makeSummary(15962, "Separate U350 single core and dual core version with license", "U300", "BBIC", "Normal", "NEW", "stefan.macher@umsemi.com", "bill.xiong@umsemi.com", 7, 7, { keywords: ["licensing", "u350"] }),
  makeSummary(15847, "[CMW] PRACH preamble detection rate < 95% in TDD band n78", "U300", "Calibration", "Critical", "WAITING_FOR_INFO", "joachim.wehinger@umsemi.com", "haibo.cui@umsemi.com", 22, 6, { customer: "Anritsu Lab" }),
  makeSummary(15803, "Refsens degradation 4.2 dB at -45°C, band n8 (LTE)", "U300", "RFIC", "Blocker", "IN_PROGRESS", "venkata.pathuri@umsemi.com", "joachim.wehinger@umsemi.com", 35, 12, { customer: "Tier-1 OEM A", label: "U300_SYSTEM_CCB" }),
  makeSummary(15721, "RedCap UE fails RACH after 2nd IRAT handover NR→LTE", "U300", "BBIC", "Critical", "ANALYZED", "ryan.li@umsemi.com", "kai.liu@umsemi.com", 41, 3, { keywords: ["redcap", "irat"] }),
  makeSummary(15689, "DPD update causes 12 dB spike at +5 MHz offset", "U300", "RFIC", "Major", "IN_VERIFICATION", "stefan.macher@umsemi.com", "venkata.pathuri@umsemi.com", 48, 2),
  makeSummary(15602, "Calibration drift after thermal soak — TX power -1.8 dB", "U300", "Calibration", "Major", "NEW", "joachim.wehinger@umsemi.com", "yuan.tan@umsemi.com", 58, 18, { customer: "Lab Verification" }),
  makeSummary(15511, "MIMO 2x2 — sample buffer overflow at 100 MHz BW", "U300", "BBIC", "Critical", "IN_PROGRESS", "nan.lu@umsemi.com", "lin.wang@umsemi.com", 67, 4),
  makeSummary(15455, "Frequency error 380 Hz at boot in cold start (spec: ±230 Hz @ 2300 MHz)", "U300", "RFIC", "Critical", "WAITING_FOR_INFO", "venkata.pathuri@umsemi.com", "richard.prueller@bc-s.com", 73, 21, { customer: "BC-S" }),
  makeSummary(15401, "AT#CRFTXSTART returns ERROR when carrier already locked", "U300", "BBIC", "Normal", "RESOLVED", "yi.wang@umsemi.com", "haibo.cui@umsemi.com", 82, 9, { keywords: ["at-command"] }),
  makeSummary(15388, "Document update: PCMAX calculation example missing for B41 inner allocation", "U300", "Documentation", "Minor", "ANALYZED", "joseph.he@umsemi.com", "venkata.pathuri@umsemi.com", 88, 5),
  makeSummary(15301, "ACLR margin only 1.2 dB at -20°C (spec ≥30 dB)", "U300", "RFIC", "Blocker", "IN_PROGRESS", "stefan.macher@umsemi.com", "venkata.pathuri@umsemi.com", 99, 18, { customer: "Tier-1 OEM A", label: "U300_SYSTEM_CCB" }),
  makeSummary(15212, "DDR 3200 MT/s fails BIST above 30°C — board #074", "U300", "BBIC", "Critical", "NEW", "joseph.he@umsemi.com", "vlad.taller@umsemi.com", 108, 31, { customer: "HW Lab" }),
];

export const MOCK_DETAILS: Record<number, TicketDetail> = {
  16026: {
    ...MOCK_SUMMARIES[0],
    description: `frequency offset setting in AT command can be valid only for one time.
Using the following AT commands, it can be seen the frequency offset works from cmw100.
  AT#CRFASSUL=287200,281,20000,0
  AT#CRFTXSTART=0,2300,0,-150,0
  AT#CRFTXPOWER=2300,0,0,0
  AT#CIFTXWAV=1,-1792,0,0,0,0,1,20000,287200,281,0,51,0
but it is valid only for one time, that's mean after
  AT#CIFTXWAV=0,-1792,0,0,0,0,1,20000,287200,281,0,51,0
and then send the AT command sequence with setting frequency offset = -150Hz again.
frequency offset will not works.`,
    cc: ["colin.kong@umsemi.com", "haibo.cui@umsemi.com", "klaus.goebel@bc-s.com", "nan.lu@umsemi.com", "yuan.tan@umsemi.com"],
    blocks: [],
    dependsOn: [],
    comments: [
      { id: 73501, count: 0, author: "haibo.cui@umsemi.com", time: iso(3), text: "(see description)", isPrivate: false },
      { id: 73502, count: 1, author: "haibo.cui@umsemi.com", time: iso(3, 11), text: "Created attachment 5226: before setting frequency offset", isPrivate: false },
      { id: 73503, count: 2, author: "haibo.cui@umsemi.com", time: iso(3, 11), text: "Created attachment 5227: after setting frequency offset", isPrivate: false },
      { id: 73510, count: 3, author: "bugzilla-mcp@umsemi.com", time: iso(1, 9), text: "Auto Triggered by Claude for Analysis", isPrivate: false },
      { id: 73511, count: 4, author: "bugzilla-mcp@umsemi.com", time: iso(1, 9), text: "Analyzed by Claude:\n\n**Domain:** NR RF · AT-command surface · band n40 (TDD, 2300-2400 MHz)\n\n[full 4-layer analysis previously posted]", isPrivate: false },
    ],
    history: [
      { who: "bugzilla-mcp@umsemi.com", when: iso(1, 9), changes: [{ field: "status", removed: "NEW", added: "IN_ANALYSIS" }, { field: "cf_label", removed: "", added: "Analyzed by Claude" }] },
    ],
    attachments: [
      { id: 5226, fileName: "frequency offset-1.png", contentType: "image/png", size: 796722, creator: "haibo.cui@umsemi.com", creationTime: iso(3, 11) },
      { id: 5227, fileName: "frequency offset-2.png", contentType: "image/png", size: 806583, creator: "haibo.cui@umsemi.com", creationTime: iso(3, 11) },
    ],
  },
  15968: {
    ...MOCK_SUMMARIES[1],
    description: `#### Observation
The Anritsu tester shows an UL constellation diagram when the device is connected.
There we see that our 4-QAM pattern has little "rings" around the individual symbols
leading to EVM. Currently it is unclear where this phenomenon is coming from and
how severe the impact is.

#### Next steps
1. Align with Ven where the problem could be coming from
2. Check if the problem is also observed on other test hardware
3. Narrow down the source of the problem BBIC/RFIC`,
    cc: ["joachim.wehinger@umsemi.com", "johann.pletzer@umsemi.com", "venkata.pathuri@umsemi.com"],
    blocks: [],
    dependsOn: [],
    comments: [
      { id: 73401, count: 0, author: "richard.prueller@bc-s.com", time: iso(7), text: "(see description)", isPrivate: false },
      { id: 73405, count: 1, author: "richard.prueller@bc-s.com", time: iso(7, 14), text: "Investigated UL signal quality on the CMX. Rings are not visible there during connected mode, but it is not clear yet if there are problems with the signal. Further investigation required.", isPrivate: false },
    ],
    history: [{ who: "richard.prueller@bc-s.com", when: iso(7, 14), changes: [{ field: "status", removed: "NEW", added: "IN_ANALYSIS" }] }],
    attachments: [
      { id: 5197, fileName: "anritsu_screenshot_1.png", contentType: "image/png", size: 432010, creator: "richard.prueller@bc-s.com", creationTime: iso(7) },
      { id: 5198, fileName: "anritsu_screenshot_2.png", contentType: "image/png", size: 421007, creator: "richard.prueller@bc-s.com", creationTime: iso(7) },
    ],
  },
};

// Filter helpers used by mock /api/* routes when the live backend isn't
// reachable. They mirror the same product/component/assignee semantics
// as bz_bridge.py so the UI behaves identically against either source.
const CLOSED_SET = new Set<TicketStatus>(["RESOLVED", "VERIFIED", "CLOSED"]);

export const MOCK_PRODUCTS: ProductInfo[] = (() => {
  const grouped = new Map<string, Set<string>>();
  for (const t of MOCK_SUMMARIES) {
    if (!grouped.has(t.product)) grouped.set(t.product, new Set());
    grouped.get(t.product)!.add(t.component);
  }
  return Array.from(grouped.entries())
    .map(([name, comps]) => ({ name, components: Array.from(comps).sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
})();

export const MOCK_WHOAMI: WhoAmI = {
  login: "demo.user@umsemi.com",
  realName: "Demo User",
  id: null,
  source: "env-fallback",
};

export function buildMockStats(opts: {
  product?: string; component?: string; assignee?: string;
}): DashboardStats {
  const scoped = MOCK_SUMMARIES.filter(t =>
    (!opts.product || t.product === opts.product) &&
    (!opts.component || t.component === opts.component) &&
    (!opts.assignee || t.assignee === opts.assignee),
  );
  const open = scoped.filter(t => !CLOSED_SET.has(t.status));
  const closed = scoped.filter(t => CLOSED_SET.has(t.status));
  const sevCount = (arr: TicketSummary[], sev: Severity) =>
    arr.filter(t => t.severity === sev).length;

  const inWindow = (iso: string, days: number) => {
    const t = new Date(iso).getTime();
    const cutoff = Date.now() - days * 86_400_000;
    return t >= cutoff;
  };
  const inPrevWindow = (iso: string) => {
    const t = new Date(iso).getTime();
    const start = Date.now() - 14 * 86_400_000;
    const end = Date.now() - 7 * 86_400_000;
    return t >= start && t < end;
  };
  const isBC = (t: TicketSummary) => t.severity === "Blocker" || t.severity === "Critical";

  const last7d = {
    filed: scoped.filter(t => inWindow(t.creationTime, 7)).length,
    filedBC: scoped.filter(t => inWindow(t.creationTime, 7) && isBC(t)).length,
    closed: closed.filter(t => inWindow(t.lastChangeTime, 7)).length,
    closedBC: closed.filter(t => inWindow(t.lastChangeTime, 7) && isBC(t)).length,
  };
  const prev7d = {
    filed: scoped.filter(t => inPrevWindow(t.creationTime)).length,
    filedBC: scoped.filter(t => inPrevWindow(t.creationTime) && isBC(t)).length,
    closed: closed.filter(t => inPrevWindow(t.lastChangeTime)).length,
    closedBC: closed.filter(t => inPrevWindow(t.lastChangeTime) && isBC(t)).length,
  };
  return {
    scope: { product: opts.product || null, component: opts.component || null, assignee: opts.assignee || null },
    open: { total: open.length, blocker: sevCount(open, "Blocker"), critical: sevCount(open, "Critical") },
    closed: { total: closed.length, blocker: sevCount(closed, "Blocker"), critical: sevCount(closed, "Critical") },
    trend: { last7d, prev7d, netFlowPerWeek: last7d.filed - last7d.closed },
    generatedAt: new Date().toISOString(),
  };
}

export function buildMockDetail(id: number): TicketDetail {
  if (MOCK_DETAILS[id]) return MOCK_DETAILS[id];
  const summary = MOCK_SUMMARIES.find(s => s.id === id);
  if (!summary) throw new Error(`mock ticket ${id} not found`);
  return {
    ...summary,
    description: `(mock data) ${summary.summary}. This is placeholder description text used when BUGZILLA_URL is not configured. Wire BUGZILLA_URL + BUGZILLA_API_KEY in .env.local to read real tickets.`,
    cc: [],
    blocks: [],
    dependsOn: [],
    comments: [{ id: id * 10, count: 0, author: summary.reporter, time: summary.creationTime, text: "(mock initial comment)", isPrivate: false }],
    history: [],
    attachments: [],
  };
}
