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
