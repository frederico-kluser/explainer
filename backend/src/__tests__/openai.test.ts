import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// HOME to a temp dir BEFORE the first runtime import: `openai.ts` pulls in
// `costs.ts`, which reaches storage, and `sandbox.ts` freezes its
// homedir()-derived roots at module load. Same technique as storage.test.ts,
// and the reason this file cannot touch the real ~/.local/share/voice-assistant.
const tmpHome = mkdtempSync(join(tmpdir(), "explainer-openai-test-"));
process.env.HOME = tmpHome;

const openai = await import("../services/openai.js");
const costs = await import("../services/costs.js");
const { priceTextResponse } = await import("../services/pricing.js");

/** What the stub saw, so a test can assert on what was asked for. */
let lastBody: Record<string, unknown> = {};
let requestCount = 0;

/** Answer the next `/responses` call with `payload`. Nothing opens a socket. */
function stubOpenAI(payload: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: { body?: string }) => {
      requestCount += 1;
      lastBody = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(payload)),
      });
    }),
  );
}

function message(text: string): Record<string, unknown> {
  return { type: "message", content: [{ text }] };
}

/** Let the storage half of the fire-and-forget `addCost` land. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(() => {
  requestCount = 0;
  lastBody = {};
  process.env.OPENAI_API_KEY = "sk-test-not-real";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("completeText", () => {
  it("hands the caller the token counts, so the answer can be priced", async () => {
    stubOpenAI({
      status: "completed",
      model: "gpt-5.2-mini",
      usage: {
        input_tokens: 1200,
        output_tokens: 90,
        input_tokens_details: { cached_tokens: 400 },
      },
      output: [message("O pipeline tem três etapas.")],
    });

    const completion = await openai.completeText("resuma");

    expect(completion.text).toBe("O pipeline tem três etapas.");
    expect(completion.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 90,
      input_tokens_details: { cached_tokens: 400 },
    });
    expect(completion.status).toBe("completed");
    expect(completion.truncated).toBe(false);

    // The whole point of returning `usage`: a caller that books its own charge
    // gets a real number instead of the silent zero an empty usage prices to.
    expect(priceTextResponse(completion.model, completion.usage)).toBeGreaterThan(0);
  });

  it("answers an empty usage rather than undefined when the payload carried none", async () => {
    stubOpenAI({
      model: "gpt-5.2-mini",
      output: [message("sem contadores")],
    });

    const completion = await openai.completeText("resuma");

    expect(completion.usage).toEqual({});
    expect(completion.usage).not.toBeUndefined();
    // `{}` is what makes the field safe to price without a guard — it costs 0,
    // which is the truth here, instead of throwing on a missing object.
    expect(priceTextResponse(completion.model, completion.usage)).toBe(0);
  });

  it("reports the model the provider answered with, not the one asked for", async () => {
    stubOpenAI({
      model: "gpt-5.2-mini-2026-01-15",
      usage: { input_tokens: 100, output_tokens: 10 },
      output: [message("ok")],
    });

    const completion = await openai.completeText("resuma");

    // The request named the alias; the answer came back as a dated snapshot.
    // Pricing has to follow the answer, so that is what gets returned.
    expect(lastBody.model).toBe(openai.TEXT_MODEL);
    expect(completion.model).toBe("gpt-5.2-mini-2026-01-15");
    expect(completion.model).not.toBe(lastBody.model);
  });

  it("falls back to the requested model only when the payload names none", async () => {
    stubOpenAI({ output: [message("ok")] });

    const completion = await openai.completeText("resuma");

    expect(completion.model).toBe(openai.TEXT_MODEL);
  });

  it("flags a completion that ran out of output tokens, and keeps the prose", async () => {
    stubOpenAI({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      model: "gpt-5.2-mini",
      usage: { input_tokens: 100, output_tokens: 400 },
      output: [message("O pipeline tem três etapas. A primeira")],
    });

    const completion = await openai.completeText("resuma", { maxTokens: 400 });

    expect(completion.status).toBe("incomplete");
    expect(completion.truncated).toBe(true);
    // A 200 with a cut-off answer is still an answer; the caller decides what to
    // do with it, which it cannot do if the text is thrown away here.
    expect(completion.text).toBe("O pipeline tem três etapas. A primeira");
  });

  it("does not call every incomplete response truncated", async () => {
    stubOpenAI({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      model: "gpt-5.2-mini",
      output: [message("")],
    });

    const completion = await openai.completeText("resuma");

    // `truncated` means exactly one thing — the output hit its token ceiling.
    // Any other reason for stopping is a different problem with a different fix.
    expect(completion.status).toBe("incomplete");
    expect(completion.truncated).toBe(false);
  });

  it("books the conversation exactly once when given an id", async () => {
    const conversationId = randomUUID();
    const usage = {
      input_tokens: 1000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 200 },
    };
    stubOpenAI({
      model: "gpt-5.2-mini",
      usage,
      output: [message("resumo")],
    });

    const completion = await openai.completeText("resuma", { conversationId });
    await drain();

    const ledger = await costs.getCosts(conversationId);
    expect(requestCount).toBe(1);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]!.source).toBe("text");
    expect(ledger.entries[0]!.tokens).toEqual({ input: 1000, output: 100, cached: 200 });
    expect(ledger.by_source.text).toBeCloseTo(
      priceTextResponse("gpt-5.2-mini", usage),
      12,
    );

    // `usage` comes back even so. A caller holding the id must NOT also price
    // this itself — the two paths are mutually exclusive and both would book.
    expect(completion.usage).toEqual(usage);
  });

  it("books nothing without an id, leaving the caller to price the usage", async () => {
    const conversationId = randomUUID();
    stubOpenAI({
      model: "gpt-5.2-mini",
      usage: { input_tokens: 1000, output_tokens: 100 },
      output: [message("resumo")],
    });

    const completion = await openai.completeText("resuma");
    await drain();

    const ledger = await costs.getCosts(conversationId);
    expect(ledger.entries).toHaveLength(0);
    expect(ledger.by_source.text).toBe(0);
    // The other half of the exclusive choice: no id, so the charge is the
    // caller's to book, and `usage` is what lets it.
    expect(priceTextResponse(completion.model, completion.usage)).toBeGreaterThan(0);
  });
});

describe("webSearch", () => {
  it("attaches the conversation context before the question when given one", async () => {
    stubOpenAI({
      model: openai.SEARCH_MODEL,
      usage: { input_tokens: 100, output_tokens: 20 },
      output: [message("Segundo o site tal, o valor atual e vinte reais.")],
    });

    const result = await openai.webSearch("quanto custa hoje?", {
      context: "O usuario esta em Sao Paulo e pergunta sobre o plano mensal.",
    });

    const input = String(lastBody.input);
    expect(input).toContain(
      "Contexto da conversa: O usuario esta em Sao Paulo e pergunta sobre o plano mensal.",
    );
    // The conversation comes first; the question is what the search answers.
    expect(input.indexOf("Contexto da conversa")).toBeLessThan(input.indexOf("Pergunta:"));
    expect(result.text).toContain("Segundo o site tal");
  });

  it("keeps the plain query when no context is given", async () => {
    stubOpenAI({
      model: openai.SEARCH_MODEL,
      usage: {},
      output: [],
    });

    await openai.webSearch("quanto custa hoje?");

    const input = String(lastBody.input);
    expect(input).not.toContain("Contexto da conversa");
    expect(input).toContain("Pergunta: quanto custa hoje?");
  });

  it("assembles the input exactly: instruction, context, then the question", async () => {
    stubOpenAI({
      model: openai.SEARCH_MODEL,
      usage: { input_tokens: 100, output_tokens: 20 },
      output: [message("resposta")],
    });

    await openai.webSearch("quanto custa?", {
      context: "bloco da conversa",
    });

    expect(lastBody.input).toBe(
      "Pesquise na web e responda de forma curta e objetiva, em portugues do Brasil, " +
        "em no maximo cinco frases, citando as fontes.\n\n" +
        "Contexto da conversa: bloco da conversa\n\n" +
        "Pergunta: quanto custa?",
    );
  });

  it("mounts the search payload around the context-aware input", async () => {
    stubOpenAI({
      model: openai.SEARCH_MODEL,
      usage: {},
      output: [],
    });

    await openai.webSearch("quanto custa?", { context: "um bloco" });

    expect(lastBody.model).toBe(openai.SEARCH_MODEL);
    expect(lastBody.tools).toEqual([{ type: "web_search" }]);
    expect(lastBody.tool_choice).toBe("auto");
    expect(lastBody.max_output_tokens).toBe(900);
    expect(lastBody.reasoning).toEqual({ effort: "low" });
  });
});
