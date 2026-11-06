import { describe, it } from "@effect/vitest"
import {
	accepted,
	type Answer,
	type StepFeature,
	type Machine,
	program,
	type Real,
	refused as refusedVerdict,
	runProgram,
	took
} from "@grizzle/testing/commands"
import { explore, drawn as drawnCase } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { fullSwarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	Stream,
	String as Str
} from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { identity } from "#compiler/core/identity.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { WriteSlot } from "#compiler/ir/products.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { admittedText } from "#compiler/scalar/values/identity.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { columnKey, type ColumnKey, fieldKey } from "#compiler/write/family/fold.ts"
import { inForce, type Transport } from "#compiler/write/family/order.ts"
import {
	endColumns,
	ownerReadColumns,
	type RowLayout,
	rowLayout
} from "#compiler/write/family/statements.ts"
import { inputSlots } from "#compiler/write/frontend/compile.ts"
import type { WriteNames } from "#compiler/write/insert/statement.ts"
import { bindWrite, type Chunks } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { type FoldMonoid, folded } from "#test/support/families/fold.ts"
import { lawNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, owning } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * The write algebra's commands machine (rows-first.md §8): every write a ChangeSet states of a family's members and
 * owners, run through the whole planner (write/frontend, write/family, write/program/bind) against a host model of the
 * tables, statement by statement.
 *
 * The schema: three member relations, A in one counted family, B in two and C in three, over the owners O1 (a sum fold
 * per family), O2 (a sum fold over the members whose `on` holds) and O3 (a count only). The commands: insert owners;
 * append a member; remove one; change a step value; change a selection; move a member to another group; put an owner;
 * an identical repeat of an appended member (one fact); a conflicting repeat at one new key (refused by the member's key
 * law, before any SQL); and an append with its owner inserted in the same ChangeSet.
 *
 * The oracles:
 * - the specification of each law, as a checker over the host tables: after every statement every immediate law holds
 *   (each member's ‹i› below its ‹n›, its ‹n› its owner's count, each group's ‹i› distinct), and after the last every
 *   law does (each group's slots exactly 0 … n − 1, its count n), so updates that move a member into a freed slot must
 *   precede the count that shrinks the group (write/family/order.ts);
 * - a second implementation of every fold: NP's reference fold (test/support/families/fold.ts `folded`) over each
 *   group's members in slot order, which every hidden accumulator and every owner's end must equal;
 * - the model's own state: each member's group, value and selection, each owner's fields.
 *
 * The read flight is answered with every stored row of each family it reads, a superset of the stored suffix
 * (statements.ts suffixReadSql, whose SQL the pg suites run): the planner must plan from any set of stored rows that
 * holds the touched groups. Transports: the one in force and one that carries one row per statement.
 */

const O1 = relation(
	"O1",
	{
		id: uuid,
		cap: pg.bigint,
		na: drawn(natural),
		nb: drawn(natural),
		nc: drawn(natural),
		ta: accumulated(pg.bigint, 0n),
		tb: accumulated(pg.bigint, 0n),
		tc: accumulated(pg.bigint, 0n)
	},
	["id"]
)
const O2 = relation(
	"O2",
	{
		id: uuid,
		nb: drawn(natural),
		nc: drawn(natural),
		pb: accumulated(pg.bigint, 0n),
		pc: accumulated(pg.bigint, 0n)
	},
	["id"]
)
const O3 = relation("O3", { id: uuid, nc: drawn(natural) }, ["id"])
const A = relation("A", { id: uuid, o1: uuid, x: pg.bigint, on: pg.boolean }, ["id"])
const B = relation("B", { id: uuid, o1: uuid, o2: uuid, x: pg.bigint, on: pg.boolean }, ["id"])
const C = relation("C", { id: uuid, o1: uuid, o2: uuid, o3: uuid, x: pg.bigint, on: pg.boolean }, [
	"id"
])
const fa1 = counted(on(A, "o1"), fin(O1, "na"))
const fb1 = counted(on(B, "o1"), fin(O1, "nb"))
const fb2 = counted(on(B, "o2"), fin(O2, "nb"))
const fc1 = counted(on(C, "o1"), fin(O1, "nc"))
const fc2 = counted(on(C, "o2"), fin(O2, "nc"))
const fc3 = counted(on(C, "o3"), fin(O3, "nc"))
const Algebra = schema("Algebra", { O1, O2, O3, A, B, C }, [
	fa1,
	fb1,
	fb2,
	fc1,
	fc2,
	fc3,
	fold(fa1, Monoid.sum, on(A, "o1", "x"), on(O1, "id", "ta")),
	fold(fb1, Monoid.sum, on(B, "o1", "x"), on(O1, "id", "tb")),
	fold(fc1, Monoid.sum, on(C, "o1", "x"), on(O1, "id", "tc")),
	fold(
		fb2,
		Monoid.sum,
		on(
			select(B, (b) => b.eq(b.on, true)),
			"o2",
			"x"
		),
		on(O2, "id", "pb")
	),
	fold(
		fc2,
		Monoid.sum,
		on(
			select(C, (c) => c.eq(c.on, true)),
			"o2",
			"x"
		),
		on(O2, "id", "pc")
	),
	mutable(O1),
	mutable(O2),
	mutable(O3),
	mutable(A),
	mutable(B),
	mutable(C)
])

type MemberName = "A" | "B" | "C"
type OwnerName = "O1" | "O2" | "O3"
const MEMBERS: ReadonlyArray<MemberName> = ["A", "B", "C"]
const memberRelations = { A, B, C } as const
const ownerRelations = { O1, O2, O3 } as const

/** Each member relation's group fields, in the order its families are declared, and the owner each names. */
const groupsOf: Readonly<
	Record<MemberName, ReadonlyArray<{ readonly field: string; readonly owner: OwnerName }>>
> = {
	A: [{ field: "o1", owner: "O1" }],
	B: [
		{ field: "o1", owner: "O1" },
		{ field: "o2", owner: "O2" }
	],
	C: [
		{ field: "o1", owner: "O1" },
		{ field: "o2", owner: "O2" },
		{ field: "o3", owner: "O3" }
	]
}

/** The pools the machine draws ids from: owners 0 … 2 of each owner relation, members 0 … 5 of each member relation. */
const OWNER_IDS = 3
const MEMBER_IDS = 6

interface ModelMember {
	readonly groups: ReadonlyArray<number>
	readonly x: number
	readonly on: boolean
}

interface Model {
	readonly owners: Readonly<Record<OwnerName, ReadonlyMap<number, number>>>
	readonly members: Readonly<Record<MemberName, ReadonlyMap<number, ModelMember>>>
}

const initial: Model = {
	owners: { O1: new Map(), O2: new Map(), O3: new Map() },
	members: { A: new Map(), B: new Map(), C: new Map() }
}

interface Params {
	readonly insertOwners: { readonly owner: OwnerName; readonly ids: ReadonlyArray<number> }
	readonly append: {
		readonly relation: MemberName
		readonly id: number
		readonly member: ModelMember
	}
	readonly remove: { readonly relation: MemberName; readonly id: number }
	readonly step: { readonly relation: MemberName; readonly id: number; readonly x: number }
	readonly selection: { readonly relation: MemberName; readonly id: number }
	readonly move: {
		readonly relation: MemberName
		readonly id: number
		readonly family: number
		readonly group: number
	}
	readonly ownerPut: { readonly id: number; readonly cap: number }
	readonly repeat: {
		readonly relation: MemberName
		readonly id: number
		readonly member: ModelMember
	}
	readonly conflict: {
		readonly relation: MemberName
		readonly id: number
		readonly member: ModelMember
	}
	readonly withOwner: { readonly id: number; readonly owner: number; readonly x: number }
	readonly exactRepeat: { readonly relation: MemberName; readonly id: number }
	readonly storedConflict: { readonly relation: MemberName; readonly id: number }
}

const ids = (n: number): ReadonlyArray<number> => Array.from({ length: n }, (_, i) => i)

/** A draw of one of `xs`, which the command's `applies` keeps nonempty. */
const pick = <A>(xs: ReadonlyArray<A>): Gen<A> => {
	if (!Arr.isReadonlyArrayNonEmpty(xs)) {
		throw new Error("a draw from no choice: the command's applies admits none")
	}
	return element(xs)
}

/** The owners of a member relation's groups that exist, by family. */
const ownersFor = (m: Model, relation: MemberName): ReadonlyArray<ReadonlyArray<number>> =>
	Arr.map(groupsOf[relation], (g) => [...m.owners[g.owner].keys()])

const canAppend = (m: Model, relation: MemberName): boolean =>
	Arr.every(ownersFor(m, relation), (os) => os.length > 0) && m.members[relation].size < MEMBER_IDS

const memberGen =
	(m: Model, relation: MemberName): Gen<ModelMember> =>
	(source) => ({
		groups: Arr.map(ownersFor(m, relation), (os) => source.draw(pick(os))),
		x: source.draw(int(0, 3)),
		on: source.draw(int(0, 1)) === 1
	})

const freshId = (m: Model, relation: MemberName): Gen<number> =>
	pick(Arr.filter(ids(MEMBER_IDS), (i) => !m.members[relation].has(i)))

const storedId = (m: Model, relation: MemberName): Gen<number> =>
	pick([...m.members[relation].keys()])

const withMember = (
	m: Model,
	relation: MemberName,
	id: number,
	member: ModelMember | undefined
): Model => {
	const next = new Map(m.members[relation])
	if (member === undefined) {
		next.delete(id)
	} else {
		next.set(id, member)
	}
	return { ...m, members: { ...m.members, [relation]: next } }
}

const appendable = (m: Model): ReadonlyArray<MemberName> =>
	Arr.filter(MEMBERS, (r) => canAppend(m, r))
const stored = (m: Model): ReadonlyArray<MemberName> =>
	Arr.filter(MEMBERS, (r) => m.members[r].size > 0)

const machine: Machine<Model, Params, "key"> = {
	initial,
	commands: {
		insertOwners: {
			weight: 2,
			applies: (m) => Arr.some(["O1", "O2", "O3"] as const, (o) => m.owners[o].size < OWNER_IDS),
			parameters: (m) => (source) => {
				const owner = source.draw(
					pick(Arr.filter(["O1", "O2", "O3"] as const, (o) => m.owners[o].size < OWNER_IDS))
				)
				const free = Arr.filter(ids(OWNER_IDS), (i) => !m.owners[owner].has(i))
				const n = source.draw(int(1, free.length))
				return { owner, ids: Arr.take(free, n) }
			},
			judge: (m, p) => {
				const next = new Map(m.owners[p.owner])
				for (const id of p.ids) {
					next.set(id, 0)
				}
				return accepted({ ...m, owners: { ...m.owners, [p.owner]: next } })
			}
		},
		append: {
			weight: 4,
			applies: (m) => appendable(m).length > 0,
			parameters: (m) => (source) => {
				const relation = source.draw(pick(appendable(m)))
				return {
					relation,
					id: source.draw(freshId(m, relation)),
					member: source.draw(memberGen(m, relation))
				}
			},
			judge: (m, p) => accepted(withMember(m, p.relation, p.id, p.member))
		},
		remove: {
			weight: 3,
			applies: (m) => stored(m).length > 0,
			parameters: (m) => (source) => {
				const relation = source.draw(pick(stored(m)))
				return { relation, id: source.draw(storedId(m, relation)) }
			},
			judge: (m, p) => accepted(withMember(m, p.relation, p.id, undefined))
		},
		step: {
			weight: 3,
			applies: (m) => stored(m).length > 0,
			parameters: (m) => (source) => {
				const relation = source.draw(pick(stored(m)))
				return { relation, id: source.draw(storedId(m, relation)), x: source.draw(int(0, 3)) }
			},
			judge: (m, p) => {
				const was = defined(m.members[p.relation].get(p.id), "a stored member")
				return accepted(withMember(m, p.relation, p.id, { ...was, x: p.x }))
			}
		},
		selection: {
			weight: 2,
			applies: (m) => stored(m).length > 0,
			parameters: (m) => (source) => {
				const relation = source.draw(pick(stored(m)))
				return { relation, id: source.draw(storedId(m, relation)) }
			},
			judge: (m, p) => {
				const was = defined(m.members[p.relation].get(p.id), "a stored member")
				return accepted(withMember(m, p.relation, p.id, { ...was, on: !was.on }))
			}
		},
		move: {
			weight: 3,
			applies: (m) => stored(m).length > 0,
			parameters: (m) => (source) => {
				const relation = source.draw(pick(stored(m)))
				const family = source.draw(int(0, groupsOf[relation].length - 1))
				return {
					relation,
					id: source.draw(storedId(m, relation)),
					family,
					group: source.draw(pick(defined(ownersFor(m, relation)[family], "a family's owners")))
				}
			},
			judge: (m, p) => {
				const was = defined(m.members[p.relation].get(p.id), "a stored member")
				const groups = Arr.map(was.groups, (g, i) => (i === p.family ? p.group : g))
				return accepted(withMember(m, p.relation, p.id, { ...was, groups }))
			}
		},
		ownerPut: {
			weight: 1,
			applies: (m) => m.owners.O1.size > 0,
			parameters: (m) => (source) => ({
				id: source.draw(pick([...m.owners.O1.keys()])),
				cap: source.draw(int(0, 3))
			}),
			judge: (m, p) => {
				const next = new Map(m.owners.O1)
				next.set(p.id, p.cap)
				return accepted({ ...m, owners: { ...m.owners, O1: next } })
			}
		},
		repeat: {
			weight: 1,
			applies: (m) => appendable(m).length > 0,
			parameters: (m) => (source) => {
				const relation = source.draw(pick(appendable(m)))
				return {
					relation,
					id: source.draw(freshId(m, relation)),
					member: source.draw(memberGen(m, relation))
				}
			},
			judge: (m, p) => accepted(withMember(m, p.relation, p.id, p.member))
		},
		conflict: {
			weight: 1,
			applies: (m) => appendable(m).length > 0,
			parameters: (m) => (source) => {
				const relation = source.draw(pick(appendable(m)))
				return {
					relation,
					id: source.draw(freshId(m, relation)),
					member: source.draw(memberGen(m, relation))
				}
			},
			judge: () => refusedVerdict("key")
		},
		exactRepeat: {
			weight: 1,
			applies: (m) => stored(m).length > 0,
			parameters: (m) => (source) => {
				const relation = source.draw(pick(stored(m)))
				return { relation, id: source.draw(storedId(m, relation)) }
			},
			judge: (m) => accepted(m)
		},
		storedConflict: {
			weight: 1,
			applies: (m) => stored(m).length > 0,
			parameters: (m) => (source) => {
				const relation = source.draw(pick(stored(m)))
				return { relation, id: source.draw(storedId(m, relation)) }
			},
			judge: () => refusedVerdict("key")
		},
		withOwner: {
			weight: 1,
			applies: (m) => m.owners.O1.size < OWNER_IDS && m.members.A.size < MEMBER_IDS,
			parameters: (m) => (source) => ({
				id: source.draw(freshId(m, "A")),
				owner: source.draw(pick(Arr.filter(ids(OWNER_IDS), (i) => !m.owners.O1.has(i)))),
				x: source.draw(int(0, 3))
			}),
			judge: (m, p) => {
				const owners = new Map(m.owners.O1)
				owners.set(p.owner, 0)
				return accepted(
					withMember({ ...m, owners: { ...m.owners, O1: owners } }, "A", p.id, {
						groups: [p.owner],
						x: p.x,
						on: true
					})
				)
			}
		}
	}
}

/** Owner and member ids as uuids, apart by relation. */
const ownerUuid = (owner: OwnerName, id: number): string =>
	uuidOf(1000 * (["O1", "O2", "O3"].indexOf(owner) + 1) + id)
const memberUuid = (relation: MemberName, id: number): string =>
	uuidOf(10_000 * (MEMBERS.indexOf(relation) + 1) + id)

/** A member's fact as a ChangeSet states it: its written fields. */
const memberFact = (relation: MemberName, id: number, member: ModelMember) => ({
	id: memberUuid(relation, id),
	...Rec.fromEntries(
		Arr.map(
			groupsOf[relation],
			(g, i) => [g.field, ownerUuid(g.owner, defined(member.groups[i], "a group"))] as const
		)
	),
	x: BigInt(member.x),
	on: member.on
})

const ownerFact = (owner: OwnerName, id: number, cap: number) =>
	owner === "O1" ? { id: ownerUuid(owner, id), cap: BigInt(cap) } : { id: ownerUuid(owner, id) }

/** What a step states, by command: its ChangeSet over the model's state before it, and the stratum's own statements it
 * makes the host tables take, an owner inserted at its starts or an owner's put. */
interface Stated<P> {
	readonly change: (p: P, before: Model) => unknown
	readonly own: (db: Db, p: P) => void
	/** The member relation it writes, whose key law a conflicting repeat is refused by; none for an owner's write. */
	readonly member: (p: P) => MemberName | undefined
	/** What else its ChangeSet's shape depends on beside its command and member relation: the owner it inserts. */
	readonly variant: (p: P) => string
	/** The check of the owners it inserts, right after their own insert and before any family statement. */
	readonly inserted: (db: Db, p: P) => void
}

const noVariant = (): string => ""

const ofRelation = (p: { readonly relation: MemberName }): MemberName => p.relation
const noMember = (): undefined => undefined

const none = (): void => undefined

const storedMember = (model: Model, relation: MemberName, id: number): ModelMember =>
	defined(model.members[relation].get(id), "a stored member")

const stated: { readonly [K in keyof Params]: Stated<Params[K]> } = {
	insertOwners: {
		inserted: none,
		member: noMember,
		variant: (q) => q.owner,
		change: (q) =>
			ChangeSet.empty(Algebra).insert(
				ownerRelations[q.owner],
				Arr.map(q.ids, (id) => ownerFact(q.owner, id, 0))
			),
		own: none
	},
	append: {
		inserted: none,
		member: ofRelation,
		variant: noVariant,
		change: (q) =>
			ChangeSet.empty(Algebra).insert(memberRelations[q.relation], [
				memberFact(q.relation, q.id, q.member)
			]),
		own: none
	},
	remove: {
		inserted: none,
		member: ofRelation,
		variant: noVariant,
		change: (q, m) =>
			ChangeSet.empty(Algebra).delete(memberRelations[q.relation], [
				memberFact(q.relation, q.id, storedMember(m, q.relation, q.id))
			]),
		own: none
	},
	step: {
		inserted: none,
		member: ofRelation,
		variant: noVariant,
		change: (q, m) =>
			ChangeSet.empty(Algebra).put(memberRelations[q.relation], [
				memberFact(q.relation, q.id, { ...storedMember(m, q.relation, q.id), x: q.x })
			]),
		own: none
	},
	selection: {
		inserted: none,
		member: ofRelation,
		variant: noVariant,
		change: (q, m) => {
			const was = storedMember(m, q.relation, q.id)
			return ChangeSet.empty(Algebra).put(memberRelations[q.relation], [
				memberFact(q.relation, q.id, { ...was, on: !was.on })
			])
		},
		own: none
	},
	move: {
		inserted: none,
		member: ofRelation,
		variant: noVariant,
		change: (q, m) => {
			const was = storedMember(m, q.relation, q.id)
			const groups = Arr.map(was.groups, (g, i) => (i === q.family ? q.group : g))
			return ChangeSet.empty(Algebra).put(memberRelations[q.relation], [
				memberFact(q.relation, q.id, { ...was, groups })
			])
		},
		own: none
	},
	ownerPut: {
		inserted: none,
		member: noMember,
		variant: noVariant,
		change: (q) => ChangeSet.empty(Algebra).put(O1, [ownerFact("O1", q.id, q.cap)]),
		own: (db, q) => {
			const row = defined(tableOf(db, "O1").get(keyText([ownerUuid("O1", q.id)])), "a stored owner")
			row.set(fieldKey("cap"), textOf(db, fieldOf("O1", "cap").type, BigInt(q.cap)))
		}
	},
	repeat: {
		inserted: none,
		member: ofRelation,
		variant: noVariant,
		change: (q) => {
			const fact = memberFact(q.relation, q.id, q.member)
			return ChangeSet.empty(Algebra)
				.insert(memberRelations[q.relation], [fact, fact])
				.insert(memberRelations[q.relation], Stream.fromIterable([fact]))
		},
		own: none
	},
	conflict: {
		inserted: none,
		member: ofRelation,
		variant: noVariant,
		change: (q) => {
			const fact = memberFact(q.relation, q.id, q.member)
			return ChangeSet.empty(Algebra).insert(memberRelations[q.relation], [
				fact,
				{ ...fact, x: fact.x + 1n }
			])
		},
		own: none
	},
	exactRepeat: {
		inserted: none,
		member: ofRelation,
		variant: noVariant,
		change: (q, m) =>
			ChangeSet.empty(Algebra).insert(memberRelations[q.relation], [
				memberFact(q.relation, q.id, storedMember(m, q.relation, q.id))
			]),
		own: none
	},
	storedConflict: {
		inserted: none,
		member: ofRelation,
		variant: noVariant,
		change: (q, m) => {
			const was = storedMember(m, q.relation, q.id)
			return ChangeSet.empty(Algebra).insert(memberRelations[q.relation], [
				memberFact(q.relation, q.id, { ...was, x: was.x + 1 })
			])
		},
		own: none
	},
	withOwner: {
		inserted: (db, q) => {
			/** The CHECK `ta = x`, of an end against a written field, holds of the owner's insert row itself. */
			const owner = defined(
				tableOf(db, "O1").get(keyText([ownerUuid("O1", q.owner)])),
				"the inserted owner"
			)
			assert.equal(num(owner.get(fieldKey("na"))), 1n, "the owner's insert row carries its count")
			assert.equal(
				num(owner.get(fieldKey("ta"))),
				BigInt(q.x),
				"the owner's insert row carries its end"
			)
		},
		member: () => "A",
		variant: noVariant,
		change: (q) =>
			ChangeSet.empty(Algebra)
				.insert(O1, [ownerFact("O1", q.owner, 0)])
				.insert(A, [memberFact("A", q.id, { groups: [q.owner], x: q.x, on: true })]),
		own: none
	}
}

const owned = owning(Algebra)
const names: WriteNames = succeeded(
	compileInstallation(owned, {
		...installOptions(owned, "owner"),
		installation: identity.schema(parsedSchemaName("algebra"))
	})
).names
const artifacts = succeeded(testArtifacts(Algebra, testCompile))
/** The schema's law names, compiled once: a refusal names its key law by them. */
const algebraLaws = lawNamesOf(Algebra)
const families = artifacts.laws.families
const programs = new Map<string, CompiledWrite>()
/** The program of a step's ChangeSet shape, compiled once per command and relation. */
const programOf = (shape: string, value: unknown): CompiledWrite => {
	const known = programs.get(shape)
	if (known !== undefined) {
		return known
	}
	const built = succeeded(
		compileWrite(checking(Algebra), descOf(value), {
			names,
			reads: names,
			claims: { kind: "every" },
			world: { kind: "reality" },
			laws: artifacts.laws,
			derived: artifacts.derived
		})
	)
	programs.set(shape, built)
	return built
}

/** A host table: each row's columns' texts by column key, by its key's text. */
type Table = Map<string, Map<ColumnKey, string>>

/** The host model of the installed tables, every column as its canonical text. */
interface Db {
	readonly codes: Codebook
	readonly tables: Map<string, Table>
}

const relationInfo = (name: string): RelationInfo =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst([...artifacts.laws.relations.values()], (r) => r.relation.name === name)
		)?.relation,
		`the relation ${name}`
	)

