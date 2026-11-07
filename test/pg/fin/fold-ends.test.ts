import { layer } from "@effect/vitest"
import { type Kept, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Record as Rec } from "effect"
import { apply } from "#adapter/apply/index.ts"
import { dbContext } from "#adapter/db/context.ts"
import { Db } from "#adapter/public/db.ts"
import type { MonoidName } from "#compiler/ir/desc.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { cleared, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, deepEquals, defined, nonEmpty, unorderedEqual } from "#test/support/assert.ts"
import {
	type Cell,
	type CellLabel,
	cellLabel,
	emptyState,
	type FamilyKind,
	familyKinds,
	type FoldSchema,
	foldSchema,
	type Group,
	setWidths,
	type MemberState,
	membersOf,
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
import { installMigrated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld, loginLayer } from "#test/support/worlds.ts"

/**
 * Every fold's end and running values after every write grizzle's apply makes of a family, on PostgreSQL 19rc1: what
 * PostgreSQL holds after each `db.apply` is exactly what the host model of the README's family semantics states
 * (test/support/families/ends.ts), and every lawful write is accepted.
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
 * write. Coverage requires every (monoid, plane) cell of each kind under each of its write forms, reached by an accepted
 * write that touched that cell's family and whose stored rows matched. The kept case is the downstream report's: a
 * counted Monoid.or over a set of three codes, the owner and its members {a} and {b} inserted separately, whose end was
 * written as the empty set.
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

type Situation = `${CellLabel} in a ${FamilyKind} family, ${Form}`

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

const schemas: { readonly [K in FamilyKind]: FoldSchema } = {
	counted: foldSchema("counted"),
	ordered: foldSchema("ordered"),
	tree: foldSchema("tree")
}

const groupOf = (s: FoldSchema, monoid: MonoidName): Group =>
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
const applied = (s: FoldSchema, state: State, w: Write): State => {
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

/** New members of every monoid's family under `owners`, at most `most` per owner and family, their keys fresh. */
const newMembersGen =
	(
		s: FoldSchema,
		owners: Arr.NonEmptyReadonlyArray<number>,
		keys: Keys,
		most: number
	): Gen<ReadonlyArray<Stated>> =>
	(source) =>
		Arr.flatMap(s.groups, (g) =>
			Arr.flatMap(owners, (owner) =>
				times(source.draw(int(0, most)), (): Stated => {
					keys.member += 1
					return {
						monoid: g.monoid,
						member: { id: keys.member, owner, steps: source.draw(stepsGen(g)) }
					}
				})
			)
		)

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
const reaches = (cell: Cell, form: Form): boolean =>
	form !== "a member's step put" || cell.step !== undefined

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
		switch (kind) {
			case "create": {
				const owners = nonEmpty(
					times(source.draw(int(1, 3)), () => {
						keys.owner += 1
						return { id: keys.owner, label: source.draw(int(0, 3)) }
					})
				)
				const ids = nonEmpty(Arr.map(owners, (o) => o.id))
				return { kind, owners, members: source.draw(newMembersGen(s, ids, keys, 4)) }
			}
			case "append": {
				const members = source.draw(newMembersGen(s, [ownerOf()], keys, 3))
				return Arr.isReadonlyArrayNonEmpty(members) ? { kind, members } : undefined
			}
			case "relabel": {
				const owner = { id: ownerOf(), label: source.draw(int(0, 3)) }
				return {
					kind,
					owner,
					members: s.kind === "counted" ? source.draw(newMembersGen(s, [owner.id], keys, 2)) : []
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
								kind === "restep" ? Arr.some(g.cells, (c) => c.step !== undefined) : true
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
								member: { ...p.member, steps: source.draw(stepsGen(groupOf(s, p.monoid))) }
							}
						case "move":
							return { monoid: p.monoid, member: { ...p.member, owner: ownerOf() } }
					}
				})
				return { kind, members }
			}
		}
	}

