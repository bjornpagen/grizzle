/**
 * A data step pays for the judge's premise in its own transaction (physical/ddl/recheck.ts): the judge reads no row a
 * write removes of a closed relation, and none a write adds to one where a contained relation pins its key, since no
 * served write updates or deletes a closed relation's rows; a data step, inside the bracket that lifts the guards, may.
 * So after its statements the bracket refills each stored relation over a closed relation from its definition and
 * checks each rule over a closed relation over every row, before the guards stand again: a custom migration's file
 * through the function `__recheck` the catalog holds (physical/ddl/immutable.ts dataStepBracket, adapter/migrate/apply.ts
 * rechecksRead), a draft's Structure by the steps it drafts after its data steps (deploy/diff/diff.ts recheck).
 *
 * On PostgreSQL 19, over a family of closed relations (data-step-recheck.fixtures.ts): Childless, a rule the judge
 * probes with Child under a negation, whose removed rows no probe reads; Capped, a rule whose probe of Parent's added
 * rows a child's containment prunes; and Toys, stored, whose upkeep reads no row Parent or Toy loses. Each case migrates
 * one data step through the runner as the owner:
 *
 * - a step that deletes a parent's last child, or lowers a parent's cap under a child, a custom migration's or written
 *   at a draft's data step, is refused in its own transaction, naming the law it breaks;
 * - a step that deletes a family, or raises a cap, applies, and Toys holds exactly its definition's rows after it: the
 *   family's toys gone, the raised cap on its toy's row;
 * - a draft holds the re-check exactly where its Structure holds a data step a law can meet: a step a reviewer writes at
 *   a placeholder, whose writes no reading decides, refills Toys and re-checks every rule over a closed relation; a
 *   fill grizzle drafts re-checks only the rules that read the column it fills, none for Note's memo, Marked's for
 *   Mark's v, whose reviewer's 0 breaks it, refused in Structure, its check in Validate gone; one with no data step
 *   re-checks nothing.
 *
 * Oracle: the specification above, Toys read against its definition by plain SQL. Features: each step.
 */
import { assert } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { steps } from "#test/pg/migrate/data-step-recheck.dictionary.ts"
import { brokenBy, recheckCase, type Step } from "#test/pg/migrate/data-step-recheck.fixtures.ts"
import { baseSubstrate, Substrate } from "#test/support/substrate/substrate.ts"

/** A data step that breaks a rule over a closed relation is refused in its own transaction naming it, and one that breaks none leaves each stored relation over closed rows its definition's. */
export const aDataStepThatBreaksARuleOverClosedRowsIsRefusedNamingItAndOneThatBreaksNoneLeavesEachStoredRelationItsDefinitions =
	property.exhaust(finite(word(steps)), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: steps satisfies ReadonlyArray<Reached<Step>>,
		check:
			({ substrate }, c: Case<Step>) =>
			(step) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							c.note(step)
							const outcome = yield* recheckCase(step)
							const broken = brokenBy[step]
							if (broken === undefined) {
								assert.ok(outcome.applied, `the step applies: ${Arr.join(outcome.refused, ", ")}`)
								assert.ok(outcome.equal, "Toys holds exactly its definition's rows after the step")
								return
							}
							assert.ok(!outcome.applied, "the step is refused")
							assert.ok(
								Arr.some(outcome.refused, (display) => Str.includes(broken)(display)),
								`the refusal names ${broken}: ${Arr.join(outcome.refused, ", ")}`
							)
							assert.ok(
								outcome.equal,
								"Toys holds its definition's rows: the refused step rolled back"
							)
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "README, Migrations: a data step re-checks every rule and stored relation over an immutable relation before it commits, refused naming the law it breaks; Toys read against its definition by plain SQL"
		},
		box: "each way a data step meets the re-check: a custom migration's file and a draft's data step, each breaking a rule over closed rows or none, and a draft with no data step",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/recheck.ts",
				original: "\tconst ruled = b.model.rules.filter((r) => readsClosed(r.law.reads))",
				replacement: "\tconst ruled = b.model.rules.filter(() => false)",
				why: "No rule re-checked: a custom step deleting parent 1's last child applies, Childless holding parent 1."
			},
			{
				file: "packages/engine/src/physical/ddl/recheck.ts",
				original: "\t\tif (!overClosed(u)) {",
				replacement: "\t\tif (true) {",
				why: "No stored relation refilled: a step raising parent 1's cap leaves Toys' row at the old cap, the upkeep's insert meeting the row its key holds."
			},
			{
				file: "packages/engine/src/physical/ddl/recheck.ts",
				original: "\t\t\t...(isNonEmpty(rest)\n",
				replacement: "\t\t\t...(false\n",
				why: "A refill that updates no row past its key: Toys keeps parent 1's old cap after a step raises it."
			},
			{
				file: "packages/engine/src/physical/ddl/recheck.ts",
				original:
					'\t\t\t{ match: "NOT MATCHED BY SOURCE", condition: undefined, action: { kind: "delete" } },',
				replacement:
					'\t\t\t{ match: "NOT MATCHED BY SOURCE", condition: undefined, action: { kind: "doNothing" } },',
				why: "A refill that deletes no row: Toys keeps the toy of the family a step deleted."
			},
			{
				file: "packages/engine/src/physical/ddl/immutable.ts",
				original: "\t\t\t...(isNonEmpty(rechecks)\n",
				replacement: "\t\t\t...(false\n",
				why: "A custom data step's bracket runs no re-check: deleting parent 1's last child applies."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/apply.ts",
				original: "textParam(dataStepRecheckName)",
				replacement: 'textParam("")',
				why: "The catalog's re-check never found: a custom step lowering parent 1's cap under its child applies."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original:
					"\t\t\tfor (const law of this.recheck(checks.rules, this.stepWrites(backfilled.columns))) {\n\t\t\t\trechecked.add(law)\n\t\t\t}\n",
				replacement: "",
				why: "A draft drafts no re-check: the step written at its data step deleting parent 1's last child applies."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\tif (isNonEmpty(written)) {\n\t\t\tthis.standUps()\n",
				replacement:
					'\t\tfor (const law of this.recheck(checks.rules, { kind: "unknown" })) {\n\t\t\trechecked.add(law)\n\t\t}\n\t\tif (isNonEmpty(written)) {\n\t\t\tthis.standUps()\n',
				why: "A draft re-checks with no data step: the draft opening Note alone holds the MERGE of Toys."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original:
					'\t\t\twrites.kind === "unknown" || [...reads].some((c) => writes.columns.has(c))',
				replacement: '\t\t\twrites.kind === "unknown"',
				why: "The steps grizzle drafts re-check nothing: the fill of Mark's v at the reviewer's 0, which Marked's rule reads, is checked in Structure by no statement."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: '\t\t\treturn { kind: "unknown" }\n',
				replacement: '\t\t\treturn { kind: "columns", columns: new Set() }\n',
				why: "A step a reviewer writes is read as writing nothing: the step at a draft's placeholder deleting parent 1's last child is re-checked by nothing and applies."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\t\t\t!rechecked.has(c.law) &&\n",
				replacement: "",
				why: "A rule Structure re-checked is checked in Validate again: Marked_low's check over every row runs twice in the draft widening Mark's v."
			}
		]
	})
