/**
 * A closed relation's sparse constant on PostgreSQL 19 (ir/cells.ts Constant, sql/constants.ts): its cells and its
 * payloads, created as the migration states them (sql/constants.ts pack), read as every closed read reads them, over
 * drawn constants of product keys, one to three coordinates of a few codes or of up to a roster's whole code space, and
 * a payload of none, one or two coordinates; and the kept key space of 2^45 cells holding five.
 *
 * At every key a case asks, every held cell, its neighbours, the key space's first and last cell, every point of a small
 * space, a few drawn keys and a NULL one, in one round trip: C.has is whether the cell is held, false where it is not
 * and NULL at a NULL code; C.at of each payload coordinate is the held cell's code there, NULL where none is held; the
 * pair of a key and a payload code holds exactly where the cell holds that code; and C.row of the key's prefix is the run
 * of the last coordinate's cells, a bit at each held one, at the width of a set over it, read by the library's closedRow,
 * NULL where its prefix is.
 *
 * Oracle: the model, each read off a scan of every element of the constant's arrays (test/support/closed/codes.ts) at
 * the index the model's own mixed radix gives the key's digits, sharing no code with the encoder or its SQL.
 *
 * Features: a set, a function and one of two payload coordinates; a key space past 2^31 cells; no cell held; a held key,
 * an absent one, one past and one before every held key, and a NULL one asked; a row holding a cell and one holding none.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	createSql,
	featuresOf,
	modelOf,
	probesJson,
	readSql,
	type SparseFeature,
	sparseCases
} from "#test/pg/closed/sparse.fixtures.ts"
import { inInstallation } from "#test/support/pg/compute/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A closed relation's sparse constant answers every closed read at every key as the model does, a key space past 2^31
 * cells among them.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aClosedRelationsSparseConstantAnswersEveryClosedReadAtEveryKeyAsTheModelDo =
	property.explore(sparseCases, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"a set",
			"a function",
			"a function of two payload coordinates",
			"a key space past 2^31 cells",
			"no cell held",
			"a held key asked",
			"an absent key asked",
			"a key past every held one asked",
			"a key before every held one asked",
			"a NULL key asked",
			"a row holding a cell",
			"a row holding none"
		] satisfies ReadonlyArray<Reached<SparseFeature>>,
		check:
			({ tx }, k: Case<SparseFeature>) =>
			(c) =>
				Effect.gen(function* () {
					const { bare } = yield* tx
					const rows = yield* inInstallation(
						bare,
						createSql(c),
						bare.queryValues(readSql(c), [jsonText(probesJson(c))])
					)
					assert.equal(rows.length, c.probes.length, "a row per key asked")
					for (const [i, row] of rows.entries()) {
						const probe = defined(c.probes[i], "the key PostgreSQL read")
						assert.deepEqual(
							row,
							modelOf(c, probe),
							`the reads at ${Formatter.format(probe.digits)} of ${Formatter.format(c.key)}`
						)
					}
					for (const feature of featuresOf(c)) {
						k.note(feature)
					}
				}),
		oracle: {
			kind: "specification",
			name: "each read off a scan of every element of the constant's arrays, at the model's own mixed-radix index"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/closed/sparse.test.ts#aClosedRelationsSparseConstantAnswersEveryClosedReadAtEveryKeyAsTheModelDo:-:1"
				),
				reason:
					"a key of three coordinates of 32,768 codes each, 2^45 cells, holding five: past the 2^31 cells an integer index counted, which a bigint index reads",
				since: "2026-11-24"
			}
		],
		kills: [
			{
				file: "packages/engine/src/sql/constants.ts",
				original: '\t\t\t\tindex: binary("-", positionOf(constant.cells, index), int(1))',
				replacement: "\t\t\t\tindex: positionOf(constant.cells, index)",
				why: "An application reads the payloads one place on from its cell, the next held cell's payload; C.at and the pair part from the model at every held key but the last."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: '\t\t\tbinary("+", atOrBelow(binary("-", first, one)), integer(1)),',
				replacement: '\t\t\tbinary("+", atOrBelow(first), integer(1)),',
				why: "closedRow's run starts one cell late: a row whose first cell is held reads it unset."
			},
			{
				file: "packages/engine/src/sql/constants.ts",
				original:
					'const times = (e: Expr, factor: number): Expr => (factor === 1 ? e : binary("*", e, big(factor)))',
				replacement:
					'const times = (e: Expr, factor: number): Expr => (factor === 1 ? e : binary("*", e, int(factor)))',
				why: 'A key\'s index is integer arithmetic: a key space past 2^31 cells reads "integer out of range" at its far keys, where the model reads their cells.'
			}
		]
	})
