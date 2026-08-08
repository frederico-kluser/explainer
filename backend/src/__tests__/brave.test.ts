import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  braveSearch,
  BraveSearchError,
  getBraveSearchStats,
  resetBraveSearchStats,
} from "../services/brave.js";

// The client only ever reads `ok`, `status`, `headers.get()` and `text()` off a
// response, so the double supplies exactly those. A real `Response` would drag a
// ReadableStream into the fake-timer tests, where draining it is no longer a
// plain microtask.
//
// `headers` is omitted entirely unless a test asks for it: a response with no
// headers at all is what a header-blind transport looks like, and the client has
// to degrade to its blind backoff instead of throwing.
function braveResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  const lookup = new Map(
    Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    ...(headers
      ? { headers: { get: (name: string) => lookup.get(name.toLowerCase()) ?? null } }
      : {}),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** A 429 exactly as Brave sends it, with whatever rate-limit headers a test wants. */
function rateLimited(headers?: Record<string, string>): Response {
  return braveResponse(
    { type: "ErrorResponse", error: { status: 429, detail: "Rate limit exceeded" } },
    429,
    headers,
  );
}

function okBody(results: unknown[]): unknown {
  return { query: { original: "q" }, type: "search", web: { results } };
}

const RESULT = {
  title: "Aposentadoria por idade",
  url: "https://www.gov.br/aposentadoria",
  description: "Regras atuais.",
  page_age: "2026-03-04T10:00:00",
};

type FetchInit = { headers?: Record<string, string>; signal?: AbortSignal };

function stubFetch(handler: (url: string, call: number) => Response | Promise<Response>) {
  let calls = 0;
  const mock = vi.fn((input: unknown, _init?: FetchInit) => {
    const call = calls++;
    return Promise.resolve(handler(String(input), call));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function urlOf(mock: ReturnType<typeof stubFetch>, index = 0): URL {
  const call = mock.mock.calls[index];
  expect(call).toBeDefined();
  return new URL(String(call![0]));
}

beforeEach(() => {
  process.env.BRAVE_API_KEY = "test-key";
  // Pacing and backoff are exercised on purpose in their own tests; everywhere
  // else they would only make the suite sleep.
  process.env.BRAVE_MIN_INTERVAL_MS = "0";
  process.env.BRAVE_RETRY_BASE_MS = "0";
  delete process.env.BRAVE_COUNTRY;
  delete process.env.BRAVE_SEARCH_LANG;
  delete process.env.BRAVE_SAFESEARCH;
  delete process.env.BRAVE_FRESHNESS;
  delete process.env.BRAVE_TIMEOUT_MS;
  delete process.env.BRAVE_MAX_BACKOFF_MS;
  resetBraveSearchStats();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // The backoff test spies on Math.random to pin the jitter down.
  vi.restoreAllMocks();
});

describe("braveSearch", () => {
  it("parses web.results into the frozen BraveResult shape", async () => {
    const mock = stubFetch(() => braveResponse(okBody([RESULT])));

    const response = await braveSearch("aposentadoria por idade");

    expect(response.query).toBe("aposentadoria por idade");
    expect(response.results).toEqual([
      {
        title: "Aposentadoria por idade",
        url: "https://www.gov.br/aposentadoria",
        snippet: "Regras atuais.",
        age: "2026-03-04T10:00:00",
      },
    ]);
    expect(response.summary).toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("sends the endpoint, the token header and the documented parameters", async () => {
    const mock = stubFetch(() => braveResponse(okBody([])));

    await braveSearch("teste");

    const url = urlOf(mock);
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("teste");
    expect(url.searchParams.get("count")).toBe("10");
    expect(url.searchParams.get("country")).toBe("br");
    expect(url.searchParams.get("search_lang")).toBe("pt-br");
    expect(url.searchParams.get("safesearch")).toBe("moderate");
    expect(url.searchParams.get("freshness")).toBeNull();

    const init = mock.mock.calls[0]![1];
    expect(init?.headers).toMatchObject({
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": "test-key",
    });
  });

  it("strips Brave's <strong> highlights and decodes the escaped entities", async () => {
    stubFetch(() =>
      braveResponse(
        okBody([
          {
            title: "<strong>Node</strong> 22",
            url: "https://exemplo.com/a",
            description:
              "<strong>Node</strong> 22 &amp; o &#x27;fetch&#x27; &quot;nativo&quot;&nbsp;já",
          },
        ]),
      ),
    );

    const { results } = await braveSearch("node 22");

    expect(results[0]!.title).toBe("Node 22");
    expect(results[0]!.snippet).toBe(`Node 22 & o 'fetch' "nativo" já`);
  });

  // This test used to expect `Use <strong> para dar ênfase.` — the escaped tag
  // preserved as visible text. That was backwards: decoding ran *after* the tags
  // were stripped, so the cleaner rebuilt a live tag out of the escaping Brave
  // had done precisely to neutralise it, and the snippet goes to an LLM and then
  // to TTS. Nothing shaped `<...>` may leave the cleaner now.
  it("removes a tag the page had escaped instead of decoding it back into markup", async () => {
    stubFetch(() =>
      braveResponse(
        okBody([
          {
            title: "HTML",
            url: "https://exemplo.com/html",
            description: "Use &lt;strong&gt;forte&lt;/strong&gt; para dar ênfase.",
          },
        ]),
      ),
    );

    const { results } = await braveSearch("html strong");

    expect(results[0]!.snippet).toBe("Use forte para dar ênfase.");
  });

  it("lets no markup through the snippet, however the page encoded it", async () => {
    const cases: Array<{ description: string; snippet: string }> = [
      // Escaped markup: what Brave actually sends when a page contains a script.
      { description: "&lt;script&gt;alert(2)&lt;/script&gt;", snippet: "alert(2)" },
      // Raw markup, in case Brave ever stops escaping. Tags collapse to nothing
      // rather than to a space, which is what keeps `aposenta<strong>doria</strong>`
      // one word — and is why `x<br/>fim` comes out joined.
      {
        description: "<script>alert(1)</script> texto <em>x</em><br/>fim",
        snippet: "alert(1) texto xfim",
      },
      { description: "aposenta<strong>doria</strong> por idade", snippet: "aposentadoria por idade" },
      // Uppercase and attributes: the old `/<\/?strong>/gi` matched neither, and
      // left an unbalanced opening tag behind.
      {
        description: '<STRONG>maiuscula</STRONG> <strong class="hl">com atributo</strong>',
        snippet: "maiuscula com atributo",
      },
      // A `<` whose `>` only appears after a decode round.
      { description: "&amp;lt;script&amp;gt;x&amp;lt;/script&amp;gt;", snippet: "x" },
      // Overlapping angle brackets: the greedy-free match eats the outer pair and
      // leaves inert text, never a surviving tag.
      { description: "<scr<script>ipt>alerta", snippet: "ipt>alerta" },
      // Numeric entities, decimal and hexadecimal.
      { description: "caf&#233; e caf&#xe9;", snippet: "café e café" },
      // Control characters a decode can produce. NUL is unspeakable, literally.
      { description: "&#0; nulo&#13;", snippet: "nulo" },
      // An entity nobody defined stays as it was written: deleting it would
      // silently rewrite the sentence.
      { description: "a &naoexiste; b", snippet: "a &naoexiste; b" },
    ];

    stubFetch(() =>
      braveResponse(
        okBody(
          cases.map((entry, index) => ({
            title: "t",
            url: `https://exemplo.com/${index}`,
            description: entry.description,
          })),
        ),
      ),
    );

    const { results } = await braveSearch("sanitização");

    expect(results.map((result) => result.snippet)).toEqual(cases.map((entry) => entry.snippet));
    for (const result of results) expect(result.snippet).not.toMatch(/<[^>]*>/);
  });

  it("uses page_age as the ISO date and refuses Brave's relative prose", async () => {
    stubFetch(() =>
      braveResponse(
        okBody([
          { title: "a", url: "https://exemplo.com/a", description: "", age: "3 days ago" },
          { title: "b", url: "https://exemplo.com/b", description: "", age: "2025-01-02" },
        ]),
      ),
    );

    const { results } = await braveSearch("datas");

    expect(results[0]!.age).toBeUndefined();
    expect(results[1]!.age).toBe("2025-01-02");
  });

  it("fails with an actionable message when the key is missing, without calling the API", async () => {
    delete process.env.BRAVE_API_KEY;
    const mock = stubFetch(() => braveResponse(okBody([])));

    const error = await braveSearch("qualquer").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BraveSearchError);
    expect((error as BraveSearchError).message).toContain("BRAVE_API_KEY");
    expect((error as BraveSearchError).status).toBeUndefined();
    expect(mock).not.toHaveBeenCalled();
  });

  it("does not retry a 401 and surfaces the API's own explanation", async () => {
    const mock = stubFetch(() =>
      braveResponse(
        {
          type: "ErrorResponse",
          error: { status: 401, detail: "Subscription token invalid", code: "SUBSCRIPTION_TOKEN_INVALID" },
        },
        401,
      ),
    );

    const error = await braveSearch("qualquer").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BraveSearchError);
    expect((error as BraveSearchError).status).toBe(401);
    expect((error as BraveSearchError).message).toContain("Subscription token invalid");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(getBraveSearchStats()).toMatchObject({ searches: 0, failures: 1, retries: 0 });
  });

  it("does not retry a 422 and names the parameter Brave rejected", async () => {
    const mock = stubFetch(() =>
      braveResponse(
        {
          type: "ErrorResponse",
          error: {
            status: 422,
            detail: "Unable to validate request parameter(s)",
            meta: { errors: [{ msg: "Input should be 'pt-br' or 'pt-pt'", loc: ["query", "search_lang"] }] },
            code: "VALIDATION",
          },
        },
        422,
      ),
    );

    const error = await braveSearch("qualquer").catch((err: unknown) => err);

    expect((error as BraveSearchError).status).toBe(422);
    expect((error as BraveSearchError).message).toContain("Unable to validate request parameter(s)");
    expect((error as BraveSearchError).message).toContain("pt-br");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and returns the results of the attempt that lands", async () => {
    const mock = stubFetch((_url, call) =>
      call === 0
        ? braveResponse({ type: "ErrorResponse", error: { status: 429, detail: "Rate limit exceeded" } }, 429)
        : braveResponse(okBody([RESULT])),
    );

    const response = await braveSearch("aposentadoria");

    expect(response.results).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(getBraveSearchStats()).toMatchObject({
      searches: 1,
      requests: 2,
      retries: 1,
      failures: 0,
    });
  });

  it("gives up after three attempts when the 429s never stop", async () => {
    const mock = stubFetch(() =>
      braveResponse({ type: "ErrorResponse", error: { status: 429, detail: "Rate limit exceeded" } }, 429),
    );

    const error = await braveSearch("insistente").catch((err: unknown) => err);

    expect((error as BraveSearchError).status).toBe(429);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(getBraveSearchStats()).toMatchObject({ retries: 2, failures: 1 });
  });

  it("fails immediately when the 429 is the monthly quota rather than a throttle", async () => {
    // Brave answers both limits with a 429 and separates them only here: the
    // second figure is the plan window, and `0` remaining on it means the quota
    // is gone until the reset — 1419704 s away. Retrying spends two more
    // requests of a budget that no longer exists, and in a 30-search deep-think
    // that is a minute of queue before the first honest error.
    const mock = stubFetch(() =>
      rateLimited({ "X-RateLimit-Remaining": "1, 0", "X-RateLimit-Reset": "1, 1419704" }),
    );

    const error = await braveSearch("cota estourada").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BraveSearchError);
    expect((error as BraveSearchError).status).toBe(429);
    expect((error as BraveSearchError).retryable).toBe(false);
    expect((error as BraveSearchError).message).toContain("cota da Brave Search acabou");
    expect((error as BraveSearchError).message).toContain("17 dias");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(getBraveSearchStats()).toMatchObject({ requests: 1, retries: 0, failures: 1 });
  });

  it("keeps the blind backoff when the 429 carries no rate-limit headers", async () => {
    const mock = stubFetch(() => rateLimited());

    const error = await braveSearch("sem headers").catch((err: unknown) => err);

    expect((error as BraveSearchError).status).toBe(429);
    expect((error as BraveSearchError).retryable).toBe(true);
    expect((error as BraveSearchError).message).toContain("BRAVE_MIN_INTERVAL_MS");
    expect(mock).toHaveBeenCalledTimes(3);
    expect(getBraveSearchStats()).toMatchObject({ retries: 2, failures: 1 });
  });

  it("keeps the blind backoff when the rate-limit headers make no sense", async () => {
    const mock = stubFetch(() =>
      rateLimited({ "X-RateLimit-Remaining": "", "X-RateLimit-Reset": "logo mais" }),
    );

    const error = await braveSearch("headers tortos").catch((err: unknown) => err);

    expect((error as BraveSearchError).retryable).toBe(true);
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("retries a 5xx, which is the provider having a bad moment", async () => {
    const mock = stubFetch((_url, call) =>
      call === 0
        ? braveResponse({ error: { detail: "internal error" } }, 500)
        : call === 1
          ? braveResponse({ error: { detail: "bad gateway" } }, 502)
          : braveResponse(okBody([RESULT])),
    );

    const response = await braveSearch("instável");

    expect(response.results).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(getBraveSearchStats()).toMatchObject({ searches: 1, retries: 2, failures: 0 });
  });

  it("gives up on a 503 that never clears, and never retries an unexpected 4xx", async () => {
    const unavailable = stubFetch(() => braveResponse({ error: { detail: "unavailable" } }, 503));

    const error = await braveSearch("fora do ar").catch((err: unknown) => err);

    expect((error as BraveSearchError).status).toBe(503);
    expect((error as BraveSearchError).message).toContain("unavailable");
    expect(unavailable).toHaveBeenCalledTimes(3);

    const notFound = stubFetch(() => braveResponse({ error: { detail: "sumiu" } }, 404));

    const missing = await braveSearch("rota errada").catch((err: unknown) => err);

    expect((missing as BraveSearchError).status).toBe(404);
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty query without spending a request", async () => {
    const mock = stubFetch(() => braveResponse(okBody([RESULT])));

    const error = await braveSearch("   ").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BraveSearchError);
    expect((error as BraveSearchError).message).toContain("query chegou vazia");
    expect(mock).not.toHaveBeenCalled();
    expect(getBraveSearchStats()).toMatchObject({ requests: 0, searches: 0, failures: 1 });
  });

  it("hands fetch an AbortSignal that fires when the timeout budget runs out", async () => {
    // Real timers on purpose: `AbortSignal.timeout` runs on a Node-internal
    // timer that vitest's fake clock does not drive.
    process.env.BRAVE_TIMEOUT_MS = "120";
    const mock = stubFetch(() => braveResponse(okBody([])));

    await braveSearch("com sinal");

    const signal = mock.mock.calls[0]![1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);

    await new Promise<void>((resolve) => {
      signal!.addEventListener("abort", () => resolve(), { once: true });
    });

    expect(signal!.aborted).toBe(true);
    expect((signal!.reason as Error).name).toBe("TimeoutError");
  });

  it("retries a network fault, which a timeout is deliberately not", async () => {
    const mock = stubFetch((_url, call) =>
      call === 0 ? Promise.reject(new TypeError("fetch failed")) : braveResponse(okBody([RESULT])),
    );

    const response = await braveSearch("rede instável");

    expect(response.results).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("reports a timeout once instead of spending the budget three times", async () => {
    process.env.BRAVE_TIMEOUT_MS = "15000";
    const mock = stubFetch(() =>
      Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    );

    const error = await braveSearch("lenta").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BraveSearchError);
    expect((error as BraveSearchError).message).toContain("15000 ms");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(getBraveSearchStats()).toMatchObject({ retries: 0, failures: 1 });
  });

  it("degrades to zero results when the payload carries no web.results", async () => {
    stubFetch(() => braveResponse({ type: "search", query: { original: "q" } }));

    const response = await braveSearch("nada");

    expect(response.results).toEqual([]);
    expect(getBraveSearchStats()).toMatchObject({ searches: 1, failures: 0 });
  });

  it("degrades to zero results when a 200 body is not JSON at all", async () => {
    stubFetch(
      () =>
        ({
          ok: true,
          status: 200,
          text: () => Promise.resolve("<html>challenge</html>"),
        }) as unknown as Response,
    );

    const response = await braveSearch("proxy");

    expect(response.results).toEqual([]);
  });

  it("skips entries with no url rather than emitting a citation nobody can open", async () => {
    stubFetch(() =>
      braveResponse(okBody([{ title: "sem url", description: "x" }, { url: "   " }, RESULT])),
    );

    const { results } = await braveSearch("parciais");

    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe("https://www.gov.br/aposentadoria");
  });

  it("clamps count into the 1..20 range the API enforces", async () => {
    const mock = stubFetch(() => braveResponse(okBody([])));

    await braveSearch("a", { count: 999 });
    await braveSearch("b", { count: 0 });
    await braveSearch("c", { count: 7.9 });
    await braveSearch("d");

    expect(urlOf(mock, 0).searchParams.get("count")).toBe("20");
    expect(urlOf(mock, 1).searchParams.get("count")).toBe("1");
    expect(urlOf(mock, 2).searchParams.get("count")).toBe("7");
    expect(urlOf(mock, 3).searchParams.get("count")).toBe("10");
  });

  it("ignores an env value the API would reject instead of 422-ing every search", async () => {
    process.env.BRAVE_SAFESEARCH = "muito";
    process.env.BRAVE_FRESHNESS = "ontem";
    const mock = stubFetch(() => braveResponse(okBody([])));

    await braveSearch("config torta");

    const url = urlOf(mock);
    expect(url.searchParams.get("safesearch")).toBe("moderate");
    expect(url.searchParams.get("freshness")).toBeNull();
  });

  it("passes an env value the API does accept", async () => {
    process.env.BRAVE_SAFESEARCH = "off";
    process.env.BRAVE_FRESHNESS = "pw";
    process.env.BRAVE_SEARCH_LANG = "en";
    process.env.BRAVE_COUNTRY = "us";
    const mock = stubFetch(() => braveResponse(okBody([])));

    await braveSearch("config boa");

    const url = urlOf(mock);
    expect(url.searchParams.get("safesearch")).toBe("off");
    expect(url.searchParams.get("freshness")).toBe("pw");
    expect(url.searchParams.get("search_lang")).toBe("en");
    expect(url.searchParams.get("country")).toBe("us");
  });

  it("keeps a failed search from poisoning the ones queued behind it", async () => {
    const mock = stubFetch((_url, call) =>
      call === 0
        ? braveResponse({ type: "ErrorResponse", error: { status: 401, detail: "nope" } }, 401)
        : braveResponse(okBody([RESULT])),
    );

    const failed = braveSearch("primeira");
    const survivor = braveSearch("segunda");

    await expect(failed).rejects.toBeInstanceOf(BraveSearchError);
    await expect(survivor).resolves.toMatchObject({ query: "segunda" });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("measures the interval from the response, because Brave meters by arrival", async () => {
    process.env.BRAVE_MIN_INTERVAL_MS = "1100";
    vi.useFakeTimers();

    const issuedAt: number[] = [];
    stubFetch(() => {
      issuedAt.push(Date.now());
      // A slow exchange. Timed from when the request *left*, the next one would
      // depart 1100 ms later and Brave would see the two only 500 ms apart —
      // which is how a run at 1100 ms spacing still collected a 429 in practice.
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(braveResponse(okBody([]))), 600),
      );
    });

    const searches = [braveSearch("um"), braveSearch("dois")];
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(Promise.all(searches)).resolves.toHaveLength(2);

    expect(issuedAt).toHaveLength(2);
    expect(issuedAt[1]! - issuedAt[0]!).toBeGreaterThanOrEqual(1_100 + 600);
  });

  // The fake-clock tests are grouped from here on purpose: they advance a fake
  // clock, and the pacing state they leave behind is only harmless because
  // `awaitSlot` caps its wait at one interval.
  it("spaces concurrent searches apart to stay inside the free plan's 1 req/s", async () => {
    process.env.BRAVE_MIN_INTERVAL_MS = "1100";
    vi.useFakeTimers();

    // Measured as the gaps between the requests that were actually issued, not
    // as call counts at chosen instants: where the run starts on the fake clock
    // depends on what the earlier tests left in the pacer.
    const issuedAt: number[] = [];
    const mock = stubFetch(() => {
      issuedAt.push(Date.now());
      return braveResponse(okBody([]));
    });

    const searches = [braveSearch("um"), braveSearch("dois"), braveSearch("três")];
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(Promise.all(searches)).resolves.toHaveLength(3);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(issuedAt).toHaveLength(3);
    expect(issuedAt[1]! - issuedAt[0]!).toBeGreaterThanOrEqual(1_100);
    expect(issuedAt[2]! - issuedAt[1]!).toBeGreaterThanOrEqual(1_100);
  });

  it("treats a blank BRAVE_MIN_INTERVAL_MS as unset rather than as zero", async () => {
    // `Number("") === 0`, finite and non-negative, so an env line left as
    // `BRAVE_MIN_INTERVAL_MS=` used to pass the guard and turn the pacer off for
    // the whole run — which on the free plan is a 429 on the second search.
    process.env.BRAVE_MIN_INTERVAL_MS = "   ";
    vi.useFakeTimers();

    const issuedAt: number[] = [];
    const mock = stubFetch(() => {
      issuedAt.push(Date.now());
      return braveResponse(okBody([]));
    });

    const searches = [braveSearch("um"), braveSearch("dois")];
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(Promise.all(searches)).resolves.toHaveLength(2);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(issuedAt[1]! - issuedAt[0]!).toBeGreaterThanOrEqual(1_100);
  });

  it("waits as long as X-RateLimit-Reset says before retrying a throttle", async () => {
    // `BRAVE_RETRY_BASE_MS` is 0 for the whole suite, so any wait measured here
    // can only have come from the header.
    vi.useFakeTimers();

    const issuedAt: number[] = [];
    const mock = stubFetch((_url, call) => {
      issuedAt.push(Date.now());
      return call === 0
        ? rateLimited({ "X-RateLimit-Remaining": "0, 1934", "X-RateLimit-Reset": "2, 1419704" })
        : braveResponse(okBody([RESULT]));
    });

    const search = braveSearch("throttle");
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(search).resolves.toMatchObject({ query: "throttle" });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(issuedAt[1]! - issuedAt[0]!).toBe(2_000);
  });

  it("takes the earliest reset when Brave does not say which window is empty", async () => {
    // No `remaining` header, so the client cannot tell a throttle from a quota.
    // The shortest window is the earliest legal retry — reading the longest one
    // would turn every per-second throttle into a hard failure.
    vi.useFakeTimers();

    const mock = stubFetch((_url, call) =>
      call === 0
        ? rateLimited({ "X-RateLimit-Reset": "1, 1419704" })
        : braveResponse(okBody([RESULT])),
    );

    const search = braveSearch("sem remaining");
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(search).resolves.toMatchObject({ query: "sem remaining" });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("lets BRAVE_MAX_BACKOFF_MS raise the wait that is still worth taking", async () => {
    // 30 s is past the default ceiling, so this same response fails outright
    // unless the operator says the queue can afford to wait.
    process.env.BRAVE_MAX_BACKOFF_MS = "60000";
    vi.useFakeTimers();

    const mock = stubFetch((_url, call) =>
      call === 0
        ? rateLimited({ "X-RateLimit-Remaining": "0, 1934", "X-RateLimit-Reset": "30, 1419704" })
        : braveResponse(okBody([RESULT])),
    );

    const search = braveSearch("espera longa");
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(search).resolves.toMatchObject({ query: "espera longa" });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("doubles the blind backoff between attempts, jitter included", async () => {
    process.env.BRAVE_RETRY_BASE_MS = "1000";
    vi.useFakeTimers();
    // Pins the jitter so the two waits can be asserted exactly: 1 + 0.8 * 0.25.
    vi.spyOn(Math, "random").mockReturnValue(0.8);

    const issuedAt: number[] = [];
    const mock = stubFetch(() => {
      issuedAt.push(Date.now());
      return rateLimited();
    });

    const search = braveSearch("insistente");
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(search).rejects.toBeInstanceOf(BraveSearchError);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(issuedAt[1]! - issuedAt[0]!).toBe(1_200);
    expect(issuedAt[2]! - issuedAt[1]!).toBe(2_400);
  });

  // Last on purpose: it winds the system clock backwards.
  it("caps the pacing wait at one interval when the clock jumps backwards", async () => {
    process.env.BRAVE_MIN_INTERVAL_MS = "1100";
    vi.useFakeTimers();

    const mock = stubFetch(() => braveResponse(okBody([])));

    const first = braveSearch("primeira");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(first).resolves.toMatchObject({ query: "primeira" });

    // An NTP correction, or a laptop waking from suspend: the last exchange is
    // suddenly stamped an hour in the future, and the raw difference would park
    // every remaining search of the run for that hour.
    vi.setSystemTime(Date.now() - 3_600_000);

    const second = braveSearch("segunda");
    await vi.advanceTimersByTimeAsync(1_200);

    expect(mock).toHaveBeenCalledTimes(2);

    // Drained past the uncapped wait so a failure above cannot leave the shared
    // queue holding a promise that never settles.
    await vi.advanceTimersByTimeAsync(3_700_000);
    await expect(second).resolves.toMatchObject({ query: "segunda" });
  });
});
