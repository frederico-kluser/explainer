// Natural-language instructions in, validated mermaid source out.
//
// The voice model never writes mermaid. It describes the drawing in Portuguese
// ("desenha o fluxo de uma chamada de ferramenta") and this module produces the
// diagram. Two reasons for that boundary: a realtime voice model asked to emit
// syntax mid-sentence emits broken syntax, and whatever it emits is rendered
// inside the user's browser, where a mermaid diagram is an executable document
// rather than a picture.
//
// Validation here is structural and brings no new dependency. mermaid v11 needs
// a full browser DOM even for `mermaid.parse` (mermaid-js/mermaid#6370; jsdom
// and happy-dom are documented as not sufficient), and `@mermaid-js/parser`
// only covers the newer Langium grammars — not flowchart or sequenceDiagram,
// the two kinds this app draws most. A "real" parser would therefore cost a
// headless browser and still miss the common cases.

import { randomUUID } from "node:crypto";

import { addCost } from "./costs.js";
import { OpenAIError, TEXT_MODEL } from "./openai.js";
import { priceTextResponse, ratesFor, type TextUsage } from "./pricing.js";
import { providerKey } from "./providers/keys.js";
import type {
  MermaidDiagram,
  MermaidDiagramKind,
  MermaidRequest,
  MermaidValidation,
} from "../types/deep-tools.js";

/** The closed list from the contract, as a value the prompt and the tool schema can iterate. */
export const MERMAID_KINDS = [
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
] as const satisfies readonly MermaidDiagramKind[];

/** Render budget, not a syntax rule: past this the browser stalls on one diagram. */
export const MAX_DIAGRAM_CHARS = 8_000;
export const MAX_DIAGRAM_LINES = 120;

/** One generation plus two corrections. A fourth attempt has never fixed a third. */
const MAX_ATTEMPTS = 3;

const KIND_LABELS: Record<MermaidDiagramKind, string> = {
  flowchart: "um fluxograma",
  sequenceDiagram: "um diagrama de sequencia",
  classDiagram: "um diagrama de classes",
  "stateDiagram-v2": "um diagrama de estados",
  erDiagram: "um diagrama de entidades",
  journey: "uma jornada do usuario",
  gantt: "um cronograma",
  pie: "um grafico de pizza",
  mindmap: "um mapa mental",
  timeline: "uma linha do tempo",
};

/**
 * Raised when three attempts in a row produced something we refuse to render.
 *
 * The message is Brazilian Portuguese because the voice model reads it out to
 * the user; `problems` stays machine-readable for the tool layer and the logs.
 */
