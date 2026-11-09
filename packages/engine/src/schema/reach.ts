import { nominal } from "#compiler/core/brand.ts"
import type { ProgramDesc } from "#compiler/ir/desc.ts"
import type { Owned, OwnedRole, OwnedWrite } from "#compiler/schema/own.ts"
import { queryUses } from "#compiler/schema/walk.ts"

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
 * schema, so its slice is every relation (everySlice); a login's runtime serves the programs of its workloads, and
 * each program it compiles at a call outside them its own slice (sliceOf).
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

/** A program a slice serves, by its Description, with the role it is compiled for. */
export interface RoleProgram {
	readonly role: OwnedRole
	readonly program: ProgramDesc
}

/** The relations of the base a name a role's program reads stands for: a whole entry's relation, a query entry's
 * reads, or the base's own relation of a program over the base. */
const entryReads = (base: Owned, role: OwnedRole, name: string): ReadonlyArray<string> => {
	const entry = role.relations[name]
	if (entry === undefined) {
		return base.relations[name] === undefined ? [] : [name]
	}
	return entry.kind === "whole" ? [entry.relation.name] : entry.reads
}

/**
 * The slice of a set of programs over a base: each relation their ChangeSets' members write, each by its role's write
 * list, closed under family coupling (`Slice`); and each relation they read, write or apply, through their queries,
 * members and read-backs, as the base relations a role's entries stand for, a query entry a member writes through
 * standing for its reads too, closed under what a derived one's definition reads. A name is what the programs name and no more: the relations a compile over them needs besides, the
 * reads of the laws over a name and the rosters and closed relations its fields and laws apply, are the law model's
 * to compile without naming them.
 */
export const sliceOf = (base: Owned, programs: ReadonlyArray<RoleProgram>): Slice => {
	const written = new Set<string>()
	const named = new Set<string>()
	const name = (role: OwnedRole, relation: string): void => {
		for (const r of entryReads(base, role, relation)) {
			named.add(r)
		}
	}
	for (const { role, program } of programs) {
		if (program.kind === "query") {
			for (const r of queryUses(program.query).relations) {
				name(role, r)
			}
			continue
		}
		for (const member of program.changeSet.strata.flatMap((s) => s.members)) {
			const write = role.writes.get(member.relation)
			if (write !== undefined) {
				written.add(writtenBy(write))
				for (const r of write.kind === "rows" ? write.entry.reads : []) {
					named.add(r)
				}
			}
			name(role, member.relation)
			if (member.member.kind === "query") {
				for (const r of queryUses(member.member.query).relations) {
					name(role, r)
				}
			}
		}
		for (const read of program.changeSet.reads) {
			for (const r of queryUses(read.query).relations) {
				name(role, r)
			}
		}
	}
	const writes = coupled(base)
	for (const relation of written) {
		for (const other of writes.get(relation) ?? []) {
			written.add(other)
		}
	}
	for (const relation of written) {
		named.add(relation)
	}
	for (const relation of named) {
		const owned = base.relations[relation]
		for (const read of owned?.kind === "derived" ? owned.reads : []) {
			named.add(read)
		}
	}
	return slice({ writes: written, names: named })
}

/** Whether `outer` serves every compile `inner` does: it writes every relation `inner` writes and names every relation
 * it names, so a compile over `outer` reads, of each relation `inner` names, exactly what one over `inner` does. */
export const within = (inner: Slice, outer: Slice): boolean =>
	[...inner.writes].every((r) => outer.writes.has(r)) &&
	[...inner.names].every((r) => outer.names.has(r))
