/**
 * A cast into an exact integer on PostgreSQL 19 (scalar/compute/registry.ts castOverloads, numeric's and text's
 * exactInteger): over drawn rows of a text of at most 40 bytes and a numeric(30, 0), a relation's two generated exact
 * integers, the text's integer parsed in one step under qti-pie's integer guard (its ledger's walks.ts at 7ea6419c, a
 * cell's integer, QtiValue's integer arm) and the numeric widened, each stored by PostgreSQL in its column under the
 * exact integer's CHECK of scale 0 and read back through a served Db, agree with grizzle's host evaluator of the row
 * (rowEvaluator) and with xs:integer's mapping, BigInt's, exactly: past bigint's range, signed, zero-padded, at the
 * text's byte bound, and 0 for a text of no integer, so neither cast rounds.
 *
 * Oracle: xs:integer's lexical mapping, BigInt over the numeral, beside PostgreSQL's and the host's.
 *
 * Features: an integer text past bigint's range, of a sign and leading zeros, at the byte bound; a text of no integer;
 * a numeric past bigint's range.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Option, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import { rowEvaluator } from "#adapter/public/host.ts"
import {
	Digits,
	type DrawnRow,
	ExactCasts,
	exactCastsInstall,
	exactCastsTemplate,
	type Feature,
	featuresOf,
	parsedOf,
	rowsGen
} from "#test/pg/compute/exact-casts.fixtures.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const evaluator = Result.getOrThrow(rowEvaluator(ExactCasts))

/** A row as the relation states it: its id its place. */
const factOf = (row: DrawnRow, id: number) => ({ id, t: row.t, n: row.n })

/** A text and a numeric cast into exact integers on PostgreSQL agree with the host evaluator and xs:integer's mapping. */
export const aCastIntoAnExactIntegerOnPostgreSQLAgreesWithTheHostAndXsIntegersMapping =
	property.explore(rowsGen, {
		needs: { fixture: Substrate.fresh(exactCastsTemplate) },
		situations: [
			"an integer text past bigint's range",
			"an integer text of a sign and leading zeros",
			"an integer text at the byte bound",
			"a text of no integer",
			"a numeric past bigint's range"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			(rows) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.scoped(
							Effect.gen(function* () {
								const o = yield* openedIn(ExactCasts, {}, exactCastsInstall, taken)
								yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const facts = Arr.map(rows, factOf)
									const written = yield* writeAnswerOf(
										db.workload.insert.once({ params: {}, facts: { insert: { Digits: facts } } })
									)
									assert.equal(written.kind, "accepted", "every row is written")
									const stored = yield* rowsOf(db.workload.all.once({ params: {}, facts: {} }))
									for (const [id, row] of rows.entries()) {
										const read = defined(
											Option.getOrUndefined(Arr.findFirst(stored, (s) => s.id === id)),
											`row ${id} reads back`
										)
										const expected = [parsedOf(row.t), row.n]
										assert.deepEqual(
											[read.parsed, read.widened],
											expected,
											`${Formatter.format(row.t)} and ${row.n}: PostgreSQL's exact integers are xs:integer's`
										)
										const admitted = Result.getOrThrow(evaluator.admit(Digits, factOf(row, id)))
										const host = evaluator(Digits, admitted).generated
										assert.deepEqual(
											[Result.getOrThrow(host.parsed), Result.getOrThrow(host.widened)],
											expected,
											`${Formatter.format(row.t)} and ${row.n}: the host's exact integers are PostgreSQL's`
										)
										c.noteAll(featuresOf(row))
									}
								}).pipe(
									(body) =>
										Effect.flatMap(Layer.build(o.served.layer), (context) =>
											Effect.provideContext(body, context)
										),
									Effect.scoped
								)
							})
						),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "xs:integer's lexical mapping, BigInt over the numeral"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/lexical.ts",
				original: "\t\t: BigInt(text)\n}\n",
				replacement: "\t\t: BigInt(Number(text))\n}\n",
				why: "The host reads an exact integer's numeral through a double: a text past 2^53 loses its last digits, where PostgreSQL's parse and xs:integer's mapping keep them; the property fails."
			},
			{
				file: "packages/engine/src/scalar/lexical.ts",
				original:
					'\t\tcase "exactInteger":\n\t\t\treturn { kind: "exactInteger", digits: type.digits }\n',
				replacement:
					'\t\tcase "exactInteger":\n\t\t\treturn { kind: "integer", carrier: "int8" }\n',
				why: "An exact integer's lexical form is bigint's: the integer guard's language lies past it, so the fixture's parse is refused at compile; the property fails."
			}
		]
	})
