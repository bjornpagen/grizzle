/**
 * Generated alternatives schemas, over a single key and over a composite key (test/support/laws/boxes.ts), every law
 * native: per arm relation, a forward containment into the parent selected by its handles, and per armed handle, a
 * reverse containment from the parent selected by the handle, deferred on the cycle (fin.md §7). The oracle is the host
 * model (test/support/laws/model.ts), a second implementation judging each generated write sequence.
 *
 * Beside them, every armed handle of every schema of the box written once, exhausted: a run of the handle with its
 * payload commits, a payload relation shared by several handles taking each one's. Its oracle is alternatives' meaning
 * (fin.md §7), the specification: a run of an armed handle beside its payload's row keeps every law of the expansion.
 * Features: a handle of a payload relation shared, and one of a relation of its own.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { type ArmedFeature, armedHandles } from "#test/pg/laws/families/alternatives.fixtures.ts"
import { alternativesBox, compositeAlternatives, stageName } from "#test/support/laws/boxes.ts"
import {
	familySuite,
	familyTemplates,
	noKeptCases,
	variantKey
} from "#test/support/laws/suites/family.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Law-bearing generated schemas, alternatives: accepted iff every violation query is empty, each population. */
export const alternativesLaws = familySuite(import.meta, alternativesBox, "the family", noKeptCases)

/** Law-bearing generated schemas, composite-key alternatives: each schema's every refusal, each population. */
export const compositeAlternativesLaws = familySuite(
	import.meta,
	compositeAlternatives,
	"every schema's refusals",
	noKeptCases
)

/**
 * Law-bearing generated schemas, alternatives, every armed handle: a run of every armed handle of every schema commits
 * with its payload, a payload relation shared by several handles taking each one's. Each case on the worker's clone of
 * its schema's template (familyTemplates), which the suite above seats its cases on too.
 */
export const aRunOfEveryArmedHandleOfEverySchemaCommitsWithItsPayload = property.exhaust(
	armedHandles,
	{
		box: "every armed handle of every schema of the alternatives box, a run of it beside its payload's row",
		needs: Substrate.oneOf(familyTemplates(import.meta, alternativesBox), Substrate.seat),
		situations: [
			"a handle of a payload relation shared",
			"a handle of a payload relation of its own"
		] satisfies ReadonlyArray<Reached<ArmedFeature>>,
		check:
			(seats, c: Case<ArmedFeature>) =>
			({ schema, pay, handle, shared }) =>
				Effect.scoped(
					Effect.gen(function* () {
						c.note(
							shared
								? "a handle of a payload relation shared"
								: "a handle of a payload relation of its own"
						)
						const seat = yield* defined(
							seats[variantKey(alternativesBox, schema)],
							"the alternatives box's seats"
						)
						const session = yield* Effect.provideService(
							alternativesBox.connect(schema, seat.value),
							Substrate,
							seat.substrate
						)
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
				),
		oracle: {
			kind: "specification",
			name: "alternatives' meaning: a run of an armed handle beside its payload's row keeps every law"
		},
		kept: [],
		kills: []
	}
)
