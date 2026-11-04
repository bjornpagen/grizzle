import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { CompileError } from "#compiler/core/errors.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"
import * as fixtures from "#test/types/changeset/fixtures/changeset.ts"

/** The refusals the fixtures state, each of which the facade must also throw at runtime. */
const refusals = [
	"duplicate read",
	"duplicate union",
	"duplicate sequence",
	"closed member"
] as const

type Refusal = (typeof refusals)[number]

const refusing: Readonly<Record<Refusal, () => unknown>> = {
	"duplicate read": fixtures.duplicateRead,
	"duplicate union": fixtures.duplicateUnion,
	"duplicate sequence": fixtures.duplicateSequence,
	"closed member": fixtures.closedMember
}

layer(NodeServices.layer, { excludeTestServices: true })("ChangeSet facade", (it) => {
	it.effect("typechecks every fixture under tsgo with Effect diagnostics", () =>
		Effect.gen(function* () {
			assert.equal((yield* checked("changeset/fixtures")).output, "")
		})
	)

	it.effect("fails each refusal with the diagnostic it names, and nothing else", () =>
		Effect.gen(function* () {
			const { expected, actual } = yield* checked("changeset/disarmed")
			assert.deepEqual(actual, expected)
		})
	)

	it.effect("refuses at runtime what the types refuse", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "types/changeset runtime refusals",
					generator: element(refusals),
					literal: Formatter.format,
					limit: refusals.length,
					coverage: requiredInSpace<Refusal>(refusals),
					caseHang: Duration.minutes(2)
				},
				(refusal, c) =>
					Effect.sync(() => {
						c.note(refusal)
						assert.throws(refusing[refusal], CompileError)
					})
			)
		)
	)
})