export class MermaidError extends Error {
  constructor(
    message: string,
    public readonly problems: string[] = [],
    public readonly lastSource?: string,
  ) {
    super(message);
    this.name = "MermaidError";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// These checks are not theatre. mermaid renders into the live page, and every
// published bypass is reachable from diagram text alone:
//   - `%%{init: ...}%%` directives that flip `securityLevel` or `htmlLabels`
//     (Snyk Labs, "More than flowcharts: exploiting diagram renderers", 2026);
//   - GitLab / HackerOne #1212822: `securityLevel` sits on mermaid's `secure`
//     list and still could not be trusted — setting `flowchart.htmlLabels` to
//     the *string* "false" skipped sanitisation entirely;
//   - GHSL-2021-1058: links registered through `click` were stored unsanitised
//     whenever htmlLabels was off.
// A backend that only trusts `securityLevel: "strict"` in the frontend is one
// config regression away from stored XSS, so the constructs never leave here.
//
// The first version of these checks was a denylist of literal spellings, and an
// adversarial review walked 27 of 51 hostile diagrams straight through it. Every
// bypass had the same shape: the dangerous construct is not spelled that way in
// the source. `&#106;avascript:`, `#60;script#62;` and `htmlLabels` are all
// decoded after the check runs; `A["java\nscript:"]` is joined by the HTML
// parser; `A --> B; click B call f()` is two statements on one line, which is
// enough to slip past a check anchored at the start of a line.
//
// So nothing is matched against the raw text any more. The source is folded into
// a canonical form first — every escape mermaid or the browser would undo is
// undone, `;` becomes a line break, breaks inside a label disappear — and the
// patterns run over that. The patterns are shapes (any tag, any `on*=` handler),
// never enumerations of names, because an enumeration is one new event name away
// from being bypassed again.

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

/**
 * The escapes mermaid and the HTML parser undo, as one table.
 *
 * mermaid documents `#35;` as the way to put a reserved character in a label and
 * the browser does the same job for `&#35;`, so by render time the two spellings
 * are the same character. Only names that can rebuild dangerous syntax are
 * listed; an unknown name is left exactly as it was found.
 */
const NAMED_ESCAPES: Record<string, string> = {
  amp: "&",
  apos: "'",
  colon: ":",
  commat: "@",
  equals: "=",
  excl: "!",
  grave: "`",
  gt: ">",
  lpar: "(",
  lt: "<",
  nbsp: " ",
  newline: "\n",
  num: "#",
  period: ".",
  quot: '"',
  rpar: ")",
  semi: ";",
  sol: "/",
  tab: "\t",
};

/** `&amp;#106;` needs two passes; a handful more covers anything a model emits. */
const MAX_DECODE_PASSES = 8;

function fromCode(code: number, original: string): string {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return original;
  try {
    return String.fromCodePoint(code);
  } catch {
    return original;
  }
}

function decodeOnce(text: string): string {
  return (
    text
      // `&#106;` (HTML) and `#106;` (mermaid's own escape) mean the same letter.
      .replace(/&?#(\d{1,7});/g, (whole, digits: string) => fromCode(Number(digits), whole))
      .replace(/&?#x([0-9a-fA-F]{1,6});/gi, (whole, hex: string) =>
        fromCode(Number.parseInt(hex, 16), whole),
      )
      .replace(/[&#]([a-zA-Z][a-zA-Z0-9]{1,15});/g, (whole, name: string) => {
        const decoded = NAMED_ESCAPES[name.toLowerCase()];
        return decoded ?? whole;
      })
      // mermaid JSON-decodes the body of `%%{init: ...}%%`, so a `\u` escape in
      // a key is a live key by the time the config is read.
      .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (whole, hex: string) =>
        fromCode(Number.parseInt(hex, 16), whole),
      )
      .replace(/\\u([0-9a-fA-F]{4})/g, (whole, hex: string) =>
        fromCode(Number.parseInt(hex, 16), whole),
      )
      .replace(/\\x([0-9a-fA-F]{2})/g, (whole, hex: string) =>
        fromCode(Number.parseInt(hex, 16), whole),
      )
  );
}

/** Decode until the text stops changing: one pass only undoes one layer. */
function decodeLayers(raw: string): string {
  let text = raw;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next = decodeOnce(text);
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * What the HTML parser drops from inside an attribute value before using it.
 *
 * A set rather than a character class: `no-control-regex` is right that a bare
 * control character inside a regex is almost always a typo.
 */
const INVISIBLE_IN_LABEL = new Set(["\t", "\n", "\r", "\f", "\v"]);

/**
 * The form the dangerous-construct patterns are matched against.
 *
 * Two folds, in this order. `;` ends a statement in mermaid, so `A --> B; click
 * A call f()` is two statements and the second one has to look like it starts a
 * line. Inside a quoted label the opposite holds: a line break there is not a
 * separator and the browser removes it, so `"java\nscript:"` is `javascript:`
 * before anything can act on it.
 */
function canonicalScan(decoded: string): string {
  const flattened = decoded.replace(/;/g, "\n");
  const out: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < flattened.length; i += 1) {
    const char = flattened[i]!;
    if (char === '"') {
      inQuotes = !inQuotes;
      out.push(char);
      continue;
    }
    if (inQuotes && INVISIBLE_IN_LABEL.has(char)) {
      while (out.length > 0 && (out[out.length - 1] === " " || out[out.length - 1] === "\t")) {
        out.pop();
      }
      while (i + 1 < flattened.length && (flattened[i + 1] === " " || flattened[i + 1] === "\t")) {
        i += 1;
      }
      continue;
    }
    out.push(char);
  }

  return out.join("");
}

// ---------------------------------------------------------------------------
// Dangerous constructs
// ---------------------------------------------------------------------------

/**
 * `<<interface>>` is a classDiagram annotation, not markup.
 *
 * mermaid's grammar eats the angle brackets and renders «interface» as text, so
 * the annotation is folded away before the tag check. The fold is fenced in
 * tightly, because `<<name>>` is not one inert construct to an HTML parser: it
 * is a literal `<` followed by a *real* `<name>` element. A fold that only
 * looked at the identifier walked `<<style>>*{position:fixed;…;background:url(…)}`
 * straight through — a live stylesheet, which `innerHTML` applies even though it
 * refuses to run `<script>`, so a whole-page defacement plus a network beacon.
 * Neither an attribute nor an `=` is needed for that, which is why "no `=`
 * inside" was never the boundary it looked like.
 *
 * Three conditions now hold together, and each one closes a way in:
 *   - only in a classDiagram, the one grammar that has annotations at all;
 *   - only where that grammar accepts one — a line of its own, or the
 *     `<<interface>> Classe` form — which is what leaves no room for the
 *     `*{…}` a stylesheet payload needs;
 *   - only a plain identifier, so no quote, slash or angle bracket rides along.
 * Anything else keeps its `<` and meets `HTML_TAG` unchanged.
 */
const CLASS_ANNOTATION =
  /^[^\S\n]*<<[A-Za-z][A-Za-z0-9_ -]{0,39}>>[^\S\n]*(?:[A-Za-z_][A-Za-z0-9_~.]{0,63})?[^\S\n]*$/gm;

/**
 * Any tag at all. A list of six names did not contain `img` or `video`.
 *
 * No whitespace is tolerated between `<`, the optional `/` and the letter,
 * because the HTML tokenizer tolerates none either: the tag-open state needs an
 * ASCII letter *immediately* after `<`, so `< y` and `< 5` are text and never
 * become an element. The earlier `<\s*\/?\s*[a-zA-Z]` rejected `A["x < y"]`, an
 * ordinary mathematical comparison, and every false rejection here costs a paid
 * retry on a diagram that was already correct.
 *
 * This does not reopen the escaped spellings: `&lt;script&gt;`, `#60;script#62;`
 * and `"<\nscript>"` are all folded back to a bare `<script>` by `decodeLayers`
 * and `canonicalScan` before this pattern ever runs.
 *
 * `<<name>>` is not an exception to the rule and only looks like one: the first
 * `<` is inert and the second opens a live element. The only thing that ever
 * removes it from this scan is `CLASS_ANNOTATION` above, inside the one grammar
 * position where mermaid itself consumes the brackets.
 */
const HTML_TAG = /<\/?[a-zA-Z]/;

/** Any handler. A list of nine names did not contain `onpointerover`. */
const EVENT_HANDLER = /\bon[a-z]+\s*=/i;

const SCRIPT_URL = /(?:java|vb)script\s*:/i;
const DATA_HTML_URL = /data\s*:\s*text\/html/i;

/** `href` never has a reason to appear, with or without the `=` the old check demanded. */
const HREF_ANYWHERE = /\bhref\b/i;

/**
 * An interaction directive with its payload, anywhere on the line.
 *
 * Covers `click A call f()`, `click A href "url"`, the `click A "url"` shorthand,
 * `link Classe "url" "dica"` and `callback Classe "fn" "dica"` — the forms that
 * actually register something. Position is not part of the pattern: a leading
 * `;` was all it took to defeat the `^click` version.
 */
const INTERACTION_CALL =
  /\b(?:click|link|callback)\b[^\S\r\n]+\S+[^\S\r\n]+(?:call\b|href\b|["'])/i;

/**
 * The bare `click A minhaFuncao` form, which has no payload marker to key on and
 * can only be recognised by sitting where a statement starts.
 */
const INTERACTION_STATEMENT = /^[ \t]*(?:click|link|callback)\b/im;

/**
 * Config keys that decide whether a label is escaped before it reaches the page.
 *
 * Matched as a shape so `security_level` and `securityLevel` both land, and only
 * inside a directive: a *label* that says "securityLevel strict" is prose, and
 * rejecting it burned a paid retry on a diagram that was fine.
 */
const DIRECTIVE_KEY = /security|htmllabels|themecss/i;

/**
 * Split off a YAML frontmatter block, which mermaid accepts before the type.
 *
 * Only a `---` on the first useful line opens one, and only a matching `---`
 * closes it; an unterminated block is not frontmatter, it is a flowchart link
 * that lost its ends.
 */
function splitFrontmatter(source: string): { frontmatter: string; body: string } {
  const lines = source.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start]!.trim().length === 0) start += 1;
  if (start >= lines.length || lines[start]!.trim() !== "---") {
    return { frontmatter: "", body: source };
  }
  for (let end = start + 1; end < lines.length; end += 1) {
    if (lines[end]!.trim() !== "---") continue;
    return {
      frontmatter: lines.slice(start + 1, end).join("\n"),
      body: [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n"),
    };
  }
  return { frontmatter: "", body: source };
}

/** Every region mermaid reads as configuration rather than as drawing. */
function directiveRegions(decoded: string): string[] {
  const regions = [...decoded.matchAll(/%%\{[\s\S]*?\}%%/g)].map((match) => match[0]);
  // Frontmatter carries a `config:` block that does the same job as `%%{init}%%`.
  const { frontmatter } = splitFrontmatter(decoded);
  if (frontmatter.trim().length > 0) regions.push(frontmatter);
  return regions;
}

function dangerousProblems(source: string, kind: MermaidDiagramKind | undefined): string[] {
  const problems: string[] = [];
  const decoded = decodeLayers(source);
  const scan = canonicalScan(decoded);
  // Only a classDiagram has annotations, and a diagram that never declared its
  // kind is read under the strictest rule available — so neither gets the fold.
  const markup = kind === "classDiagram" ? scan.replace(CLASS_ANNOTATION, " ") : scan;

  if (HTML_TAG.test(markup)) {
    problems.push(
      "Tirei o diagrama porque ele tem tag HTML (script, img, iframe, qualquer uma). Use so texto nos rotulos.",
    );
  }
  if (EVENT_HANDLER.test(scan)) {
    problems.push(
      "O diagrama tem atributo de evento (onerror, onclick e qualquer outro on...). Remova qualquer atributo HTML.",
    );
  }
  if (SCRIPT_URL.test(scan)) {
    problems.push('O diagrama tem "javascript:", que nao pode aparecer em rotulo nenhum.');
  }
  if (DATA_HTML_URL.test(scan)) {
    problems.push('O diagrama tem uma URL "data:text/html", que nao pode aparecer.');
  }
  if (HREF_ANYWHERE.test(scan)) {
    problems.push('O diagrama usa "href". Nao coloque link nenhum no desenho.');
  }

  // mindmap has no interaction grammar at all and gantt only accepts the
  // `call`/`href` payload forms, so in those two a node or task whose text
  // starts with the word "click" is prose. `INTERACTION_CALL` still covers the
  // real gantt directive; only the positional rule is relaxed.
  const clickIsProse = kind === "mindmap" || kind === "gantt";
  if (INTERACTION_CALL.test(scan) || (!clickIsProse && INTERACTION_STATEMENT.test(scan))) {
    problems.push(
      'O diagrama usa uma diretiva de interacao (click, link ou callback). Diagrama aqui nao tem interacao: remova a linha.',
    );
  }

  if (directiveRegions(decoded).some((region) => DIRECTIVE_KEY.test(region))) {
    problems.push(
      'O diagrama mexe em securityLevel ou htmlLabels dentro de "%%{init: ...}%%". Isso nunca e permitido.',
    );
  }

  return problems;
}

/**
 * Drop what mermaid itself treats as neither drawing nor label.
 *
 * Whole-line `%%` comments, `%%{...}%%` directives and a YAML frontmatter block.
 * A bare `%%` in the middle of a label is left alone, so "50%% ao ano" does not
 * get truncated into an unbalanced label by the bracket scan below.
 */
function stripComments(source: string): string {
  return splitFrontmatter(source)
    .body.replace(/%%\{[\s\S]*?\}%%/g, " ")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("%%"))
    .join("\n");
}

/** The first line that is neither blank nor a comment — where the type must be declared. */
function declarationLine(source: string): string | null {
  for (const raw of splitFrontmatter(source).body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("%%")) continue;
    return line;
  }
  return null;
}

const PAIRS: Record<string, string> = { "]": "[", ")": "(", "}": "{" };

/**
 * Bracket and quote balance, scanned outside of quoted labels.
 *
 * Four kinds are treated specially because their syntax is legitimately
 * unbalanced: `erDiagram` writes cardinality as `||--o{` / `}o..||`, `mindmap`
 * has the inverted `))bang((` and `)cloud(` shapes, `sequenceDiagram` closes its
 * async message arrows with `-)` and `--)`, and `flowchart` has the asymmetric
 * `A>"Aviso"]` node. Counting those as brackets would reject perfectly good
 * diagrams, and a false rejection costs a retry the user pays for — the async
 * arrow alone appears in nearly every real sequence diagram and was burning all
 * three attempts on a message the model had written correctly.
 */
function balanceProblems(source: string, kind: MermaidDiagramKind): string[] {
  const problems: string[] = [];
  let text = stripComments(source);
  if (kind === "erDiagram") {
    text = text.replace(/[|}{o]{2}(?:--|\.\.)[|}{o]{2}/g, " ");
  }
  if (kind === "sequenceDiagram") {
    text = text.replace(/-{1,2}\)/g, " ");
  }
  if (kind === "flowchart") {
    // `A>"Aviso"]` opens with `>`, not with `[`. Removed whole, quotes included,
    // so the quote parity below still sees a pair.
    text = text.replace(/[A-Za-z0-9_]+[ \t]*>[ \t]*(?:"[^"\n]*"|[^\]\n"]*)\]/g, " ");
  }
  const trackRound = kind !== "mindmap";
  const trackCurly = kind !== "mindmap";

  const stack: string[] = [];
  let inQuotes = false;

  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (char === "(" && !trackRound) continue;
    if (char === ")" && !trackRound) continue;
    if (char === "{" && !trackCurly) continue;
    if (char === "}" && !trackCurly) continue;

    if (char === "[" || char === "(" || char === "{") {
      stack.push(char);
      continue;
    }
    const opener = PAIRS[char];
    if (!opener) continue;
    if (stack.pop() !== opener) {
      problems.push(
        `Tem um "${char}" fechando o que nunca foi aberto. Confira os colchetes, parenteses e chaves.`,
      );
      return problems;
    }
  }

  if (inQuotes) {
    problems.push('Ficou uma aspa dupla (") aberta. Toda aspa precisa de um par.');
  }
  if (stack.length > 0) {
    problems.push(
      `Faltou fechar ${stack.length} simbolo(s): ${stack.join(" ")}. Cada "[", "(" ou "{" precisa do par dele.`,
    );
  }
  return problems;
}

