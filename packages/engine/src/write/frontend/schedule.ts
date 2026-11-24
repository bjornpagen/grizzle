import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import * as Order from "#compiler/core/order.ts"
import type { ActionCore } from "#compiler/ir/write.ts"
import { type UnitDelete, type UnitMember, unitRelations } from "#compiler/write/delete/unit.ts"

/** An action in execution order, with the positions of the earlier actions it depends on. */
interface ScheduledAction<A> {
	readonly scheduled: A
	readonly dependsOn: ReadonlyArray<number>
}

/**
 * One of a stratum's family statements, as the schedule orders it among the stratum's actions: its deletes of whole
 * units, or one member relation's family additions or removals.
 */
export type FamilyNode = FamilyAdditions | FamilyRemovals | UnitRemovals

/**
 * A stratum's deletes of whole units, one statement (write/delete/unit.ts): it removes rows of every relation of its
 * units, each root and every relation below it, and runs before every other write of its stratum but the removals of
 * rows that reference its rows immediately, so the stratum's inserts meet no stored row at a key it removed.
 */
export interface UnitRemovals {
	readonly kind: "unit"
	readonly units: NonEmptyReadonlyArray<UnitDelete>
	/** Every relation below the units' roots, judged together (write/delete/unit.ts UnitMember). */
	readonly below: ReadonlyArray<UnitMember>
}

/**
 * A relation a family statement changes stored rows of, at the columns `changes` names, by key, each generated column
 * that reads one of them among them: an owner's counts and ends, or a rider's columns its families draw again
 * (`FamilyAdditions` and `FamilyRemovals` `riders`). Every other column of those rows keeps its value, so a reference
 * that reads none of them meets the rows as they were.
 */
export interface RowChanges {
	readonly relation: StoredRelationName
	readonly changes: ReadonlyArray<string>
}

/**
 * Where an appended member reads the owner's column an owner copy of its family carries (write/family/additions.ts),
 * by the rows of the owner relation its stratum inserts:
 * - `stored`: none, so the table holds every owner a member names;
 * - `held`: every row the stratum inserts holds the group's fields and the copied column, or for a generated field the
 *   written fields its generation reads, in the parameters the statement can read, as its row is written, a slot's
 *   stated facts or its nested rows as the statement holds them (`HeldSource`), which it reads before the table;
 * - `drawn`: the database draws the copied column of some, a described member's rows or a column no slot states and no
 *   nested row carries (an identity, a count, end or index a family draws in SQL, a generated field reading one, or a
 *   stamped field another statement stamps), so it reads the table once the owner's own statement has run.
 */
export type CopySource = "stored" | "held" | "drawn"

/** An owner copy an appended member's family draws: its family by key, its owner relation, the member's copy column by
 * key (write/family/fold.ts ColumnKey), and where it reads the owner's column (`CopySource`). */
export interface OwnerCopy {
	readonly family: string
	readonly owner: StoredRelationName
	readonly column: string
	readonly source: CopySource
}

/**
 * A source of the rows of an owner its stratum inserts that a family statement reads its `held` copies from: one of its
 * slots' facts, by the slot's name, or the stratum's nested rows of it (write/family/additions.ts OwnerRows). A stamp is
 * taken once in its stratum, by the statement that writes the rows carrying it (ir/instant.ts stampText), so the
 * sources of an owner the statement appends are those it appends it from, read with the stamps it takes of them, and an
 * owner another statement appends is read as the host sends it, without them (frontend/compile.ts ownerReadingOf).
 */
export type HeldSource =
	| { readonly kind: "slot"; readonly slot: ParamId }
	| { readonly kind: "nestedRows" }

/** An owner a family statement's `held` copies read, and every source of its rows they read (`HeldSource`). */
export interface HeldOwner {
	readonly owner: StoredRelationName
	readonly rows: NonEmptyReadonlyArray<HeldSource>
}

/**
 * A stratum's family additions of member relations, one statement (write/family/additions.ts): it inserts rows of each
 * of `members` and changes the rows of `owners`; or, appending none, it recounts the owners its stratum puts of
 * `member`'s families. Each member relation's additions take their own place in the stratum's order, as its appends' keys
 * need, so a member relation has one in a stratum; the relations a stamped nesting writes are one statement's, which
 * stamps each head once (write/family/nesting.ts Nesting `stamps`), the nesting's root among them.
 */
