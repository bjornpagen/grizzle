import { array, boolean, type Gen, int, uniqueKeys, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import { maxOf } from "#compiler/core/array.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, counted, fin, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { paged } from "#compiler/public/workload.ts"
import { upTo } from "#test/support/up-to.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * The live world: the schemas, programs, subscriptions and write histories the live suites search, each drawn from a box
 * whose every axis is a choice the live machinery branches on.
 *
 * A schema holds two relations, `Item0` and `Item1`, each `{ id, g, o, val }` keyed by `id`, mutable or not, and the
 * fence's `Probe` (probeRelation), a counted family no read reads (familyRelations), and a closed relation read by
 * one constant member alone (closedRead): `g` is the group a keyed read binds its parameter `g` to, the column a commit's
 * notification names its value of, `o` the order an ordered read delivers by, and `val` a value no read binds. Its
 * programs are the reads the box draws, each one of the shapes the live machinery routes and diffs differently
 * (WorldRead), the probe member, one insert, delete and put member per item relation and the family's two inserts
 * (familyMembers), whose facts are each call's. A
 * subscription is a read with what its call binds (LiveBinding). A history is commits, each a grizzle call of one write
 * member, or one SERIALIZABLE transaction of a direct SQL writer of the role, which may write several rows of either
 * relation, an immutable relation's row moved as its delete and its insert at one key. Every write changes what it
 * writes: an insert's key is free, a delete's and an update's row is stored, and an update moves at least one of `g`,
 * `o` and `val`, so every commit touches exactly the rows it names.
 */

/** A row of a live relation: its key `id`, its group `g`, its order `o` and its value `val`. */
export type LiveFact = {
	readonly id: number
	readonly g: number
	readonly o: number
	readonly val: number
}

/** The two relations of the box, by place. */
export type RelationPlace = 0 | 1

/**
 * A read of the box, each a shape the live machinery treats on its own:
 *
 * - `keyed`: one relation's rows of the bound group, a set routed by `g`;
 * - `wide`: one relation's every row, which binds nothing and is routed by its table alone;
 * - `count`: how many rows of one relation the bound group holds, one aggregate row routed by `g`;
 * - `ordered`: `keyed` delivered by `o` then `id`, a list whose rows carry the key before them;
 * - `window`: `ordered` cut to its first `size` rows by the program's take, so a write past its edge moves rows in or
 *   out;
 * - `page`: `ordered` served paged, each subscription's window of it the call's (LiveBinding `window`);
 * - `join`: the pairs of a row of `relation` and a row of `other`, the same relation or not, both of the bound group,
 *   routed by both relations' `g`.
 */
export type WorldRead =
	| { readonly kind: "keyed"; readonly relation: RelationPlace }
	| { readonly kind: "wide"; readonly relation: RelationPlace }
	| { readonly kind: "count"; readonly relation: RelationPlace }
	| { readonly kind: "ordered"; readonly relation: RelationPlace }
	| { readonly kind: "window"; readonly relation: RelationPlace; readonly size: number }
	| { readonly kind: "page"; readonly relation: RelationPlace }
	| { readonly kind: "join"; readonly relation: RelationPlace; readonly other: RelationPlace }

export type ReadKind = WorldRead["kind"]

/**
 * Where a page's window starts (live/program.ts Anchor): its first rows, its last, or the rows after or before a key of
 * its completed order, `o` then `id`, which no row need hold.
 */
export type LiveAnchor =
	| { readonly kind: "start" }
	| { readonly kind: "end" }
	| { readonly kind: "after"; readonly o: number; readonly id: number }
	| { readonly kind: "before"; readonly o: number; readonly id: number }

/**
 * What a subscription's call binds: nothing, for a wide read; the group its parameter `g` binds; or, for a page, the
 * group and the window of `size` rows from its anchor.
 */
export type LiveBinding =
	| { readonly kind: "none" }
	| { readonly kind: "group"; readonly group: number }
	| {
			readonly kind: "window"
			readonly group: number
			readonly anchor: LiveAnchor
			readonly size: number
	  }

/** A subscription: a read by its place, and what its call binds. */
export interface LiveSubscription {
	readonly read: number
	readonly binding: LiveBinding
}

/** The group a subscription binds, none for one that binds none. */
export const groupOf = (subscription: LiveSubscription): number | undefined =>
	subscription.binding.kind === "none" ? undefined : subscription.binding.group

/** A write of one row: an insert of a free key, a delete of a stored row, or a stored row moved to `to` at its key. */
export type LiveWrite =
	| { readonly kind: "insert"; readonly relation: RelationPlace; readonly fact: LiveFact }
	| { readonly kind: "delete"; readonly relation: RelationPlace; readonly fact: LiveFact }
	| {
			readonly kind: "update"
			readonly relation: RelationPlace
			readonly from: LiveFact
			readonly to: LiveFact
	  }

/**
 * A commit: one grizzle call of the write member of its write's kind and relation (an update is a put), or one
 * SERIALIZABLE transaction of a direct SQL writer holding its writes in order, no two of one row.
 */
export type LiveCommit =
	| { readonly writer: "grizzle"; readonly write: LiveWrite }
	| { readonly writer: "psql"; readonly writes: Arr.NonEmptyReadonlyArray<LiveWrite> }

/** The stored rows of both relations, by place. */
export type LiveState = readonly [ReadonlyArray<LiveFact>, ReadonlyArray<LiveFact>]

/** A drawn live case (see the header). */
export interface LiveCase {
	readonly mutable: readonly [boolean, boolean]
	readonly reads: Arr.NonEmptyReadonlyArray<WorldRead>
	readonly subscriptions: Arr.NonEmptyReadonlyArray<LiveSubscription>
	readonly facts: LiveState
	readonly history: ReadonlyArray<LiveCommit>
}

/**
 * The bounds of the box: groups, orders and values each a few small integers, at least 2, so draws collide where they
 * matter; keys, rows per relation, reads, subscriptions, commits, a direct writer's writes per commit and a window's
 * largest size.
 */
export interface LiveBounds {
	readonly groups: number
	readonly orders: number
	readonly values: number
	readonly keys: number
	readonly rows: number
	readonly reads: number
	readonly subscriptions: number
	readonly commits: number
	readonly writes: number
	readonly window: number
}

const relationGen: Gen<RelationPlace> = (source) => (source.draw(boolean) ? 1 : 0)

const readGen =
	(bounds: LiveBounds): Gen<WorldRead> =>
	(source) => {
		const at = source.draw(relationGen)
		return source.draw(
			weighted<WorldRead>([
				[2, () => ({ kind: "keyed", relation: at })],
				[1, () => ({ kind: "wide", relation: at })],
				[1, () => ({ kind: "count", relation: at })],
				[2, () => ({ kind: "ordered", relation: at })],
				[2, (s) => ({ kind: "window", relation: at, size: s.draw(int(1, bounds.window)) })],
				[2, () => ({ kind: "page", relation: at })],
				[1, (s) => ({ kind: "join", relation: at, other: s.draw(relationGen) })]
			])
		)
	}

const factGen =
	(bounds: LiveBounds, id: number): Gen<LiveFact> =>
	(source) => ({
		id,
		g: source.draw(int(0, bounds.groups - 1)),
		o: source.draw(int(0, bounds.orders - 1)),
		val: source.draw(int(0, bounds.values - 1))
	})

const rowsGen =
	(bounds: LiveBounds): Gen<ReadonlyArray<LiveFact>> =>
	(source) =>
		Arr.map(source.draw(uniqueKeys(int(0, bounds.keys - 1), { min: 0, max: bounds.rows })), (id) =>
			source.draw(factGen(bounds, id))
		)

/** The rows of `state` at `place`. */
const rowsAt = (state: LiveState, place: RelationPlace): ReadonlyArray<LiveFact> =>
	place === 0 ? state[0] : state[1]

const withRows = (
	state: LiveState,
	place: RelationPlace,
	rows: ReadonlyArray<LiveFact>
): LiveState => (place === 0 ? [rows, state[1]] : [state[0], rows])

/** `state` after `write`. */
const written = (state: LiveState, write: LiveWrite): LiveState => {
	const rows = rowsAt(state, write.relation)
	switch (write.kind) {
		case "insert":
			return withRows(state, write.relation, [...rows, write.fact])
		case "delete":
			return withRows(
				state,
				write.relation,
				Arr.filter(rows, (row) => row.id !== write.fact.id)
			)
		case "update":
			return withRows(
				state,
				write.relation,
				Arr.map(rows, (row) => (row.id === write.from.id ? write.to : row))
			)
	}
}

/** The writes of a commit, in order. */
export const writesOf = (commit: LiveCommit): Arr.NonEmptyReadonlyArray<LiveWrite> =>
	commit.writer === "grizzle" ? [commit.write] : commit.writes

/** `state` after `commit`. */
const committed = (state: LiveState, commit: LiveCommit): LiveState =>
	Arr.reduce(writesOf(commit), state, written)

/** Every state of a history: the facts', then each commit's, so state k is the one commit k - 1 left. */
export const statesOf = (c: LiveCase): Arr.NonEmptyReadonlyArray<LiveState> =>
	Arr.scan(c.history, c.facts, committed)

/** A key of `place` no row of `state` holds and no write of `taken` named, drawn among the box's keys and one past them. */
const freeKeyGen =
	(bounds: LiveBounds, rows: ReadonlyArray<LiveFact>, taken: ReadonlyArray<number>): Gen<number> =>
	(source) => {
		const used = new Set([...Arr.map(rows, (row) => row.id), ...taken])
		const free = Arr.filter(
			upTo(bounds.keys + 1, (id) => id),
			(id) => !used.has(id)
		)
		const fresh = maxOf(used, bounds.keys) + 1
		const options: Arr.NonEmptyReadonlyArray<number> = [fresh, ...free]
		return options[source.draw(int(0, options.length - 1))] ?? fresh
	}

/**
 * A row `from` moved: at least one of its group, order and value drawn anew and changed, each shifted within its bound,
 * which is at least 2.
 */
const movedGen =
	(bounds: LiveBounds, from: LiveFact): Gen<LiveFact> =>
	(source) => {
		const shifted = (value: number, span: number): number =>
			(value + source.draw(int(1, span - 1))) % span
		const field = source.draw(int(0, 2))
		return {
			id: from.id,
			g: field === 0 || source.draw(boolean) ? shifted(from.g, bounds.groups) : from.g,
			o: field === 1 || source.draw(boolean) ? shifted(from.o, bounds.orders) : from.o,
			val: field === 2 ? shifted(from.val, bounds.values) : from.val
		}
	}

/**
 * One write over `state`, never to a row `taken` names: an insert where the relation it draws has no row left to delete or
 * move, else an insert, a delete or an update as drawn.
 */
const writeGen =
	(
		bounds: LiveBounds,
		state: LiveState,
		taken: ReadonlyArray<readonly [RelationPlace, number]>
	): Gen<LiveWrite> =>
	(source) => {
		const place = source.draw(relationGen)
		const takenHere = Arr.flatMap(taken, ([p, id]) => (p === place ? [id] : []))
		const rows = Arr.filter(rowsAt(state, place), (row) => !takenHere.includes(row.id))
		const insert = (): LiveWrite => ({
			kind: "insert",
			relation: place,
			fact: source.draw(factGen(bounds, source.draw(freeKeyGen(bounds, rows, takenHere))))
		})
		if (!Arr.isReadonlyArrayNonEmpty(rows)) {
			return insert()
		}
		const stored = rows[source.draw(int(0, rows.length - 1))] ?? rows[0]
		return source.draw(
			weighted<LiveWrite>([
				[2, () => insert()],
				[1, () => ({ kind: "delete", relation: place, fact: stored })],
				[
					3,
					(s) => ({
						kind: "update",
						relation: place,
						from: stored,
						to: s.draw(movedGen(bounds, stored))
					})
				]
			])
		)
	}

/** The row a write names, by relation and key. */
const rowOf = (write: LiveWrite): readonly [RelationPlace, number] => [
	write.relation,
	write.kind === "update" ? write.from.id : write.fact.id
]

/** One commit over `state`: a grizzle call of one write, or a direct writer's transaction of several, no two of one row. */
const commitGen =
	(bounds: LiveBounds, state: LiveState): Gen<LiveCommit> =>
	(source) => {
		if (source.draw(boolean)) {
			return { writer: "grizzle", write: source.draw(writeGen(bounds, state, [])) }
		}
		const count = source.draw(int(1, bounds.writes))
		const first = source.draw(writeGen(bounds, state, []))
		const writes: Array<LiveWrite> = []
		let at = written(state, first)
		for (let k = 1; k < count; k++) {
			const next = source.draw(writeGen(bounds, at, Arr.map([first, ...writes], rowOf)))
			writes.push(next)
			at = written(at, next)
		}
		return { writer: "psql", writes: [first, ...writes] }
	}

/** A history of commits from `facts`, each drawn over the state the commits before it left. */
const historyGen =
	(bounds: LiveBounds, facts: LiveState): Gen<ReadonlyArray<LiveCommit>> =>
	(source) => {
		const count = source.draw(int(0, bounds.commits))
		const commits: Array<LiveCommit> = []
		let state = facts
		for (let k = 0; k < count; k++) {
			const commit = source.draw(commitGen(bounds, state))
			commits.push(commit)
			state = committed(state, commit)
		}
		return commits
	}

const anchorGen =
	(bounds: LiveBounds): Gen<LiveAnchor> =>
	(source) => {
		const key = () => ({
			o: source.draw(int(0, bounds.orders - 1)),
			id: source.draw(int(0, bounds.keys - 1))
		})
		return source.draw(
			weighted<LiveAnchor>([
				[2, () => ({ kind: "start" })],
				[1, () => ({ kind: "end" })],
				[1, () => ({ kind: "after", ...key() })],
				[1, () => ({ kind: "before", ...key() })]
			])
		)
	}

const subscriptionGen =
	(bounds: LiveBounds, reads: Arr.NonEmptyReadonlyArray<WorldRead>): Gen<LiveSubscription> =>
	(source) => {
		const place = source.draw(int(0, reads.length - 1))
		const read = reads[place] ?? reads[0]
		const group = () => source.draw(int(0, bounds.groups - 1))
		switch (read.kind) {
			case "wide":
				return { read: place, binding: { kind: "none" } }
			case "page":
				return {
					read: place,
					binding: {
						kind: "window",
						group: group(),
						anchor: source.draw(anchorGen(bounds)),
						size: source.draw(int(1, bounds.window))
					}
				}
			case "keyed":
			case "count":
			case "ordered":
			case "window":
			case "join":
				return { read: place, binding: { kind: "group", group: group() } }
		}
	}

/** The live box's cases under `bounds` (see the header). */
export const liveCaseGen =
	(bounds: LiveBounds): Gen<LiveCase> =>
	(source) => {
		const reads: Arr.NonEmptyReadonlyArray<WorldRead> = [
			source.draw(readGen(bounds)),
			...source.draw(array(readGen(bounds), { min: 0, max: bounds.reads - 1 }))
		]
		const facts: LiveState = [source.draw(rowsGen(bounds)), source.draw(rowsGen(bounds))]
		return {
			mutable: [source.draw(boolean), source.draw(boolean)],
			reads,
			subscriptions: [
				source.draw(subscriptionGen(bounds, reads)),
				...source.draw(
					array(subscriptionGen(bounds, reads), { min: 0, max: bounds.subscriptions - 1 })
				)
			],
			facts,
			history: source.draw(historyGen(bounds, facts))
		}
	}

/** A read's member name in the login's workload, by its place. */
export const readMember = (place: number): string => `read${place}`

/** A write member's name: the op its facts go under and the relation's place. */
export const writeMember = (op: "insert" | "delete" | "put", place: RelationPlace): string =>
	`${op}${place}`

/**
 * The fence's relation, `Probe(id)`, which no read of a case reads and no commit of its history writes: a fence commit
 * inserts a row of it, and the probe member, a wide read of it, hears that commit after every commit before it.
 */
export const probeRelation = "Probe"

/** The probe member: every row of Probe. */
export const probeMember = "probe"

/**
 * The counted family every world holds and no read reads: a `Shelf(id)` owner whose drawn count `n` counts the
 * `Book(id, shelf)` members naming it, beside the items. A write of a book naming a stored shelf appends a member to a
 * stored owner, which its one flight writes by the family write's additions statement, and which only a mutable owner
 * takes (write/frontend/compile.ts), so Shelf is mutable.
 */
export const familyRelations = { owner: "Shelf", member: "Book" } as const

/** The family's write members: a shelf's insert, and a book's, each from its call's facts. */
export const familyMembers = { owner: "shelf", member: "book" } as const

/**
 * The closed relation every world holds, `Tier` of two codes, and its member, every tier: a read of closed relations
 * alone, whose value no write changes and whose watch is a constant one, registered under no routing key.
 */
export const closedRead = { relation: "Tier", member: "tiers" } as const

/** A relation's declared name, by place. */
export const relationName = (place: RelationPlace): string => `Item${place}`

/** The parameters a subscription's call binds. */
export const paramsOf = (subscription: LiveSubscription): Readonly<Record<string, number>> => {
	const group = groupOf(subscription)
	return group === undefined ? {} : { g: group }
}

/**
 * The schema of `c` named `name`, and its full world's login (test/support/worlds.ts fullWorld), whose one role `app`
 * holds both relations whole and serves every read of `c` and every write member, by its name (readMember, writeMember).
 */
export const liveWorld = (c: LiveCase, name: string) => {
	const fields = { id: pg.integer, g: pg.integer, o: pg.integer, val: pg.integer }
	const Item0 = relation(relationName(0), fields, ["id"])
	const Item1 = relation(relationName(1), fields, ["id"])
	const Probe = relation(probeRelation, { id: pg.integer }, ["id"])
	const Shelf = relation(familyRelations.owner, { id: pg.integer, n: drawn(natural) }, ["id"])
	const Book = relation(familyRelations.member, { id: pg.integer, shelf: pg.integer }, ["id"])
	const Tier = closed(closedRead.relation, ["gold", "silver"])
	const base = schema(
		name,
		[Item0, Item1, Probe, Shelf, Book, Tier],
		[
			...(c.mutable[0] ? [mutable(Item0)] : []),
			...(c.mutable[1] ? [mutable(Item1)] : []),
			mutable(Shelf),
			counted(on(Book, "shelf"), fin(Shelf, "n"))
		]
	)
	const items = [Item0, Item1] as const
	const keyed = (place: RelationPlace) => {
		const Item = items[place]
		return query(base).rule((r) => {
			const { id, o, val } = v(Item, "item")
			return r.match(Item, { id, g: r.param("g", pg.integer), o, val }).find({ id, o, val })
		})
	}
	const readOf = (read: WorldRead): unknown => {
		switch (read.kind) {
			case "keyed":
				return keyed(read.relation)
			case "wide": {
				const Item = items[read.relation]
				return query(base).rule((r) => {
					const { id, g, o, val } = v(Item, "item")
					return r.match(Item, { id, g, o, val }).find({ id, g, o, val })
				})
			}
			case "count": {
				const Item = items[read.relation]
				return query(base).rule((r) => {
					const { id } = v(Item, "item")
					return r.match(Item, { id, g: r.param("g", pg.integer) }).find({ rows: r.count() })
				})
			}
			case "ordered":
				return keyed(read.relation).orderBy(["o", "asc"], ["id", "asc"])
			case "page":
				return paged(keyed(read.relation).orderBy(["o", "asc"], ["id", "asc"]))
			case "window":
				return keyed(read.relation).orderBy(["o", "asc"], ["id", "asc"]).take(read.size)
			case "join": {
				const Left = items[read.relation]
				const Right = items[read.other]
				return query(base).rule((r) => {
					const group = r.param("g", pg.integer)
					const left = v(Left, "left")
					const right = v(Right, "right")
					return r
						.match(Left, { id: left.id, g: group, o: left.o })
						.match(Right, { id: right.id, g: group, val: right.val })
						.find({ left: left.id, right: right.id, o: left.o, val: right.val })
				})
			}
		}
	}
	const programs: Record<string, unknown> = {
		[probeMember]: query(base).rule((r) => {
			const { id } = v(Probe, "probe")
			return r.match(Probe, { id }).find({ id })
		})
	}
	for (const [place, read] of c.reads.entries()) {
		programs[readMember(place)] = readOf(read)
	}
	for (const place of [0, 1] as const) {
		const Item = items[place]
		programs[writeMember("insert", place)] = ChangeSet.empty(base).insert(Item, [])
		programs[writeMember("delete", place)] = ChangeSet.empty(base).delete(Item, [])
		programs[writeMember("put", place)] = ChangeSet.empty(base).put(Item, [])
	}
	programs[closedRead.member] = query(base).rule((r) => {
		const { id } = v(Tier, "tier")
		return r.match(Tier, { id }).find({ id })
	})
	programs[familyMembers.owner] = ChangeSet.empty(base).insert(Shelf, [])
	programs[familyMembers.member] = ChangeSet.empty(base).insert(Book, [])
	const world = fullWorld(base, programs)
	return { schema: base, world, logins: [world.server] }
}

/** The relations a read reads, by place: its footprint. */
const footprintOf = (read: WorldRead): ReadonlyArray<RelationPlace> =>
	read.kind === "join" ? Arr.dedupe([read.relation, read.other]) : [read.relation]

/**
 * The footprint a read's served file must record, by relation and the fields it routes by: every relation of its
 * footprint routed by `g`, which each of its matches fixes to the parameter `g`, but a wide read's, which fixes nothing.
 */
export const expectedRoutes = (
	read: WorldRead
): ReadonlyArray<{ readonly relation: RelationPlace; readonly routes: ReadonlyArray<"g"> }> =>
	Arr.map(footprintOf(read), (relation) => ({
		relation,
		routes: read.kind === "wide" ? [] : ["g"]
	}))

/** The rows a write touches: an insert's new row, a delete's old one, an update's both. */
const touchedRows = (write: LiveWrite): ReadonlyArray<LiveFact> => {
	switch (write.kind) {
		case "insert":
		case "delete":
			return [write.fact]
		case "update":
			return [write.from, write.to]
	}
}

/**
 * Whether `commit` touches a routing value of `subscription` (the routing oracle): it writes a relation of the read's
 * footprint, and the read binds no group, or one row it touches holds the bound group in `g`, before or after.
 */
export const touches = (
	c: LiveCase,
	subscription: LiveSubscription,
	commit: LiveCommit
): boolean => {
	const read = c.reads[subscription.read] ?? c.reads[0]
	const footprint = footprintOf(read)
	const group = groupOf(subscription)
	return Arr.some(
		writesOf(commit),
		(write) =>
			footprint.includes(write.relation) &&
			(group === undefined || Arr.some(touchedRows(write), (row) => row.g === group))
	)
}

/** One row of a read's value as the host model states it: its key's text and the row's cells. */
interface ModelRow {
	readonly key: string
	readonly cells: ReadonlyArray<number>
}

const byOrder: Order.Order<LiveFact> = Order.combine(
	Order.mapInput(Order.Number, (row: LiveFact) => row.o),
	Order.mapInput(Order.Number, (row: LiveFact) => row.id)
)

/** Whether `row` lies after the key `o`, `id` in a page's completed order. */
const pastKey = (row: LiveFact, o: number, id: number): boolean =>
	row.o > o || (row.o === o && row.id > id)

/** Whether `row` lies before the key `o`, `id` in a page's completed order. */
const beforeKey = (row: LiveFact, o: number, id: number): boolean =>
	row.o < o || (row.o === o && row.id < id)

/** The window a binding reads of rows in a page's completed order: all of them for a binding that is no window. */
const windowOf = (rows: ReadonlyArray<LiveFact>, binding: LiveBinding): ReadonlyArray<LiveFact> => {
	if (binding.kind !== "window") {
		return rows
	}
	const anchor = binding.anchor
	switch (anchor.kind) {
		case "start":
			return Arr.take(rows, binding.size)
		case "end":
			return Arr.takeRight(rows, binding.size)
		case "after":
			return Arr.take(
				Arr.filter(rows, (row) => pastKey(row, anchor.o, anchor.id)),
				binding.size
			)
		case "before":
			return Arr.takeRight(
				Arr.filter(rows, (row) => beforeKey(row, anchor.o, anchor.id)),
				binding.size
			)
	}
}

/**
 * A subscription's value over `state` as the host model states it, for the features a commit reaches: a set read's rows
 * in key order, an ordered read's in its order, a count's one row. It judges nothing: the suites' oracles are grizzle's
 * own fresh reads and the reference evaluator.
 */
const modelValue = (
	c: LiveCase,
	subscription: LiveSubscription,
	state: LiveState
): ReadonlyArray<ModelRow> => {
	const read = c.reads[subscription.read] ?? c.reads[0]
	const group = groupOf(subscription)
	const inGroup = (place: RelationPlace) =>
		Arr.filter(rowsAt(state, place), (row) => group === undefined || row.g === group)
	const rowOfFact = (row: LiveFact): ModelRow => ({ key: `${row.id}`, cells: [row.o, row.val] })
	switch (read.kind) {
		case "keyed":
			return Arr.map(Arr.sort(inGroup(read.relation), byOrder), rowOfFact)
		case "wide":
			return Arr.map(Arr.sort(rowsAt(state, read.relation), byOrder), (row) => ({
				key: `${row.id}`,
				cells: [row.g, row.o, row.val]
			}))
		case "count":
			return [{ key: "", cells: [inGroup(read.relation).length] }]
		case "ordered":
			return Arr.map(Arr.sort(inGroup(read.relation), byOrder), rowOfFact)
		case "window":
			return Arr.map(Arr.take(Arr.sort(inGroup(read.relation), byOrder), read.size), rowOfFact)
		case "page":
			return Arr.map(
				windowOf(Arr.sort(inGroup(read.relation), byOrder), subscription.binding),
				rowOfFact
			)
		case "join":
			return Arr.flatMap(inGroup(read.relation), (left) =>
				Arr.map(inGroup(read.other), (right) => ({
					key: `${left.id}:${right.id}`,
					cells: [left.o, right.val]
				}))
			)
	}
}

/** What a commit reached for one subscription (the live suites' commit situations). */
export type CommitSituation =
	| "a write outside its routing values"
	| "a write inside its routing values"
	| "a delete of a row it holds"
	| "a row removed from its value"
	| "a move in an ordered read"
	| "a write in a window's neighbourhood"
	| "a commit of no relation it reads"

/**
 * Whether a subscription's value over `state` holds `fact` of `place`: a row of a relation its read reads, of its bound
 * group, and, for a window or a page, among the window's rows.
 */
const holds = (
	c: LiveCase,
	subscription: LiveSubscription,
	state: LiveState,
	place: RelationPlace,
	fact: LiveFact
): boolean => {
	const read = c.reads[subscription.read] ?? c.reads[0]
	const group = groupOf(subscription)
	if (!footprintOf(read).includes(place) || (group !== undefined && fact.g !== group)) {
		return false
	}
	return (
		(read.kind !== "window" && read.kind !== "page") ||
		Arr.some(modelValue(c, subscription, state), (row) => row.key === `${fact.id}`)
	)
}

/**
 * The situations `commit`, from `before` to `after`, reaches for `subscription`: a write of its footprint outside its
 * routing values or inside them; a delete of a row its value held; a key its value held and no longer holds; a row of
 * an ordered read or a window that its commit wrote, which stays and follows another row than before; a window whose rows changed by a row its commit did not write,
 * pushed out or pulled in by a neighbour; a commit of no relation it reads.
 */
export const situationsOf = (
	c: LiveCase,
	subscription: LiveSubscription,
	commit: LiveCommit,
	before: LiveState,
	after: LiveState
): ReadonlyArray<CommitSituation> => {
	const read = c.reads[subscription.read] ?? c.reads[0]
	const footprint = footprintOf(read)
	const writes = Arr.filter(writesOf(commit), (write) => footprint.includes(write.relation))
	if (!Arr.isReadonlyArrayNonEmpty(writes)) {
		return ["a commit of no relation it reads"]
	}
	const was = modelValue(c, subscription, before)
	const is = modelValue(c, subscription, after)
	const wasKeys = new Set(Arr.map(was, (row) => row.key))
	const isKeys = new Set(Arr.map(is, (row) => row.key))
	const writtenKeys = new Set(
		Arr.flatMap(writes, (write) => Arr.map(touchedRows(write), (row) => `${row.id}`))
	)
	const found: Array<CommitSituation> = [
		touches(c, subscription, commit)
			? "a write inside its routing values"
			: "a write outside its routing values"
	]
	if (
		Arr.some(
			writes,
			(write) =>
				write.kind === "delete" && holds(c, subscription, before, write.relation, write.fact)
		)
	) {
		found.push("a delete of a row it holds")
	}
	if (Arr.some([...wasKeys], (key) => !isKeys.has(key))) {
		found.push("a row removed from its value")
	}
	if (read.kind === "ordered" || read.kind === "window" || read.kind === "page") {
		const before = (rows: ReadonlyArray<ModelRow>, key: string): string | undefined => {
			const at = Option.getOrUndefined(Arr.findFirstIndex(rows, (row) => row.key === key))
			return at === undefined || at === 0 ? undefined : rows[at - 1]?.key
		}
		const moved = Arr.some(
			was,
			(row) =>
				isKeys.has(row.key) &&
				writtenKeys.has(row.key) &&
				before(was, row.key) !== before(is, row.key)
		)
		if (moved) {
			found.push("a move in an ordered read")
		}
	}
	if (read.kind === "window" || read.kind === "page") {
		const entered = Arr.filter([...isKeys], (key) => !wasKeys.has(key))
		const left = Arr.filter([...wasKeys], (key) => !isKeys.has(key))
		if (Arr.some([...entered, ...left], (key) => !writtenKeys.has(key))) {
			found.push("a write in a window's neighbourhood")
		}
	}
	return found
}
