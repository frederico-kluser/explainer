// Provider balances.
//
// Three providers, three completely different answers to "how much is left":
// OpenRouter reports credits granted minus used, DeepSeek reports a balance, and
// OpenAI reports nothing at all unless you hand it an *admin* key — a project
// key (`sk-proj-…`) is missing the `api.usage.read` scope and gets a 401 with
// that exact complaint. Rather than pretend, each provider reports its own
// status and the UI shows what it got.

export interface ProviderCredit {
  provider: "openai" | "openrouter" | "deepseek";
  label: string;
  /** Remaining balance in USD, when the provider will say. */
  remaining_usd: number | null;
  /** Spent so far, when the provider will say. */
  used_usd: number | null;
  /** Credits granted in total, when the provider will say. */
  total_usd: number | null;
  status: "ok" | "unavailable" | "error";
  /** Why it is unavailable, in words the operator can act on. */
  note?: string;
}

const TIMEOUT_MS = 12_000;

async function getJSON<T>(url: string, key: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text.slice(0, 200));
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function openRouter(): Promise<ProviderCredit> {
  const base: ProviderCredit = {
    provider: "openrouter",
    label: "OpenRouter",
    remaining_usd: null,
    used_usd: null,
    total_usd: null,
    status: "unavailable",
  };

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ...base, note: "OPENROUTER_API_KEY não está definida." };

  try {
    const data = await getJSON<{ data?: { total_credits?: number; total_usage?: number } }>(
      "https://openrouter.ai/api/v1/credits",
      key,
    );
    const total = data.data?.total_credits ?? 0;
    const used = data.data?.total_usage ?? 0;
    return {
      ...base,
      status: "ok",
      total_usd: total,
      used_usd: used,
      remaining_usd: total - used,
    };
  } catch (err) {
    return { ...base, status: "error", note: errText(err) };
  }
}

async function deepSeek(): Promise<ProviderCredit> {
  const base: ProviderCredit = {
    provider: "deepseek",
    label: "DeepSeek",
    remaining_usd: null,
    used_usd: null,
    total_usd: null,
    status: "unavailable",
  };

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { ...base, note: "DEEPSEEK_API_KEY não está definida." };

  try {
    const data = await getJSON<{
      is_available?: boolean;
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    }>("https://api.deepseek.com/user/balance", key);

    const usd =
      data.balance_infos?.find((info) => info.currency === "USD") ??
      data.balance_infos?.[0];
    return {
      ...base,
      status: "ok",
      remaining_usd: usd?.total_balance ? Number(usd.total_balance) : null,
    };
  } catch (err) {
    return { ...base, status: "error", note: errText(err) };
  }
}

async function openAI(): Promise<ProviderCredit> {
  const base: ProviderCredit = {
    provider: "openai",
    label: "OpenAI",
    remaining_usd: null,
    used_usd: null,
    total_usd: null,
    status: "unavailable",
  };

  // Only an admin key can read the Costs API. A project key gets a 401 naming
  // the missing scope, so asking with the wrong key just wastes a round-trip.
  const key = process.env.OPENAI_ADMIN_KEY;
  if (!key) {
    return {
      ...base,
      note:
        "A OpenAI só expõe gastos para chaves de administração. Crie uma em " +
        "platform.openai.com/settings/organization/admin-keys com o escopo " +
        "api.usage.read e defina OPENAI_ADMIN_KEY para ver o gasto do mês aqui.",
    };
  }

  try {
    const start = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const data = await getJSON<{
      data?: Array<{ results?: Array<{ amount?: { value?: number } }> }>;
    }>(
      `https://api.openai.com/v1/organization/costs?start_time=${start}&limit=180`,
      key,
    );

    const used = (data.data ?? []).reduce(
      (sum, bucket) =>
        sum +
        (bucket.results ?? []).reduce(
          (inner, result) => inner + (result.amount?.value ?? 0),
          0,
        ),
      0,
    );

    return { ...base, status: "ok", used_usd: used, note: "gasto dos últimos 30 dias" };
  } catch (err) {
    return { ...base, status: "error", note: errText(err) };
  }
}

/** Ask every provider at once; a slow one must not hold up the others. */
export async function getCredits(): Promise<ProviderCredit[]> {
  return Promise.all([openAI(), openRouter(), deepSeek()]);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