const textOf = (db: Db, type: LawField["type"], value: unknown): string =>
	admittedText(carrierSpecOf(type, db.codes), value)

const fieldOf = (relation: string, name: string): LawField =>
	defined(
		Option.getOrUndefined(Arr.findFirst(relationInfo(relation).fields, (f) => f.name === name)),
		`the field ${relation}.${name}`
	)

/** An array literal's elements: uuids, integers and booleans, which hold no quote or comma. */
const arrayItems = (literal: string): ReadonlyArray<string> =>
	literal === "{}"
		? []
		: Arr.map(Str.split(Str.slice(1, -1)(literal), ","), (item) =>
				Str.startsWith('"')(item) && Str.endsWith('"')(item) ? Str.slice(1, -1)(item) : item
			)

/** A chunk's arrays as rows: the i-th element of every array. */
const rowsOfChunk = (chunk: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
	const columns = Arr.map(chunk, arrayItems)
	const n = columns[0]?.length ?? 0
	return Array.from({ length: n }, (_, i) =>
		Arr.map(columns, (c) => defined(c[i], "an array's element"))
	)
}

const layoutOf = (relation: string): RowLayout =>
	succeeded(rowLayout(relationInfo(relation), families))

const tableOf = (db: Db, relation: string): Table => {
	const known = db.tables.get(relation)
	if (known !== undefined) {
		return known
	}
	const made: Table = new Map()
	db.tables.set(relation, made)
	return made
}

