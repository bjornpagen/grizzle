/**
 * A materialized view is identified by what it means, never by its SQL (physical/derived/meaning.ts definitionMeanings,
 * deploy/diff/diff.ts viewDropsOf), and the migration that creates it populates it (diff.ts view, structure.refresh).
 * Its meaning is the digest of what its pruned definition's DAG asks of the rows it reads, so a migration that changes
 * a definition, or a view below it, creates exactly those views again, and one that changes only how grizzle lowers
 * them creates none: the view its earlier lowering installed stands, and the target's snapshot records it as installed
 * (deploy/snapshot/build.ts withInstalledViews). A view created WITH NO DATA is unreadable until its first refresh, so
 * each migration that creates one refreshes it in Structure, after every row it reads is written, bottom-up.
 *
 * The schema: T's facts by document and place; Ones and Twos, T's facts of `a` one and of `a` two, at level 1; Fives,
 * Ones' facts of `b` five, at level 2.
 *
 * Property: the first version drafted from no installation creates and refreshes every view, and the second, over it,
 * which changes nothing, Ones' lowering alone, Ones' installed definition to one calling a function the target no
 * longer holds, T's key of `b`, or Ones', Twos' or Fives' definition, creates again and refreshes exactly the views
 * whose meaning the change changes or whose installed definition reads what is gone, each with every view above it,
 * in install order, a refresh in structure.refresh, and none for a key; a change of nothing but a lowering drafts no
 * step, and every view it keeps is recorded as installed.
 *
 * Oracle: a specification read off the schema, each view reading its own relation. The box, exhausted: every change.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { assert, defined } from "#test/support/assert.ts"
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

/** A draft creates exactly `expected` again, in install order, and refreshes each in structure.refresh, in that order. */
const createsAndRefreshes = (
	draft: ViewDraft,
	expected: ReadonlyArray<View>,
	which: string
): void => {
	assert.deepEqual(
		Arr.map(draft.created, (s) => s.view),
		[...expected],
		`${which} creates exactly these views, in install order`
	)
	assert.deepEqual(
		draft.refreshed,
		Arr.map(expected, (view) => ({ view, slot: "structure.refresh" as const })),
		`${which} refreshes each view it creates, bottom-up, in structure.refresh`
	)
}

/** A change of a view's meaning creates exactly the views it changes again and refreshes them; a lowering, none. */
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
				createsAndRefreshes(first, views, "the first draft")
				const recreated = recreatedBy(change)
				createsAndRefreshes(second, recreated, `${change}: the second draft`)
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
			name: "the schema's own reads: each view reads its own relation, so a change creates again exactly the views over what it changes"
		},
		box: "the schema of Ones and Twos over T and Fives over Ones, its second version changing nothing, Ones' lowering alone, Ones' installed definition to one calling a function no longer held, T's key of b, or Ones', Twos' or Fives' definition",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\t\t\twas.get(ran.create.name.name) !== now.get(v.create.name.name) ||",
				replacement: "\t\t\t\t!sameRecord(before, o) ||",
				why: "A view is identified by its SQL again, so a change of how grizzle lowers Ones alone drops and creates Ones and Fives again and refreshes them over every row."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: '\t\t\tthis.sql("structure.refresh", [refreshStatement(v.create.name, false)])\n',
				replacement: "",
				why: "A view the migration creates is left WITH NO DATA, unreadable until a caller's first refresh."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\t\t\tthis.readsGone(ran.create, held)\n",
				replacement: "\t\t\t\tfalse\n",
				why: "A view whose installed definition calls a function the target no longer holds is kept, so the migration's drop of the function fails under it, and its snapshot records a definition that reads nothing the installation holds."
			},
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "statedForm(normal, rowsFields)",
				replacement: "statedForm(normal, digestedFields)",
				why: "A view's meaning holds the keys the relations it reads declare, so a key added to T drops and creates Ones, Twos and Fives again and refreshes them over every row, where the key's unique indexes alone are new."
			},
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: '\t\tcase "derived":\n\t\t\treturn { ...of, meaning: r.meaning }',
				replacement: '\t\tcase "derived":\n\t\t\treturn of',
				why: "The snapshot's files record no view's meaning, so every draft over a committed snapshot drops and creates every view again and refreshes it over every row."
			},
			{
				file: "packages/engine/src/deploy/render/generate.ts",
				original:
					"withAttnums(withInstalledViews(state, plan), applied.previous, plan, tableMaxColumns)",
				replacement: "withAttnums(state, applied.previous, plan, tableMaxColumns)",
				why: "A kept view is recorded by the target's lowering, not the one installed, so the snapshot changes and the drift check replays a definition PostgreSQL does not hold."
			}
		]
	}
)
