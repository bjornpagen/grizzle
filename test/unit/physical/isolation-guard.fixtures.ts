/** What the properties of isolation-guard.test.ts read: its spaces, models and helpers. */

import { type Case } from "@bjornpagen/testing/explore"
import { array, element, type Gen, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"

export const relations = ["r0", "r1", "r2", "r3"] as const

type Relation = (typeof relations)[number]

const privileges: ReadonlyArray<TablePrivilege> = ["SELECT", "INSERT", "UPDATE", "DELETE"]

const levels: Arr.NonEmptyReadonlyArray<Isolation> = ["readCommitted", "serializable"]

/** One role of a case: its level, and the privileges it holds on each relation it holds any on. */
interface RoleCase {
	readonly level: Isolation
	readonly held: ReadonlyArray<readonly [Relation, ReadonlyArray<TablePrivilege>]>
}

const roleGen: Gen<RoleCase> = (source) => ({
	level: source.draw(element(levels)),
	held: Arr.flatMap(
		relations,
		(r): ReadonlyArray<readonly [Relation, ReadonlyArray<TablePrivilege>]> => {
			const held = source.draw(subarray(privileges))
			return held.length > 0 ? [[r, held]] : []
		}
	)
})

export const rolesGen: Gen<ReadonlyArray<RoleCase>> = array(roleGen, { min: 0, max: 4 })

const writing = (held: ReadonlyArray<TablePrivilege>): boolean =>
	Arr.some(held, (p) => p !== "SELECT")

/** The rule restated: whether `r`'s table takes no guard among `roles`. */
export const unguarded = (roles: ReadonlyArray<RoleCase>, r: Relation): boolean => {
	const writers = Arr.flatMap(roles, (role) =>
		Arr.flatMap(role.held, ([at, held]) =>
			at === r && writing(held) ? [{ level: role.level, held }] : []
		)
	)
	return (
		writers.length > 0 &&
		Arr.every(
			writers,
			(w) =>
				w.level === "readCommitted" && Arr.every(w.held, (p) => p === "SELECT" || p === "INSERT")
		)
	)
}

export type Feature =
	| "a relation no role holds"
	| "a relation a role only reads"
	| "a relation every writer of which inserts at READ COMMITTED"
	| "a relation two READ COMMITTED inserters write"
	| "a relation a SERIALIZABLE role writes"
	| "a relation a READ COMMITTED role updates or deletes"

export const noteRelation = (
	roles: ReadonlyArray<RoleCase>,
	r: Relation,
	c: Case<Feature>
): void => {
	const holders = Arr.flatMap(roles, (role) =>
		Arr.flatMap(role.held, ([at, held]) => (at === r ? [{ level: role.level, held }] : []))
	)
	const writers = Arr.filter(holders, (h) => writing(h.held))
	if (holders.length === 0) {
		c.note("a relation no role holds")
	} else if (writers.length === 0) {
		c.note("a relation a role only reads")
	} else if (unguarded(roles, r)) {
		c.note(
			writers.length > 1
				? "a relation two READ COMMITTED inserters write"
				: "a relation every writer of which inserts at READ COMMITTED"
		)
	} else if (Arr.some(writers, (w) => w.level === "serializable")) {
		c.note("a relation a SERIALIZABLE role writes")
	} else {
		c.note("a relation a READ COMMITTED role updates or deletes")
	}
}
