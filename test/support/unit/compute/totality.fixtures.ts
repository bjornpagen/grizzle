/** What the properties of totality.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { PreconditionKind } from "#compiler/core/errors.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Numeric } from "#compiler/scalar/values/decimal.ts"
import {
	type LeafBinding,
	lowerWith,
	testDeclaringContract,
	type TestField,
	testPg
} from "#test/support/unit/compute/support.ts"

/**
 * The texts of numeric's drawn literals: zero, the units, a half, a large value and NaN, the one value no finite fact
 * holds of that a numeric field holds, since no numeric(p, s) holds an infinity.
 */
const decimalTexts: Arr.NonEmptyReadonlyArray<string> = [
	"0",
	"1",
	"-1",
	"2.5",
	"-0.5",
	"1e20",
	"2147483648.5",
	"NaN"
]

/** A field operands are drawn over: the test field, the literals its operands draw, and their zero. */
interface OperandField extends TestField {
	/** Zero, the units, a half, a large value and the specials. */
	readonly literals: Gen<LiteralDesc>
	/** The zero of its literals, a string for numeric's exact decimal. */
	readonly zero: number | bigint | string
}

const integerOperands: OperandField = {
	...testPg.integer,
	literals: element<LiteralDesc>([0, 1, -1, 7, 2147483647, -2147483648]),
	zero: 0
}

const bigintOperands: OperandField = {
	...testPg.bigint,
	literals: element<LiteralDesc>([0n, 1n, -1n, 7n, 2n ** 63n - 1n, -(2n ** 63n)]),
	zero: 0n
}

const numericOperands: OperandField = {
	...testPg.numeric,
	literals: element<LiteralDesc>(Arr.map(decimalTexts, (t) => Numeric.of(t))),
	zero: "0"
}

/** A partial entry over literal operands, its operands' field, and the fact of its operands it needs. */
interface Entry {
	readonly name: string
	readonly field: OperandField
	readonly needs: "nonzero" | "nonnegative" | "finite"
	/** The operand, by position, the needed fact is of. */
	readonly operand: 0 | 1
	readonly build: (a: ScalarTerm, b: ScalarTerm) => { readonly expr: OpenExpr }
}

const entries: Arr.NonEmptyReadonlyArray<Entry> = [
	{
		name: "div/integer",
		field: integerOperands,
		needs: "nonzero",
		operand: 1,
		build: (a, b) => computeCore.div(a, b)
	},
	{
		name: "mod/bigint",
		field: bigintOperands,
		needs: "nonzero",
		operand: 1,
		build: (a, b) => computeCore.mod(a, b)
	},
	{
		name: "div/numeric",
		field: numericOperands,
		needs: "nonzero",
		operand: 1,
		build: (a, b) => computeCore.div(a, b)
	},
	{
		name: "rem/numeric",
		field: numericOperands,
		needs: "nonzero",
		operand: 1,
		build: (a, b) => computeCore.rem(a, b)
	},
	{
		name: "sqrt/numeric",
		field: numericOperands,
		needs: "nonnegative",
		operand: 0,
		build: (a) => computeCore.sqrt(a)
	},
	{
		name: "minScale/numeric",
		field: numericOperands,
		needs: "finite",
		operand: 0,
		build: (a) => computeCore.minScale(a)
	},
	{
		name: "cast numeric to integer",
		field: numericOperands,
		needs: "finite",
		operand: 0,
		build: (a) => computeCore.cast(a, testPg.integer)
	}
]

/** Whether a literal violates the fact: zero for nonzero, below zero for nonnegative, NaN or an infinity for finite. */
export const violates = (value: LiteralDesc, fact: Entry["needs"]): boolean => {
	if (typeof value === "number" || typeof value === "bigint") {
		const n = BigInt(value)
		return fact === "nonzero" ? n === 0n : fact === "nonnegative" ? n < 0n : false
	}
	if (!(value instanceof Numeric)) {
		return false
	}
	const p = value.parts
	switch (fact) {
		case "nonzero":
			return p.kind === "finite" && p.coefficient === 0n
		case "nonnegative":
			return (p.kind === "finite" && p.negative && p.coefficient !== 0n) || p.kind === "-infinity"
		case "finite":
			return p.kind !== "finite"
	}
}

