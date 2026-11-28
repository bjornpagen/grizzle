/**
 * A carrier's rows travel exactly (write/carriers/carriers.ts WriteCarrier): every value a carrier column holds, of
 * every carried type, reads back from its transaction-local setting as the value its fill read, against PostgreSQL 19.
 *
 * A carrier column's values travel as the text of their array (sql/carriers.ts carrierStash's set_config), PostgreSQL's
 * own output of it, and come back through its input (carrierReading's current_setting cast to the array type, unnested
 * in lockstep). The property draws a carried type of every carrier (the codec catalogue, test/support/unit/codec/wild.fixtures.ts
 * written, keyed by carrier, so a new carrier is listed there) and the edges of their texts: both zeros of a float, its
 * least subnormal and its greatest, NaN and the infinities, shortest digits; numeric of no typmod at its display scale,
 * NaN and the infinities; spans; a variant's composite; bytea; closed ids and sets; text of any character, the array's
 * punctuation, quotes, backslashes, whitespace and NULL spelled out among them. A case fills a carrier of two columns,
 * each value's ordinal and the value, typed as production types every carrier column (ir/physical.ts sessionTypeRef),
 * with the fill a write sends, then reads it as a write's statement does, under the login defaults a value's text
 * depends on (physical/ddl/roles.ts roleDefaultSettings): each value read back is paired with its own ordinal and is the
 * value sent, by its text, which under those defaults names one value (a float's shortest round-trip digits and its
 * sign of zero, a numeric's display scale).
 *
 * Oracle: second-implementation, the source's own rows, each value's text as PostgreSQL prints it before it travels.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	byOrdinal,
	carriedOf,
	carrierOf,
	catalogue,
	createComposite,
	exactGen,
	type ExactFeature,
	loginLike,
	parameterOf,
	statementsOf
} from "#test/pg/write/carrier-exactness/carrier-exactness.fixtures.ts"
import { baseSubstrate, Substrate } from "#test/support/substrate/substrate.ts"

/** Every value of every carried type a carrier holds reads back as itself, paired with its row. */
export const everyValueOfEveryCarriedTypeACarrierHoldsReadsBackAsItselfPairedWithItsRow =
	property.explore(exactGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			...Arr.map(catalogue, (c): ExactFeature => `carries ${c.label}`),
			"an empty carrier"
		] satisfies ReadonlyArray<Reached<ExactFeature>>,
		check:
			({ tx }, c: Case<ExactFeature>) =>
			(cases) =>
				Effect.gen(function* () {
					const { session, schema } = yield* tx
					for (const exact of cases) {
						yield* Effect.scoped(
							Effect.gen(function* () {
								const carried = carriedOf(exact.label)
								const { names, wire, schema: own } = yield* loginLike(session, schema)
								yield* createComposite(session, names, carried.type)
								const carrier = carrierOf(names, carried.type)
								const { create, load, fill, read, expected } = statementsOf(
									carrier,
									carried.type,
									wire,
									own
								)
								yield* session.values(create, [])
								yield* session.values(load, parameterOf(carried.type, exact.values))
								yield* session.values(fill, [])
								const readRows = yield* session.values(read, [])
								const sentRows = yield* session.values(expected, [])
								assert.deepEqual(byOrdinal(readRows), byOrdinal(sentRows), exact.label)
							})
						)
						c.note(`carries ${exact.label}`)
						if (exact.values.length === 0) {
							c.note("an empty carrier")
						}
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the source's own rows, each value's text as PostgreSQL prints it before it travels"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/carriers.ts",
				original: '\treturn type.kind === "builtin" && type.name === "bit" ? types.varbit : type\n',
				replacement:
					'\treturn type.kind === "builtin" && type.name === "bit"\n\t\t? types.varbit\n\t\t: type.kind === "builtin" && type.name === "double precision"\n\t\t\t? types.real\n\t\t\t: type\n',
				why: "A double travels as a real: its array is aggregated and read back at binary32, so every double past binary32's digits reads back another value."
			}
		]
	})
