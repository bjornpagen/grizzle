/**
 * A persistent expression PostgreSQL's planner folds installs and computes what the host computes: every subterm the
 * planner reduces to a constant is folded on the host (physical/ddl/expr.ts plannedConstants), so no collatable function
 * of constants reaches PostgreSQL, which evaluates one while it checks a generation expression's immutability, before it
 * assigns the expression's collations, and refuses it with 42P22 whatever COLLATE its operands carry
 * (upstream/generated-column-collation-before-planning). The planner reduces more than a subterm that reads no row: a CASE
 * whose condition folds is the arm it selects, and an AND or OR an operand of which folds to its deciding value is that
 * value, so `GREATEST(CASE WHEN 0 <> 0 THEN t ELSE '' END, '')` is its `GREATEST('', '')` (PANTRY13-CLOSED's red of the
 * row-evaluator property, seed 275374157). On PostgreSQL 19rc2, over Planned (planner-constants.fixtures.ts): R keyed
 * by its id, writing a text t and an integer n, with a generated text of a drawn text term and a generated boolean of a
 * drawn predicate.
 *
 * Each case draws the two terms over literals of texts that order by code point unlike by case, the row's text,
 * CASE, GREATEST, LEAST and an ASCII case fold, and comparisons of texts, of the row's integer and of integer
 * literals, under AND, OR and NOT; installs them; and writes rows of drawn texts and integers.
 *
 * Oracle: second implementation: the schema installs, and every stored generated value is the host's (rowEvaluator),
 * which evaluates the terms as written.
 *
 * Features: a CASE whose condition folds, a CASE a connective's operand decides beside a literal in GREATEST or LEAST,
 * and a collatable function of folded operands.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type PlannerFeature,
	plannerCaseGen,
	runPlanner
} from "#test/pg/fields/planner-constants.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A generation expression whose subterms PostgreSQL's planner folds installs, and stores what the host computes.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aGenerationExpressionThePlannerFoldsInstallsEverySubtermItFoldsFoldedOnTheHostAndStoresWhatTheHostComputes =
	property.explore(plannerCaseGen, {
		needs: { caseSubstrate: Substrate.installing },
		situations: [
			"a CASE whose condition folds",
			"a CASE a connective's operand decides, beside a literal in GREATEST or LEAST",
			"a collatable function of folded operands"
		] satisfies ReadonlyArray<PlannerFeature>,
		check:
			({ caseSubstrate }, c) =>
			(drawn) =>
				Effect.provideServiceEffect(
					runPlanner(drawn, c).pipe(Effect.scoped),
					Substrate,
					caseSubstrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the installation succeeds, and PostgreSQL's stored generated values are the host's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/expr.ts",
				original:
					"\t\t\t\treturn holds === undefined\n\t\t\t\t\t? every\n\t\t\t\t\t\t? over(e, forms)\n\t\t\t\t\t\t: undefined\n\t\t\t\t\t: forms.get(holds === true ? t : f)",
				replacement: "\t\t\t\treturn every ? over(e, forms) : undefined",
				why: "A CASE folds only where every operand does, as a subterm that reads no row: a CASE whose condition folds keeps the row read in its other arm, so the planner's GREATEST of the arm it selects and a literal reaches PostgreSQL, which refuses the installation with 42P22."
			},
			{
				file: "packages/engine/src/physical/ddl/expr.ts",
				original:
					"\t\t\t\treturn decided ? truth(e, deciding) : every ? over(e, forms) : undefined",
				replacement: "\t\t\t\treturn every ? over(e, forms) : undefined",
				why: "An AND or OR folds only where every operand does: one an operand decides keeps the row read in another, so a CASE over it selects a literal arm only in the planner, whose GREATEST of it and a literal reaches PostgreSQL, which refuses the installation with 42P22."
			}
		]
	})
