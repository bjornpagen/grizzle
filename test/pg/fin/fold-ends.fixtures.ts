/** What the properties of fold-ends.test.ts read: its spaces, models and helpers. */

import { assert, deepEquals, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { constant, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { type Swarm, swarm, swarmChoice } from "@bjornpagen/testing/swarm"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, type Scope } from "effect"
import { memberCalls, type OnceCalls, type WrittenOutcome } from "#adapter/db/handles.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import type { MonoidName } from "#compiler/ir/desc.ts"
import type { Law } from "#compiler/public/changeset.ts"
import type { AnyLogin, AnyLoginRole } from "#compiler/public/schema.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import type { WriteAnswer } from "#test/support/calls.ts"
import {
	type Breaking,
	type Broken,
	brokenOf,
	type Cell,
	type CellLabel,
	cellLabel,
	emptyState,
	type FamilyKind,
	familyKinds,
	type FoldSchema,
	foldSchema,
	type Group,
	memberKeyOf,
	membersOf,
	type MemberState,
	type ModelRow,
	type Node,
	type OwnerState,
	type State,
	stepFacts,
	stepsGen,
	storedRows,
	times,
	treeFact,
	treeRows
} from "#test/support/families/ends.ts"
import { type Generated, type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { refusedLaws } from "#test/support/refused.ts"
import {
	member,
	openServedDbOf,
	type ServedDb,
	type ServedFixture,
	servedFixture
} from "#test/support/served-db.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/**
 * Every fold's end and running values after every write grizzle's apply makes of a family, on PostgreSQL 19: what
 * PostgreSQL holds after each write, applied as a served member with its call's facts, is exactly what the host model
 * of the README's family semantics states (test/support/families/ends.ts), and every lawful write is accepted.
 *
 * The space is grizzle's own rosters (ends.ts): every monoid of the closed set over every plane its admission accepts,
 * sets over rosters of one code to nine, in each family kind that folds it, one schema per kind, installed once. A case
 * is a program of up to four ChangeSets from an empty state, its forms drawn under a swarm and each one relative to the
 * model's state, so every write is lawful by construction and no form a kind refuses is ever drawn:
 *
 * - a counted family: owners inserted with their members as separate inserts of one ChangeSet (the README's form for
 *   an entry and its postings), one owner or several, members appended to a stored owner, deleted, put with new steps,
 *   moved to another owner, and an owner put beside an append to its families;
 * - an ordered family: owners inserted with their members nested, one or several, members deleted, members put with
 *   new steps, and an owner put;
 * - a tree: trees inserted whole, one or several.
 *
 * The oracle is the model: each owner's count and every end, each ordered member's slot and named running values, each
 * tree node's drawn fields and its fold of its children, held against every stored row of every relation after each
 * write. Coverage requires every (monoid, plane) cell of each kind under each of its write forms, reached by an
 * accepted write that touched that cell's family and whose stored rows matched.
 *
 * A refined cell's accumulators are of another pattern than its step's (ends.ts): concat's pieces, texts of at most
 * three bytes PostgreSQL generates by doubling a caller's token, folded into the text of a and b. A write may draw a
 * token holding c, or one of two letters, and a write whose model rows hold a piece outside its bound or a running
 * value or an end outside the pattern is refused on a rule they break and changes nothing: its witness is the key of a
 * row the write states whose value breaks that rule, or `unreported` where no row it states does, as when a delete
 * re-places the members after it, where two ordered owners it inserts break it, or where every row it states that
 * breaks it does so at a running value or an end of a member it puts, which grizzle does not hold. Coverage requires
 * the refined cell of each kind that folds it refused by each rule.
 *
 * Three cases are kept. The downstream report's: a counted Monoid.or over a set of three codes, the owner and its
 * members {a} and {b} inserted separately, whose end was written as the empty set. The downstream shape that once
 * needed host-written copies: a concat over pieces PostgreSQL generates at a byte bound, folded into a pattern its
 * accumulators declare, accepted, and refused once a piece holds a letter outside the pattern. And a member restepped
 * to a piece outside the pattern, refused with its witness `unreported`, where the oracle once required its key.
 */

type CountedForm =
	| "owner and members in one ChangeSet"
	| "several owners in one ChangeSet"
	| "members appended to a stored owner"
	| "a member deleted"
	| "a member's step put"
	| "a member moved to another owner"
	| "an owner put beside an append"

type OrderedForm =
	| "an owner inserted with its members nested"
	| "several owners in one ChangeSet"
	| "a member deleted"
	| "a member's step put"
	| "an owner put"

type TreeForm = "a tree inserted whole" | "several trees in one ChangeSet"

type Form = CountedForm | OrderedForm | TreeForm

/** What a write whose model rows break a refined cell's rule reached: its accumulators' pattern, or its piece's bound. */
type Refused = "refused by its pattern" | "refused by its piece's bound"

/** The situation a broken rule reaches. */
export const refusedBy = (b: Broken): Refused =>
	b.rule === "bound" ? "refused by its piece's bound" : "refused by its pattern"

export type Situation = `${CellLabel} in a ${FamilyKind} family, ${Form | Refused}`

const formsOf = (kind: FamilyKind): Arr.NonEmptyReadonlyArray<Form> => {
	switch (kind) {
		case "counted":
			return [
				"owner and members in one ChangeSet",
				"several owners in one ChangeSet",
				"members appended to a stored owner",
				"a member deleted",
				"a member's step put",
				"a member moved to another owner",
				"an owner put beside an append"
			]
		case "ordered":
			return [
				"an owner inserted with its members nested",
				"several owners in one ChangeSet",
				"a member deleted",
				"a member's step put",
				"an owner put"
			]
		case "tree":
			return ["a tree inserted whole", "several trees in one ChangeSet"]
	}
}

/** A member a write states, of one monoid's family. */
interface Stated {
	readonly monoid: MonoidName
	readonly member: MemberState
}

/**
 * One ChangeSet of a case: `create` inserts owners with their members, as separate inserts for a counted family and
 * nested for an ordered one; `append`, `remove`, `restep` and `move` insert, delete and put members; `relabel` puts an
 * owner beside `members` appended; `trees` inserts trees whole.
 */
type Write =
	| {
			readonly kind: "create"
			readonly owners: Arr.NonEmptyReadonlyArray<OwnerState>
			readonly members: ReadonlyArray<Stated>
	  }
	| {
			readonly kind: "append" | "remove" | "restep" | "move"
			readonly members: Arr.NonEmptyReadonlyArray<Stated>
	  }
	| {
			readonly kind: "relabel"
			readonly owner: OwnerState
			readonly members: ReadonlyArray<Stated>
	  }
	| {
			readonly kind: "trees"
			readonly trees: Arr.NonEmptyReadonlyArray<{
				readonly monoid: MonoidName
				readonly root: Node
			}>
	  }

interface Sketch {
	readonly kind: FamilyKind
	readonly writes: Arr.NonEmptyReadonlyArray<Write>
}

export const schemas: { readonly [K in FamilyKind]: FoldSchema } = {
	counted: foldSchema("counted"),
	ordered: foldSchema("ordered"),
	tree: foldSchema("tree")
}

export const groupOf = (s: FoldSchema, monoid: MonoidName): Group =>
	defined(
		Option.getOrUndefined(Arr.findFirst(s.groups, (g) => g.monoid === monoid)),
		`${monoid}'s family`
	)

/** A write's members of one monoid's family. */
const statedOf = (members: ReadonlyArray<Stated>, monoid: MonoidName): ReadonlyArray<MemberState> =>
	Arr.map(
		Arr.filter(members, (s) => s.monoid === monoid),
		(s) => s.member
	)

/** The model's state after a write of a counted or an ordered family. */
export const applied = (s: FoldSchema, state: State, w: Write): State => {
	const each = (
		f: (
			members: ReadonlyArray<MemberState>,
			stated: ReadonlyArray<MemberState>
		) => ReadonlyArray<MemberState>,
		members: ReadonlyArray<Stated>
	): ReadonlyMap<MonoidName, ReadonlyArray<MemberState>> =>
		new Map(
			Arr.map(
				s.groups,
				(g) => [g.monoid, f(membersOf(state, g.monoid), statedOf(members, g.monoid))] as const
			)
		)
	const appended = (ms: ReadonlyArray<MemberState>, stated: ReadonlyArray<MemberState>) => [
		...ms,
		...stated
	]
	switch (w.kind) {
		case "create":
			return { owners: [...state.owners, ...w.owners], members: each(appended, w.members) }
		case "append":
			return { owners: state.owners, members: each(appended, w.members) }
		case "relabel":
			return {
				owners: Arr.map(state.owners, (o) => (o.id === w.owner.id ? w.owner : o)),
				members: each(appended, w.members)
			}
		case "remove":
			return {
				owners: state.owners,
				members: each(
					(ms, stated) => Arr.filter(ms, (m) => !Arr.some(stated, (r) => r.id === m.id)),
					w.members
				)
			}
		case "restep":
		case "move":
			return {
				owners: state.owners,
				members: each(
					(ms, stated) =>
						Arr.map(ms, (m) =>
							Option.getOrElse(
								Arr.findFirst(stated, (r) => r.id === m.id),
								() => m
							)
						),
					w.members
				)
			}
		case "trees":
			return state
	}
}

/** The keys a case hands out, each above every one before: owners', and members' and tree nodes'. */
interface Keys {
	owner: number
	member: number
}

/**
 * New members of every monoid's family under `owners`, at most `most` per owner and family, their keys fresh, a refined
 * cell's steps breaking the rule `breaking` names too.
 */
const newMembersGen =
	(
		s: FoldSchema,
		owners: Arr.NonEmptyReadonlyArray<number>,
		keys: Keys,
		most: number,
		breaking: Breaking
	): Gen<ReadonlyArray<Stated>> =>
	(source) =>
		Arr.flatMap(s.groups, (g) =>
			Arr.flatMap(owners, (owner) =>
				times(source.draw(int(0, most)), (): Stated => {
					keys.member += 1
					return {
						monoid: g.monoid,
						member: { id: keys.member, owner, steps: source.draw(stepsGen(g, breaking)) }
					}
				})
			)
		)

/** Which rule a write's refined steps may break: one write in twelve the pattern, as many the pieces' bound. */
const breakingGen: Gen<Breaking> = weighted([
	[10, constant("none")],
	[1, constant("pattern")],
	[1, constant("bound")]
])

const writeKinds = ["create", "append", "remove", "restep", "move", "relabel"] as const

type WriteKind = (typeof writeKinds)[number]

/** The write kinds a family kind admits, the first the one every state admits. */
const admitted = (kind: FamilyKind): Arr.NonEmptyReadonlyArray<WriteKind> =>
	kind === "counted" ? writeKinds : ["create", "remove", "restep", "relabel"]

/** Some stored members, each kept with odds of one in three. */
const storedPick =
	(state: State, monoids: ReadonlyArray<MonoidName>): Gen<ReadonlyArray<Stated>> =>
	(source) =>
		Arr.flatMap(monoids, (monoid) =>
			Arr.flatMap(membersOf(state, monoid), (member) =>
				source.draw(int(0, 2)) === 0 ? [{ monoid, member }] : []
			)
		)

/** Whether a write form reaches a cell: a step's put reaches only a cell whose fold steps by a value. */
export const reaches = (cell: Cell, form: Form): boolean =>
	form !== "a member's step put" || cell.step.kind !== "none"

/** One write of a counted or an ordered family, drawn from the state it applies to; none where its pick is empty. */
const writeGen =
	(s: FoldSchema, state: State, keys: Keys, kinds: Swarm<WriteKind>): Gen<Write | undefined> =>
	(source) => {
		const stored = Arr.map(state.owners, (o) => o.id)
		const kind = Arr.isReadonlyArrayNonEmpty(stored)
			? source.draw(swarmChoice(kinds, admitted(s.kind)))
			: "create"
		const ownerOf = (): number =>
			defined(stored[source.draw(int(0, stored.length - 1))], "a stored owner")
		const breaking = source.draw(breakingGen)
		switch (kind) {
			case "create": {
				const owners = nonEmpty(
					times(source.draw(int(1, 3)), () => {
						keys.owner += 1
						return { id: keys.owner, label: source.draw(int(0, 3)) }
					})
				)
				const ids = nonEmpty(Arr.map(owners, (o) => o.id))
				return { kind, owners, members: source.draw(newMembersGen(s, ids, keys, 4, breaking)) }
			}
			case "append": {
				const members = source.draw(newMembersGen(s, [ownerOf()], keys, 3, breaking))
				return Arr.isReadonlyArrayNonEmpty(members) ? { kind, members } : undefined
			}
			case "relabel": {
				const owner = { id: ownerOf(), label: source.draw(int(0, 3)) }
				return {
					kind,
					owner,
					members:
						s.kind === "counted" ? source.draw(newMembersGen(s, [owner.id], keys, 2, breaking)) : []
				}
			}
			case "remove":
			case "restep":
			case "move": {
				const picked = source.draw(
					storedPick(
						state,
						Arr.map(
							Arr.filter(s.groups, (g) =>
								kind === "restep" ? Arr.some(g.cells, (c) => c.step.kind !== "none") : true
							),
							(g) => g.monoid
						)
					)
				)
				if (!Arr.isReadonlyArrayNonEmpty(picked)) {
					return undefined
				}
				const members = Arr.map(picked, (p): Stated => {
					switch (kind) {
						case "remove":
							return p
						case "restep":
							return {
								monoid: p.monoid,
								member: {
									...p.member,
									steps: source.draw(stepsGen(groupOf(s, p.monoid), breaking))
								}
							}
						case "move":
							return { monoid: p.monoid, member: { ...p.member, owner: ownerOf() } }
					}
				})
				return { kind, members }
			}
		}
	}

/**
 * A tree of at most `depth` levels below its root, each node of at most three children, its keys fresh, a refined
 * cell's steps breaking the rule `breaking` names too.
 */
const nodeGen =
	(g: Group, keys: Keys, depth: number, breaking: Breaking): Gen<Node> =>
	(source) => {
		keys.member += 1
		const id = keys.member
		const steps = source.draw(stepsGen(g, breaking))
		const children = times(depth === 0 ? 0 : source.draw(int(0, 3)), () =>
			source.draw(nodeGen(g, keys, depth - 1, breaking))
		)
		return { id, steps, children }
	}

/** The model's rows of a tree schema after a write of trees: each group's trees, numbered and folded. */
export const treesRows = (
	s: FoldSchema,
	trees: ReadonlyArray<{ readonly monoid: MonoidName; readonly root: Node }>
): ReadonlyMap<string, ReadonlyArray<ModelRow>> =>
	new Map(
		Arr.map(s.groups, (g) => [
			g.member.name,
			treeRows(
				g,
				Arr.map(
					Arr.filter(trees, (t) => t.monoid === g.monoid),
					(t) => t.root
				)
			)
		])
	)

/** The relations a schema stores: a tree's nodes, or an owner and its families' members. */
export const storedRelations = (s: FoldSchema): ReadonlyArray<AnyRelation> =>
	s.kind === "tree"
		? Arr.map(s.groups, (g) => g.member)
		: [s.owner, ...Arr.map(s.groups, (g) => g.member)]

/** The model's rows after a write, were it accepted: the trees it inserts, or the state it leaves. */
export const rowsAfter = (
	s: FoldSchema,
	state: State,
	w: Write
): ReadonlyMap<string, ReadonlyArray<ModelRow>> =>
	w.kind === "trees" ? treesRows(s, w.trees) : storedRows(s, applied(s, state, w))

/** The state a write leaves: the state after it, or the state before where its rows break a refinement, which refuses it. */
const settled = (s: FoldSchema, state: State, w: Write): State =>
	Arr.isReadonlyArrayNonEmpty(brokenOf(s, rowsAfter(s, state, w))) ? state : applied(s, state, w)

/** A tree's node keys in pre-order, the root's first: its root value, the root's id, and each node's start. */
const nodeKeys = (root: Node): ReadonlyArray<ReadonlyArray<unknown>> => {
	const keys: Array<ReadonlyArray<unknown>> = []
	const visit = (node: Node, start: number): number => {
		keys.push([root.id, BigInt(start)])
		return Arr.reduce(node.children, start + 1, (next, child) => visit(child, next))
	}
	visit(root, 0)
	return keys
}

/** The rows a write states, by relation and key: its owners and members, or every node of its trees. */
const statedRows = (
	s: FoldSchema,
	w: Write
): ReadonlyArray<readonly [string, ReadonlyArray<unknown>]> => {
	const members = (stated: ReadonlyArray<Stated>) =>
		Arr.map(stated, (m) => [groupOf(s, m.monoid).member.name, [m.member.id]] as const)
	switch (w.kind) {
		case "create":
			return [...Arr.map(w.owners, (o) => [s.owner.name, [o.id]] as const), ...members(w.members)]
		case "append":
		case "restep":
		case "move":
			return members(w.members)
		case "relabel":
			return [[s.owner.name, [w.owner.id]], ...members(w.members)]
		case "remove":
			return []
		case "trees":
			return Arr.flatMap(w.trees, (t) =>
				Arr.map(nodeKeys(t.root), (key) => [groupOf(s, t.monoid).member.name, key] as const)
			)
	}
}

export const caseGen: Gen<Sketch> = (source) => {
	const kind = source.draw(swarmChoice(source.draw(swarm(familyKinds)), familyKinds))
	const s = schemas[kind]
	const keys: Keys = { owner: 0, member: 0 }
	if (kind === "tree") {
		const breaking = source.draw(breakingGen)
		const trees = nonEmpty(
			Arr.flatten(
				times(source.draw(int(1, 2)), () =>
					Arr.map(s.groups, (g) => ({
						monoid: g.monoid,
						root: source.draw(nodeGen(g, keys, 2, breaking))
					}))
				)
			)
		)
		return { kind, writes: [{ kind: "trees", trees }] }
	}
	const kinds = source.draw(swarm(writeKinds))
	let state = emptyState
	const writes: Array<Write> = []
	for (let left = source.draw(int(1, 4)); left > 0; left -= 1) {
		const w = source.draw(writeGen(s, state, keys, kinds))
		if (w !== undefined) {
			writes.push(w)
			state = settled(s, state, w)
		}
	}
	return { kind, writes: nonEmpty(writes) }
}

/** A member's fact: its key, its owner and its steps. */
const memberFact = (s: FoldSchema, stated: Stated): Record<string, unknown> => ({
	id: stated.member.id,
	o: stated.member.owner,
	...stepFacts(groupOf(s, stated.monoid), stated.member.steps)
})

/** Each monoid's family's members of a write, with the facts `fact` gives them. */
const byFamily = (
	s: FoldSchema,
	members: ReadonlyArray<Stated>,
	fact: (stated: Stated) => Record<string, unknown>
): ReadonlyArray<readonly [Group, ReadonlyArray<Record<string, unknown>>]> =>
	Arr.flatMap(s.groups, (g) => {
		const mine = Arr.filter(members, (m) => m.monoid === g.monoid)
		return Arr.isReadonlyArrayNonEmpty(mine) ? [[g, Arr.map(mine, fact)] as const] : []
	})

/** One array member a write states: its op, its relation, and the facts its call holds for it. */
interface ServedSlot {
	readonly op: "insert" | "put" | "delete"
	readonly relation: AnyRelation
	readonly facts: ReadonlyArray<Record<string, unknown>>
}

/** The array members a write states, over the families of `s`, in its ChangeSet's order. */
export const slotsOf = (s: FoldSchema, w: Write): ReadonlyArray<ServedSlot> => {
	const each = (op: ServedSlot["op"], members: ReadonlyArray<Stated>): ReadonlyArray<ServedSlot> =>
		Arr.map(
			byFamily(s, members, (m) => memberFact(s, m)),
			([g, facts]): ServedSlot => ({ op, relation: g.member, facts })
		)
	switch (w.kind) {
		case "create":
			return s.kind === "ordered"
				? [
						{
							op: "insert",
							relation: s.owner,
							facts: Arr.map(w.owners, (o) =>
								Rec.fromEntries([
									["id", o.id],
									["label", o.label],
									...Arr.map(s.groups, (g): readonly [string, unknown] => [
										g.count,
										Arr.map(
											Arr.filter(
												w.members,
												(m) => m.monoid === g.monoid && m.member.owner === o.id
											),
											(m) => ({ id: m.member.id, ...stepFacts(g, m.member.steps) })
										)
									])
								])
							)
						}
					]
				: [
						{
							op: "insert",
							relation: s.owner,
							facts: Arr.map(w.owners, (o) => ({ id: o.id, label: o.label }))
						},
						...each("insert", w.members)
					]
		case "append":
			return each("insert", w.members)
		case "relabel":
			return [
				{ op: "put", relation: s.owner, facts: [{ id: w.owner.id, label: w.owner.label }] },
				...each("insert", w.members)
			]
		case "remove":
			return each("delete", w.members)
		case "restep":
		case "move":
			return each("put", w.members)
		case "trees":
			return Arr.map(w.trees, (t): ServedSlot => {
				const g = groupOf(s, t.monoid)
				return { op: "insert", relation: g.member, facts: [treeFact(g, t.root, true)] }
			})
	}
}

/** A call's facts: under each op of the ChangeSet's array members, the rows of each, under its relation's name. */
type CallFacts = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>

/**
 * A write as the served ChangeSet over the schema value `value` a call applies: one array member per op and relation,
 * at its first slot, whose facts are every such slot's in order, as its stratum's union holds them; and the call's
 * facts under each op and relation.
 */
const servedOf = (
	value: unknown,
	slots: ReadonlyArray<ServedSlot>
): { readonly changes: ChangeSetValue; readonly shape: string; readonly facts: CallFacts } => {
	const held = Arr.dedupeWith(slots, (a, b) => a.op === b.op && a.relation.name === b.relation.name)
	const changes = Arr.reduce(held, ChangeSet.empty(value), (cs, slot) => {
		switch (slot.op) {
			case "insert":
				return cs.insert(slot.relation, [])
			case "put":
				return cs.put(slot.relation, [])
			case "delete":
				return cs.delete(slot.relation, [])
		}
	})
	const facts = Rec.fromEntries(
		Arr.map(
			Arr.dedupe(Arr.map(held, (h) => h.op)),
			(op): readonly [string, Readonly<Record<string, ReadonlyArray<unknown>>>] => [
				op,
				Rec.fromEntries(
					Arr.map(
						Arr.filter(held, (h) => h.op === op),
						(h): readonly [string, ReadonlyArray<unknown>] => [
							h.relation.name,
							Arr.flatMap(
								Arr.filter(slots, (x) => x.op === op && x.relation.name === h.relation.name),
								(x: ServedSlot) => x.facts
							)
						]
					)
				)
			]
		)
	)
	return {
		changes,
		shape: Arr.join(
			Arr.map(held, (h) => `${h.op} ${h.relation.name}`),
			", "
		),
		facts
	}
}

/** What a case compiles through: its served Db over its own clone (db), and each write's member and facts (write). */
export interface EndsCompiles {
	readonly db: (
		done: Installed,
		role: AnyLoginRole
	) => Effect.Effect<ServedDb, ServedRefusal | OpenError, Scope.Scope>
	readonly write: (
		db: ServedDb,
		done: Installed,
		value: unknown,
		slots: ReadonlyArray<ServedSlot>
	) => Effect.Effect<
		{ readonly calls: OnceCalls; readonly facts: CallFacts },
		ServedRefusal | OpenError
	>
}

/**
 * Each kind's served fixture of its full world's login, by its clone's database and schema, and each write's served
 * member, by its schema and its shape, compiled once per worker: a write's ChangeSet is a function of its shape alone,
 * the ops and relations it states in order (servedOf), and a served file a function of the installation's snapshot, the
 * login and its programs (test/support/served-db.ts servedFixture, ServedDb.load), so every later case or write of one
 * runs what the first compiled. A case's Db is its own (openServedDbOf), and so is each member's call on it
 * (memberCalls). Each case compiled its own before: 230 ms a case for the fixture and 433 ms a write for its member,
 * 375 writes of 58 shapes in 150 cases (f7d32b7c1, the lane's family).
 */
export const endsCompiles = {
	key: "test/pg/fin/fold-ends.fixtures.ts endsCompiles",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const fixtures = new Map<string, ServedFixture<AnyLogin>>()
		const writes = new Map<string, LoadedMember>()
		const compiles: EndsCompiles = {
			db: (done, role) =>
				Effect.gen(function* () {
					const key = `${done.database} ${done.schema}`
					const fixture = fixtures.get(key) ?? (yield* servedFixture(done, role.login))
					fixtures.set(key, fixture)
					return yield* openServedDbOf(fixture, done, role, {})
				}),
			write: (db, done, value, slots) =>
				Effect.gen(function* () {
					const served = servedOf(value, slots)
					const key = `${done.database} ${done.schema} ${served.shape}`
					const loaded =
						writes.get(key) ??
						(yield* Effect.map(db.load({ write: served.changes }), (members) =>
							member(members, "write")
						))
					writes.set(key, loaded)
					return { calls: memberCalls(db.ctx, loaded), facts: served.facts }
				})
		}
		return Effect.succeed(compiles)
	})
} as const satisfies Need<EndsCompiles>

