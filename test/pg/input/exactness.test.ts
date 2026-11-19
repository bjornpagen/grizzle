/**
 * The input boundary's exactness against PostgreSQL 19: a value is parsed once as its type (scalar/values/identity.ts
 * parseValue), and the database stores exactly the value parsed or nothing; a silently altered value is never stored.
 *
 * - Exactness: for every carrier whose input PostgreSQL could store as another value than the one sent, numeric under
 *   typmods of many precisions and scales (a negative scale and a scale above the precision among them), real, double
 *   precision, money, smallint, integer, bigint, uuid, date, text and boolean, a batch of drawn host values, inside the
 *   type, past its scale or its precision, no binary32 value, at the type's edges and of another type, is parsed: a
 *   refused value sends nothing (every JavaScript number is a double exactly, -0 a spelling of 0, so a double's one
 *   refusal is a value of another type); an admitted one is the value drawn under the carrier's own equality, the parse
 *   altering only its spelling (a uuid's case, a float's -0), and its parameter text, cast to the column's type in one
 *   recordset as a stored column's assignment casts it, comes back as PostgreSQL's text of the stored value, read by
 *   the kernel's strict reader (test/support/kernel/strict.ts), exactly the value parsed.
 *
 * Oracle: PostgreSQL itself, its input functions and its typmod coercion; and each carrier's equality between the value
 * drawn and the value parsed.
 *
 * Features: per carrier, "<carrier> stored exactly" and "<carrier> refused"; "numeric past its scale refused" and "real
 * no binary32 value refused", the two coercions PostgreSQL would make silently.
 */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { carrierSpecOf, scalarCodec } from "#compiler/codec/scalar.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { parseValue } from "#compiler/scalar/values/identity.ts"
import {
	caseGen,
	columns,
	type ExactFeature,
	keptValue,
	readBackSql,
	sameHost
} from "#test/pg/input/exactness.fixtures.ts"
import { strictReader } from "#test/support/kernel/strict.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The input boundary against PostgreSQL 19 stores exactly the value parsed, or refuses it before any SQL: never a silently altered value. */
export const theInputBoundaryAgainstPostgreSQL19StoresExactlyTheValueParsedOrRefusesItBeforeAnySQLNeverASilentlyAlteredValue =
	property.explore(caseGen, {
		needs: { tx: Substrate.transaction },
		situations: nonEmpty(
			[
				...Arr.flatMap(columns, (c): ReadonlyArray<ExactFeature> => [
					`${c.label} stored exactly`,
					`${c.label} refused`
				]),
				"numeric past its scale refused",
				"real no binary32 value refused"
			],
			"the features"
		) satisfies ReadonlyArray<Reached<ExactFeature>>,
		/** Its pre-conversion budget: runs 400, coverage cases 400 (exactness.test.ts at 4fbc3e95). */
		budget: { runs: 400, steered: 400 },
		check:
			({ tx }, c: CaseOf<ExactFeature>) =>
			({ column, values }) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx

					const spec = carrierSpecOf(column.type, emptyCodebook)
					const codec = scalarCodec(column.type, emptyCodebook)
					const sent: Array<{
						readonly ord: number
						readonly v: string
						readonly parsed: unknown
					}> = []
					for (const [ord, value] of values.entries()) {
						const parsed = parseValue(spec, value)
						if (!parsed.ok) {
							c.note(`${column.label} refused`)
							if (parsed.error === "numericScale") {
								c.note("numeric past its scale refused")
							}
							if (parsed.error === "realInexact") {
								c.note("real no binary32 value refused")
							}
							continue
						}
						assert.ok(
							keptValue(spec, parsed.value, value),
							`${column.label}: the parse of ${Formatter.format(value)} is ${Formatter.format(parsed.value)}, another value`
						)
						const text = codec.encode(value)
						if (!text.ok) {
							return assert.fail(`${column.label}: a value the parse admits encodes`)
						}
						sent.push({ ord, v: text.value, parsed: parsed.value })
					}
					if (sent.length === 0) {
						return
					}
					const rows = yield* db.values(
						`SELECT c.ord::text, ${readBackSql(column)} FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord`,
						[jsonText(Arr.map(sent, ({ ord, v }) => ({ ord, v })))]
					)
					assert.equal(rows.length, sent.length, `${column.label}: one row per value sent`)
					const read = strictReader(column.type, emptyCodebook)
					for (const [i, one] of sent.entries()) {
						const cell = defined(rows[i], `the row of value ${one.ord}`)[1]
						const stored = typeof cell === "string" ? read(cell) : undefined
						assert.ok(
							stored !== undefined &&
								Result.isSuccess(stored) &&
								sameHost(spec, stored.success, one.parsed),
							`${column.label}: ${Formatter.format(one.parsed)} was stored as ${Formatter.format(cell)}`
						)
						c.note(`${column.label} stored exactly`)
					}
				}),
		oracle: {
			kind: "postgresql",
			name: "each column type's input and typmod coercion, read back by the strict reader"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original: "\tconst units = exactUnits(d, typmod.scale)",
				replacement:
					"\treturn normalizeNumeric(d, typmod)\n\tconst units = exactUnits(d, typmod.scale)",
				why: "parseNumeric rounds to the typmod's scale as normalizeNumeric does, admitting 1.005 at scale 2 as 1.01."
			},
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original:
					'\treturn real === x || Number.isNaN(x) ? Result.ok(real) : Result.err("realInexact")',
				replacement: "\treturn toReal(x)",
				why: "parseReal rounds a double to binary32 as toReal does."
			}
		]
	})
