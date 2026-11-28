/**
 * A bare literal takes an exact type as it takes any type (scalar/compute/literal.ts literalOf): its host value, a bigint
 * for an exact integer and a Money for exact money, is a value of the type within its digits, |x| < 10^digits (ir/expr.ts
 * literalProblem), and one past them is refused naming the bound. The type is its position's: a value's place takes its
 * field's type, a conditional's branch the conditional's type (Typing.branchOperand), and a comparison's or an
 * operation's operand opposite an exact value any value of its family, at numeric's own limit (typing.ts adoptedType),
 * since an exact value's digits are what its making proves of it, never a domain a value it meets is held to.
 *
 * qti-pie's ledger (lane LEDGER-VALUECELL, QtiValue's integer arm on exactInteger) writes
 * `QtiValue.make("integer", { value: 1n })`, the kept case: a made value's field is a value's place, so the literal is
 * a value of the field's exact integer, the same value `Type.cast(Type.literal(int8, 1n), field)` writes.
 *
 * The box, exhausted: each position of a relation's generated field an exact integer literal stands at, built and
 * compiled as `grizzle generate` compiles it, a made value's field (the consumer's), a typed literal, a branch and an
 * operand beside an exact field, a comparison opposite one, and a branch, a comparison and an operand beside a sum of two
 * integers (an exact integer of 11 digits), at 1, -7, 10^30, -(10^11 - 1), 10^11 and 10^131072; and an amount in a query
 * beside a term of exact money of 2 digits as a conditional's branch and compared with it, at 1.25, 99.99, 100.00,
 * money's greatest and 10^131072 units.
 *
 * Oracle: the specification, its bound read by the power, never by the digits the engine counts: a literal whose
 * magnitude lies below 10^digits of the type its position gives it is admitted, an integer written as itself at the
 * type's SQL type (bigint for an exact value of at most 18 digits, numeric past them), and the consumer's made value is
 * the one its cast wrote; one at or past 10^digits is MalformedDescription naming 10^digits, or 10^131072 where a
 * builder states it past any value of its family, as which the builder reads a literal opposite an exact term before its
 * position types it.
 */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result, String as Str } from "effect"
import { compileReasonText, isCompileError } from "#compiler/core/errors.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { exactType } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { moneyFractionDigits } from "#compiler/scalar/values/decimal.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ownedInput } from "#test/support/policy.ts"
import { adoptedLiteral, baseParams, lowerWith } from "#test/support/unit/compute/support.ts"
import {
	castSchema,
	fieldDigits,
	type IntegerPosition,
	integerPositionNames,
	integerPositions,
	type LiteralCase,
	literalCases,
	moneyDigits,
	type MoneyPlace,
	moneyPlaces
} from "#test/unit/compute/exact-literals.fixtures.ts"

/** Where a case's literal stands: an integer position of a generated field, or an amount's place beside exact money. */
type Place = IntegerPosition | MoneyPlace

type Feature = `${Place}, ${"admitted" | "refused past its bound"}`

/** A case's place. */
const placeOf = (c: LiteralCase): Place => (c.door === "position" ? c.position : c.place)

/** What a case's schema comes to: its installation's text, or the refusal of its build or its compile. */
type Outcome =
	| { readonly kind: "installed"; readonly text: string }
	| { readonly kind: "refused"; readonly tag: string; readonly text: string }

/** The installation of a schema built by `build`, every statement printed, or the CompileError its build or compile is. */
const outcomeOf = (build: () => Parameters<typeof ownedInput>[0]): Outcome => {
	const built = Result.try({ try: build, catch: (thrown) => thrown })
	if (Result.isFailure(built)) {
		const thrown = built.failure
		if (!isCompileError(thrown)) {
			throw thrown
		}
		return { kind: "refused", tag: thrown.reason._tag, text: compileReasonText(thrown.reason) }
	}
	const owned = ownedInput(built.success)
	const installed = owned.ok ? compileInstallation(owned.value, installOptions(owned.value)) : owned
	return installed.ok
		? {
				kind: "installed",
				text: Arr.join(Arr.map(installed.value.statements, printStatement), "\n")
			}
		: {
				kind: "refused",
				tag: installed.error.reason._tag,
				text: compileReasonText(installed.error.reason)
			}
}

