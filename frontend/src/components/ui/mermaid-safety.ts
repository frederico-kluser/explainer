import type { MermaidConfig } from "mermaid";

// === What makes an LLM-authored diagram safe to put on screen ===
//
// This module holds the render contract on its own, away from the component,
// because every value in it is a security decision and because the suite has no
// DOM: the parts that decide are pure functions and are covered by
// `src/__tests__/mermaid-diagram.test.ts`, while the component only wires them
// to the browser.
//
// Research (Brave, 2026-08) — five findings, each of which the config below
// answers:
//
//   1. GHSA-r4hj-mc62-jmwj (docmost, 2026-01-21) describes this exact component:
//      "renders attacker-controlled Mermaid diagrams using mermaid.render(),
//      then injects the returned SVG/HTML into the DOM via
//      dangerouslySetInnerHTML without sanitization. Mermaid per-diagram
//      %%{init}%% directives allow overriding securityLevel and enabling
//      htmlLabels, enabling arbitrary HTML/JS execution for any viewer."
//      Three separate mistakes in one sentence: a config the source can undo,
//      an unsanitised injection, and trusting the producer.
//   2. GHSA-wvh5-6vjm-23qh (oneuptime, 2026-03-12): `securityLevel: "loose"` is
//      the hole; `"strict"` is what strips the interactive bindings (`click`,
//      `callback`, `href`).
//   3. GitLab #332528 / HackerOne #1212822: their frozen-key list held
//      `securityLevel` but not `flowchart.htmlLabels`, and turning htmlLabels
//      back on was by itself enough to bypass the label sanitiser. Confirmed
//      still reachable here: mermaid 11.16.1 ships
//      `secure: ["secure","securityLevel","startOnLoad","maxTextSize","suppressErrorRendering","maxEdges"]`
//      and its directive sanitiser deletes only *top-level* keys named in that
//      list — so `flowchart` has to be in it by name, not just `htmlLabels`.
//   4. GHSL-2021-1058 (GitHub Security Lab): with htmlLabels off, mermaid skips
//      part of its *own* sanitisation of labels. Turning htmlLabels off is not
//      the same as the output being clean, which is why the SVG is still walked
//      and stripped below before it reaches the document.
//   5. mermaid issue #6889: `securityLevel: "sandbox"` renders labels inside
//      escaped `<p>` tags as of 11.10.0 — visibly broken. `"strict"` is the
//      level that both draws and defends.
//
// Why any of it is reachable, precisely — an adversarial review measured this
// end to end and it is worth writing down rather than paraphrasing:
// `backend/src/services/memory.ts` validates an imported diagram with
// `validateImportedDiagram`, which checks `kind` against a closed list and
// `source` for being a string. It never calls `validateMermaid`. So the
// `source` inside an imported `MemoryFile.diagrams` reaches this module exactly
// as the file's author wrote it, with none of the 18 vectors the backend's own
// generator path holds down. The file arrives from another machine, chosen by
// the user from a file picker. That is the threat model, and it is not
// hypothetical.
//
// Three layers answer it, and each one is only worth the part it actually does:
//
//   Layer 1 — the source is refused before mermaid sees it (`sourceRefusal`).
//   Layer 2 — `secure` names the keys a directive or frontmatter block may not
//             reach even if layer 1 is bypassed.
//   Layer 3 — the SVG mermaid returns is walked and stripped before it is
//             adopted into the live document.
//
// Layer 3 is explicitly *not* a claim that mermaid's output is dirty. Mermaid
// runs DOMPurify over its own output at every security level except "loose",
// and today that filter drops `script`, `animate` and `use` on its own. Layer 3
// exists because that filter is a dependency: it is one `npm update`, one
// config merge or one `securityLevel` regression away from not running, and the
// walk below is what makes those failures survivable rather than fatal.

/**
 * The one configuration `mermaid.initialize` is ever called with.
 *
 * Frozen so a later feature cannot weaken a shared object by mutating it, and
 * asserted field by field in the test — these are invariants, not preferences.
 */
