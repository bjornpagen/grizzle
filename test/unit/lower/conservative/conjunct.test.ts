/**
 * A boolean conditional over a condition never NULL with an arm that is a constant is its connective
 * (lower/conservative/expr/share.ts #cond, constantArms), built in the one place every conditional of a shared term is
 * built: `cond(s, true, e)` is `s OR e`, `cond(s, false, e)` is `NOT s AND e`, `cond(s, t, false)` is `s AND t`, and
 * `cond(s, t, true)` is `NOT s OR t`. So a check's refusal of a predicate never NULL, `cond(p, false, true)` (ir/desc.ts
 * refusalCondition), is `NOT p`, whose equalities PostgreSQL reads as index conditions where `CASE WHEN p THEN false
 * ELSE true END` hid them; and where the sharing splits a boolean on a subterm it reads twice and the split's arm where
 * the subterm fails is false, the split is `subterm AND (the rest where it holds)`, the equality a top-level conjunct.
 * A conditional is written only where no connective form exists: a condition that may be NULL, or an arm that raises.
 *
 * - Over each selection an equality decides (conjunct.fixtures.ts shapes), `kind = 633` first and read again below it,
 *   lowered as a query lowers it and shared: the shared term holds no conditional, and its SQL begins with the equality.
 * - Over each conditional with a constant arm (constantArmShapes), one per entry of the table, and a refusal: the shared
 *   term holds no conditional, its top-level connective is the table's, its condition negated where the table says,
 *   and its value at every row is the conditional's (the host's evaluation, scalar/compute/evaluate.ts).
 * - Over each term no connective form holds (negatives): it keeps its conditional, or is never split on, and its value.
 *
 * Oracle: the shared term's own structure and SQL, and the host's value of the term before the sharing.
 *
 * Features: each shape.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { connectiveOps } from "#compiler/scalar/compute/registry.ts"
import {
	closedReads,
	type ConstantArmShape,
	connectiveOfShape,
	constantArmShapes,
	constantArmTerm,
	holdsConditional,
	hostValue,
	type Negative,
	negatives,
	negativeTerm,
	rows,
	type Shape,
	shapes,
	shared,
	sharedTerm,
	selectionSql,
	topOf
} from "#test/unit/lower/conservative/conjunct.fixtures.ts"

/** A selection an equality decides keeps the equality a top-level conjunct, never a CASE. */
export const aSelectionAnEqualityDecidesKeepsTheEqualityATopLevelConjunctNeverACASE =
	property.exhaust(
		finite((source) => source.draw(element(shapes))),
		{
			box: "each shape of a selection `kind = 633` decides, the equality first and read again below it",
			needs: {},
			situations: shapes satisfies ReadonlyArray<Reached<Shape>>,
			check: (_, c: Case<Shape>) => (shape) =>
				Effect.sync(() => {
					c.note(shape)
					const term = shared(shape)
					const sql = selectionSql(term)
					assert.ok(!holdsConditional(term), `no conditional in ${sql}`)
					assert.ok(
						Str.startsWith('"r0"."kind" = 633::smallint')(sql),
						`the equality first in ${sql}`
					)
				}),
			oracle: { kind: "specification", name: "the shared term's own structure and SQL" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/expr/share.ts",
					original:
						"\t\tif (isBoolean(like) && !this.#raisesAt(c) && this.#nonNullAt(c, facts)) {\n",
					replacement: "\t\tif (isBoolean(like) && false) {\n",
					why: "No conditional is reduced to its connective, so a boolean split is always the conditional: `kind = 633 AND (...)` is CASE WHEN kind = 633 THEN ... ELSE false END, the equality hidden from an index condition."
				}
			]
		}
	)

