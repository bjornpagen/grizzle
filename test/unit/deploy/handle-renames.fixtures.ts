/** What handle-renames.test.ts reads: its space of handle renames and the draft of each. */

import { shuffled, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { bit, closedId, int4 } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { installedCodes } from "#test/support/compile.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	asDrafted,
	compile,
	draftCodes,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { rowStepsOf, statementsOf } from "#test/unit/deploy/renames.fixtures.ts"

/** The roster's handles in code order, and the name a rename may give a handle beside them. */
const handles = Object.freeze(["a", "b", "c"] as const)

const fresh = "d"

/** The schema over the roster spelled `spelled`, code order kept: a relation holding one code of it and a set of it. */
const schemaOf = (spelled: ReadonlyArray<string>) => {
	const Kind = closed.ordered("Kind", spelled)
	const T = relation("T", { id: int4, k: closedId(Kind), s: bit(Kind) }, ["id"])
	return schema("Renamed", [Kind, T], [])
}

/** A rename of the roster's handles: each handle's name after it, an injective map onto the handles and `fresh`. */
export interface HandleRenaming {
	readonly to: ReadonlyArray<string>
}

export const renamingGen: Gen<HandleRenaming> = (source) => ({
	to: source.draw(shuffled([...handles, fresh], { min: handles.length, max: handles.length }))
})

/** The renaming's handle declarations, each handle whose name moves. */
const declarationsOf = (r: HandleRenaming): Declarations => ({
	renames: Arr.flatMap(handles, (handle, i) => {
		const to = r.to[i] ?? handle
		return to === handle
			? []
			: [
					{
						from: { kind: "handle" as const, roster: parsedName("Kind"), handle },
						to: { kind: "handle" as const, roster: parsedName("Kind"), handle: to }
					}
				]
	}),
	drops: []
})

/** How a renaming moves the roster's names: none, a swap of two handles' names, or a rename to a fresh one. */
export type RenamingFeature = "renamed" | "swapped" | "renamed to a fresh name"

/** The features of a renaming. */
export const renamingNotes = (r: HandleRenaming): ReadonlyArray<RenamingFeature> => {
	const moved = Arr.filter(handles, (h, i) => r.to[i] !== h)
	return [
		...(moved.length > 0 ? (["renamed"] as const) : []),
		...(Arr.some(handles, (h, i) => r.to[i] !== h && Arr.contains(handles, r.to[i] ?? h))
			? (["swapped"] as const)
			: []),
		...(Arr.contains(r.to, fresh) ? (["renamed to a fresh name"] as const) : [])
	]
}

/**
 * The draft from the snapshot of the schema over the handles as declared to the schema over them as the renaming names
 * them, declared, as `grizzle generate --rename` drafts it: its statements and the steps it runs over stored rows.
 */
export const renamedDraft = (
	r: HandleRenaming
): {
	readonly statements: ReadonlyArray<SqlStatement>
	readonly rowSteps: ReadonlyArray<string>
} => {
	const first = schemaOf(handles)
	const installed = compile(first, asDrafted)
	const { snapshot } = succeeded(
		generate({
			installation: installed,
			timestamp: draftedAt(1),
			previous: fromEmpty,
			workload: noWorkload,
			declared: noDeclarations,
			name: "installed"
		})
	)
	const second = schemaOf(Arr.map(handles, (h, i) => r.to[i] ?? h))
	const declared = declarationsOf(r)
	const codes = succeeded(draftCodes(second, fromSnapshot(snapshot), declared))
	const { plan } = succeeded(
		generate({
			installation: compile(second, { ...asDrafted, codes: installedCodes(codes) }),
			timestamp: draftedAt(2),
			previous: fromSnapshot(snapshot),
			workload: noWorkload,
			declared,
			name: "renamed"
		})
	)
	return { statements: statementsOf(plan.steps), rowSteps: rowStepsOf(plan.steps) }
}
