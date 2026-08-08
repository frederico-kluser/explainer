import { describe, it, expect } from "vitest";

import {
  MERMAID_SECURITY_CONFIG,
  describeRenderFailure,
  hasConfigDirective,
  hasUnsafeFrontmatter,
  isForbiddenSvgTag,
  isUnsafeSvgAttribute,
  nextRenderId,
  renderDiagramSource,
  sanitizeStyleText,
  sanitizeSvgElement,
  sourceRefusal,
} from "@/components/ui/mermaid-safety";

// The suite has no jsdom, so the component itself is not mounted here. What is
// asserted instead is the part of it that decides: the config mermaid is
// initialised with, the guards on the source, the filter applied to the SVG,
// and the promise that must never reject. Those are the security invariants;
// the component only wires them to the DOM.

// ---------------------------------------------------------------------------
// The config is an invariant, not a preference
// ---------------------------------------------------------------------------

describe("MERMAID_SECURITY_CONFIG", () => {
  it('renders under securityLevel "strict"', () => {
    // "loose" is the setting behind GHSA-wvh5-6vjm-23qh; "sandbox" renders
    // labels inside escaped <p> tags since 11.10.0 (mermaid#6889).
    expect(MERMAID_SECURITY_CONFIG.securityLevel).toBe("strict");
  });

  it("never scans the document on its own", () => {
    expect(MERMAID_SECURITY_CONFIG.startOnLoad).toBe(false);
  });

  it("keeps labels out of HTML, at the root and in flowcharts", () => {
    expect(MERMAID_SECURITY_CONFIG.htmlLabels).toBe(false);
    expect(MERMAID_SECURITY_CONFIG.flowchart.htmlLabels).toBe(false);
  });

  it("freezes htmlLabels and flowchart against %%{init}%% overrides", () => {
    // Mermaid's own `secure` default covers neither, and re-enabling
    // flowchart.htmlLabels through a directive was by itself enough to bypass
    // the label sanitiser — GitLab #332528 / HackerOne #1212822.
    expect(MERMAID_SECURITY_CONFIG.secure).toContain("htmlLabels");
    expect(MERMAID_SECURITY_CONFIG.secure).toContain("flowchart");
    expect(MERMAID_SECURITY_CONFIG.secure).toContain("securityLevel");
  });

  it("freezes every key that ends up inside the SVG's stylesheet", () => {
    // `themeCSS` is raw CSS copied into the <style> of the rendered SVG, and
    // mermaid's own directive sanitiser only drops strings holding `<`, `>` or
    // `url(data:` — so `themeCSS: "#x{background:url(https://evil/p)}"` used to
    // survive and fetch. The other three are interpolated into the same
    // stylesheet.
    for (const key of [
      "themeCSS",
      "themeVariables",
      "theme",
      "fontFamily",
      "altFontFamily",
    ]) {
      expect(MERMAID_SECURITY_CONFIG.secure).toContain(key);
    }
  });

  it("suppresses mermaid's own error graphic, so ours is what shows", () => {
    expect(MERMAID_SECURITY_CONFIG.suppressErrorRendering).toBe(true);
  });

  it("cannot be weakened by mutating the shared object", () => {
    expect(Object.isFrozen(MERMAID_SECURITY_CONFIG)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The source is refused before it reaches the parser
// ---------------------------------------------------------------------------

describe("sourceRefusal", () => {
  it("draws an ordinary diagram", () => {
    expect(sourceRefusal("flowchart LR\n  A --> B")).toBeNull();
  });

  it("refuses a %%{init}%% directive, whatever it sets", () => {
    const attack =
      '%%{init: {"securityLevel": "loose", "flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n  A --> B';
    expect(hasConfigDirective(attack)).toBe(true);
    expect(sourceRefusal(attack)).toMatch(/reconfigurar/);
  });

  it("refuses the spaced spelling of the directive", () => {
    expect(hasConfigDirective('%% { init: {"theme":"dark"} }%%')).toBe(true);
  });

  it("leaves a bare %% comment alone", () => {
    expect(hasConfigDirective("flowchart LR\n%% um comentario\n  A --> B")).toBe(
      false,
    );
  });

  it("refuses an empty source instead of drawing nothing", () => {
    expect(sourceRefusal("   \n ")).toBe("O diagrama chegou vazio.");
  });
});

describe("hasUnsafeFrontmatter", () => {
  // Every spelling below was measured reaching the renderer past a check that
  // looked for the bare key at the start of a line (`/^\s*config\s*:/m`). YAML
  // accepts all of them as the key `config`; the pattern recognised one.
  const spellings: [string, string][] = [
    ["bare key", "config:\n  securityLevel: loose"],
    ["double-quoted key", '"config":\n  securityLevel: loose'],
    ["single-quoted key", "'config':\n  securityLevel: loose"],
    [
      "flow mapping",
      "{config: {securityLevel: loose, flowchart: {htmlLabels: true}}}",
    ],
    ["JSON", '{"config":{"securityLevel":"loose"}}'],
    // js-yaml resolves escapes in double-quoted scalars, so this key contains
    // none of the letters of the word it spells. No textual blocklist wins here,
    // which is why the check is an allowlist.
    ["unicode-escaped key", '"\\u0063onfig":\n  securityLevel: loose'],
  ];

  for (const [name, body] of spellings) {
    it(`refuses the ${name} spelling of config`, () => {
      const attack = `---\n${body}\n---\nflowchart LR\n  A --> B`;
      expect(hasUnsafeFrontmatter(attack)).toBe(true);
      expect(sourceRefusal(attack)).toMatch(/cabeçalho/);
    });
  }

  it("refuses a themeCSS block, the one that reached the network", () => {
    const attack =
      '---\n{config: {themeCSS: "#x{background:url(https://evil.example/p)}"}}\n---\nflowchart LR\n  A --> B';
    expect(sourceRefusal(attack)).toMatch(/cabeçalho/);
  });

  it("still draws the frontmatter a diagram legitimately carries", () => {
    const legit = "---\ntitle: Fluxo de compra\n---\nflowchart LR\n  A --> B";
    expect(hasUnsafeFrontmatter(legit)).toBe(false);
    expect(sourceRefusal(legit)).toBeNull();

    const both =
      "---\ntitle: Fluxo\ndisplayMode: compact\n# um comentario\n---\ngantt\n  title x";
    expect(hasUnsafeFrontmatter(both)).toBe(false);
  });

  it("reads CRLF the way mermaid does, not the way the raw string looks", () => {
    // `preprocessDiagram` normalises `\r\n` to `\n` *before* extracting
    // frontmatter. A check reading the raw string disagrees with mermaid about
    // where every line ends, and a parser differential in front of a security
    // check is the check being wrong.
    expect(
      hasUnsafeFrontmatter("---\r\nconfig:\r\n  securityLevel: loose\r\n---\r\nflowchart LR\r\n A --> B"),
    ).toBe(true);
    expect(
      hasUnsafeFrontmatter("---\r\ntitle: Fluxo\r\n---\r\nflowchart LR\r\n A --> B"),
    ).toBe(false);
  });

  it("refuses the indented spelling mermaid's own regex accepts", () => {
    expect(
      hasUnsafeFrontmatter("  ---\n  config:\n    theme: x\n  ---\nflowchart LR\n A --> B"),
    ).toBe(true);
  });

  it("leaves a source with no frontmatter alone", () => {
    expect(hasUnsafeFrontmatter("flowchart LR\n  A --> B")).toBe(false);
    // An opener with no closer is not frontmatter to mermaid either.
    expect(hasUnsafeFrontmatter("---\nconfig:\nflowchart LR\n A --> B")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The SVG filter, as decisions
// ---------------------------------------------------------------------------

describe("isForbiddenSvgTag", () => {
  it("drops script and foreignObject, in any casing", () => {
    // A <script> parsed by DOMParser is inert only until it is adopted into the
    // live document, which is exactly what the component does next.
    expect(isForbiddenSvgTag("script")).toBe(true);
    expect(isForbiddenSvgTag("SCRIPT")).toBe(true);
    expect(isForbiddenSvgTag("foreignObject")).toBe(true);
    expect(isForbiddenSvgTag("iframe")).toBe(true);
  });

  it("drops the whole SMIL family, not half of it", () => {
    // `set` was on the list and `animate` was not, which is the same attack
    // with a different tag: an animation element rewrites an attribute of its
    // parent after the walk has already inspected it.
    for (const tag of [
      "set",
      "animate",
      "animateTransform",
      "animateMotion",
      "mpath",
      "discard",
    ]) {
      expect(isForbiddenSvgTag(tag)).toBe(true);
    }
  });

  it("drops the elements that pull content in from elsewhere", () => {
    expect(isForbiddenSvgTag("use")).toBe(true);
    expect(isForbiddenSvgTag("feImage")).toBe(true);
  });

  it("keeps what a diagram is made of", () => {
    for (const tag of ["svg", "g", "path", "text", "rect", "marker", "style"]) {
      expect(isForbiddenSvgTag(tag)).toBe(false);
    }
  });
});

describe("isUnsafeSvgAttribute", () => {
  const plain = (localName: string, value: string) =>
    isUnsafeSvgAttribute({ localName, namespaceURI: null, value });

  it("drops every inline handler", () => {
    expect(plain("onclick", "alert(1)")).toBe(true);
    expect(plain("ONLOAD", "alert(1)")).toBe(true);
  });

  it("drops a script URL, including the obfuscated spellings", () => {
    expect(plain("href", "javascript:alert(1)")).toBe(true);
    expect(plain("href", "  javascript:alert(1)")).toBe(true);
    // A browser strips the control characters before resolving the URL, so a
    // prefix check on the raw value would pass this through.
    expect(plain("href", "java\tscript:alert(1)")).toBe(true);
    expect(plain("href", "data:text/html,<script>")).toBe(true);
  });

  it("judges by local name, so the prefix cannot hide the attribute", () => {
    // The document chooses the prefix. `zz:href` bound to the xlink namespace is
    // the same live link as `xlink:href`, and a check comparing the qualified
    // name `"xlink:href"` never sees it.
    const xlink = "http://www.w3.org/1999/xlink";
    expect(
      isUnsafeSvgAttribute({
        localName: "href",
        namespaceURI: xlink,
        value: "javascript:alert(1)",
      }),
    ).toBe(true);
    expect(
      isUnsafeSvgAttribute({
        localName: "onclick",
        namespaceURI: "urn:whatever",
        value: "alert(1)",
      }),
    ).toBe(true);
  });

  it("keeps the links a diagram legitimately carries", () => {
    expect(plain("href", "https://example.com")).toBe(false);
    expect(
      isUnsafeSvgAttribute({
        localName: "href",
        namespaceURI: "http://www.w3.org/1999/xlink",
        value: "#arrowhead",
      }),
    ).toBe(false);
    expect(plain("d", "M0 0 L10 10")).toBe(false);
    expect(plain("class", "node default")).toBe(false);
  });

  it("drops a style that smuggles a payload through url()", () => {
    expect(plain("style", "fill:url(data:text/html,x)")).toBe(true);
    expect(plain("style", "fill:#fff;stroke:#000")).toBe(false);
  });
});

describe("sanitizeStyleText", () => {
  it("cuts the beacon out of a themeCSS payload", () => {
    const cleaned = sanitizeStyleText(
      "#x{background:url(https://evil.example/p)}",
    );
    expect(cleaned).not.toContain("evil.example");
  });

  it("keeps the fragment references SVG points at itself with", () => {
    expect(sanitizeStyleText(".edge{marker-end:url(#arrowhead)}")).toContain(
      "url(#arrowhead)",
    );
  });

  it("removes @import in both of its spellings", () => {
    expect(sanitizeStyleText('@import "https://evil.example/a.css";')).not.toContain(
      "evil.example",
    );
    expect(
      sanitizeStyleText("@import url(https://evil.example/a.css);"),
    ).not.toContain("evil.example");
  });

  it("covers image-set, which fetches without spelling url()", () => {
    expect(
      sanitizeStyleText('#x{background:image-set("https://evil.example/p" 1x)}'),
    ).not.toContain("evil.example");
  });

  it("drops the whole stylesheet when something able to fetch survives", () => {
    // Fail closed: an unbalanced paren defeats the rewrite, and an unstyled
    // diagram beats a diagram that phones home.
    expect(sanitizeStyleText("#x{background:url(https://evil.example/(p)}")).toBe(
      "",
    );
  });

  it("leaves an ordinary mermaid stylesheet alone", () => {
    const css = "#g .node rect{fill:#262626;stroke:#525252}";
    expect(sanitizeStyleText(css)).toBe(css);
  });
});

// ---------------------------------------------------------------------------
// The walk that actually runs in production
// ---------------------------------------------------------------------------
//
// `sanitizeSvgElement` is the function the component calls on every diagram, and
// the two holes an adversarial review found — a namespaced `href` under an
// unexpected prefix, and `<animate>` missing from a list that already held
// `<set>` — were both inside it, in the half no test touched. A review replacing
// the whole function with the identity left the suite green.
//
// The suite runs in Node with no jsdom, and adding one is a dependency this
// change is not allowed to take. What follows implements exactly the surface the
// walk touches, with the distinction the browser draws and a qualified-name
// check does not: an attribute has a namespace URI and a local name, and its
// prefix is whatever the document said. A double storing only the string
// `"zz:href"` could not express the bug, so it stores both.

const XLINK_NS = "http://www.w3.org/1999/xlink";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

interface AttrInit {
  /** The qualified name, exactly as the document writes it. */
  name: string;
  value: string;
  /** What the prefix is bound to. `null` for an unprefixed attribute. */
  ns?: string | null;
}

interface NodeInit {
  tag: string;
  attrs?: AttrInit[];
  text?: string;
  children?: NodeInit[];
}

function localNameOf(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

class TestAttr {
  readonly name: string;
  readonly value: string;
  readonly namespaceURI: string | null;

  constructor(init: AttrInit) {
    this.name = init.name;
    this.value = init.value;
    this.namespaceURI = init.ns ?? null;
  }

  get localName(): string {
    return localNameOf(this.name);
  }
}

class TestElement {
  readonly localName: string;
  attributes: TestAttr[];
  kids: TestElement[];
  textContent: string;
  parent: TestElement | null = null;

  constructor(init: NodeInit) {
    this.localName = localNameOf(init.tag);
    this.attributes = (init.attrs ?? []).map((attr) => new TestAttr(attr));
    this.textContent = init.text ?? "";
    this.kids = (init.children ?? []).map((child) => {
      const element = new TestElement(child);
      element.parent = this;
      return element;
    });
  }

  get children(): TestElement[] {
    return this.kids;
  }

  removeAttribute(name: string): void {
    this.attributes = this.attributes.filter((attr) => attr.name !== name);
  }

  removeAttributeNS(namespaceURI: string | null, localName: string): void {
    this.attributes = this.attributes.filter(
      (attr) =>
        !(attr.namespaceURI === namespaceURI && attr.localName === localName),
    );
  }

  remove(): void {
    const parent = this.parent;
    if (!parent) return;
    parent.kids = parent.kids.filter((child) => child !== this);
  }

  /** Every qualified attribute name still on the tree, root included. */
  attributeNames(): string[] {
    return [
      ...this.attributes.map((attr) => attr.name),
      ...this.kids.flatMap((child) => child.attributeNames()),
    ];
  }

  /** Every local tag name still on the tree, root included. */
  tagNames(): string[] {
    return [this.localName, ...this.kids.flatMap((child) => child.tagNames())];
  }

  /** Everything a browser would resolve or run, as one string to search. */
  serialize(): string {
    const attrs = this.attributes
      .map((attr) => ` ${attr.name}="${attr.value}"`)
      .join("");
    const inner =
      this.textContent + this.kids.map((child) => child.serialize()).join("");
    return `<${this.localName}${attrs}>${inner}</${this.localName}>`;
  }
}

function sanitized(init: NodeInit): TestElement {
  const root = new TestElement(init);
  sanitizeSvgElement(root as unknown as Element);
  return root;
}

describe("sanitizeSvgElement", () => {
  it("removes a namespaced href whatever prefix the document chose", () => {
    // Vector 1: the qualified name is `zz:href`, the namespace is xlink, and the
    // browser resolves the link by namespace. Measured surviving the old walk
    // and firing on a synthetic click.
    const root = sanitized({
      tag: "svg",
      children: [
        {
          tag: "a",
          attrs: [
            { name: "xmlns:zz", value: XLINK_NS, ns: XMLNS_NS },
            { name: "zz:href", value: "javascript:alert(1)", ns: XLINK_NS },
          ],
          children: [{ tag: "text", text: "clique" }],
        },
      ],
    });

    expect(root.attributeNames()).not.toContain("zz:href");
    expect(root.serialize()).not.toContain("javascript:");
  });

  it("removes <animate>, which rewrites an attribute after the walk", () => {
    // Vector 2: the <a> passes inspection with a harmless href, and the
    // animation swaps it for a script URL once the tree is live.
    const root = sanitized({
      tag: "svg",
      children: [
        {
          tag: "a",
          attrs: [{ name: "href", value: "#safe" }],
          children: [
            {
              tag: "animate",
              attrs: [
                { name: "attributeName", value: "href" },
                { name: "values", value: "javascript:alert(1)" },
              ],
            },
          ],
        },
      ],
    });

    expect(root.tagNames()).not.toContain("animate");
    expect(root.serialize()).not.toContain("javascript:");
    // The legitimate link is untouched.
    expect(root.serialize()).toContain('href="#safe"');
  });

  it("removes <animate> aimed at a namespaced attribute too", () => {
    // Vector 3.
    const root = sanitized({
      tag: "svg",
      children: [
        {
          tag: "animate",
          attrs: [
            { name: "attributeName", value: "xlink:href" },
            { name: "values", value: "javascript:alert(1)" },
          ],
        },
      ],
    });

    expect(root.tagNames()).toEqual(["svg"]);
  });

  it("removes <set>, the half of the family that was already covered", () => {
    // Vector 4.
    const root = sanitized({
      tag: "svg",
      children: [
        {
          tag: "set",
          attrs: [
            { name: "attributeName", value: "href" },
            { name: "to", value: "javascript:alert(1)" },
          ],
        },
      ],
    });

    expect(root.tagNames()).toEqual(["svg"]);
  });

  it("removes script and foreignObject wherever they are nested", () => {
    const root = sanitized({
      tag: "svg",
      children: [
        {
          tag: "g",
          children: [
            { tag: "script", text: "alert(1)" },
            {
              tag: "foreignObject",
              children: [{ tag: "iframe", attrs: [{ name: "src", value: "//evil.example" }] }],
            },
            { tag: "rect" },
          ],
        },
      ],
    });

    expect(root.tagNames()).toEqual(["svg", "g", "rect"]);
  });

  it("recurses, so a handler four levels down is still removed", () => {
    const root = sanitized({
      tag: "svg",
      children: [
        {
          tag: "g",
          children: [
            {
              tag: "g",
              children: [
                {
                  tag: "text",
                  attrs: [
                    { name: "onload", value: "alert(1)" },
                    { name: "class", value: "label" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(root.attributeNames()).toEqual(["class"]);
  });

  it("removes the obfuscated and data: URLs on surviving elements", () => {
    const root = sanitized({
      tag: "svg",
      children: [
        { tag: "a", attrs: [{ name: "href", value: "java\tscript:alert(1)" }] },
        { tag: "image", attrs: [{ name: "href", value: "data:text/html,<svg>" }] },
        {
          tag: "rect",
          attrs: [{ name: "style", value: "fill:url(data:image/svg+xml,x)" }],
        },
      ],
    });

    expect(root.attributeNames()).toEqual([]);
  });

  it("cleans the text of a <style>, which is not an attribute", () => {
    // The end of the chain that worked: `themeCSS` from an imported memory file
    // lands inside this element, and the walk used to keep it verbatim because
    // a diagram without its stylesheet is unreadable.
    const root = sanitized({
      tag: "svg",
      children: [
        {
          tag: "style",
          text: "#x{background:url(https://evil.example/p)}.edge{marker-end:url(#arrowhead)}",
        },
      ],
    });

    expect(root.serialize()).not.toContain("evil.example");
    expect(root.serialize()).toContain("url(#arrowhead)");
  });

  it("cleans the root element's own attributes", () => {
    const root = sanitized({
      tag: "svg",
      attrs: [
        { name: "onload", value: "alert(1)" },
        { name: "viewBox", value: "0 0 10 10" },
      ],
    });

    expect(root.attributeNames()).toEqual(["viewBox"]);
  });

  it("leaves an ordinary diagram intact", () => {
    const root = sanitized({
      tag: "svg",
      attrs: [{ name: "viewBox", value: "0 0 100 50" }],
      children: [
        {
          tag: "g",
          attrs: [{ name: "class", value: "node" }],
          children: [
            { tag: "rect", attrs: [{ name: "fill", value: "#262626" }] },
            { tag: "text", text: "A" },
            {
              tag: "a",
              attrs: [{ name: "href", value: "https://example.com" }],
            },
          ],
        },
      ],
    });

    expect(root.tagNames()).toEqual(["svg", "g", "rect", "text", "a"]);
    expect(root.attributeNames()).toEqual([
      "viewBox",
      "class",
      "fill",
      "href",
    ]);
  });
});

// ---------------------------------------------------------------------------
// A render that throws — or never comes back — has to become something readable
// ---------------------------------------------------------------------------

describe("renderDiagramSource", () => {
  it("returns the svg when the render succeeds", async () => {
    const outcome = await renderDiagramSource("flowchart LR\n A --> B", () =>
      Promise.resolve({ svg: "<svg></svg>" }),
    );
    expect(outcome).toEqual({ svg: "<svg></svg>", error: null });
  });

  it("turns a thrown parser error into a visible message, and does not reject", async () => {
    // The backend validates the source structurally, which proves it is a
    // diagram of an allowed kind — not that mermaid can draw it. Without this,
    // the user gets a hole in the page and no reason for it.
    const outcome = await renderDiagramSource("flowchart LR\n A --> B", () =>
      Promise.reject(new Error("Parse error on line 4: expected NODE_STRING")),
    );
    expect(outcome.svg).toBeNull();
    expect(outcome.error).toContain("Não consegui desenhar este diagrama");
    expect(outcome.error).toContain("line 4");
  });

  it("survives a rejection that is not an Error", async () => {
    const outcome = await renderDiagramSource("flowchart LR\n A --> B", () =>
      Promise.reject("boom"),
    );
    expect(outcome.svg).toBeNull();
    expect(outcome.error).toContain("boom");
  });

  it("survives a render that throws synchronously", async () => {
    const outcome = await renderDiagramSource("flowchart LR\n A --> B", () => {
      throw new Error("chunk load failed");
    });
    expect(outcome.svg).toBeNull();
    expect(outcome.error).toContain("chunk load failed");
  });

  it("gives up on a render that never comes back", async () => {
    // Without a ceiling the card sits on "Desenhando o diagrama…" for the life
    // of the page — a spinner that means broken and looks like almost.
    const outcome = await renderDiagramSource(
      "flowchart LR\n A --> B",
      () => new Promise(() => {}),
      20,
    );
    expect(outcome.svg).toBeNull();
    expect(outcome.error).toMatch(/demorou demais/);
  });

  it("does not fire the ceiling on a render that answers in time", async () => {
    const outcome = await renderDiagramSource(
      "flowchart LR\n A --> B",
      () => Promise.resolve({ svg: "<svg/>" }),
      20,
    );
    expect(outcome).toEqual({ svg: "<svg/>", error: null });
  });

  it("refuses a directive without ever calling the renderer", async () => {
    let called = false;
    const outcome = await renderDiagramSource(
      '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n A --> B',
      () => {
        called = true;
        return Promise.resolve({ svg: "<svg/>" });
      },
    );
    expect(called).toBe(false);
    expect(outcome.svg).toBeNull();
    expect(outcome.error).toMatch(/reconfigurar/);
  });

  it("refuses a frontmatter payload without ever calling the renderer", async () => {
    let called = false;
    const outcome = await renderDiagramSource(
      '---\n{config: {themeCSS: "#x{background:url(https://evil.example/p)}"}}\n---\nflowchart LR\n A --> B',
      () => {
        called = true;
        return Promise.resolve({ svg: "<svg/>" });
      },
    );
    expect(called).toBe(false);
    expect(outcome.svg).toBeNull();
    expect(outcome.error).toMatch(/cabeçalho/);
  });
});

describe("describeRenderFailure", () => {
  it("always produces something to show", () => {
    expect(describeRenderFailure(undefined)).toBe(
      "Não consegui desenhar este diagrama.",
    );
    expect(describeRenderFailure({})).toBe(
      "Não consegui desenhar este diagrama.",
    );
  });

  it("clips a runaway message instead of flooding the card", () => {
    const message = describeRenderFailure(new Error("x".repeat(5000)));
    expect(message.length).toBeLessThan(500);
  });
});

describe("nextRenderId", () => {
  it("never repeats, because mermaid injects a node under this id", () => {
    const ids = new Set([
      nextRenderId(),
      nextRenderId(),
      nextRenderId(),
      nextRenderId(),
    ]);
    expect(ids.size).toBe(4);
  });

  it("stays valid inside a CSS selector", () => {
    expect(nextRenderId()).toMatch(/^[A-Za-z][\w-]*$/);
  });
});