/** A boolean conditional with a constant arm over a condition never NULL is the table's connective, of the same value. */
export const aBooleanConditionalWithAConstantArmOverAConditionNeverNullIsItsConnectiveOfTheSameValue =
	property.exhaust(
		finite((source) => source.draw(element(constantArmShapes))),
		{
			box: "each entry of the table of constant arms, over `kind = 633` and `base = 3`, and a check's refusal of a predicate never NULL",
			needs: {},
			situations: constantArmShapes satisfies ReadonlyArray<Reached<ConstantArmShape>>,
			check: (_, c: Case<ConstantArmShape>) => (shape) =>
				Effect.sync(() => {
					c.note(shape)
					const term = constantArmTerm(shape)
					const reduced = sharedTerm(term)
					const sql = selectionSql(reduced)
					assert.ok(!holdsConditional(reduced), `no conditional in ${sql}`)
					const expected = connectiveOfShape[shape]
					const top = topOf(reduced)
					assert.ok(top.op === connectiveOps[expected.op], `the connective of ${sql}`)
					assert.ok(
						(top.first === connectiveOps.not) === expected.negated,
						`the condition negated as the table says in ${sql}`
					)
					assert.deepEqual(
						Arr.map(rows, (row) => hostValue(reduced, row)),
						Arr.map(rows, (row) => hostValue(term, row)),
						`${sql} is the conditional's value at every row`
					)
				}),
			oracle: {
				kind: "specification",
				name: "the table's connective, and the host's value of the conditional at every row"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/expr/share.ts",
					original: '\t\ttrue: { negated: false, connective: "or" },\n',
					replacement: '\t\ttrue: { negated: true, connective: "or" },\n',
					why: "cond(s, true, e) read as NOT s OR e: a row whose condition holds takes e, which may be false, where the conditional is true."
				},
				{
					file: "packages/engine/src/lower/conservative/expr/share.ts",
					original: '\t\tfalse: { negated: true, connective: "and" }\n',
					replacement: '\t\tfalse: { negated: false, connective: "and" }\n',
					why: "cond(s, false, e) read as s AND e: a row whose condition holds is e, true at base 3, where the conditional is false."
				},
				{
					file: "packages/engine/src/lower/conservative/expr/share.ts",
					original: '\t\ttrue: { negated: true, connective: "or" },\n',
					replacement: '\t\ttrue: { negated: false, connective: "or" },\n',
					why: "cond(s, t, true) read as s OR t: a row whose condition fails is t, false at base 4, where the conditional is true."
				},
				{
					file: "packages/engine/src/lower/conservative/expr/share.ts",
					original: '\t\tfalse: { negated: false, connective: "and" }\n',
					replacement: '\t\tfalse: { negated: true, connective: "and" }\n',
					why: "cond(s, t, false) read as NOT s AND t: a row whose condition fails is t, true at base 3, where the conditional is false."
				}
			]
		}
	)

/**
 * A term no connective form holds is never rewritten into one: a subterm that may be NULL, a closed read at a key the
 * relation may hold no tuple at, is never split on, so it is read twice still and no conditional stands; a split whose
 * held arm calls a declared function, which may raise, keeps its conditional, since AND's operands PostgreSQL may
 * evaluate in any order; and a refusal of a predicate that may be NULL keeps its conditional, true where the read is
 * NULL, where NOT of it would be NULL.
 */
export const aSelectionNoConjunctFormHoldsIsNeverSplitOnANullableSubtermAndKeepsItsConditionalBesideACall =
	property.exhaust(
		finite((source) => source.draw(element(negatives))),
		{
			box: "a subterm that may be NULL, a held arm that calls a declared function, and a refusal of a predicate that may be NULL",
			needs: {},
			situations: negatives satisfies ReadonlyArray<Reached<Negative>>,
			check: (_, c: Case<Negative>) => (negative) =>
				Effect.sync(() => {
					c.note(negative)
					const built = negativeTerm(negative)
					const term = sharedTerm(built)
					if (negative === "a subterm that may be NULL") {
						assert.ok(closedReads(term) === 2, "a subterm that may be NULL is never split on")
						assert.ok(!holdsConditional(term), "and no conditional stands for it")
						return
					}
					assert.ok(holdsConditional(term), `${negative} keeps its conditional`)
					if (negative === "a refusal of a predicate that may be NULL") {
						assert.deepEqual(
							Arr.map(rows, (row) => hostValue(term, row)),
							Arr.map(rows, (row) => hostValue(built, row)),
							"the refusal's value at every row, true where the read is NULL"
						)
					}
				}),
			oracle: {
				kind: "specification",
				name: "the shared term's own structure, and the host's value of the refusal at every row"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/expr/share.ts",
					original: "\t\t\t\t\tthis.#nonNullAt(s, facts) &&\n",
					replacement: "",
					why: "A subterm that may be NULL is split on, so `R.f(kind) = 633 AND ...` is rewritten as though its subterm were true or false on every row, where a key R holds no tuple at reads NULL."
				},
				{
					file: "packages/engine/src/lower/conservative/expr/share.ts",
					original: "\t\t\t\tif (value !== undefined && !this.#raisesAt(other)) {\n",
					replacement: "\t\t\t\tif (value !== undefined) {\n",
					why: "A held arm that calls a declared function is a conjunct of AND, which PostgreSQL may evaluate before the subterm, so the call runs, and may raise, on a row the conditional never ran it on."
				},
				{
					file: "packages/engine/src/lower/conservative/expr/share.ts",
					original:
						"\t\tif (isBoolean(like) && !this.#raisesAt(c) && this.#nonNullAt(c, facts)) {\n",
					replacement: "\t\tif (isBoolean(like) && !this.#raisesAt(c)) {\n",
					why: "A refusal of a predicate that may be NULL read as its negation: where R holds no tuple at the row's kind, the predicate is NULL, the refusal true and NOT of it NULL, so a row the check refuses passes it."
				}
			]
		}
	)
