/**
 * A rule's check over every row, the one the migration that adds a rule over a query runs (deploy/snapshot/violation.ts
 * lawChecks), is its judge over the transaction that writes every row into an installation that holds none: of a
 * probed rule, the probe of the facts each arm of its breaking side adds, held at the arm's first match of a stored
 * relation, its region every row of that relation (analysis/theory/query.ts everyRowProbes). Read by the reference
 * evaluator, it finds a row exactly where the rule's violation query does, and the same facts where the two state one
 * heading.
 *
 * The box, explored: T(k, a, b), S(id, a) and G(x), each mutable, so every rule over them is probed; D over T of three
 * arms, each delivering T's (a, k): T joined to S by b, T at a literal b, a key field bound by a literal, and T at a
 * literal b whose a no S holds, a negation, each literal 1 or 2, which drawn rows hold, or 9, which none does; its x
 * contained in G, a check that x is never 3, or a key of x; states of up to four rows of T, three of S and four of G
 * over the values 0 to 3, lawful or not. The oracle is the reference evaluator's reading of the rule's violation query,
 * the law's meaning, which lowers nothing.
 *
 * Features: a check that finds a row and one that finds none; a fact only a later arm derives; each kind of rule.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseGen, type Feature, features, judged } from "#test/unit/laws/every-row.fixtures.ts"

/** A rule's check over every row finds exactly the facts its violation query holds. */
export const aRulesCheckOverEveryRowFindsExactlyTheFactsItsViolationQueryHolds = property.explore(
	caseGen,
	{
		needs: {},
		budget: { runs: 300, steered: 100 },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (drawn) => Effect.sync(() => judged(drawn, c.note)),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's reading of the rule's violation query: a row exactly where it holds one, and its facts"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\tflatMapNonEmpty(breakingArms(rule), (arm) => {",
				replacement: "\tflatMapNonEmpty([breakingArms(rule)[0]], (arm) => {",
				why: "The check over every row reads the first arm of the breaking side alone, so a fact only a later arm derives is never found, and the migration installs a rule the stored rows break."
			}
		]
	}
)