export type FamilyAdditions =
	| {
			readonly kind: "additions"
			readonly appends: "rows"
			readonly members: NonEmptyReadonlyArray<string>
			/** The owner relations whose rows its appended members copy a column of that the database draws, read as the
			 * stratum's earlier statements leave them, so it follows each statement that writes them (`OwnerCopy`
			 * `drawn`). */
			readonly copies: ReadonlyArray<string>
			/** Where each owner copy its appended members' families draw reads its owner's column. */
			readonly ownerCopies: ReadonlyArray<OwnerCopy>
			/** Each owner one of its `held` copies reads, with the sources of its rows as this statement holds them. */
			readonly held: ReadonlyArray<HeldOwner>
			readonly owners: ReadonlyArray<RowChanges>
			/** The member relations whose rows an edit of a member refills from the rows this statement appends of it, a
			 * stored one a put moves among them, as its removals refill them from the rows they redraw (FamilyRemovals
			 * `riders`): a re-placed row's dependants follow it, at the columns their families draw. */
			readonly riders: ReadonlyArray<RowChanges>
	  }
	| {
			readonly kind: "additions"
			readonly appends: "nothing"
			readonly member: string
			readonly owners: NonEmptyReadonlyArray<RowChanges>
	  }

/**
 * What a removals statement does to its member's rows besides redrawing their indexes: deletes and re-places those its
 * stratum deletes or puts, updates in place each stored one its stratum puts, and rewrites in place the groups its
 * stratum's plain puts' cascades reach (frontend/refill.ts StratumRefill).
 */
export type RemovalEdit = Extract<MemberOp, "put" | "delete"> | "refill"

/**
 * One member relation's family removals in a stratum, one statement (write/family/removals.ts): it deletes and re-places
 * rows of `member`, redraws the indexes of the rest, updates in place each stored one its stratum puts and the groups
 * its refills draw again, and changes the rows of `owners` at the columns `changes` names of each, their counts and
 * ends. `edits` are what it does to `member` (`RemovalEdit`): only a put's or a refill's update in place sets a field a
 * reference from `member` reads. Its stratum's additions follow it.
 */
export interface FamilyRemovals {
	readonly kind: "removals"
	readonly member: string
	readonly edits: NonEmptyReadonlyArray<RemovalEdit>
	readonly owners: ReadonlyArray<RowChanges>
	/** The plain relations whose puts its refills draw from, the member's rows as their cascades would leave them, which
	 * it writes ahead of each put of them, members first, so the cascade finds them changed (frontend/refill.ts
	 * StratumRefill). */
	readonly refilledFrom: ReadonlyArray<string>
	/** The member relations whose rows its edit's refills rewrite in place in this statement, from the rows of `member` it
	 * redraws (frontend/refill.ts RefillStart `edit`), none of them `member`, at the columns their families draw. */
	readonly riders: ReadonlyArray<RowChanges>
}

/** The relations a family statement writes: an additions or removals statement's member, where it writes its rows, and
 * owners, or every relation of a unit removal's units. */
export const familyNodeRelations = (node: FamilyNode): ReadonlyArray<string> =>
	node.kind === "unit"
		? unitRelations(node.units, node.below).map((r) => r.name)
		: [...writtenMembers(node), ...node.owners.map((o) => o.relation)]

/** The member relations an additions or removals statement writes the rows of: its members and its riders, none where
 * it appends none. */
const writtenMembers = (node: FamilyAdditions | FamilyRemovals): ReadonlyArray<string> =>
	writesMember(node) ? [...ownMembers(node), ...ridersOf(node).map((r) => r.relation)] : []

/** The member relations a statement that writes its members' rows inserts or re-places: a removals statement's one, an
 * appending additions statement's every one. */
const ownMembers = (
	node: FamilyRemovals | Extract<FamilyAdditions, { readonly appends: "rows" }>
): NonEmptyReadonlyArray<string> => (node.kind === "removals" ? [node.member] : node.members)

/** Whether a family statement writes its member's rows: a removals statement, or an additions statement that appends. */
const writesMember = (
	node: FamilyAdditions | FamilyRemovals
): node is FamilyRemovals | Extract<FamilyAdditions, { readonly appends: "rows" }> =>
	node.kind === "removals" || node.appends === "rows"