/** The key text of a row by its relation's key columns' texts. */
const keyText = (texts: ReadonlyArray<string>): string => Arr.join(texts, "\u0000")

/** The owner a member's row names in a family, by its group fields' texts in the owner's key order. */
const ownerKeyOf = (family: Family, row: ReadonlyMap<ColumnKey, string>): string =>
	keyText(Arr.map(family.group, (g) => defined(row.get(fieldKey(g.member.name)), "a group field")))

/**
 * An owner's insert statement's rows, as its encoded arrays carry them, inserted into the host table: each member
 * placeholder's array is its slot's column at its part, the slot carrying the owner's counts and ends, which its
 * stratum's appends drew (write/program/bind.ts), so the owner's row is judged as its insert writes it.
 */
const insertEncoded = (
	db: Db,
	compiled: CompiledWrite,
	slots: ReadonlyArray<WriteSlot>,
	relation: string,
	executions: ReadonlyArray<ReadonlyArray<string>>
): void => {
	for (const params of executions) {
		const columns = new Map<string, ReadonlyArray<string>>()
		for (const [i, p] of slots.entries()) {
			if (p.kind !== "member") {
				continue
			}
			const heading = defined(
				Option.getOrUndefined(
					Arr.findFirst(
						Arr.flatMap(compiled.frontend.slots, (g) => Arr.flatMap(g.inputs, inputSlots)),
						(m) => m.slot === p.slot
					)
				),
				"an owner insert's member slot"
			).heading
			/** The insert reads its input's columns key first, in its relation's field order (insert/statement.ts
			 * writtenFields), and each placeholder's part is its column's position there. */
			const info = relationInfo(relation)
			const keyFirst = [
				...info.primaryFields,
				...Arr.filter(info.heading, (f) => !info.primaryFields.includes(f))
			]
			const read = Arr.filter(keyFirst, (f) => Arr.some(heading, (c) => c.name === f.name))
			const name = defined(read[p.part], "a member slot's column").name
			columns.set(name, arrayItems(defined(params[i], "a placeholder's array")))
		}
		const ids = defined(columns.get("id"), "an owner's key column")
		for (const [at, id] of ids.entries()) {
			const row = new Map<ColumnKey, string>()
			for (const [name, texts] of columns) {
				row.set(fieldKey(name), defined(texts[at], "a column's element"))
			}
			tableOf(db, relation).set(keyText([id]), row)
		}
	}
}

