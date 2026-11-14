/**
 * The isolation facts of an installation are total (program/isolation/input.ts isolationInput): one RelationFacts for
 * every relation its owned schema states and one RoleFacts for every role it is given, each part the answer of the
 * function that owns it, and the keys and counted groups the law model holds.
 *
 * Over drawn schemas of families the reference admits (test/support/families/fill.ts: relations keyed by `id`, a tree's
 * by its root fields and start, ordered and counted families and trees between them, each relation mutable or not,
 * admitted by construction: admittedFillSpecGen, with no copy), compiled to their law model, and drawn roles of drawn
 * change members, each function of the sources a recorder:
 *
 * - Relations: exactly one fact for each relation the owned schema states, by its declared name, and triggerLawsOver
 *   asked once for each, its answer the fact's triggerLaws.
 * - Keys: each relation's are, as sets of fields, every key PostgreSQL enforces over its fields alone, by the
 *   specification's names (fill.ts keyOfRelation, groupFieldsOf): its primary key, `id` or a tree's (`d<f>`, `d<f>p`,
 *   `start`); an ordered family's member slot, its group then `i<f>`; each owner's owner-axis target, its key then
 *   `n<f>`, a tree's own (`d<f>`, `d<f>p`, `start`, `n<f>`) among them. A counted family's member slot and a tree's are
 *   over a law column, so no key of the relation.
 * - Counted groups: a second implementation over the specification's own names: each relation's are, for each family
 *   it is the member of whose owner is immutable (a tree's owner its own relation), the family's group fields, and none
 *   for any other.
 * - References: each relation's are, as a multiset, the foreign keys each family it is in holds, by the
 *   specification's names, each target's fields without its law columns: an ordered or counted family's member
 *   references its owner's target, its key then `n<f>`, ON UPDATE CASCADE, and its own slot, which its owner's last
 *   member references too, its group and `i<f>` for an ordered family and its group alone for a counted one, whose
 *   index is a law column; a tree's relation references its own target (`d<f>`, `d<f>p`, `start`, `n<f>`) and twice
 *   its own slot and end past its guarded parent (`d<f>`, `d<f>p`, `i<f>`, `end`); every reference but an owner axis
 *   NO ACTION.
 * - Roles: one fact for each role, in order, its privileges grantedPrivileges' answer for its own input, and its
 *   members memberFacts' answers for its members in order, every variant of each.
 *
 * Features: an immutable and a mutable owner's family, an immutable tree, a role with no change member, a member of
 * several variants, a relation some trigger law reads, a member's reference to its owner.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): isolation-input-counted-mutable, a counted group given for a mutable
 * owner's family too.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import type { MemberFacts, StatementFacts } from "#compiler/analysis/isolation/facts.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { isolationInput } from "#compiler/program/isolation/input.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
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
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"

/** A drawn role: how many variants each of its change members compiles to. */
interface RoleSketch {
	readonly members: ReadonlyArray<number>
}

interface Case {
	readonly spec: FillSpec
	readonly roles: ReadonlyArray<RoleSketch>
}

const caseGen: Gen<Case> = (source) => ({
	spec: source.draw(admittedFillSpecGen({ relations: 4, families: 4, copies: 0 })),
	roles: source.draw(
		array((role): RoleSketch => ({ members: role.draw(array(int(1, 3), { min: 0, max: 3 })) }), {
			min: 0,
			max: 3
		})
	)
})

type Feature =
	| "an immutable owner's family"
	| "a mutable owner's family"
	| "an immutable tree"
	| "a role with no change member"
	| "a member of several variants"
	| "a relation some trigger law reads"
	| "a member's reference to its owner"

