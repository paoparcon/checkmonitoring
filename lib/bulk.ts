/**
 * The selection a bulk action is allowed to act on.
 *
 * Pure, and separate from the server actions, so the cleaning rules are
 * asserted on their own rather than inferred from a database test.
 *
 * **There is no cap on how many checks one click may act on** (user ruling
 * 2026-11-05: "dont limit 50 tick at a time. i can select all"). Until then a
 * tick-box action refused more than `caps.bulkSelection` (50) checks, to stop a
 * select-all over a filter turning "the twelve I meant" into "every check in
 * the company". The user owns that judgement and has made it. What still holds
 * a large selection in check is the bulk bar itself — it states the count and
 * the total before anything is pressed — and `runEach`'s time budget, which
 * stops a run that would outlive the request and says how many it did not
 * reach, instead of letting the platform kill it half way through.
 */

export type SelectionResult =
  | { ok: true; checkIds: string[] }
  | { ok: false; message: string }

/**
 * Cleans a submitted selection, or refuses an empty one.
 *
 * De-duplication matters for more than arithmetic: the same id submitted twice
 * would otherwise be acted on twice, and the second attempt would fail on a
 * transition the first one just made — reporting a refusal for a check the
 * user did in fact release.
 */
export function parseSelection(raw: readonly string[]): SelectionResult {
  const checkIds = [...new Set(raw.map((v) => v.trim()).filter((v) => v !== ''))]
  if (checkIds.length === 0) {
    return { ok: false, message: 'Select at least one check first.' }
  }
  return { ok: true, checkIds }
}
