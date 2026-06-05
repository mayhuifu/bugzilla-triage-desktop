# v0.5.7 — Knowledge-graph-augmented retrieval (Phase C of next-gen RAG)

> **Status:** Approved, not started. Durable hand-off — survives a `/compact`.
> Strategy: `bugzilla-triage-corpus/PLAN-nextgen-rag.md`. Depends on Phase A
> (v0.5.5 reranker) and benefits from Phase B (v0.5.6 cleaner parse/entities).
> Most experimental of the three — **eval-gated**.

## Goal

Fix **relational / multi-hop** queries ("how does BWP switching relate to
handover and which timers apply", "what configures X and where is it measured")
— the one failure mode where a knowledge graph genuinely beats flat hybrid.

Borrow RAG-Anything/LightRAG's **knowledge-graph idea**, but adapt it to our
model: **build the KG offline, ship it inside SQLite, traverse it locally at
query time with NO runtime LLM and NO graph server.**

Ships as desktop **v0.5.7** consuming corpus **rel17-v7** (schema v5).

## Invariants (unchanged)

Offline, single SQLite, LLM-optional at runtime, in-process. The KG is built
once (LLM at build time), then it's static data + plain graph traversal at query
time. No Neo4j, no Python service, no query-time LLM.

## Versioning

- Desktop **v0.5.7** (graph-augmented retrieval + Phase A reranker).
- Corpus **rel17-v7**, `meta.schemaVersion = "5"` (adds `kg_nodes`, `kg_edges`).

## Why a KG (and why ours, not RAG-Anything's runtime)

Hybrid + reranker rank *individual* clauses well, but a relational query needs
clauses *connected* through shared entities (a timer defined in one clause,
configured in another, measured in a third). A KG of entities + relationships
lets us pull in graph neighbours the lexical/dense match would miss. RAG-Anything
gets this from LightRAG — but at the cost of a Python runtime + query-time LLM +
graph store. We keep the *structure*, drop the *runtime cost*: precompute the
graph, ship it, traverse in SQL/Node.

## State to know

- Clauses already carry `mentions_json` (entity mentions) and `acronyms` table
  (152 rows) — useful seeds for entity matching.
- Phase A reranker (`lib/corpus/reranker.ts`) reorders candidates; Phase C feeds
  graph-expanded candidates INTO that reranker.
- Corpus `03-index.ts` builds the SQLite; `retriever.ts` does hybrid RRF.

## Implementation

### 1. Build-time KG construction (corpus; ~1–1.5 wk; one-time LLM)

- New `scripts/build-kg.ts` (+ LLM sidecar):
  - **Entities** (`kg_nodes`): channels (PUSCH/PUCCH/PDSCH…), signals (SRS/CSI-RS/SSB),
    procedures (handover, RACH, BWP switch), parameters/timers (T304, k0…),
    bearers (SRB/DRB), MAC CEs, etc. Type + canonical name + aliases. Seed from
    `acronyms` + `mentions_json`, expand via LLM extraction per clause.
  - **Relationships** (`kg_edges`): `defines`, `references`, `configured_by`,
    `measured_by`, `depends_on`, `belongs_to` (clause hierarchy), with a weight
    and the source clause id. LLM extracts per clause; dedupe + canonicalize.
  - **Pragmatic shortcut:** run **LightRAG/RAG-Anything once, offline, as a build
    tool** over the corpus to produce its graph, then **export** nodes/edges into
    our schema. Gets a battle-tested KG without reimplementing extraction prompts.
    Evaluate this vs a hand-rolled extractor on a sample first.
- Cost: one-time LLM spend over ~13k clauses. Cache by clause-text hash.

### 2. Schema v5 (`03-index.ts`)

- `kg_nodes(id PK, type, name, canonical, aliases_json)`
- `kg_edges(src, dst, relation, weight, source_clause_id)` (+ indexes on src,dst)
- `clause_entities(clause_id, node_id)` linking clauses to the entities they
  mention/define (from extraction; supersedes/augments `mentions_json`).
- `meta.schemaVersion = "5"`; record KG build model + stats (node/edge counts).

### 3. Runtime: graph-augmented retrieval (desktop; ~1 wk; NO LLM)

In `lib/corpus/retriever.ts`, a new path `"hybrid-rrf+kg+rerank"`:

1. **Query entity detection** — match query terms against `kg_nodes`
   (name/aliases), reusing acronym expansion. Cheap, no LLM.
2. **Candidate generation** — hybrid RRF as today (the lexical/dense anchor).
3. **Graph expansion** — for detected query entities (and entities of the top
   hybrid hits), traverse 1–2 hops over `kg_edges` (SQL) → gather neighbour
   clauses via `clause_entities`. Cap fan-out (e.g. top-M neighbours by edge
   weight) to avoid flooding.
4. **Merge + rerank** — union hybrid + graph-expanded candidates, dedupe, then
   **Phase A reranker** scores the lot → top-N. The reranker is what keeps the
   graph-pulled candidates honest (noisy edges get down-ranked).
5. Fallback: no KG tables (older corpus) → skip graph expansion, behave as
   v0.5.6 (hybrid + rerank). Graceful.

`lib/corpus/store.ts`: KG query helpers (entity lookup, neighbour fetch).
`/api/corpus/status`: expose `retrieverPath` incl. `+kg`.

### 4. Eval-gate (critical)

- The expanded eval set must have a **relational/multi-hop** stratum.
- Ship **only if** that stratum's MRR@10 / recall improves AND no other stratum
  regresses beyond a small threshold. KG noise can *hurt* precision — if it
  doesn't beat hybrid+rerank, **don't ship the KG path** (keep it behind a flag).

### 5. Ship v0.5.7

- Publish corpus `rel17-v7`; desktop `manifest.ts` add schema 5; `settings.ts`
  default → rel17-v7 (+ rel17-v6 legacy). Bump `package.json` 0.5.7; RELEASES;
  tag/CI/publish; Windows smoke test.

## Cross-repo contract

- `meta.schemaVersion = "5"` (adds kg tables; additive — older desktops ignore).
- Desktop `SUPPORTED_SCHEMA_VERSIONS` add `5`.
- Artifact grows by the KG tables (nodes/edges/links — modest vs figure blobs).
- Runtime still LLM-optional; traversal is SQL over shipped tables.

## Verification matrix

| Check | Expected |
|---|---|
| KG build sample (a few specs) | sensible entities + edges; spot-check a relation chain |
| Build rel17-v7 | schema 5; kg_nodes/kg_edges populated; goldens pass |
| Relational eval stratum | MRR@10 / recall up vs hybrid+rerank |
| Other strata | no regression beyond threshold |
| `/api/corpus/status` | `retrieverPath` includes `+kg` |
| Older corpus (no kg tables) | graceful fallback to hybrid+rerank |

## Risk register

| Risk | Mitigation |
|---|---|
| KG quality / noisy edges hurt precision | Reranker on the merged set; eval-gate; flag-guard the path |
| Build LLM cost over 13k clauses | One-time; cache by clause hash; or export from a single LightRAG run |
| Entity matching false positives | Canonicalize + alias control; weight edges; cap graph fan-out |
| Graph expansion floods candidates | Cap neighbours by edge weight; rerank trims |
| Schema migration | Additive; SUPPORTED_SCHEMA_VERSIONS; legacy URL fallback |

## Out of scope

- RAG-Anything as the desktop *runtime* (stays the deferred server-side §6
  platform). Using it offline as a one-shot KG *build* tool IS in scope here.
- Anything beyond the three confirmed failure modes.
