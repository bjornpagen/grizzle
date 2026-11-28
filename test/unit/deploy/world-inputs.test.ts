/**
 * A role's world object, a view, a world function or a policy, is identified by its own statement (deploy/diff/diff.ts
 * worldChangesOf): a migration drops it and creates it again exactly when its DDL changes, it is new or gone, or it
 * waits for an object the migration changes or takes away beneath it. A foreign key is no input of it: what the
 * compile of a world object may rely on is in its DDL, which changes where its compile does, and PostgreSQL records no
 * dependency of a view on a foreign key, so nothing beneath it needs it dropped.
 *
 * Property: the schema of List and Item, a reader reading Item or Item and List whole, its second version adding a
 * containment of Item's `list` in List's key, a foreign key, re-expressing Item's generated field, which SET EXPRESSION
 * changes in place and PostgreSQL keeps every view over (diff.ts sameRead), or changing nothing: the second draft drops
 * and creates no world object, and only a draft that changes something has steps.
 *
 * Oracle: a specification, the reader's views reading each relation whole, whose statements no foreign key changes.
 * The box, exhausted: each change, under each reader.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { secondDraft, type Turn, turnGen } from "#test/unit/deploy/world-inputs.fixtures.ts"

type Feature = `${Turn["change"]}, read by ${Turn["reads"]}`

/** A foreign key added drops and creates no role's world object again. */
export const aForeignKeyAddedCreatesNoWorldObjectAgain = property.exhaust(finite(turnGen), {
	needs: {},
	situations: [
		"none, read by Item",
		"none, read by Item and List",
		"a foreign key added, read by Item",
		"a foreign key added, read by Item and List",
		"a generated field re-expressed, read by Item",
		"a generated field re-expressed, read by Item and List"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, c: Case<Feature>) => (turn) =>
		Effect.sync(() => {
			const drafted = secondDraft(turn)
			assert.equal(
				drafted.worldSteps,
				0,
				`${turn.change}: no world object dropped or created again`
			)
			assert.equal(
				drafted.steps > 0,
				turn.change !== "none",
				`${turn.change}: a draft exactly where the second version changes something`
			)
			c.note(`${turn.change}, read by ${turn.reads}`)
		}),
	oracle: {
		kind: "specification",
		name: "the reader's views read each relation whole, and no foreign key changes their statements"
	},
	box: "List and Item, a reader of Item or of Item and List, the second version adding Item's foreign key into List, re-expressing Item's generated field, or nothing",
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				'\tif (samePrinted(was, now) || (was.kind === "storedTable" && now.kind === "storedTable")) {\n\t\treturn true\n\t}\n\tconst [before] = was.ddl',
			replacement:
				"\tif (samePrinted(was, now) || was.ident !== now.ident) {\n\t\treturn samePrinted(was, now)\n\t}\n\treturn false\n\tconst [before] = was.ddl",
			why: "A table whose generated field SET EXPRESSION re-expresses in place read as changed (diff.ts sameRead as samePrinted): the reader's views over it are dropped and created again, which PostgreSQL keeps over a re-expression."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				"\t\tif (was === undefined || !sameRead(was, o)) {\n\t\t\tchanged.add(o.ident)\n\t\t}\n\t}\n\tfor (const o of previous.objects) {",
			replacement:
				'\t\tif (was === undefined || !sameRead(was, o)) {\n\t\t\tchanged.add(o.ident)\n\t\t\tif (o.kind === "foreignKey") {\n\t\t\t\tfor (const e of target.edges) {\n\t\t\t\t\tif (e.to === o.ident) {\n\t\t\t\t\t\tchanged.add(e.from)\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n\tfor (const o of previous.objects) {',
			why: "A foreign key added counts as a change of the tables it is created after, as a compile input of every world object reading them, so the migration drops and creates the reader's views over them again with the same statements."
		}
	]
})
