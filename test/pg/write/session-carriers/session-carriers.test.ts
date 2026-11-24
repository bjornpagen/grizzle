/**
 * A session's writes stand on its first write's carriers, and hold no more than one write's rows in them, on PostgreSQL
 * 19: a carrier is a session table, made ON COMMIT PRESERVE ROWS by the session's stand-up of the write, once, and
 * emptied by each use before it fills it (sql/print.ts carrierEmptying). So no write's transaction makes or drops a
 * relation: a carrier made and dropped by every transaction wrote catalog rows, a wide carrier's columns,
 * type and key, past what PostgreSQL's shared invalidation queue holds (4096 messages), and every COMMIT that dropped
 * them reset every cache of the session, the rule judge's cached plans among them, which the next COMMIT made again
 * (pantry's package write, 43 carriers: a statement cached at 39 ms took 152 ms after one such transaction). And a
 * carrier holds no page an earlier use filled: a DELETE left every one in the heap, whose free space no VACUUM of the
 * session's table records, so every fill after it extended the heap, a session's carriers growing by each write.
 *
 * The box, exhausted: each shape whose facts its program carries and whose write a session repeats (session-carriers
 * .fixtures.ts shapes: a candidate-keyed relation's put, its displacing deletion and its insert; owners put, their
 * UPDATE, their items refilled and recounted), at one key and at 256, three writes of it in turn on one session of a
 * fresh installation holding 256 owners of two items each and 256 candidate-keyed facts, each write's values its own.
 *
 * Property, for each case: one backend runs the three writes, the first holds a carrier, and just before each COMMIT the
 * session holds the same carriers, relation for relation (pg_class oid) and byte for byte (pg_total_relation_size), the
 * first write's (oracle: PostgreSQL's catalog). Its kills: carriers dropped at COMMIT, made again by each write, so each
 * write's are relations of their own; and a carrier emptied by DELETE, which grows by each write.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	heldOf,
	type Situation,
	situations,
	sketchGen
} from "#test/pg/write/session-carriers/session-carriers.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A session's writes stand on its first write's carriers, each holding one write's rows. */
export const aSessionsWritesStandOnItsFirstWritesCarriersEachHoldingOneWritesRows =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, c: Case<Situation>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const held = yield* heldOf(sketch)
						const where: Situation = `${sketch.shape} at ${sketch.keys}`
						c.note(where)
						const [first, ...later] = held
						assert.ok(
							first !== undefined && later.length > 0,
							`${where}: the writes ran their probes`
						)
						assert.ok(first.carriers.length > 0, `${where}: the first write holds no carrier`)
						for (const [i, h] of later.entries()) {
							assert.equal(
								h.backend,
								first.backend,
								`${where}: write ${i + 2} ran on another backend`
							)
							assert.deepEqual(
								h.carriers,
								first.carriers,
								`${where}: write ${i + 2} holds carriers other than the first write's: ${Arr.join(
									Arr.map(h.carriers, (x) => `${x.name} ${x.oid} ${x.bytes} B`),
									", "
								)}, where the first held ${Arr.join(
									Arr.map(first.carriers, (x) => `${x.name} ${x.oid} ${x.bytes} B`),
									", "
								)}`
							)
						}
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "the session's carriers in pg_class, each relation's oid and pg_total_relation_size, just before each write's COMMIT"
		},
		box: "each shape whose facts its program carries and whose write a session repeats, at one key and at 256, three writes of it on one session of a fresh installation",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `(\${[...columns, ...key].join(", ")}) ON COMMIT PRESERVE ROWS\``,
				replacement: `(\${[...columns, ...key].join(", ")}) ON COMMIT DROP\``,
				why: "Every carrier drops at its write's COMMIT and the next write makes it again, a relation of its own, whose catalog rows overflow the shared invalidation queue and reset the session's caches; the later writes' carriers are not the first's."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\t\treturn out.line(\`TRUNCATE \${sessionTableName(statement.name)};\`)`,
				replacement: `\t\t\treturn out.line(\`DELETE FROM \${sessionTableName(statement.name)};\`)`,
				why: "A carrier is emptied by DELETE, which keeps every page of the use before, no VACUUM recording their space, so each fill extends the heap and the later writes' carriers are larger than the first's."
			}
		]
	})
