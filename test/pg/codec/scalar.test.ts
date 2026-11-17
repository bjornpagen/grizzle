/**
 * Exact scalar codecs against PostgreSQL 19 in raw-text mode (codec/scalar.ts): the outermost SELECT casts every column
 * to text, which the conversions read.
 *
 * - Round trip: for every carrier, numeric with NaN, Infinity and display scale, real at binary32, -0, money minor
 *   units, bigint, uuid case, text of every plane, closed ids and sets of every width over rosters with holes, spans,
 *   vectors and a contract, a batch of host values is encoded, sent through jsonb_to_recordset, and one value of the
 *   case through a cast parameter, and PostgreSQL's own text of each is admitted by the kernel's strict reader
 *   (test/support/kernel/strict.ts) and converted by the library's trusting conversion to the value the strict reader
 *   reads, which is exactly the value sent.
 * - Stored rows: facts encoded through their relation input's arrays, inserted into a table of every column type with
 *   the lowering's casts, and read back are decoded by the positional row decoder (statement-rows.ts headingRecord) to
 *   exactly the facts written, one row each.
 * - Routable carriers: for every carrier a change routes by (ir/scalar.ts routable), a batch of values, each encoded,
 *   is printed by PostgreSQL's ::text exactly as the codec writes it, under any DateStyle, IntervalStyle,
 *   extra_float_digits and bytea_output a writer's session holds: the change source prints a routed column's text
 *   under the writer's settings, and a subscription matches it against its parameter's codec text.
 *
 * Oracle: a universal one, convert ∘ PostgreSQL ∘ encode = id, PostgreSQL's input and output functions between them.
 * The encoder parses exactly, so every value drawn here is one its type holds as it is: a real a binary32 value, a
 * numeric(7, 2) at most two fractional digits. Its refusal of every value PostgreSQL would round is held in
 * test/pg/values/numeric.test.ts and test/pg/input/exactness.test.ts, pgvector's rounding in
 * test/pg/values/carriers.test.ts. A value's text is any one PostgreSQL reads as the value, so Money's own spelling is
 * test/pg/values/money.test.ts's, which reads the host's text back.
 *
 * Features: "round-trips <carrier>", every carrier's; "routes <carrier>", every routable carrier's.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { uniqueArray } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { isHostValue } from "#compiler/scalar/values/identity.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	anyUuid,
	caseOf,
	cases,
	factOf,
	kindRosterCodes,
	readingOver,
	recordset,
	roundTrip,
	type RoundTripFeature,
	roundTripGen,
	routableCases,
	roundTripRuns,
	routableGen,
	sameValue,
	type RoutableFeature,
	setupIn
} from "#test/pg/codec/scalar.fixtures.ts"
import { fieldOf, storedTextOut, textRows, wireSql } from "#test/pg/codec/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { codecOf } from "#test/unit/codec/support.ts"

/** Exact scalar codecs against PostgreSQL round-trip every carrier exactly through the recordset and a cast parameter. */
export const exactScalarCodecsAgainstPostgreSQLRoundTripsEveryCarrierExactlyThroughTheRecordsetAndACastParameter =
	property.explore(roundTripGen, {
		needs: { tx: Substrate.transaction },
		situations: Arr.map(
			cases,
			(c): RoundTripFeature => `round-trips ${c.label}`
		) satisfies ReadonlyArray<Reached<RoundTripFeature>>,
		/** Its pre-conversion budget: runs and coverage cases roundTripRuns times the carriers' cases (scalar.test.ts at 4fbc3e95). */
		budget: { runs: roundTripRuns * cases.length, steered: roundTripRuns * cases.length },
		check:
			({ tx }, c: Case<RoundTripFeature>) =>
			(trip) =>
				Effect.gen(function* () {
					const { session, schema } = yield* tx
					const { db, names } = yield* setupIn(session, schema)
					yield* roundTrip(db, names, caseOf(trip.label), trip)
					c.note(`round-trips ${trip.label}`)
				}),
		oracle: {
			kind: "universal",
			name: "convert ∘ PostgreSQL ∘ encode = id, the strict reader's value of the output text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/hex.ts",
				original: "\t\t(firstBit >> (position % hexDigitBits))",
				replacement: "\t\t(1 << (position % hexDigitBits))",
				why: "setBit puts a set's position 0 at its digit's least significant bit; a set's round trip fails."
			}
		]
	})

