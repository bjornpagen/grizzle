/**
 * exactInteger and exactMoney are stored fields of the types integer and money arithmetic deliver (scalar/exact.ts), at
 * numeric's own limit, so a query's exact value of any bound is a field's value, written and read back as it is.
 *
 * - Typing: for each carrier, a drawn digit bound an operation computes its exact value at, and a drawn value of the
 *   field's, from within a signed 64-bit count to hundreds of digits: the field's Description is the exact arm of its
 *   carrier and its type the exact value at numeric's own limit; the descriptor a derived relation's or a records
 *   relation's column of the computed type writes (schema/field-desc.ts fieldDescOf) is the field's, whose type
 *   it reads back; the computed value enters the field's column (ir/scalar.ts entersColumn), and no value of the other
 *   carrier does; the field's column converts numeric_out's text of the value to it bit-exactly, the codec writes that
 *   text and reads it back, and the live wire parses it at the field's spec; and the wire's spec of the computed bound
 *   holds 10^edge - 1 and refuses 10^edge at a bound of `edge` digits, read by its digits.
 * - Placement: for each carrier, an exact field in a relation's primary key or a candidate key is UnrepresentableKey
 *   (exactValue), naming its precision as the fix; one beside the key installs with its column CHECK of its one scale,
 *   scale 0 or money's 2; and a derived relation's head of an exact value, a + b over bigints or m + n over amounts, is
 *   the exact field's, where it was refused (DerivedRefused exactField) before.
 *
 * Oracles: the exact type restated (exactType at numericMaxIntegerDigits), the drawn values' own text, and the rule that
 * no key holds an exact field, each a specification.
 *
 * Features: each carrier, magnitude and bound; each placement of each carrier.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import { compileReasonText } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { entersColumn, type ExactValueCarrier, sameScalarType } from "#compiler/ir/scalar.ts"
import { wireScalarOf } from "#compiler/live/member.ts"
import { parseScalar } from "#compiler/live/wire.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { exactType } from "#compiler/scalar/compute/types.ts"
import { bareEnv, describeField, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { converterOf } from "#compiler/scalar/values/convert.ts"
import { numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { fieldDescOf } from "#compiler/schema/field-desc.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { refused, refusedKeys, succeeded } from "#test/support/assert.ts"
import { undeclared } from "#test/support/fixtures/ir/scalar.ts"
import { checkedIn, ownedInput } from "#test/support/policy.ts"
import { outputText } from "#test/support/wire.ts"
import { codecOf } from "#test/unit/codec/support.ts"
import {
	type BoundFeature,
	declaredSchema,
	derivedLevel,
	exactCheckText,
	exactFields,
	type ExactValue,
	type MagnitudeFeature,
	otherCarrier,
	type Placement,
	placements,
	keyFaultOf,
	precisionFix,
	typingCaseGen
} from "#test/unit/scalar/exact-fields.fixtures.ts"

/** Whether a host value is the drawn value: a bigint by identity, a Money by its count of cents. */
const sameHost = (read: unknown, drawn: ExactValue): boolean =>
	drawn.carrier === "exactInteger"
		? read === drawn.value
		: read instanceof Money && read.minorUnits === drawn.value.minorUnits

type TypingFeature = ExactValueCarrier | MagnitudeFeature | BoundFeature

