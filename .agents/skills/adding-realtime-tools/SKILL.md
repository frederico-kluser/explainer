---
name: adding-realtime-tools
description: Adds a new function tool the voice model can call, across the six files a tool touches in both packages. Use whenever the user wants the assistant to be able to do something new during a call — look something up, read something, trigger something — or whenever a tool exists but the model never calls it or its result never arrives.
metadata:
  type: task
  verification_signal: npm run validate && npm --prefix frontend test
---
# Adding a realtime tool

## When to use

The user wants the assistant to be able to do a new thing mid-conversation. Also
when a tool is defined but the model never calls it, or calls it and the result
never lands.

Load `integrating-openai-realtime` first — the protocol rules it carries are
what make the difference between a tool that works and a tool that is silently
invisible.

## Injected knowledge

A tool is not one edit. It exists in six places, and skipping any one of them
produces a distinct, quiet failure:

| Skipped | Symptom |
|---|---|
| the definition | model has no idea the tool exists |
| the per-source gate | tool offered on materials that cannot serve it |
| the executor branch | model calls it, gets "unknown tool" back as prose |
| argument validation | malformed model output reaches the filesystem |
| the frontend bridge | nothing — the call is never relayed to the server |
| the eval | it works today and nobody notices when it stops |

Argument values arrive from a language model, so they are normalised rather than
trusted: a numeric `material` is coerced to a string, an unmatched material
falls back to the first, and a bad tool name is answered as tool output rather
than thrown — a throw would derail the spoken turn instead of letting the model
correct itself.

## Procedure

1. **Define it** in `backend/src/tools/index.ts` using the flat schema
   (`type`/`name`/`description`/`parameters` at the top level) —
   `backend/src/tools/index.ts:6@cdb48364`. Add the name to
   the `ToolName` union in `backend/src/types/index.ts`. Write the description
   for a model that under-triggers: say when to use it, not only what it does.
2. **Gate it** in `toolsForSources` — decide which material kinds should see it;
   a tool only meaningful with several materials belongs behind the same count
   check `list_materials` uses — `backend/src/tools/index.ts:210@81835297`.
   A tool that needs files on disk belongs behind the `hasFiles` branch.
3. **Execute it** in `services/tool-executor.ts`: add the `case`, pull arguments
   through `requireString`/`optionalString`, and resolve the material with
   `pickSource`. Return `{ output, meta? }`; put anything the UI needs in `meta`.
4. **Nothing to do in the frontend** if the tool is synchronous — the bridge in
   `useRealtimeSession` is generic. If it is slow, return a handle immediately
   and inject the result later, as `dispatch_pi_agent` does.
5. **Write the eval before the prose**: add a case to the owning skill's
   `evals.json` that fails if the tool disappears or its shape changes.
6. **Verify**: `npm run validate` and then `npm --prefix frontend test`
   separately, because the gate cannot fail on frontend tests.

For a live end-to-end check, `verifying-explainer-changes` has the harness.

## References

- `backend/src/tools/index.ts` — every existing definition; copy the nearest one
  rather than writing a schema from memory.

## <evolution>

On completion, run the memory pipeline in `meta-skill-evolution`. Update this
SKILL.md directly only if the task revealed something important **and**
externally verified — a step that was missing from the procedure above, or a new
silent failure mode. Edit or replace the relevant passage rather than appending;
the table above is the memory, and it earns its length.

A tool that simply worked is not a learning. Write nothing, which is the normal
outcome.
