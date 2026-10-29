import { element, filter, map } from "@grizzle/testing/gen"
import { Array as Arr, Option, Record } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { violations } from "#test/pg/laws/families/model.ts"
import { sameDomain } from "#test/support/worlds/generate/domain.ts"
import { installGen, plantedInstallGen } from "#test/support/worlds/generate/install.ts"
import { lawIdsOf } from "#test/support/worlds/invalid/catalog.ts"
import type { Strata } from "#test/support/worlds/invalid/kinds.ts"
import { atMostOne, classifyEntry, hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { nativeLaw } from "#test/support/worlds/model/session/migrate.ts"
import { draftedFrom, samePlain } from "#test/support/worlds/model/session/state.ts"
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
		case "capacity":
			return { kind: law.kind, law: standIn }
		case "mirrors":
			return { kind: "mirrors", leftToRight: standIn, rightToLeft: standIn }
		case "alternatives":
			return {
				kind: "alternatives",
				head: standIn,
				arms: Record.fromEntries(
					Arr.map(Record.keys(law.arms), (handle) => [handle, standIn] as const)
				),
				reverse: standIn
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
		case "mirrors":
			return [law.left.relation, law.right.relation]
		case "capacity":
			return [law.source.relation, law.target.relation]
	}
}

/**
 * Whether a law would take an identity a law of the base already holds: grizzle names a containment's foreign key by
 * its source relation and fields, a key's constraint by its relation and fields, an at-most-one capacity's unique index
 * by its source's relation, fields and selector, and a check by its name, and refuses two laws of one identity when it
 * compiles the installation (IdentifierCollision).
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
			return Arr.some(base.laws, (old) => old.kind === "check" && old.name === law.name)
		case "capacity":
			return (
				Arr.some(base.laws, (old) => samePlain(old, law)) ||
				(atMostOne(law) &&
					Arr.some(
						base.laws,
						(old) =>
							old.kind === "capacity" &&
							atMostOne(old) &&
							old.source.relation === law.source.relation &&
							samePlain(old.source.fields, law.source.fields) &&
							samePlain(old.source.where, law.source.where)
					))
			)
		case "spanKey":
		case "mirrors":
		case "alternatives":
			return Arr.some(base.laws, (old) => samePlain(old, law))
	}
}

/**
 * New laws over the base's relations, each of an identity no law of the base holds: a key over one field; a row check
 * holding an integer field below each value a fact holds there, which that fact fails, and at most the largest, which
 * every fact meets; a containment of one relation's field in another's single-field key; and at most one fact of a
 * relation per fact of another, a count capacity of at most one from a field, no key alone, into another relation's
 * single-field key, which is a unique index on that field (host.ts atMostOne).
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
				name: `Below${r.name}${f.name}`,
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
							name: `AtMost${r.name}${f.name}`,
							relation: r.name,
							predicate: {
								kind: "compare",
								field: f.name,
								op: "<=",
								value: Math.max(first, ...rest)
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
	const atMostOnes = Arr.flatMap(base.relations, (s) =>
		Arr.flatMap(
			Arr.filter(s.fields, (f) => !s.key.includes(f.name) || s.key.length > 1),
			(f: FieldSpec) =>
				Arr.flatMap(
					Arr.filter(base.relations, (t) => t.name !== s.name),
					(t: RelationSpec) =>
						Arr.map(
							Arr.filter(
								t.fields,
								(g) => sameDomain(g.domain, f.domain) && t.key.length === 1 && t.key[0] === g.name
							),
							(g: FieldSpec): LawSpec => ({
								kind: "capacity",
								target: { relation: t.name, fields: [g.name], where: {} },
								source: { relation: s.name, fields: [f.name], where: {} },
								weight: { kind: "count" },
								low: 0n,
								high: 1n
							})
						)
				)
		)
	)
	return Arr.filter(
		[...keys, ...checks, ...containments, ...atMostOnes],
		(law) => !takenIdentity(base, law)
	)
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

/** The invalid kinds of a migration from a state: how it lands, the installation it lands, and a new law the data breaks. */
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
	...(Arr.some(
		to.base.laws,
		(law) => !state.install.base.laws.includes(law) && violatedBy(state, law)
	)
		? ["migration:law-over-violating-data" as const]
		: [])
]

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
 */
export const migrationStrata = (state: ModelState): Strata<Migration> => {
	const base = state.install.base
	const lawful = installGen(base)
	const landed =
		(how: MigrationHow) =>
		(to: InstallSpec): Migration => ({ to, how })
	const [law, ...moreLaws] = Arr.filter(violatingLaws(state), (l) => nativeLaw(base, l))
	const [kept, ...moreKept] = Arr.filter(keptLaws(state), (l) => nativeLaw(base, l))
	return {
		live: [
			map(lawful, landed("complete")),
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
			}
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
			}
		]
	}
}