/**
 * Decide whether a candidate can be handed to the browser.
 *
 * Structural, not semantic: it proves the source declares a supported kind, is
 * plain diagram text, balances its delimiters, fits the render budget, and
 * carries none of the constructs that turn a diagram into script. It does not
 * prove mermaid will draw it — an unknown arrow shape still fails at render, and
 * `flowchart TD` followed by loose prose is still accepted here. That last gap
 * is deliberate (writing a grammar is the thing this module refuses to do) and
 * it is not a security gap: the dangerous-construct scan reads every line, in
 * canonical form, which is exactly where a payload smuggled past the first line
 * would sit.
 */
export function validateMermaid(source: string): MermaidValidation {
  const text = source ?? "";
  if (text.trim().length === 0) {
    return { ok: false, problems: ["O diagrama veio vazio. Mande o codigo mermaid."] };
  }

  const problems: string[] = [];

  if (text.includes("```")) {
    problems.push(
      "Tire as cercas de codigo (```). A resposta e so o codigo mermaid, sem markdown.",
    );
  }
  if (text.length > MAX_DIAGRAM_CHARS) {
    problems.push(
      `O diagrama tem ${text.length} caracteres e o limite e ${MAX_DIAGRAM_CHARS}. Simplifique.`,
    );
  }
  const lineCount = text.split(/\r?\n/).length;
  if (lineCount > MAX_DIAGRAM_LINES) {
    problems.push(
      `O diagrama tem ${lineCount} linhas e o limite e ${MAX_DIAGRAM_LINES}. Corte os detalhes menos importantes.`,
    );
  }

  const declaration = declarationLine(text);
  const token = declaration ? /^([A-Za-z][A-Za-z0-9-]*)/.exec(declaration)?.[1] : undefined;
  const kind = MERMAID_KINDS.find((candidate) => candidate === token);

  // After the kind, because two of these checks are only correct once the kind
  // is known — and an undeclared diagram is scanned under the strictest reading.
  problems.push(...dangerousProblems(text, kind));

  if (!kind) {
    if (token === "graph") {
      problems.push('Troque "graph" por "flowchart" na primeira linha.');
    } else if (token === "stateDiagram") {
      problems.push('Troque "stateDiagram" por "stateDiagram-v2" na primeira linha.');
    } else {
      problems.push(
        `A primeira linha util precisa declarar o tipo do diagrama, um destes: ${MERMAID_KINDS.join(", ")}. ` +
          `Veio "${(declaration ?? "").slice(0, 60)}".`,
      );
    }
    return { ok: false, problems };
  }

  problems.push(...balanceProblems(text, kind));

  return problems.length === 0 ? { ok: true, kind, problems: [] } : { ok: false, kind, problems };
}

