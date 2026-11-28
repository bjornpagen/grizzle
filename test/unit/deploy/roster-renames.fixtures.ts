/** What roster-renames.test.ts reads: its space of roster renames and the draft of each. */

import { boolean, element, type Gen, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Declarations, Rename } from "#compiler/deploy/diff/plan.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { installedCodes } from "#test/support/compile.ts"
import {
	check,
	closed,
	closedRelation,
	f,
	field,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
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

/** The roster's handles in code order, the name a rename may give a handle beside them, and the roster's two names. */
const handles = Object.freeze(["a", "b", "c"] as const)

const fresh = "d"

const rosters = Object.freeze(["Kind", "Sort"] as const)

/** How the closed relation of each kind's weight holds its weights: each its handle's code, or that code reversed. */
const weighings = Object.freeze(["by code", "reversed"] as const)

type Weighing = (typeof weighings)[number]

/**
 * The schema over the roster `roster` spelled `spelled`, code order kept, and the closed relation Weight of each kind's
 * weight as `weighed` says: a relation holding one code of the roster, a set of it and a number, and a CHECK that the
 * number is at least its code's weight, which reads Weight's constants and so is its row function's call
 * (physical/ddl/row-functions.ts), the function's parameter typed by the roster's domain.
 */
const schemaOf = (
	roster: string,
	spelled: ReadonlyArray<string>,
	weighed: Weighing
): SchemaDesc => ({
	name: "Renamed",
	relations: [
		closed.ordered(roster, spelled),
		closedRelation(
			"Weight",
			{ kind: { kind: "closedId", roster, only: undefined }, w: { kind: "pg", type: "int4" } },
			["kind"],
			Arr.map(spelled, (handle, code) => ({
				kind: handle,
				w: weighed === "by code" ? code : spelled.length - 1 - code
			}))
		),
		relation(
			"T",
			{ id: f.integer, k: f.closedId(roster), s: { kind: "bits", roster }, x: f.integer },
			["id"]
		)
	],
	statements: [
		check("Heavy", "T", {
			kind: "compare",
			op: "le",
			left: { kind: "closedAt", relation: "Weight", field: "w", args: [field("k")] },
			right: field("x")
		})
	],
	bases: []
})

/** A rename of the roster: its name after it, each handle's name after it (an injective map onto the handles and
 * `fresh`), and how Weight holds its weights after it. */
export interface RosterRenaming {
	readonly roster: string
	readonly to: ReadonlyArray<string>
	readonly weighed: Weighing
}

export const renamingGen: Gen<RosterRenaming> = (source) => ({
	roster: source.draw(element(rosters)),
	to: source.draw(boolean)
		? [...handles]
		: source.draw(shuffled([...handles, fresh], { min: handles.length, max: handles.length })),
	weighed: source.draw(element(weighings))
})

/** The renaming's declarations: the roster's rename where its name moves, and each handle's whose name moves. */
const declarationsOf = (r: RosterRenaming): Declarations => ({
	renames: [
		...(r.roster === "Kind"
			? []
			: [
					{
						from: { kind: "relation", relation: parsedName("Kind") },
						to: { kind: "relation", relation: parsedName(r.roster) }
					} satisfies Rename
				]),
		...Arr.flatMap(handles, (handle, i): ReadonlyArray<Rename> => {
			const to = r.to[i] ?? handle
			return to === handle
				? []
				: [
						{
							from: { kind: "handle", roster: parsedName("Kind"), handle },
							to: { kind: "handle", roster: parsedName(r.roster), handle: to }
						}
					]
		})
	],
	drops: []
})

/** What a renaming moves: the roster's name, its handles' names, and Weight's rows. */
export type RenamingFeature = "roster renamed" | "handles renamed" | "weights changed"

/** The features of a renaming. */
export const renamingNotes = (r: RosterRenaming): ReadonlyArray<RenamingFeature> => [
	...(r.roster === "Kind" ? [] : (["roster renamed"] as const)),
	...(Arr.some(handles, (h, i) => r.to[i] !== h) ? (["handles renamed"] as const) : []),
	...(r.weighed === "by code" ? [] : (["weights changed"] as const))
]

/**
 * The draft from the snapshot of the schema over Kind, its handles as declared and its weights by code, to the schema
 * as the renaming names and weighs it, declared, as `grizzle generate --rename` drafts it: its statements and the steps
 * it runs over stored rows.
 */
export const renamedDraft = (
	r: RosterRenaming
): {
	readonly statements: ReadonlyArray<SqlStatement>
	readonly rowSteps: ReadonlyArray<string>
} => {
	const first = schemaOf("Kind", handles, "by code")
	const { snapshot } = succeeded(
		generate({
			installation: compile(first, asDrafted),
			timestamp: draftedAt(1),
			previous: fromEmpty,
			workload: noWorkload,
			declared: noDeclarations,
			name: "installed"
		})
	)
	const second = schemaOf(
		r.roster,
		Arr.map(handles, (h, i) => r.to[i] ?? h),
		r.weighed
	)
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
