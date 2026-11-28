/** What over.test.ts reads: its schemas, roles and programs, and the levels each role holds. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { natural } from "#compiler/public/fields.ts"
import { relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import {
	changeSetOver as ChangeSet,
	changeSetState,
	type ChangeSetValue
} from "#compiler/write/changeset/value.ts"

const Sitting = relation("Sitting", { number: natural }, ["number"])
const Root = schema("Root", [Sitting], [])
const Gradebook = relation("Gradebook", { number: natural }, ["number"])
const Graded = schema.extend([Root], "Graded", [Gradebook], [])
const Note = relation("Note", { number: natural }, ["number"])
const Elsewhere = schema("Elsewhere", [Note], [])

/**
 * What a program is taken over: RootWriter and GradedWriter, full roles over Root and Graded; SittingWriter, a role over
 * Graded holding Root's relation alone, whose levels are Root's; ElsewhereWriter, a full role over a schema of which
 * neither program's is a level; and Root itself, a schema, which is no role.
 */
const overs = [
	"RootWriter",
	"GradedWriter",
	"SittingWriter",
	"ElsewhereWriter",
	"Root itself"
] as const
export type Over = (typeof overs)[number]

const values: { readonly [O in Over]: unknown } = {
	RootWriter: role(Root, "root_writer", wholeEntriesOf(Root), { insert: ["Sitting"] }),
	GradedWriter: role(Graded, "graded_writer", wholeEntriesOf(Graded), {
		insert: ["Sitting", "Gradebook"]
	}),
	SittingWriter: role(Graded, "sitting_writer", { Sitting }, { insert: ["Sitting"] }),
	ElsewhereWriter: role(Elsewhere, "elsewhere_writer", wholeEntriesOf(Elsewhere), {
		insert: ["Note"]
	}),
	"Root itself": Root
}

/** The level a program is written over. */
const levels = ["Root", "Graded"] as const
export type ProgramLevel = (typeof levels)[number]

const programs: { readonly [L in ProgramLevel]: ChangeSetValue } = {
	Root: ChangeSet.empty(Root).insert(Sitting, []),
	Graded: ChangeSet.empty(Graded).insert(Gradebook, [])
}

/**
 * The engine's level rule for a role, as the specification states it (docs/schema.md "A program over whatever role it is
 * given"): each role's levels among the programs', a full role's base and every level below it, a role holding a lower
 * level whole that level and every level below it; none for a schema, which is no role.
 */
export const levelsOf = (over: Over): ReadonlyArray<ProgramLevel> => {
	switch (over) {
		case "RootWriter":
		case "SittingWriter":
			return ["Root"]
		case "GradedWriter":
			return ["Graded", "Root"]
		case "ElsewhereWriter":
		case "Root itself":
			return []
	}
}

/** A case: a program over one level, taken over one role or value. */
export interface OverCase {
	readonly over: Over
	readonly program: ProgramLevel
}

/** Every role and value under every program: 5 × 2 cases. */
export const overCaseGen: Gen<OverCase> = (source) => ({
	over: source.draw(element(overs)),
	program: source.draw(element(levels))
})

/** The case's program taken over its role (ChangeSet.over). */
export const overOf = (c: OverCase): ChangeSetValue =>
	ChangeSet.over(values[c.over], programs[c.program])

/** The case's program unioned with the empty ChangeSet over its role: what ChangeSet.over is. */
export const unionOf = (c: OverCase): ChangeSetValue =>
	ChangeSet.union(ChangeSet.empty(values[c.over]), programs[c.program])

/** Whether a ChangeSet is over the case's role itself: the level it is built over is the role's value. */
export const isOverItsRole = (c: OverCase, cs: ChangeSetValue): boolean =>
	changeSetState(cs)?.over.value === values[c.over]