// ---------------------------------------------------------------------------
// Model output cleanup
// ---------------------------------------------------------------------------

/**
 * Remove markdown fences a model wrapped the diagram in.
 *
 * Cleaned rather than rejected: fences are the single most common deviation and
 * they carry no meaning, so paying for a retry over them is waste. Everything
 * else the validator still refuses.
 */
export function stripFences(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("```"))
    .join("\n")
    .trim();
}

const CAPTION_MAX_CHARS = 300;

/**
 * Diagram syntax that has no spoken form.
 *
 * The caption goes to text-to-speech, and "LEGENDA: O no A[Navegador] aponta
 * para B[Backend] com a seta -->" was being read out as very nearly that:
 * stripping the symbols one at a time left "O no A Navegador aponta para B
 * Backend com a seta", a sentence about node ids. So a caption carrying any of
 * this is dropped whole and the spoken fallback takes over — the caption was the
 * one string in this module that reached the user unvalidated.
 */
const CAPTION_SYNTAX = /[[\]{}|<>`]|%%|-{1,2}\)|\(\(|\)\)|[A-Za-z0-9_]\(|::/;

/** The model answering with the diagram where the caption belongs. */
const CAPTION_IS_DIAGRAM = new RegExp(`^(?:${MERMAID_KINDS.join("|")}|graph)\\b`, "i");

/** A caption has to be a sentence, not what survived the punctuation. */
const CAPTION_HAS_WORDS = /[A-Za-zÀ-ÖØ-öø-ÿ]{3}/;

/** The caption is spoken, so anything a screen reader would stumble on goes. */
function cleanCaption(text: string): string {
  const raw = text.replace(/\s+/g, " ").trim();
  if (raw.length === 0) return "";
  if (CAPTION_SYNTAX.test(raw) || CAPTION_IS_DIAGRAM.test(raw)) return "";

  const cleaned = raw
    .replace(/[`*_#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return CAPTION_HAS_WORDS.test(cleaned) ? cleaned.slice(0, CAPTION_MAX_CHARS) : "";
}