/** Every stored row of a family, as its read returns them (statements.ts suffixReadSql): its owners, then its members. */
const readRows = (db: Db, family: Family): ReadonlyArray<ReadonlyArray<string>> => {
	const layout = layoutOf(family.member.name)
	const ownerColumns = [...Arr.map(family.group, (g) => g.owner), ...ownerReadColumns(family)]
	const owners = Arr.map([...tableOf(db, family.owner.name).values()], (row) => [
		"o",
		...Arr.map(ownerColumns, (f) =>
			defined(row.get(fieldKey(f.name)), `the owner column ${f.name}`)
		)
	])
	const members = Arr.map([...tableOf(db, family.member.name).values()], (row) => [
		"m",
		...Arr.map([...layout.key, ...layout.columns], (c) =>
			defined(row.get(c.key), `the column ${c.key}`)
		)
	])
	return [...owners, ...members]
}

/** A family statement's rows applied to the host tables, as PostgreSQL applies them. */
const applyFamily = (
	db: Db,
	step: { readonly statement: string; readonly target: { readonly kind: string } },
	relation: string,
	family: Family | undefined,
	rows: ReadonlyArray<ReadonlyArray<string>>
): "key" | undefined => {
	if (step.statement === "count") {
		const f = defined(family, "a count statement's family")
		const owners = tableOf(db, f.owner.name)
		const ends = endColumns(f)
		for (const row of rows) {
			const key = keyText(Arr.take(row, f.group.length))
			const owner = defined(owners.get(key), "a counted owner")
			const count = defined(row[f.group.length], "a count")
			owner.set(fieldKey(f.count.name), count)
			for (const [i, end] of ends.entries()) {
				owner.set(fieldKey(end.name), defined(row[f.group.length + 1 + i], "an end"))
			}
			/** Every member of the family, whose copy ‹n› the owner axis cascades the count into. */
			const members = tableOf(db, f.member.name).values()
			for (const member of members) {
				if (ownerKeyOf(f, member) === key) {
					member.set(`law:${f.copy}`, count)
				}
			}
		}
		return undefined
	}
	const layout = layoutOf(relation)
	const table = tableOf(db, relation)
	const all = [...layout.key, ...layout.columns]
	for (const row of rows) {
		const key = keyText(Arr.take(row, layout.key.length))
		switch (step.statement) {
			case "delete":
				assert.ok(table.delete(key), "a delete removes a stored row")
				break
			case "insert": {
				/** A stored row at the key: PostgreSQL's 23505 on the primary key, which the outcome reads as its key law. */
				const occupied = table.has(key)
				if (occupied) {
					return "key"
				}
				table.set(
					key,
					new Map(Arr.map(all, (c, i) => [c.key, defined(row[i], "a column")] as const))
				)
				break
			}
			case "update": {
				const stored = defined(table.get(key), "an update's stored row")
				for (const [i, c] of all.entries()) {
					if (c.settable) {
						stored.set(c.key, defined(row[i], "a column"))
					}
				}
				break
			}
			default:
				assert.fail(`a family statement ${step.statement}`)
		}
	}
	return undefined
}