/** An exact field is arithmetic's exact type at numeric's own limit, and holds every value of its carrier bit-exactly. */
export const anExactFieldIsArithmeticsExactTypeAtNumericsOwnLimitAndHoldsEveryValueOfItsCarrierBitExactly =
	property.explore(typingCaseGen, {
		needs: {},
		situations: [
			"exactInteger",
			"exactMoney",
			"a value within a signed 64-bit count",
			"a value past a signed 64-bit count",
			"a value of hundreds of digits",
			"a computed bound of a bigint's digits or fewer",
			"a computed bound past a bigint's digits",
			"a computed bound at numeric's own limit"
		] satisfies ReadonlyArray<Reached<TypingFeature>>,
		check:
			(_, c: Case<TypingFeature>) =>
			({ carrier, bound, digits, magnitude, value, edge }) =>
				Effect.sync(() => {
					c.note(carrier)
					c.note(bound)
					c.note(magnitude)
					const shown = `${carrier} at a computed bound of ${digits} digits, ${value.text}`
					const field = succeeded(describeField(exactFields[carrier], SourceLoc("exact field", [])))
					assert.deepEqual(field.desc, { kind: "exact", carrier }, `${shown}: its Description`)
					assert.ok(
						sameScalarType(field.scalar, exactType(carrier, numericMaxIntegerDigits)),
						`${shown}: its type is the exact value at numeric's own limit`
					)
					const computed = exactType(carrier, digits)
					const written = succeeded(
						fieldDescOf(computed, undeclared),
						`${shown}: the computed column's descriptor`
					)
					assert.deepEqual(
						written,
						field.desc,
						`${shown}: the computed column's descriptor is the field's`
					)
					assert.ok(
						written.kind !== "computedNumeric" &&
							sameScalarType(
								succeeded(scalarTypeOf(written, bareEnv, SourceLoc("exact", []))),
								field.scalar
							),
						`${shown}: the computed column's descriptor reads back as the field's type`
					)
					assert.ok(
						entersColumn(field.scalar, computed),
						`${shown}: the computed value enters the field`
					)
					assert.ok(
						!entersColumn(field.scalar, exactType(otherCarrier(carrier), digits)),
						`${shown}: the other carrier's value enters no field of it`
					)
					const column = field.column
					assert.ok(column.kind === "convert", `${shown}: the field's column converts its text`)
					assert.ok(
						sameHost(converterOf(column.conversion)(outputText(value.text)), value),
						`${shown}: the column's value`
					)
					const codec = codecOf(field.scalar, firstCodebook([]))
					assert.equal<string>(
						succeeded(codec.encode(value.value)),
						value.text,
						`${shown}: the codec's text`
					)
					assert.ok(sameHost(codec.convert(value.text), value), `${shown}: the codec's reading`)
					assert.ok(
						sameHost(succeeded(parseScalar(wireScalarOf(field.scalar), value.text)), value),
						`${shown}: the wire's parse at the field's spec`
					)
					const spec = wireScalarOf(exactType(carrier, edge))
					const greatest = (10n ** BigInt(edge) - 1n).toString()
					const past = (10n ** BigInt(edge)).toString()
					assert.ok(
						parseScalar(spec, greatest).ok,
						`${shown}: the wire holds ${greatest} at ${edge} digits`
					)
					assert.ok(
						!parseScalar(spec, past).ok,
						`${shown}: the wire refuses ${past} at ${edge} digits`
					)
				}),
		oracle: {
			kind: "specification",
			name: "an exact field is exactType(carrier, numericMaxIntegerDigits), its values their own text"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/registry.ts",
				original: "\t\tdigits: numericMaxIntegerDigits\n\t})",
				replacement: "\t\tdigits: 18\n\t})",
				why: "An exact field is the exact value of a bigint's digits, not numeric's own limit: its type differs, and a computed value of more digits enters no field; the typing property fails."
			},
			{
				file: "packages/engine/src/schema/field-desc.ts",
				original: '\t\t\treturn Result.ok({ kind: "exact", carrier: type.carrier })',
				replacement: '\t\t\treturn Result.ok({ kind: "exact", carrier: "exactInteger" })',
				why: "A computed exact money column's descriptor is the exact integer's, so a derived or records relation of it reads integers; the typing property fails."
			},
			{
				file: "packages/engine/src/ir/scalar.ts",
				original: "\tvalue.digits <= column.digits",
				replacement: "\tvalue.digits === column.digits",
				why: "Only an exact value at numeric's own limit enters an exact field, so a query's sum or product of a narrower bound is refused where it is written; the typing property fails."
			},
			{
				file: "packages/engine/src/ir/carriers.ts",
				original:
					"\tcoefficient === 0n || (exponent > 0 && coefficient.toString().length <= exponent)",
				replacement:
					"\tcoefficient === 0n || (exponent > 0 && coefficient.toString().length < exponent)",
				why: "The wire refuses an exact value of exactly its bound's digits, 10^d - 1 at d digits; the typing property fails."
			}
		]
	})

/** Each placement of each carrier: the box of the placement property. */
const placementCases = nonEmpty(
	Arr.flatMap(["exactInteger", "exactMoney"] as const, (carrier) =>
		Arr.map(placements, (placement) => ({ carrier, placement }))
	),
	"the placements"
)

