/**
 * The regex agreement (test/types/regex/agreement.ts), one program the type batch checks disarmed: over drawn str.regex
 * calls and the floor's, a literal call typechecks exactly when the engine admits its pattern, the declared classes
 * apart; a finite language within the scan infers exactly its members, a long source string, and a cross product its
 * union, or past the union limit string, never by expanding it. Oracle: the engine's admission (text/refinement.ts),
 * and ECMAScript's acceptance of each member. The floor's witnesses reach every form, verdict, declared class and host
 * claim. The scan's budget is type-level only, RegexScan's codeUnits (types/fields/source.ts): nothing scans a source
 * at run time, so the program's value of it is a constant of that type, which stops typechecking once the budget moves.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): regex-infer-string.patch widens every inferred host type to string.
 */
import { unreachedOf } from "@bjornpagen/testing/features"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"
import { regexRequired, regexWitnesses } from "#test/types/regex/agreement.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the regex agreement", (it) => {
	it.effect(
		"over drawn str.regex calls, the types admit exactly what the engine admits and infer what the oracle states",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("regex/agreement")
				assert.deepEqual(actual, expected)
			})
	)

	it("the floor's witnesses reach every form, verdict, declared class and host claim", () => {
		assert.deepEqual(
			unreachedOf(regexRequired, [regexWitnesses().tally]),
			[],
			"forms, verdicts, classes or claims no floor witness reached"
		)
	})
})
