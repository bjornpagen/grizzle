import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, constant, element, type Gen, recursive } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { ExprId, NodeId } from "#compiler/core/ids.ts"
import { builtExpr, type ScalarExpr } from "#compiler/ir/expr.ts"
import { ieeeForm } from "#compiler/lower/conservative/expr/total.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { col } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { assert, assertVariant } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { definedOpOf } from "#test/support/oracle/gen/ops.ts"

type Carrier = "float4" | "float8"

type FloatOp = "add" | "sub" | "mul" | "div" | "sqrt"

/**
 * A nested float expression: a column, a column whose scope binds it to another expression's SQL (a correlated
 * variable's value, a parent's key: an IR leaf whose SQL is compound), or an IEEE 754 operation over sketches.
 */
type Sketch =
	| { readonly kind: "column" }
	| { readonly kind: "bound"; readonly to: Sketch }
	| { readonly kind: "op"; readonly op: FloatOp; readonly args: ReadonlyArray<Sketch> }

interface Case {
	readonly carrier: Carrier
	readonly tree: Sketch
}

const overloads: { readonly [C in Carrier]: Readonly<Partial<Record<FloatOp, string>>> } = {
	float8: {
		add: "float8pl",
		sub: "float8mi",
		mul: "float8mul",
		div: "float8div",
		sqrt: "sqrt(double precision)"
	},
	float4: { add: "float4pl", sub: "float4mi", mul: "float4mul", div: "float4div" }
}

const opsOf = (carrier: Carrier): Arr.NonEmptyReadonlyArray<FloatOp> =>
	carrier === "float8" ? ["add", "sub", "mul", "div", "sqrt"] : ["add", "sub", "mul", "div"]

const column: Sketch = { kind: "column" }

const sketchGen = (carrier: Carrier): Gen<Sketch> =>
	recursive<Sketch>(
		constant(column),
		(inner) => (source) => {
			if (source.draw(boolean)) {
				return { kind: "bound", to: inner(source) }
			}
			const op = source.draw(element(opsOf(carrier)))
			return {
				kind: "op",
				op,
				args: op === "sqrt" ? [inner(source)] : [inner(source), inner(source)]
			}
		},
		5
	)

const caseGen: Gen<Case> = (source) => {
	const carrier = source.draw(element(["float8", "float4"] as const))
	return { carrier, tree: source.draw(sketchGen(carrier)) }
}

/** A sketch's SQL as the conservative lowering renders it, with the operations and column leaves it unfolds to. */
interface Rendered {
	readonly ir: ScalarExpr
	readonly sql: Expr
	readonly ops: number
	readonly leaves: number
}

const atom: Expr = col("r0", "c1")

/**
 * A guarded IEEE 754 operation over `args`, its node and its SQL, through the one choice every renderer makes (total.ts
 * ieeeForm).
 */
const operation = (
	carrier: Carrier,
	op: FloatOp,
	args: ReadonlyArray<Rendered>,
	id: number
): { readonly node: ScalarExpr; readonly sql: Expr } => {
	const overload = overloads[carrier][op]
	assert.ok(overload !== undefined, `an overload of ${op} over ${carrier}`)
	const node = builtExpr(
		{
			kind: "op",
			op: definedOpOf(overload),
			args: Arr.map(args, (a) => a.ir),
			type: plainType(carrier),
			nonNull: "strict",
			volatility: "immutable"
		},
		ExprId(`e#${id}`)
	)
	assertVariant(node, "kind", "op")
	const form = ieeeForm(
		node,
		Arr.map(args, (a) => a.sql)
	)
	assert.ok(form?.kind === "guarded" && form.sql !== undefined, `the guarded form of ${overload}`)
	return { node, sql: form.sql }
}

