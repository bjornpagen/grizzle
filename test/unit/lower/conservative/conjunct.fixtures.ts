/** What the property of conjunct.test.ts reads: its selections an equality decides, each lowered, and its sharing. */

import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr } from "effect"
import { admittedFunctionDigest } from "#compiler/core/fingerprint.ts"
import { NodeId } from "#compiler/core/ids.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { exprClosure, type ScalarExpr, storedColumn } from "#compiler/ir/expr.ts"
import { sharedExpr } from "#compiler/lower/conservative/expr/share.ts"
import { connectiveOps, definedIdOf, overloadOf } from "#compiler/scalar/compute/registry.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	baseParams,
	lowerWith,
	plainRender,
	renderSql,
	type Sink,
	sink,
	testPg
} from "#test/unit/compute/support.ts"

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
		{ closed: new Map(), host: () => undefined, size: () => 0 }
	)

/** Whether `e` holds a conditional anywhere. */
export const holdsConditional = (e: ScalarExpr): boolean =>
	Arr.some(exprClosure([e]), (x) => x.kind === "cond")

/** `e`'s SQL, as a query prints it. */
export const selectionSql = (e: ScalarExpr): string => renderSql(e, plainRender)

/**
 * The two selections no conjunct form holds: one whose deciding subterm may be NULL, `R.f(kind) = 633`, a closed read
 * at a key the relation may hold no tuple at, which the sharing never splits on (#nonNullAt); and one whose held arm
 * calls a declared function, which may raise, so the split keeps its conditional (#raisesAt). Each is built as the IR
 * holds it, the subterm read twice: `s AND (b = 2 AND s OR b = 3)`, and `s AND CASE WHEN s THEN f(b) ELSE b = 3 END`,
 * whose arm where s fails is false and whose arm where it holds is the call.
 */
export const negatives = ["a subterm that may be NULL", "a held arm that calls a function"] as const
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
const connective = (out: Sink, c: "and" | "or", args: ReadonlyArray<ScalarExpr>): ScalarExpr =>
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
		negative === "a subterm that may be NULL"
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
	sharedExpr(e, { closed: new Map(), host: () => undefined, size: () => 0 })

/** How many times `e`'s tree reads a closed relation, each read counted where it stands. */
export const closedReads = (e: ScalarExpr): number =>
	(e.kind === "closedAt" ? 1 : 0) + Arr.reduce(e.args, 0, (n, a) => n + closedReads(a))