const num = (text: string | undefined): bigint => BigInt(defined(text, "a natural's text"))

/** Every immediate law of every family over the host tables: ‹i› below ‹n›, ‹n› the owner's count, ‹i› distinct. */
const immediateHold = (db: Db, at: string): void => {
	for (const f of families) {
		const owners = tableOf(db, f.owner.name)
		const seen = new Set<string>()
		for (const row of tableOf(db, f.member.name).values()) {
			const i = num(row.get(columnKey(f.index)))
			const n = num(row.get(`law:${f.copy}`))
			const key = ownerKeyOf(f, row)
			const owner = defined(owners.get(key), `${at}: a member's owner is stored`)
			assert.ok(i < n, `${at}: a member's ‹i› is below its ‹n› (${f.member.name})`)
			assert.equal(n, num(owner.get(fieldKey(f.count.name))), `${at}: ‹n› is its owner's count`)
			const slot = `${key}\u0000${i}`
			assert.ok(!seen.has(slot), `${at}: each group's ‹i› is distinct`)
			seen.add(slot)
		}
	}
}

const SUM: FoldMonoid = { name: "sum", least: 0n }

/** Every law at commit, each fold against the reference fold: dense slots, counts, accumulators and ends. */
const commitHolds = (db: Db, model: Model): void => {
	immediateHold(db, "at commit")
	for (const f of families) {
		for (const [key, owner] of tableOf(db, f.owner.name)) {
			const members = Arr.sort(
				Arr.filter([...tableOf(db, f.member.name).values()], (row) => ownerKeyOf(f, row) === key),
				Order.mapInput(Order.BigInt, (r: ReadonlyMap<ColumnKey, string>) =>
					num(r.get(columnKey(f.index)))
				)
			)
			assert.deepEqual(
				Arr.map(members, (r) => num(r.get(columnKey(f.index)))),
				Arr.map(ids(members.length), BigInt),
				"a group's slots are exactly 0 … n − 1"
			)
			assert.equal(num(owner.get(fieldKey(f.count.name))), BigInt(members.length), "the count is n")
			for (const fo of f.folds) {
				const steps = Arr.map(members, (r) => ({
					x: fo.step.kind === "value" ? num(r.get(fieldKey(fo.step.field.name))) : 1n,
					selected:
						fo.where.length === 0 ||
						r.get(fieldKey("on")) === "true" ||
						r.get(fieldKey("on")) === "t"
				}))
				const reference = folded(SUM, steps)
				for (const [p, plane] of fo.planes.entries()) {
					for (const [slot, r] of members.entries()) {
						const acc = defined(reference.slots[slot], "a slot's accumulators")
						assert.equal(
							num(r.get(columnKey(plane.before))),
							defined(acc.before[p], "a plane's before"),
							"a hidden before is the reference's"
						)
						assert.equal(
							num(r.get(columnKey(plane.after))),
							defined(acc.after[p], "a plane's after"),
							"a hidden after is the reference's"
						)
					}
					assert.equal(
						num(owner.get(fieldKey(plane.end.name))),
						defined(reference.end[p], "a plane's end"),
						"an end is the reference fold's"
					)
				}
			}
		}
	}
	for (const relation of MEMBERS) {
		const table = tableOf(db, relation)
		assert.equal(table.size, model.members[relation].size, "the members are the model's")
		for (const [id, member] of model.members[relation]) {
			const row = defined(
				table.get(keyText([memberUuid(relation, id)])),
				"a modelled member is stored"
			)
			assert.equal(num(row.get(fieldKey("x"))), BigInt(member.x), "a member's value is the model's")
			for (const [i, g] of groupsOf[relation].entries()) {
				assert.equal(
					row.get(fieldKey(g.field)),
					ownerUuid(g.owner, defined(member.groups[i], "a group")),
					"a member's group is the model's"
				)
			}
		}
	}
}