export const MERMAID_SECURITY_CONFIG = Object.freeze({
  // Never scan the document for `.mermaid` nodes. Every render here is an
  // explicit call on a source this module has already inspected; an auto-scan
  // would draw whatever happened to land in the DOM.
  startOnLoad: false,

  // Strips click/callback/href bindings and escapes label text.
  securityLevel: "strict",

  // Labels become SVG <text>, never a foreignObject full of HTML. Set at the
  // root because the root value takes precedence over any diagram-specific one.
  htmlLabels: false,
  flowchart: { htmlLabels: false, useMaxWidth: true },

  // The keys a `%%{init: ...}%%` directive or a frontmatter `config:` block must
  // not reach. Mermaid deletes exactly the *top-level* keys named here from the
  // parsed directive (`sanitize`, config.ts), and `assignWithDepth` merges arrays
  // by push, so this list is added to mermaid's default rather than replacing it.
  //
  // Mermaid's own default omits `htmlLabels` and `flowchart` — finding 3 — and
  // also omits every key that ends up inside the `<style>` block of the SVG.
  // That second gap is the one that mattered: `themeCSS` is raw CSS, copied into
  // the stylesheet verbatim, and mermaid's `sanitize` only drops strings holding
  // `<`, `>` or `url(data:`. `themeCSS: "#x{background:url(https://evil/p)}"`
  // holds none of those, so it survived and the browser fetched the URL when the
  // diagram was displayed. `themeVariables`, `fontFamily` and `altFontFamily` are
  // interpolated into the same stylesheet and can break out of a declaration the
  // same way; `theme` picks which of them apply. All five are frozen here.
  secure: [
    "secure",
    "securityLevel",
    "startOnLoad",
    "maxTextSize",
    "suppressErrorRendering",
    "maxEdges",
    "htmlLabels",
    "flowchart",
    "theme",
    "themeCSS",
    "themeVariables",
    "fontFamily",
    "altFontFamily",
  ],

  maxTextSize: 50_000,

  // Parser complaints belong in this component's error state, not in a console
  // nobody reading the diagram has open.
  logLevel: "fatal",

  // Without this, a failed parse leaves mermaid's own unstyled "Syntax error"
  // graphic in the DOM, which replaces our error state with something that
  // neither matches the app nor says what went wrong.
  suppressErrorRendering: true,

  // "base" plus explicit variables, rather than the built-in "dark": the app's
  // dark palette is fixed (`index.html` sets `class="dark"` and there is no
  // switcher), so the diagram is tuned to it once. Hex rather than the
  // stylesheet's `oklch()` because mermaid runs its own colour maths over these.
  theme: "base",
  themeVariables: {
    darkMode: true,
    background: "transparent",
    // The dark block of `index.css`, as hex: --card, --foreground, --border,
    // --muted-foreground, --background.
    primaryColor: "#262626",
    primaryTextColor: "#fafafa",
    primaryBorderColor: "#525252",
    secondaryColor: "#404040",
    tertiaryColor: "#1f1f1f",
    lineColor: "#a3a3a3",
    textColor: "#e5e5e5",
    mainBkg: "#262626",
    nodeBorder: "#525252",
    clusterBkg: "#1a1a1a",
    clusterBorder: "#404040",
    titleColor: "#fafafa",
    edgeLabelBackground: "#0a0a0a",
    fontSize: "14px",
  },
  fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif',
} satisfies MermaidConfig);

/**
 * A `%%{ ... }%%` directive anywhere in the source.
 *
 * The directive is the mechanism behind findings 1 and 3, and nothing the
 * generator is allowed to emit needs one — the prompt forbids them and the
 * backend rejects the ones naming a security key. Refusing every directive
 * rather than the dangerous keys is the version that will not need editing when
 * mermaid adds the next overridable option.
 */
