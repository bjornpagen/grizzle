/**
 * A write statement reaches every stored relation it joins to a carrier's rows by the key's index, on PostgreSQL 19:
 * each stored relation a write statement joins to rows it holds is restricted to those rows' keys,
 * `t.k = ANY (ARRAY(SELECT DISTINCT r.k FROM rows r))` per key field (write/probe.ts amongHeld), one condition its index
 * serves, so PostgreSQL reads it by that index however many rows it estimates the carrier at. A carrier's rows are the
 * arrays in its transaction's settings (write/carriers/carriers.ts), which a session plans its statement over once, at
 * the length its first call's arrays hold; against a later call's longer arrays a join of the carrier to a stored
 * relation by its key alone could scan the relation whole, which under SERIALIZABLE takes a relation-level SIRead lock
 * and fails every concurrent writer of it with 40001.
 *
 * The box, exhausted: each shape whose facts two or more statements of its program read, so the program carries them in
 * a carrier of its own (write/program/slot-carriers.ts) and every one of those statements joins it to a stored relation
 * (carrier-keys.fixtures.ts shapes: the displacing deletion of a candidate-keyed relation's put, an owner's UPDATE, a
 * family's removals and additions over its edited, refilled, moved and recounted members), at one key and at 4096, over
 * 8192 stored owners of two items each and 8192 facts of the candidate-keyed relation, on a fresh installation per
 * case. The write is applied once, its statements each under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) in its
 * place, its carriers filled as the call fills them, its transaction ended by ROLLBACK
 * (bench/write/support/writes.ts explainedChange).
 *
 * Property, for each case: some statement reads a carrier, and no plan node reads a stored relation of the box but by a
 * key, an index scan's or a bitmap's index condition or a TID scan's tids (oracle: PostgreSQL's plan). Its kill drops
 * the restriction, every statement joining the carrier to the stored relation by its key alone.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	plannedOf,
	type Situation,
	situations,
	sketchGen
} from "#test/pg/write/carrier-keys/carrier-keys.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A write statement reaches every stored relation it joins to a carrier by the key's index. */
export const aWriteStatementReachesEveryStoredRelationItJoinsToANeverAnalyzedCarrierByTheKeysIndex =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, c: Case<Situation>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const planned = yield* plannedOf(sketch)
						c.note(`${sketch.shape} at ${sketch.keys}`)
						assert.ok(
							planned.carriers > 0,
							`${sketch.shape} at ${sketch.keys}: no statement reads a carrier`
						)
						assert.deepEqual(
							planned.unkeyed,
							[],
							`${sketch.shape} at ${sketch.keys}: a stored relation read by no key: ${Arr.join(planned.unkeyed, "; ")}`
						)
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "EXPLAIN ANALYZE of each statement in its place: every scan of a stored relation of the box by an index condition or tids"
		},
		box: "each shape whose facts its program carries, at one key and at 4096, over 8192 stored owners of two items each and 8192 candidate-keyed facts, each case on a fresh installation",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/probe.ts",
				original:
					'\treturn {\n\t\tkind: "equalsAny",\n\t\texpr: stored,\n\t\tarray: {\n\t\t\tkind: "array",\n\t\t\tquery: select(distinctCore([target(value(h))], [cteRefAs(held, h)], undefined))\n\t\t},\n\t\tschema\n\t}\n',
				replacement: "\treturn lit.bool(true)\n",
				why: "A write statement joins a stored relation to the carrier's rows by its key alone (write/probe.ts amongHeld): PostgreSQL plans the never-analyzed carrier at ten pages of rows and scans the relation whole."
			}
		]
	})
