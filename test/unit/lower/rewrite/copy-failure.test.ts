import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { NodeId } from "#compiler/core/ids.ts"
import { emptyDag } from "#compiler/ir/dag.ts"
import { OpId, type ScalarExpr } from "#compiler/ir/expr.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import { assert } from "#test/support/assert.ts"

/**
 * A rewrite that substitutes an expression for a column reference keeps the failure behavior honest: an operator over an
 * operand that can fail can fail too, and predicate order never proves it safe.
 */

type Failure = "total" | "canFail"
type Volatility = "immutable" | "stable"

/**
 * One copy: the marks of the expression substituted for the column, the marks every operator of the copied tree
 * states itself, how many operators stand over the column, and whether the column is substituted at all.
 */
interface Copy {
	readonly substitute: { readonly failure: Failure; readonly volatility: Volatility }
	readonly own: { readonly failure: Failure; readonly volatility: Volatility }
	readonly depth: 1 | 2
	readonly substituted: boolean
}

const marks: Gen<Copy["own"]> = (source) => ({
	failure: source.draw(element<Failure>(["total", "canFail"])),
	volatility: source.draw(element<Volatility>(["immutable", "stable"]))
})

const copies: Gen<Copy> = (source) => ({
	substitute: source.draw(marks),
	own: source.draw(marks),
	depth: source.draw(element<1 | 2>([1, 2])),
	substituted: source.draw(boolean)
})

/**
 * What the copies reach: a copy whose marks the substituted operand raised, one that kept its own, and one that
 * changed nothing.
 */
type CopyFeature = "raised by the operand" | "kept its own marks" | "nothing substituted"

describe("DagEditor.copyExpr", () => {
	it.effect("marks a copied operator canFail and stable when a substituted operand is", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/lower/rewrite/copy-failure",
					generator: copies,
					literal: Formatter.format,
					limit: 64,
					features: features<CopyFeature>([
						"raised by the operand",
						"kept its own marks",
						"nothing substituted"
					]),
					caseHang: Duration.minutes(2)
				},
				(copy, c) =>
					Effect.sync(() => {
						const ed = new DagEditor(emptyDag)
						const int2 = plainType("int2")
						const column = ed.expr({
							kind: "column",
							column: { node: NodeId("n1"), name: "y0" },
							args: [],
							type: int2,
							nonNull: "storage"
						})
						/**
						 * The operators over the column, innermost first, each stating `copy.own`'s marks: a comparison with
						 * zero, then its negation.
						 */
						const zero = ed.expr({
							kind: "literal",
							value: { kind: "int", value: 0n },
							args: [],
							type: int2,
							nonNull: "literal"
						})
						const operator = (op: string, args: ReadonlyArray<ScalarExpr>): ScalarExpr =>
							ed.expr({
								kind: "op",
								op: OpId(op),
								args,
								type: plainType("bool"),
								nonNull: "strict",
								volatility: copy.own.volatility,
								failure: copy.own.failure
							})
						const eq = operator("int2eq", [column, zero])
						const top = copy.depth === 1 ? eq : operator("not", [eq])
						const narrowed = ed.expr({
							kind: "cast",
							checked: copy.substitute.failure === "canFail",
							args: [
								ed.expr({
									kind: "column",
									column: { node: NodeId("n2"), name: "a" },
									args: [],
									type: plainType("int4"),
									nonNull: "storage"
								})
							],
							type: int2,
							nonNull: "strict",
							volatility: copy.substitute.volatility
						})
						const copied = ed.copyExpr(top, (ref) =>
							copy.substituted && ref.name === "y0" ? narrowed : undefined
						)
						if (!copy.substituted) {
							c.note("nothing substituted")
							assert.equal(copied, top)
							return
						}
						/**
						 * The documented rule: every operator of the copy is canFail when it or an operand below it can fail,
						 * and stable when it or an operand below it is.
						 */
						const failure: Failure =
							copy.own.failure === "canFail" || copy.substitute.failure === "canFail"
								? "canFail"
								: "total"
						const volatility: Volatility =
							copy.own.volatility === "stable" || copy.substitute.volatility === "stable"
								? "stable"
								: "immutable"
						c.note(
							failure === copy.own.failure && volatility === copy.own.volatility
								? "kept its own marks"
								: "raised by the operand"
						)
						assert.notEqual(copied, top)
						assert.equal(copied.failure, failure)
						assert.equal(copied.volatility, volatility)
					})
			)
		)
	)
})
