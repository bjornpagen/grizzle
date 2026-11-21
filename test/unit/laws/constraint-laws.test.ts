/**
 * A refusal names every law the constraint PostgreSQL reports serves, whatever order the schema states its laws in: the
 * installation's constraint map (laws/model/model.ts constraintLawMap, which snapshot.json's constraintToLaw, a served
 * file's constraints above and a folder's meta.json record) maps each constraint to every law of its entries, each once,
 * in code point order, and the installation's classifier (adapter/served/refusals.ts installationWitness) names those
 * laws for a violation of it, none chosen by statement order.
 *
 * The box: a counted family whose owner also folds its members' count (README: counted, fold), the shape of qti's
 * site_target, whose key index serves the counted law and the fold's, with its two statements as written and reversed.
 * Each case compiles the schema in its order and, for every table constraint of the model, reports a unique violation
 * of it. Oracle (specification): the map holds exactly the laws of the constraint's entries, sorted; the refusal names
 * exactly those, in that order; and both, the map and every refusal, are those of the schema in the other order.
 *
 * Features: a constraint serving several laws, and each statement order.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { constraintLawMap } from "#compiler/laws/model/model.ts"
import {
	artifactsIn,
	lawsServed,
	statementOrderGen,
	refusedIds,
	type StatementOrder,
	constraintEntriesByName
} from "#test/unit/laws/constraint-laws.fixtures.ts"

type Feature = "a constraint serving several laws" | `statements ${StatementOrder}`

/** A refusal of a constraint names every law it serves, in one order whatever order the schema states its laws in. */
export const aRefusalOfAConstraintNamesEveryLawItServesInOneOrderWhateverOrderTheSchemaStatesItsLawsIn =
	property.exhaust(finite(statementOrderGen), {
		box: "a counted family whose owner folds its members' count, its two statements as written and reversed",
		needs: {},
		situations: [
			"a constraint serving several laws",
			"statements as written",
			"statements reversed"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (order: StatementOrder) =>
			Effect.sync(() => {
				c.note(`statements ${order}`)
				const other: StatementOrder = order === "as written" ? "reversed" : "as written"
				const artifacts = artifactsIn(order)
				const otherArtifacts = artifactsIn(other)
				const map = constraintLawMap(artifacts.constraintLaws)
				assert.deepEqual(
					map,
					constraintLawMap(otherArtifacts.constraintLaws),
					"the constraint map is the schema's whatever order it states its statements in"
				)
				for (const [, entries] of constraintEntriesByName(artifacts)) {
					const [entry] = entries
					if (entry === undefined) {
						continue
					}
					const served = lawsServed(entries)
					if (served.length > 1) {
						c.note("a constraint serving several laws")
					}
					assert.deepEqual<ReadonlyArray<LawId> | undefined>(
						lawsOfConstraint(map, { kind: "table", name: entry.owner }, entry.name),
						served,
						`the map holds every law ${entry.name} of ${entry.owner} serves`
					)
					const refused = refusedIds(artifacts, entry.owner, entry.name)
					assert.deepEqual(
						refused,
						served,
						`a violation of ${entry.name} names every law it serves`
					)
					assert.deepEqual(
						refused,
						refusedIds(otherArtifacts, entry.owner, entry.name),
						`a violation of ${entry.name} names its laws alike in the schema stated ${other}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "every law of a constraint's entries, each once, in code point order, in either statement order"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/model.ts",
				original: "\t\tnamed.set(c.name, concatNonEmpty(named.get(c.name) ?? [], lawIdsOf(c)))",
				replacement: "\t\tnamed.set(c.name, [lawIdsOf(c)[0]])",
				why: "The constraint map keeps one law per constraint, its last entry's first, as it did, so a constraint serving the counted law and the fold's records one of them and the map property fails."
			},
			{
				file: "packages/engine/src/laws/model/model.ts",
				original: "\tconst sorted = sortNonEmpty(laws, (a, b) => compareStrings(idOf(a), idOf(b)))",
				replacement: "\tconst sorted = laws",
				why: "A constraint's laws keep the order the schema states them in, so the schema with its statements reversed names them otherwise and the order-free property fails."
			}
		]
	})
