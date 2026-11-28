/**
 * numeric(p, 0) is an integer type: its host value is a bigint, exact at any precision, and NaN, which PostgreSQL's
 * numeric(p, 0) holds and no bigint spells, is no value of it (ir/carriers.ts isIntegerTypmod).
 *
 * - Decoding: over drawn typmods across numeric's box, scale 0 one in two, and drawn values of each, a numeric(p, s)
 *   descriptor's column (scalar/values/convert.ts numericColumn), which a caller's reads deliver, and its codec's reader
 *   (codec/read.ts scalarReader), which the engine's own reads take, each convert numeric_out's text of a value to the
 *   host value its value space gives: numeric(p, 0)'s integer as that bigint, any other value as its Decimal.
 * - NaN at every door: for a drawn numeric(p, 0), NaN is refused by the codec's parse of a caller's value, a stored
 *   literal (scalar/literal.ts storedLiteral), a typed literal (scalar/compute/literal.ts irLiteral), the typmod's one
 *   rule the evaluator's cast coerces by (decimal.ts normalizeNumeric and parseNumeric), the proof a cast into the type
 *   needs (scalar/compute/lower.ts fitsTarget), which an operand of no NaN meets, and the live wire's parse
 *   (live/wire.ts parseScalar); PostgreSQL's own refusal of a direct writer is the column's CHECK
 *   (physical/numeric/storage.ts).
 *
 * Oracle: the value space restated (fixtures valueGen's model), and the specification that every door refuses NaN.
 *
 * Features: each scale's sign; each door.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { scalarReader } from "#compiler/codec/read.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { wireScalarOf } from "#compiler/live/member.ts"
import { parseScalar } from "#compiler/live/wire.ts"
import { pg } from "#compiler/public/fields.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import { storedLiteral } from "#compiler/scalar/literal.ts"
import { converterOf } from "#compiler/scalar/values/convert.ts"
import { Decimal, normalizeNumeric, parseNumeric } from "#compiler/scalar/values/decimal.ts"
import { faulted } from "#test/support/assert.ts"
import { codecOf } from "#test/support/unit/codec/support.ts"
import {
	baseParams,
	lowerWith,
	param,
	spelledExpr,
	testPg
} from "#test/support/unit/compute/support.ts"
import { preconditionOf } from "#test/support/unit/compute/totality.fixtures.ts"
import { outputText } from "#test/support/wire.ts"
import { described } from "#test/unit/scalar/descriptors.fixtures.ts"
import {
	type ScaleFeature,
	scaleFeatureOf,
	typmodGen,
	valueGen
} from "#test/unit/scalar/integer-numeric.fixtures.ts"

/** Whether a converted value is the model's: a bigint by identity, a Decimal by its own equality. */
const sameValue = (converted: unknown, model: Decimal | bigint): boolean =>
	typeof model === "bigint"
		? converted === model
		: converted instanceof Decimal && converted.equals(model)

/** A numeric(p, s) descriptor's column and its codec's reader read numeric_out's text as its value space's host value. */
export const aNumericDescriptorsColumnAndItsReaderReadItsOutputAsItsValueSpacesHostValue =
	property.explore(
		(source) => {
			const typmod = source.draw(typmodGen)
			return { typmod, written: source.draw(valueGen(typmod)) }
		},
		{
			needs: {},
			situations: ["scale 0", "a positive scale", "a negative scale"] satisfies ReadonlyArray<
				Reached<ScaleFeature>
			>,
			check:
				(_, c: Case<ScaleFeature>) =>
				({ typmod, written }) =>
					Effect.sync(() => {
						c.note(scaleFeatureOf(typmod.scale))
						const field = described(pg.numeric(typmod.precision, typmod.scale))
						const column = field.column
						assert.ok(column.kind === "convert", "a numeric's column converts its text")
						const shown = `numeric(${typmod.precision}, ${typmod.scale}) of ${written.text}`
						assert.ok(
							sameValue(converterOf(column.conversion)(outputText(written.text)), written.value),
							`${shown}: the column's value`
						)
						assert.ok(
							sameValue(
								scalarReader(field.scalar, firstCodebook([])).convert(outputText(written.text)),
								written.value
							),
							`${shown}: the reader's value`
						)
					}),
			oracle: {
				kind: "specification",
				name: "numeric(p, 0)'s values are bigints, every other numeric's Decimals"
			},
			budget: { runs: 300, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/convert.ts",
					original:
						'\tconvertColumn({ carrier: isIntegerTypmod(typmod) ? "exactInteger" : "numeric" })',
					replacement: '\tconvertColumn({ carrier: "numeric" })',
					why: "A numeric(p, 0) descriptor's column decodes as the general numeric, a Decimal where its host type is a bigint; the column's value differs."
				},
				{
					file: "packages/engine/src/codec/scalar.ts",
					original: "\t\t\t\t: isIntegerTypmod(type.typmod)",
					replacement: "\t\t\t\t: false",
					why: "A numeric(p, 0)'s codec spec is the general numeric's, so the engine's reader decodes a Decimal where the column delivers a bigint; the reader's value differs."
				}
			]
		}
	)

