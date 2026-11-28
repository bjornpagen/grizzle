/**
 * What the properties of conjunct.test.ts read: its selections an equality decides, each lowered, its conditionals with
 * a constant arm, its sharing, and the host's value of a term at each row.
 */

import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Formatter, Option } from "effect"
import { admittedFunctionDigest } from "#compiler/core/fingerprint.ts"
import { NodeId } from "#compiler/core/ids.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import {
	exprClosure,
	type OpId,
	predicateTable,
	type ScalarExpr,
	storedColumn
} from "#compiler/ir/expr.ts"
import { FieldTexts, sharedExpr } from "#compiler/lower/conservative/expr/share.ts"
import { compiledExpr, sqlNull, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { connectiveOps, definedIdOf, overloadOf } from "#compiler/scalar/compute/registry.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	baseParams,
	lowerWith,
	plainRender,
	renderSql,
	type Sink,
	sink,
	testPg
} from "#test/support/unit/compute/support.ts"

/**
 * A selection an equality of a column to a literal decides, the equality first and read again below it, so the
 * sharing splits on it: before a disjunction of conjunctions one of which reads it again, before a disjunction it
 * decides true, and before a conjunction that reads it again.
 */
export const shapes = [
	"before a disjunction reading it",
	"before a disjunction it decides",
	"before a conjunction reading it"
] as const
export type Shape = (typeof shapes)[number]

const column = { kind: "column", type: testPg.smallint.scalar } as const

const eq = (field: "kind" | "base", value: number): ExprDesc => ({
	kind: "compare",
	op: "eq",
	left: { kind: "var", var: field },
	right: { kind: "literal", value }
})

/** The selection of `shape`, `kind = 633` first. */
const selectionOf = (shape: Shape): ExprDesc => {
	const decides = eq("kind", 633)
	switch (shape) {
		case "before a disjunction reading it":
			return {
				kind: "and",
				args: [
					decides,
					{
						kind: "or",
						args: [
							{ kind: "and", args: [eq("base", 11), eq("kind", 617)] },
							{ kind: "and", args: [eq("base", 392), eq("kind", 633)] }
						]
					}
				]
			}
		case "before a disjunction it decides":
			return {
				kind: "and",
				args: [decides, { kind: "or", args: [eq("kind", 633), eq("base", 1)] }]
			}
		case "before a conjunction reading it":
			return {
				kind: "and",
				args: [
					decides,
					{
						kind: "or",
						args: [{ kind: "and", args: [eq("base", 2), eq("kind", 633)] }, eq("base", 3)]
					}
				]
			}
	}
}

/** The selection of `shape` as a query lowers it over two smallint columns, shared as every lowering shares a term. */
export const shared = (shape: Shape): ScalarExpr =>
	sharedExpr(
		succeeded(
			lowerWith("query", selectionOf(shape), { kind: column, base: column }, true, baseParams),
			`the selection ${shape} lowers in a query`
		).root.expr,
		{ closed: new Map(), host: () => undefined, size: () => 0, texts: new FieldTexts() }
	)

/** Whether `e` holds a conditional anywhere. */
export const holdsConditional = (e: ScalarExpr): boolean =>
	Arr.some(exprClosure([e]), (x) => x.kind === "cond")

/** `e`'s SQL, as a query prints it. */
export const selectionSql = (e: ScalarExpr): string => renderSql(e, plainRender)

/**
 * The three terms no connective form holds: one whose deciding subterm may be NULL, `R.f(kind) = 633`, a closed read
 * at a key the relation may hold no tuple at, which the sharing never splits on (#nonNullAt); one whose held arm calls a
 * declared function, which may raise, so the split keeps its conditional (#raisesAt); and a check's refusal of that
 * predicate, `cond(R.f(kind) = 633, false, true)`, which is true where the read is NULL, as NOT of it is not. The first
 * two are built as the IR holds them, the subterm read twice: `s AND (b = 2 AND s OR b = 3)`, and `s AND CASE WHEN s
 * THEN f(b) ELSE b = 3 END`, whose arm where s fails is false and whose arm where it holds is the call.
 */