export const literalOf = (field: TestField, value: LiteralDesc): LeafBinding => ({
	kind: "literal",
	field,
	value
})

/** A refusal's precondition, or a defect: an entry over literals refuses only a partial operation. */
export const preconditionOf = (
	lowered: ReturnType<typeof lowerWith>,
	label: string
): PreconditionKind | undefined => {
	if (lowered.ok) {
		return undefined
	}
	const reason = lowered.error.reason
	if (reason._tag !== "PartialOperation") {
		throw new Error(`${label}: ${lowered.error.message}`)
	}
	return reason.precondition
}

/**
 * Where the operand whose fact is needed comes from: a literal, a parameter of the operands' field, or a parameter of a
 * contract over it that declares the fact.
 */
type OperandSource = "literal" | "parameter" | "declaring parameter"

const sources: Arr.NonEmptyReadonlyArray<OperandSource> = [
	"literal",
	"parameter",
	"declaring parameter"
]

export type RefusalFeature = `${string} ${"admitted" | "refused"}` | `over a ${OperandSource}`

export const refusalSituations: Arr.NonEmptyReadonlyArray<RefusalFeature> = Arr.appendAll(
	Arr.flatMap(entries, (e) => [`${e.name} admitted` as const, `${e.name} refused` as const]),
	Arr.map(sources, (s) => `over a ${s}` as const)
)

interface LiteralCase {
	readonly entry: Entry
	readonly source: OperandSource
	readonly a: LiteralDesc
	readonly b: LiteralDesc
}

export const literalCaseGen: Gen<LiteralCase> = (source) => {
	const entry = source.draw(element(entries))
	return {
		entry,
		source: source.draw(element(sources)),
		a: source.draw(entry.field.literals),
		b: source.draw(entry.field.literals)
	}
}

/** A contract over `field` whose predicate proves `fact`, which it declares. */
export const declaring = (field: OperandField, fact: Entry["needs"]): TestField =>
	testDeclaringContract(
		`Declares_${fact}_${field.sql}`,
		field,
		(x) =>
			fact === "nonzero"
				? computeCore.ne(x, field.zero)
				: fact === "nonnegative"
					? computeCore.ge(x, field.zero)
					: computeCore.between(x, "-1000000", "1000000"),
		[fact]
	)

/**
 * A guarded form over two operands, columns or parameters: the guard, the branch, the otherwise value, and what the
 * host must deliver per row.
 */
interface Guarded {
	readonly name: string
	readonly field: OperandField
	readonly build: (a: ScalarTerm, b: ScalarTerm) => { readonly expr: OpenExpr }
	readonly holds: (a: LiteralDesc, b: LiteralDesc) => boolean
}

export const guardedOperations: Arr.NonEmptyReadonlyArray<Guarded> = [
	{
		name: "a quotient under its divisor's nonzero guard",
		field: bigintOperands,
		build: (a, b) =>
			computeCore.when(computeCore.nonzero(b), (d: ScalarTerm) => computeCore.div(a, d), 0n),
		holds: (_a, b) => !violates(b, "nonzero")
	},
	{
		name: "a root under its radicand's nonnegative guard",
		field: numericOperands,
		build: (a) =>
			computeCore.when(computeCore.nonnegative(a), (x: ScalarTerm) => computeCore.sqrt(x), 0n),
		holds: (a) => !violates(a, "nonnegative")
	},
	{
		name: "a narrowing under a within guard",
		field: numericOperands,
		build: (a) =>
			computeCore.when(
				computeCore.within(a, -1000n, 1000n),
				(x: ScalarTerm) => computeCore.cast(x, testPg.integer),
				0
			),
		holds: (a) => a instanceof Numeric && a.isFinite() && Math.abs(Number(a.text)) <= 1000
	}
]

/** What a guarded form's operands are: the row's columns, or parameters the call binds. */
export type Subject = "columns" | "parameters"

export type GuardFeature = `${string}: the guard ${"holds" | "fails"}` | `over ${Subject}`

export const guardSituations: Arr.NonEmptyReadonlyArray<GuardFeature> = [
	"over columns",
	"over parameters",
	...Arr.flatMap(guardedOperations, (g) => [
		`${g.name}: the guard holds` as const,
		`${g.name}: the guard fails` as const
	])
]
