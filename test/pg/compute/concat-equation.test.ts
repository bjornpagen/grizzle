/**
 * A text's equation with a concatenation of any number of parts (scalar/compute/typing.ts concatEquation) on
 * PostgreSQL 19, decided as an equality of the text with the parts built in order under their bytes' guard,
 * `octet_length(t) = Σ octet_length(pi) AND t = CASE WHEN Σ octet_length(pi) > bytesMaxLength THEN '' ELSE p1 || … ||
 * pn END`.
 *
 * - **expressions**: equations of two to five parts drawn as concatenation trees of any bracketing, over text columns,
 *   bounded or not, and bare literals, the whole a column or a literal on either side, `=` or `<>`
 *   (test/unit/compute/concat-equation.fixtures.ts), each lowered as a query and as a check lowers it and run over a
 *   batch of rows in one statement: texts of one-, two- and four-byte characters, empty ones and NULL. PostgreSQL's
 *   value is the host's and the equation's plain meaning, three-valued, and the reference evaluator's where no operand
 *   is NULL.
 * - **pantry's reference split**: a check over the join of each reference with its attribute's lexical form,
 *   `lexical = lead || target || params || trail`, which the rule judge decides in its query, and the same split as a
 *   row check, which PostgreSQL decides as a CHECK (concat-equation.fixtures.ts). One transaction writes a package's
 *   references and inline references; the CHECK refuses exactly the inline references whose lexical form is not their
 *   parts in order, and the judge exactly the packages with such a reference, each naming its law.
 *
 * Oracle: the equation's plain meaning, the whole against the parts' texts joined in order, NULL at a NULL operand.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runEquation,
	runWritten,
	type SplitFeature,
	splitTemplate,
	writtenGen
} from "#test/pg/compute/concat-equation.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	type EquationFeature,
	loweredEquationGen
} from "#test/unit/compute/concat-equation.fixtures.ts"

/**
 * An equation of a text with a concatenation of any number of parts, lowered as a query and as a check lowers it, is on
 * PostgreSQL the whole against the parts in order, NULL at a NULL operand, as the host evaluates it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/concat-equation.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/concat-equation.test.ts` at its budget
 *   before, the runner's, runs 150 and steered 200, each kill's verdict printed with where its witnesses went red
 *   (judgedLine with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log;
 *   this budget run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result each of its 2 kills went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const anEquationWithAConcatenationOfAnyNumberOfPartsIsOnPostgreSQLTheWholeAgainstThePartsInOrderInAQueryAndACheck =
	property.explore(loweredEquationGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"two parts",
			"three parts",
			"four parts",
			"five parts",
			"a concatenation nested two deep",
			"a concatenation nested in a second operand",
			"the equation holds",
			"the lengths hold and a middle part differs",
			"a NULL operand",
			"a part of multibyte characters",
			"an empty part"
		] satisfies ReadonlyArray<Reached<EquationFeature>>,
		check:
			({ substrate }, k: Case<EquationFeature>) =>
			(c) =>
				Effect.provideServiceEffect(runEquation(c, k), Substrate, substrate),
		oracle: {
			kind: "specification",
			name: "the equation's plain meaning, the whole against the parts' texts joined in order, NULL at a NULL operand"
		},
		budget: { runs: 1, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\tif (desc.kind !== "compute" || desc.fn !== "concat") {\n\t\treturn [{ desc, at, concat, stands }]',
				replacement:
					'\tif (desc.kind !== "compute" || desc.fn !== "concat" || at === at) {\n\t\treturn [{ desc, at, concat, stands }]',
				why: "Flattening is capped at two parts: a concatenation nested in an equation's side is one part, typed as a term, which a query refuses beside an equation, so no query compiles an equation of three parts or more."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\t\t[bytes, this.literal(bytesMaxLength, plainType("int4"), here)],',
				replacement: '\t\t\t[bytes, this.literal(0, plainType("int4"), here)],',
				why: "The guard's bound is zero bytes, so PostgreSQL compares every whole of non-empty parts with the empty text, and refuses one that is the parts in order."
			}
		]
	})

/**
 * pantry's reference split, a check over the join of each reference with its attribute's lexical form and a row check,
 * each the lexical form against its four parts in order, refuses exactly the references whose lexical form is not them.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/concat-equation.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/concat-equation.test.ts` at its budget
 *   before, the runner's, runs 150 and steered 200, each kill's verdict printed with where its witnesses went red
 *   (judgedLine with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log;
 *   this budget run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on its need's open, the mutant's schema refused before any case
 * @decision 1, the least a generative search draws: no declared kill needs a floor or a rotating case; no headroom: a
 *   kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const aReferenceSplitOverAJoinAndARowCheckRefuseExactlyTheReferencesWhoseLexicalFormIsNotTheirFourPartsInOrder =
	property.explore(writtenGen, {
		needs: { substrate: Substrate.rolledBack(splitTemplate) },
		situations: [
			"accepted",
			"refused by Reference split",
			"refused by Inline split",
			"the lengths hold and a middle part differs",
			"a part of multibyte characters",
			"an empty part"
		] satisfies ReadonlyArray<SplitFeature>,
		check:
			({ substrate }, c) =>
			(written) =>
				Effect.gen(function* () {
					const { connection, value } = yield* substrate
					yield* runWritten(value, connection, written, c)
				}),
		oracle: {
			kind: "specification",
			name: "a reference split as its lexical form is exactly where that form is its lead, target, params and trail joined in order: the judge and the CHECK refuse exactly the others, each naming its law"
		},
		budget: { runs: 1, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\tif (desc.kind !== "compute" || desc.fn !== "concat") {\n\t\treturn [{ desc, at, concat, stands }]',
				replacement:
					'\tif (desc.kind !== "compute" || desc.fn !== "concat" || at === at) {\n\t\treturn [{ desc, at, concat, stands }]',
				why: "Flattening is capped at two parts: the split over the join reads its nested concatenations as terms, which the judge's query refuses, so the schema does not compile."
			}
		]
	})