/** Exact scalar codecs against PostgreSQL store facts through their arrays and decode the stored rows positionally. */
export const exactScalarCodecsAgainstPostgreSQLStoresFactsThroughTheirArraysAndDecodesTheStoredRowsPositionally =
	property.explore(uniqueArray(anyUuid, factOf, { min: 1, max: 100 }), {
		needs: { tx: Substrate.transaction },
		situations: [],
		/** Its pre-conversion budget: runs 3, no coverage (scalar.test.ts at 4fbc3e95). */
		budget: { runs: 3, steered: 0 },
		check:
			({ tx }) =>
			(facts) =>
				Effect.gen(function* () {
					const { session, schema } = yield* tx
					const { db, names } = yield* setupIn(session, schema)
					const { table, columns, create, encode, arrayColumns, selectList, decodeRow } =
						readingOver(names)
					yield* db.values(create, [])
					yield* db.values(`TRUNCATE ${table}`, [])
					const { arrays, count } = succeeded(encode(facts))
					const inserted = yield* db.query(
						`INSERT INTO ${table} SELECT ${selectList} FROM (SELECT ${arrayColumns}) AS r0`,
						arrays
					)
					assert.equal(inserted.rowCount, count)
					const rows = yield* db.values(
						`SELECT ${Arr.join(
							Arr.map(columns, (c) => storedTextOut(c.type, `r.${quoteIdent(c.field)}`)),
							", "
						)} FROM ${table} AS r ORDER BY r."id"`,
						[]
					)
					const texts = textRows(rows)
					const decoded = Arr.map(texts, decodeRow)
					const expected = new Map<string, (typeof facts)[number]>(
						Arr.map(facts, (f) => [Str.toLowerCase(f.id), f] as const)
					)
					assert.equal(decoded.length, expected.size)
					for (const row of decoded) {
						const f = typeof row["id"] === "string" ? expected.get(row["id"]) : undefined
						if (f === undefined) {
							return assert.fail(`a stored row of no fact: ${String(row["id"])}`)
						}
						for (const c of columns) {
							const codec = codecOf(c.type, kindRosterCodes)
							const value = row[c.field]
							assert.ok(
								isHostValue(codec.spec.carrier, value),
								`${c.field}: no ${codec.spec.carrier} value`
							)
							assert.ok(sameValue(codec, fieldOf(f, c.field), value), `${c.field} of ${f.id}`)
						}
					}
				}),
		oracle: {
			kind: "universal",
			name: "decode ∘ PostgreSQL ∘ encode = id over a stored row, the positional decoder's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/hex.ts",
				original: "\t\t(firstBit >> (position % hexDigitBits))",
				replacement: "\t\t(1 << (position % hexDigitBits))",
				why: "setBit puts a set's position 0 at its digit's least significant bit; a stored set decodes as another (CATCH census: the old suite's stored-row test caught this, plant codec-set-bit-order)."
			}
		]
	})

/** Exact scalar codecs against PostgreSQL write a routable carrier's value as PostgreSQL's ::text of it, whatever the writer's session settings. */
export const exactScalarCodecsAgainstPostgreSQLWritesARoutableCarriersValueAsPostgreSQLsTextOfItWhateverTheWritersSessionSettings =
	property.explore(routableGen, {
		needs: { tx: Substrate.transaction },
		situations: Arr.map(
			routableCases,
			(c): RoutableFeature => `routes ${c.label}`
		) satisfies ReadonlyArray<Reached<RoutableFeature>>,
		/** Its pre-conversion budget: runs and coverage cases roundTripRuns times the routable cases (scalar.test.ts at 4fbc3e95). */
		budget: {
			runs: roundTripRuns * routableCases.length,
			steered: roundTripRuns * routableCases.length
		},
		check:
			({ tx }, c: Case<RoutableFeature>) =>
			(trip) =>
				Effect.gen(function* () {
					const { session, schema } = yield* tx
					const { db, names } = yield* setupIn(session, schema)
					const routed = caseOf(trip.label)
					const codec = codecOf(routed.type, kindRosterCodes)
					const texts = Arr.map(trip.batch, (v) => succeeded(codec.encode(v)))
					for (const [name, value] of trip.settings) {
						yield* db.values(`SELECT pg_catalog.set_config($1, $2, false)`, [name, value])
					}
					const rows = yield* recordset(db, "(r.v)::text", wireSql(routed.type, names), texts)
					for (const [name] of trip.settings) {
						yield* db.values(`RESET ${name}`, [])
					}
					const differing = Arr.flatMap(texts, (text, i) => {
						const printed = textRows(rows)[i]?.[0]
						return printed === text ? [] : [{ codec: text, postgresql: printed }]
					})
					assert.deepEqual(differing, [], `${trip.label} under ${Formatter.format(trip.settings)}`)
					c.note(`routes ${trip.label}`)
				}),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's ::text of each value, under the writer's DateStyle, IntervalStyle, extra_float_digits and bytea_output"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/scalar.ts",
				original: "\tint8: true,\n\tnumeric: false,\n\tfloat4: false,\n\tfloat8: false,",
				replacement: "\tint8: true,\n\tnumeric: false,\n\tfloat4: false,\n\tfloat8: true,",
				why: "A double precision routes, and extra_float_digits prints it otherwise; a float8's route fails."
			}
		]
	})
