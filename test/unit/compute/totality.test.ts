import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import type { PreconditionKind } from "#compiler/core/errors.ts"
import { ParamId } from "#compiler/core/ids.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { constantEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	param,
	spelled,
	type TestField,
	testDeclaringContract,
	testPg,
	v
} from "#test/unit/compute/support.ts"

/**
 * No read raises an evaluation error: every partial operation compilation admits stands where its precondition holds,
 * and it refuses one exactly where its operands' values leave it undefined (README "No read fails on a value").
 *
 * Two oracles judge the lowering's proofs. Over literal operands, whose interval is their point, the operation's
 * definedness is read off the values themselves, independently of the bound domain: a divisor is zero or not, a
 * radicand below zero, a value NaN; compilation must refuse a case whose values violate a fact it needs
 * (PartialOperation naming that fact), admit one whose values satisfy every fact it needs, and the host evaluator must
 * never meet an undefined operation in what it admits. A refusal of a precondition that rests on magnitudes (a
 * narrowing's range) is the bound domain's residue, admitted either way. A parameter is a term of its declared type,
 * whose value compilation never sees: a partial operation over a plain one is refused for exactly the fact it needs, and
 * over one of a contract declaring that fact (which its binding checks of every value) admitted. Over columns and
 * parameters, a Compute.when guard's branch is computed exactly where the guard holds and its other value elsewhere,
 * the host evaluator judging every row.
 */

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
	literals: element<LiteralDesc>(Arr.map(decimalTexts, (t) => Decimal.of(t))),
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
		build: (a, b) => Compute.div(a, b)
	},
	{
		name: "mod/bigint",
		field: bigintOperands,
		needs: "nonzero",
		operand: 1,
		build: (a, b) => Compute.mod(a, b)
	},
	{
		name: "div/numeric",
		field: numericOperands,
		needs: "nonzero",
		operand: 1,
		build: (a, b) => Compute.div(a, b)
	},
	{
		name: "rem/numeric",
		field: numericOperands,
		needs: "nonzero",
		operand: 1,
		build: (a, b) => Compute.rem(a, b)
	},
	{
		name: "sqrt/numeric",
		field: numericOperands,
		needs: "nonnegative",
		operand: 0,
		build: (a) => Compute.sqrt(a)
	},
	{
		name: "minScale/numeric",
		field: numericOperands,
		needs: "finite",
		operand: 0,
		build: (a) => Compute.minScale(a)
	},
	{
		name: "cast numeric to integer",
		field: numericOperands,
		needs: "finite",
		operand: 0,
		build: (a) => Compute.cast(a, testPg.integer)
	}
]

