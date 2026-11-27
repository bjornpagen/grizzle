import {
	boundRowsLoc,
	boundRowsQuery,
	type ProgramDesc,
	type QueryDesc,
	unclocked
} from "#compiler/ir/desc.ts"
import type { Owned, OwnedRole, OwnedWrite } from "#compiler/schema/own.ts"
import { closedImportsOf, queryUses, readsOf } from "#compiler/schema/walk.ts"

/** The relation a role's write writes: its relation, or its query entry's target. */
const writtenBy = (write: OwnedWrite): string => {
	switch (write.kind) {
		case "whole":
			return write.relation.name
		case "rows":
			return write.writable.target
	}
}

/** Each ordinary relation of `owned` with the ordinary relations a write of it writes: its families' members and
 * owners. */
const coupled = (owned: Owned): ReadonlyMap<string, ReadonlyArray<string>> => {
	const ordinary = (name: string): boolean => owned.relations[name]?.kind === "relation"
	const out = new Map<string, Array<string>>()
	for (const s of owned.statements) {
		if (
			(s.kind === "family" || s.kind === "tree") &&
			ordinary(s.member.relation) &&
			ordinary(s.slots.owner)
		) {
			out.getOrInsertComputed(s.member.relation, () => []).push(s.slots.owner)
			out.getOrInsertComputed(s.slots.owner, () => []).push(s.member.relation)
		}
	}
	return out
}

/**
 * The relations a write of the ordinary relations `written` changes: they, closed under what a write of one writes of
 * another (`coupled`), a family member's count, ends and accumulators on its owner and an owner's copies its members'
 * owner axis cascades by ON UPDATE CASCADE, however long the chain. No other foreign key cascades, so no write changes
 * any other relation: what a footprint names of its writes, and what a login's compiled writes can raise a law of.
 */
export const writesOf = (base: Owned, written: Iterable<string>): ReadonlySet<string> => {
	const writes = coupled(base)
	const out = new Set(written)
	for (const relation of out) {
		for (const other of writes.get(relation) ?? []) {
			out.add(other)
		}
	}
	return out
}

/** A program of a footprint, by its Description, with the role it is compiled for. */
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

/** The queries a program reads: a read's query, and a ChangeSet's members' and read-backs'. */
const programQueries = (described: ProgramDesc): ReadonlyArray<QueryDesc> => {
	const program = unclocked(described)
	if (program.kind === "query" || program.kind === "answered") {
		return [program.query]
	}
	return [
		...program.changeSet.strata
			.flatMap((s) => s.members)
			.flatMap((m) => (m.member.kind === "query" ? [m.member.query] : [])),
		...program.changeSet.reads.map((r) => r.query)
	]
}

/**
 * Whether a name a role's program reads is the base's own relation as the base names it: a relation of the base the role
 * holds no entry for, or the relation a whole entry of the same name stands for. A query over such names alone is a
 * query of the base's, which the base's checked schema reads as the program does.
 */
const baseSpelled = (role: OwnedRole, name: string): boolean => {
	const entry = role.relations[name]
	return entry === undefined
		? role.base.relations[name] !== undefined
		: entry.kind === "whole" && entry.relation.name === name
}

/**
 * The closed imports of `programs`, which the checked schema of an installation that serves them admits as canonical
 * relations beside its definitions' (analysis/schema.ts checkedReality `served`), so a statement of those programs reads
 * the table of each one stored in its place, and a program's read computes no closed derivation its installation could
 * hold: each query one of them imports under an empty bind map, at any depth of its queries (schema/walk.ts
 * closedImportsOf), that reads only the base's own relations as the base names them (`baseSpelled`), each Description
 * object once, in the programs' order, every import before the imports that read it. An import over a query entry of
 * its role reads the rows the role's claims select, no relation of the schema's.
 */
export const servedImportsOf = (programs: ReadonlyArray<RoleProgram>): ReadonlySet<QueryDesc> => {
	const out = new Set<QueryDesc>()
	for (const { role, program } of programs) {
		for (const query of programQueries(program)) {
			for (const imported of closedImportsOf(query)) {
				if (!out.has(imported) && readsOf(imported).every((r) => baseSpelled(role, r))) {
					out.add(imported)
				}
			}
		}
	}
	return out
}

/**
 * The footprint of a set of programs over a base, the relations they name: each relation their ChangeSets' members
 * write, each by its role's write list, closed under family coupling (writesOf); and each relation they read, write or
 * apply, through their queries, members and read-backs, a read-back's delta sources' relations among them, as the base
 * relations a role's entries stand for, a query entry a member writes through standing for its reads too, closed under
 * what a derived one's definition reads. A name is what the programs name and no more: the relations a compile over
 * them needs besides, the reads of the laws over a name and the rosters and closed relations its fields and laws apply,
 * are the law model's to compile without naming them.
 */
export const footprintOf = (
	base: Owned,
	programs: ReadonlyArray<RoleProgram>
): ReadonlySet<string> => {
	const written = new Set<string>()
	const named = new Set<string>()
	const name = (role: OwnedRole, relation: string): void => {
		for (const r of entryReads(base, role, relation)) {
			named.add(r)
		}
	}
	for (const { role, program: described } of programs) {
		const program = unclocked(described)
		if (program.kind === "query" || program.kind === "answered") {
			for (const r of queryUses(program.query).relations) {
				name(role, r)
			}
			continue
		}
		for (const member of program.changeSet.strata.flatMap((s) => s.members)) {
			const write = role.writes.get(member.relation)
			if (write !== undefined) {
				written.add(writtenBy(write))
				for (const r of write.kind === "whole" ? [] : write.entry.reads) {
					named.add(r)
				}
			}
			name(role, member.relation)
			if (member.member.kind === "query") {
				const uses = queryUses(member.member.query)
				for (const r of [...uses.relations, ...uses.deltas]) {
					name(role, r)
				}
			}
		}
		for (const read of program.changeSet.reads) {
			const uses = queryUses(read.query)
			for (const r of [...uses.relations, ...uses.deltas]) {
				name(role, r)
			}
		}
		for (const [bound, { rows }] of Object.entries(program.changeSet.boundRows)) {
			for (const r of queryUses(boundRowsQuery(bound, rows, boundRowsLoc(bound))).relations) {
				name(role, r)
			}
		}
	}
	for (const relation of writesOf(base, written)) {
		named.add(relation)
	}
	return definitionsClosed(base, named)
}

/** The relations `names` name, closed under what a derived one's definition reads, however deep. */
const definitionsClosed = (base: Owned, names: Iterable<string>): ReadonlySet<string> => {
	const out = new Set(names)
	for (const relation of out) {
		const owned = base.relations[relation]
		for (const read of owned?.kind === "derived" ? owned.reads : []) {
			out.add(read)
		}
	}
	return out
}

/**
 * The relations of the base whose facts a read of the names `read` depends on: each name's relations of the base, a
 * role's entry's (`entryReads`) where the read is `role`'s, none for reality's, closed under what a derived one's
 * definition reads (`definitionsClosed`). A read of them in two states agrees wherever no write between the two writes
 * one of them (`writesOf`): the facts of every other relation, the call's inputs, its claims and its clock are the
 * same in every state of one call.
 */
export const readsThrough = (
	base: Owned,
	role: OwnedRole | undefined,
	read: Iterable<string>
): ReadonlySet<string> =>
	definitionsClosed(
		base,
		[...read].flatMap((name) => (role === undefined ? [name] : entryReads(base, role, name)))
	)
