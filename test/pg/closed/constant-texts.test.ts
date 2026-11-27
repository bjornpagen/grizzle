/**
 * A comparison of texts that read no row field is a constant, and a schema holding one installs and judges each row by
 * its value, on PostgreSQL 19, in a generated field, a row check and a selection alike.
 *
 * PostgreSQL pre-evaluates a function of constants while it checks a generation expression's immutability, before it
 * assigns the expression's collations, so a collatable comparison of constants there fails with 42P22
 * (upstream/generated-column-collation-before-planning). The persistent lowering prints every compound subterm
 * PostgreSQL's planner folds as its value, which the host's exact evaluator computes as PostgreSQL does under pg_c_utf8:
 * by code points, NULL included. test/pg/fields/planner-constants holds the subterms the planner folds that read the
 * row in a CASE's dead arm or beside an operand that decides an AND or OR.
 *
 * Each case draws a roster Kind of one to three handles; Pick, a closed relation of a text at a drawn subset of the
 * kinds, so a read at a kind it holds no row at is NULL; and a constant predicate over constant texts: literals over an
 * alphabet that orders by code point unlike by UTF-16 unit or by case (Z, a, b, é and 𝒳), Pick.at at a handle written
 * in the term, their concatenation and GREATEST (a check admits no LEAST); compared by =, <>, <, <=, > and >=, IN a list of literals,
 * starts_with and ends_with, under AND, OR and NOT. The predicate stands alone, or beside an arm that reads the row's
 * integer, under OR or AND, as GEN-NULL found it. Its positions, each its own relation:
 *
 * - a generated integer field, `Logic.cond(φ, n, m)`, a generation expression;
 * - a generated text field, a constant text term alone;
 * - a row check of φ;
 * - a key over the selection of φ, a law column `CASE WHEN φ THEN n END`, a generation expression;
 * - a containment of the selection of φ into a closed relation, a table CHECK guarded by φ.
 *
 * The oracle is the contract restated over the drawn texts: SQL's three-valued logic, a closed read at an absent key
 * NULL, texts ordered by code point. A list value is a bare literal, which adopts its subject's type and is judged by it,
 * and a concatenation is text of at most its operands' bytes together, a literal operand by its own (README,
 * Text.concat), so a schema whose constant lists a value of more bytes than a concatenation of two literals is
 * refused at compile, ContractLiteral; any other schema must install. Each row written by grizzle's writer is accepted where
 * lawful and refused by its relation's one law otherwise, and every stored generated value is the model's.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	caseGen,
	constantCase,
	type Feature,
	situations
} from "#test/pg/closed/constant-texts.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A comparison of texts that read no row installs, and judges each row by its value, in every position.
 *
 * Its pre-conversion budget: runs 24, coverage cases 48 (test/pg/closed/constant-texts.test.ts at d8eed1786).
 */
export const aComparisonOfTextsThatReadNoRowInstallsAndJudgesEachRowByItsValueInEveryPosition =
	property.explore(caseGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, c: Case<Feature>) =>
			(value) =>
				Effect.provideServiceEffect(
					constantCase(value, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "SQL's three-valued logic over the drawn texts ordered by code point, a closed read at an absent key NULL, a list value longer than a concatenation of literals ContractLiteral, and a schema that compiles installs"
		},
		budget: { runs: 24, steered: 48 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/closed/constant-texts.test.ts#aComparisonOfTextsThatReadNoRowInstallsAndJudgesEachRowByItsValueInEveryPosition:-:1.1.1.1.1.0.1.0.0.1.0.0.2.1.0.1.1.2.1.0.1.1.1.2.1.1.1.1.1.0.2.0.1.0.0.0.0.0.1.1.0.0.1.1.0.0.0.0.0.0.1.0.0.0.1.1.0.0.0.0.2.0.0.2.1.0.1.1.0.0.2.1.1.1.1.0.0.0.1.1.1.0.2"
				),
				reason:
					"GEN-NULL: a generated field whose condition ORs a row arm with 'ab' IN ('ab', 'bb'), and one comparing Pick.at at a handle written in the term with a literal",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/closed/constant-texts.test.ts#aComparisonOfTextsThatReadNoRowInstallsAndJudgesEachRowByItsValueInEveryPosition:-:2.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"main at 38a1b476: a key's selection of '' || '' IN ('Z'), a list of one value, which the schema owns as the equality '' || '' = 'Z' (schema/own.ts), and an equation with a concatenation typed its literal as any text (scalar/compute/typing.ts concatEquation), so the schema installed where 'Z' is no value of a concatenation of no bytes (ContractLiteral)",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					"\t\t\tthis.opposite(desc.op, whole, this.textWithinBytes(concatBytes([p, ...rest]), here), here),\n",
				replacement: "\t\t\tthis.opposite(desc.op, whole, wildcardText, here),\n",
				why: "An equation's whole is typed opposite any text, not its concatenation's type, so a literal of more bytes than the parts take together is admitted, and a key's selection of '' || '' IN ('Z'), its equality once owned, installs."
			}
		]
	})