const render = (carrier: Carrier, tree: Sketch): Rendered => {
	let next = 0
	const fresh = (): number => {
		next += 1
		return next
	}
	const leaf = (): ScalarExpr => {
		const id = fresh()
		return builtExpr(
			{
				kind: "column",
				column: { node: NodeId("n#0"), name: `x${id}` },
				args: [],
				type: plainType(carrier),
				nonNull: "storage"
			},
			ExprId(`e#${id}`)
		)
	}
	const go = (s: Sketch): Rendered => {
		switch (s.kind) {
			case "column":
				return { ir: leaf(), sql: atom, ops: 0, leaves: 1 }
			case "bound":
				return { ...go(s.to), ir: leaf() }
			case "op": {
				const args = Arr.map(s.args, go)
				const { node, sql } = operation(carrier, s.op, args, fresh())
				return {
					ir: node,
					sql,
					ops: 1 + Arr.reduce(args, 0, (n, a) => n + a.ops),
					leaves: Arr.reduce(args, 0, (n, a) => n + a.leaves)
				}
			}
		}
	}
	return go(tree)
}

const bytes = (e: Expr): number => printExpr(e).length

/**
 * The most text one operation's form adds beyond its operands' own, over every operation of the width: over column
 * operands, which it names inline, and over compound ones, which it binds once.
 */
const formCost = (carrier: Carrier): number => {
	const compound: Expr = { kind: "negate", expr: atom }
	const costs = Arr.flatMap(opsOf(carrier), (op) =>
		Arr.map([atom, compound], (operand) => {
			const one: Rendered = { ...render(carrier, column), sql: operand }
			const operands = op === "sqrt" ? [one] : [one, one]
			return bytes(operation(carrier, op, operands, 0).sql) - operands.length * bytes(operand)
		})
	)
	return Arr.reduce(costs, 0, Math.max)
}

const costs: { readonly [C in Carrier]: number } = {
	float8: formCost("float8"),
	float4: formCost("float4")
}

type Feature = "an operation over an operation" | "an operand bound to a compound expression"

const features = (tree: Sketch): ReadonlyArray<Feature> => {
	switch (tree.kind) {
		case "column":
			return []
		case "bound":
			return features(tree.to)
		case "op":
			return [
				...Arr.flatMap(tree.args, (a): ReadonlyArray<Feature> =>
					a.kind === "op"
						? ["an operation over an operation"]
						: a.kind === "bound" && a.to.kind === "op"
							? ["an operand bound to a compound expression"]
							: []
				),
				...Arr.flatMap(tree.args, features)
			]
	}
}

/** Planted: the shape a pipeline case reached, sums over a column bound to a sum, two levels deep, over real. */
const twoStages: Kept<Case, Feature> = {
	note: "sums of a column bound to a sum of a column bound to a sum",
	sketch: {
		carrier: "float4",
		tree: {
			kind: "op",
			op: "add",
			args: [
				{
					kind: "bound",
					to: {
						kind: "op",
						op: "add",
						args: [{ kind: "bound", to: { kind: "op", op: "add", args: [column, column] } }, column]
					}
				},
				column
			]
		}
	},
	draws: "",
	reaches: ["an operand bound to a compound expression"]
}

describe("IEEE 754 forms", () => {
	it.effect(
		"render a nested float expression in SQL whose size is linear in its operations: each operand's text once",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/lower/conservative/ieee-linear",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							["an operation over an operation", "an operand bound to a compound expression"],
							{ cases: 100, sense: notesOnly }
						),
						kept: [twoStages],
						/** Half of each level's steps are bindings and half operations, so both features come up within a few cases. */
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ carrier, tree }, c) =>
						Effect.sync(() => {
							for (const f of features(tree)) {
								c.note(f)
							}
							const r = render(carrier, tree)
							const limit = costs[carrier] * r.ops + bytes(atom) * r.leaves
							assert.ok(
								bytes(r.sql) <= limit,
								`${bytes(r.sql)} bytes for ${r.ops} operations over ${r.leaves} columns, at most ${limit}`
							)
						})
				)
			)
	)
})
