// === Local mirror of the three deliberation contracts ===
//
// Deep think, mermaid and memory are typed once in
// `backend/src/types/deep-tools.ts`, and their browser-side home is
// `frontend/src/types/index.ts`, next to `AgentJob`. They are declared here
// instead because that file is being written in parallel by another agent, and
// two writers on one file is how a field silently disappears from a contract.
//
// Merge instruction: once `@/types` exports these names, delete this file and
// repoint the imports in `MermaidDiagram.tsx`, `DeepThinkCard.tsx` and
// `MemoryPanel.tsx`. The shapes below are copied from the backend unchanged, so
// the swap is mechanical — and where the two disagree, the backend is right.

// ---------------------------------------------------------------------------
// Brave search — what a thinker cites
// ---------------------------------------------------------------------------

export interface BraveResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

// ---------------------------------------------------------------------------
// Deep think
// ---------------------------------------------------------------------------

export type ThinkerStatus = "pending" | "running" | "done" | "error";

export interface ThinkerResult {
  id: string;
  angle: string;
  status: ThinkerStatus;
  thinking?: string;
  citations?: BraveResult[];
  searches?: number;
  error?: string;
  usd?: number;
}

export type DeepThinkStatus = "running" | "done" | "error" | "cancelled";

export interface DeepThinkJob {
  id: string;
  conversation_id: string;
  scenario: string;
  status: DeepThinkStatus;
  activity: string;
  thinkers: ThinkerResult[];
  synthesis?: string;
  error?: string;
  started_at: string;
  finished_at?: string;
  cost_usd?: number;
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

export type MermaidDiagramKind =
  | "flowchart"
  | "sequenceDiagram"
  | "classDiagram"
  | "stateDiagram-v2"
  | "erDiagram"
  | "journey"
  | "gantt"
  | "pie"
  | "mindmap"
  | "timeline";

/**
 * The backend calls this `MermaidDiagram`. It is renamed here only because the
 * component that draws it already owns that name in this folder; the field list
 * is identical, so `import type { MermaidDiagram as MermaidDiagramData }` from
 * `@/types` is the whole migration.
 */
export interface MermaidDiagramData {
  id: string;
  kind: MermaidDiagramKind;
  title?: string;
  /** The mermaid source itself, already validated by the backend. */
  source: string;
  caption: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export type MemoryEventKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "reflection"
  | "diagram"
  | "note";

export interface MemoryEvent {
  id: string;
  kind: MemoryEventKind;
  at: string;
  text?: string;
  tool?: string;
  arguments?: string;
  output?: string;
  diagram_id?: string;
  meta?: Record<string, unknown>;
}

export interface MemoryFile {
  version: 1;
  conversation_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  materials: string[];
  events: MemoryEvent[];
  diagrams?: MermaidDiagramData[];
}