const familyOfStep = (family: {
	readonly owner: string
	readonly count: string
}): Family | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(families, (f) => f.id.owner === family.owner && f.id.count === family.count)
	)

/** One step run on the planner against the host tables, its every family statement applied and judged in order. */
const runStep =
	(db: Db, transport: Transport, model: { current: Model }) =>
	<K extends keyof Params>(command: K) =>
	(p: Params[K], before: Model, after: Model) =>
		Effect.gen(function* () {
			const value = stated[command].change(p, before)
			const member = stated[command].member(p)
			const shape = `${command}:${member ?? ""}:${stated[command].variant(p)}`
			const compiled = programOf(shape, value)
			const members = yield* collectInputs(compiled.frontend, parsedOf(value).inputs)
			const bound = succeeded(bindWrite(compiled, { members, params: {}, transport }))
			if (bound.kind === "invariant-rejected") {
				assert.equal(
					bound.law,
					algebraLaws.primaryKeyLaw(
						memberRelations[defined(member, "a refused member write's relation")]
					),
					"two facts at one key are refused by the member's key law"
				)
				const answer: Answer<"key"> = refusedVerdict("key")
				return answer
			}
			/** The tables before the step, which a statement's refusal rolls back to. */
			const before_ = new Map(
				Arr.map(
					[...db.tables],
					([name, table]) =>
						[name, new Map(Arr.map([...table], ([k, row]) => [k, new Map(row)] as const))] as const
				)
			)
			const flights = bound.flights
			/** The read flight runs first, before the stratum's own statements: it sees the state before the step. */
			const chunks: Chunks =
				flights.kind === "write"
					? flights.chunks
					: succeeded(
							flights.writes(
								Arr.map(flights.reads, (r) =>
									readRows(db, defined(familyOfStep(r.family), "a read's family"))
								)
							)
						)
			stated[command].own(db, p)
			if (command === "insertOwners" || command === "withOwner") {
				for (const statement of compiled.artifacts.optimized.statements) {
					const s = statement.step
					if (s.kind === "write" && s.result.kind === "insert" && s.relation in ownerRelations) {
						insertEncoded(
							db,
							compiled,
							bound.form(statement).paramSlots,
							s.relation,
							succeeded(chunks(statement))
						)
					}
				}
				stated[command].inserted(db, p)
			}
			for (const statement of compiled.artifacts.optimized.statements) {
				const step = statement.step
				if (step.kind !== "family") {
					continue
				}
				const family = step.target.kind === "owners" ? familyOfStep(step.target.family) : undefined
				if (family !== undefined) {
					/** A member's writer reads its owner's key, count and ends alone: a count statement returns no other
					 * column, so a role without SELECT on the owner's written fields appends a member. */
					const readable = [
						...Arr.map(relationInfo(family.owner.name).primaryFields, (f) => f.name),
						family.count.name,
						...Arr.map(endColumns(family), (f) => f.name)
					]
					assert.ok(
						Arr.every(step.result.fields, (f) => readable.includes(f)),
						"a count statement returns only its owner's key, count and ends"
					)
				}
				for (const chunk of succeeded(chunks(statement))) {
					if (applyFamily(db, step, step.relation, family, rowsOfChunk(chunk)) === "key") {
						/** The statement's refusal aborts the transaction: the tables are as before the step. */
						const restored = [...before_]
						db.tables.clear()
						for (const [name, table] of restored) {
							db.tables.set(name, table)
						}
						const answer: Answer<"key"> = refusedVerdict("key")
						return answer
					}
					immediateHold(db, `after ${command}'s ${step.statement} of ${step.relation}`)
				}
			}
			commitHolds(db, after)
			model.current = after
			return took
		})