/** The forms a write takes in each monoid's family it touches. */
export const formsTouched = (
	s: FoldSchema,
	w: Write
): ReadonlyArray<readonly [MonoidName, Form]> => {
	const touched = (members: ReadonlyArray<Stated>) => Arr.dedupe(Arr.map(members, (m) => m.monoid))
	switch (w.kind) {
		case "create": {
			const forms: ReadonlyArray<Form> = [
				s.kind === "ordered"
					? "an owner inserted with its members nested"
					: "owner and members in one ChangeSet",
				...(w.owners.length > 1 ? ["several owners in one ChangeSet" as const] : [])
			]
			return Arr.flatMap(touched(w.members), (m) => Arr.map(forms, (f) => [m, f] as const))
		}
		case "append":
			return Arr.map(touched(w.members), (m) => [m, "members appended to a stored owner"] as const)
		case "remove":
			return Arr.map(touched(w.members), (m) => [m, "a member deleted"] as const)
		case "restep":
			return Arr.map(touched(w.members), (m) => [m, "a member's step put"] as const)
		case "move":
			return Arr.map(touched(w.members), (m) => [m, "a member moved to another owner"] as const)
		case "relabel":
			return s.kind === "ordered"
				? Arr.map(s.groups, (g) => [g.monoid, "an owner put"] as const)
				: Arr.map(touched(w.members), (m) => [m, "an owner put beside an append"] as const)
		case "trees":
			return Arr.flatMap(s.groups, (g) => {
				const trees = Arr.filter(w.trees, (t) => t.monoid === g.monoid).length
				return [
					...(trees > 0 ? [[g.monoid, "a tree inserted whole"] as const] : []),
					...(trees > 1 ? [[g.monoid, "several trees in one ChangeSet"] as const] : [])
				]
			})
	}
}

