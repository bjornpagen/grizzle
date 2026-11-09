import { Array as Arr, Option, Record as Rec } from "effect"
import { classifyEntry, writableSupplier } from "#test/support/worlds/model/host.ts"
import { relationSpecOf } from "#test/support/worlds/model/session/state.ts"
import type {
	BaseSpec,
	Fill,
	HeadField,
	InstalledRole,
	InstallSpec,
	ModelState,
	RoleSpec,
	Rule,
	WorldFunction
} from "#test/support/worlds/model/types.ts"

/**
 * A role relation in the role's write list, as README "Writing through a role" defines it: a whole entry, written as
 * its relation itself, or a writable query entry, whose one rule's supplier carries the head fields and whose fixed
 * fields are filled from literals and claims. An entry the writable-entry rule refuses writes nothing.
 */
export type Written =
	| { readonly kind: "whole"; readonly entry: string; readonly target: string }
	| {
			readonly kind: "query"
			readonly entry: string
			readonly target: string
			readonly rules: Arr.NonEmptyReadonlyArray<Rule>
			/** Each head field, the target field it supplies and its standing. */
			readonly head: Readonly<Record<string, HeadField>>
			readonly fills: Readonly<Record<string, Fill>>
	  }

/**
 * Whether a written query entry's membership reads a stored relation besides its target's row, so a SECURITY DEFINER
 * filter function serves its policy: a match or a negation of an ordinary or derived relation beside the supplying
 * occurrence (a roster is inlined as literals, a context is the session's).
 */
export const filterReadsStored = (rules: Arr.NonEmptyReadonlyArray<Rule>): boolean => {
	const [rule] = rules
	return (
		Arr.filter(
			[...rule.matches, ...rule.negations.flat()],
			(o) => o.source.kind === "ordinary" || o.source.kind === "derived"
		).length > 1
	)
}

/**
 * A written relation's serial head fields, by how an insertion treats them (README "Writes", "Writing through a role"):
 * `classed`, those a fact may leave out for the identity to draw, all of them or none, a whole entry's every serial
 * field and a query entry's every head field writing a serial field its filter does not read; and `filtered`, a query
 * entry's head fields writing a serial field its filter reads, which every inserted fact carries, since the fact is
 * checked against the filter before its identity is drawn. A variable the filter reads is one another match, a negation
 * or a comparison of the entry's rule names.
 */
export const serialHead = (
	base: BaseSpec,
	w: Written
): { readonly classed: ReadonlyArray<string>; readonly filtered: ReadonlyArray<string> } => {
	const fields = relationSpecOf(base, w.target)?.fields ?? []
	const serial = (field: string): boolean =>
		Arr.some(fields, (f) => f.name === field && f.domain.kind === "serial")
	if (w.kind === "whole") {
		return {
			classed: Arr.filter(
				Arr.map(fields, (f) => f.name),
				serial
			),
			filtered: []
		}
	}
	const supplied = writableSupplier(base, w.rules)
	const reads = new Set<string>()
	if (supplied !== undefined) {
		const { rule, supplier } = supplied
		const named = (t: Rule["head"][string]): ReadonlyArray<string> =>
			t.kind === "var" ? [t.name] : []
		const occurrences = [
			...Arr.filter(rule.matches, (_, i) => i !== supplier),
			...rule.negations.flat()
		]
		for (const o of occurrences) {
			for (const t of Rec.values(o.fields)) {
				for (const v of named(t)) {
					reads.add(v)
				}
			}
		}
		for (const c of rule.comparisons) {
			for (const v of [...named(c.left), ...named(c.right)]) {
				reads.add(v)
			}
		}
	}
	const supplierFields =
		supplied === undefined ? {} : (supplied.rule.matches[supplied.supplier]?.fields ?? {})
	const serialHeads = Arr.filter(Rec.toEntries(w.head), ([, h]) => serial(h.field))
	const readByFilter = (field: string): boolean => {
		const t = supplierFields[field]
		return t?.kind === "var" && reads.has(t.name)
	}
	return {
		classed: Arr.flatMap(serialHeads, ([head, h]) => (readByFilter(h.field) ? [] : [head])),
		filtered: Arr.flatMap(serialHeads, ([head, h]) => (readByFilter(h.field) ? [head] : []))
	}
}

/** Every relation a role writes, in its write list's order. */
export const writtenOf = (base: BaseSpec, role: RoleSpec): ReadonlyArray<Written> =>
	Arr.flatMap(role.write, (name): ReadonlyArray<Written> => {
		const entry = Rec.has(role.entries, name) ? role.entries[name] : undefined
		if (entry === undefined) {
			return []
		}
		if (entry.kind === "whole") {
			return relationSpecOf(base, entry.relation) === undefined
				? []
				: [{ kind: "whole", entry: name, target: entry.relation }]
		}
		const classified = classifyEntry(base, entry)
		return classified.kind === "writable"
			? [
					{
						kind: "query",
						entry: name,
						target: classified.target,
						rules: entry.rules,
						head: classified.head,
						fills: classified.fills
					}
				]
			: []
	})