export const negatives = [
	"a subterm that may be NULL",
	"a held arm that calls a function",
	"a refusal of a predicate that may be NULL"
] as const
export type Negative = (typeof negatives)[number]

const int2 = plainType("int2")
const bool = plainType("bool")

/** `left = right` over smallints, as the IR holds it. */
const eqOver = (out: Sink, left: ScalarExpr, right: ScalarExpr): ScalarExpr =>
	out.emit({
		kind: "op",
		op: defined(
			definedIdOf(defined(overloadOf("eq", ["int2", "int2"]), "smallint's =")),
			"a defined ="
		),
		args: [left, right],
		type: bool,
		nonNull: "strict",
		volatility: "immutable"
	})

/** A connective over its operands, as the IR holds it. */
const connective = (
	out: Sink,
	c: "and" | "or" | "not",
	args: ReadonlyArray<ScalarExpr>
): ScalarExpr =>
	out.emit({
		kind: "op",
		op: connectiveOps[c],
		args,
		type: bool,
		nonNull: "strict",
		volatility: "immutable"
	})

const smallint = (out: Sink, value: bigint): ScalarExpr =>
	out.emit({
		kind: "literal",
		value: { kind: "int", value },
		args: [],
		type: int2,
		nonNull: "literal"
	})

/** The selection of `negative`, built, before the sharing. */
export const negativeTerm = (negative: Negative): ScalarExpr => {
	const out = sink()
	const row = NodeId("row")
	const kind = out.emit(storedColumn(row, "kind", int2))
	const base = out.emit(storedColumn(row, "base", int2))
	const subject =
		negative !== "a held arm that calls a function"
			? eqOver(
					out,
					out.emit({
						kind: "closedAt",
						relation: "R",
						field: "f",
						args: [kind],
						type: int2,
						nonNull: "absentRefused"
					}),
					smallint(out, 633n)
				)
			: eqOver(out, kind, smallint(out, 633n))
	if (negative === "a refusal of a predicate that may be NULL") {
		return cond(out, subject, truth(out, false), truth(out, true))
	}
	if (negative === "a subterm that may be NULL") {
		return connective(out, "and", [
			subject,
			connective(out, "or", [
				connective(out, "and", [eqOver(out, base, smallint(out, 2n)), subject]),
				eqOver(out, base, smallint(out, 3n))
			])
		])
	}
	const call = out.emit({
		kind: "call",
		function: { name: "f", volatility: "immutable", definition: admittedFunctionDigest("f") },
		params: [int2],
		args: [base],
		type: bool,
		nonNull: "returned",
		volatility: "immutable"
	})
	return connective(out, "and", [
		subject,
		out.emit({
			kind: "cond",
			args: [subject, call, eqOver(out, base, smallint(out, 3n))],
			type: bool,
			nonNull: "cond"
		})
	])
}

/** `e` shared as every lowering shares a term, over no closed relation. */
export const sharedTerm = (e: ScalarExpr): ScalarExpr =>
	sharedExpr(e, {
		closed: new Map(),
		host: () => undefined,
		size: () => 0,
		texts: new FieldTexts()
	})

/** How many times `e`'s tree reads a closed relation, each read counted where it stands. */
export const closedReads = (e: ScalarExpr): number =>
	(e.kind === "closedAt" ? 1 : 0) + Arr.reduce(e.args, 0, (n, a) => n + closedReads(a))

/** A boolean literal, as the IR holds it. */
const truth = (out: Sink, value: boolean): ScalarExpr =>
	out.emit({
		kind: "literal",
		value: { kind: "bool", value },
		args: [],
		type: bool,
		nonNull: "literal"
	})

/** A conditional over booleans, as the IR holds it. */
const cond = (out: Sink, c: ScalarExpr, t: ScalarExpr, f: ScalarExpr): ScalarExpr =>
	out.emit({ kind: "cond", args: [c, t, f], type: bool, nonNull: "cond" })

/** `NOT x`, as the IR holds it. */
const negation = (out: Sink, x: ScalarExpr): ScalarExpr => connective(out, "not", [x])

