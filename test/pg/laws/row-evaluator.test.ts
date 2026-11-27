/**
 * The host's evaluation of a row, rowEvaluator (program/evaluate.ts), against PostgreSQL 19: what PostgreSQL computes
 * of a row of a relation, stored, derived or closed, its generated field's value, each row check's verdict and whether
 * a selection keeps it, the host computes alike, and a row PostgreSQL's domains refuse the host refuses at a field they
 * refuse.
 *
 * The box: a world of the NULL language (test/support/null/language.ts World), closed relations over two rosters with
 * some keys held by no row, so a closed read is NULL; two to six of its rows, each with a text of the pattern
 * ^[a-c]{0,3}$ and an integer of the contract Units (u ≤ 5), each outside its domain at times; a generated field of a
 * drawn sort (every sort a generated field stores, a closed id, a set, a numeric and both floats among them); one to
 * three row checks; one to three checks of derived relations, in the vocabulary both a check and a query admit; and a
 * selection's predicate. Terms and predicates are the language's, two levels deep, over every operator family a check
 * admits; and a predicate in the closed vocabulary, over a row of Pick, the world's closed relation of a kind's
 * payload, which holds every field of the rows but their set and their span. The schema states Gen, the rows' fields
 * and the generated field g; All, under every row check; for each check, a relation under it alone, named as All's;
 * for each derived check, SrcJ, under none, and on a level above it DJ, live, every row of SrcJ, under the check;
 * Refined, a closed relation over a kind and the rows' refined fields; select(Gen, φ); and select(Pick, ψ). It is
 * installed through its first migration, and a direct writer writes each row into each relation. For every row:
 *
 * - PostgreSQL's domains refuse it (pg_input_is_valid, and the insert's 23514 naming a domain's CHECK) exactly where the
 *   host's evaluation of it, as a row of every source, Refined's among them, is DomainRefused, at a field a domain
 *   refuses, and otherwise Refined's evaluation is a closed row's (below);
 * - otherwise the host's g is PostgreSQL's stored value of the column, or NULL where PostgreSQL refuses the row by g's
 *   NOT NULL (23502);
 * - each check's verdict is PostgreSQL's: a row of the relation under it alone is stored where it holds and refused by
 *   its CHECK (23514, the constraint the installation names for it) where it breaks, whether its predicate is false or
 *   NULL; All's evaluation judges each check alike, under every name; and All stores the row exactly where every check
 *   holds, naming one it breaks;
 * - each derived check's verdict is its rule's: a row of SrcJ is stored where the check of DJ, every row of SrcJ, holds
 *   of it, and refused at its commit by the rule's trigger (23514, named as constraintNamesOf names the check) where it
 *   breaks, its predicate false or NULL, as the rule's violation query, WHERE (p) IS NOT TRUE, reads it;
 * - the selection keeps it exactly where `SELECT … WHERE φ` does, φ written in plain SQL from its meaning alone.
 *
 * And for the world's closed relations, rosters among them, a closed relation being a row source as a stored one is:
 *
 * - each row of each is evaluated as a row of it with no generated field and no row check, which a closed relation
 *   holds none of, and selected, as select(C, TRUE) keeps every row;
 * - select(Pick, ψ) keeps a row of Pick exactly where `SELECT … FROM pick WHERE ψ` does, Pick's rows as values and ψ
 *   in plain SQL from its meaning alone.
 *
 * Oracle: PostgreSQL itself, its domains, its stored generated column, its CHECKs and its WHERE.
 *
 * Features: each domain's refusal and both at once, a generated value of every stored sort and a NULL one, each truth
 * of a check, of a derived check, of the selection and of the selection of Pick, a row every check holds of, and a
 * refusal among several broken checks.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	caseGen,
	type Feature,
	required,
	rowEvaluatorCase
} from "#test/pg/laws/row-evaluator.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The host evaluates a row as PostgreSQL does: its domains' refusal, its generated value, each check's verdict and its selection. */
export const theHostEvaluatesARowAsPostgreSQLDoesItsDomainsRefusalItsGeneratedValueEachChecksVerdictAndItsSelection =
	property.explore(caseGen, {
		needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
		situations: required satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ caseSubstrate }, k: Case<Feature>) =>
			(ec) =>
				Effect.provideServiceEffect(
					rowEvaluatorCase(ec, k).pipe(Effect.scoped),
					Substrate,
					Effect.map(caseSubstrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "PostgreSQL's domains, stored generated column, CHECKs, rule triggers and WHERE over the same rows"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/witness.ts",
				original: "\tfor (const field of judged) {",
				replacement: "\tfor (const field of judged.slice(1)) {",
				why: "admit skips a judged field: a row its first judged field's domain refuses is admitted, where PostgreSQL's CHECK refuses it."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "items: once(() => itemsOf(relation, reading, answers))",
				replacement: "items: () => itemsOf(relation, reading, answers)",
				why: "Each evaluation of an admitted row builds its relation's records again, for every source of its relation, so two sources of Gen over one admitted row read two records and two values of g, not the one record they share."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: '\t\tcase "null":\n\t\t\treturn truths.false',
				replacement: '\t\tcase "null":\n\t\t\treturn truths.true',
				why: "A predicate NULL at a row is read as true, where IS TRUE reads it as false: a check its row leaves NULL holds, and a selection keeps a row its predicate leaves NULL."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original:
					'\t\t: { relation: selection.relation, predicate: connectiveExpr("and", [selection.predicate]) }',
				replacement: '\t\t: { relation: selection.relation, predicate: connectiveExpr("and", []) }',
				why: "A selection is evaluated as its whole relation, select(R, TRUE), its predicate unread."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "fields.filter((f) => judgedGeneration(f) === undefined && isJudged(f.type))",
				replacement: "fields.filter((f) => judgedGeneration(f) !== undefined && isJudged(f.type))",
				why: "A caller's field is never held to its domain, so a row PostgreSQL's domain refuses is evaluated as if admitted."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: '\t\t\t\ttest.kind === "row"',
				replacement: '\t\t\t\ttest.kind !== "row"',
				why: "A stored relation's row checks are not read from the CHECKs its table holds, so its evaluation judges none of them."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "judgeOf(closedTableOf(model.checked), model.checked.patterns)",
				replacement: "judgeOf(new Map(), model.checked.patterns)",
				why: "The judge reads none of the schema's closed relations, so a closed read is no value of the host's."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "\t\t\treturn Result.ok(null)",
				replacement: '\t\t\treturn Result.err({ _tag: "Unevaluated", why: "NULL" })',
				why: "A generated value PostgreSQL computes as NULL is no value of the host's, where it is NULL, the NOT NULL's refusal."
			},
			{
				file: "packages/engine/src/ir/desc.ts",
				original:
					'\tkind: "cond",\n\tpred: predicate,\n\tonTrue: connectiveUnit("or"),\n\tonFalse: connectiveUnit("and")',
				replacement: '\tkind: "not",\n\targ: predicate',
				why: "A derived relation's rule refuses a row where NOT (p) holds, so a derived row its predicate leaves NULL passes it, where its table twin's CHECK ((p) IS TRUE), and the README's law, refuse that row."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: '\tif (derived?.desc.kind !== "derived") {',
				replacement: '\tif (derived?.desc.kind === "derived") {',
				why: "No derived relation is read as a source, as before a live derived relation was, which the checked schema holds no analysis of."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "\t\treturn relationReading(name, statedFields(closed.heading), [], codes)",
				replacement: "\t\treturn undefined",
				why: "No closed relation is read as a source, as before: a row of a closed relation or of a selection of one, which RowSource admits, is a defect thrown, a row source of the schema not found."
			}
		]
	})
