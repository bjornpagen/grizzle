/**
 * One change to a family's or a tree's copies or generated fields, drafted with no database: a copy removed from the
 * riding containment that carries it or added to one, the member's generated field added or removed, or a copy's pair
 * moved to another target field; over a counted family's owner axis, an ordered family's and a tree's, one to four
 * copies split over one or two carriers, a tree's copies reading another copy, beside a fold over the members, whose
 * running values are hidden law columns, and a containment from a selection of them, which rides no axis and keeps law
 * columns of its own.
 *
 * The oracle is the schema's own read graph: what the change replaces (the copy's or the generated field's column) and
 * what it gives other values (a retargeted copy, and every copy that reads one, transitively) are the fields the
 * migration touches, exactly; every other column it touches, and every constraint and index it drops or creates, is one
 * the two versions' catalogs hold otherwise or that reads a touched column; and the migration ends at the catalog the
 * second version installs from nothing, on the catalog model of PostgreSQL (test/support/migrate/interpret.ts).
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	changeKinds,
	type CopyFeature,
	copyCases,
	judge,
	notesOf,
	shapes
} from "#test/unit/deploy/copy-diff.fixtures.ts"

/** One change to an axis's copies or a member's generated field touches only it and what reads it: a sibling copy, a selection's law columns, a fold's hidden running values and the family's drawn values keep their columns, and a copy whose pair moves is drawn again with every copy that reads it. */
export const oneChangeToAnAxissCopiesOrAMembersGeneratedFieldTouchesOnlyItAndWhatReadsIt =
	property.explore(copyCases, {
		needs: {},
		budget: { runs: 200, steered: 100 },
		situations: [
			...shapes,
			...changeKinds,
			"two carriers",
			"a copy of a copy",
			"a retarget another copy reads",
			"folded",
			"selected"
		] satisfies ReadonlyArray<Reached<CopyFeature>>,
		check: (_, c: Case<CopyFeature>) => (copyCase) =>
			Effect.sync(() => {
				c.noteAll(notesOf(copyCase))
				judge(copyCase)
			}),
		oracle: {
			kind: "specification",
			name: "the schema's own read graph: the fields a change replaces or gives other values, the two versions' catalogs, and the catalog model of PostgreSQL running the migration"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\treturn carriers\n\t}\n}",
				replacement: "\t\treturn mapNonEmpty(copy.carriers, this.#spell.law)\n\t}\n}",
				why: "A copy identified by its carriers' identities, each the hash of the containment's whole term list (the old restatement, declared.ts PreviousFill.carriers): a sibling added to or taken from a carrier draws every copy it carries again; the property fails."
			},
			{
				file: "packages/engine/src/laws/model/restate.ts",
				original: "\t\treturn was === undefined ? [] : [was]\n\t})\n",
				replacement:
					"\t\treturn was === undefined ? [] : [was]\n\t})\n\tif (previousFields.length < relation.fields.length) {\n\t\treturn undefined\n\t}\n",
				why: "A selection restated only where every field of its relation has a previous name (the old restate.ts restatedConjuncts, C18): a field added to the member sets aside and draws again every law column of a selection or a fold over it; the property fails."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "this.drawn.get(key)?.has(column) === true && changed.has(columnAt(key, column))",
				replacement: "this.drawn.get(key)?.has(column) === true && changed.size < 0",
				why: "No column drawn again for what its fill reads (diff.ts keptTablesOf drawnAgain): a copy of a retargeted copy keeps its stale values; the property fails."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "drawnAgain(key, column) ? drawnAnew(change) : change",
				replacement:
					"drawnAgain(key, column) || (this.drawn.get(key)?.has(column) === true && at.old.columns.length !== create.columns.length) ? drawnAnew(change) : change",
				why: "A family drawn again on any change of its member's columns: a sibling copy and the family's drawn values drawn again where nothing they read changed; the property fails."
			}
		]
	})
