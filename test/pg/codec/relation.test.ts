/**
 * Relation inputs against PostgreSQL.
 *
 * - Host fact identity is PostgreSQL's: on explored batches of generated cases over small domains that collide (numeric
 *   display scale, NaN, uuid case, composed and decomposed text) or look alike (a float's signed zero), the host's fact
 *   identity partitions every case exactly as GROUP BY, which is DISTINCT's equality, does, over each field's values
 *   and, for a float, its binary image beside it, since a float's -0 is a value of its own that its equality holds equal
 *   to +0 (scalar/values/float.ts; relation.fixtures.ts fields). Each field's domain is values its type holds as they
 *   are, which the input boundary admits (scalar/values/identity.ts parseValue): a numeric(5,2) value is constructed
 *   from hundredths at the typmod's scale, and a real is a binary32 value, a double rounded by Math.fround. A value
 *   PostgreSQL's coercion would round is refused at the boundary (numericScale, realInexact), never grouped, and is
 *   test/pg/values/numeric.test.ts's to hold against PostgreSQL.
 * - The arrays encoder deduplicates, so PostgreSQL receives a set, which it reads back from the arrays in the
 *   select-list form the lowering prints (sql/print.ts printArrays).
 *
 * The heading of the equality cases spells each field raw to PostgreSQL, the host value's own spelling and not the
 * codec's normalized text, so PostgreSQL decides the equality independently.
 *
 * Oracle: PostgreSQL itself, GROUP BY's equality over the raw spellings and a float's binary image, and DISTINCT over
 * them in the arrays the encoder sends.
 *
 * Features: "equal facts spelled apart" and "deduplicated".
 */

import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { exact, ordered } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { positionalColumns, type RelationSpec } from "#compiler/codec/recordset.ts"
import { TextsMap } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { factIdentity } from "#compiler/scalar/values/identity.ts"
import {
	collidingFactsGen,
	columns,
	fieldOf,
	fields,
	heading,
	input,
	rawSpelling
} from "#test/pg/codec/relation.fixtures.ts"
import { arraysEncoder } from "#test/support/arrays.ts"
import { succeeded } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Relation inputs against PostgreSQL partitions generated cases exactly as PostgreSQL's DISTINCT equality does, a
 * float's binary image beside it.
 */
