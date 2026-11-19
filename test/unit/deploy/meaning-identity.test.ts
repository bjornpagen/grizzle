/**
 * Identity by meaning: a follow-up drafted by today's grizzle over the snapshot an earlier one wrote, whose canonical
 * form lacked one of today's rules (schema/own.ts canonicalRules), keeps every object of a schema whose meaning did not
 * change. The earlier grizzle named two keys over the rows one predicate keeps, each spelled its own way, under two
 * canonical texts, and so their law columns, keys and the foreign key of a containment from those rows; today's form
 * makes the two spellings one. The follow-up renames each law column, constraint and index to the name today's text
 * gives it (laws/model/restate.ts PreviousNames.selections, firstHeld), and drops, adds, validates or rebuilds nothing:
 * a membership of one, which PostgreSQL stores as its equality and grizzle writes so, moves no SQL at all, and a rule
 * that reorders a predicate's SQL re-expresses each law column it reorders in place, each table in one ALTER TABLE
 * (deploy/diff/diff.ts reexpressedLawColumn). A law the rule judge holds, from the first spelling's rows of a unit's
 * body, is the earlier snapshot's law under today's identifier (deploy/diff/declared.ts restatedLaws): its record, its
 * check's identity as the release's converter leaves it, is read under that identifier, so the follow-up checks no
 * stored row against it again and only replaces the judge's function, which names the law by its identifier.
 *
 * The oracle is a specification: every statement of the follow-up a rename, a comment, a table's one re-expression or
 * a function replaced. The box, exhausted: every rule an earlier grizzle lacked.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, HashMap } from "effect"
import { printStatement } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import {
	draftedOf,
	type MeaningCase,
	meaningCases,
	moveOf,
	movesSql,
	reexpressedTables,
	rowStepsOf,
	statementsOf
} from "#test/unit/deploy/meaning-identity.fixtures.ts"

type Feature = MeaningCase["rule"] | "renamed" | "re-expressed"

/** A follow-up over an earlier canonical form keeps every object: it renames, comments and re-expresses in place. */
export const aFollowUpOverASnapshotAnEarlierCanonicalFormWroteKeepsEveryObjectRenamingOrReexpressingItInPlace =
	property.exhaust(finite(meaningCases), {
		box: "every rule of today's canonical form an earlier grizzle lacked, over two keys of one predicate spelled two ways, a containment from its rows, where the rule moves no SQL a row check of it, and a containment the rule judge holds from a unit's rows it keeps",
		needs: {},
		situations: [
			"orientation",
			"connectives",
			"conjuncts",
			"inValues",
			"inOfOne",
			"renamed",
			"re-expressed"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (m) =>
			Effect.sync(() => {
				c.note(m.rule)
				const { steps } = draftedOf(m)
				const statements = statementsOf(steps)
				const moved = Arr.filter(statements, (s) => moveOf(s) === "other")
				assert.deepEqual(
					[...Arr.map(moved, printStatement), ...rowStepsOf(steps)],
					[],
					`${m.rule}: the follow-up drops, adds, validates, checks or rebuilds nothing`
				)
				assert.ok(
					Arr.some(statements, (s) => moveOf(s) === "rename"),
					`${m.rule}: the follow-up renames what the earlier canonical text named`
				)
				c.note("renamed")
				const tables = reexpressedTables(statements)
				for (const [table, count] of tables) {
					assert.equal(count, 1, `${m.rule}: ${table} is re-expressed by one ALTER TABLE`)
				}
				if (movesSql(m.rule)) {
					assert.ok(HashMap.size(tables) > 0, `${m.rule}: a reordered law column takes its new SQL`)
					c.note("re-expressed")
				} else {
					assert.equal(HashMap.size(tables), 0, `${m.rule}: a membership of one moves no SQL`)
				}
			}),
		oracle: {
			kind: "specification",
			name: "every statement of the follow-up a rename, a comment or a table's one re-expression in place"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/restate.ts",
				original: "\treturn (isNonEmpty(recorded) ? choices.pick(recorded) : today).map((p) => ({",
				replacement: "\treturn today.map((p) => ({",
				why: "The restating step removed: a law and a law column are restated under today's canonical text alone, which names none the earlier snapshot holds, so every law column, key and foreign key is dropped and built again."
			},
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\tconst today = canonicalTexts(side.selection)",
				replacement:
					"\t\tconst today = side.selection.conjuncts.map((p) => ownedText(p, withoutSourceLocs))",
				why: "The earlier snapshot's selections not read under today's rules again: each is found by its earlier text, which no restated selection has, so the follow-up drops and builds again what that rule renamed."
			},
			{
				file: "packages/engine/src/laws/model/restate.ts",
				original: "\tfor (const at of assignments(choices.met).slice(1)) {",
				replacement: "\tfor (const at of assignments([]).slice(1)) {",
				why: "No probe: a selection the earlier snapshot records in two spellings is always read as the first, so one of the two keys names a law column the earlier snapshot does not hold, and is dropped and built again."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original:
					'\t\t\tif (generation !== undefined) {\n\t\t\t\tthis.alter("structure", t, [{ kind: "setExpression", column, generation }])\n\t\t\t\treturn\n\t\t\t}\n',
				replacement: "",
				why: "A law column whose SQL a rule reordered dropped and added again, with every key and foreign key over it, where SET EXPRESSION keeps them."
			},
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\trestatedLaws(writings, installation, names),\n",
				replacement: "\t\twritings,\n",
				why: "The earlier snapshot's law records read under the earlier identifiers alone: the law the rule judge holds is found under none, so the follow-up checks every stored row against it again, a violation query over the unit's bodies."
			}
		]
	})