/** Each cell of each kind under each of the kind's write forms. */
const formSituations: ReadonlyArray<Situation> = Arr.flatMap(familyKinds, (kind) =>
	Arr.flatMap(schemas[kind].groups, (g) =>
		Arr.flatMap(g.cells, (c) =>
			Arr.map(
				Arr.filter(formsOf(kind), (f) => reaches(c, f)),
				(f): Situation => `${cellLabel(c)} in a ${kind} family, ${f}`
			)
		)
	)
)

/** Each refined cell of each kind that folds it, refused by each of its rules. */
const refusalSituations: ReadonlyArray<Situation> = Arr.flatMap(familyKinds, (kind) =>
	Arr.flatMap(schemas[kind].groups, (g) =>
		Arr.flatMap(
			Arr.filter(g.cells, (c) => c.refined),
			(c: Cell) =>
				Arr.map(
					["refused by its pattern", "refused by its piece's bound"] as const,
					(r): Situation => `${cellLabel(c)} in a ${kind} family, ${r}`
				)
		)
	)
)

/** Every situation the search requires: each cell under each write form, and each refined cell refused by each rule. */
export const situations: Arr.NonEmptyReadonlyArray<Situation> = nonEmpty(
	Arr.appendAll(formSituations, refusalSituations)
)

