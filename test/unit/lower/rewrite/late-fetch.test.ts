/**
 * R06 (lower/optimize/late-fetch): delay expensive payload work explicitly when legal. A take over wide payload selects
 * the narrow key and order tuple first and fetches the payload through the retained key in the same statement, its
 * certificate naming the key it rests on; it is refused when the key does not determine the output ("if a query
 * projects away the base key and collapses equal payloads, limiting base keys first changes the answer"), when the
 * order reads the payload, when a reader reads the take or its stage laterally, and when the take is correlated, its
 * rows selected per outer row. Every rewritten query delivers what its original does, by the reference evaluator, and
 * lowers conservatively.
 *
 * Oracle: the rule's statement as a checker over an exhaustive planted space and over generated wide-payload cases (a
 * specification), the reference evaluator's delivery (a second implementation).
 *
 * Features: fetched on each evidence; held back by each guard; a correlated take held back.
 */

import { assert, lacks } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { lateFetchPass } from "#compiler/lower/optimize/late-fetch/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import {
	agrees,
	caseQuery,
	lowerConservatively,
	nodesOf,
	passContext,
	rulesOf,
	runPasses
} from "#test/support/unit/lower/rewrite/support.ts"
import {
	accountKey,
	bounded,
	type Evidence,
	fetchedUnder,
	type LateFetchFeature,
	shapes
} from "#test/unit/lower/rewrite/late-fetch.fixtures.ts"
import { wideCaseGen } from "#test/unit/lower/rewrite/wide.ts"

/** Late payload fetch selects the narrow key under the bound, then joins the payload back through the key. */
export const latePayloadFetchSelectsTheNarrowKeyUnderTheBoundThenJoinsThePayloadBackThroughTheKey =
	property.exhaust(finite(shapes), {
		needs: {},
		situations: [
			"fetched on snapshot evidence",
			"fetched on transaction evidence",
			"held back: the order reads the payload",
			"held back: no key of the payload's relation",
			"held back: a lateral reader"
		] satisfies ReadonlyArray<Reached<LateFetchFeature>>,
		check: (_, c: Case<LateFetchFeature>) => (shape) =>
			Effect.sync(() => {
				const ran = fetchedUnder(bounded(shape).dag, shape.evidence)
				const cert = Arr.findFirst(ran.certificates, (x) => x.rule === "R06.lateFetch")
				if (shape.order === "reading the payload") {
					c.note("held back: the order reads the payload")
				} else if (shape.stage === "carries no Account key") {
					c.note("held back: no key of the payload's relation")
				} else if (
					shape.reader === "a join reading the take laterally" ||
					shape.reader === "a join reading the stage laterally"
				) {
					c.note("held back: a lateral reader")
				} else {
					c.note(`fetched on ${shape.evidence} evidence`)
					const certified = Option.getOrThrowWith(
						cert,
						() => new Error("the late fetch's certificate")
					)
					assert.equal(certified.context, "immediate")
					assert.deepEqual(
						Arr.flatMap(certified.premises, (p) => (p.kind === "constraint" ? [p.constraint] : [])),
						[accountKey]
					)
					for (const take of nodesOf(ran.query.dag, "Take")) {
						lacks(
							Arr.map(take.heading, (col) => col.name),
							"name"
						)
					}
					return
				}
				assert.deepEqual(cert, Option.none())
			}),
		oracle: {
			kind: "specification",
			name: "R06 fetches late exactly over a key the stage carries, an order free of the payload and no lateral reader"
		},
		box: "a take of one or two over a stage that carries Account's key or none, ordered by the key or reading the payload, read by the query, a join or a lateral join, in each evidence context",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/scalar.ts",
				original: '\t\tcase "sha256":\n\t\t\treturn true',
				replacement: '\t\tcase "sha256":\n\t\t\treturn false',
				why: "Operator mutant (comparison) at packages/engine/src/ir/scalar.ts:867 in sameSpan: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Late payload fetch refuses a correlated take, whose rows are selected per outer row.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/lower/rewrite/late-fetch.test.ts:301 at 8cad5bce, its runs and its coverage's cases).
 */
export const latePayloadFetchRefusesACorrelatedTakeWhoseRowsAreSelectedPerOuterRow =
	property.explore(wideCaseGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: ["fetched", "a correlated take held back"] satisfies ReadonlyArray<
			Reached<"fetched" | "a correlated take held back">
		>,
		check: (_, c: Case<"fetched" | "a correlated take held back">) => (q) =>
			Effect.sync(() => {
				const input = caseQuery(q)
				const correlated = Arr.some(nodesOf(input.dag, "Take"), (t) => t.correlation.length > 0)
				for (const evidence of [
					"snapshot",
					"transaction"
				] as const satisfies ReadonlyArray<Evidence>) {
					const ran = succeeded(
						runPasses(
							input,
							[lateFetchPass],
							passContext({ catalog: genCatalog(q.schema), evidence })
						)
					)
					agrees(q, ran.query)
					succeeded(lowerConservatively(ran.query, schemaCodes(q.schema)))
					const fetched = Arr.contains(rulesOf(ran.certificates), "R06.lateFetch")
					if (correlated) {
						assert.equal(fetched, false)
						c.note("a correlated take held back")
					} else if (fetched) {
						c.note("fetched")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "no correlated take is fetched late; the reference's delivery"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/late-fetch/index.ts",
				original: "\t\ttake.correlation.length > 0 ||\n",
				replacement: "",
				why: "A correlated take's payload is fetched late, the narrow take losing its correlation; the late-fetch-correlated search fails."
			}
		]
	})
