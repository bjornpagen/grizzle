/** What the property of world-inputs.test.ts reads: its space, the schema's versions and the world steps they draft. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Slot } from "#compiler/deploy/diff/plan.ts"
import { draftMigration } from "#compiler/deploy/render/generate.ts"
import { emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { draftCodebook, noPreviousRosters } from "#compiler/ir/codes.ts"
import { noSpellings } from "#compiler/ir/pattern.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Logic } from "#compiler/public/compute.ts"
import { generated, pg } from "#compiler/public/fields.ts"
import { contained, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { installationsOf, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { owning } from "#test/support/policy.ts"

/**
 * What the second version changes of the first: nothing, or a containment of Item's `list` in List's key added, which
 * the law model discharges natively, a foreign key; each with the reader reading Item alone or Item and List.
 */
export interface Turn {
	readonly change: "none" | "a foreign key added" | "a generated field re-expressed"
	readonly reads: "Item" | "Item and List"
}

export const turnGen: Gen<Turn> = (s) => ({
	change: s.draw(
		element(["none", "a foreign key added", "a generated field re-expressed"] as const)
	),
	reads: s.draw(element(["Item", "Item and List"] as const))
})

/** The schema at a version, with its one login: List and Item, each keyed by its id, Item's `list` contained in List's
 * id where the version holds the foreign key, and its generated `g` its `n` where it exceeds `step`, 0 elsewhere; the reader reads Item, or
 * Item and List, whole. */
const installationOf = (turn: Turn, keyed: boolean, step: bigint): Installation => {
	const List = relation("List", { id: Id }, ["id"])
	const Item = relation.generated("Item", { id: Id, list: Id, n: pg.bigint }, ["id"], (r) => ({
		g: generated(pg.bigint, Logic.cond(Logic.gt(r.n, step), r.n, 0n))
	}))
	const base = schema(
		"WorldInputs",
		[List, Item],
		keyed ? [contained(on(Item, "list"), on(List, "id"))] : []
	)
	const reader =
		turn.reads === "Item" ? role(base, "reader", { Item }) : role(base, "reader", { Item, List })
	const desk = succeeded(
		ownLogin(defined(loginDescOf(login(base, "desk", [reader])), "a login built by login(...)"))
	)
	const owned = owning(base)
	const codes = draftCodebook(noPreviousRosters, new Map(), rostersOf(owned), noSpellings)
	assert.ok(codes.ok, "the version's rosters draw their codes")
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [desk], [], codes.value)
		)
	)
}

const drafted = (installation: Installation, previous: DeploySnapshot) => {
	const draft = draftMigration({
		previous,
		installation,
		workload: noWorkload,
		declared: noDeclarations,
		abandoned: []
	})
	if (!draft.ok) {
		return assert.fail(`the draft: ${draft.error.message}`)
	}
	return draft.value
}

/** The slots a migration drops the roles' world objects in and creates them again in (diff.ts dropWorlds, visit). */
const worldSlots: ReadonlySet<Slot> = new Set([
	"structure.drop",
	"structure.worlds",
	"publish.worlds"
])

/** What the second draft does: how many steps it drafts in all, and how many in the world objects' slots. */
export interface Drafted {
	readonly steps: number
	readonly worldSteps: number
}

/** The second version drafted over the first's snapshot, the first drafted from no installation. */
export const secondDraft = (turn: Turn): Drafted => {
	const first = installationOf(turn, false, 1n)
	const one = drafted(
		first,
		emptySnapshot({ schemaName: first.owned.name, schema: first.names.schema })
	)
	const two = drafted(
		installationOf(
			turn,
			turn.change === "a foreign key added",
			turn.change === "a generated field re-expressed" ? 2n : 1n
		),
		one.snapshot
	)
	return {
		steps: two.plan.steps.length,
		worldSteps: Arr.filter(two.plan.steps, (s) => worldSlots.has(s.slot)).length
	}
}