/**
 * Whether a broken row breaks its rule at a running value or an end of a family member the write puts: the put states
 * the member's key and steps, PostgreSQL folds its running values again from the stored members before it and keeps its
 * ends from the stored row, so grizzle holds none of them (README, Witness) and the host judges no rule over them.
 */
const brokenAtPutFold = (s: FoldSchema, w: Write, b: Broken): boolean =>
	b.law.kind === "pattern" &&
	Arr.contains(
		[...b.cell.ends, ...Arr.flatMap(b.cell.pairs, (p) => [p.before, p.after])],
		b.law.field
	) &&
	Arr.some(
		slotsOf(s, w),
		(slot) =>
			slot.op === "put" &&
			slot.relation.name === b.relation &&
			Arr.some(s.groups, (g) => g.member.name === slot.relation.name) &&
			Arr.some(slot.facts, (fact) =>
				deepEquals<ReadonlyArray<unknown>>(
					Arr.map(memberKeyOf(s.kind), (k) => fact[k]),
					b.key
				)
			)
	)

/**
 * A refused write's answer, as the model judges it: `refused` naming rules its rows break, a field's piece
 * bound or its accumulators' pattern, each field's own law: every one it names where it decides them, at least one
 * where it names `some` of a domain's; its witness the key of a row the write states whose value breaks a rule it
 * names, every one of them where it decides them, or `unreported` where the write states none (the rule broken at a
 * row only a refill writes), where two ordered owners it inserts break one, either of which may be the row refused:
 * no read of the write looks an ordered owner's key up, so the host cannot tell a new one from a stored one inserted
 * again, which its INSERT writes nothing of; or where each row it states breaks one at a value grizzle does not hold,
 * a running value or an end of a member it puts (`brokenAtPutFold`). The rules it names are returned.
 */
