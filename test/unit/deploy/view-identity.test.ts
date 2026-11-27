/**
 * A stored derived relation's table is named by its canonical form (analysis/derived/canonical.ts, core/identity.ts
 * view), the rows form of its definition, which claims no key (ir/dag-digest.ts rowsNode), so a key added to T leaves
 * every table over it its name; a table of one name is identified by what it means, never by its SQL
 * (physical/derived/meaning.ts definitionMeanings, deploy/diff/diff.ts viewDropsOf), and the migration that creates its
 * table fills it (diff.ts view, structure.stored). Its meaning is the digest of what its pruned definition's DAG asks
 * of the rows it reads, a stored relation it names read through its definition, so a migration that changes a
 * definition, or one a definition reads, creates exactly those tables again, and one that changes only how grizzle
 * lowers them creates none: the table its earlier lowering installed stands, and the target's snapshot records it as
 * installed (deploy/snapshot/build.ts withInstalledViews). Each migration that creates a stored table fills it in
 * Structure, after every row it reads is written, bottom-up.
 *
 * The schema: T's facts by document and place, in a unit of the document; Ones and Twos, T's facts of `a` one and of
 * `a` two, at level 1; Fives, Ones' facts of `b` five, at level 2.
 *
 * Property: the first version drafted from no installation creates and fills every stored table, each of Ones' and
 * Twos' fills reading T at its constant `a` through T's index on `a`, which the draft creates before them (its files'
 * advice names it, deploy/render/advise.ts), and the second, over
 * it, which changes nothing, Ones' lowering alone, Ones' installed definition to one calling a function the target no
 * longer holds, T's key of `b`, or Ones', Twos' or Fives' definition, creates again and fills exactly the tables whose
 * meaning or primary key the change changes or whose installed definition reads what is gone, and those above them (a
 * key added changes no primary key: each is the narrowest proven key holding its table's unit), in install order, a
 * fill in structure.stored; a change of nothing but a lowering drafts no step, and every table it keeps is recorded as
 * installed.
 *
 * Oracle: a specification read off the schema, each stored relation reading its own definition. The box, exhausted:
 * every change.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import {
	type Change,
	changeGen,
	indexOfA,
	inInstallOrder,
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
	const ordered = inInstallOrder(draft.identities, expected)
	assert.deepEqual(
		Arr.map(draft.created, (s) => s.view),
		[...ordered],
		`${which} creates exactly these stored tables, in install order`
	)
	assert.deepEqual(
		draft.filled,
		Arr.map(ordered, (view) => ({ view, slot: "structure.stored" as const })),
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
				const throughA = indexOfA(first.snapshot)
				assert.ok(
					Arr.some(first.advice, Str.includes(throughA)),
					`the first draft's fills of Ones and Twos read T at their constant a through ${throughA}, which it creates before them: its files' advice names it\n${Arr.join(first.advice, "\n")}`
				)
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
				file: "packages/engine/src/ir/dag.ts",
				original: "\tconst digested = digestedBase(node)\n",
				replacement: "\tconst digested = node\n",
				why: "A stored table's meaning reads the dependencies the checker stamps on the Bases it reads, which a key gives them: T's key of `b`, carried into Ones' dependencies, changes Fives' meaning, so the draft creates Fives again."
			},
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
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: "\tconst holding = keys.find((k) => unit.every((f) => k.fields.includes(f)))\n",
				replacement: "\tconst holding = narrowest\n",
				why: "A stored table's primary key is its narrowest proven key with its unit's fields put before it, whatever key holds the unit already: T's key of b moves Ones' and Twos' from (doc, at) to (doc, at, b), so a key added creates every stored table again."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					'\t\treturn { kind: "superkey", fields, named: [first, ...rest], of: narrowest }\n',
				replacement: '\t\treturn { kind: "superkey", fields, named: fields, of: narrowest }\n',
				why: "A superkey is named by its fields in its key's order, the unit first: once T's key of b leaves Fives one fact at most, its proven keys single fields, its (doc, at) superkey takes another name than the proven (at, doc) it stood for, and a key added creates Fives again."
			},
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original:
					"\t\tconst { primaryKey: _primaryKey, keys: _keys, ...rows } = digestedBase(node)\n",
				replacement: "\t\tconst rows = digestedBase(node)\n",
				why: "A canonical form holds the keys of the relations it reads, so T's key of b names Ones', Twos' and Fives' tables anew and a key added creates and fills every stored table over T again, where it re-indexes them."
			},
			{
				file: "packages/engine/src/deploy/render/generate.ts",
				original:
					"withAttnums(withInstalledViews(state, plan), applied.previous, plan, tableMaxColumns)",
				replacement: "withAttnums(state, applied.previous, plan, tableMaxColumns)",
				why: "A kept stored table is recorded by the target's lowering, not the one installed, so the snapshot changes and the drift check replays a definition PostgreSQL does not hold."
			},
			{
				file: "packages/engine/src/deploy/render/advise.ts",
				original: "\tconst steps = [...plan.steps]\n",
				replacement: "\tconst steps = [...plan.steps]\n\treturn plan\n",
				why: "The drafter leaves each index where the diff drafted it, after the data steps: Ones' fill reads T through the index on a its draft creates, which stands only once a later statement creates it, so its file's advice names an index the database does not hold yet, the in-force internal compiler error."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: '\t\treturn landing.kind === "served" ? landing.index : undefined\n',
				replacement: "\t\treturn undefined\n",
				why: "A data step finds no index serving its read at a constant (servingOf), so Ones' and Twos' fills read T whole beside their filter on a, every row of it, where its index on a reaches the rows of their constant alone: their files' advice names no index of T."
			}
		]
	}
)