/** The riders of a family statement: none where it appends none. */
const ridersOf = (node: FamilyAdditions | FamilyRemovals): ReadonlyArray<RowChanges> =>
	writesMember(node) ? node.riders : []

/** Whether a statement's change of rows reaches a reference over `columns`: it changes one of them. */
const touches = (changed: RowChanges, columns: ReadonlyArray<string>): boolean =>
	changed.changes.some((c) => columns.includes(c))

/**
 * Whether a family statement writes rows of `relation` at `columns`, as a reference over those columns meets them: its
 * member's rows, which it inserts, deletes or re-places whole, or its riders' at the columns their families draw again,
 * every other column of a rider's row keeping its value.
 */
const writesAt = (
	node: FamilyAdditions | FamilyRemovals,
	relation: string,
	columns: ReadonlyArray<string>
): boolean =>
	(writesMember(node) && ownMembers(node).includes(relation)) ||
	ridersOf(node).some((r) => r.relation === relation && touches(r, columns))

/** A column PostgreSQL generates from its row, by key (ir/law.ts ColumnKey), with the keys of the columns it
 * reads. */
export interface GeneratedColumn {
	readonly key: string
	readonly reads: ReadonlyArray<string>
}

/** An operation a stratum's edits state of a member relation: an insertion, a put, a deletion, or a nested write's row. */
export type MemberOp = "insert" | "put" | "delete" | "nested"

/** `written` and every generated column that reads one of them, directly or through another generated column: the
 * columns a statement that writes `written` of a row changes. */
export const generating = (
	written: ReadonlyArray<string>,
	generated: ReadonlyArray<GeneratedColumn>
): ReadonlyArray<string> => {
	const changed = new Set(written)
	const pending = [...changed]
	for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
		for (const g of generated) {
			if (!changed.has(g.key) && g.reads.includes(key)) {
				changed.add(g.key)
				pending.push(g.key)
			}
		}
	}
	return [...changed]
}

/** A family statement in the stratum's order: `at`, the number of the stratum's actions that run before it. */
export interface FamilyAt {
	readonly node: FamilyNode
	readonly at: number
}

/** A write the schedule places: one of the stratum's actions, or one of its family statements. */
export type Write<A> =
	| { readonly kind: "action"; readonly action: A }
	| { readonly kind: "family"; readonly node: FamilyNode }

/**
 * A stratum's schedule: its actions in execution order, and where each of its family statements runs among them; or a
 * cycle of its writes, each of which an immediate key or foreign key must run before the next, and the last before the
 * first, which no order keeps.
 */
export type Schedule<A> =
	| {
			readonly kind: "ordered"
			readonly actions: ReadonlyArray<ScheduledAction<A>>
			readonly family: ReadonlyArray<FamilyAt>
	  }
	| { readonly kind: "cycle"; readonly cycle: NonEmptyReadonlyArray<Write<A>> }

/**
 * Where two distinct facts of a relation meet, which decides what its removals free for its additions:
 * - `key`: at its primary key, which leaves a payload outside it (write/frontend/targets.ts Payload): a put displaces the
 *   fact at each key it writes, and a removal frees a key an addition may take;
 * - `unique`: a pure set's, each fact its own primary key, at a unique object besides it: a put displaces nothing, and a
 *   removal frees a value of that object an addition may take;
 * - `nowhere`: a pure set's with no unique object besides its primary key: a put displaces nothing, and no fact an
 *   addition gives meets one a removal frees but itself, which the removal's D EXCEPT A keeps.
 */
export type Meeting = "key" | "unique" | "nowhere"

/** What the schedule reads of an action: what it does, and where facts of its relation meet (`Meeting`). */
interface Scheduled {
	readonly action: ActionCore
	readonly meeting: Meeting
}

/**
 * An immediate reference: facts of `from` name facts of `to` at every statement, by the columns `fromColumns` and
 * `toColumns`, each by key (ir/law.ts ColumnKey); `cascade` where an update of the referenced facts carries
 * itself into the referencing ones (ON UPDATE CASCADE), so only a deletion removes what they reference.
 */
export interface ImmediateReference {
	readonly from: string
	readonly to: string
	readonly cascade: boolean
	readonly fromColumns: ReadonlyArray<string>
	readonly toColumns: ReadonlyArray<string>
}