export const relationInputsAgainstPostgreSQLPartitionsGeneratedCasesExactlyAsPostgreSQLsDISTINCTEqualityDoes =
	property.explore(array(collidingFactsGen(8), { min: 1, max: 100 }), {
		needs: { tx: Substrate.transaction },
		situations: ["equal facts spelled apart"] satisfies ReadonlyArray<
			Reached<"equal facts spelled apart">
		>,
		/** Its pre-conversion budget: runs 20, coverage cases 20 (relation.test.ts at 4fbc3e95). */
		budget: { runs: 20, steered: 20 },
		check:
			({ tx }, c: Case<"equal facts spelled apart">) =>
			(cases) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx

					const payload = Arr.flatMap(cases, (facts, k) =>
						Arr.map(facts, (fact, ord) => ({
							k: String(k),
							ord: String(ord),
							...Rec.fromEntries(
								Arr.map(fields, (f) => [f.name, rawSpelling(f.name, fieldOf(fact, f.name))])
							)
						}))
					)
					const rows = yield* db.values(
						`SELECT r.k::text, string_agg(r.ord::text, ',' ORDER BY r.ord) FROM jsonb_to_recordset($1::text::jsonb) AS r(k int4, ord int4, ${Arr.join(
							Arr.map(fields, (f) => `${f.name} ${f.sql}`),
							", "
						)}) GROUP BY r.k, ${Arr.join(
							Arr.map(fields, (f) => f.group),
							", "
						)}`,
						[jsonText(payload)]
					)
					const pg = new Map<number, Array<string>>()
					for (const [k, group] of rows) {
						const key = Number(k)
						pg.set(key, [...(pg.get(key) ?? []), String(group)])
					}
					for (const [k, facts] of cases.entries()) {
						const groups = new TextsMap<Array<number>>()
						for (const [ord, fact] of facts.entries()) {
							const { identity } = succeeded(factIdentity(heading, fact))
							groups.set(identity, [...(groups.get(identity) ?? []), ord])
						}
						if (groups.size < facts.length) {
							c.note("equal facts spelled apart")
						}
						const host = Arr.sort(
							Arr.map([...groups.values()], (g) =>
								Arr.join(
									Arr.map(g, (ord) => String(ord)),
									","
								)
							),
							compareCodePoints
						)
						const native = Arr.sort(
							defined(pg.get(k), `the groups of case ${k}`),
							compareCodePoints
						)
						assert.deepEqual(
							ordered(exact)(host, native),
							Option.none(),
							`case ${k}: the host groups ${Arr.join(host, " ")}, PostgreSQL ${Arr.join(native, " ")}`
						)
					}
				}),
		oracle: {
			kind: "postgresql",
			name: "GROUP BY's equality over the raw spellings and a float's binary image"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\tfloat8: (v) => floatText(v),",
				replacement: "\tfloat8: (v) => floatText(v === 0 ? 0 : v),",
				why: "A double's fact identity writes -0 as +0, as its key text does, so the host merges two facts PostgreSQL's binary image tells apart; the partition property fails."
			},
			{
				file: "packages/engine/src/scalar/values/uuid.ts",
				original: "\treturn Result.ok(upper ? value.toLowerCase() : value)",
				replacement: "\treturn Result.ok(upper ? value : value)",
				why: "A uuid's identity keeps its case, so the host splits what PostgreSQL groups; both properties fail."
			}
		]
	})

/**
 * Relation inputs against PostgreSQL sends PostgreSQL a set: the encoder's arrays hold rows distinct under PostgreSQL's
 * equality, a float's binary image beside it.
 */
export const relationInputsAgainstPostgreSQLSendsPostgreSQLASetTheEncodersArraysHoldRowsDistinctUnderPostgreSQLsEquality =
	property.explore(collidingFactsGen(40), {
		needs: { tx: Substrate.transaction },
		situations: ["deduplicated"] satisfies ReadonlyArray<Reached<"deduplicated">>,
		/** Its pre-conversion budget: runs 200, coverage cases 200 (relation.test.ts at 4fbc3e95). */
		budget: { runs: 200, steered: 200 },
		check:
			({ tx }, c: Case<"deduplicated">) =>
			(facts) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					const spec: RelationSpec = {
						relation: "Case",
						columns: positionalColumns(fields),
						slot: { kind: "none" },
						codes: emptyCodebook
					}
					const encode = arraysEncoder(spec)

					const { arrays, count } = succeeded(encode(facts))
					if (count < facts.length) {
						c.note("deduplicated")
					}
					const [row] = yield* db.values(
						`SELECT count(*)::text, (SELECT count(*) FROM (SELECT DISTINCT ${columns} FROM ${input}) AS q)::text FROM ${input}`,
						arrays
					)
					assert.deepEqual(row, [String(count), String(count)])
				}),
		oracle: { kind: "postgresql", name: "DISTINCT over the arrays the encoder sends" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/uuid.ts",
				original: "\treturn Result.ok(upper ? value.toLowerCase() : value)",
				replacement: "\treturn Result.ok(upper ? value : value)",
				why: "A uuid's identity keeps its case, so the host splits what PostgreSQL groups; both properties fail."
			},
			{
				file: "packages/engine/src/codec/recordset.ts",
				original: "\t\t\t\tbyIdentity.set(entry.identity, entry)",
				replacement:
					"\t\t\t\tbyIdentity.set(textsId([...entry.identity.texts, String(byIdentity.size)]), entry)",
				why: "The normalizer keeps every fact, so the arrays hold one value twice; the DISTINCT property fails."
			}
		]
	})
