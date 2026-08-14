// === What a conversation mode is ===
//
// A mode is the answer to "what is this conversation for". Until now there was
// one implicit answer — explain a material — spread across `prompts.ts`,
// `tools/index.ts` and `routes/realtime.ts`. A mode gathers the parts that
// differ between kinds of conversation into one object, so a second kind is a
// new file plus a line in `registry.ts` rather than an `if` in each of those
// three places.
//
// What a mode may change, and nothing else:
//   - whether the conversation needs a material before the microphone opens;
//   - which markdown document it keeps on screen, and what that document starts
//     as;
//   - which tools ride on top of the ones the materials already grant;
//   - the Role, the Conversation Flow and any extra prompt sections.
//
// What a mode may NOT change is everything that makes the app itself: the
// speech format, the language, the unclear-audio rule, the tool preamble. Those
// stay in `prompts.ts` and are shared, because a mode that could rewrite them
// would be a second application rather than a mode.

import type { ResolvedSource, ToolName } from "../types/index.js";

/**
 * The markdown document a mode keeps beside the conversation.
 *
 * Every field here is read by the browser, so every string is pt-BR: this is
 * the one part of a mode definition that reaches the screen verbatim.
 */
export interface ModeDocumentSpec {
  /** Heading of the sidebar. */
  title: string;
  /** What the panel says while the document is still empty. */
  placeholder: string;
  /**
   * Written into the conversation's document the moment it is created.
   *
   * A skeleton rather than an empty file, for the same reason a form shows its
   * fields before you fill them: it tells the user what the mode is going to
   * produce, and it gives the model a structure to edit section by section
   * instead of rewriting the whole file on every turn.
   */
  template: string;
  /** Whether the sidebar is open the first time the conversation is shown. */
  openByDefault: boolean;
  /**
   * How the browser renders the document: markdown through the shared renderer,
   * or a whole html-explainer file shown in a sandboxed iframe. Every mode
   * declares it — a missing field would silently fall back to markdown.
   */
  format: "markdown" | "html";
}

/** What the prompt sections get to look at. */
export interface ModePromptContext {
  sources: ResolvedSource[];
  /** The tool list this session is actually being minted with. */
  toolNames: readonly string[];
}

export interface ModeDefinition {
  /** Must equal the key it is registered under. Pinned by a test. */
  id: string;
  /** Shown on the mode picker. pt-BR. */
  label: string;
  /** One line under the label on the picker. pt-BR. */
  description: string;
  /**
   * A `lucide-react` icon name, resolved by the picker against a small
   * allowlist. Kept as data rather than as a component so that adding a mode
   * never means editing the frontend.
   */
  icon: string;
  /**
   * Whether the microphone is refused until a material is added.
   *
   * `false` is not a detail: `routes/realtime.ts` answers 409 on a conversation
   * with no sources, and a presentation is very often built from nothing but
   * the conversation itself.
   */
  requiresMaterial: boolean;
  /** The document on the right, or null for a mode that keeps none. */
  document: ModeDocumentSpec | null;
  /**
   * Tools this mode adds to whatever the materials already grant, by name.
   *
   * Names rather than schemas, so `tools/index.ts` stays the single place a
   * tool is defined — a mode that shipped its own schema would be a second
   * registry, and the flat-shape trap is exactly the kind of mistake that gets
   * made twice when there are two of them.
   */
  toolNames: readonly ToolName[];
  /**
   * Tools this mode may use even when the conversation has no materials, on
   * top of the shared MATERIAL_FREE_TOOLS. Research opens the microphone with
   * nothing attached, so web_search has to be free for it and stay gated for
   * everyone else.
   */
  materialFreeTools?: readonly ToolName[];
  /**
   * How many web searches may run at once in a conversation under this mode.
   * The shared tool allows one at a time; research dispatches a fan of
   * approved doubts, each becoming its own job card. Absent means one.
   */
  parallelSearches?: number;
  /** Replaces the shared Role & Objective section. */
  role: string;
  /** Replaces the shared Conversation Flow section. */
  flow: string;
  /** Extra sections, in order, appended after the Tools section. */
  sections(context: ModePromptContext): string[];
  /**
   * The line the UI shows before connecting, or null to keep the one derived
   * from the materials.
   */
  greeting(sources: ResolvedSource[]): string | null;
}

/** The serialisable half — everything `GET /api/modes` hands the browser. */
export interface ModeSummary {
  id: string;
  label: string;
  description: string;
  icon: string;
  requires_material: boolean;
  document: {
    title: string;
    placeholder: string;
    open_by_default: boolean;
    format: "markdown" | "html";
  } | null;
}

export function toModeSummary(mode: ModeDefinition): ModeSummary {
  return {
    id: mode.id,
    label: mode.label,
    description: mode.description,
    icon: mode.icon,
    requires_material: mode.requiresMaterial,
    document: mode.document
      ? {
          title: mode.document.title,
          placeholder: mode.document.placeholder,
          open_by_default: mode.document.openByDefault,
          format: mode.document.format,
        }
      : null,
  };
}
