/**
 * The README's and SKILL.md's program at the public API (test/types/examples/fixtures), the one sanctioned example
 * code: its blocks are the documentation, mirrored line for line (blocks.test.ts). The type batch checks the fixtures
 * twice: as they stand they typecheck, and disarmed each refusal the documentation states fails with the claim its
 * directive names, and nothing else does.
 *
 * Plant (~/.cache/grizzle-release/BR14/plants): evidence-get-one-only.patch refuses db.get of a query proved at most
 * one row, which the README's postPage is.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"the worked example's program at the public API",
	(it) => {
		it.effect("typechecks the program and its refusals under tsgo with Effect diagnostics", () =>
			Effect.gen(function* () {
				const diagnostics = yield* checked("examples/fixtures")
				assert.equal(diagnostics.output, "")
			})
		)

		it.effect("fails each refusal with the diagnostic it names, and nothing else", () =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("examples/disarmed")
				assert.deepEqual(actual, expected)
			})
		)
	}
)
