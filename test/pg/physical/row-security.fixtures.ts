/** What the properties of row-security.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { roleNameOf } from "#adapter/served/served.ts"
import { login } from "#compiler/program/workload/login.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { Id } from "#test/support/ids.ts"

/** How a role holds a relation: whole, or through a query entry fixing the shelf at 1 or at 2. */
type Holding = "whole" | "shelf 1" | "shelf 2"

/** What a role does with a relation: how it holds it, and whether it writes it. */
interface Use {
	readonly holds: Holding
	readonly writes: boolean
}

const relationNames = ["Note", "Card"] as const

export type RelationName = (typeof relationNames)[number]

export const roleNames = ["clerk", "keeper"] as const

type RoleName = (typeof roleNames)[number]

/** A version: each role's use of each relation. */
export type Uses = Readonly<Record<RoleName, Readonly<Record<RelationName, Use>>>>

const useGen: Gen<Use> = (source) => ({
	holds: source.draw(element<Holding>(["whole", "shelf 1", "shelf 2"])),
	writes: source.draw(boolean)
})

const usesGen: Gen<Uses> = (source) => ({
	clerk: { Note: source.draw(useGen), Card: source.draw(useGen) },
	keeper: { Note: source.draw(useGen), Card: source.draw(useGen) }
})

const historyGen: Gen<Arr.NonEmptyReadonlyArray<Uses>> = (source) =>
	nonEmpty(source.draw(array(usesGen, { min: 2, max: 3 })), "a history's versions")

/** What a hand does to each table under row security once the last version is migrated. */
type Planted = "disabled" | "forced"

/** A case: the versions migrated in turn, and the change by hand after the last. */
interface RowSecurityCase {
	readonly history: Arr.NonEmptyReadonlyArray<Uses>
	readonly planted: Planted
}

export const caseGen: Gen<RowSecurityCase> = (source) => ({
	history: source.draw(historyGen),
	planted: source.draw(element<Planted>(["disabled", "forced"]))
})

/** The version under the declared name `name`, each role holding and writing each relation as `uses` says. */
export const versionOf = (name: string, uses: Uses) => {
	const Note = relation("Note", { id: Id, shelf: pg.integer }, ["id"])
	const Card = relation("Card", { id: Id, shelf: pg.integer }, ["id"])
	const base = schema(name, [Note, Card], [])
	/** A relation's facts on one shelf, a query entry whose filter fixes the shelf. */
	const shelvedNote = (shelf: 1 | 2) =>
		query(base).rule((r) => {
			const { id } = v(Note, "note")
			return r.match(Note, { id, shelf }).find({ id })
		})
	const shelvedCard = (shelf: 1 | 2) =>
		query(base).rule((r) => {
			const { id } = v(Card, "card")
			return r.match(Card, { id, shelf }).find({ id })
		})
	/** A role's entry of a relation: the relation whole, or the query of its facts on one shelf. */
	const entryOf = (relationName: RelationName, holding: Holding): EntryValue => {
		switch (holding) {
			case "whole":
				return relationName === "Note" ? Note : Card
			case "shelf 1":
			case "shelf 2": {
				const shelf = holding === "shelf 1" ? 1 : 2
				return relationName === "Note" ? shelvedNote(shelf) : shelvedCard(shelf)
			}
		}
	}
	const roleOf = <N extends RoleName>(roleName: N) => {
		const entries: Record<string, EntryValue> = {}
		const writes: Array<string> = []
		for (const relationName of relationNames) {
			const use = uses[roleName][relationName]
			const entry = `${relationName}${use.holds === "whole" ? "" : "Shelved"}`
			entries[entry] = entryOf(relationName, use.holds)
			if (use.writes) {
				writes.push(entry)
			}
		}
		return role(base, roleName, entries, { write: writes, refresh: [] })
	}
	const clerk = roleOf("clerk")
	const keeper = roleOf("keeper")
	return {
		declared: name,
		schema: base,
		Note,
		Card,
		clerk,
		keeper,
		login: login(base, "desk", [clerk, keeper])
	}
}