export const judgeRefused = (
	s: FoldSchema,
	w: Write,
	broken: Arr.NonEmptyReadonlyArray<Broken>,
	outcome: WriteAnswer<WrittenOutcome>
): ReadonlyArray<Broken> => {
	if (outcome._tag !== "refused") {
		return assert.fail(
			`a write whose rows break ${Formatter.format(Arr.map(broken, (b) => b.law))} is refused, not ${outcome._tag}: ${Formatter.format(w)}`
		)
	}
	const breaks = (law: Law): boolean => Arr.some(broken, (b) => deepEquals(b.law, law))
	switch (outcome.refused.kind) {
		case "every":
		case "first":
			for (const law of refusedLaws(outcome.refused)) {
				assert.ok(
					breaks(law),
					`the refusal names a rule its rows break, not ${Formatter.format(law)}`
				)
			}
			break
		case "some":
			assert.ok(
				Arr.some(refusedLaws(outcome.refused), breaks),
				`a refusal that names some of ${Formatter.format(refusedLaws(outcome.refused))} names one its rows break`
			)
			break
		case "above":
			return assert.fail(
				`a fold schema is one level, so no law above it refuses a write: ${Formatter.format(outcome.refused)}`
			)
	}
	const named = Arr.filter(broken, (b) =>
		Arr.some(refusedLaws(outcome.refused), (law) => deepEquals(b.law, law))
	)
	const stated = statedRows(s, w)
	const statedBroken = Arr.filter(named, (b) =>
		Arr.some(stated, ([relation, key]) => relation === b.relation && deepEquals(key, b.key))
	)
	const witness = outcome.witness
	if (witness.kind !== "key") {
		const unread =
			s.kind === "ordered" && Arr.every(statedBroken, (b) => b.relation === s.owner.name)
				? Arr.dedupeWith(
						Arr.map(statedBroken, (b) => b.key),
						deepEquals
					)
				: []
		assert.ok(
			!Arr.isReadonlyArrayNonEmpty(statedBroken) ||
				unread.length >= 2 ||
				Arr.every(statedBroken, (b) => brokenAtPutFold(s, w, b)),
			`a refusal at a row the write states, ${Formatter.format(statedBroken)}, names its key`
		)
		return named
	}
	const keyFields = memberKeyOf(s.kind)
	const atWitness = (b: Broken): boolean =>
		b.relation === witness.relation &&
		Rec.keys(witness.values).length === keyFields.length &&
		deepEquals<ReadonlyArray<unknown>>(
			Arr.map(keyFields, (f) => witness.values[f]),
			b.key
		)
	assert.ok(
		Arr.some(statedBroken, atWitness),
		`the witness ${Formatter.format(witness)} is a stated row whose value breaks a rule the refusal names: ${Formatter.format(statedBroken)}`
	)
	if (outcome.refused.kind === "every") {
		for (const law of refusedLaws(outcome.refused)) {
			assert.ok(
				Arr.some(named, (b) => atWitness(b) && deepEquals(b.law, law)),
				`the witnessed row breaks every rule the refusal decides, ${Formatter.format(law)} among them`
			)
		}
	}
	return named
}

/** A family kind's schema migrated with its full world's login, once per member: the template its cases clone. */
const endsTemplate = (kind: FamilyKind): SubstrateTemplate<Generated> => {
	const declaredKind = schemas[kind].value(`FoldEnds_${kind}`)
	return fullWorldTemplate({
		declaredIn: import.meta,
		name: `ends_${kind}`,
		fixture: declaredKind,
		programs: {},
		contexts: [],
		label: `ends_${kind}`,
		ambient: ordinarySession
	})
}

/** Each family kind's template, by kind: a case takes only the one of its sketch's kind. */
export const endsTemplates: { readonly [K in FamilyKind]: SubstrateTemplate<Generated> } = {
	counted: endsTemplate("counted"),
	ordered: endsTemplate("ordered"),
	tree: endsTemplate("tree")
}
