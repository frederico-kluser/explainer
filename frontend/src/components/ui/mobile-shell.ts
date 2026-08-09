import type { MicrophoneFailure } from "@/hooks/useRealtimeSession";
import type { SourceSpec } from "@/types";

/**
 * The judgements the compact layout makes, kept out of the components.
 *
 * This suite has no jsdom, so nothing here can be proven by rendering — the
 * same reason `mermaid-safety.ts` exists next door. What is provable is the
 * deciding: where the layout flips, when the first-contact overlay is owed, and
 * which of the session's failure states the user is looking at.
 */

/**
 * Tailwind's `md`, in pixels.
 *
 * Named once because two different mechanisms have to agree on it: the `md:`
 * utilities all over the tree, and the media query below that decides in
 * JavaScript whether the rail or the sheets are mounted. A disagreement of one
 * pixel puts the rail and the phone top bar on screen at the same time.
 */
export const MD_BREAKPOINT_PX = 768;

/** Everything strictly below `md`. The 0.02px step is the usual guard against
 *  a fractional viewport width falling into the gap between the query and the
 *  `md:` utilities, which resolve at `min-width: 48rem`. */
export const COMPACT_MEDIA_QUERY = `(max-width: ${MD_BREAKPOINT_PX - 0.02}px)`;

/** What the first-contact overlay looks at before it decides to appear. */
export interface FirstRunInput {
  /** Whether the compact layout is active. */
  compact: boolean;
  /** Materials already attached to the conversation. */
  materialCount: number;
  /** Turns and diagrams already on screen. */
  conversationItemCount: number;
  /** Whether the user has already waved the overlay away this session. */
  dismissed: boolean;
  /**
   * Whether somebody else is already in this conversation.
   *
   * Always `false` today: presence arrives with the shared-call work, and a
   * guess here would be worse than no guess — a second person's screen must not
   * be taken over by an onboarding card about picking a material.
   */
  othersPresent: boolean;
}

/**
 * Whether to cover the app with the first-contact overlay.
 *
 * Only in the compact layout: at `md` and up the rail, the picker and the
 * transcript are all on screen at once, which is already an explanation of what
 * the app is. On a phone none of that is visible, and what is left — a
 * directory listing of somebody else's computer — explains nothing.
 */
export function shouldShowFirstRun(input: FirstRunInput): boolean {
  if (!input.compact || input.dismissed || input.othersPresent) return false;
  return input.materialCount === 0 && input.conversationItemCount === 0;
}

/** Which session problem the user is looking at. */
export type SessionAlertKind = "microphone" | "audio-blocked" | "call-dropped";

/** The one thing the alert offers to do about it. */
export type SessionAlertAction = "certificate" | "retry" | "play" | "none";

export interface SessionAlert {
  kind: SessionAlertKind;
  action: SessionAlertAction;
}

/** The session flags the alert strip reads. */
export interface SessionAlertInput {
  micFailure: MicrophoneFailure | null;
  audioBlocked: boolean;
  callDropped: boolean;
}

/**
 * Which alert, if any, the session's flags mean — and what the button on it does.
 *
 * The branch is on `micFailure`, never on the message: the wording is copy and
 * will be rewritten, while whether a tap can fix the problem will not. Three of
 * the six failures are recoverable by tapping connect again; an insecure address
 * needs a certificate installed and the page reloaded, so retrying in place
 * would fail identically; and a WebKit that withholds capture outside Safari
 * offers nothing to press at all.
 *
 * Order matters. A microphone that cannot open outranks everything, because
 * nothing else in the call can happen without it; a dropped call outranks
 * blocked audio, because audio blocked on a call that no longer exists is a
 * button that plays silence.
 */
export function sessionAlert(input: SessionAlertInput): SessionAlert | null {
  if (input.micFailure) {
    return { kind: "microphone", action: micFailureAction(input.micFailure) };
  }
  if (input.callDropped) return { kind: "call-dropped", action: "retry" };
  if (input.audioBlocked) return { kind: "audio-blocked", action: "play" };
  return null;
}

/** The affordance each microphone failure earns. Exported for the table test. */
export function micFailureAction(failure: MicrophoneFailure): SessionAlertAction {
  switch (failure) {
    case "insecure-context":
      return "certificate";
    case "unsupported":
      return "none";
    default:
      return "retry";
  }
}

/** What the user picked on the first-contact overlay. */
export type FirstRunChoice = "machine" | "repo" | "markdown";

/** The three cards, in the order they are offered. */
export const FIRST_RUN_ORDER: readonly FirstRunChoice[] = [
  "machine",
  "repo",
  "markdown",
] as const;

/** A markdown file the user picked on the overlay, already read. */
export interface FirstRunDocument {
  label: string;
  markdown: string;
}

/**
 * The material the overlay would add, or `null` while it is still incomplete.
 *
 * "Este computador" is first on the card list and the only one that resolves
 * with nothing typed and nothing chosen — on a phone that is the difference
 * between a first call and a bounce.
 */
export function firstRunSpec(
  choice: FirstRunChoice,
  repoRef: string,
  document: FirstRunDocument | null,
): SourceSpec | null {
  if (choice === "machine") return { kind: "machine" };
  if (choice === "repo") {
    const ref = repoRef.trim();
    return ref ? { kind: "repo", ref } : null;
  }
  return document
    ? { kind: "markdown", markdown: document.markdown, label: document.label }
    : null;
}
