/** What the properties of input.test.ts read: its spaces, models and helpers. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import type { MemberFacts, StatementFacts, TriggerLaw } from "#compiler/analysis/isolation/facts.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { isolationInput } from "#compiler/program/isolation/input.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import {
	admittedFillSpecGen,
	buildFill,
	type FillSpec,
	groupFieldsOf,
	keyOfRelation,
	relationName,
	rootFieldsOf
} from "#test/support/families/fill.ts"
import { upTo } from "#test/support/up-to.ts"

/** A drawn role: how many variants each of its change members compiles to. */
interface RoleSketch {
	readonly members: ReadonlyArray<number>
}

interface Case {
	readonly spec: FillSpec
	readonly roles: ReadonlyArray<RoleSketch>
}

export const caseGen: Gen<Case> = (source) => ({
	spec: source.draw(admittedFillSpecGen({ relations: 4, families: 4, copies: 0 })),
	roles: source.draw(
		array((role): RoleSketch => ({ members: role.draw(array(int(1, 3), { min: 0, max: 3 })) }), {
			min: 0,
			max: 3
		})
	)
})

export type Feature =
	| "an immutable owner's family"
	| "a mutable owner's family"
	| "an immutable tree"
	| "a role with no change member"
	| "a member of several variants"
	| "a relation some trigger law reads"
	| "a member's reference to its owner"

/** What the recorders were handed and answered: each relation's laws, each role's privileges, each member's facts. */
interface Recorded {
	readonly laws: Map<string, ReadonlyArray<TriggerLaw>>
	readonly asked: Array<string>
	readonly privileges: Map<number, ReadonlyMap<string, ReadonlySet<TablePrivilege>>>
	readonly readable: Map<number, ReadonlyArray<string>>
	readonly facts: Map<string, NonEmptyReadonlyArray<MemberFacts>>
}

/**
 * The counted groups of each relation, by the specification's names alone: for each family whose owner is immutable,
 * its member's group fields (a tree's member and owner one relation).
 */
const countedOracle = (
	spec: FillSpec
): ReadonlyMap<string, ReadonlyArray<ReadonlyArray<string>>> => {
	const groups = new Map<string, Array<ReadonlyArray<string>>>()
	for (const [f, family] of spec.families.entries()) {
		const owner = family.kind === "tree" ? family.member : family.owner
		if (defined(spec.relations[owner], `relation ${owner}`).mutable) {
			continue
		}
		const member = relationName(family.member)
		const held = groups.get(member) ?? []
		held.push(groupFieldsOf(spec, f))
		groups.set(member, held)
	}
	return groups
}

/** Lists of field lists as one sorted list of each list's sorted fields, so two compare as sets of field sets. */
const sorted = (lists: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(lists, (fields) => Arr.join(Arr.sort(fields, Str.Order), ",")),
		Str.Order
	)

/** What the oracles write for a column a law adds, which the specification does not name: the facts' identifier of it,
 * one of its relation's law columns, reads as this. */
const law = "<law>"

/**
 * The keys of each relation PostgreSQL enforces, by the specification's names, a law column as `law` (see the header):
 * its primary key; an ordered family's member slot, its group then `i<f>`, and its predecessor's, its group then the
 * predecessor of `i<f>`; a counted family's two, its group then its drawn index, and then that index's predecessor;
 * a tree's two, its root, the parent's start under its members' selection, then `i<f>` or the predecessor of `i<f>`;
 * the successors the predecessor and last axes reference, the slot's columns then the successor, a tree's `end` after
 * it, then a fold's accumulator where it folds; and each owner's holding reference's target, its key with its first
 * field where the count is above 0, a tree's own among them.
 */
const holdingOf = (spec: FillSpec, owner: number): ReadonlyArray<string> => {
	const [, ...rest] = keyOfRelation(spec, owner)
	return [law, ...rest]
}
const keysOracle = (spec: FillSpec): ReadonlyMap<string, ReadonlyArray<ReadonlyArray<string>>> => {
	const keys = new Map<string, Array<ReadonlyArray<string>>>(
		Arr.map(spec.relations, (_, r) => [relationName(r), [keyOfRelation(spec, r)]] as const)
	)
	const add = (r: number, fields: ReadonlyArray<string>): void => {
		defined(keys.get(relationName(r)), `relation ${r}`).push(fields)
	}
	for (const [f, family] of spec.families.entries()) {
		const holding = holdingOf(spec, family.owner)
		const group = groupFieldsOf(spec, f)
		const after = foldedOf(spec, f)
		switch (family.kind) {
			case "ordered":
				add(family.member, [...group, `i${f}`])
				add(family.member, [...group, law])
				add(family.member, [...group, `i${f}`, law, ...after])
				add(family.owner, holding)
				break
			case "counted":
				add(family.member, [...group, law])
				add(family.member, [...group, law])
				add(family.member, [...group, law, law, ...after])
				add(family.owner, holding)
				break
			case "tree":
				add(family.member, [...rootFieldsOf(f), law, `i${f}`])
				add(family.member, [...rootFieldsOf(f), law, law])
				add(family.member, [...rootFieldsOf(f), law, `i${f}`, law, "end", ...after])
				add(family.owner, holding)
				break
		}
	}
	return keys
}

