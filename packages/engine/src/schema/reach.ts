import { nominal } from "#compiler/core/brand.ts"
import type { Owned, OwnedLogin, OwnedWrite } from "#compiler/schema/own.ts"

declare const writeReachBrand: unique symbol

/**
 * The ordinary relations a law model serves the writes of: the relations its writers write, closed under what a write
 * of one relation writes of another. A write of a family's member writes its owner's count, ends and accumulators, and a
 * write of its owner writes its members, nested under an insert and rewritten by the owner axis's ON UPDATE CASCADE, so
 * a family's member and its owner are each other's reach, and a tree's relation its own. No write writes any other
 * relation: a foreign key cascades only on a family's owner axis, and a rule's trigger reads and never writes.
 *
 * An installation serves every role over its schema, so its reach is every ordinary relation (everyWrite); a login's
 * runtime serves its roles, which the database holds to their write lists (loginWrites).
 */
export type WriteReach = ReadonlySet<string> & { readonly [writeReachBrand]: true }

const writeReach = nominal<ReadonlySet<string>, WriteReach>()

/** Every ordinary relation of `owned`: the reach of its installation, which any role over it may write. */
export const everyWrite = (owned: Owned): WriteReach =>
	writeReach(
		new Set(Object.values(owned.relations).flatMap((r) => (r.kind === "relation" ? [r.name] : [])))
	)

/** The relation a role's write writes: its relation, or its query entry's target. */
const writtenBy = (write: OwnedWrite): string =>
	write.kind === "whole" ? write.relation.name : write.writable.target

/** Each ordinary relation of `owned` with the ordinary relations a write of it writes: its families' members and owners. */
const coupled = (owned: Owned): ReadonlyMap<string, ReadonlyArray<string>> => {
	const ordinary = (name: string): boolean => owned.relations[name]?.kind === "relation"
	const out = new Map<string, ReadonlyArray<string>>()
	for (const s of owned.statements) {
		if (
			(s.kind === "family" || s.kind === "tree") &&
			ordinary(s.member.relation) &&
			ordinary(s.slots.owner)
		) {
			out.set(s.member.relation, [...(out.get(s.member.relation) ?? []), s.slots.owner])
			out.set(s.slots.owner, [...(out.get(s.slots.owner) ?? []), s.member.relation])
		}
	}
	return out
}

/** The reach of a login's roles over its base: every relation one of them writes, closed (`WriteReach`). */
export const loginWrites = (login: OwnedLogin): WriteReach => {
	const writes = coupled(login.base)
	const reach = new Set(login.roles.flatMap((role) => [...role.writes.values()].map(writtenBy)))
	for (const relation of reach) {
		for (const other of writes.get(relation) ?? []) {
			reach.add(other)
		}
	}
	return writeReach(reach)
}
