---
name: tracking-costs-and-credits
description: Prices realtime, web-search and agent usage against the rate card and explains the two ways the meter lies — double-billed cached tokens and an unrecognised model silently reporting zero. Use whenever touching pricing, costs, credits, the usage report, or a model id anywhere in the codebase, and whenever a number in the cost panel looks wrong or a provider balance will not load.
metadata:
  type: knowledge
  verification_signal: npm --prefix backend test -- src/__tests__/pricing.test.ts
---
# Tracking costs and credits

## When to use

Editing `services/pricing.ts`, `services/costs.ts`, `services/credits.ts`,
`routes/costs.ts`, or **any model id anywhere** — a model rename silently
changes what the meter reports. Also when a displayed number looks wrong.

## Injected knowledge

### The browser reports tokens, the server prices them

Realtime `usage` only exists on the data channel, which only the browser holds.
It sends the raw counts to `POST /api/costs/realtime` and the server applies the
rate card. A client that lied about its usage would only be lying to itself, and
the rate card stays in one place.

### Cached tokens are counted inside each modality total

`input_token_details.audio_tokens` includes the cached ones. Subtract the cached
share before applying the full rate and price the remainder at the cached rate —
`backend/src/services/pricing.ts:117@c165e691`. Skipping the subtraction bills a
heavily-cached session at roughly ten times its real cost, and nothing fails: the
number is simply wrong.

### An unrecognised model reports zero, loudly to nobody

`if (!rates) return summary;` — `backend/src/services/pricing.ts:129@55996118` —
returns the token counts with `usd: 0`. That is a deliberate choice (invented
prices are worse than no price), but it means **a model rename makes the meter
read zero while credit is still burning**. When bumping a model id, add its row
to the rate card in the same change, and let `pricing.test.ts` be the check.

The rate card itself lives at `backend/src/services/pricing.ts:24@d948aa10` and
is dated only in git — audio and text bill at different rates, which is why the
usage object has to be read per modality rather than by its totals.

Hosted web search bills a flat fee per call on top of the model's own tokens.

### Three providers, three different answers to "how much is left"

- OpenRouter reports credits granted minus used.
- DeepSeek reports a balance.
- OpenAI reports nothing at all to a project key: `/v1/organization/costs` needs
  an **admin** key with `api.usage.read`, and `sk-proj-…` gets a 401 naming the
  missing scope — `backend/src/services/credits.ts:135@09d25aa7`. The panel says
  so in words rather than showing a fabricated number, which is the honest
  behaviour and should stay.

All three are queried in parallel with a 12 s timeout, so one slow provider does
not hold up the others.

### The ledger is monotonic and partially in memory

`total_usd` is `max(inMemory, persisted)` so it never appears to go backwards
after a restart; `by_source` is in-memory only, so after a restart the breakdown
will not sum to the total. Reconciliation code that assumes they agree is wrong.

### Instructions are re-billed every turn

The 40 000-char document budget lives in the session instructions, so it is paid
on every single response rather than once per session. Adding material to the
prompt is a recurring cost, not a one-off.

## References

- `backend/src/__tests__/pricing.test.ts` — the arithmetic, including the
  cached-token case. Read it as the executable specification of the rate card.

## Escape hatch

If a price is uncertain, leaving the model out of the rate card gives `usd: 0`,
which reads as "unknown" only if someone notices. Prefer adding the row with the
published number and citing it.