/** Family `f`'s fold's accumulator at its end, a law column, where it folds; none where it does not. */
const foldedOf = (spec: FillSpec, f: number): ReadonlyArray<string> =>
	defined(spec.families[f], `family ${f}`).fold === "none" ? [] : [law]

/**
 * The references of each relation as canonical lines `<target>(<columns>) <action>`, by the specification's names, a
 * law column as `law` (see the header): what each family's foreign keys reference, its owner axis its owner's holding
 * target and its predecessor and last axes its slot and successor, a tree's `end` after them, then its fold's
 * accumulator where it folds.
 */
const referencesOracle = (spec: FillSpec): ReadonlyMap<string, ReadonlyArray<string>> => {
	const references = new Map<string, Array<string>>()
	const add = (from: number, to: number, fields: ReadonlyArray<string>, action: string): void => {
		const held = references.get(relationName(from)) ?? []
		held.push(`${relationName(to)}(${Arr.join(fields, ",")}) ${action}`)
		references.set(relationName(from), held)
	}
	for (const [f, family] of spec.families.entries()) {
		const holding = holdingOf(spec, family.owner)
		const group = groupFieldsOf(spec, f)
		const after = foldedOf(spec, f)
		switch (family.kind) {
			case "ordered":
				add(family.member, family.owner, holding, "noAction")
				add(family.member, family.member, [...group, `i${f}`, law, ...after], "noAction")
				add(family.owner, family.member, [...group, `i${f}`, law, ...after], "noAction")
				break
			case "counted":
				add(family.member, family.owner, holding, "noAction")
				add(family.member, family.member, [...group, law, law, ...after], "noAction")
				add(family.owner, family.member, [...group, law, law, ...after], "noAction")
				break
			case "tree": {
				const end = [...rootFieldsOf(f), law, `i${f}`, law, "end", ...after]
				add(family.member, family.member, holding, "noAction")
				add(family.member, family.member, end, "noAction")
				add(family.member, family.member, end, "noAction")
				break
			}
		}
	}
	return references
}

/** A statement that writes and reads nothing: the builder hands the extractor's facts on without reading them. */
const nothing: StatementFacts = {
	writes: [],
	reads: [],
	probes: [],
	cores: [],
	uses: [],
	ctes: []
}