/** A case's value as units at its scale: an exact integer's own, an amount's count of minor units. */
const unitsOf = (c: LiteralCase): { readonly units: bigint; readonly scale: number } =>
	c.door === "position"
		? { units: c.value, scale: 0 }
		: { units: c.value.minorUnits, scale: moneyFractionDigits }

/**
 * The integer digits of the type a case's literal takes, as the specification states it: an integer position's, a
 * branch's its conditional's, moneyDigits, and a comparison's any exact money, at numeric's own limit.
 */
const digitsOf = (c: LiteralCase): number => {
	if (c.door === "position") {
		return integerPositions[c.position].digits
	}
	switch (c.place) {
		case "a branch beside exact money of 2 digits":
			return moneyDigits
		case "a comparison opposite exact money of 2 digits":
			return fieldDigits
	}
}

/** A term of exact money of moneyDigits digits, `c`, and a boolean, `f`, as a query's columns. */
const moneyColumns = {
	c: { kind: "column", type: exactType("exactMoney", moneyDigits) },
	f: { kind: "column", type: plainType("bool") }
} as const

/**
 * What a case comes to: its schema built and compiled, or its amount, in a query, the otherwise of a conditional whose
 * first branch is a term of exact money of moneyDigits digits, or compared with such a term.
 */
const caseOutcome = (c: LiteralCase): Outcome => {
	if (c.door === "position") {
		return outcomeOf(() => integerPositions[c.position].schema(c.value))
	}
	const branch: ExprDesc = {
		kind: "cond",
		pred: { kind: "var", var: "f" },
		onTrue: { kind: "var", var: "c" },
		onFalse: { kind: "literal", value: c.value }
	}
	const lowered =
		c.place === "a branch beside exact money of 2 digits"
			? lowerWith("query", branch, moneyColumns, false, baseParams)
			: adoptedLiteral(c.value, exactType("exactMoney", moneyDigits))
	return lowered.ok
		? { kind: "installed", text: "" }
		: {
				kind: "refused",
				tag: lowered.error.reason._tag,
				text: compileReasonText(lowered.error.reason)
			}
}

/**
 * An integer as its position's type writes it: its digits, a negative parenthesized, cast to bigint where the type is of
 * at most 18 digits and to numeric past them.
 */
const spelled = (value: bigint, digits: number): string => {
	const sql = digits <= 18 ? "bigint" : "numeric"
	return value < 0n ? `(${value})::${sql}` : `${value}::${sql}`
}

