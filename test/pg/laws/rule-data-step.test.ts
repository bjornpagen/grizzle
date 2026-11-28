/**
 * A migration's data step is judged at its statement (deploy/diff/diff.ts checkedAtOnce, physical/ddl/rules.ts
 * addCapture): a migration's Structure transaction sets its constraints immediate before every data step it holds, a
 * reviewer's UPDATE among them, so a rule over a query whose relation the step writes refuses the step where it breaks
 * the rule, at that statement, by the rule's own SQLSTATE and law; the judge reads the step's rows because the capture
 * writes the sentinel's row, whose trigger fires it, after them. Written before them, the judge read no row of the step,
 * and only the Validate file's full violation check refused it.
 *
 * Over a mutable P and Small, a check over a query of P's rows, a second version adds a column to P with a placeholder,
 * its Structure file holding a reviewer's UPDATE of a stored row's v: one Small keeps applies; one it breaks is refused
 * at that statement of the Structure file with check_violation and Small's law.
 */
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { dataStepGen, runDataStep } from "#test/pg/laws/rule-data-step.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A migration's data step that breaks a rule over a query is refused at its statement, and one that keeps it applies. */
export const aMigrationsDataStepThatBreaksARuleOverAQueryIsRefusedAtItsStatement = property.exhaust(
	finite(dataStepGen),
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a data step that keeps the rule applied",
			"a data step that breaks the rule refused at it"
		],
		check:
			({ substrate }, c) =>
			(d) =>
				Effect.provideServiceEffect(
					runDataStep(d, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "the migration's outcome over the data step's value: applied under 10, refused at the data step's statement of the Structure file by check_violation and Small's law at 99"
		},
		box: "a data step of a reviewed migration writing v 5 or 99 into a stored row of a mutable relation under a check over a query of it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					'source: { kind: "values", rows: [[thisTransaction, variable(captureNames.row)]] }',
				replacement:
					'source: { kind: "values", rows: [[thisTransaction, variable(captureNames.head)]] }',
				why: "A capture leaves the arm's head where it read it, so the judge the data step fires claims none of its rows, and the breaking step runs on, refused only by the Validate file's full violation check."
			}
		]
	}
)