function fallbackCaption(kind: MermaidDiagramKind, title?: string): string {
  return title
    ? `Coloquei na tela ${KIND_LABELS[kind]} sobre ${title}.`
    : `Coloquei na tela ${KIND_LABELS[kind]} com o que voce pediu.`;
}

/**
 * Split the two-part answer the prompt asks for.
 *
 * Everything before the `DIAGRAMA:` marker is discarded, which is what makes a
 * model that prefaced its answer with a sentence recoverable without a retry.
 * With no marker at all the whole reply is treated as the diagram, so the plain
 * "just the code" answer also works.
 */
function splitCompletion(raw: string): { caption: string; source: string } {
  const captionParts: string[] = [];
  const before: string[] = [];
  const after: string[] = [];
  let seenMarker = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!seenMarker && /^legenda\s*:/i.test(trimmed)) {
      captionParts.push(trimmed.replace(/^legenda\s*:/i, ""));
      continue;
    }
    if (!seenMarker && /^diagrama\s*:?\s*$/i.test(trimmed)) {
      seenMarker = true;
      continue;
    }
    (seenMarker ? after : before).push(line);
  }

  return {
    caption: cleanCaption(captionParts.join(" ")),
    source: (seenMarker ? after : before).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Voce e um gerador de diagramas mermaid. Recebe instrucoes em portugues e devolve UM diagrama.

Responda EXATAMENTE neste formato, sem mais nada:
LEGENDA: <uma ou duas frases>
DIAGRAMA:
<codigo mermaid>

Regras do DIAGRAMA:
- NUNCA use cercas de codigo (tres crases), markdown, titulo, comentario ou explicacao.
- A primeira linha declara o tipo, escolhido EXATAMENTE entre: ${MERMAID_KINDS.join(", ")}.
- Escreva "flowchart", nunca "graph". Escreva "stateDiagram-v2", nunca "stateDiagram".
- Rotulos em portugues do Brasil, curtos e diretos.
- Todo rotulo que tiver parenteses, dois-pontos, virgula, ponto-e-virgula, barra ou aspas fica ENTRE ASPAS DUPLAS: A["Backend (Express)"].
- Cada "[", "(" e "{" precisa do par que fecha.
- PROIBIDO: click, link, callback, href, call, tag HTML, javascript:, securityLevel, htmlLabels, %%{init: ...}%%.
- As formas proprias de cada tipo sao BEM-VINDAS: "-)" e "--)" nas mensagens assincronas do sequenceDiagram, ")nuvem(" e "))explosao((" no mindmap, "A>\\"Aviso\\"]" no flowchart.
- No maximo ${MAX_DIAGRAM_LINES} linhas e ${MAX_DIAGRAM_CHARS} caracteres.

Regras da LEGENDA:
- Uma ou duas frases em portugues do Brasil, para serem FALADAS em voz alta.
- Diz o que o desenho mostra. NAO leia a sintaxe, nao cite nomes de nos, nao use markdown.`;

function firstPrompt(request: MermaidRequest): string {
  const parts = [SYSTEM_PROMPT, "", "Instrucoes:", request.instructions.trim()];
  if (request.kind) parts.push("", `Tipo pedido: ${request.kind}`);
  if (request.title) parts.push("", `Titulo: ${request.title}`);
  return parts.join("\n");
}

function retryPrompt(
  request: MermaidRequest,
  previous: string,
  problems: string[],
): string {
  return [
    firstPrompt(request),
    "",
    "A tentativa anterior foi recusada. Problemas encontrados:",
    ...problems.map((problem) => `- ${problem}`),
    "",
    "Diagrama recusado:",
    previous.slice(0, 2_000),
    "",
    "Corrija exatamente esses problemas e devolva o formato completo de novo.",
  ].join("\n");
}

/**
 * The correction for a truncated answer, which is not the correction for a
 * wrong one.
 *
 * Sending the fragment back with "fix these problems" asks the model to repair
 * syntax that was never broken, and it answers with the same too-long diagram —
 * so the fragment is not shown to it at all and the only instruction is: draw
 * less.
 */
function shorterPrompt(request: MermaidRequest): string {
  return [
    firstPrompt(request),
    "",
    "A tentativa anterior foi CORTADA no meio: a resposta passou do limite de tokens.",
    "Desenhe a MESMA ideia, bem menor: no maximo dez nos, rotulos de poucas palavras,",
    "sem ramos secundarios e sem detalhe que nao mude o entendimento.",
  ].join("\n");
}

/**
 * The correction for an answer the provider itself stopped, which is neither of
 * the other two.
 *
 * There is no syntax to point at — the fragment proves nothing about the
 * model's mermaid — and nothing says the drawing was too big, so asking for a
 * smaller one corrects a size that was never wrong. The only thing worth
 * changing is the wording.
 */
function plainerPrompt(request: MermaidRequest, reason: string): string {
  return [
    firstPrompt(request),
    "",
    `A tentativa anterior foi interrompida pelo provedor. Motivo relatado: ${reason}.`,
    "Desenhe a MESMA ideia com outras palavras: rotulos neutros e curtos, sem citar",
    "nome proprio, dado pessoal ou termo que possa ser lido como conteudo sensivel.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

export interface MermaidCompletion {
  text: string;
  /** Absent when the caller injects a stub; present on the real API path. */
  usage?: TextUsage;
  model?: string;
  /**
   * The model ran out of output budget mid-answer, so `text` is a fragment.
   *
   * Kept apart from the validation problems because half a diagram fails the
   * bracket scan and is then indistinguishable from a model that cannot write
   * mermaid — and the correction the two need is not the same one.
   *
   * Only `max_output_tokens` sets this. The other reasons are `stoppedEarly`.
   */
  truncated?: boolean;
  /**
   * The answer stopped early for a reason that is not the token budget —
   * `content_filter` being the one that actually happens.
   *
   * Separate from `truncated` because the two need opposite corrections and one
   * of them is actively wrong for the other: answering a filtered stop with
   * "the same drawing, smaller" tells the user their diagram was too big, and
   * spends the retry shrinking something whose size was never the problem.
   */
  stoppedEarly?: string;
}

export type MermaidCompleteFn = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<MermaidCompletion>;

export interface MermaidOptions {
  /** Injected by tests and by any caller that already has a text client. */
  complete?: MermaidCompleteFn;
  /**
   * Attempts this call may spend, clamped into 1..MAX_ATTEMPTS.
   *
   * A caller that is holding a spoken turn open cannot afford the default: three
   * sequential 45 s calls outlive the conversation waiting for them.
   */
  attempts?: number;
  /** Cancels the in-flight call and stops the loop between attempts. */
  signal?: AbortSignal;
}

const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

interface ResponsesPayload {
  model?: string;
  usage?: TextUsage;
  output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
  /** `"completed"` | `"incomplete"` | … — a 200 does not mean a whole answer. */
  status?: string;
  incomplete_details?: { reason?: string };
}

/**
 * One Responses call that also reports its `usage`.
 *
 * `openai.completeText` is the natural place for this and is deliberately not
 * used: it returns only the text, and without the token counts `priceTextResponse`
 * has nothing to price, so every diagram would silently cost zero in the ledger.
 * Widening that function belongs to whoever owns `openai.ts`; until then the
 * call lives here, sharing its model id and its error type.
 */
async function completeWithUsage(
  prompt: string,
  signal?: AbortSignal,
): Promise<MermaidCompletion> {
  // Same resolver as every other call site, so a key saved after boot draws the
  // next diagram instead of waiting for a restart. Throws the 500 itself.
  const key = providerKey("openai");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  // The caller's budget is shorter than this call's own, so its abort has to
  // reach the socket: without the relay the fetch keeps a spoken turn waiting
  // long after the caller gave up on it.
  const relay = () => controller.abort();
  signal?.addEventListener("abort", relay, { once: true });

  try {
    const response = await fetch(`${OPENAI_BASE}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        input: prompt,
        // Diagram syntax is a formatting job, not a reasoning one, and on a
        // reasoning model the thinking tokens come out of the same budget.
        reasoning: { effort: "low" },
        max_output_tokens: 2_000,
      }),
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      let detail = body.slice(0, 500);
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } };
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        // keep the raw body
      }
      throw new OpenAIError(response.status, detail);
    }

    const payload = JSON.parse(body) as ResponsesPayload;
    const chunks: string[] = [];
    for (const item of payload.output ?? []) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part.text) chunks.push(part.text);
      }
    }

    // `max_output_tokens` is shared with the reasoning tokens, so a diagram this
    // model thought hard about arrives cut in half with a 200 and no error field.
    // Any other reason is not a size problem, and the correction for a size
    // problem is the wrong one for it — so the two are reported apart. A missing
    // reason on an `incomplete` is read as the budget, which is what it is in
    // every case the API documents.
    const reason = payload.incomplete_details?.reason;
    const incomplete = payload.status === "incomplete";
    const truncated = incomplete && (reason === undefined || reason === "max_output_tokens");
    if (incomplete && !truncated) {
      console.warn(`[mermaid] the model stopped early: ${reason}`);
    }

    return {
      text: chunks.join("\n").trim(),
      usage: payload.usage ?? {},
      model: payload.model ?? TEXT_MODEL,
      ...(truncated ? { truncated: true } : {}),
      // Never the empty string: the generation loop branches on this being
      // truthy, and an unnamed reason is still not the token budget.
      ...(incomplete && !truncated ? { stoppedEarly: reason || "desconhecido" } : {}),
    };
  } catch (err) {
    if (err instanceof OpenAIError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new OpenAIError(504, "A geracao do diagrama passou do tempo limite");
    }
    throw new OpenAIError(502, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

async function bookCost(
  conversationId: string,
  completion: MermaidCompletion,
  attempt: number,
): Promise<void> {
  if (!completion.usage) {
    // The silent zero is this ledger's documented failure mode: the panel shows
    // a number, the number is wrong, and nothing says so. A caller that injects
    // its own client and drops `usage` still gets nothing billed — that is the
    // contract — but it no longer gets it quietly.
    console.warn(
      `[mermaid] attempt ${attempt} was not billed: the completion carried no usage`,
    );
    return;
  }
  const usage = completion.usage;
  const model = completion.model ?? TEXT_MODEL;
  // The other half of the same failure mode: an id that is not on the rate card
  // prices at exactly zero, which reads like a free call instead of a gap.
  if (!ratesFor(model)) {
    console.warn(
      `[mermaid] model "${model}" is not on the rate card; attempt ${attempt} books usd=0`,
    );
  }
  await addCost(conversationId, {
    source: "mermaid",
    usd: priceTextResponse(model, usage),
    detail: `mermaid (tentativa ${attempt})`,
    tokens: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cached: usage.input_tokens_details?.cached_tokens ?? 0,
    },
  });
}

/**
 * Roughly how many characters a token is worth, for the one call nobody will
 * ever report usage for.
 *
 * Four is the ratio OpenAI publishes for English and it slightly over-counts
 * Portuguese, which is the direction to err in here: the entry exists so an
 * attempt that happened stops reading as free, not so it reads as exact.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Bill an attempt whose answer we walked away from.
 *
 * The tool layer's 25 s ceiling aborts a call the provider is already serving:
 * the prompt was read and tokens were being generated, and closing the socket
 * un-charges neither. Leaving it at zero is exactly the failure this ledger
 * documents everywhere else — a meter that reports nothing for work that
 * happened — so the input side is priced from the prompt we know we sent. The
 * output side stays at zero because nothing on this path ever reports it, which
 * makes the entry an under-estimate and never an invented number.
 */
async function bookAbandoned(
  conversationId: string,
  prompt: string,
  attempt: number,
): Promise<void> {
  const inputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  console.warn(
    `[mermaid] attempt ${attempt} was abandoned in flight; booking an estimate of ` +
      `${inputTokens} input token(s) and no output`,
  );
  // The same trap `bookCost` names: an id off the rate card prices at exactly
  // zero, and an estimate that rounds to nothing is the zero we came to avoid.
  if (!ratesFor(TEXT_MODEL)) {
    console.warn(`[mermaid] model "${TEXT_MODEL}" is not on the rate card; the estimate books usd=0`);
  }
  await addCost(conversationId, {
    source: "mermaid",
    usd: priceTextResponse(TEXT_MODEL, { input_tokens: inputTokens }),
    detail: `mermaid (tentativa ${attempt}, interrompida: estimativa)`,
    tokens: { input: inputTokens, output: 0, cached: 0 },
  });
}

/** Our own 45 s ceiling, which fires only after the request was served that long. */
function servedThenDropped(err: unknown): boolean {
  return err instanceof OpenAIError && err.status === 504;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** What the truncation branch reports, as a problem and to the user. */
const TRUNCATED_PROBLEM = "a resposta do modelo foi cortada no limite de tokens";
const TRUNCATED_MESSAGE =
  "O desenho ficou grande demais e foi cortado no meio antes de terminar. " +
  "Me pede uma versao mais simples, com menos partes, que eu desenho na hora.";

/** The same pair for an answer the provider stopped for a reason of its own. */
const STOPPED_PROBLEM = "o provedor interrompeu a resposta, motivo";
const STOPPED_MESSAGE =
  "Nao consegui terminar esse desenho: a resposta parou antes do fim. " +
  "Me pede a mesma ideia com outras palavras que eu tento de novo.";

/**
 * What the user hears when the attempts run out, which is not what the log gets.
 *
 * `problems` is the validator talking to itself: node ids, brackets, arrows and
 * sixty verbatim characters of the source it just refused. The tool layer reads
 * this message out loud exactly as written, so interpolating that diagnosis
 * spoke `Veio "grafico TD A["Navegador"] --> B["Backend"]"` to a listener — the
 * very thing `CAPTION_SYNTAX` exists to keep out of the caption, arriving one
 * layer up. The diagnosis still exists; it goes to `problems` and to the log.
 */
function gaveUpMessage(attempts: number): string {
  return (
    `Tentei ${attempts} vezes e o desenho nao saiu do jeito certo. ` +
    "Me explica de outro jeito o que voce quer no diagrama que eu tento de novo."
  );
}

/** Which correction the next attempt gets, given how the last one failed. */
function nextPrompt(
  request: MermaidRequest,
  attempt: number,
  state: { cutShort: boolean; stoppedEarly: string; previous: string; problems: string[] },
): string {
  if (attempt === 1) return firstPrompt(request);
  if (state.cutShort) return shorterPrompt(request);
  if (state.stoppedEarly) return plainerPrompt(request, state.stoppedEarly);
  return retryPrompt(request, state.previous, state.problems);
}

/** Cancelled from outside: spoken, because the tool layer reads this out. */
function cancelledError(): MermaidError {
  return new MermaidError(
    "A geracao do diagrama foi interrompida antes de terminar.",
    ["cancelado"],
  );
}

/**
 * Turn instructions into a diagram, correcting the model with its own errors.
 *
 * Every attempt is billed, valid or not, because it was generated either way —
 * a retry loop that only books the winning attempt understates what the feature
 * costs.
 */
export async function generateMermaid(
  request: MermaidRequest,
  conversationId: string,
  options: MermaidOptions = {},
): Promise<MermaidDiagram> {
  const instructions = request.instructions?.trim() ?? "";
  if (instructions.length === 0) {
    throw new MermaidError(
      "Preciso que voce diga o que desenhar antes de eu montar o diagrama.",
      ["instrucoes vazias"],
    );
  }

  const complete = options.complete ?? completeWithUsage;
  const signal = options.signal;
  const limit = clampAttempts(options.attempts);
  let problems: string[] = [];
  let previous = "";
  let cutShort = false;
  let stoppedEarly = "";

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    if (signal?.aborted) throw cancelledError();

    const prompt = nextPrompt(request, attempt, { cutShort, stoppedEarly, previous, problems });

    let completion: MermaidCompletion;
    try {
      completion = await complete(prompt, signal);
    } catch (err) {
      // By the time either ceiling fires the provider has read the prompt and
      // started generating, and it charges for both however the socket ends.
      // Booking nothing here would hand the meter a call that cost real money
      // and report it as free.
      if (signal?.aborted || servedThenDropped(err)) {
        await bookAbandoned(conversationId, prompt, attempt);
      }
      // An abort surfaces as whatever the client throws; the caller asked for a
      // cancellation and should hear about a cancellation.
      if (signal?.aborted) throw cancelledError();
      throw err;
    }
    await bookCost(conversationId, completion, attempt);

    // A fragment is not evidence about the model's mermaid. Validating it would
    // fill `problems` with bracket errors it never made and spend the next
    // attempt correcting them instead of asking for a smaller drawing.
    if (completion.truncated) {
      cutShort = true;
      stoppedEarly = "";
      problems = [TRUNCATED_PROBLEM];
      previous = "";
      continue;
    }
    // Same reasoning, opposite correction: the fragment proves nothing, and the
    // one thing we know is that its size was not the complaint.
    if (completion.stoppedEarly) {
      cutShort = false;
      stoppedEarly = completion.stoppedEarly;
      problems = [`${STOPPED_PROBLEM}: ${completion.stoppedEarly}`];
      previous = "";
      continue;
    }
    cutShort = false;
    stoppedEarly = "";

    const { caption, source } = splitCompletion(completion.text ?? "");
    const cleaned = stripFences(source);
    const validation = validateMermaid(cleaned);

    if (validation.ok && validation.kind) {
      return {
        id: randomUUID(),
        kind: validation.kind,
        ...(request.title ? { title: request.title } : {}),
        source: cleaned,
        caption: caption.length > 0 ? caption : fallbackCaption(validation.kind, request.title),
        created_at: new Date().toISOString(),
      };
    }

    problems = validation.problems;
    previous = cleaned;
  }

  if (cutShort) throw new MermaidError(TRUNCATED_MESSAGE, problems, previous);
  if (stoppedEarly) throw new MermaidError(STOPPED_MESSAGE, problems, previous);

  // The diagnosis leaves here in `problems` and in the log, and nowhere else:
  // see `gaveUpMessage` for why it must not leave in the message.
  console.warn(`[mermaid] gave up after ${limit} attempt(s): ${problems.join(" ")}`);
  throw new MermaidError(gaveUpMessage(limit), problems, previous);
}

/** A caller asking for more than three gets three; asking for none gets one. */
function clampAttempts(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return MAX_ATTEMPTS;
  return Math.min(MAX_ATTEMPTS, Math.max(1, Math.trunc(requested)));
}