/** Whether a literal violates the fact: zero for nonzero, below zero for nonnegative, NaN or an infinity for finite. */
const violates = (value: LiteralDesc, fact: Entry["needs"]): boolean => {
	if (typeof value === "number" || typeof value === "bigint") {
		const n = BigInt(value)
		return fact === "nonzero" ? n === 0n : fact === "nonnegative" ? n < 0n : false
	}
	if (!(value instanceof Decimal)) {
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

const literalOf = (field: TestField, value: LiteralDesc): LeafBinding => ({
	kind: "literal",
	field,
	value
})

/** A refusal's precondition, or a defect: an entry over literals refuses only a partial operation. */
const preconditionOf = (
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

type RefusalFeature = `${string} ${"admitted" | "refused"}` | `over a ${OperandSource}`

const refusalSituations: Arr.NonEmptyReadonlyArray<RefusalFeature> = Arr.appendAll(
	Arr.flatMap(entries, (e) => [`${e.name} admitted` as const, `${e.name} refused` as const]),
	Arr.map(sources, (s) => `over a ${s}` as const)
)

interface LiteralCase {
	readonly entry: Entry
	readonly source: OperandSource
	readonly a: LiteralDesc
	readonly b: LiteralDesc
}

const literalCaseGen: Gen<LiteralCase> = (source) => {
	const entry = source.draw(element(entries))
	return {
		entry,
		source: source.draw(element(sources)),
		a: source.draw(entry.field.literals),
		b: source.draw(entry.field.literals)
	}
}

/** A contract over `field` whose predicate proves `fact`, which it declares. */
const declaring = (field: OperandField, fact: Entry["needs"]): TestField =>
	testDeclaringContract(
		`Declares_${fact}_${field.sql}`,
		field,
		(x) =>
			fact === "nonzero"
				? x.ne(field.zero)
				: fact === "nonnegative"
					? x.ge(field.zero)
					: x.between("-1000000", "1000000"),
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

const guarded: Arr.NonEmptyReadonlyArray<Guarded> = [
	{
		name: "a quotient under its divisor's nonzero guard",
		field: bigintOperands,
		build: (a, b) => Compute.when(Compute.nonzero(b), (d: ScalarTerm) => Compute.div(a, d), 0n),
		holds: (_a, b) => !violates(b, "nonzero")
	},
	{
		name: "a root under its radicand's nonnegative guard",
		field: numericOperands,
		build: (a) => Compute.when(Compute.nonnegative(a), (x: ScalarTerm) => Compute.sqrt(x), 0n),
		holds: (a) => !violates(a, "nonnegative")
	},
	{
		name: "a narrowing under a within guard",
		field: numericOperands,
		build: (a) =>
			Compute.when(
				Compute.within(a, -1000n, 1000n),
				(x: ScalarTerm) => Compute.cast(x, testPg.integer),
				0
			),
		holds: (a) => a instanceof Decimal && a.isFinite() && Math.abs(Number(a.text)) <= 1000
	}
]

/** What a guarded form's operands are: the row's columns, or parameters the call binds. */
type Subject = "columns" | "parameters"

type GuardFeature = `${string}: the guard ${"holds" | "fails"}` | `over ${Subject}`

const guardSituations: Arr.NonEmptyReadonlyArray<GuardFeature> = [
	"over columns",
	"over parameters",
	...Arr.flatMap(guarded, (g) => [
		`${g.name}: the guard holds` as const,
		`${g.name}: the guard fails` as const
	])
]

describe("totality", () => {
	it.effect(
		"refuses a partial operation over literals exactly where their values leave it undefined",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/totality-refusal",
						draw: drawn(literalCaseGen),
						literal: Formatter.format,
						coverage: required<RefusalFeature>(refusalSituations, { cases: 600, sense: notesOnly }),
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ entry, source, a, b }, c) =>
						Effect.sync(() => {
							c.note(`over a ${source}`)
							/**
							 * The operand whose fact the operation needs: a literal, whose own value states its facts, a parameter of
							 * the field, or one of a contract declaring the fact, met as its base, which keeps the facts it declares.
							 */
							const needed =
								source === "literal"
									? Compute.literal(entry.field, entry.operand === 0 ? a : b)
									: source === "parameter"
										? param("p", entry.field)
										: Compute.base(param("p", declaring(entry.field, entry.needs)))
							const expr = (
								entry.operand === 0
									? entry.build(needed, v("b", entry.field))
									: entry.build(v("a", entry.field), needed)
							).expr
							const lowered = lowerWith(
								"query",
								spelled(expr),
								{ a: literalOf(entry.field, a), b: literalOf(entry.field, b) },
								false,
								baseParams
							)
							const refused = preconditionOf(lowered, entry.name)
							c.note(`${entry.name} ${refused === undefined ? "admitted" : "refused"}`)
							if (source === "parameter") {
								assert.equal(refused, entry.needs, `${entry.name} over a parameter of no fact`)
								return
							}
							if (source === "declaring parameter") {
								assert.ok(
									refused === undefined || refused === "fits",
									`${entry.name} over a parameter declaring ${entry.needs}: refused for ${String(refused)}`
								)
								return
							}
							const violated = violates(entry.operand === 0 ? a : b, entry.needs)
							if (violated) {
								assert.equal(
									refused,
									entry.needs,
									`${entry.name} over values violating ${entry.needs}`
								)
								return
							}
							if (lowered.ok) {
								const host = evaluate(lowered.value.root.expr, constantEnv)
								assert.ok(
									Result.isSuccess(host) || host.failure.kind !== "undefined",
									`${entry.name}: an admitted operation the host finds undefined`
								)
								return
							}
							assert.equal(
								refused,
								"fits",
								`${entry.name}: refused for ${String(refused)} over values its tags admit`
							)
						})
				)
			)
	)

	it.effect(
		"computes a guard's branch exactly where the guard holds, over columns and parameters",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/totality-guards",
						draw: drawn((source) => {
							const form = source.draw(element(guarded))
							return {
								form,
								subject: source.draw(element<Subject>(["columns", "parameters"])),
								a: source.draw(form.field.literals),
								b: source.draw(form.field.literals)
							}
						}),
						literal: Formatter.format,
						coverage: required<GuardFeature>(guardSituations, { cases: 300, sense: notesOnly }),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ form, subject, a, b }, c) =>
						Effect.sync(() => {
							c.note(`over ${subject}`)
							const columns = {
								a: { kind: "column", type: form.field.scalar } as const,
								b: { kind: "column", type: form.field.scalar } as const
							}
							const operand = (name: string) =>
								subject === "parameters" ? param(name, form.field) : v(name, form.field)
							const term = form.build(operand("a"), operand("b")).expr
							const lowered = lowerWith("query", spelled(term), columns, false, baseParams)
							assert.ok(lowered.ok, `${form.name} compiles over ${subject}`)
							const literal = (x: LiteralDesc) =>
								lowerWith(
									"query",
									spelled(v("a", form.field).expr),
									{ a: literalOf(form.field, x) },
									false,
									baseParams
								)
							const [la, lb] = [literal(a), literal(b)]
							if (!la.ok || !lb.ok) {
								return
							}
							const values = [
								evaluate(la.value.root.expr, constantEnv),
								evaluate(lb.value.root.expr, constantEnv)
							]
							const [va, vb] = values
							if (
								va === undefined ||
								vb === undefined ||
								!Result.isSuccess(va) ||
								!Result.isSuccess(vb)
							) {
								return
							}
							const row = evaluate(lowered.value.root.expr, {
								kind: "row",
								column: (ref) =>
									ref.name === "a" ? va.success : ref.name === "b" ? vb.success : undefined,
								param: (id) =>
									id === ParamId("a") ? va.success : id === ParamId("b") ? vb.success : undefined,
								regexMember: () => false
							})
							const holds = form.holds(a, b)
							c.note(`${form.name}: the guard ${holds ? "holds" : "fails"}`)
							assert.ok(
								Result.isSuccess(row) || row.failure.kind !== "undefined",
								`${form.name}: the host meets an undefined operation`
							)
							if (!holds) {
								assert.ok(
									Result.isSuccess(row),
									`${form.name}: the other value where the guard fails`
								)
							}
						})
				)
			)
	)
})