/**
 * The conditionals with a constant arm, one per entry of share.ts constantArms, each over the condition `kind = 633`
 * and the other arm `base = 3`, never NULL; and a check's refusal of a predicate never NULL, `cond(p, false, true)`
 * over `p = NOT (kind = 633 AND base = 3 OR kind = 1 AND base = 4)` (ir/desc.ts refusalCondition), a check's predicate
 * that negates a disjunction of key pairs, as edullm's Media type does.
 */
export const constantArmShapes = [
	"cond(s, true, e)",
	"cond(s, false, e)",
	"cond(s, t, false)",
	"cond(s, t, true)",
	"a refusal of a predicate never NULL"
] as const
export type ConstantArmShape = (typeof constantArmShapes)[number]

/** The connective each shape is: its top-level operation once shared, and whether its condition stands negated in it. */
export const connectiveOfShape = {
	"cond(s, true, e)": { op: "or", negated: false },
	"cond(s, false, e)": { op: "and", negated: true },
	"cond(s, t, false)": { op: "and", negated: false },
	"cond(s, t, true)": { op: "or", negated: true },
	"a refusal of a predicate never NULL": { op: "or", negated: false }
} as const satisfies Record<
	ConstantArmShape,
	{ readonly op: "and" | "or"; readonly negated: boolean }
>

/** The term of `shape`, built as the IR holds it, before the sharing. */
export const constantArmTerm = (shape: ConstantArmShape): ScalarExpr => {
	const out = sink()
	const row = NodeId("row")
	const kind = out.emit(storedColumn(row, "kind", int2))
	const base = out.emit(storedColumn(row, "base", int2))
	const s = eqOver(out, kind, smallint(out, 633n))
	const e = eqOver(out, base, smallint(out, 3n))
	switch (shape) {
		case "cond(s, true, e)":
			return cond(out, s, truth(out, true), e)
		case "cond(s, false, e)":
			return cond(out, s, truth(out, false), e)
		case "cond(s, t, false)":
			return cond(out, s, e, truth(out, false))
		case "cond(s, t, true)":
			return cond(out, s, e, truth(out, true))
		case "a refusal of a predicate never NULL": {
			const pairs = connective(out, "or", [
				connective(out, "and", [s, e]),
				connective(out, "and", [
					eqOver(out, kind, smallint(out, 1n)),
					eqOver(out, base, smallint(out, 4n))
				])
			])
			return cond(out, negation(out, pairs), truth(out, false), truth(out, true))
		}
	}
}

/** The operator at the top of `e`, if it is an operation: the connective a reduced conditional is. */
const operatorOf = (e: ScalarExpr | undefined): OpId | undefined =>
	e?.kind === "op" ? e.op : undefined

/** The operator at the top of `e` and its first operand's, each undefined where it is no operation. */
export const topOf = (
	e: ScalarExpr
): { readonly op: OpId | undefined; readonly first: OpId | undefined } => ({
	op: operatorOf(e),
	first: operatorOf(Arr.head(e.args).pipe(Option.getOrUndefined))
})

/** The rows a term's value is compared at: `kind` at 633, 1 and 7, `base` at 3 and 4, R.f(kind) 633 at kind 633 alone. */
export const rows: ReadonlyArray<{ readonly kind: number; readonly base: number }> = Arr.flatMap(
	[633, 1, 7],
	(kind) => Arr.map([3, 4], (base) => ({ kind, base }))
)

/**
 * The host's value of `e` at `row`, as text (scalar/compute/evaluate.ts): true, false, NULL, or why it has none; R.f
 * holds 633 at kind 633 and no tuple elsewhere, so its read is NULL there.
 */
export const hostValue = (
	e: ScalarExpr,
	row: { readonly kind: number; readonly base: number }
): string => {
	const table = predicateTable(e)
	const value = compiledExpr(table)(
		{
			value: undefined,
			column: (ref) =>
				ref.name === "kind" ? row.kind : ref.name === "base" ? row.base : undefined,
			closed: () => (row.kind === 633 ? 633 : sqlNull),
			param: noParamLeaf
		},
		ProgramPatterns.of(tablePatterns(table))
	)
	return value.ok ? (value.value === sqlNull ? "NULL" : Formatter.format(value.value)) : "no value"
}