const CONFIG_DIRECTIVE = /%%\s*\{/;

export function hasConfigDirective(source: string): boolean {
  return CONFIG_DIRECTIVE.test(source);
}

/**
 * `\r\n` and `\r` become `\n`, exactly as mermaid does it.
 *
 * `preprocessDiagram` runs `cleanupText` (`code.replace(/\r\n?/g, "\n")`) before
 * it extracts frontmatter, so a check that reads the raw string and a mermaid
 * that reads the normalised one disagree about where a line ends. That gap is a
 * parser differential, and a parser differential in front of a security check is
 * the check being wrong on CRLF input.
 */
function normalizeNewlines(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

/**
 * Mermaid's own frontmatter regex, copied byte for byte from
 * `src/diagram-api/frontmatter.ts` (mermaid 11.16.1).
 *
 * Copied rather than approximated for the reason above: whatever this matches
 * has to be the same block mermaid will hand to js-yaml, including the indented
 * spelling, where the closing `---` must repeat the opener's indent.
 */
const FRONT_MATTER = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s;

/**
 * The only frontmatter lines that are allowed to exist.
 *
 * An allowlist, not a search for `config`, and the difference is the whole
 * finding. A `/^\s*config\s*:/m` recognises the bare key at the start of a line
 * and nothing else; YAML accepts far more spellings of the same key, and every
 * one of these was measured reaching the renderer:
 *
 *     ---\n"config":\n  securityLevel: loose\n---
 *     ---\n'config':\n  securityLevel: loose\n---
 *     ---\n{config: {securityLevel: loose}}\n---
 *     ---\n{"config":{"securityLevel":"loose"}}\n---
 *
 * Adding those four spellings to the pattern would still lose, because mermaid
 * parses frontmatter with js-yaml's JSON schema and js-yaml resolves escapes in
 * double-quoted scalars: `"config"` is the key `config` and contains none
 * of its letters. There is no textual blocklist that survives that. So the
 * question is inverted — mermaid reads exactly three keys out of frontmatter
 * (`title`, `displayMode`, `config`), the first two are strings it prints, and
 * anything that is not visibly one of those two is refused unparsed.
 *
 * The lookahead after the colon rejects the YAML value forms that continue onto
 * lines this check would then have to reason about: block scalars (`|`, `>`),
 * flow collections (`{`, `[`), anchors and aliases (`&`, `*`), tags (`!`) and
 * directives (`%`). A title is a string on one line.
 *
 * Cost of the trade: a diagram whose frontmatter carries a key this app does not
 * know about is refused rather than drawn. That is the intended direction — the
 * file came from another machine.
 */
const FRONTMATTER_ALLOWED_LINE =
  /^(?:#[^\n]*|(?:title|displayMode)[^\S\n]*:[^\S\n]*(?![|>&*!%{[])[^\n]*)$/;

export function hasUnsafeFrontmatter(source: string): boolean {
  const matched = FRONT_MATTER.exec(normalizeNewlines(source));
  if (!matched) return false;

  // Mermaid strips the opener's indent from every line before parsing; the
  // allowlist below anchors at column zero, so it has to see the same text.
  const indent = matched[1] ?? "";
  const lines = (matched[2] ?? "").split("\n");
  const body = indent
    ? lines.map((line) =>
        line.startsWith(indent) ? line.slice(indent.length) : line,
      )
    : lines;

  return body
    .some(
      (line) =>
        line.trim().length > 0 && !FRONTMATTER_ALLOWED_LINE.test(line),
    );
}

/** Refuse before rendering, with the reason the user reads. `null` = draw it. */
export function sourceRefusal(source: string): string | null {
  if (source.trim().length === 0) {
    return "O diagrama chegou vazio.";
  }
  if (hasConfigDirective(source)) {
    return "Este diagrama tenta reconfigurar o renderizador, então não foi desenhado.";
  }
  if (hasUnsafeFrontmatter(source)) {
    return "O cabeçalho deste diagrama traz algo além de um título, então não foi desenhado.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sanitising the SVG mermaid hands back
// ---------------------------------------------------------------------------

/**
 * Elements dropped from the rendered SVG, whatever mermaid's reason for them.
 *
 * `script` is not theoretical: a `<script>` built by `DOMParser` has its
 * "already started" flag unset, so it stays inert inside the parsed document but
 * runs the moment it is adopted into the live one. `foreignObject` is the
 * htmlLabels escape hatch, kept on the list so finding 3 stays inert even if a
 * future mermaid re-enables htmlLabels by a route this file missed.
 *
 * The SMIL animation elements are all here, and the reason is that half of them
 * used to be. `<set attributeName="href" to="javascript:…">` was on the list;
 * `<animate attributeName="href" values="javascript:…">` was not, and it is the
 * same attack with a different tag — an animation element rewrites an attribute
 * of its parent *after* this walk has inspected it, so no amount of attribute
 * filtering reaches it. `animateTransform`, `animateMotion`, `mpath` and
 * `discard` complete the family. `use` is here because `<use xlink:href="…">`
 * pulls a subtree in from elsewhere, and `feImage` because it fetches. Mermaid's
 * own DOMPurify pass already refuses `animate` and `use`, so nothing legitimate
 * is lost by refusing them again.
 *
 * Matched on `localName`, so `<svg:script>` and `<html:script>` are the same
 * entry as `<script>`.
 *
 * `style` is deliberately absent: mermaid emits its whole stylesheet inside the
 * SVG and the diagram is unreadable without it. Its text is filtered instead —
 * see `sanitizeStyleText`.
 */
const FORBIDDEN_SVG_TAGS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "link",
  "meta",
  "base",
  "annotation-xml",
  "handler",
  // SMIL: each of these can rewrite an attribute after this walk has passed.
  "animate",
  "animatetransform",
  "animatemotion",
  "mpath",
  "set",
  "discard",
  // Pull content in from elsewhere.
  "use",
  "feimage",
]);

export function isForbiddenSvgTag(tagName: string): boolean {
  return FORBIDDEN_SVG_TAGS.has(tagName.toLowerCase());
}

/** Schemes a link inside a diagram may carry. Everything else is dropped. */
const SAFE_URL = /^(?:https?:|mailto:|#|\/|\.{1,2}\/)/i;

/**
 * C0 controls and space, which a browser strips before it resolves a URL.
 *
 * `no-control-regex` is disabled on purpose: the control characters are the
 * point. `java<TAB>script:alert(1)` is a working URL in every browser, and a
 * pattern forbidden from naming them cannot recognise it.
 */
// eslint-disable-next-line no-control-regex
const URL_NOISE = /[\u0000-\u0020]/g;

/** Local names whose value a browser resolves as a URL. */
const URL_BEARING = new Set([
  "href",
  "src",
  "srcset",
  "data",
  "poster",
  "action",
  "formaction",
  "background",
]);

/**
 * The only things this module reads off an attribute — and, pointedly, not its
 * qualified name.
 *
 * Structural rather than `Attr`, so the decision can be asserted without a DOM.
 */
export interface SvgAttributeView {
  /** `attr.localName`: the name with any prefix removed. */
  localName: string;
  /** `attr.namespaceURI`: `null` for an unprefixed attribute. */
  namespaceURI: string | null;
  value: string;
}

/**
 * Attributes stripped from every surviving element.
 *
 * Decided on the *local name*, never on the qualified name, and that is a fix
 * rather than a style choice. A prefix is arbitrary — the document decides what
 * it binds to — so
 *
 *     <a xmlns:zz="http://www.w3.org/1999/xlink" zz:href="javascript:…">
 *
 * is the same live link as `xlink:href`, and a check comparing the string
 * `"xlink:href"` never sees it. The browser resolves by namespace; so does this.
 * The namespace URI itself is not consulted for the decision: an `href` in a
 * namespace nobody recognises is inert, but validating it anyway costs nothing
 * and removes a whole class of question.
 *
 * Anything whose local name starts with `on` is an inline handler, prefixed or
 * not. A URL-bearing attribute survives only with a scheme from `SAFE_URL`,
 * which rules out `javascript:`, `vbscript:` and the `data:text/html` variant.
 * The noise is removed first because a browser ignores control characters when
 * it resolves a URL and a naive prefix check does not — `java\tscript:alert(1)`
 * is a working URL.
 */
export function isUnsafeSvgAttribute(attribute: SvgAttributeView): boolean {
  const name = attribute.localName.toLowerCase();
  if (name.startsWith("on")) return true;

  if (URL_BEARING.has(name)) {
    return !SAFE_URL.test(attribute.value.replace(URL_NOISE, ""));
  }

  // `style` reaches the network only through url(), and a data: URL there is the
  // documented way to smuggle a payload past a tag filter.
  if (name === "style") {
    return /url\s*\(\s*['"]?\s*(?:data|javascript):/i.test(attribute.value);
  }

  return false;
}

// ---------------------------------------------------------------------------
// The stylesheet mermaid puts inside the SVG
// ---------------------------------------------------------------------------

const CSS_AT_IMPORT = /@import\b[^;{}]*;?/gi;
const CSS_FETCHING_CALL = /\b(?:-webkit-)?(?:url|image-set)\s*\(([^()]*)\)/gi;
/** Anything still able to fetch after the rewrite above. */
const CSS_FETCH_SURVIVOR = /\b(?:-webkit-)?(?:url|image-set)\s*\(\s*(?!['"]?#)/i;

/**
 * Neutralise the network references inside a `<style>` element's text.
 *
 * The walk used to inspect attributes only, and a stylesheet is not an
 * attribute. That was the last step of a chain that worked end to end: an
 * imported memory file carries a diagram whose frontmatter sets `themeCSS`,
 * mermaid copies that CSS into the `<style>` of the SVG it returns, the walk
 * kept `<style>` whole because a diagram without it is unreadable, and opening
 * the memory made the browser fetch the author's URL. No script ran — mermaid's
 * own `sanitize` drops strings holding `<`, `>` or `url(data:` — but a beacon
 * firing when a user opens a file someone handed them is the whole of the bug.
 *
 * Two doors out of a stylesheet, and both are shut here: `@import`, and any
 * value calling `url()` or `image-set()`. A same-document fragment
 * (`url(#arrowhead)`) is kept, because that is how SVG points at its own
 * markers; everything else becomes `none`, which is a valid value for every
 * property that accepts a `url()`. If anything able to fetch survives the
 * rewrite — an unbalanced paren, a spelling not anticipated here — the whole
 * stylesheet is dropped. An unstyled diagram is a bad afternoon; a diagram that
 * phones home is an incident.
 *
 * What this cannot do, measured rather than assumed: stop the fetch on its own.
 * `mermaid.render` inserts a temporary element into the *live* document to
 * measure text before it returns the string, so a stylesheet that reached
 * mermaid has already been live for a frame and the request is already out. With
 * layers 1 and 2 disabled on purpose, a beacon still fired even though nothing
 * reached the card. That is the argument for refusing the source and freezing
 * `themeCSS` rather than relying on this walk: by the time the SVG is a string,
 * the network call has happened.
 */
export function sanitizeStyleText(css: string): string {
  const rewritten = css
    .replace(CSS_AT_IMPORT, "")
    .replace(CSS_FETCHING_CALL, (call: string, inner: string) => {
      const target = inner.trim().replace(/^['"]|['"]$/g, "").trim();
      return target.startsWith("#") ? call : "none";
    });

  return CSS_FETCH_SURVIVOR.test(rewritten) ? "" : rewritten;
}

/**
 * Strip everything above from a parsed SVG tree, in place.
 *
 * Takes an `Element` rather than a string so the caller adopts nodes instead of
 * assigning `innerHTML`: the injection half of finding 1 is not fixed by any
 * amount of filtering if the filtered string is parsed as HTML afterwards.
 */
export function sanitizeSvgElement(element: Element): void {
  for (const attribute of [...element.attributes]) {
    if (
      isUnsafeSvgAttribute({
        localName: attribute.localName,
        namespaceURI: attribute.namespaceURI,
        value: attribute.value,
      })
    ) {
      // Removed by namespace, for the same reason the decision was made by
      // namespace: `removeAttribute` takes a qualified name, and the qualified
      // name is the part the document's author chose.
      if (attribute.namespaceURI !== null) {
        element.removeAttributeNS(attribute.namespaceURI, attribute.localName);
      } else {
        element.removeAttribute(attribute.name);
      }
    }
  }

  if (element.localName.toLowerCase() === "style") {
    // A `<style>` holds text, never elements, so this replaces the recursion
    // rather than preceding it.
    element.textContent = sanitizeStyleText(element.textContent ?? "");
    return;
  }

  for (const child of [...element.children]) {
    if (isForbiddenSvgTag(child.localName)) child.remove();
    else sanitizeSvgElement(child);
  }
}

// ---------------------------------------------------------------------------
// Failure, in words
// ---------------------------------------------------------------------------

/**
 * The message shown when a render throws.
 *
 * A validated source can still fail the parser — the backend's check is
 * structural — and the failure has to be visible, because the alternative is a
 * blank space on screen while the voice model talks about a diagram that is not
 * there. Mermaid's own message rides along: it names the offending line, and it
 * is the only thing that makes the failure fixable.
 */
export function describeRenderFailure(error: unknown): string {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const trimmed = detail.trim().split("\n").slice(0, 4).join(" ").slice(0, 400);
  return trimmed.length > 0
    ? `Não consegui desenhar este diagrama: ${trimmed}`
    : "Não consegui desenhar este diagrama.";
}

/** The one thing this module needs from mermaid, so a test can stand in for it. */
export type MermaidRenderFn = (
  id: string,
  text: string,
) => Promise<{ svg: string }>;

export interface DiagramRenderOutcome {
  /** The SVG string, still unsanitised — `sanitizeSvgElement` runs on the tree. */
  svg: string | null;
  /** A sentence for the user. Exactly one of the two fields is non-null. */
  error: string | null;
}

/**
 * How long a diagram may take before the card stops waiting for it.
 *
 * There is a third outcome besides "drew" and "threw", and it is the one that
 * shows worst: nothing. A chunk request that hangs open, or a graph large enough
 * that layout never converges, leaves `mermaid.render` pending forever, and a
 * promise that never settles renders as "Desenhando o diagrama…" for the rest of
 * the session — a spinner that means "broken" and looks like "almost". Measured:
 * a render that never settles left the card pending indefinitely.
 *
 * Fifteen seconds is far past any diagram this app generates and far short of
 * the user deciding the app is dead.
 */
export const RENDER_TIMEOUT_MS = 15_000;

const RENDER_TIMED_OUT = Symbol("mermaid-render-timeout");

/**
 * Produce the SVG for a source, or a sentence saying why not. Never throws.
 *
 * This is the whole failure contract in one place: a refused source, a mermaid
 * chunk that would not load, a parser that rejected line 4 and a render that
 * never came back all arrive the same way, so the component has one path to
 * render and no way to let a rejected promise escape into React. A validated
 * source can still fail here — the backend's check is structural, and
 * "well-formed" is not "draws".
 *
 * The timeout only stops *waiting*; mermaid has no cancellation and the work
 * keeps running in the background until it finishes or the tab goes away. What
 * this buys is a card that says something.
 */
export async function renderDiagramSource(
  source: string,
  render: MermaidRenderFn,
  timeoutMs: number = RENDER_TIMEOUT_MS,
): Promise<DiagramRenderOutcome> {
  const refusal = sourceRefusal(source);
  if (refusal) return { svg: null, error: refusal };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const svg = await Promise.race([
      render(nextRenderId(), source).then((outcome) => outcome.svg),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(RENDER_TIMED_OUT), timeoutMs);
      }),
    ]);
    return { svg, error: null };
  } catch (err) {
    if (err === RENDER_TIMED_OUT) {
      return {
        svg: null,
        error: "Este diagrama demorou demais para ser desenhado e foi cancelado.",
      };
    }
    return { svg: null, error: describeRenderFailure(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A DOM id no other render is using.
 *
 * `mermaid.render(id, ...)` injects a temporary element under that id and
 * queries it back, so two diagrams rendering at once under the same id race for
 * one node. A module counter rather than `useId`, because React's generated ids
 * contain characters that are invalid in the CSS selectors mermaid builds from
 * this string.
 */
let renderSequence = 0;

export function nextRenderId(): string {
  renderSequence += 1;
  return `mermaid-render-${renderSequence}`;
}