/** What the recorders were handed and answered: each relation's laws, each role's privileges, each member's facts. */
interface Recorded {
	readonly laws: Map<string, ReadonlyArray<LawId>>
	readonly asked: Array<string>
	readonly privileges: Map<number, ReadonlyMap<string, ReadonlySet<TablePrivilege>>>
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

/**
 * The keys of each relation PostgreSQL enforces over fields alone, by the specification's names (see the header): its
 * primary key, an ordered family's member slot, and each owner's owner-axis target, a tree's own among them.
 */
const keysOracle = (spec: FillSpec): ReadonlyMap<string, ReadonlyArray<ReadonlyArray<string>>> => {
	const keys = new Map<string, Array<ReadonlyArray<string>>>(
		Arr.map(spec.relations, (_, r) => [relationName(r), [keyOfRelation(spec, r)]] as const)
	)
	const add = (r: number, fields: ReadonlyArray<string>): void => {
		defined(keys.get(relationName(r)), `relation ${r}`).push(fields)
	}
	for (const [f, family] of spec.families.entries()) {
		const ownerTarget = [...keyOfRelation(spec, family.owner), `n${f}`]
		switch (family.kind) {
			case "ordered":
				add(family.member, [...groupFieldsOf(spec, f), `i${f}`])
				add(family.owner, ownerTarget)
				break
			case "counted":
			case "tree":
				add(family.owner, ownerTarget)
				break
		}
	}
	return keys
}

/**
 * The references of each relation as canonical lines `<target>(<fields>) <action>`, by the specification's names (see
 * the header): what each family's foreign keys reference, a law column left out of a target's fields.
 */
const referencesOracle = (spec: FillSpec): ReadonlyMap<string, ReadonlyArray<string>> => {
	const references = new Map<string, Array<string>>()
	const add = (from: number, to: number, fields: ReadonlyArray<string>, action: string): void => {
		const held = references.get(relationName(from)) ?? []
		held.push(`${relationName(to)}(${Arr.join(fields, ",")}) ${action}`)
		references.set(relationName(from), held)
	}
	for (const [f, family] of spec.families.entries()) {
		const ownerTarget = [...keyOfRelation(spec, family.owner), `n${f}`]
		const group = groupFieldsOf(spec, f)
		switch (family.kind) {
			case "ordered":
				add(family.member, family.owner, ownerTarget, "cascade")
				add(family.member, family.member, [...group, `i${f}`], "noAction")
				add(family.owner, family.member, [...group, `i${f}`], "noAction")
				break
			case "counted":
				add(family.member, family.owner, ownerTarget, "cascade")
				add(family.member, family.member, group, "noAction")
				add(family.owner, family.member, group, "noAction")
				break
			case "tree":
				add(family.member, family.member, ownerTarget, "noAction")
				add(family.member, family.member, [...rootFieldsOf(f), `i${f}`, "end"], "noAction")
				add(family.member, family.member, [...rootFieldsOf(f), `i${f}`, "end"], "noAction")
				break
		}
	}
	return references
}

/** A statement that writes and reads nothing: the builder hands the extractor's facts on without reading them. */
const nothing: StatementFacts = { writes: [], reads: [], probes: [], cores: [] }

const run = (c: Case, note: (feature: Feature) => void) =>
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
			facts: new Map()
		}
		const input = isolationInput({
			model,
			roles: Arr.map(c.roles, (role, r) => ({
				login: "app",
				role: `role${r}`,
				checked: r,
				names: r,
				members: Arr.map(role.members, (variants, m) => ({
					name: `r${r}m${m}`,
					compiled: variants
				}))
			})),
			triggerLawsOver: (given: LawModel, relation: string) => {
				assert.equal(given, model, "triggerLawsOver is asked over the installation's model")
				recorded.asked.push(relation)
				const laws = lawIds.slice(0, recorded.asked.length % (lawIds.length + 1))
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
		for (const [name, facts] of input.relations) {
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
				sorted(facts.keys),
				sorted(keys.get(name) ?? []),
				`${name}'s keys are every key it enforces over fields alone`
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
						(r) => `${r.relation}(${Arr.join(r.fields, ",")}) ${r.onUpdate}`
					),
					Str.Order
				),
				Arr.sort(references.get(name) ?? [], Str.Order),
				`${name}'s references are every foreign key it holds`
			)
			if (Arr.some(facts.references, (r) => r.onUpdate === "cascade")) {
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
			assert.equal(role.members.length, expected.length, `role ${r}: every variant of every member`)
			for (const [i, member] of role.members.entries()) {
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

describe("isolation facts", () => {
	it.effect(
		"give one fact for every relation and every member, each its builder's answer, every key enforced over fields and the counted groups of immutable owners",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/program/isolation-input",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the family specification's own counted groups and enforced keys, and each builder's own answers"
						},
						coverage: required<Feature>(
							[
								"an immutable owner's family",
								"a mutable owner's family",
								"an immutable tree",
								"a role with no change member",
								"a member of several variants",
								"a relation some trigger law reads",
								"a member's reference to its owner"
							],
							{ cases: 120, sense: notesOnly }
						),
						kept: [],
						runs: 120,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, notes) => run(c, notes.note)
				)
			)
	)
})
