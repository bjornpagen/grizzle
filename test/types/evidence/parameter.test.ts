/**
 * A child query a function builds over its parent's field (test/types/evidence/parameter.ts), one program the type
 * batch checks disarmed: the function takes the field as an input term, `Term<Uuid, unknown, InputOrigin, "uuid">`,
 * and over every schema and delivery of its box:
 *
 * - its child proves a delivery exactly where the same child written inline over the parent's own variable proves it,
 *   and raises the same refusal where it does not (a twin label for the two);
 * - an app's parent variable is taken by the function's parameter, and the app that attaches the function's query has
 *   the head of the app that writes it inline.
 *
 * Oracle: the inline child, whose verdicts are the evidence's (an array always, an option over the key the parent
 * fixes, the one child where the schema proves existence). Not stated: a function generic over the field,
 * `<D extends Meets<Uuid, "uuid">>`, defers the equality's evidence until the call and proves neither option nor one, a
 * known limit of the types, which no contract promises either way.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): parameter-input-lost.patch loses an equality's evidence over an input
 * term, so the function's option and one children are refused where the inline ones prove.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"a child query a function builds over its parent's field",
	(it) => {
		it.effect(
			"proves each delivery exactly where the same child inline proves it, and keeps the inline app's head",
			() =>
				Effect.gen(function* () {
					const { expected, actual } = yield* checked("evidence/parameter")
					assert.deepEqual(actual, expected)
				})
		)
	}
)
