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
import { type CompileError, isCompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { WriteSlot } from "#compiler/ir/products.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	check,
	contained,
	counted,
	fin,
	fold,
	key,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { admittedText } from "#compiler/scalar/values/identity.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { columnKey, type ColumnKey, fieldKey, literalHost } from "#compiler/write/family/fold.ts"
import { inForce, type Transport } from "#compiler/write/family/order.ts"
import {
	endColumns,
	ownerReadColumns,
	type RowLayout,
	rowLayout
} from "#compiler/write/family/statements.ts"
import { inputSlots } from "#compiler/write/frontend/compile.ts"
import type { InsertResult, WriteNames } from "#compiler/write/insert/statement.ts"
import { bindWrite, type Chunks } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, refusalLoc, succeeded } from "#test/support/assert.ts"
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
 * per family, and a candidate key every insert and put of it probes), O2 (a sum fold over the members whose `on` holds)
 * and O3 (a count only); and D, in the counted family
 * of the immutable owner F with a sum fold, whose family is fixed when F is inserted. The commands: insert owners;
 * append a member; remove one; change a step value; change a selection; move a member to another group; put an owner;
 * an identical repeat of an appended member (one fact); a conflicting repeat at one new key (refused by the member's key
 * law, before any SQL); an append with its owner inserted in the same ChangeSet; an F inserted with its members; the
 * exact repeat of a stored owner with its stored members, O1 with its A members or F with its D members, which changes
 * nothing; and that repeat with one new member, an append to O1, and to F the immutable owner's refusal (rows-first.md
 * §2: the owner's key is read, and an owner stored at it makes the group a stored one); a D appended to a stored F the
 * ChangeSet does not insert, and a stored D removed, both refused when they compile, at the member's write; and an
 * insert, put or delete of an O1 fact that states its drawn count or its accumulated end, refused at bind by its shape.
 *
 * And the chain of H, K and L, K a member of H's counted family and the owner of L's: an L appended under a K and that K
 * under an H, each inserted in the same ChangeSet or already stored, a K inserted as a member with its own family empty;
 * and a put of an H and of a K under it, each stored or not, an owner put in place and inserted only where no row is.
 *
 * And G, a mutable owner whose row check reads its end against a written field, as an invoice's lines sum to its
 * amount: its members E sum to its `total` (`t = total`). The commands: a G stated with its members, its total their
 * sum, by an insertion or by a put of a G no row stores, whose row carries the count and end its members draw; that
 * insertion's exact repeat, which changes nothing; a put of a stored G at its total, and at another, which the
 * check refuses at the UPDATE; and a put of a G no row stores, at a total of 0, inserted with its family empty, and at
 * another, which the check refuses at its starts (rows-first.md §3: a put of an owner updates a stored one and inserts
 * only one that isn't stored).
 *
 * The oracles:
 * - the specification of each law, as a checker over the host tables: after every statement every immediate law holds
 *   (each member's ‹i› below its ‹n›, its ‹n› its owner's count, each group's ‹i› distinct), and after the last every
 *   law does (each group's slots exactly 0 … n − 1, its count n), so updates that move a member into a freed slot must
 *   precede the count that shrinks the group (write/family/order.ts);
 * - a second implementation of every fold: NP's reference fold (test/support/families/fold.ts `folded`) over each
 *   group's members in slot order, which every hidden accumulator and every owner's end must equal;
 * - the model's own state: each member's group, value and selection, each owner's fields;
 * - PostgreSQL's privileges, which a whole writer holds: an immutable owner's row is never updated, so no count
 *   statement names one;
 * - PostgreSQL's order at an insert (19rc1 nodeModifyTable.c ExecInsert): every row an owner's insert statement
 *   proposes, a field its input does not carry at its start, is judged by its relation's check before its arbiter
 *   meets a stored row at its key. Which facts a statement proposes is its act's (write/insert/statement.ts InsertOf),
 *   and that its SQL proposes exactly those is the pg suites' to prove (test/schedules/platform/refunds.test.ts).
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
		code: pg.bigint,
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
/** An immutable owner and its member: F's family is fixed when F is inserted. */
const F = relation("F", { id: uuid, n: drawn(natural), t: accumulated(pg.bigint, 0n) }, ["id"])
const D = relation("D", { id: uuid, f: uuid, x: pg.bigint }, ["id"])
const fd = counted(on(D, "f"), fin(F, "n"))
/** A mutable owner whose check reads its end: its members' values sum to its total. */
const G = relation(
	"G",
	{ id: uuid, total: pg.bigint, n: drawn(natural), t: accumulated(pg.bigint, 0n) },
	["id"]
)
const E = relation("E", { id: uuid, g: uuid, x: pg.bigint }, ["id"])
const fe = counted(on(E, "g"), fin(G, "n"))
/** A chain of counted families: K is a member of H's family and the owner of L's, so it is inserted as a member, its
 * own family empty, and put in place as an owner is. */
const H = relation("H", { id: uuid, nk: drawn(natural) }, ["id"])
const K = relation("K", { id: uuid, h: uuid, nl: drawn(natural) }, ["id"])
const L = relation("L", { id: uuid, k: uuid }, ["id"])
const fk = counted(on(K, "h"), fin(H, "nk"))
const fl = counted(on(L, "k"), fin(K, "nl"))
/** A mutable owner W whose counted members V copy its rate and the end of the sum fold over its ordered members U: a
 * put of W and an edit of its U each change a column a V appended in the same ChangeSet copies. */
const W = relation(
	"W",
	{
		id: uuid,
		rate: pg.bigint,
		nu: drawn(natural),
		tu: accumulated(pg.bigint, 0n),
		nv: drawn(natural)
	},
	["id"]
)
const U = relation("U", { id: uuid, w: uuid, at: drawn(natural), x: pg.bigint }, ["id"])
const V = relation(
	"V",
	{ id: uuid, w: uuid, r: accumulated(pg.bigint, 0n), t: accumulated(pg.bigint, 0n) },
	["id"]
)
const fu = ordered(on(U, "w", "at"), fin(W, "nu"))
const fv = counted(on(V, "w"), fin(W, "nv"))
const Algebra = schema("Algebra", { O1, O2, O3, A, B, C, F, D, G, E, H, K, L, W, U, V }, [
	fk,
	fl,
	fu,
	fv,
	fold(fu, Monoid.sum, on(U, "w", "x"), on(W, "id", "tu")),
	contained(on(V, "w", "r"), on(W, "id", "rate")),
	contained(on(V, "w", "t"), on(W, "id", "tu")),
	mutable(W),
	mutable(H),
	mutable(K),
	fa1,
	fb1,
	fb2,
	fc1,
	fc2,
	fc3,
	fd,
	fe,
	fold(fa1, Monoid.sum, on(A, "o1", "x"), on(O1, "id", "ta")),
	fold(fd, Monoid.sum, on(D, "f", "x"), on(F, "id", "t")),
	fold(fe, Monoid.sum, on(E, "g", "x"), on(G, "id", "t")),
	check("GExact", G, (g) => g.eq(g.t, g.total)),
	key(on(O1, "code")),
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
	mutable(C),
	mutable(G)
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

/** A member of the immutable F: its owner and its value. */
interface FixedMember {
	readonly owner: number
	readonly x: number
}

interface Model {
	readonly owners: Readonly<Record<OwnerName, ReadonlyMap<number, number>>>
	readonly members: Readonly<Record<MemberName, ReadonlyMap<number, ModelMember>>>
	/** The stored F owners, and their D members by id. */
	readonly fixedOwners: ReadonlySet<number>
	readonly fixedMembers: ReadonlyMap<number, FixedMember>
	/** The stored G owners by id, each with its total, and their E members by id, each with its owner and value. */
	readonly exactOwners: ReadonlyMap<number, number>
	readonly exactMembers: ReadonlyMap<number, FixedMember>
	/** The stored H owners, the stored K members by id with their H, and the stored L members by id with their K. */
	readonly chainOwners: ReadonlySet<number>
	readonly chainMembers: ReadonlyMap<number, number>
	readonly chainLeaves: ReadonlyMap<number, number>
	/** The stored W owners by id with their rates, their U members by id in slot order with their owners and values,
	 * and their V members by id with their owners. */
	readonly rated: ReadonlyMap<number, number>
	readonly lines: ReadonlyMap<number, FixedMember>
	readonly copies: ReadonlyMap<number, number>
}

const initial: Model = {
	owners: { O1: new Map(), O2: new Map(), O3: new Map() },
	members: { A: new Map(), B: new Map(), C: new Map() },
	fixedOwners: new Set(),
	fixedMembers: new Map(),
	exactOwners: new Map(),
	exactMembers: new Map(),
	chainOwners: new Set(),
	chainMembers: new Map(),
	chainLeaves: new Map(),
	rated: new Map(),
	lines: new Map(),
	copies: new Map()
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
	readonly fixedWithMembers: {
		readonly owner: number
		readonly members: ReadonlyArray<{ readonly id: number; readonly x: number }>
	}
	readonly mutableRepeat: { readonly owner: number }
	readonly fixedRepeat: { readonly owner: number }
	readonly mutableRepeatAppend: { readonly owner: number; readonly id: number; readonly x: number }
	readonly fixedRepeatAppend: { readonly owner: number; readonly id: number; readonly x: number }
	/** A D appended to a stored F the ChangeSet does not insert: refused when it compiles. */
	readonly fixedAppend: { readonly owner: number; readonly id: number; readonly x: number }
	/** A stored D removed: its immutable owner's family is fixed, so refused when it compiles. */
	readonly fixedRemove: { readonly id: number }
	/** A write of a stored O1's fact stating a field grizzle writes, its drawn count or its accumulated end. */
	readonly drawnFact: {
		readonly id: number
		readonly op: "insert" | "put" | "delete"
		readonly field: "na" | "ta"
	}
	readonly gWithMembers: {
		readonly owner: number
		readonly members: Arr.NonEmptyReadonlyArray<{ readonly id: number; readonly x: number }>
		/** How the ChangeSet states the owner: an insertion, or a put of a G no row stores. */
		readonly by: "insert" | "put"
	}
	readonly gPut: { readonly owner: number; readonly total: number }
	readonly gFreshPut: { readonly owner: number; readonly total: number }
	readonly gRepeat: { readonly owner: number }
	/** An L inserted under a K, and that K under an H, each inserted in the same ChangeSet or already stored. */
	readonly chainAppend: {
		readonly h: number
		readonly k: number
		readonly l: number
		readonly insertH: boolean
		readonly insertK: boolean
	}
	/** A put of an H and of a K under it, each stored or not. */
	readonly chainPut: { readonly h: number; readonly k: number }
	/** A W inserted with its U members nested in order. */
	readonly wInsert: {
		readonly owner: number
		readonly rate: number
		readonly lines: ReadonlyArray<{ readonly id: number; readonly x: number }>
	}
	/** A put of a stored W at a rate, and a V appended under it, in one ChangeSet. */
	readonly wPutAppend: { readonly owner: number; readonly rate: number; readonly v: number }
	/** A U appended to a stored W, or a stored U removed, and a V appended under that W, in one ChangeSet. */
	readonly wEditAppend: {
		readonly owner: number
		readonly edit:
			| { readonly kind: "append"; readonly id: number; readonly x: number }
			| { readonly kind: "remove"; readonly id: number }
		readonly v: number
	}
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

/** The verdicts a step's refusal states: a member's key law, an immutable owner's fixed family, G's check, or a fact
 * stating a field grizzle writes. */
type Refusal = "key" | "fixed" | "check" | "shape"

const freeFixedIds = (m: Model): ReadonlyArray<number> =>
	Arr.filter(ids(MEMBER_IDS), (i) => !m.fixedMembers.has(i))

/** A fixed owner's stored members, by id. */
const fixedMembersOf = (m: Model, owner: number): ReadonlyArray<readonly [number, FixedMember]> =>
	Arr.filter([...m.fixedMembers], ([, member]) => member.owner === owner)

const freeExactIds = (m: Model): ReadonlyArray<number> =>
	Arr.filter(ids(MEMBER_IDS), (i) => !m.exactMembers.has(i))

/** A G owner's stored E members, by id. */
const exactMembersOf = (m: Model, owner: number): ReadonlyArray<readonly [number, FixedMember]> =>
	Arr.filter([...m.exactMembers], ([, member]) => member.owner === owner)

/** The ids of `n` that `stored` does not hold. */
const freeChainIds = (
	stored: { readonly has: (k: number) => boolean },
	n: number
): ReadonlyArray<number> => Arr.filter(ids(n), (i) => !stored.has(i))

/** An O1 owner's stored A members, by id. */
const aMembersOf = (m: Model, owner: number): ReadonlyArray<readonly [number, ModelMember]> =>
	Arr.filter([...m.members.A], ([, member]) => member.groups[0] === owner)

const machine: Machine<Model, Params, Refusal> = {
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
		},
		fixedWithMembers: {
			weight: 2,
			applies: (m) => m.fixedOwners.size < OWNER_IDS && freeFixedIds(m).length >= 2,
			parameters: (m) => (source) => {
				const free = freeFixedIds(m)
				const n = source.draw(int(0, 2))
				return {
					owner: source.draw(pick(Arr.filter(ids(OWNER_IDS), (i) => !m.fixedOwners.has(i)))),
					members: Arr.map(Arr.take(free, n), (id) => ({ id, x: source.draw(int(0, 3)) }))
				}
			},
			judge: (m, p) => {
				const members = new Map(m.fixedMembers)
				for (const d of p.members) {
					members.set(d.id, { owner: p.owner, x: d.x })
				}
				return accepted({
					...m,
					fixedOwners: new Set([...m.fixedOwners, p.owner]),
					fixedMembers: members
				})
			}
		},
		mutableRepeat: {
			weight: 1,
			applies: (m) => m.owners.O1.size > 0,
			parameters: (m) => (source) => ({ owner: source.draw(pick([...m.owners.O1.keys()])) }),
			judge: (m) => accepted(m)
		},
		fixedRepeat: {
			weight: 1,
			applies: (m) => m.fixedOwners.size > 0,
			parameters: (m) => (source) => ({ owner: source.draw(pick([...m.fixedOwners])) }),
			judge: (m) => accepted(m)
		},
		mutableRepeatAppend: {
			weight: 1,
			applies: (m) => m.owners.O1.size > 0 && m.members.A.size < MEMBER_IDS,
			parameters: (m) => (source) => ({
				owner: source.draw(pick([...m.owners.O1.keys()])),
				id: source.draw(freshId(m, "A")),
				x: source.draw(int(0, 3))
			}),
			judge: (m, p) => accepted(withMember(m, "A", p.id, { groups: [p.owner], x: p.x, on: true }))
		},
		fixedRepeatAppend: {
			weight: 1,
			applies: (m) => m.fixedOwners.size > 0 && freeFixedIds(m).length > 0,
			parameters: (m) => (source) => ({
				owner: source.draw(pick([...m.fixedOwners])),
				id: source.draw(pick(freeFixedIds(m))),
				x: source.draw(int(0, 3))
			}),
			judge: () => refusedVerdict("fixed")
		},
		fixedAppend: {
			weight: 1,
			applies: (m) => m.fixedOwners.size > 0 && freeFixedIds(m).length > 0,
			parameters: (m) => (source) => ({
				owner: source.draw(pick([...m.fixedOwners])),
				id: source.draw(pick(freeFixedIds(m))),
				x: source.draw(int(0, 3))
			}),
			judge: () => refusedVerdict("fixed")
		},
		fixedRemove: {
			weight: 1,
			applies: (m) => m.fixedMembers.size > 0,
			parameters: (m) => (source) => ({ id: source.draw(pick([...m.fixedMembers.keys()])) }),
			judge: () => refusedVerdict("fixed")
		},
		drawnFact: {
			weight: 1,
			applies: (m) => m.owners.O1.size > 0,
			parameters: (m) => (source) => ({
				id: source.draw(pick([...m.owners.O1.keys()])),
				op: source.draw(element(["insert", "put", "delete"] as const)),
				field: source.draw(element(["na", "ta"] as const))
			}),
			judge: () => refusedVerdict("shape")
		},
		gWithMembers: {
			weight: 2,
			applies: (m) => m.exactOwners.size < OWNER_IDS && freeExactIds(m).length >= 2,
			parameters: (m) => (source) => {
				const [first, second] = freeExactIds(m)
				const n = source.draw(int(1, 2))
				const member = (id: number | undefined) => ({
					id: defined(id, "a free E id"),
					x: source.draw(int(1, 3))
				})
				return {
					owner: source.draw(pick(Arr.filter(ids(OWNER_IDS), (i) => !m.exactOwners.has(i)))),
					members: n === 1 ? [member(first)] : [member(first), member(second)],
					by: source.draw(element(["insert", "put"] as const))
				}
			},
			judge: (m, p) => {
				const owners = new Map(m.exactOwners)
				owners.set(
					p.owner,
					Arr.reduce(p.members, 0, (sum, d) => sum + d.x)
				)
				const members = new Map(m.exactMembers)
				for (const d of p.members) {
					members.set(d.id, { owner: p.owner, x: d.x })
				}
				return accepted({ ...m, exactOwners: owners, exactMembers: members })
			}
		},
		gPut: {
			weight: 2,
			applies: (m) => m.exactOwners.size > 0,
			parameters: (m) => (source) => {
				const owner = source.draw(pick([...m.exactOwners.keys()]))
				const total = defined(m.exactOwners.get(owner), "a stored G")
				return { owner, total: source.draw(int(0, 2)) === 0 ? total + 1 : total }
			},
			/** The UPDATE writes the total and leaves the family, so the check holds exactly at the stored end. */
			judge: (m, p) =>
				p.total === m.exactOwners.get(p.owner) ? accepted(m) : refusedVerdict("check")
		},
		gFreshPut: {
			weight: 1,
			applies: (m) => m.exactOwners.size < OWNER_IDS,
			parameters: (m) => (source) => ({
				owner: source.draw(pick(Arr.filter(ids(OWNER_IDS), (i) => !m.exactOwners.has(i)))),
				total: source.draw(int(0, 1))
			}),
			/** An owner the put inserts starts with its family empty, its end at 0. */
			judge: (m, p) => {
				if (p.total !== 0) {
					return refusedVerdict("check")
				}
				const owners = new Map(m.exactOwners)
				owners.set(p.owner, 0)
				return accepted({ ...m, exactOwners: owners })
			}
		},
		gRepeat: {
			weight: 1,
			applies: (m) => m.exactOwners.size > 0,
			parameters: (m) => (source) => ({ owner: source.draw(pick([...m.exactOwners.keys()])) }),
			judge: (m) => accepted(m)
		},
		chainAppend: {
			weight: 2,
			applies: (m) =>
				freeChainIds(m.chainLeaves, MEMBER_IDS).length > 0 &&
				(m.chainMembers.size > 0 ||
					(freeChainIds(m.chainMembers, MEMBER_IDS).length > 0 &&
						(m.chainOwners.size > 0 || freeChainIds(m.chainOwners, OWNER_IDS).length > 0))),
			parameters: (m) => (source) => {
				const l = source.draw(pick(freeChainIds(m.chainLeaves, MEMBER_IDS)))
				const freeK = freeChainIds(m.chainMembers, MEMBER_IDS)
				const insertK =
					m.chainMembers.size === 0 || (freeK.length > 0 && source.draw(int(0, 1)) === 1)
				if (!insertK) {
					const k = source.draw(pick([...m.chainMembers.keys()]))
					return {
						h: defined(m.chainMembers.get(k), "a stored K's H"),
						k,
						l,
						insertH: false,
						insertK
					}
				}
				const freeH = freeChainIds(m.chainOwners, OWNER_IDS)
				const insertH =
					m.chainOwners.size === 0 || (freeH.length > 0 && source.draw(int(0, 1)) === 1)
				return {
					h: source.draw(pick(insertH ? freeH : [...m.chainOwners])),
					k: source.draw(pick(freeK)),
					l,
					insertH,
					insertK
				}
			},
			judge: (m, p) =>
				accepted({
					...m,
					chainOwners: new Set([...m.chainOwners, p.h]),
					chainMembers: new Map([...m.chainMembers, [p.k, p.h]]),
					chainLeaves: new Map([...m.chainLeaves, [p.l, p.k]])
				})
		},
		wInsert: {
			weight: 1,
			applies: (m) => m.rated.size < OWNER_IDS && freeChainIds(m.lines, MEMBER_IDS).length >= 2,
			parameters: (m) => (source) => {
				const free = freeChainIds(m.lines, MEMBER_IDS)
				const n = source.draw(int(0, 2))
				return {
					owner: source.draw(pick(freeChainIds(m.rated, OWNER_IDS))),
					rate: source.draw(int(0, 3)),
					lines: Arr.map(Arr.take(free, n), (id) => ({ id, x: source.draw(int(0, 3)) }))
				}
			},
			judge: (m, p) =>
				accepted({
					...m,
					rated: new Map([...m.rated, [p.owner, p.rate]]),
					lines: new Map([
						...m.lines,
						...Arr.map(p.lines, (l) => [l.id, { owner: p.owner, x: l.x }] as const)
					])
				})
		},
		wPutAppend: {
			weight: 2,
			applies: (m) => m.rated.size > 0 && freeChainIds(m.copies, MEMBER_IDS).length > 0,
			parameters: (m) => (source) => ({
				owner: source.draw(pick([...m.rated.keys()])),
				rate: source.draw(int(0, 3)),
				v: source.draw(pick(freeChainIds(m.copies, MEMBER_IDS)))
			}),
			judge: (m, p) =>
				accepted({
					...m,
					rated: new Map([...m.rated, [p.owner, p.rate]]),
					copies: new Map([...m.copies, [p.v, p.owner]])
				})
		},
		wEditAppend: {
			weight: 2,
			applies: (m) =>
				m.rated.size > 0 &&
				freeChainIds(m.copies, MEMBER_IDS).length > 0 &&
				(m.lines.size > 0 || freeChainIds(m.lines, MEMBER_IDS).length > 0),
			parameters: (m) => (source) => {
				const v = source.draw(pick(freeChainIds(m.copies, MEMBER_IDS)))
				const free = freeChainIds(m.lines, MEMBER_IDS)
				if (m.lines.size > 0 && (free.length === 0 || source.draw(int(0, 1)) === 1)) {
					const id = source.draw(pick([...m.lines.keys()]))
					const owner = defined(m.lines.get(id), "a stored U").owner
					return { owner, edit: { kind: "remove", id }, v }
				}
				return {
					owner: source.draw(pick([...m.rated.keys()])),
					edit: { kind: "append", id: source.draw(pick(free)), x: source.draw(int(0, 3)) },
					v
				}
			},
			judge: (m, p) => {
				const lines = new Map(m.lines)
				if (p.edit.kind === "append") {
					lines.set(p.edit.id, { owner: p.owner, x: p.edit.x })
				} else {
					lines.delete(p.edit.id)
				}
				return accepted({ ...m, lines, copies: new Map([...m.copies, [p.v, p.owner]]) })
			}
		},
		chainPut: {
			weight: 1,
			applies: (m) =>
				m.chainMembers.size > 0 || freeChainIds(m.chainMembers, MEMBER_IDS).length > 0,
			parameters: (m) => (source) => {
				const k = source.draw(
					pick([...freeChainIds(m.chainMembers, MEMBER_IDS), ...m.chainMembers.keys()])
				)
				const stored = m.chainMembers.get(k)
				return { h: stored ?? source.draw(int(0, OWNER_IDS - 1)), k }
			},
			judge: (m, p) =>
				accepted({
					...m,
					chainOwners: new Set([...m.chainOwners, p.h]),
					chainMembers: new Map([...m.chainMembers, [p.k, p.h]])
				})
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

/** An owner's fact as a ChangeSet states it: O1's with its cap and its code, a candidate key every insert probes. */
const ownerFact = (owner: OwnerName, id: number, cap: number) =>
	owner === "O1"
		? { id: ownerUuid(owner, id), cap: BigInt(cap), code: BigInt(id) }
		: { id: ownerUuid(owner, id) }

/** The immutable F's owners and D's members as uuids, apart from every other relation's. */
const fixedUuid = (id: number): string => uuidOf(4000 + id)
const dUuid = (id: number): string => uuidOf(40_000 + id)
const dFact = (id: number, owner: number, x: number) => ({
	id: dUuid(id),
	f: fixedUuid(owner),
	x: BigInt(x)
})

/** The chain's H, K and L as uuids, apart from every other relation's. */
const hUuid = (id: number): string => uuidOf(6000 + id)
const kUuid = (id: number): string => uuidOf(60_000 + id)
const lUuid = (id: number): string => uuidOf(70_000 + id)

/** G's owners and E's members as uuids, apart from every other relation's. */
const gUuid = (id: number): string => uuidOf(5000 + id)
const eUuid = (id: number): string => uuidOf(50_000 + id)
const eFact = (id: number, owner: number, x: number) => ({
	id: eUuid(id),
	g: gUuid(owner),
	x: BigInt(x)
})

const wUuid = (id: number): string => uuidOf(7000 + id)
const uUuid = (id: number): string => uuidOf(80_000 + id)
const vUuid = (id: number): string => uuidOf(90_000 + id)

/** A W's U members, by id, in slot order. */
const linesOf = (m: Model, owner: number): ReadonlyArray<readonly [number, FixedMember]> =>
	Arr.filter([...m.lines], ([, line]) => line.owner === owner)

/** A G stated by an insertion or a put, with its E members, its total their sum. */
const gWith = (
	owner: number,
	members: ReadonlyArray<readonly [number, FixedMember]>,
	by: "insert" | "put"
) => {
	const g = [{ id: gUuid(owner), total: BigInt(Arr.reduce(members, 0, (sum, [, d]) => sum + d.x)) }]
	const empty = ChangeSet.empty(Algebra)
	return (by === "insert" ? empty.insert(G, g) : empty.put(G, g)).insert(
		E,
		Arr.map(members, ([id, d]) => eFact(id, owner, d.x))
	)
}

/** A put of G's written fields, which sets its total in place when a G is stored at its key. */
const gPutOf = (q: { readonly owner: number; readonly total: number }) =>
	ChangeSet.empty(Algebra).put(G, [{ id: gUuid(q.owner), total: BigInt(q.total) }])

const gPutOwn = (db: Db, q: { readonly owner: number; readonly total: number }): void => {
	tableOf(db, "G")
		.get(keyText([gUuid(q.owner)]))
		?.set(fieldKey("total"), textOf(db, fieldOf("G", "total").type, BigInt(q.total)))
}

/** An O1 owner's exact repeat, with every A member stored under it. */
const mutableRepeatOf = (owner: number, m: Model) =>
	ChangeSet.empty(Algebra)
		.insert(O1, [ownerFact("O1", owner, defined(m.owners.O1.get(owner), "a stored O1"))])
		.insert(
			A,
			Arr.map(aMembersOf(m, owner), ([id, member]) => memberFact("A", id, member))
		)

/** An F owner's exact repeat, with every D member stored under it. */
const fixedRepeatOf = (owner: number, m: Model) =>
	ChangeSet.empty(Algebra)
		.insert(F, [{ id: fixedUuid(owner) }])
		.insert(
			D,
			Arr.map(fixedMembersOf(m, owner), ([id, member]) => dFact(id, owner, member.x))
		)

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
	},
	fixedWithMembers: {
		inserted: none,
		member: noMember,
		variant: noVariant,
		change: (q) =>
			ChangeSet.empty(Algebra)
				.insert(F, [{ id: fixedUuid(q.owner) }])
				.insert(
					D,
					Arr.map(q.members, (d) => dFact(d.id, q.owner, d.x))
				),
		own: none
	},
	mutableRepeat: {
		inserted: none,
		member: () => "A",
		variant: noVariant,
		change: (q, m) => mutableRepeatOf(q.owner, m),
		own: none
	},
	fixedRepeat: {
		inserted: none,
		member: noMember,
		variant: noVariant,
		change: (q, m) => fixedRepeatOf(q.owner, m),
		own: none
	},
	mutableRepeatAppend: {
		inserted: none,
		member: () => "A",
		variant: noVariant,
		change: (q, m) =>
			mutableRepeatOf(q.owner, m).insert(A, [
				memberFact("A", q.id, { groups: [q.owner], x: q.x, on: true })
			]),
		own: none
	},
	fixedRepeatAppend: {
		inserted: none,
		member: noMember,
		variant: noVariant,
		change: (q, m) => fixedRepeatOf(q.owner, m).insert(D, [dFact(q.id, q.owner, q.x)]),
		own: none
	},
	fixedAppend: {
		inserted: none,
		member: noMember,
		variant: noVariant,
		change: (q) => ChangeSet.empty(Algebra).insert(D, [dFact(q.id, q.owner, q.x)]),
		own: none
	},
	fixedRemove: {
		inserted: none,
		member: noMember,
		variant: noVariant,
		change: (q, m) => {
			const d = defined(m.fixedMembers.get(q.id), "a stored D")
			return ChangeSet.empty(Algebra).delete(D, [dFact(q.id, d.owner, d.x)])
		},
		own: none
	},
	drawnFact: {
		inserted: none,
		member: noMember,
		variant: (q) => `${q.op}:${q.field}`,
		change: (q, m) =>
			ChangeSet.empty(Algebra)[q.op](O1, [
				{
					...ownerFact("O1", q.id, defined(m.owners.O1.get(q.id), "a stored O1")),
					[q.field]: 0n
				}
			]),
		own: none
	},
	gWithMembers: {
		inserted: none,
		member: noMember,
		variant: (q) => q.by,
		change: (q) =>
			gWith(
				q.owner,
				Arr.map(q.members, (d) => [d.id, { owner: q.owner, x: d.x }] as const),
				q.by
			),
		own: none
	},
	gPut: { inserted: none, member: noMember, variant: noVariant, change: gPutOf, own: gPutOwn },
	gFreshPut: { inserted: none, member: noMember, variant: noVariant, change: gPutOf, own: gPutOwn },
	gRepeat: {
		inserted: none,
		member: noMember,
		variant: noVariant,
		change: (q, m) => gWith(q.owner, exactMembersOf(m, q.owner), "insert"),
		own: none
	},
	chainAppend: {
		inserted: none,
		member: noMember,
		variant: (q) => `${q.insertH}:${q.insertK}`,
		change: (q) => {
			const withH = q.insertH
				? ChangeSet.empty(Algebra).insert(H, [{ id: hUuid(q.h) }])
				: ChangeSet.empty(Algebra)
			const withK = q.insertK ? withH.insert(K, [{ id: kUuid(q.k), h: hUuid(q.h) }]) : withH
			return withK.insert(L, [{ id: lUuid(q.l), k: kUuid(q.k) }])
		},
		own: none
	},
	chainPut: {
		inserted: none,
		member: noMember,
		variant: noVariant,
		change: (q) =>
			ChangeSet.empty(Algebra)
				.put(H, [{ id: hUuid(q.h) }])
				.put(K, [{ id: kUuid(q.k), h: hUuid(q.h) }]),
		own: none
	},
	wInsert: {
		inserted: none,
		member: noMember,
		variant: noVariant,
		change: (q) =>
			ChangeSet.empty(Algebra).insert(W, [
				{
					id: wUuid(q.owner),
					rate: BigInt(q.rate),
					nu: Arr.map(q.lines, (l) => ({ id: uUuid(l.id), x: BigInt(l.x) }))
				}
			]),
		own: none
	},
	wPutAppend: {
		inserted: none,
		member: noMember,
		variant: noVariant,
		change: (q) =>
			ChangeSet.empty(Algebra)
				.put(W, [{ id: wUuid(q.owner), rate: BigInt(q.rate) }])
				.insert(V, [{ id: vUuid(q.v), w: wUuid(q.owner) }]),
		own: (db, q) => {
			const key = keyText([wUuid(q.owner)])
			defined(tableOf(db, "W").get(key), "a stored W").set(
				fieldKey("rate"),
				textOf(db, fieldOf("W", "rate").type, BigInt(q.rate))
			)
			cascade(db, "W", key)
		}
	},
	wEditAppend: {
		inserted: none,
		member: noMember,
		variant: (q) => q.edit.kind,
		change: (q, m) => {
			const edit = q.edit
			const edited =
				edit.kind === "append"
					? ChangeSet.empty(Algebra).put(U, [
							{ id: uUuid(edit.id), w: wUuid(q.owner), x: BigInt(edit.x) }
						])
					: ChangeSet.empty(Algebra).delete(U, [
							{
								id: uUuid(edit.id),
								w: wUuid(q.owner),
								x: BigInt(defined(m.lines.get(edit.id), "a stored U").x)
							}
						])
			return edited.insert(V, [{ id: vUuid(q.v), w: wUuid(q.owner) }])
		},
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
const programs = new Map<string, Result.Result<CompiledWrite, CompileError>>()
/** The program of a step's ChangeSet shape, or the compiler's refusal of it, compiled once per command and relation. */
const programOf = (shape: string, value: unknown): Result.Result<CompiledWrite, CompileError> => {
	const known = programs.get(shape)
	if (known !== undefined) {
		return known
	}
	const built = compileWrite(checking(Algebra), descOf(value), {
		names,
		reads: names,
		claims: { kind: "every" },
		world: { kind: "reality" },
		laws: artifacts.laws,
		derived: artifacts.derived
	})
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

const layoutOf = (relation: string): RowLayout => rowLayout(relationInfo(relation), families)

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

/** Each relation's row check, over a row's texts: G's end is its total. */
const rowChecks: Readonly<Record<string, (row: ReadonlyMap<ColumnKey, string>) => boolean>> = {
	G: (row) => num(row.get(fieldKey("t"))) === num(row.get(fieldKey("total")))
}

/** Whether a row holds its relation's check, as PostgreSQL judges an inserted or updated row. */
const checkHolds = (relation: string, row: ReadonlyMap<ColumnKey, string>): boolean =>
	rowChecks[relation]?.(row) ?? true

/** The text a field is written at when its statement's input does not carry it (insert/statement.ts startOf): a
 * drawn count at 0 and an accumulated end at its start; none for any other field. */
const startText = (db: Db, field: LawField): string | undefined => {
	switch (field.writing.kind) {
		case "drawn":
			return "0"
		case "accumulated":
			return textOf(
				db,
				field.type,
				literalHost(carrierSpecOf(field.type, db.codes), field.writing.start)
			)
		case "caller":
		case "serial":
		case "generated":
			return undefined
	}
}

/**
 * An owner's insert statement run on the host table, as PostgreSQL runs it (19rc1 nodeModifyTable.c ExecInsert): its
 * requested facts, as its encoded arrays carry them, each placeholder's array its slot's column at its part, a field
 * the slot does not carry at its start. The statement proposes the facts its result says (write/insert/statement.ts
 * Proposal), each judged by its relation's check before its arbiter meets a stored row at its key. A stored row at a
 * requested key that agrees at every field its facts carry is an insertion's exact repeat, no change, and one that
 * disagrees is the key law's refusal, whether the arbiter met it or the statement read it, unproposed; at a put's key it
 * is the row the put's UPDATE wrote. An owner insert's slot carries the counts and ends its stratum's appends drew
 * (write/program/bind.ts), so its row is judged as its insert writes it.
 */
const insertEncoded = (
	db: Db,
	compiled: CompiledWrite,
	slots: ReadonlyArray<WriteSlot>,
	relation: string,
	result: Pick<InsertResult, "of" | "proposes">,
	executions: ReadonlyArray<ReadonlyArray<string>>
): Refusal | undefined => {
	const info = relationInfo(relation)
	const table = tableOf(db, relation)
	const requested: Array<readonly [string, Map<ColumnKey, string>]> = []
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
			for (const f of info.fields) {
				const start = startText(db, f)
				if (start !== undefined && !row.has(fieldKey(f.name))) {
					row.set(fieldKey(f.name), start)
				}
			}
			requested.push([keyText([id]), row])
		}
	}
	const proposed = Arr.filter(requested, ([key]) => result.proposes === "every" || !table.has(key))
	if (!Arr.every(proposed, ([, row]) => checkHolds(relation, row))) {
		return "check"
	}
	const carried = Arr.filter(info.fields, (f) => f.writing.kind === "caller" && f.name !== "id")
	for (const [key, row] of requested) {
		const stored = table.get(key)
		if (stored === undefined) {
			table.set(key, row)
		} else if (
			result.of === "insert" &&
			!Arr.every(carried, (f) => stored.get(fieldKey(f.name)) === row.get(fieldKey(f.name)))
		) {
			return "key"
		}
	}
	return undefined
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

/**
 * An owner row's change as its owner axes' ON UPDATE CASCADE carries it into its members: every member of each family
 * of `relation`, a tree's aside, that names the row at `key` takes the owner's count as its ‹n› and each column the axis
 * carries from it.
 */
const cascade = (db: Db, relation: string, key: string): void => {
	const owner = defined(tableOf(db, relation).get(key), "a cascaded owner")
	for (const f of families) {
		if (f.owner.name !== relation || f.members.kind === "tree") {
			continue
		}
		for (const member of tableOf(db, f.member.name).values()) {
			if (ownerKeyOf(f, member) !== key) {
				continue
			}
			member.set(`law:${f.copy}`, defined(owner.get(fieldKey(f.count.name)), "an owner's count"))
			for (const pair of f.axes.owner) {
				if (
					pair.from.kind === "field" &&
					pair.from.field.writing.kind === "accumulated" &&
					pair.to.kind === "field"
				) {
					member.set(
						columnKey(pair.from),
						defined(owner.get(columnKey(pair.to)), "a column an owner axis carries")
					)
				}
			}
		}
	}
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
		assert.ok(
			rows.length === 0 || relationInfo(f.owner.name).mutable,
			"no count statement updates an immutable owner's row, which a whole writer holds no UPDATE on"
		)
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
			cascade(db, f.owner.name, key)
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
			for (const pair of f.axes.owner) {
				if (
					pair.from.kind === "field" &&
					pair.from.field.writing.kind === "accumulated" &&
					pair.to.kind === "field"
				) {
					assert.equal(
						row.get(columnKey(pair.from)),
						owner.get(columnKey(pair.to)),
						`${at}: ${f.member.name}.${pair.from.field.name} is its owner's ${pair.to.field.name}`
					)
				}
			}
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
	const gTable = tableOf(db, "G")
	assert.deepEqual(
		Arr.sort([...gTable.keys()], Order.String),
		Arr.sort(
			Arr.map([...model.exactOwners.keys()], (id) => keyText([gUuid(id)])),
			Order.String
		),
		"the G owners are the model's"
	)
	for (const [id, total] of model.exactOwners) {
		const row = defined(gTable.get(keyText([gUuid(id)])), "a modelled G is stored")
		assert.equal(num(row.get(fieldKey("total"))), BigInt(total), "a G's total is the model's")
		assert.ok(checkHolds("G", row), "a G's end is its total at commit")
	}
	const eTable = tableOf(db, "E")
	assert.equal(eTable.size, model.exactMembers.size, "the G owners' members are the model's")
	for (const [id, member] of model.exactMembers) {
		const row = defined(eTable.get(keyText([eUuid(id)])), "a modelled E is stored")
		assert.equal(row.get(fieldKey("g")), gUuid(member.owner), "an E's owner is the model's")
		assert.equal(num(row.get(fieldKey("x"))), BigInt(member.x), "an E's value is the model's")
	}
	assert.deepEqual(
		Arr.sort([...tableOf(db, "F").keys()], Order.String),
		Arr.sort(
			Arr.map([...model.fixedOwners], (id) => keyText([fixedUuid(id)])),
			Order.String
		),
		"the immutable owners are the model's"
	)
	assert.deepEqual(
		Arr.sort([...tableOf(db, "H").keys()], Order.String),
		Arr.sort(
			Arr.map([...model.chainOwners], (id) => keyText([hUuid(id)])),
			Order.String
		),
		"the chain's owners are the model's"
	)
	for (const [relation, stored, uuidFor, ownerUuidFor, field] of [
		["K", model.chainMembers, kUuid, hUuid, "h"],
		["L", model.chainLeaves, lUuid, kUuid, "k"]
	] as const) {
		const table = tableOf(db, relation)
		assert.equal(table.size, stored.size, "the chain's members are the model's")
		for (const [id, owner] of stored) {
			const row = defined(table.get(keyText([uuidFor(id)])), "a modelled chain member is stored")
			assert.equal(
				row.get(fieldKey(field)),
				ownerUuidFor(owner),
				"a chain member's owner is the model's"
			)
		}
	}
	const wTable = tableOf(db, "W")
	assert.equal(wTable.size, model.rated.size, "the W owners are the model's")
	for (const [id, rate] of model.rated) {
		const row = defined(wTable.get(keyText([wUuid(id)])), "a modelled W is stored")
		assert.equal(num(row.get(fieldKey("rate"))), BigInt(rate), "a W's rate is the model's")
		assert.equal(
			num(row.get(fieldKey("tu"))),
			Arr.reduce(linesOf(model, id), 0n, (sum, [, line]) => sum + BigInt(line.x)),
			"a W's end is its U members' sum"
		)
		for (const [slot, [lineId]] of linesOf(model, id).entries()) {
			const line = defined(tableOf(db, "U").get(keyText([uUuid(lineId)])), "a modelled U is stored")
			assert.equal(num(line.get(fieldKey("at"))), BigInt(slot), "a U keeps its order among its W's")
		}
	}
	assert.equal(tableOf(db, "U").size, model.lines.size, "the W owners' U members are the model's")
	const vTable = tableOf(db, "V")
	assert.equal(vTable.size, model.copies.size, "the W owners' V members are the model's")
	for (const [id, owner] of model.copies) {
		const row = defined(vTable.get(keyText([vUuid(id)])), "a modelled V is stored")
		const w = defined(wTable.get(keyText([wUuid(owner)])), "a V's W")
		assert.equal(row.get(fieldKey("w")), wUuid(owner), "a V's owner is the model's")
		assert.equal(row.get(fieldKey("r")), w.get(fieldKey("rate")), "a V's rate is its W's")
		assert.equal(row.get(fieldKey("t")), w.get(fieldKey("tu")), "a V's end is its W's")
	}
	const dTable = tableOf(db, "D")
	assert.equal(
		dTable.size,
		model.fixedMembers.size,
		"the immutable owners' members are the model's"
	)
	for (const [id, member] of model.fixedMembers) {
		const row = defined(dTable.get(keyText([dUuid(id)])), "a modelled D is stored")
		assert.equal(row.get(fieldKey("f")), fixedUuid(member.owner), "a D's owner is the model's")
		assert.equal(num(row.get(fieldKey("x"))), BigInt(member.x), "a D's value is the model's")
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
			const program = programOf(shape, value)
			if (!program.ok) {
				assert.equal(
					program.error.reason._tag,
					"UnsupportedOperation",
					"a write the compiler refuses"
				)
				const at = refusalLoc(program.error)
				const written = defined(
					Option.getOrUndefined(
						Arr.findFirst(
							Arr.flatMap(descOf(value).strata, (s) => s.members),
							(m) => m.relation === "D"
						)
					),
					"the immutable owner's member write"
				).loc
				assert.deepEqual(
					{ label: at.label, path: at.path },
					{ label: written.label, path: written.path },
					"the refusal is the member write's"
				)
				/** An immutable owner's family changed without its owner's insert is refused when it compiles, at the
				 * member's write. */
				const answer: Answer<Refusal> = refusedVerdict("fixed")
				return answer
			}
			const compiled = program.value
			const members = yield* collectInputs(compiled.frontend, parsedOf(value).inputs)
			const binding = bindWrite(compiled, { members, params: {}, transport })
			if (!binding.ok) {
				assert.ok(
					binding.error._tag === "EncodingFailure" && binding.error.reason._tag === "factShape",
					"a fact stating a field grizzle writes is refused by its shape"
				)
				/** A fact stating a field grizzle writes is refused at bind, before any SQL. */
				const answer: Answer<Refusal> = refusedVerdict("shape")
				return answer
			}
			const bound = binding.value
			if (bound.kind === "invariant-rejected") {
				assert.equal(
					bound.law,
					algebraLaws.primaryKeyLaw(
						memberRelations[defined(member, "a refused member write's relation")]
					),
					"two facts at one key are refused by the member's key law"
				)
				const answer: Answer<Refusal> = refusedVerdict("key")
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
			const planned =
				flights.kind === "write"
					? Result.ok(flights.chunks)
					: flights.writes(
							Arr.map(flights.reads, (r) =>
								readRows(db, defined(familyOfStep(r.family), "a read's family"))
							)
						)
			if (!planned.ok) {
				assert.ok(
					isCompileError(planned.error) && planned.error.reason._tag === "UnsupportedOperation",
					"a write the planner refuses is an immutable owner's fixed family"
				)
				/** An immutable owner's stored family refuses the change once the read has found it, before any write. */
				const answer: Answer<Refusal> = refusedVerdict("fixed")
				return answer
			}
			const chunks: Chunks = planned.value
			/** A statement's refusal aborts the transaction: the tables are as before the step. */
			const refuse = (verdict: Refusal): Answer<Refusal> => {
				const restored = [...before_]
				db.tables.clear()
				for (const [name, table] of restored) {
					db.tables.set(name, table)
				}
				return refusedVerdict(verdict)
			}
			/** Every row a statement wrote holds its relation's check, which PostgreSQL judges at the row. */
			const checked = (): boolean =>
				Arr.every(Rec.keys(rowChecks), (relation) =>
					Arr.every([...tableOf(db, relation).values()], (row) => checkHolds(relation, row))
				)
			stated[command].own(db, p)
			if (!checked()) {
				return refuse("check")
			}
			for (const statement of compiled.artifacts.optimized.statements) {
				const s = statement.step
				if (
					s.kind === "write" &&
					s.result.kind === "insert" &&
					(s.relation in ownerRelations ||
						s.relation === "F" ||
						s.relation === "G" ||
						s.relation === "H" ||
						s.relation === "W")
				) {
					const verdict = insertEncoded(
						db,
						compiled,
						bound.form(statement).paramSlots,
						s.relation,
						s.result,
						succeeded(chunks(statement))
					)
					if (verdict !== undefined) {
						return refuse(verdict)
					}
				}
			}
			stated[command].inserted(db, p)
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
						return refuse("key")
					}
					if (!checked()) {
						return refuse("check")
					}
					immediateHold(db, `after ${command}'s ${step.statement} of ${step.relation}`)
				}
			}
			commitHolds(db, after)
			model.current = after
			return took
		})

interface MachineCase {
	readonly steps: ReturnType<ReturnType<typeof program<Model, Params, Refusal>>>
	readonly oneRowEach: boolean
}

type MachineFeature = StepFeature<Params, Refusal> | "a statement per row"

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
				"storedConflict",
				"fixedWithMembers",
				"mutableRepeat",
				"fixedRepeat",
				"mutableRepeatAppend",
				"fixedRepeatAppend",
				"fixedAppend",
				"fixedRemove",
				"drawnFact",
				"gWithMembers",
				"gPut",
				"gFreshPut",
				"gRepeat",
				"chainAppend",
				"chainPut",
				"wInsert",
				"wPutAppend",
				"wEditAppend"
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
								"fixedWithMembers accepted",
								"mutableRepeat accepted",
								"fixedRepeat accepted",
								"mutableRepeatAppend accepted",
								"fixedRepeatAppend refused fixed",
								"fixedAppend refused fixed",
								"fixedRemove refused fixed",
								"drawnFact refused shape",
								"gWithMembers accepted",
								"gPut accepted",
								"gPut refused check",
								"gFreshPut accepted",
								"gFreshPut refused check",
								"gRepeat accepted",
								"chainAppend accepted",
								"chainPut accepted",
								"wInsert accepted",
								"wPutAppend accepted",
								"wEditAppend accepted",
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
							const real: Real<Model, Params, Refusal, never, never> = {
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
								storedConflict: step("storedConflict"),
								fixedWithMembers: step("fixedWithMembers"),
								mutableRepeat: step("mutableRepeat"),
								fixedRepeat: step("fixedRepeat"),
								mutableRepeatAppend: step("mutableRepeatAppend"),
								fixedRepeatAppend: step("fixedRepeatAppend"),
								fixedAppend: step("fixedAppend"),
								fixedRemove: step("fixedRemove"),
								drawnFact: step("drawnFact"),
								gWithMembers: step("gWithMembers"),
								gPut: step("gPut"),
								gFreshPut: step("gFreshPut"),
								gRepeat: step("gRepeat"),
								chainAppend: step("chainAppend"),
								chainPut: step("chainPut"),
								wInsert: step("wInsert"),
								wPutAppend: step("wPutAppend"),
								wEditAppend: step("wEditAppend")
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