/** A tree of at most `depth` levels below its root, each node of at most three children, its keys fresh. */
const nodeGen =
	(g: Group, keys: Keys, depth: number): Gen<Node> =>
	(source) => {
		keys.member += 1
		const id = keys.member
		const steps = source.draw(stepsGen(g))
		const children = times(depth === 0 ? 0 : source.draw(int(0, 3)), () =>
			source.draw(nodeGen(g, keys, depth - 1))
		)
		return { id, steps, children }
	}

const caseGen: Gen<Sketch> = (source) => {
	const kind = source.draw(swarmChoice(source.draw(swarm(familyKinds)), familyKinds))
	const s = schemas[kind]
	const keys: Keys = { owner: 0, member: 0 }
	if (kind === "tree") {
		const trees = nonEmpty(
			Arr.flatten(
				times(source.draw(int(1, 2)), () =>
					Arr.map(s.groups, (g) => ({ monoid: g.monoid, root: source.draw(nodeGen(g, keys, 2)) }))
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
			state = applied(s, state, w)
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

/** The ChangeSet a write is, over the schema value `value`. */
const changeSetOf = (s: FoldSchema, value: unknown, w: Write): ChangeSetValue => {
	const empty = ChangeSet.empty(value)
	const inserted = (cs: ChangeSetValue, members: ReadonlyArray<Stated>) =>
		Arr.reduce(
			byFamily(s, members, (m) => memberFact(s, m)),
			cs,
			(out, [g, facts]) => out.insert(g.member, facts)
		)
	switch (w.kind) {
		case "create":
			return s.kind === "ordered"
				? empty.insert(
						s.owner,
						Arr.map(w.owners, (o) =>
							Rec.fromEntries([
								["id", o.id],
								["label", o.label],
								...Arr.map(s.groups, (g): readonly [string, unknown] => [
									g.count,
									Arr.map(
										Arr.filter(w.members, (m) => m.monoid === g.monoid && m.member.owner === o.id),
										(m) => ({ id: m.member.id, ...stepFacts(g, m.member.steps) })
									)
								])
							])
						)
					)
				: inserted(
						empty.insert(
							s.owner,
							Arr.map(w.owners, (o) => ({ id: o.id, label: o.label }))
						),
						w.members
					)
		case "append":
			return inserted(empty, w.members)
		case "relabel":
			return inserted(empty.put(s.owner, [{ id: w.owner.id, label: w.owner.label }]), w.members)
		case "remove":
			return Arr.reduce(
				byFamily(s, w.members, (m) => memberFact(s, m)),
				empty,
				(out, [g, facts]) => out.delete(g.member, facts)
			)
		case "restep":
		case "move":
			return Arr.reduce(
				byFamily(s, w.members, (m) => memberFact(s, m)),
				empty,
				(out, [g, facts]) => out.put(g.member, facts)
			)
		case "trees":
			return Arr.reduce(w.trees, empty, (out, t) => {
				const g = groupOf(s, t.monoid)
				return out.insert(g.member, [treeFact(g, t.root, true)])
			})
	}
}

/** The forms a write takes in each monoid's family it touches. */
const formsTouched = (s: FoldSchema, w: Write): ReadonlyArray<readonly [MonoidName, Form]> => {
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

/** Every situation the search requires: each cell of each kind under each of the kind's write forms. */
const situations: Arr.NonEmptyReadonlyArray<Situation> = nonEmpty(
	Arr.flatMap(familyKinds, (kind) =>
		Arr.flatMap(schemas[kind].groups, (g) =>
			Arr.flatMap(g.cells, (c) =>
				Arr.map(
					Arr.filter(formsOf(kind), (f) => reaches(c, f)),
					(f): Situation => `${cellLabel(c)} in a ${kind} family, ${f}`
				)
			)
		)
	)
)

/**
 * The downstream report's case, kept: one owner and its two members of the counted Monoid.or family, inserted
 * separately in one ChangeSet, the first holding the set's first code and the second its second at every width (the
 * report's {a} and {b} of a set of three codes), whose end was written as the empty set.
 */
const downstream: Kept<Sketch, Situation> = {
	note: "a counted Monoid.or's end, its owner and members inserted separately, was written as its identity",
	sketch: {
		kind: "counted",
		writes: [
			{
				kind: "create",
				owners: [{ id: 1, label: 0 }],
				members: [
					{
						monoid: "or",
						member: {
							id: 1,
							owner: 1,
							steps: Rec.fromEntries(Arr.map(setWidths, (w) => [`x_bits${w}`, 1n] as const))
						}
					},
					{
						monoid: "or",
						member: {
							id: 2,
							owner: 1,
							steps: Rec.fromEntries(
								Arr.map(setWidths, (w) => [`x_bits${w}`, w > 1 ? 2n : 0n] as const)
							)
						}
					}
				]
			}
		]
	},
	draws: "",
	reaches: ["or over bits3 in a counted family, owner and members in one ChangeSet"]
}

layer(Substrate.layer, { excludeTestServices: true })(
	"every fold's end through grizzle's apply on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"stores exactly the README's fold of every member's step, every end and running value, after every write of every family kind",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const opened = yield* Effect.forEach(familyKinds, (kind) =>
							Effect.gen(function* () {
								const s = schemas[kind]
								const declared = s.value(`FoldEnds_${kind}`)
								const done = yield* installMigrated(declared, {
									ambient: ordinarySession,
									label: `ends_${kind}`,
									logins: [fullWorld(declared).server],
									extensions: []
								})
								const value = s.value(done.schema)
								const world = fullWorld(value)
								const seat = yield* seatOfInstalled(done, s.relations, `ends_${kind}`)
								const context = yield* Layer.build(loginLayer(done, world.server))
								const db = yield* Db.open(world.server.roles.app, {}).pipe(
									Effect.provideContext(context)
								)
								const dbc = dbContext(db)
								if (dbc === undefined) {
									return yield* Effect.die(new Error("Db.open registered no context"))
								}
								return { kind, s, done, value, seat, dbc } as const
							})
						)
						const of = (kind: FamilyKind) =>
							defined(
								Option.getOrUndefined(Arr.findFirst(opened, (o) => o.kind === kind)),
								`the ${kind} schema`
							)
						return yield* explore(
							{
								suite: "pg/fin/fold-ends",
								draw: drawn(caseGen),
								literal: Formatter.format,
								coverage: required<Situation>(situations, { cases: 160, sense: notesOnly }),
								kept: [downstream],
								runs: 16,
								shrink: boundedShrink(40),
								concurrency: 1,
								steerEvery: 8,
								caseHang,
								oracle: {
									kind: "specification",
									name: "the README's fold of each family's members (test/support/families/ends.ts)"
								}
							},
							(sketch, c) =>
								Effect.gen(function* () {
									const o = of(sketch.kind)
									yield* cleared(o.seat, o.s.relations)
									let state = emptyState
									for (const w of sketch.writes) {
										const changes = changeSetOf(o.s, o.value, w)
										const outcome = yield* apply(o.dbc, changes, changes.reads, {})
										const next = applied(o.s, state, w)
										assert.equal(
											outcome.kind,
											deepEquals(next, state) && w.kind !== "trees" ? "no-change" : "accepted",
											`the write ${Formatter.format(w)}`
										)
										state = next
										if (sketch.kind === "tree" && w.kind === "trees") {
											for (const g of o.s.groups) {
												const stored = yield* tableState(o.done, g.member)
												unorderedEqual<ModelRow>(
													stored,
													treeRows(
														g,
														Arr.map(
															Arr.filter(w.trees, (t) => t.monoid === g.monoid),
															(t) => t.root
														)
													),
													`${g.member.name}'s rows`
												)
											}
										} else {
											const expected = storedRows(o.s, state)
											for (const r of [o.s.owner, ...Arr.map(o.s.groups, (g) => g.member)]) {
												const stored = yield* tableState(o.done, r)
												unorderedEqual<ModelRow>(
													stored,
													expected.get(r.name) ?? [],
													`${r.name}'s rows after ${Formatter.format(w)}`
												)
											}
										}
										for (const [monoid, form] of formsTouched(o.s, w)) {
											for (const cell of Arr.filter(groupOf(o.s, monoid).cells, (cell) =>
												reaches(cell, form)
											)) {
												c.note(`${cellLabel(cell)} in a ${sketch.kind} family, ${form}`)
											}
										}
									}
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