/** The phase of an action on its own relation. */
const phaseOf = (a: ActionCore): 0 | 1 | 2 => (a.op === "delete" ? 0 : a.op === "put" ? 1 : 2)

/**
 * Whether an action removes facts: a deletion, or a put of a relation with a payload, which displaces the occupant of
 * each key it writes. A pure set's put displaces nothing: its fact at a key is the key, so its put only adds.
 */
const removes = (s: Scheduled): boolean =>
	s.action.op === "delete" || (s.action.op === "put" && s.meeting === "key")
const adds = (s: Scheduled): boolean => s.action.op === "insert" || s.action.op === "put"

/**
 * Whether `b` runs after `a`, two actions of one relation: in a later phase, but for a deletion before a put or an
 * insert of given facts where the relation's facts meet nowhere (`Meeting`): every fact the addition gives is its own
 * key, so it meets no fact the deletion frees, and either order leaves the stratum's one state.
 */
const followsOnRelation = (a: Scheduled, b: Scheduled): boolean =>
	phaseOf(a.action) < phaseOf(b.action) && !(a.meeting === "nowhere" && a.action.op === "delete")

/** The canonical order of a stratum's actions: an action of a relation in `last` after every other, then relation,
 * phase, then (the sort being stable) the order given. */
const scheduledOrder = (last: ReadonlySet<string>): Order.Comparator<Scheduled> =>
	Order.combineAll([
		Order.mapInput(Order.compareBooleans, (s: Scheduled) => last.has(s.action.relation)),
		Order.mapInput(Order.compareStrings, (s: Scheduled) => s.action.relation),
		Order.mapInput(Order.compareNumbers, (s: Scheduled) => phaseOf(s.action))
	])

/**
 * A stratum's actions in canonical order (`scheduledOrder`), the actions of the relations `deltas` names after every
 * other: relations whose deltas a read-back reads beside a relation it reads as state, which the stratum's order wrote
 * after them (frontend/compile.ts). A read-back over such a delta rides the statement that makes it where the state it
 * reads is settled there, which sees the state every earlier statement wrote, and is carried to the end of the write
 * otherwise (write/schedule/plan.ts placeReadBacks), so where no key orders the actions this runs the writes of the
 * state it reads first, and the read-back rides with no carrier. Every member of a stratum reads the stratum's starting
 * state, so the order of actions no key orders changes no result.
 */
export const canonicalActionOrder = <A extends Scheduled>(
	actions: ReadonlyArray<A>,
	deltas: ReadonlySet<string>
): ReadonlyArray<A> => actions.toSorted(scheduledOrder(deltas))

/** Orders one stratum's actions, given in canonical order (canonicalActionOrder): each in execution order with the
 * positions of the earlier actions it depends on. Each action is a vertex holding the actions an edge orders before it;
 * the next action is the first in canonical order whose predecessors are all placed. Where none is, the remaining
 * actions hold a cycle no order keeps, and the schedule is that cycle: no edge is ever dropped.
 *
 * b references a: a's additions before b's, b's removals before a's.
 *
 * The dependency graph of one stratum's physical actions.
 *
 * Every member of a stratum is evaluated against the state before the stratum's writes, so the order of its actions
 * is a physical choice, constrained only by what immediate constraints see between statements:
 *
 * - On one relation, removals come before additions, because primary keys and UNIQUE constraints are immediate and
 *   cannot be wished away: the exact deletions first, then the puts, whose implied deletion frees each
 *   replaced key before its insertion, then the inserts. A relation whose facts meet nowhere (`Meeting`) takes its
 *   deletion in any order beside its puts and inserts, since no fact they give meets one the deletion frees. An insert
 *   after the puts meets a put's new fact as an exact repeat or a conflict witness of the insert protocol, never as a
 *   displaced occupant, which is what makes a put and an insert of one key with different payloads a key conflict.
 * - Across relations, an immediate foreign key from C into P (`natives`, deferrable false) is checked at
 *   each statement, so P's additions precede C's, and C's removals precede P's. A deferred reference tolerates any
 *   order until COMMIT, so it orders nothing. A put is both a removal and an addition, but a pure set's put displaces
 *   nothing and is an addition alone, and an immediate foreign key's target is a pure set under the deferral rule (a
 *   reference into a relation that has a field outside the referenced columns is deferred): so C's put follows P's.
 *   Where the rules still order actions in a cycle, as a deletion and an insertion of one relation whose facts meet around a put of
 *   another that references it, no order keeps every key at every statement, and that cycle is the schedule.
 *
 * Family statements are ordered by the same keys, and among themselves only where their rows require it, never into one
 * order across the stratum's families, which no key requires and which closed cycles through keys that hold none:
 * every removals before every additions, one member relation's additions before those of a member relation an
 * immediate key names it from, and their removals the other way, an additions that copies a column of another's member
 * after that additions (`orderFamilyWrites`).
 * A stratum's unit removal (`UnitRemovals`) runs before every other write of it, so its source reads the state before
 * the stratum and every insertion of the stratum meets no row it removed, but the removals of rows that reference its
 * relations immediately from outside them, which run before it, as any removal of referencing rows does; a member's
 * removals within its units run after it, finding only the rows it leaves.
 * Against an action, a family additions or removals is ordered as `orderFamilyWrite` says.
 *
 * The actions are numbered in a canonical order (the relations the caller names last, then relation, the phases above,
 * then member order: canonicalActionOrder), sorted topologically with that order breaking ties, and each
 * action's dependsOn lists the earlier actions an edge orders before it; family statements follow the actions in the
 * order given, where nothing places them earlier. */
