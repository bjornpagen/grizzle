/**
 * A stored derived relation is identified by what it means, never by its SQL (physical/derived/meaning.ts
 * definitionMeanings, deploy/diff/diff.ts viewDropsOf), and the migration that creates its table fills it (diff.ts
 * view, structure.stored). Its meaning is the digest of what its pruned definition's DAG asks of the rows it reads, a
 * stored relation it names read through its definition, so a migration that changes a definition, or one a definition
 * reads, creates exactly those tables again, and one that changes only how grizzle lowers them creates none: the table
 * its earlier lowering installed stands, and the target's snapshot records it as installed
 * (deploy/snapshot/build.ts withInstalledViews). Each migration that creates a stored table fills it in Structure, after
 * every row it reads is written, bottom-up.
 *
 * The schema: T's facts by document and place, in a unit of the document; Ones and Twos, T's facts of `a` one and of
 * `a` two, at level 1; Fives, Ones' facts of `b` five, at level 2.
 *
 * Property: the first version drafted from no installation creates and fills every stored table, and the second, over
 * it, which changes nothing, Ones' lowering alone, Ones' installed definition to one calling a function the target no
 * longer holds, T's key of `b`, or Ones', Twos' or Fives' definition, creates again and fills exactly the tables whose
 * meaning or primary key the change changes or whose installed definition reads what is gone, and those above them, in
 * install order, a fill in structure.stored; a change of nothing but a lowering drafts no step, and every table it keeps
 * is recorded as installed.
 *
 * Oracle: a specification read off the schema, each stored relation reading its own definition. The box, exhausted:
 * every change.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type Change,
	changeGen,
	viewDrafts,
	recordedViews,
	recreatedBy,
	type View,
	type ViewDraft,
	views
} from "#test/unit/deploy/view-identity.fixtures.ts"

/** What the property reaches: each kind of change. */
type Feature =
	| "nothing changed"
	| "a lowering alone changed"
	| "an installed definition reads what is gone"
	| "a key added"
	| "a definition changed"

const featureOf = (change: Change): Feature => {
	switch (change) {
		case "none":
			return "nothing changed"
		case "lowering":
			return "a lowering alone changed"
		case "gone":
			return "an installed definition reads what is gone"
		case "key":
			return "a key added"
		case "Ones":
		case "Twos":
		case "Fives":
			return "a definition changed"
	}
}

/** A draft creates exactly `expected` again, in install order, and fills each in structure.stored, in that order. */
const createsAndFills = (draft: ViewDraft, expected: ReadonlyArray<View>, which: string): void => {
	assert.deepEqual(
		Arr.map(draft.created, (s) => s.view),
		[...expected],
		`${which} creates exactly these stored tables, in install order`
	)
	assert.deepEqual(
		draft.filled,
		Arr.map(expected, (view) => ({ view, slot: "structure.stored" as const })),
		`${which} fills each stored table it creates, bottom-up, in structure.stored`
	)
}

/** A change of a stored relation's meaning creates exactly the tables it changes again and fills them; a lowering, none. */
export const aChangeOfAViewsMeaningCreatesExactlyThatViewAgainAndPopulatesIt = property.exhaust(
	finite(changeGen),
	{
		needs: {},
		situations: [
			"nothing changed",
			"a lowering alone changed",
			"an installed definition reads what is gone",
			"a key added",
			"a definition changed"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (change) =>
			Effect.sync(() => {
				const { first, second } = viewDrafts(change)
				createsAndFills(first, views, "the first draft")
				const recreated = recreatedBy(change)
				createsAndFills(second, recreated, `${change}: the second draft`)
				if (change === "none" || change === "lowering") {
					assert.equal(second.steps, 0, `${change}: a change of no installed object drafts no step`)
				}
				const before = recordedViews(second.previous)
				const after = recordedViews(second.snapshot)
				for (const view of Arr.filter(views, (w) => !recreated.includes(w))) {
					assert.deepEqual(
						after.get(view),
						defined(before.get(view), `${view} as installed`),
						`${change}: ${view}, kept, is recorded as installed`
					)
				}
				c.note(featureOf(change))
			}),
		oracle: {
			kind: "specification",
			name: "the schema's own reads: each stored relation reads its own definition, so a change creates again exactly the tables over what it changes"
		},
		box: "the schema of Ones and Twos over T and Fives over Ones, stored, its second version changing nothing, Ones' lowering alone, Ones' installed definition to one calling a function no longer held, T's key of b, or Ones', Twos' or Fives' definition",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\t\t\twas.get(ran.create.name.name) !== now.get(v.create.name.name) ||",
				replacement: "\t\t\t\t!sameRecord(before, o) ||",
				why: "A stored relation is identified by its SQL again, so a change of how grizzle lowers Ones alone drops and creates Ones' table again and fills it over every row."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: '\t\t\tthis.sql("structure.stored", [fillStatement(v.create)])\n',
				replacement: "",
				why: "A stored table the migration creates is left empty, so no read of it holds its definition's rows."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\t\t\tthis.readsGone(ran.create, held)\n",
				replacement: "\t\t\t\tfalse\n",
				why: "A stored table whose installed definition calls a function the target no longer holds is kept, so its snapshot records a definition that reads nothing the installation holds."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: '\t\tcase "derived":\n\t\t\treturn { ...of, meaning: r.meaning }',
				replacement: '\t\tcase "derived":\n\t\t\treturn of',
				why: "The snapshot's files record no stored relation's meaning, so every draft over a committed snapshot drops and creates every stored table again and fills it over every row."
			},
			{
				file: "packages/engine/src/deploy/render/generate.ts",
				original:
					"withAttnums(withInstalledViews(state, plan), applied.previous, plan, tableMaxColumns)",
				replacement: "withAttnums(state, applied.previous, plan, tableMaxColumns)",
				why: "A kept stored table is recorded by the target's lowering, not the one installed, so the snapshot changes and the drift check replays a definition PostgreSQL does not hold."
			}
		]
	}
)
