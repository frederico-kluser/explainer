// === Contract for the thinker roster ===
//
// Which model each of the ten thinkers runs on, which model plans the angles,
// and which single model reads every trace and writes the answer. Frozen ahead
// of the store, the routes and the settings UI so all three can be written at
// the same time without agreeing on anything else.
//
// Types only, for the same reason `deep-tools.ts` is types only: behaviour here
// would make this a second place to look for it.

// The ceiling is `deep-tools.ts`'s, not a second opinion about it. Re-exported
// rather than re-declared so a roster consumer needs one import, and so a change
// to the ceiling cannot land in one file and miss the other.
export { MAX_THINKERS } from "./deep-tools.js";

/**
 * Where a model is billed. Also picks the wire protocol — see `WireProtocol`.
 *
 * These three because they are the three the operator already has a balance for:
 * `services/credits.ts` reports on exactly this set.
 */
export type ThinkerProvider = "openai" | "openrouter" | "deepseek";

/**
 * Which protocol the adapter speaks. Decided by the provider, never by the user.
 *
 * OpenAI is reached through `/v1/responses`; OpenRouter and DeepSeek expose
 * OpenAI-compatible `/chat/completions` endpoints. The distinction is not
 * cosmetic — the two protocols disagree on where reasoning effort goes, on what
 * a tool call id is called, and on what has to be echoed back between turns.
 * Every one of those differences is absorbed by the adapter, so nothing above
 * this line has to know which one is in play.
 */
export type WireProtocol = "openai-responses" | "openai-chat";

/**
 * How hard the model is asked to think.
 *
 * Declared here, next to the setting the user actually picks, and imported by
 * `services/providers/types.ts` rather than restated there: two copies of a
 * literal union drift the moment a provider adds a level.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelChoice {
  provider: ThinkerProvider;
  /** The provider's own id: "gpt-5.2-mini", "deepseek/deepseek-v4-pro", "deepseek-v4-pro". */
  model: string;
  /** Goes out as `reasoning.effort` (Responses) or `reasoning_effort` (Chat). */
  effort?: ReasoningEffort;
  /**
   * Context window in tokens, cached from discovery.
   *
   * `null` means never discovered, which the budgeter must read as the
   * conservative FLOOR — never as "unlimited". A missing number is the one case
   * where guessing high truncates a thinker's prompt at the provider instead of
   * here, where it could have been trimmed deliberately.
   */
  context_window: number | null;
  /**
   * Whether the model accepts `tools`.
   *
   * False takes the WEB away from that thinker; it does not switch the thinker
   * off. A thinker reasoning without sources is still a different angle, which
   * is the thing the fan-out is buying.
   */
  supports_tools: boolean;
  /**
   * USD per 1M tokens, as discovered. `null` = no published price known.
   *
   * Kept on the choice rather than looked up at billing time because these are
   * models `services/pricing.ts` has never heard of, and an unknown model there
   * prices at zero without complaining to anyone.
   */
  rate: { input: number; cached_input: number; output: number } | null;
  discovered_at?: string;
}

export interface ThinkerSlot {
  /**
   * 1..MAX_THINKERS. Stable: it addresses the row in the UI, so it survives a
   * slot being disabled and must not be renumbered to close a gap.
   */
  index: number;
  /**
   * A disabled slot is skipped by the round but KEEPS its model. Turning a
   * thinker off to try nine instead of ten should not cost the operator the
   * model they picked for it.
   */
  enabled: boolean;
  model: ModelChoice;
  /**
   * A fixed angle overriding the planner for this slot alone.
   *
   * Born EMPTY on purpose, and empty is the default the UI should keep offering:
   * the planner naming the angles is the whole reason the fan-out earns its
   * cost. The header of `services/deep-think.ts` records the finding — multi-
   * agent debate beats single-model self-consistency because the agents argue
   * divergent positions, and ten copies of one prompt just buy the same answer
   * ten times. A hand-written angle is an escape hatch for the operator who
   * knows something the planner cannot, not the normal way to fill a roster.
   */
  angle?: string;
}

export interface ThinkerRoster {
  /** Bumped when the shape changes, so an old stored roster can be read or refused. */
  version: 1;
  /**
   * The master: the one model that reads EVERY thinker's full trace and writes
   * the answer. It sees the most tokens of anything in a round, so it is the
   * choice that dominates both the quality and the bill.
   */
  master: ModelChoice;
  /**
   * The planner gets its OWN slot and deliberately does NOT follow the master.
   *
   * Its job is small and bounded: it reads only the scenario plus the asker's
   * reflection — capped at 4 000 chars each in `services/deep-think.ts`, so
   * 8 000 chars at worst — and writes at most 1 200 tokens of JSON. Its failure
   * is already absorbed: `fallbackSpecs` hands the round a deterministic set of
   * angles, so a planner that times out costs the round some variety, not the
   * round.
   *
   * Tying it to the master would make every master upgrade raise the planner's
   * bill in silence, for a job that never needed the bigger model. On the rate
   * card as it stands, `gpt-5.2` costs five times `gpt-5.2-mini` per token in
   * both directions — that multiple is what following the master would apply to
   * a fixed 8k-in / 1.2k-out call, every single round.
   */
  planner: ModelChoice;
  /**
   * ALWAYS MAX_THINKERS items, in index order, including the disabled ones.
   *
   * A fixed-length list rather than "only the enabled ones" so `index` keeps
   * addressing the same UI row and a slot's model survives being toggled off.
   */
  slots: ThinkerSlot[];
  updated_at: string;
}
