import { Array as Arr, Option, Order, Record as Rec } from "effect"
import type { ConstraintName } from "#compiler/core/ids.ts"
import { atMostOne, classifyEntry, writableSupplier } from "#test/support/worlds/model/host.ts"
import { relationSpecOf } from "#test/support/worlds/model/session/state.ts"
import type {
	BaseSpec,
	Fill,
	HeadField,
	InstalledNames,
	InstallSpec,
	RoleSpec,
	Rule,
	HostValue,
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

/** An at-most-one count capacity's unique index: the capacity's place among the base's laws, its source's fields and selector. */
export interface UniqueIndex {
	readonly law: number
	readonly fields: Arr.NonEmptyReadonlyArray<string>
	readonly where: Readonly<Record<string, HostValue>>
}

/** Whether every field of `inner` is among `outer`'s. */
const among = (inner: ReadonlyArray<string>, outer: ReadonlyArray<string>): boolean =>
	Arr.every(inner, (f) => outer.includes(f))

/**
 * The unique indexes of a relation that a query entry's precheck probes beside its keys, as grizzle orders them
 * (write/insert/unique.ts beyondKeys): the index of each at-most-one count capacity counting the relation's facts
 * (host.ts atMostOne), those without a selector before those with one, fewer fields first, each kept unless a key (its
 * every field among the index's) or an index without a selector kept before it (likewise) finds every collision it does.
 */
export const uniquesOf = (base: BaseSpec, relation: string): ReadonlyArray<UniqueIndex> => {
	const keys = keysOf(base, relation)
	const indexes = Arr.flatMap(base.laws, (l, law): ReadonlyArray<UniqueIndex> =>
		l.kind === "capacity" && atMostOne(l) && l.source.relation === relation
			? [{ law, fields: l.source.fields, where: l.source.where }]
			: []
	)
	const selects = (u: UniqueIndex): boolean => Rec.keys(u.where).length > 0
	const ordered = Arr.sort(
		indexes,
		Order.combine(
			Order.mapInput(Order.Boolean, selects),
			Order.mapInput(Order.Number, (u: UniqueIndex) => u.fields.length)
		)
	)
	const kept: Array<UniqueIndex> = []
	for (const u of ordered) {
		if (
			!Arr.some(keys, (k) => among(k, u.fields)) &&
			!Arr.some(kept, (c) => !selects(c) && among(c.fields, u.fields))
		) {
			kept.push(u)
		}
	}
	return kept
}

/**
 * The fields a unique index reads, a unique probe's parameters in order (physical/ddl/roles.ts): the fields it compares,
 * then each field its selector reads, in the relation's heading order (laws/model/plan.ts orderedSelection), each once.
 */
export const uniqueReads = (
	base: BaseSpec,
	relation: string,
	u: UniqueIndex
): ReadonlyArray<string> => {
	const heading = Arr.map(relationSpecOf(base, relation)?.fields ?? [], (f) => f.name)
	const selector = Arr.filter(heading, (f) => Rec.has(u.where, f))
	return [...new Set([...u.fields, ...selector])]
}

/** The installed name of a unique index, by its capacity's law (InstalledNames.uniqueIndexes). */
export const uniqueIndexOf = (names: InstalledNames, u: UniqueIndex): ConstraintName => {
	const ids = names.laws[u.law]
	const index =
		ids?.kind === "capacity" && Rec.has(names.uniqueIndexes, ids.law)
			? names.uniqueIndexes[ids.law]
			: undefined
	if (index === undefined) {
		throw new Error(`the installation names no unique index of law ${u.law}`)
	}
	return index
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

type UniqueProbe = Extract<WorldFunction, { readonly kind: "unique-probe" }>

/** A unique probe the installation defines: the relation it scans, and the unique index it tests there. */
export interface UniqueProbed {
	readonly target: string
	readonly unique: UniqueIndex
}

/**
 * A role's unique probe as the installation defines it (privileges.ts definedWorldFunctions): over the target of the
 * role's written query entry, testing the unique index at the probe's index in uniquesOf order. Undefined where the
 * installation defines no such probe: the entry is no written query entry, or its target has no unique index there.
 */
export const uniqueProbeOf = (
	base: BaseSpec,
	role: RoleSpec,
	fn: UniqueProbe
): UniqueProbed | undefined => {
	const w = writtenNamed(base, role, fn.entry)
	const unique = w?.kind === "query" ? uniquesOf(base, w.target)[fn.unique] : undefined
	return w === undefined || unique === undefined ? undefined : { target: w.target, unique }
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