export const run = (c: Case, note: (feature: Feature) => void) =>
	Effect.sync(() => {
		const built = buildFill(c.spec)
		const artifacts = succeeded(
			testArtifacts(built.rename("Facts"), testCompile),
			"the specification's artifacts"
		)
		const model = artifacts.laws
		const lawIds = [...artifacts.described.keys()]
		const recorded: Recorded = {
			laws: new Map(),
			asked: [],
			privileges: new Map(),
			readable: new Map(),
			facts: new Map()
		}
		const input = isolationInput({
			model,
			roles: Arr.map(c.roles, (role, r) => ({
				login: "app",
				role: `role${r}`,
				checked: r,
				names: r,
				members: Arr.isReadonlyArrayNonEmpty(role.members)
					? {
							kind: "served" as const,
							members: Arr.map(role.members, (variants, m) => ({
								name: `r${r}m${m}`,
								compiled: variants
							}))
						}
					: { kind: "none" as const }
			})),
			triggerLawsOver: (given: LawModel, relation: string) => {
				assert.equal(given, model, "triggerLawsOver is asked over the installation's model")
				recorded.asked.push(relation)
				const laws = Arr.map(
					lawIds.slice(0, recorded.asked.length % (lawIds.length + 1)),
					(law): TriggerLaw => ({ law, witnesses: [{ rows: [relation], present: [], absent: [] }] })
				)
				recorded.laws.set(relation, laws)
				return laws
			},
			grantedPrivileges: (given: LawModel, checked: number) => {
				assert.equal(given, model, "grantedPrivileges is asked over the installation's model")
				const privileges = new Map<string, ReadonlySet<TablePrivilege>>([
					[
						relationName(checked % c.spec.relations.length),
						new Set<TablePrivilege>(["SELECT", "INSERT"])
					]
				])
				recorded.privileges.set(checked, privileges)
				return privileges
			},
			readableRelations: (given: LawModel, checked: number) => {
				assert.equal(given, model, "readableRelations is asked over the installation's model")
				const readable = [relationName((checked + 1) % c.spec.relations.length)]
				recorded.readable.set(checked, readable)
				return readable
			},
			memberFacts: (name: string, compiled: number, names: number) => {
				const facts: NonEmptyReadonlyArray<MemberFacts> = [
					{ name, statements: [nothing] },
					...upTo(compiled - 1, (v): MemberFacts => ({
						name: `${name}/variant${v}/${names}`,
						statements: [nothing]
					}))
				]
				recorded.facts.set(name, facts)
				return facts
			}
		})
		const owned = Rec.keys(model.owned.relations)
		assert.deepEqual(
			Arr.sort([...input.relations.keys()], Str.Order),
			Arr.sort(owned, Str.Order),
			"one fact for each relation the owned schema states"
		)
		assert.deepEqual(
			Arr.sort(recorded.asked, Str.Order),
			Arr.sort(owned, Str.Order),
			"triggerLawsOver asked once for each relation"
		)
		const counted = countedOracle(c.spec)
		const keys = keysOracle(c.spec)
		const references = referencesOracle(c.spec)
		const lawColumns = new Set(
			Arr.flatMap(model.natives, ({ object }) =>
				object.kind === "LawColumn" ? [`${object.relation.name}.${object.column}`] : []
			)
		)
		for (const [name, facts] of input.relations) {
			/** A column of `name` as the oracles write it: a field's name, or `law` for one of its law columns. */
			const spelled = (column: string): string =>
				lawColumns.has(`${name}.${column}`) ? law : column
			/** A referenced column of `target`, likewise. */
			const spelledIn =
				(target: string) =>
				(column: string): string =>
					lawColumns.has(`${target}.${column}`) ? law : column
			const laws = defined(recorded.laws.get(name), `the laws of ${name}`)
			assert.deepEqual(
				facts.triggerLaws,
				laws,
				`${name}'s trigger laws are triggerLawsOver's answer`
			)
			if (laws.length > 0) {
				note("a relation some trigger law reads")
			}
			assert.deepEqual(
				sorted(Arr.map(facts.keys, (k) => Arr.map(k, spelled))),
				sorted(keys.get(name) ?? []),
				`${name}'s keys are every key it enforces, law columns among them`
			)
			assert.deepEqual(
				sorted(facts.countedGroups),
				sorted(counted.get(name) ?? []),
				`${name}'s counted groups`
			)
			assert.deepEqual(
				Arr.sort(
					Arr.map(
						facts.references,
						(r) =>
							`${r.relation}(${Arr.join(Arr.map(r.columns, spelledIn(r.relation)), ",")}) ${r.onUpdate}`
					),
					Str.Order
				),
				Arr.sort(references.get(name) ?? [], Str.Order),
				`${name}'s references are every foreign key it holds`
			)
			/** Whether the relation holds a family's holding reference, the one whose target leads with a law column, its
			 * owner's guarded key. */
			const holding = Arr.some(facts.references, (r) =>
				Option.exists(Arr.head(r.columns), (c) => spelledIn(r.relation)(c) === law)
			)
			if (holding) {
				note("a member's reference to its owner")
			}
		}
		for (const family of c.spec.families) {
			const owner = family.kind === "tree" ? family.member : family.owner
			const mutable = defined(c.spec.relations[owner], `relation ${owner}`).mutable
			note(mutable ? "a mutable owner's family" : "an immutable owner's family")
			if (family.kind === "tree" && !mutable) {
				note("an immutable tree")
			}
		}
		assert.equal(input.roles.length, c.roles.length, "one fact for each role")
		for (const [r, role] of input.roles.entries()) {
			const sketch = defined(c.roles[r], `role ${r}`)
			assert.equal(role.role, `role${r}`, "roles keep their order")
			assert.ok(
				role.privileges === recorded.privileges.get(r),
				`role ${r}'s privileges are grantedPrivileges' answer`
			)
			const expected = Arr.flatMap(sketch.members, (_, m) =>
				defined(recorded.facts.get(`r${r}m${m}`), `member ${m} of role ${r}`)
			)
			const members = role.writes.kind === "served" ? role.writes.members : []
			assert.equal(
				role.writes.kind,
				sketch.members.length > 0 ? "served" : "unknown",
				`role ${r}'s writes are served by its members' facts, unknown where it has no change member`
			)
			if (role.writes.kind === "unknown") {
				assert.ok(
					role.writes.readable === recorded.readable.get(r),
					`role ${r}'s unknown writes read what readableRelations answers, never more`
				)
			}
			assert.equal(members.length, expected.length, `role ${r}: every variant of every member`)
			for (const [i, member] of members.entries()) {
				assert.ok(
					member === expected[i],
					`role ${r}'s member facts are memberFacts' answers, in order`
				)
			}
			if (sketch.members.length === 0) {
				note("a role with no change member")
			}
			if (Arr.some(sketch.members, (variants) => variants > 1)) {
				note("a member of several variants")
			}
		}
	})
