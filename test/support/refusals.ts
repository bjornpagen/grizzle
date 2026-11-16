import { Array as Arr, Record as Rec } from "effect"
import { appliedEditPhrase } from "#adapter/migrate/errors.ts"
import { cliStageFix, migrateStageFix, refusalText } from "#cli/refusals.ts"

/**
 * Every text the skill file documents word for word (packages/grizzle/src/cli/refusals.ts): each refusal's problem
 * and fix, each applied-edit phrase of migrate, and each stage's fix.
 */
export const documentedTexts = (): ReadonlyArray<string> => [
	...Arr.flatMap(Rec.values(refusalText), (r) => [r.problem, r.fix]),
	...Rec.values(appliedEditPhrase),
	...Rec.values(migrateStageFix),
	...Rec.values(cliStageFix)
]
