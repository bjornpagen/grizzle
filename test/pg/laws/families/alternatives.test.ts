/**
 * Generated alternatives schemas, over a single key and over a composite key (test/support/laws/boxes.ts), every law
 * native: per arm relation, a forward containment into the parent selected by its handles, and per armed handle, a
 * reverse containment from the parent selected by the handle, deferred on the cycle (fin.md §7). The oracle is the host
 * model (test/support/laws/model.ts), a second implementation judging each generated write sequence.
 *
 * Beside them, every armed handle of every schema of the box written once, exhausted: a run of the handle with its
 * payload commits, a payload relation shared by several handles taking each one's. Its oracle is alternatives' meaning
 * (fin.md §7), the specification: a run of an armed handle beside its payload's row keeps every law of the expansion.
 * Features: a handle of a payload relation shared, and one of a relation of its own. Plant:
 * ~/.cache/grizzle-release/BR09/plants/alternatives-shared-arm-first-handle.patch, an arm's forward containment selecting
 * its relation's first handle alone, refuses the run of a shared relation's other handle.
 */

import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { grizzleFirstSession, ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import {
	alternativesBox,
	compositeAlternatives,
	modeOf,
	type RunsParams,
	stageName
} from "#test/support/laws/boxes.ts"
import {
	casesPerTest,
	familySuite,
	installVariant,
	noKeptCases
} from "#test/support/laws/suites/family.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

familySuite(alternativesBox, casesPerTest, "the family", noKeptCases)
familySuite(compositeAlternatives, casesPerTest, "every schema's refusals", noKeptCases)

/**
 * An armed handle of a schema of the box: the schema, the position of its payload relation and the handle's, and whether
 * the relation is the payload of other handles too.
 */
interface ArmedHandle {
	readonly schema: RunsParams
	readonly pay: number
	readonly handle: number
	readonly shared: boolean
}

type ArmedFeature =
	| "a handle of a payload relation shared"
	| "a handle of a payload relation of its own"

const armedHandles = Object.freeze(
	Arr.flatMap(alternativesBox.variants, (schema) =>
		Arr.flatMap(schema.arms, (arm, pay) =>
			Arr.map(arm.handles, (handle): ArmedHandle => ({
				schema,
				pay,
				handle,
				shared: arm.handles.length > 1
			}))
		)
	)
)

layer(Substrate.layer, { excludeTestServices: true })(
	"law-bearing generated schemas: alternatives, every armed handle",
	(it) => {
		it.effect(
			"a run of every armed handle of every schema commits with its payload, a payload relation shared by several handles taking each one's",
			(ctx) =>
				searched(
					ctx,
					exhaust(
						{
							box: "every armed handle of every schema of the alternatives box, a run of it beside its payload's row",
							oracle: {
								kind: "specification",
								name: "alternatives' meaning: a run of an armed handle beside its payload's row keeps every law"
							},
							suite: "laws/alternatives/armed-handles",
							literal: Formatter.format,
							generator: element(armedHandles),
							coverage: requiredInSpace<ArmedFeature>([
								"a handle of a payload relation shared",
								"a handle of a payload relation of its own"
							]),
							caseHang,
							concurrency: 1
						},
						({ schema, pay, handle, shared }, c) =>
							Effect.gen(function* () {
								c.note(
									shared
										? "a handle of a payload relation shared"
										: "a handle of a payload relation of its own"
								)
								const installed = yield* installVariant(
									alternativesBox,
									schema,
									modeOf(alternativesBox.host(schema)) === "mutable"
										? grizzleFirstSession
										: ordinarySession
								)
								const session = yield* alternativesBox.connect(schema, installed)
								yield* session.reset
								const outcome = yield* session.apply([
									{
										relation: "Run",
										kind: "insert",
										facts: [{ id: 1, stage: stageName(handle), note: "a" }]
									},
									{ relation: `Pay${pay}`, kind: "insert", facts: [{ id: 1, run: 1, amount: 1 }] }
								])
								if (outcome.kind !== "accepted") {
									return assert.fail(
										`${alternativesBox.describe(schema)}: a run of ${stageName(handle)} with its payload in Pay${pay} answered ${Formatter.format(outcome)}`
									)
								}
							})
					)
				)
		)
	}
)
