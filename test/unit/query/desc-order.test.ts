/**
 * A query's Description as its builder makes it (query/build/query.ts) is the Description its decoder gives for it
 * (ir/desc.ts decodeDesc): equal, a fresh copy, every object's keys in the decoder's order, and frozen throughout.
 *
 * Over generated public programs (test/support/oracle/public), each query built through the public builder.
 *
 * Oracle: the decoder, a second implementation of the Description's shapes.
 *
 * Features: a query, and a node of each common kind (rules, relation, var, compare).
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { decodeDesc } from "#compiler/ir/desc.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import {
	keyOrders,
	kindsOf,
	type OrderFeature,
	unfrozen
} from "#test/unit/query/desc-order.fixtures.ts"

/** A query's Description as its builder makes it is the Description its decoder gives for it, every object's keys in the decoder's order, and frozen throughout. */
export const aQuerysDescriptionAsItsBuilderMakesItIsTheDescriptionItsDecoderGivesForItEveryObjectsKeysInTheDecodersOrderAndFrozenThroughout =
	property.explore(caseSketchGen, {
		needs: {},
		situations: [
			"a query",
			"a node of kind rules",
			"a node of kind relation",
			"a node of kind var",
			"a node of kind compare"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check: (_, k: Case<OrderFeature>) => (sketch) =>
			Effect.sync(() => {
				const c = k.draw(resolveCase(sketch))
				const built = buildSchema(c.schema)
				for (const read of c.reads) {
					if (read.kind !== "query") {
						continue
					}
					const desc = succeeded(
						queryInput(buildRoot(built, built.schema, read.query)),
						"the builder admits a generated read"
					).desc
					k.note("a query")
					for (const kind of kindsOf(desc)) {
						k.note(`a node of kind ${kind}`)
					}
					const decoded = succeeded(
						decodeDesc("query", desc),
						"the decoder admits the builder's Description"
					)
					assert.notEqual(decoded, desc, "a decode is a fresh copy")
					assert.deepEqual(desc, decoded)
					assert.deepEqual(keyOrders(desc), keyOrders(decoded))
					assert.deepEqual(unfrozen(desc), [], "the Description is frozen throughout")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the Description shapes' decode of the builder's Description (ir/desc.ts decodeDesc)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/query/build/query.ts",
				original: "\tconst desc: QueryDesc = deepFreeze({ stage })",
				replacement: "\tconst desc: QueryDesc = Object.freeze({ stage })",
				why: "The builder's Description frozen at its root alone; the frozen-throughout check of the search fails."
			}
		]
	})
