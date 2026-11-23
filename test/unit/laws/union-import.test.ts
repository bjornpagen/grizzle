/**
 * A containment into a derived union of rules that each read one imported query compiles, and the judge's check over
 * every row finds exactly the facts its violation query holds. Navigation (analysis/theory/navigate.ts) inlines the
 * import into each rule, under a prefix `n<k>.` of the rule's navigation, and reads the union, an import of several
 * rules, whole: restricted inside to the values the reader fixes its columns to, its reader's channels among them
 * (`boundInside`), and navigated as a query of its own. That navigation names its channels and its inlined variables
 * from the start again, so the reader's channel `via0.n0.x` was a name the union's own steps minted for a variable of
 * their own, which took the step's bind map entry, and the union's bind map named a parameter none of its rules read:
 * the checker refused the judge grizzle had built (check/checker.ts #importAt, "a bind map names only the imported
 * query's parameters"), as it refused metis's Delivery containment at delivery.ts:724.
 *
 * The box, explored: stored relations Snap(child, n, at), Item(child, n, stage), Sess(child, stage), Visit(child, stage,
 * k, at) and Susp(child, stage, k, at), each immutable and keyed by its child first, so the containment is unit-local,
 * judged whole; SnapStage, the derived join of Snap, Item and Sess, contained at every column in InSession, the union
 * of a nonempty subset of three rules over that join and Visit, each reading it as an import: a visit begun by the
 * snapshot, one begun by it and suspended after it (a match of Susp), and one begun after it; compiled at its own
 * level or from a level extending it; states of two children's snapshots, items, sessions, visits and suspensions over
 * small values. The oracle is the reference evaluator's reading of the rule's violation query, the law's meaning,
 * beside the check over every row navigated as the judge navigates it (physical/ddl/rules.ts judgedStatement).
 *
 * Features: a union of one, two and three rules; compiled from a level above; a snapshot the union holds and one it
 * lacks.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseGen, type Feature, features, judged } from "#test/unit/laws/union-import.fixtures.ts"

/**
 * A containment into a union of derived rules that each inline one import compiles, and its check over every row finds
 * exactly the facts its violation query holds.
 *
 * Budget: 200 runs and 100 steered cases. In a sample of 300 cases the rarest situation, a union of three rules, one
 * union of seven, was drawn 42 times; each of the fourteen schemas is compiled once, with its installation.
 */
export const aContainmentIntoAUnionOfDerivedRulesThatEachInlineOneImportCompilesAndItsCheckOverEveryRowFindsExactlyTheFactsItsViolationQueryHolds =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 200, steered: 100 },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (drawn) => Effect.sync(() => judged(drawn, c.note)),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's reading of the rule's violation query: exactly its facts"
		},
		kept: [],
		kills: []
	})
