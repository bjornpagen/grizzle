/**
 * No read raises an evaluation error: every partial operation compilation admits stands where its precondition holds,
 * and it refuses one exactly where its operands' values leave it undefined (docs/reads-and-writes.md "No read fails on a value").
 *
 * Two oracles judge the lowering's proofs. Over literal operands, whose interval is their point, the operation's
 * definedness is read off the values themselves, independently of the bound domain: a divisor is zero or not, a
 * radicand below zero, a value NaN; compilation must refuse a case whose values violate a fact it needs
 * (PartialOperation naming that fact), admit one whose values satisfy every fact it needs, and the host evaluator must
 * never meet an undefined operation in what it admits. A refusal of a precondition that rests on magnitudes (a
 * narrowing's range) is the bound domain's residue, admitted either way. A parameter is a term of its declared type,
 * whose value compilation never sees: a partial operation over a plain one is refused for exactly the fact it needs, and
 * over one of a contract declaring that fact (which its binding checks of every value) admitted. Over columns and
 * parameters, a computeCore.when guard's branch is computed exactly where the guard holds and its other value elsewhere,
 * the host evaluator judging every row.
 *
 * Features: each operation over a literal, a parameter and a declaring parameter, admitted and refused; each guarded
 * form over columns and parameters, its guard holding and failing.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Result } from "effect"
import { ParamId } from "#compiler/core/ids.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { constantEnv, evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { baseParams, lowerWith, param, spelledExpr, v } from "#test/support/unit/compute/support.ts"
import {
	declaring,
	guardedOperations,
	type GuardFeature,
	guardSituations,
	literalCaseGen,
	literalOf,
	preconditionOf,
	type RefusalFeature,
	refusalSituations,
	type Subject,
	violates
} from "#test/support/unit/compute/totality.fixtures.ts"

/** Totality refuses a partial operation over literals exactly where their values leave it undefined. Its budget is its suite's before it was a property (test/unit/compute/totality.test.ts at 4ca3036a): 600 runs and 600 steered cases. */
export const totalityRefusesAPartialOperationOverLiteralsExactlyWhereTheirValuesLeaveItUndefined =
	property.explore(literalCaseGen, {
		needs: {},
		budget: { runs: 600, steered: 600 },
		situations: refusalSituations satisfies ReadonlyArray<Reached<RefusalFeature>>,
		check:
			(_, c: Case<RefusalFeature>) =>
			({ entry, source, a, b }) =>
				Effect.sync(() => {
					c.note(`over a ${source}`)
					/**
					 * The operand whose fact the operation needs: a literal, whose own value states its facts, a parameter of
					 * the field, or one of a contract declaring the fact, met as its base, which keeps the facts it declares.
					 */
					const needed =
						source === "literal"
							? computeCore.literal(entry.field, entry.operand === 0 ? a : b)
							: source === "parameter"
								? param("p", entry.field)
								: computeCore.base(param("p", declaring(entry.field, entry.needs)))
					const expr = (
						entry.operand === 0
							? entry.build(needed, v("b", entry.field))
							: entry.build(v("a", entry.field), needed)
					).expr
					const lowered = lowerWith(
						"query",
						spelledExpr(expr),
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
						assert.equal(refused, entry.needs, `${entry.name} over values violating ${entry.needs}`)
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
				}),
		oracle: {
			kind: "specification",
			name: "each operation's definedness read off its literal operands' own values"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\t\t\tconst sign = value.units < 0n ? -1 : value.units > 0n ? 1 : 0",
				replacement: "\t\t\tconst sign = value.units < 0n ? -1 : value.units >= 0n ? 1 : 0",
				why: "A literal's facts take a zero value as nonzero, its point interval reaching zero, so a literal zero divisor is admitted; the literals' property fails."
			}
		]
	})

/** Totality computes a guard's branch exactly where the guard holds, over columns and parameters. Its budget is its suite's before it was a property (test/unit/compute/totality.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const totalityComputesAGuardsBranchExactlyWhereTheGuardHoldsOverColumnsAndParameters =
	property.explore(
		(source) => {
			const form = source.draw(element(guardedOperations))
			return {
				form,
				subject: source.draw(element<Subject>(["columns", "parameters"])),
				a: source.draw(form.field.literals),
				b: source.draw(form.field.literals)
			}
		},
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: guardSituations satisfies ReadonlyArray<Reached<GuardFeature>>,
			check:
				(_, c: Case<GuardFeature>) =>
				({ form, subject, a, b }) =>
					Effect.sync(() => {
						c.note(`over ${subject}`)
						const columns = {
							a: { kind: "column", type: form.field.scalar } as const,
							b: { kind: "column", type: form.field.scalar } as const
						}
						const operand = (name: string) =>
							subject === "parameters" ? param(name, form.field) : v(name, form.field)
						const term = form.build(operand("a"), operand("b")).expr
						const lowered = lowerWith("query", spelledExpr(term), columns, false, baseParams)
						assert.ok(lowered.ok, `${form.name} compiles over ${subject}`)
						const literal = (x: LiteralDesc) =>
							lowerWith(
								"query",
								spelledExpr(v("a", form.field).expr),
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
					}),
			oracle: {
				kind: "second-implementation",
				name: "the reference evaluator over each row (test/support/oracle/evaluate/catalog.ts)"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/compute/typing.ts",
					original: "\t\treturn this.conditional(guard.predicate, onTrue, onFalse, at)",
					replacement: "\t\treturn this.conditional(guard.predicate, onFalse, onTrue, at)",
					why: "A computeCore.when lowers its branches swapped, so the guard's branch is computed where the guard fails; the guarded forms' property fails."
				}
			]
		}
	)