export const scheduleStratum = <A extends Scheduled>(
	actions: ReadonlyArray<A>,
	family: ReadonlyArray<FamilyNode>,
	references: ReadonlyArray<ImmediateReference>
): Schedule<A> => {
	interface Vertex {
		readonly write: Write<A>
		readonly follows: Set<Vertex>
	}
	const vertexOf = (write: Write<A>): Vertex => ({ write, follows: new Set<Vertex>() })
	const plain = actions.map((action) => ({ action, vertex: vertexOf({ kind: "action", action }) }))
	const statements = family.map((node) => ({ node, vertex: vertexOf({ kind: "family", node }) }))
	for (const { action: xa, vertex: x } of plain) {
		for (const { action: ya, vertex: y } of plain) {
			if (x === y) {
				continue
			}
			const a = xa.action
			const b = ya.action
			if (a.relation === b.relation) {
				if (followsOnRelation(xa, ya)) {
					y.follows.add(x)
				}
				continue
			}
			if (!references.some((r) => r.from === b.relation && r.to === a.relation)) {
				continue
			}
			if (adds(xa) && adds(ya)) {
				y.follows.add(x)
			}
			if (removes(xa) && removes(ya)) {
				x.follows.add(y)
			}
		}
	}
	const before = (first: Vertex | undefined, then: Vertex | undefined): void => {
		if (first !== undefined && then !== undefined && first !== then) {
			then.follows.add(first)
		}
	}
	for (const { node, vertex } of statements) {
		if (node.kind === "unit") {
			const removed = familyNodeRelations(node)
			/** Whether a write of `relation` that removes rows must run first: they reference the unit's rows immediately,
			 * from outside the unit, so they go before the rows they name. */
			const referencesUnit = (relation: string): boolean =>
				!removed.includes(relation) &&
				references.some((r) => r.from === relation && r.from !== r.to && removed.includes(r.to))
			for (const { action: x, vertex: other } of plain) {
				if (removes(x) && referencesUnit(x.action.relation)) {
					before(other, vertex)
				} else {
					before(vertex, other)
				}
			}
			for (const { node: n, vertex: other } of statements) {
				if (n.kind === "removals" && referencesUnit(n.member)) {
					before(other, vertex)
				} else {
					before(vertex, other)
				}
			}
		} else if (node.kind === "additions") {
			for (const other of statements) {
				if (other.node.kind === "removals") {
					before(other.vertex, vertex)
				}
			}
		}
	}
	for (const { node: n, vertex: x } of statements) {
		for (const { node: m, vertex: y } of statements) {
			if (
				(n.kind === "additions" && m.kind === "additions" && x !== y) ||
				(n.kind === "removals" && m.kind === "removals" && x !== y)
			) {
				orderFamilyWrites(n, x, m, y, references)
			}
		}
	}
	for (const { action, vertex: x } of plain) {
		for (const { node, vertex: y } of statements) {
			if (node.kind !== "unit") {
				orderFamilyWrite(action, x, node, y, references)
			}
		}
	}
	const sequence: Array<Vertex> = []
	const placed = new Set<Vertex>()
	for (
		let remaining: ReadonlyArray<Vertex> = [
			...plain.map((p) => p.vertex),
			...statements.map((s) => s.vertex)
		];
		isNonEmpty(remaining);
	) {
		const ready = remaining.find((v) => [...v.follows].every((u) => placed.has(u)))
		if (ready === undefined) {
			return { kind: "cycle", cycle: cycleAmong(remaining, placed) }
		}
		sequence.push(ready)
		placed.add(ready)
		remaining = remaining.filter((v) => v !== ready)
	}
	const ordered = sequence.flatMap((v) => (v.write.kind === "action" ? [v] : []))
	return {
		kind: "ordered",
		actions: ordered.map((v, at) => ({
			scheduled: actionOf(v.write),
			dependsOn: Object.freeze(
				ordered.slice(0, at).flatMap((u, position) => (v.follows.has(u) ? [position] : []))
			)
		})),
		family: sequence.flatMap((v, i) =>
			v.write.kind === "family"
				? [
						{
							node: v.write.node,
							at: sequence.slice(0, i).filter((u) => u.write.kind === "action").length
						}
					]
				: []
		)
	}
}

