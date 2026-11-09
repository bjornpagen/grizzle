import { nominal } from "#compiler/core/brand.ts"
import type { Owned, OwnedLogin, OwnedWrite } from "#compiler/schema/own.ts"

declare const sliceBrand: unique symbol

/** A slice's two sets, before reach.ts mints them as one (`Slice`). */
interface SliceSets {
	readonly writes: ReadonlySet<string>
	readonly names: ReadonlySet<string>
}

/**
 * What a law model is compiled for: the relations whose writes it serves and the relations its compiles name, each by
 * its declared name in the base.
 *
 * `writes` holds the ordinary relations its writers write, closed under what a write of one relation writes of another.
 * A write of a family's member writes its owner's count, ends and accumulators, and a write of its owner writes its
 * members, nested under an insert and rewritten by the owner axis's ON UPDATE CASCADE, so a family's member and its
 * owner are in it together, and a tree's relation alone. No write writes any other relation: a foreign key cascades
 * only on a family's owner axis, and a rule's trigger reads and never writes.
 *
 * `names` holds `writes` and every relation a compile over the slice names. An installation serves every role over its
 * schema, so its slice is every relation (everySlice); a login's runtime serves its roles, which the database holds to
 * their write lists, and names every relation of its base (loginSlice).
 */
export type Slice = SliceSets & { readonly [sliceBrand]: true }

const slice = nominal<SliceSets, Slice>()

/** Every relation of `owned`, each ordinary one written: the slice of its installation, which any role may write. */
export const everySlice = (owned: Owned): Slice =>
	slice({
		writes: new Set(
			Object.values(owned.relations).flatMap((r) => (r.kind === "relation" ? [r.name] : []))
		),
		names: new Set(Object.keys(owned.relations))
	})

/** The relation a role's write writes: its relation, or its query entry's target. */
const writtenBy = (write: OwnedWrite): string =>
	write.kind === "whole" ? write.relation.name : write.writable.target

/** Each ordinary relation of `owned` with the ordinary relations a write of it writes: its families' members and
 * owners. */
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

/** The slice of a login's roles over its base: every relation one of them writes, closed (`Slice`), and every
 * relation of the base named. */
export const loginSlice = (login: OwnedLogin): Slice => {
	const writes = coupled(login.base)
	const written = new Set(login.roles.flatMap((role) => [...role.writes.values()].map(writtenBy)))
	for (const relation of written) {
		for (const other of writes.get(relation) ?? []) {
			written.add(other)
		}
	}
	return slice({ writes: written, names: new Set(Object.keys(login.base.relations)) })
}
