import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// `app-setup-gate.test.tsx` mounts the gate and proves it points the right way.
// This file proves something a mounted gate cannot: that `App` reaches the
// preload bridge through one door. The bug it exists for was an inline
// `window.api?.isElectron` check — a second, laxer opinion on whether the
// bridge is usable, sitting next to the strict one. Both of the gate's
// directions can be correct while that is true, so no rendering test sees it.
//
// It lives in its own file because it reads source off disk, and
// `import.meta.url` is only a file URL in the default environment; the gate's
// rendering cases need happy-dom and opt into it per file.

/**
 * `source` with every comment removed — comments name what code must not do,
 * so the `// never window.api` that documents this rule would otherwise break
 * it.
 *
 * Scanned rather than matched. `replace(/^\s*\/\/.*$/gm, "")` leaves a trailing
 * `foo(); // window.api` behind, and a regex loose enough to catch that one
 * eats the `//` inside every URL and string literal in the file. The states
 * below are what tells those two apart.
 */
function stripComments(source: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    const next = source[i + 1];

    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += char;
      }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        i += 1;
      }
      continue;
    }
    if (state !== "code") {
      // Inside a string only its own quote closes it, and a backslash escapes
      // whatever follows — including that quote.
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === state) {
        state = "code";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      state = "line";
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block";
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") state = char;
    out += char;
  }

  return out;
}

describe("stripComments", () => {
  // The assertions below are `not.toContain`, which an over-eager stripper
  // passes for free — so the stripper gets its own cases first.

  it("drops a comment that trails real code", () => {
    // The case the old line-anchored regex missed: a single `// window.api` at
    // the end of any line in `App.tsx` failed the rule it was describing.
    expect(stripComments("connect(); // window.api\nnext();")).toBe(
      "connect(); \nnext();",
    );
  });

  it("drops whole-line and block comments", () => {
    expect(stripComments("  // window.api\nkeep();")).toBe("  \nkeep();");
    expect(stripComments("a();/* window.api */b();")).toBe("a();b();");
  });

  it("keeps the slashes that belong to strings", () => {
    expect(stripComments('const u = "https://x/y";')).toBe('const u = "https://x/y";');
    expect(stripComments("const u = `//not a comment`;")).toBe(
      "const u = `//not a comment`;",
    );
    expect(stripComments('const u = "a \\" // b";')).toBe('const u = "a \\" // b";');
  });
});

describe("App's route to the preload bridge", () => {
  const APP = fileURLToPath(new URL("../App.tsx", import.meta.url));

  function code(): string {
    return stripComments(readFileSync(APP, "utf8"));
  }

  it("is reading the file it claims to be reading", () => {
    // A `not.toContain` against an empty string passes.
    expect(code()).toContain("export function App");
  });

  it("asks the shared rule", () => {
    expect(code()).toContain("shouldShowSetup(");
  });

  it("reaches for the bridge nowhere else", () => {
    // Every `window.api` read goes through `electronBridge()`, which is the
    // only place that also checks the bridge is complete.
    expect(code()).not.toContain("window.api");
  });
});
