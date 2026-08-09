import { describe, it, expect } from "vitest";

import {
  COMPACT_MEDIA_QUERY,
  FIRST_RUN_ORDER,
  MD_BREAKPOINT_PX,
  firstRunSpec,
  micFailureAction,
  sessionAlert,
  shouldShowFirstRun,
} from "@/components/ui/mobile-shell";
import type { MicrophoneFailure } from "@/hooks/useRealtimeSession";

// There is no jsdom here, so the shell itself is not mounted: what is asserted
// is the part of it that decides. Where the layout flips, when the overlay that
// explains the app is owed, and which failure state the alert strip is showing —
// the three judgements that, when wrong, produce a phone with two layouts on
// screen at once, an onboarding card over a live call, or a certificate the user
// is told about but never handed.

// ---------------------------------------------------------------------------
// One breakpoint, two mechanisms
// ---------------------------------------------------------------------------

describe("the compact breakpoint", () => {
  it("sits at Tailwind's md", () => {
    // `--breakpoint-md: 48rem` at the default 16px root. The `md:` utilities in
    // the tree resolve to `min-width: 48rem`; this constant is the same edge
    // read from JavaScript, and the rail is mounted on one side of it while the
    // top bar and the sheets are mounted on the other.
    expect(MD_BREAKPOINT_PX).toBe(768);
  });

  it("stops short of the width where the md: utilities take over", () => {
    // A query of `max-width: 768px` would match at exactly 768px, where the
    // `md:` utilities also apply: the rail and the phone top bar would both be
    // on screen, which is the bug this file exists to prevent.
    const max = Number(/max-width: ([\d.]+)px/.exec(COMPACT_MEDIA_QUERY)?.[1]);
    expect(max).toBeLessThan(MD_BREAKPOINT_PX);
    expect(max).toBeGreaterThan(MD_BREAKPOINT_PX - 1);
  });
});

// ---------------------------------------------------------------------------
// First contact
// ---------------------------------------------------------------------------

const emptyPhone = {
  compact: true,
  materialCount: 0,
  conversationItemCount: 0,
  dismissed: false,
  othersPresent: false,
};

describe("shouldShowFirstRun", () => {
  it("covers an empty conversation on a phone", () => {
    expect(shouldShowFirstRun(emptyPhone)).toBe(true);
  });

  it("leaves the desktop alone", () => {
    // At md and up the rail, the picker and the transcript are all visible at
    // once, which is already an explanation of what the app is.
    expect(shouldShowFirstRun({ ...emptyPhone, compact: false })).toBe(false);
  });

  it("stays away once a material is attached", () => {
    expect(shouldShowFirstRun({ ...emptyPhone, materialCount: 1 })).toBe(false);
  });

  it("stays away once anything has been said", () => {
    // A resumed conversation arrives with its transcript and no material loaded
    // yet; the user who is reading it does not need to be told what the app is.
    expect(shouldShowFirstRun({ ...emptyPhone, conversationItemCount: 3 })).toBe(
      false,
    );
  });

  it("does not come back after it is waved away", () => {
    expect(shouldShowFirstRun({ ...emptyPhone, dismissed: true })).toBe(false);
  });

  it("never covers a conversation somebody else is already in", () => {
    // Presence is not wired yet — the caller passes false — but the gate is
    // here so that wiring it is one argument and not a redesign.
    expect(shouldShowFirstRun({ ...emptyPhone, othersPresent: true })).toBe(false);
  });

  it("offers the machine first", () => {
    // The only card that resolves with nothing typed and nothing chosen.
    expect(FIRST_RUN_ORDER[0]).toBe("machine");
  });
});

// ---------------------------------------------------------------------------
// What the overlay would add
// ---------------------------------------------------------------------------

describe("firstRunSpec", () => {
  it("needs nothing at all for the machine", () => {
    expect(firstRunSpec("machine", "", null)).toEqual({ kind: "machine" });
  });

  it("holds the call back until a repository is typed", () => {
    expect(firstRunSpec("repo", "   ", null)).toBeNull();
    expect(firstRunSpec("repo", " github.com/owner/repo ", null)).toEqual({
      kind: "repo",
      ref: "github.com/owner/repo",
    });
  });

  it("holds the call back until a document is chosen", () => {
    expect(firstRunSpec("markdown", "", null)).toBeNull();
    expect(
      firstRunSpec("markdown", "", { label: "spec.md", markdown: "# Spec" }),
    ).toEqual({ kind: "markdown", markdown: "# Spec", label: "spec.md" });
  });
});

// ---------------------------------------------------------------------------
// The session's three unhappy states
// ---------------------------------------------------------------------------

const calm = { micFailure: null, audioBlocked: false, callDropped: false };

describe("sessionAlert", () => {
  it("says nothing when nothing is wrong", () => {
    expect(sessionAlert(calm)).toBeNull();
  });

  it("puts the microphone above everything else", () => {
    // Nothing in a call can happen without it, so it outranks a dropped call
    // and blocked audio even when all three flags are set.
    expect(
      sessionAlert({
        micFailure: "denied",
        audioBlocked: true,
        callDropped: true,
      }),
    ).toEqual({ kind: "microphone", action: "retry" });
  });

  it("puts a dropped call above blocked audio", () => {
    // Audio unblocked on a call that no longer exists is a button that plays
    // silence.
    expect(
      sessionAlert({ ...calm, audioBlocked: true, callDropped: true }),
    ).toEqual({ kind: "call-dropped", action: "retry" });
  });

  it("offers to start the voice when the browser held it back", () => {
    expect(sessionAlert({ ...calm, audioBlocked: true })).toEqual({
      kind: "audio-blocked",
      action: "play",
    });
  });
});

describe("micFailureAction", () => {
  it("hands over the certificate on an insecure address", () => {
    // Retrying in place would fail identically: `isSecureContext` is fixed for
    // the life of the document, so the fix is the certificate and a reload.
    expect(micFailureAction("insecure-context")).toBe("certificate");
  });

  it("offers nothing to press when the engine withholds capture", () => {
    // A home-screen web app or an in-app browser on iOS. No amount of tapping
    // produces a microphone; the copy sends the user to Safari instead.
    expect(micFailureAction("unsupported")).toBe("none");
  });

  it("offers a retry for every failure a second tap can clear", () => {
    const recoverable: MicrophoneFailure[] = [
      "denied",
      "not-found",
      "busy",
      "aborted",
    ];
    for (const failure of recoverable) {
      expect(micFailureAction(failure)).toBe("retry");
    }
  });
});