/** A literal takes its position's exact type within its digits, and one past them is refused naming the bound. */
export const aBareLiteralTakesItsPositionsExactTypeWithinItsDigitsAndIsRefusedPastThem =
	property.exhaust(
		finite((source) => source.draw(element(nonEmpty(literalCases, "the box")))),
		{
			box: "each exact integer position of a generated field, a made value's field, a typed literal, a branch and an operand beside an exact field, a comparison opposite one, a branch, a comparison and an operand beside a sum of two integers, at 1, -7, 10^30, -(10^11 - 1), 10^11 and 10^131072; an amount in a query as a branch beside exact money of 2 digits and compared with it, at 1.25, 99.99, 100.00, money's greatest and 10^131072 units",
			needs: {},
			situations: Arr.flatMap([...integerPositionNames, ...moneyPlaces], (place: Place) =>
				Arr.map(
					["admitted", "refused past its bound"] as const,
					(verdict): Feature => `${place}, ${verdict}`
				)
			) satisfies ReadonlyArray<Reached<Feature>>,
			check: (_, c: Case<Feature>) => (literal: LiteralCase) =>
				Effect.sync(() => {
					const place = placeOf(literal)
					const digits = digitsOf(literal)
					const { units, scale } = unitsOf(literal)
					const magnitude = units < 0n ? -units : units
					const shown = `${place} at ${literal.value.toString()}`
					const outcome = caseOutcome(literal)
					if (magnitude < 10n ** BigInt(digits + scale)) {
						c.note(`${place}, admitted`)
						if (outcome.kind === "refused") {
							return assert.fail(`${shown}: admitted, not ${outcome.tag}: ${outcome.text}`)
						}
						if (literal.door === "money") {
							return
						}
						assert.ok(
							Str.includes(spelled(literal.value, digits))(outcome.text),
							`${shown}: written as itself at its position's type, ${spelled(literal.value, digits)}`
						)
						if (literal.position === "a made value's field" && magnitude < 2n ** 63n) {
							assert.deepEqual<Outcome>(
								outcome,
								outcomeOf(() => castSchema(literal.value)),
								`${shown}: the made value is the one its cast wrote`
							)
						}
						return
					}
					c.note(`${place}, refused past its bound`)
					if (outcome.kind === "installed") {
						return assert.fail(`${shown}: refused past 10^${digits}`)
					}
					assert.equal(outcome.tag, "MalformedDescription", shown)
					const named =
						literal.door === "position" && magnitude >= 10n ** BigInt(fieldDigits + scale)
							? fieldDigits
							: digits
					assert.ok(
						Str.includes(`10^${named}`)(outcome.text),
						`${shown}: the refusal names the bound 10^${named}`
					)
				}),
			oracle: {
				kind: "specification",
				name: "a literal below 10^digits of the exact type its position gives it admitted as itself at the type, one at or past it refused naming 10^digits"
			},
			kept: [
				{
					token: ReplayToken(
						"test/unit/compute/exact-literals.test.ts#aBareLiteralTakesItsPositionsExactTypeWithinItsDigitsAndIsRefusedPastThem:-:0"
					),
					reason:
						"qti-pie's ledger (lane LEDGER-VALUECELL, test-run-call.ts's numAttempts): QtiValue.make(\"integer\", { value: 1n }) over QtiValue's integer arm on exactInteger, refused as a literal of an exact value's family and written as Type.cast(Type.literal(int8, 1n), field) instead",
					since: "2026-11-27"
				}
			],
			kills: [
				{
					file: "packages/engine/src/scalar/compute/literal.ts",
					original:
						'\t\tcase "int8":\n\t\tcase "exactInteger":\n\t\t\tif (typeof value !== "bigint") {\n',
					replacement:
						'\t\tcase "exactInteger":\n\t\t\treturn Result.err("a literal of an exact value\'s family")\n\t\tcase "int8":\n\t\t\tif (typeof value !== "bigint") {\n',
					why: "A literal at an exact integer is refused again, whatever its value: the consumer's made value, 1n at QtiValue's integer field, is refused; the property fails."
				},
				{
					file: "packages/engine/src/scalar/compute/literal.ts",
					original: '\t\tcase "money":\n\t\tcase "exactMoney": {\n',
					replacement:
						'\t\tcase "exactMoney":\n\t\t\treturn Result.err("a literal of an exact value\'s family")\n\t\tcase "money": {\n',
					why: "A Money at exact money is refused again: 1.25 compared with exact money is refused; the property fails."
				},
				{
					file: "packages/engine/src/ir/expr.ts",
					original: "\tbelowPowerOfTen(units < 0n ? -units : units, digits + scale)\n",
					replacement: "\ttrue\n",
					why: "A literal past its exact type's digits is admitted: 10^11 beside a sum of two integers, and 10^131072 at an exact field, compile; the property fails."
				},
				{
					file: "packages/engine/src/ir/expr.ts",
					original: "\tbelowPowerOfTen(units < 0n ? -units : units, digits + scale)\n",
					replacement: "\tbelowPowerOfTen(units < 0n ? -units : units, digits)\n",
					why: "An amount's bound is read in minor units as if in units of money: 99.99 compared with exact money of 2 digits is refused; the property fails."
				},
				{
					file: "packages/engine/src/scalar/compute/typing.ts",
					original: "\t\treturn exactType(v.carrier, numericMaxIntegerDigits)\n",
					replacement: '\t\treturn plainType(v.carrier === "exactInteger" ? "int8" : "money")\n',
					why: "A literal opposite an exact integer term is typed at bigint again: 10^30 opposite an exact field is refused as outside bigint; the property fails."
				},
				{
					file: "packages/engine/src/scalar/compute/typing.ts",
					original: "\t\treturn exactType(v.carrier, numericMaxIntegerDigits)\n",
					replacement: "\t\treturn v\n",
					why: "A literal opposite an exact value is held to that value's digits: 10^11 compared with a sum of two integers is refused; the property fails."
				},
				{
					file: "packages/engine/src/scalar/compute/typing.ts",
					original:
						'\t\tif (desc.kind === "literal" && desc.type === undefined && isExactValue(t.nominal)) {\n',
					replacement:
						'\t\tif (desc.kind === "literal" && desc.type === undefined && !isExactValue(t.nominal)) {\n',
					why: "A conditional's literal branch beside an exact value is any exact value: 10^11 beside a sum of two integers is not refused naming its 11 digits; the property fails."
				}
			]
		}
	)