type PlacementFeature = `${Placement} of ${ExactValueCarrier}`

/** The text of every statement an installation of `schema` runs. */
const installedText = (value: Parameters<typeof ownedInput>[0]): string => {
	const owned = succeeded(ownedInput(value))
	return Arr.join(
		Arr.map(
			succeeded(compileInstallation(owned, installOptions(owned))).statements,
			printStatement
		),
		"\n"
	)
}

/** No key holds an exact field, whose refusal names its precision; one beside its key is CHECKed to its scale. */
export const noKeyHoldsAnExactFieldWhoseRefusalNamesItsPrecisionAndOneBesideItsKeyIsCheckedToItsScale =
	property.exhaust(
		finite((source) => source.draw(element(placementCases))),
		{
			box: "each carrier's exact field in a primary key, in a candidate key, beside its key and as a derived relation's head",
			needs: {},
			situations: Arr.flatMap(placements, (placement) =>
				Arr.map(
					["exactInteger", "exactMoney"] as const,
					(carrier): PlacementFeature => `${placement} of ${carrier}`
				)
			) satisfies ReadonlyArray<Reached<PlacementFeature>>,
			check:
				(_, c: Case<PlacementFeature>) =>
				({ carrier, placement }) =>
					Effect.sync(() => {
						c.note(`${placement} of ${carrier}`)
						const shown = `${carrier} ${placement}`
						switch (placement) {
							case "in the primary key":
							case "in a candidate key": {
								const error = refused(
									Result.flatMap(ownedInput(declaredSchema(carrier, placement)), (owned) =>
										compileInstallation(owned, installOptions(owned))
									),
									"UnrepresentableKey",
									shown
								)
								const reason = error.reason
								assert.ok(reason._tag === "UnrepresentableKey", `${shown}: an unrepresentable key`)
								assert.deepEqual(
									Arr.map(refusedKeys(error), (k) => k.fault),
									[{ kind: "exactValue", field: "x", ...keyFaultOf[carrier] }],
									`${shown}: the one fault names the exact field`
								)
								assert.ok(
									Str.includes(precisionFix[carrier])(compileReasonText(reason)),
									`${shown}: the refusal names the precision to declare`
								)
								return
							}
							case "beside the key": {
								assert.ok(
									Str.includes(exactCheckText("x", carrier))(
										installedText(declaredSchema(carrier, placement))
									),
									`${shown}: the column carries the CHECK of its scale`
								)
								return
							}
							case "a derived relation's head": {
								const analysis = derivedAnalysis(succeeded(checkedIn(derivedLevel(carrier)), shown))
								const head = defined(
									Option.getOrUndefined(
										Arr.findFirst(
											defined(analysis.relations["Summed"], `${shown}: Summed`).heading,
											(column) => column.name === "x"
										)
									),
									`${shown}: the head x`
								)
								assert.deepEqual(
									head.desc,
									{ kind: "exact", carrier },
									`${shown}: the head's descriptor`
								)
								return
							}
						}
					}),
			oracle: {
				kind: "specification",
				name: "no key holds an exact field; its column holds its host's scale; a derived head of one is its field"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/representability.ts",
					original:
						'\tdesc.kind === "exact" ? { kind: "exactValue", field, ...exactKeyFix[desc.carrier] } : undefined',
					replacement: "\tundefined",
					why: "A key over an exact field is sized as a numeric's datum, its refusal a B-tree entry's that names no precision; the placement property fails."
				},
				{
					file: "packages/engine/src/physical/ddl/column-checks.ts",
					original: "\tintegerNumeric,\n\texactNumeric,\n",
					replacement: "\tintegerNumeric,\n",
					why: "An exact field's column carries no CHECK of its scale, so a direct writer stores 1.5 into an integer; the placement property fails."
				},
				{
					file: "packages/engine/src/scalar/exact.ts",
					original: '\t\tcase "exactMoney":\n\t\t\treturn moneyFractionDigits',
					replacement: '\t\tcase "exactMoney":\n\t\t\treturn 0',
					why: "An exact money field's column is CHECKed to scale 0, which refuses every amount with cents; the placement property fails."
				}
			]
		}
	)