interface MachineCase {
	readonly steps: ReturnType<ReturnType<typeof program<Model, Params, "key">>>
	readonly oneRowEach: boolean
}

type MachineFeature = StepFeature<Params, "key"> | "a statement per row"

const caseGen: Gen<MachineCase> = (source) => ({
	steps: source.draw(
		program(
			machine,
			{ min: 1, max: 14 },
			fullSwarm([
				"insertOwners",
				"append",
				"remove",
				"step",
				"selection",
				"move",
				"ownerPut",
				"repeat",
				"conflict",
				"withOwner",
				"exactRepeat",
				"storedConflict"
			])
		)
	),
	oneRowEach: source.draw(int(0, 1)) === 1
})

describe("the write algebra's commands (rows-first.md §8)", () => {
	it.effect(
		"plans every write of a family's members and owners so that every statement leaves the immediate laws true and the commit every law",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/commands",
						draw: drawnCase(caseGen),
						literal: Formatter.format,
						coverage: required<MachineFeature>(
							[
								"append accepted",
								"remove accepted",
								"step accepted",
								"selection accepted",
								"move accepted",
								"ownerPut accepted",
								"repeat accepted",
								"conflict refused key",
								"withOwner accepted",
								"exactRepeat accepted",
								"storedConflict refused key",
								"a statement per row"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "specification",
							name: "the family laws at each statement's end and at commit, folds by NP's reference fold"
						}
					},
					(c, sense) =>
						Effect.gen(function* () {
							const db: Db = { codes: names.codes, tables: new Map() }
							const transport = c.oneRowEach
								? { ...inForce(bindFrame), literalUnits: 40 }
								: inForce(bindFrame)
							if (c.oneRowEach) {
								sense.note("a statement per row")
							}
							const model = { current: initial }
							const step = runStep(db, transport, model)
							const real: Real<Model, Params, "key", never, never> = {
								insertOwners: step("insertOwners"),
								append: step("append"),
								remove: step("remove"),
								step: step("step"),
								selection: step("selection"),
								move: step("move"),
								ownerPut: step("ownerPut"),
								repeat: step("repeat"),
								conflict: step("conflict"),
								withOwner: step("withOwner"),
								exactRepeat: step("exactRepeat"),
								storedConflict: step("storedConflict")
							}
							const ran = yield* runProgram(machine, real, c.steps)
							for (const verdict of ran.verdicts) {
								sense.note(verdict)
							}
						})
				)
			)
	)
})