/** The doors numeric(p, 0) refuses NaN at, and the proof a NaN-free operand meets. */
type DoorFeature =
	| "the codec refuses NaN"
	| "a stored literal refuses NaN"
	| "a typed literal refuses NaN"
	| "the typmod's rule refuses NaN"
	| "a cast's proof refuses NaN"
	| "a cast's proof admits an integer"
	| "the wire refuses NaN"

/** numeric(p, 0) refuses NaN at every door, and a cast into it is proved over an operand of no NaN. */
export const numericP0RefusesNaNAtEveryDoor = property.explore(int(1, 1000), {
	needs: {},
	situations: [
		"the codec refuses NaN",
		"a stored literal refuses NaN",
		"a typed literal refuses NaN",
		"the typmod's rule refuses NaN",
		"a cast's proof refuses NaN",
		"a cast's proof admits an integer",
		"the wire refuses NaN"
	] satisfies ReadonlyArray<Reached<DoorFeature>>,
	check: (_, c: Case<DoorFeature>) => (precision) =>
		Effect.sync(() => {
			const integer = testPg.numericOf(precision, 0)
			const type = integer.scalar
			const typmod = { precision, scale: 0 }
			const shown = `numeric(${precision}, 0)`
			faulted(codecOf(type, firstCodebook([])).encode(Decimal.nan), "integerType", shown)
			c.note("the codec refuses NaN")
			for (const nan of [Decimal.nan, "NaN"]) {
				assert.ok(!storedLiteral(type, nan).ok, `${shown}: a stored literal ${String(nan)}`)
			}
			c.note("a stored literal refuses NaN")
			assert.ok(!irLiteral(Decimal.nan, type).ok, `${shown}: a typed literal NaN`)
			c.note("a typed literal refuses NaN")
			faulted(normalizeNumeric(Decimal.nan, typmod), "numericNaN", `${shown}: its coercion`)
			faulted(parseNumeric(Decimal.nan, typmod), "numericNaN", `${shown}: its parse`)
			c.note("the typmod's rule refuses NaN")
			/** A cast into numeric(p, 0) from numeric(p, 1), whose values round inside it and hold NaN, and from itself. */
			const castFrom = (scale: number) =>
				preconditionOf(
					lowerWith(
						"query",
						spelledExpr(
							computeCore.cast(param("p", testPg.numericOf(precision, scale)), integer).expr
						),
						{},
						false,
						baseParams
					),
					shown
				)
			assert.equal(castFrom(1), "fits", `${shown}: a cast from numeric(${precision}, 1)`)
			c.note("a cast's proof refuses NaN")
			assert.equal(castFrom(0), undefined, `${shown}: a cast from numeric(${precision}, 0)`)
			c.note("a cast's proof admits an integer")
			assert.ok(!parseScalar(wireScalarOf(type), "NaN").ok, `${shown}: the wire's NaN`)
			c.note("the wire refuses NaN")
		}),
	oracle: { kind: "specification", name: "numeric(p, 0) holds no NaN" },
	budget: { runs: 60, steered: 0 },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/scalar/values/decimal.ts",
			original:
				'\t\t: isIntegerTypmod(typmod)\n\t\t\t? Result.err("numericNaN")\n\t\t\t: Result.ok(d)',
			replacement: "\t\t: Result.ok(d)",
			why: "The typmod's rule admits NaN at scale 0, so a stored literal, a typed literal and the evaluator's cast take NaN into a bigint field; the doors property fails."
		},
		{
			file: "packages/engine/src/scalar/compute/lower.ts",
			original: "\t\t!(interval.nan && integerTypmodOf(target) !== undefined)",
			replacement: "\t\ttrue",
			why: "A cast's proof into numeric(p, 0) admits an operand that may be NaN, which the bigint field cannot hold; the doors property fails."
		}
	]
})