/**
 * Each role of an installation as its base classes it (InstalledRole): its entries classed and its writes, computed once
 * for the installation a state holds, so no call classes an entry again.
 */
export const installedRoles = (install: InstallSpec): Readonly<Record<string, InstalledRole>> =>
	Rec.fromEntries(
		Arr.map(install.roles, (role) => [
			role.name,
			{
				entries: Arr.map(Rec.toEntries(role.entries), ([name, entry]) => ({
					name,
					entry,
					classified: classifyEntry(install.base, entry),
					supply: entry.kind === "query" ? writableSupplier(install.base, entry.rules) : undefined
				})),
				written: writtenOf(install.base, role)
			}
		])
	)

/** A role of the state's installation as its base classes it; a role the installation does not hold is the caller's defect. */
export const installedRole = (state: ModelState, role: string): InstalledRole => {
	const found = state.roles[role]
	if (found === undefined) {
		throw new Error(`the installation holds no role ${role}`)
	}
	return found
}

/** The installed role's write of a base relation, or undefined when the role writes none of it (writtenAt). */
export const installedWrite = (
	state: ModelState,
	role: string,
	relation: string
): Written | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(installedRole(state, role).written, (w) => w.target === relation)
	)

/**
 * Whether grizzle refuses to build an installation (README "Writing through a role"): a role's write list names a
 * relation the role does not hold, a whole entry over no ordinary relation, an entry the writable-entry rule refuses, or
 * two entries over one relation. The role's definition throws as it is built, before anything reaches the database.
 */
export const refusedAtBuild = (install: InstallSpec): boolean =>
	Arr.some(install.roles, (role) => {
		const written = writtenOf(install.base, role)
		return (
			written.length < role.write.length ||
			new Set(Arr.map(written, (w) => w.target)).size < written.length
		)
	})

/** The role relation a role writes a base relation through, or undefined when it writes none of it. */
export const writtenAt = (base: BaseSpec, role: RoleSpec, relation: string): Written | undefined =>
	Option.getOrUndefined(Arr.findFirst(writtenOf(base, role), (w) => w.target === relation))

/** The written role relation of that name, or undefined when the write list has no such writable entry. */
export const writtenNamed = (base: BaseSpec, role: RoleSpec, entry: string): Written | undefined =>
	Option.getOrUndefined(Arr.findFirst(writtenOf(base, role), (w) => w.entry === entry))

/** A relation's keys: its primary key, then every candidate key and span key a law declares on it, in declared field order. */
export const keysOf = (
	base: BaseSpec,
	relation: string
): ReadonlyArray<Arr.NonEmptyReadonlyArray<string>> => {
	const spec = relationSpecOf(base, relation)
	return [
		...(spec === undefined ? [] : [spec.key]),
		...Arr.flatMap(base.laws, (l): ReadonlyArray<Arr.NonEmptyReadonlyArray<string>> => {
			if (l.kind === "key" && l.relation === relation) {
				return [l.fields]
			}
			if (l.kind === "spanKey" && l.relation === relation) {
				return [Arr.append(l.scalars, l.span)]
			}
			return []
		})
	]
}

/** A key probe the installation defines: the relation it scans, and the key it tests there. */
interface Probe {
	readonly target: string
	readonly key: Arr.NonEmptyReadonlyArray<string>
}

type KeyProbe = Extract<WorldFunction, { readonly kind: "key-probe" }>

/**
 * A role's key probe as the installation defines it (privileges.ts definedWorldFunctions): over the target of the role's
 * written query entry, testing the target's key at the probe's index in keysOf order. Undefined where the installation
 * defines no such probe: the entry is no written query entry, or its target has no key at that index.
 */
export const probeOf = (base: BaseSpec, role: RoleSpec, fn: KeyProbe): Probe | undefined => {
	const w = writtenNamed(base, role, fn.entry)
	const key = w?.kind === "query" ? keysOf(base, w.target)[fn.key] : undefined
	return w === undefined || key === undefined ? undefined : { target: w.target, key }
}

/** The target fields a written relation's claims fix: a query entry's claim-fixed head fields (HeadField). */
export const claimFixedFields = (w: Written): ReadonlyArray<string> =>
	w.kind === "query"
		? Arr.flatMap(Rec.values(w.head), (h) => (h.kind === "claimFixed" ? [h.field] : []))
		: []

/**
 * The target fields a writer may UPDATE in place: none of an immutable relation; every field through a whole entry of a
 * mutable one; through a query entry, its free head fields, never a fixed one, one in a key, or one a claim fixes.
 */
export const updatableFields = (base: BaseSpec, w: Written): ReadonlyArray<string> => {
	const relation = relationSpecOf(base, w.target)
	if (relation === undefined || relation.mutability === "immutable") {
		return []
	}
	if (w.kind === "whole") {
		return Arr.map(relation.fields, (f) => f.name)
	}
	return Arr.flatMap(Rec.values(w.head), (h) => (h.kind === "free" ? [h.field] : []))
}