/**
 * Orders an action `x` and a stratum's family additions or removals `y` (FamilyAdditions, FamilyRemovals): the additions
 * follow every action of a relation they insert into, every put or delete of an owner they recount, whose rows they read
 * as landed, and an owner's insert where they copy its columns; an owner the stratum inserts carries its counts and ends
 * in its own row (runtime/write/bind.ts freshOwners), which no recount changes; and the immediate references between
 * them order them as any two writes' do, the additions adding the rows they insert, the removals removing the rows they
 * delete and re-place and changing the rows whose indexes they redraw, adding too where they update a put or refilled
 * member in place, either adding and changing the rows of each member relation its edit's refills rewrite (`riders`) at
 * the columns their families draw again, and either adding and changing an owner's facts at the columns its recount
 * changes; and a removals that refills a member
 * ahead of a put of a plain relation it draws from runs before that put.
 */
const orderFamilyWrite = <V extends { readonly follows: Set<V> }>(
	action: Scheduled,
	x: V,
	node: FamilyAdditions | FamilyRemovals,
	y: V,
	references: ReadonlyArray<ImmediateReference>
): void => {
	const a = action.action.relation
	if (node.kind === "removals" && node.refilledFrom.includes(a) && action.action.op === "put") {
		x.follows.add(y)
	}
	if (
		node.kind === "additions" &&
		(writtenMembers(node).includes(a) ||
			(node.owners.some((o) => o.relation === a) &&
				(action.action.op !== "insert" || (node.appends === "rows" && node.copies.includes(a)))))
	) {
		y.follows.add(x)
	}
	const effectAt = (relation: string, columns: ReadonlyArray<string>): Effect | undefined => {
		if (writesMember(node) && ownMembers(node).includes(relation)) {
			return node.kind === "additions"
				? { adds: true, removes: false, updates: false }
				: { adds: node.edits.some((e) => e !== "delete"), removes: true, updates: true }
		}
		const changed = [...ridersOf(node), ...node.owners].find((o) => o.relation === relation)
		if (changed === undefined) {
			return undefined
		}
		const touched = touches(changed, columns)
		return { adds: touched, removes: false, updates: touched }
	}
	for (const r of references) {
		if (r.from === r.to) {
			continue
		}
		const asSource = r.to === a ? effectAt(r.from, r.fromColumns) : undefined
		if (asSource !== undefined) {
			order(x, actionEffect(action), y, asSource, r)
		}
		const asTarget = r.from === a ? effectAt(r.to, r.toColumns) : undefined
		if (asTarget !== undefined) {
			order(y, asTarget, x, actionEffect(action), r)
		}
	}
}

/**
 * Orders two of a stratum's family additions, or two of its removals, `x` writing `n`'s member and `y` writing `m`'s, by
 * the immediate references from the rows `m` writes into those `n` writes (`scheduleStratum`), a rider's at the columns
 * its families draw again, which a reference over none of them never meets (`writesAt`): the referenced member's
 * additions before the referencing one's, and the referencing member's removals before the referenced one's; and an additions that copies a column of `n`'s member's rows into its own
 * after `n`'s additions, which insert them. An additions and a removals are ordered already, every removals first, and an
 * owner's recount orders nothing against another statement's, as a count statement's does not.
 */
