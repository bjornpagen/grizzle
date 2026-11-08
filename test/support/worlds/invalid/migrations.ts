import { element, filter, map } from "@grizzle/testing/gen"
import { Array as Arr, Option, Predicate, Record } from "effect"
import { maxOf } from "#compiler/core/array.ts"
import { conversionOf } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { violations } from "#test/support/laws/model.ts"
import { sameDomain } from "#test/support/worlds/generate/domain.ts"
import { installGen, plantedInstallGen } from "#test/support/worlds/generate/install.ts"
import { lawIdsOf } from "#test/support/worlds/invalid/catalog.ts"
import type { Strata } from "#test/support/worlds/invalid/kinds.ts"
import { classifyEntry, hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { draftedFrom, factsIn, samePlain } from "#test/support/worlds/model/session/state.ts"
import type {
	BaseSpec,
	FieldSpec,
	InstallSpec,
	InvalidKind,
	LawIds,
	LawSpec,
	MigrationHow,
	ModelState,
	RelationSpec,
	RoleSpec
} from "#test/support/worlds/model/types.ts"

/**
 * Whether the reality violates a law as the host law model reads it, the law alone over the state's base: a law over
 * relations the base lacks reads nothing and is never violated here. The law identity is a stand-in, one the
 * installation already holds, since only whether some fact violates the law is asked.
 */
const violatedBy = (state: ModelState, law: LawSpec): boolean => {
	const base = state.install.base
	const relations = relationsOf(law)
	if (!Arr.every(relations, (r) => Arr.some(base.relations, (x) => x.name === r))) {
		return false
	}
	const [standIn] = lawIdsOf(state)
	return (
		violations(
			hostSchemaOf({ ...base, laws: [law] }, { ...state.names, laws: [standInsOf(law, standIn)] }),
			state.reality
		).length > 0
	)
}

/** Identities of a law's own shape, every one the stand-in. */
const standInsOf = (law: LawSpec, standIn: LawId): LawIds => {
	switch (law.kind) {
		case "key":
		case "spanKey":
		case "check":
		case "contained":
		case "covered":
			return { kind: law.kind, law: standIn }
		case "alternatives":
			return {
				kind: "alternatives",
				arms: Record.fromEntries(
					Arr.map(Record.keys(law.arms), (handle) => [handle, standIn] as const)
				),
				reverse: Record.fromEntries(
					Arr.map(Record.keys(law.arms), (handle) => [handle, standIn] as const)
				)
			}
	}
}

/** The relations a declared law reads. */
const relationsOf = (law: LawSpec): ReadonlyArray<string> => {
	switch (law.kind) {
		case "key":
		case "spanKey":
		case "check":
		case "alternatives":
			return [law.relation]
		case "contained":
		case "covered":
			return [law.source.relation, law.target.relation]
	}
}

/**
 * Whether a law would take an identity a law of the base already holds: grizzle names a containment's foreign key by
 * its source relation and fields, a key's constraint by its relation and fields, and a check by its relation and its
 * declared name's conversion, and refuses two laws of one identity when it compiles the installation
 * (IdentifierCollision); any other law is taken by an equal one.
 */
export const takenIdentity = (base: BaseSpec, law: LawSpec): boolean => {
	switch (law.kind) {
		case "contained":
		case "covered":
			return Arr.some(
				base.laws,
				(old) =>
					(old.kind === "contained" || old.kind === "covered") &&
					old.source.relation === law.source.relation &&
					samePlain(old.source.fields, law.source.fields)
			)
		case "key":
			return (
				Arr.some(base.relations, (r) => r.name === law.relation && samePlain(r.key, law.fields)) ||
				Arr.some(
					base.laws,
					(old) =>
						old.kind === "key" && old.relation === law.relation && samePlain(old.fields, law.fields)
				)
			)
		case "check":
			return Arr.some(
				base.laws,
				(old) =>
					old.kind === "check" &&
					old.relation === law.relation &&
					conversionOf(old.name) === conversionOf(law.name)
			)
		case "spanKey":
		case "alternatives":
			return Arr.some(base.laws, (old) => samePlain(old, law))
	}
}

/**
 * The declared name of a new row check over a relation: its stem and the count of the relation's checks, a name of a
 * few bytes whatever the relation and its fields are named, so it fits PostgreSQL's identifier limit as a declared name
 * must; one a check of the relation already takes leaves its law to takenIdentity.
 */
const newCheckName = (base: BaseSpec, relation: string, stem: "Below" | "AtMost"): string =>
	`${stem}${Arr.filter(base.laws, (law) => law.kind === "check" && law.relation === relation).length}`

/**
 * New laws over the base's relations, each of an identity no law of the base holds: a key over one field; a row check
 * holding an integer field below each value a fact holds there, which that fact fails, and at most the largest, which
 * every fact meets, each named by newCheckName; and a containment of one relation's field in another's single-field
 * key. At most one fact of a relation per fact of another is the key over one field (fin.md §6), among the keys.
 */
const newLaws = (state: ModelState): ReadonlyArray<LawSpec> => {
	const base = state.install.base
	const keys = Arr.flatMap(base.relations, (r) =>
		Arr.map(
			Arr.filter(r.fields, (f) => !r.key.includes(f.name) || r.key.length > 1),
			(f): LawSpec => ({ kind: "key", relation: r.name, fields: [f.name] })
		)
	)
	const checks = Arr.flatMap(base.relations, (r) =>
		Arr.flatMap(r.fields, (f): ReadonlyArray<LawSpec> => {
			if (f.domain.kind !== "integer") {
				return []
			}
			const held = Arr.flatMap(state.reality.get(r.name) ?? [], (fact) => {
				const v = fact[f.name]
				return typeof v === "number" ? [v] : []
			})
			const below = Arr.map(held, (v): LawSpec => ({
				kind: "check",
				name: newCheckName(base, r.name, "Below"),
				relation: r.name,
				predicate: { kind: "compare", field: f.name, op: "<", value: v }
			}))
			const [first, ...rest] = held
			return first === undefined
				? below
				: [
						...below,
						{
							kind: "check",
							name: newCheckName(base, r.name, "AtMost"),
							relation: r.name,
							predicate: {
								kind: "compare",
								field: f.name,
								op: "<=",
								value: maxOf(rest, first)
							}
						}
					]
		})
	)
	const containments = Arr.flatMap(base.relations, (s) =>
		Arr.flatMap(s.fields, (f) =>
			Arr.flatMap(
				Arr.filter(base.relations, (t) => t.name !== s.name),
				(t: RelationSpec) =>
					Arr.map(
						Arr.filter(
							t.fields,
							(g) => sameDomain(g.domain, f.domain) && t.key.length === 1 && t.key[0] === g.name
						),
						(g: FieldSpec): LawSpec => ({
							kind: "contained",
							source: { relation: s.name, fields: [f.name], where: {} },
							target: { relation: t.name, fields: [g.name], where: {} }
						})
					)
			)
		)
	)
	return Arr.filter([...keys, ...checks, ...containments], (law) => !takenIdentity(base, law))
}

/** The new laws (newLaws) the reality violates: each a law a migration may declare over data that breaks it. */
export const violatingLaws = (state: ModelState): ReadonlyArray<LawSpec> =>
	Arr.filter(newLaws(state), (law) => violatedBy(state, law))

/**
 * The new laws (newLaws) the reality keeps: each a law a migration may declare over data that holds it, which lands
 * with the installation's roles and logins kept, so a program goes on acting as them.
 */
const keptLaws = (state: ModelState): ReadonlyArray<LawSpec> =>
	Arr.filter(newLaws(state), (law) => !violatedBy(state, law))

/** The invalid kinds of an installation's write lists: an entry the writable rule refuses, two entries over one relation. */
export const installKinds = (install: InstallSpec): ReadonlyArray<InvalidKind> => [
	...new Set(Arr.flatMap(install.roles, (role) => writeListKinds(install, role)))
]

/** The invalid kinds of one role's write list, its entries judged in order. */
const writeListKinds = (install: InstallSpec, role: RoleSpec): ReadonlyArray<InvalidKind> => {
	const classes = Arr.map(role.write, (name) =>
		Option.map(
			Option.fromUndefinedOr(Record.has(role.entries, name) ? role.entries[name] : undefined),
			(entry) => classifyEntry(install.base, entry)
		)
	)
	const targets = Arr.flatMap(classes, (c) =>
		Option.isSome(c) && c.value.kind === "writable" ? [c.value.target] : []
	)
	return [
		...(Arr.some(classes, (c) => Option.isNone(c) || c.value.kind === "read-only")
			? (["install:unwritable-write"] as const)
			: []),
		...(new Set(targets).size < targets.length
			? (["install:two-writes-one-relation"] as const)
			: [])
	]
}

/**
 * The roster kinds of a migration from a state: a roster of the installation it lands that leaves out a handle some
 * stored fact holds, or that declares two handles it keeps in the other order.
 */
const rosterKinds = (state: ModelState, to: InstallSpec): ReadonlyArray<InvalidKind> => {
	const changed = Arr.flatMap(to.base.closed, (c) => {
		const was = Arr.findFirst(state.install.base.closed, (b) => b.name === c.name)
		return Option.isSome(was) ? [{ name: c.name, was: was.value.members, now: c.members }] : []
	})
	const removedHeld = Arr.some(changed, (c) =>
		Arr.some(c.was, (m) => !c.now.includes(m) && holds(state, c.name, m))
	)
	const reordered = Arr.some(changed, (c) => {
		const kept = Arr.filter(c.was, (m) => c.now.includes(m))
		const declared = Arr.filter(c.now, (m) => c.was.includes(m))
		return Arr.some(kept, (m, i) => declared[i] !== m)
	})
	return [
		...(removedHeld ? (["migration:roster-removal-held"] as const) : []),
		...(reordered ? (["migration:roster-reorder"] as const) : [])
	]
}

/**
 * The invalid kinds of a migration from a state: how it lands, the installation it lands, its rosters' changes, and a
 * new law the data breaks.
 */
export const migrationKinds = (
	state: ModelState,
	to: InstallSpec,
	how: MigrationHow
): ReadonlyArray<InvalidKind> => [
	...(how === "complete"
		? []
		: [
				how === "half-applied"
					? ("migration:half-applied" as const)
					: ("migration:hand-edited" as const)
			]),
	...installKinds(to),
	...rosterKinds(state, to),
	...(Arr.some(
		to.base.laws,
		(law) => !state.install.base.laws.includes(law) && violatedBy(state, law)
	)
		? ["migration:law-over-violating-data" as const]
		: [])
]

/** A handle no roster of any base the generators draw holds: a growth's new member. */
const grownHandle = (members: ReadonlyArray<string>): string => {
	let n = members.length
	while (members.includes(`grown${n}`)) {
		n += 1
	}
	return `grown${n}`
}

/** Whether some stored fact holds `handle` in a field of roster `roster`. */
const holds = (state: ModelState, roster: string, handle: string): boolean =>
	Arr.some(state.install.base.relations, (r) =>
		Arr.some(
			r.fields,
			(f) =>
				f.domain.kind === "handle" &&
				f.domain.closed === roster &&
				Arr.some(factsIn(state.reality, r.name), (fact) => fact[f.name] === handle)
		)
	)

/**
 * Whether the installation names `handle` of `roster` anywhere but its roster: a handle literal (`{kind: "handle",
 * closed, member}`) in a law, a rule or a role's entry, a match of the roster itself whose field is the handle's literal
 * (generate/install.ts's closed filter, `{source: {kind: "closed", name}, fields: {id: {kind: "literal", value}}}`), or
 * an alternatives law's arm. A removal leaves such a handle alone, a harness invariant: the installation it would leave
 * names a handle its roster no longer holds, which the builders refuse before any migration is drafted.
 */
const mentioned = (install: InstallSpec, roster: string, handle: string): boolean => {
	const walk = (value: unknown): boolean => {
		if (Arr.isArray(value)) {
			return Arr.some(value, walk)
		}
		if (!Predicate.isObject(value)) {
			return false
		}
		if (value["kind"] === "handle" && value["closed"] === roster && value["member"] === handle) {
			return true
		}
		const source = value["source"]
		const fields = value["fields"]
		if (
			Predicate.isObject(source) &&
			source["kind"] === "closed" &&
			source["name"] === roster &&
			Predicate.isObject(fields) &&
			Arr.some(
				Record.values(fields),
				(term) => Predicate.isObject(term) && term["kind"] === "literal" && term["value"] === handle
			)
		) {
			return true
		}
		const arms = value["arms"]
		if (
			value["kind"] === "alternatives" &&
			value["closed"] === roster &&
			Predicate.isObject(arms) &&
			Record.has(arms, handle)
		) {
			return true
		}
		return Arr.some(Record.values(value), walk)
	}
	return walk({ ...install, base: { ...install.base, closed: [] } })
}

/** The base with roster `roster`'s handles declared as `members`. */
const withMembers = (
	base: BaseSpec,
	roster: string,
	members: Arr.NonEmptyReadonlyArray<string>
): BaseSpec => ({
	...base,
	closed: Arr.map(base.closed, (c) => (c.name === roster ? { ...c, members } : c))
})

/** One migration of a roster, by what it changes: its handles in the order the migrated base declares them. */
interface RosterChange {
	readonly roster: string
	readonly members: Arr.NonEmptyReadonlyArray<string>
}

/**
 * The roster changes from a state, each by construction: a growth appends a handle no roster holds; a removal leaves
 * out a handle the base names nowhere else (mentioned), held by some stored fact or by none; a reorder swaps two
 * adjacent handles, which D1 refuses.
 */
const rosterChanges = (
	state: ModelState
): {
	readonly grown: ReadonlyArray<RosterChange>
	readonly unheld: ReadonlyArray<RosterChange>
	readonly held: ReadonlyArray<RosterChange>
	readonly reordered: ReadonlyArray<RosterChange>
} => {
	const closed = state.install.base.closed
	const removals = Arr.flatMap(closed, (c) =>
		Arr.flatMap(
			Arr.filter(c.members, (m) => !mentioned(state.install, c.name, m)),
			(m: string): ReadonlyArray<{ readonly change: RosterChange; readonly held: boolean }> => {
				const kept = Arr.filter(c.members, (x) => x !== m)
				return Arr.isReadonlyArrayNonEmpty(kept)
					? [{ change: { roster: c.name, members: kept }, held: holds(state, c.name, m) }]
					: []
			}
		)
	)
	return {
		grown: Arr.map(closed, (c) => ({
			roster: c.name,
			members: Arr.append(c.members, grownHandle(c.members))
		})),
		unheld: Arr.flatMap(removals, (r) => (r.held ? [] : [r.change])),
		held: Arr.flatMap(removals, (r) => (r.held ? [r.change] : [])),
		reordered: Arr.flatMap(closed, (c) =>
			Arr.flatMap(c.members, (m, i) => {
				const next = c.members[i + 1]
				return next === undefined
					? []
					: [
							{
								roster: c.name,
								members: Arr.map(c.members, (x, j) => (j === i ? next : j === i + 1 ? m : x))
							}
						]
			})
		)
	}
}

/**
 * Every roster migration from a state, each applied whole: each growth, each removal of a handle held by no stored
 * fact or by one, and each reorder (rosterChanges), what the aimed box offers (generate/enumerate.ts migrateActions).
 */
export const rosterMigrations = (state: ModelState): ReadonlyArray<Migration> => {
	const rosters = rosterChanges(state)
	return Arr.map(
		[...rosters.grown, ...rosters.unheld, ...rosters.held, ...rosters.reordered],
		(change): Migration => ({
			to: onBase(state.install, withMembers(state.install.base, change.roster, change.members)),
			how: "complete"
		})
	)
}

/** A base with one more law. */
const withLaw = (base: BaseSpec, law: LawSpec): BaseSpec => ({ ...base, laws: [...base.laws, law] })

/** An installation moved onto another base: its roles and logins over it. */
const onBase = (install: InstallSpec, base: BaseSpec): InstallSpec => ({ ...install, base })

/** A migration as the migrate action states it. */
export interface Migration {
	readonly to: InstallSpec
	readonly how: MigrationHow
}

/**
 * How many installations a half-applied run draws before it gives the case up: a drawn installation is the state's own
 * so rarely that a case almost never draws one twice.
 */
const differentInstallAttempts = 16

/**
 * The migrations from a state, stratified: live, another installation of the same base applied whole, or the installation
 * as it is with a new native law its data keeps (keptLaws), which keeps every role and login; wild, a run to an
 * installation other than the one its new folder is drafted from (draftedFrom), whose session ends part-way through that
 * folder (that installation drafts a folder with nothing to stop in), one edited by hand, or one whose write list names
 * an entry the writable rule refuses;
 * stale, the installation as it is with a new native law over data that breaks it (when the state's data breaks one),
 * which stops the run with its folder unfinished, so every Db call and Db.open after it is refused as migrating, or a
 * write list with two entries over one relation.
 *
 * Rosters (S6): live, a roster grown by a handle no roster holds, or losing a handle no stored fact holds, whose
 * VALIDATE passes; stale, a roster losing a handle a stored fact holds, whose re-pointed domain's VALIDATE fails
 * (23514) and stops the run unfinished; wild, two adjacent handles swapped, a declaration D1 refuses before anything
 * is drafted (compile-refused).
 */
export const migrationStrata = (state: ModelState): Strata<Migration> => {
	const base = state.install.base
	const lawful = installGen(base)
	const landed =
		(how: MigrationHow) =>
		(to: InstallSpec): Migration => ({ to, how })
	const [law, ...moreLaws] = violatingLaws(state)
	const [kept, ...moreKept] = keptLaws(state)
	const rosters = rosterChanges(state)
	const onRoster = (change: RosterChange): Migration => ({
		to: onBase(state.install, withMembers(base, change.roster, change.members)),
		how: "complete"
	})
	const among = (changes: ReadonlyArray<RosterChange>) =>
		Arr.isReadonlyArrayNonEmpty(changes) ? [map(element(changes), onRoster)] : []
	return {
		live: [
			map(lawful, landed("complete")),
			...among(rosters.grown),
			...among(rosters.unheld),
			...(kept === undefined
				? []
				: [
						map(element([kept, ...moreKept]), (added): Migration => ({
							to: onBase(state.install, withLaw(base, added)),
							how: "complete"
						}))
					])
		],
		stale: [
			...(law === undefined
				? []
				: [
						{
							invalid: "migration:law-over-violating-data" as const,
							gen: map(element([law, ...moreLaws]), (broken): Migration => ({
								to: onBase(state.install, withLaw(base, broken)),
								how: "complete"
							}))
						}
					]),
			{
				invalid: "install:two-writes-one-relation",
				gen: map(plantedInstallGen(base, "install:two-writes-one-relation"), landed("complete"))
			},
			...Arr.map(among(rosters.held), (gen) => ({
				invalid: "migration:roster-removal-held" as const,
				gen
			}))
		],
		wild: [
			{
				invalid: "migration:half-applied",
				gen: map(
					filter(lawful, (to) => !samePlain(to, draftedFrom(state)), differentInstallAttempts),
					landed("half-applied")
				)
			},
			{ invalid: "migration:hand-edited", gen: map(lawful, landed("hand-edited")) },
			{
				invalid: "install:unwritable-write",
				gen: map(plantedInstallGen(base, "install:unwritable-write"), landed("complete"))
			},
			...Arr.map(among(rosters.reordered), (gen) => ({
				invalid: "migration:roster-reorder" as const,
				gen
			}))
		]
	}
}