export type Built = ReturnType<typeof versionOf>

/** A policy as the rule judges it: its table, its roles, and whether both its USING and its WITH CHECK admit every
 * row. */
export interface PolicySeen {
	readonly table: string
	readonly roles: ReadonlyArray<string>
	readonly holds: "every row" | "narrowed"
}

/** What one version's catalog holds of row security: the tables with it, sorted, and the policies. */
export interface Seen {
	readonly rowSecure: ReadonlyArray<string>
	readonly policies: ReadonlyArray<PolicySeen>
}

/**
 * What a version's catalog should hold: row security on each table some writer narrows, and there each writer's
 * policy, narrowed or TRUE; nothing on any other table.
 */
export const expectedAt = (uses: Uses, b: Built, tableOf: (r: RelationName) => string): Seen => {
	const secured = Arr.filter(relationNames, (r) =>
		Arr.some(roleNames, (who) => uses[who][r].writes && uses[who][r].holds !== "whole")
	)
	return {
		rowSecure: Arr.sort(Arr.map(secured, tableOf), Order.String),
		policies: Arr.flatMap(secured, (r) =>
			Arr.flatMap(roleNames, (who): ReadonlyArray<PolicySeen> =>
				uses[who][r].writes
					? [
							{
								table: tableOf(r),
								roles: [roleNameOf(who === "clerk" ? b.clerk : b.keeper, {})],
								holds: uses[who][r].holds === "whole" ? "every row" : "narrowed"
							}
						]
					: []
			)
		)
	}
}

export type RowSecurityFeature =
	| "a narrowed writer beside a whole one"
	| "a narrowed reader that writes nothing"
	| "row security added"
	| "row security dropped"
	| "a narrowed writer's filter changed"
	| `a changed table drifted, row security ${Planted}`
	| "no table changed"

export const secureds = (uses: Uses): ReadonlyArray<RelationName> =>
	Arr.filter(relationNames, (r) =>
		Arr.some(roleNames, (who) => uses[who][r].writes && uses[who][r].holds !== "whole")
	)

export const featuresOf = (
	history: Arr.NonEmptyReadonlyArray<Uses>
): ReadonlyArray<RowSecurityFeature> => [
	...(Arr.some(history, (uses) =>
		Arr.some(relationNames, (r) => {
			const writers = Arr.filter(roleNames, (who) => uses[who][r].writes)
			return (
				Arr.some(writers, (who) => uses[who][r].holds !== "whole") &&
				Arr.some(writers, (who) => uses[who][r].holds === "whole")
			)
		})
	)
		? ["a narrowed writer beside a whole one" as const]
		: []),
	...(Arr.some(history, (uses) =>
		Arr.some(roleNames, (who) =>
			Arr.some(relationNames, (r) => !uses[who][r].writes && uses[who][r].holds !== "whole")
		)
	)
		? ["a narrowed reader that writes nothing" as const]
		: []),
	...Arr.flatMap(
		Arr.zip<Uses, Uses>(history, Arr.drop(history, 1)),
		([was, now]): ReadonlyArray<RowSecurityFeature> => [
			...(Arr.some(secureds(now), (r) => !secureds(was).includes(r))
				? ["row security added" as const]
				: []),
			...(Arr.some(secureds(was), (r) => !secureds(now).includes(r))
				? ["row security dropped" as const]
				: []),
			...(Arr.some(roleNames, (who) =>
				Arr.some(
					relationNames,
					(r) =>
						was[who][r].writes &&
						now[who][r].writes &&
						was[who][r].holds !== "whole" &&
						now[who][r].holds !== "whole" &&
						was[who][r].holds !== now[who][r].holds
				)
			)
				? ["a narrowed writer's filter changed" as const]
				: [])
		]
	)
]