const orderFamilyWrites = <V extends { readonly follows: Set<V> }>(
	n: FamilyAdditions | FamilyRemovals,
	x: V,
	m: FamilyAdditions | FamilyRemovals,
	y: V,
	references: ReadonlyArray<ImmediateReference>
): void => {
	const copied = m.kind === "additions" && m.appends === "rows" ? m.copies : []
	if (n.kind === "additions" && writtenMembers(n).some((r) => copied.includes(r))) {
		y.follows.add(x)
	}
	if (
		!references.some(
			(r) => r.from !== r.to && writesAt(m, r.from, r.fromColumns) && writesAt(n, r.to, r.toColumns)
		)
	) {
		return
	}
	if (n.kind === "additions") {
		y.follows.add(x)
	} else {
		x.follows.add(y)
	}
}

/** A placed write's action, which an action vertex holds. */
const actionOf = <A>(write: Write<A>): A => {
	if (write.kind !== "action") {
		throw defect("an action vertex holds an action")
	}
	return write.action
}

/**
 * What a write does to the facts a reference names, at the reference's columns: whether it adds facts there, removes
 * them, or updates them in place.
 */
interface Effect {
	readonly adds: boolean
	readonly removes: boolean
	readonly updates: boolean
}

/** An action's effect: an insertion adds, a deletion removes, a put adds, and a put of a relation with a payload also
 * updates, displacing the occupant of each key it writes. */
const actionEffect = (action: Scheduled): Effect => ({
	adds: adds(action),
	removes: action.action.op === "delete",
	updates: action.action.op === "put" && action.meeting === "key"
})

/**
 * Orders a write `target` of the referenced relation and a write `source` of the referencing one by the reference `r`:
 * the target's additions before the source's, and the source's removals before the target's, a target's update a
 * removal unless `r` cascades it, a source's update a removal of the references it changes.
 */
const order = <V extends { readonly follows: Set<V> }>(
	targetVertex: V,
	target: Effect,
	sourceVertex: V,
	source: Effect,
	r: ImmediateReference
): void => {
	if (target.adds && source.adds) {
		sourceVertex.follows.add(targetVertex)
	}
	const targetRemoves = target.removes || (target.updates && !r.cascade)
	const sourceRemoves = source.removes || source.updates
	if (targetRemoves && sourceRemoves) {
		targetVertex.follows.add(sourceVertex)
	}
}

/**
 * A cycle among `remaining`, every one of which follows an action not yet `placed`, in the order they must run: from the
 * first remaining, each step goes back to an unplaced action it follows, until one is met again, and the actions from
 * that one on, reversed, each must run before the next.
 */
const cycleAmong = <A>(
	remaining: NonEmptyReadonlyArray<{
		readonly write: Write<A>
		readonly follows: ReadonlySet<unknown>
	}>,
	placed: ReadonlySet<unknown>
): NonEmptyReadonlyArray<Write<A>> => {
	type Vertex = (typeof remaining)[number]
	const walked: Array<Vertex> = []
	for (let at: Vertex | undefined = remaining[0]; at !== undefined;) {
		const seen = walked.indexOf(at)
		if (seen >= 0) {
			const [first, ...rest] = walked.slice(seen).toReversed()
			if (first === undefined) {
				break
			}
			return [first.write, ...rest.map((v) => v.write)]
		}
		walked.push(at)
		const from: Vertex = at
		at = remaining.find((v) => from.follows.has(v) && !placed.has(v))
	}
	throw defect("every remaining action follows an unplaced one, so the walk back meets one again")
}

/** Whether two family statements of a stratum are one: their kind and their member. */
export const sameNode = (a: FamilyNode, b: FamilyNode): boolean => {
	switch (a.kind) {
		case "additions":
			return (
				b.kind === "additions" &&
				(a.appends === "rows"
					? b.appends === "rows" && a.members[0] === b.members[0]
					: b.appends === "nothing" && a.member === b.member)
			)
		case "removals":
			return b.kind === "removals" && a.member === b.member
		case "unit":
			return b.kind === "unit"
	}
}
