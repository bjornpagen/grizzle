/**
 * The bench harness's pure parts, each against an oracle:
 *
 * - The harness's caller-side retry retries exactly what grizzle classifies as a TransientFailure, up to its policy:
 *   a model of the documented classification judges generated scripts of attempts.
 * - Every gate of the catalog has exactly one bench file, in its owner's directory: an audit of the real tree.
 *
 * Each property states its oracle and requires the situations its oracle tells apart.
 */

import { word } from "@bjornpagen/testing/dictionary"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Record as Rec } from "effect"

import { gateOwner, ownerDirectories } from "#bench/harness/rules.ts"

import { assert } from "#test/support/assert.ts"
import { catalogIds } from "#test/unit/bench/harness.dictionary.ts"
import {
	gatesNeed,
	modelOf,
	ranOf,
	reasonOf,
	retriedCases,
	type RetryFeature
} from "#test/unit/bench/harness.fixtures.ts"

/**
 * Outcomes, retries and loads retry exactly what grizzle classifies as a TransientFailure, up to the caller's policy,
 * the last attempt standing.
 *
 * Budget: its suite's count before the conversion (unit/bench/retries: 400 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const outcomesRetriesAndLoadsRetryExactlyWhatGrizzleClassifiesAsATransientFailureUpToTheCallersPolicyTheLastAttemptStanding =
	property.explore(retriedCases, {
		needs: {},
		situations: [
			"committed at once",
			"committed after a retry",
			"the policy ran out",
			"a refusal ended it",
			"a unique abort retried",
			"a unique violation not retried",
			"labelled"
		] satisfies ReadonlyArray<Reached<RetryFeature>>,
		check: (_, c: Case<RetryFeature>) => (r) =>
			Effect.map(ranOf(r), (ran) => {
				const model = modelOf(r)
				assert.deepEqual(ran, model)
				if (ran.outcome.kind === "committed") {
					c.note(ran.attempts === 1 ? "committed at once" : "committed after a retry")
				} else if (reasonOf(r, Arr.getUnsafe(r.steps, ran.attempts - 1)) === undefined) {
					c.note("a refusal ended it")
				} else {
					c.note("the policy ran out")
				}
				for (const step of Arr.take(r.steps, ran.attempts)) {
					if (step.kind === "refused" && (step.code === "23505" || step.code === "23P01")) {
						c.note(
							reasonOf(r, step) === undefined
								? "a unique violation not retried"
								: "a unique abort retried"
						)
					}
				}
				if (Arr.some(ran.retries, (d) => d.label !== undefined)) {
					c.note("labelled")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "a model of grizzle's documented TransientFailure classification over scripted attempts"
		},
		budget: { runs: 400, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/outcomes/index.ts",
				original:
					"\tconst found = Arr.findFirst(uniqueAborts, (u) => u.constraint === failure.constraint)",
				replacement: "\tconst found = Arr.findFirst(uniqueAborts, (u) => true)",
				why: "Operator mutant (boolean-return) at packages/grizzle/src/adapter/outcomes/index.ts:255 in transientFailureOf: `u.constraint === failure.constraint` becomes `true`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/** The gate catalog gives every catalog gate exactly one bench file, in its owner's directory. */
export const theGateCatalogGivesEveryCatalogGateExactlyOneBenchFileInItsOwnersDirectory =
	property.exhaust(finite(word(catalogIds)), {
		needs: { gatesNeed },
		situations: ["query", "write"] satisfies ReadonlyArray<Reached<"query" | "write">>,
		check:
			({ gatesNeed }, c: Case<"query" | "write">) =>
			(id) =>
				Effect.gen(function* () {
					const { path, discovered, listed } = yield* gatesNeed
					yield* Effect.sync(() => {
						c.note(gateOwner(id))
						const covering = Arr.filter(discovered, (d) => Arr.contains(d.gate.gates, id))
						assert.equal(covering.length, 1, id)
						for (const d of covering) {
							assert.ok(
								Arr.contains(ownerDirectories[gateOwner(id)], path.dirname(d.file)),
								`${d.file} covers ${id}`
							)
							assert.deepEqual(
								Arr.sort(Rec.keys(d.gate.options(true)), Order.String),
								Arr.sort(Rec.keys(d.gate.options(false)), Order.String),
								d.file
							)
						}
						assert.deepEqual(
							Arr.filter(
								Arr.flatMap(discovered, (d) => d.gate.gates),
								(gate) => !listed.has(gate)
							),
							[]
						)
					})
				}),
		oracle: {
			kind: "specification",
			name: "one bench file a gate, in its owner's directory, its sizes alike at both scales"
		},
		box: "every gate of the catalog, against the bench files under the owners' directories",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/registry.ts",
				original:
					'export const storedOnly = (t: ScalarType): boolean => capsOf(t).every((c) => c === "storage")',
				replacement:
					'export const storedOnly = (t: ScalarType): boolean => capsOf(t).every((c) => c !== "storage")',
				why: "Operator mutant (comparison) at packages/engine/src/scalar/registry.ts:53 in storedOnly: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
