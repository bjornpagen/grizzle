/**
 * A selection an equality of a column to a literal decides keeps the equality a top-level conjunct
 * (lower/conservative/expr/share.ts #decided): where the sharing splits a boolean on a subterm it reads twice and the
 * split's arm where the subterm fails is false, the split is `subterm AND (the rest where it holds)`, the equality a
 * conjunct PostgreSQL reads as an index condition, never `CASE WHEN subterm THEN ... ELSE false END`, which hides it; a
 * conditional is written only where no conjunct form exists. The subterm is never NULL where it is split on, so the
 * conjunction is the conditional's value on every row, which share.test.ts's meaning property holds of every split.
 *
 * Over each shape (conjunct.fixtures.ts shapes), `kind = 633` first and read again below it, lowered as a query lowers
 * it and shared: the shared term holds no conditional, and its SQL begins with the equality, a conjunct.
 *
 * Oracle: the shared term's own structure and SQL.
 *
 * Features: each shape.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, String as Str } from "effect"
import {
	closedReads,
	holdsConditional,
	type Negative,
	negatives,
	negativeTerm,
	type Shape,
	shapes,
	shared,
	sharedTerm,
	selectionSql
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
					original: "\t\t\treturn this.#decided(subject, holds, fails, e)\n",
					replacement: "\t\t\treturn this.#cond(subject, holds, fails, e)\n",
					why: "A boolean split is always the conditional, so `kind = 633 AND (...)` is CASE WHEN kind = 633 THEN ... ELSE false END, the equality hidden from an index condition."
				}
			]
		}
	)

/**
 * A selection no conjunct form holds is never rewritten into one: a subterm that may be NULL, a closed read at a key the
 * relation may hold no tuple at, is never split on, so it is read twice still and no conditional stands; and a split
 * whose held arm calls a declared function, which may raise, keeps its conditional, since AND's operands PostgreSQL
 * may evaluate in any order.
 */
export const aSelectionNoConjunctFormHoldsIsNeverSplitOnANullableSubtermAndKeepsItsConditionalBesideACall =
	property.exhaust(
		finite((source) => source.draw(element(negatives))),
		{
			box: "a subterm that may be NULL, and a held arm that calls a declared function",
			needs: {},
			situations: negatives satisfies ReadonlyArray<Reached<Negative>>,
			check: (_, c: Case<Negative>) => (negative) =>
				Effect.sync(() => {
					c.note(negative)
					const term = sharedTerm(negativeTerm(negative))
					if (negative === "a subterm that may be NULL") {
						assert.ok(closedReads(term) === 2, "a subterm that may be NULL is never split on")
						assert.ok(!holdsConditional(term), "and no conditional stands for it")
						return
					}
					assert.ok(
						holdsConditional(term),
						"a held arm that may raise keeps the split's conditional"
					)
				}),
			oracle: { kind: "specification", name: "the shared term's own structure" },
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
					original:
						"\t\tif (truthOf(fails) !== false || truthOf(holds) === false || this.#raisesAt(holds)) {\n",
					replacement: "\t\tif (truthOf(fails) !== false || truthOf(holds) === false) {\n",
					why: "A held arm that calls a declared function is a conjunct of AND, which PostgreSQL may evaluate before the subterm, so the call runs, and may raise, on a row the conditional never ran it on."
				}
			]
		}
	)
