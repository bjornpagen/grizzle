/**
 * Every rewrite of a comparison is three-valued exactly as the comparison's plain meaning is, on PostgreSQL 19:
 * NULL where an operand it reads is NULL, as a closed read at an absent key reads.
 *
 * The lowering decides some comparisons by another form: a text's equation with a concatenation, `t = p || q`, by its
 * lengths, a prefix and a suffix, so that nothing allocates (scalar/compute/typing.ts concatEquation); ends_with as
 * `right(a, char_length(b)) = b`; a match whose pattern is a term by a CASE over the pattern's values; and, in a query,
 * an IEEE 754 division by its guarded form, a zero divisor's infinity or NaN chosen by the dividend's sign. PostgreSQL
 * reads BETWEEN as two comparisons and IN as one per value. A form whose conjuncts read different operands, or whose
 * CASE ends in a constant, gives false or a value where the plain meaning is NULL, and NOT then turns it true; a form
 * that sets two operands that read no row side by side in a comparison or a CASE fails a generation expression's
 * installation with 42P22 (upstream/generated-column-collation-before-planning).
 *
 * Each case draws a roster Kind of one to three handles and Pick, a closed relation of a text t and a double f at a
 * drawn subset of the kinds. An operand is the row's own text, Pick.at("t", kind) at the row's kind, Pick.at at a
 * handle written in the term, or a literal, over the letters a and b, which a pattern reads as themselves. The
 * predicates: a concatenation's equation or inequation with an operand, on either side; starts_with and ends_with; a
 * match against a literal, or Pick's text where Pick holds a row; BETWEEN two operands; IN a list of literals; in a query, whether f over the
 * row's double is below zero; under AND, OR and NOT.
 * Positions, each its own relation: a row check, a generated field `Compute.cond(φ, n, m)`, a containment of a
 * selection into a closed relation, a key over a selection, and a query's filter.
 *
 * The oracle is the plain meaning restated over the drawn values: strict operations NULL at a NULL operand, Kleene's
 * AND, OR and NOT, texts ordered by code point, a pattern of letters matching where the text holds it, IEEE 754's
 * division. The schema must install. A lawful row is accepted
 * and an unlawful one refused by its relation's law; a generated value is n exactly where φ is true; the query returns
 * exactly the rows φ is true of.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	aimedCaseGen,
	type Feature,
	rewriteCase,
	situations
} from "#test/pg/closed/null-rewrites.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A comparison's rewrite over a NULL operand is three-valued as its plain meaning is, in every position.
 *
 * Its pre-conversion budget: runs 24, coverage cases 64 (test/pg/closed/null-rewrites.test.ts at d8eed1786).
 */
export const aComparisonsRewriteOverANULLOperandIsThreeValuedAsItsPlainMeaningIsInEveryPosition =
	property.explore(steered(aimedCaseGen), {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, c2: Case<Feature>) =>
			(value) =>
				Effect.provideServiceEffect(rewriteCase(value, c2), Substrate, substrate),
		oracle: {
			kind: "specification",
			name: "each comparison's plain meaning over the drawn values: strict operations NULL at a NULL operand, Kleene's AND, OR and NOT, and IEEE 754's division and order"
		},
		budget: { runs: 24, steered: 64 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/closed/null-rewrites.test.ts#aComparisonsRewriteOverANULLOperandIsThreeValuedAsItsPlainMeaningIsInEveryPosition:-:1.1.1.3.0.1.0.0.0.1.0.1.2.0.0.0.1.0.1.2.0.0.0.1.0.1.2.0.0.0.1.0.1.2.0.0.0.1.0.1.2.0.1.0.0.0.1.0"
				),
				reason:
					"GEN-NULL: a comparison over a concatenation decided by lengths, a prefix and a suffix: ne(concat(Pick.at(t, own kind), 'b'), t) at a kind Pick holds no row at, with t '', outside Allowed",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/closed/null-rewrites.test.ts#aComparisonsRewriteOverANULLOperandIsThreeValuedAsItsPlainMeaningIsInEveryPosition:-:1.0.1.1.6.1.0.2.1.3.1.1.1.2.1.3.2.3.5.0.0.2.0.1.1.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.6.1.1.0"
				),
				reason:
					"TEST_SEED=3553103864, case 0: a generated field's match of the row's text against Pick.at at a written handle installed as CASE 'a' WHEN 'a' THEN …, a CASE over two constants, which PostgreSQL refused with 42P22",
				since: "2026-11-19"
			}
		],
		kills: []
	})
