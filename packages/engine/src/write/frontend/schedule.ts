import { defect } from "#compiler/core/invariant.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Order from "#compiler/core/order.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { ActionCore } from "#compiler/ir/write.ts"

/** An action in execution order, with the positions of the earlier actions it depends on. */
interface ScheduledAction<A> {
	readonly scheduled: A
	readonly dependsOn: ReadonlyArray<number>
}

/**
 * One of a stratum's family statements, as the schedule orders it among the stratum's actions: the rows of a member
 * relation a family write deletes, refills, updates in place or inserts (`rows`), or the counts and ends of a family's
 * owners (`owners`), the owner relation `relation` of the member relation `member`, which update the owner's rows
 * (write/family/order.ts FamilyStatement). A refill rewrites in place the rows whose families' values a change of the
 * stratum leaves stale, ahead of the change that would cascade into them (analysis/theory/refill.ts). A refill, an
 * update in place and a count change only the columns `changes` names, by key (write/family/fold.ts ColumnKey), each
 * generated column that reads one of them among them.
 */
export type FamilyNode =
	| {
			readonly kind: "rows"
			readonly relation: string
			readonly statement: "delete" | "insert"
	  }
	| {
			readonly kind: "rows"
			readonly relation: string
			readonly statement: "refill" | "update"
			readonly changes: ReadonlyArray<string>
	  }
	| {
			readonly kind: "owners"
			readonly family: FamilyId
			readonly relation: string
			readonly member: string
			readonly changes: ReadonlyArray<string>
	  }
	| FamilyAdditions
	| FamilyRemovals

/** An owner relation a family statement changes the rows of, at the columns `changes` names: their counts and ends,
 * each generated column that reads one of them among them. */
export interface OwnerChanges {
	readonly relation: string
	readonly changes: ReadonlyArray<string>
}

/**
 * One member relation's family additions in a stratum, one statement (write/family/additions.ts): it inserts rows of
 * `member` and changes the rows of `owners`; or, appending none, it recounts the owners its stratum puts of `member`'s
 * families. Each member relation's additions take their own place in the stratum's order, as its appends' keys need, so
 * a member relation has one in a stratum.
 */
export type FamilyAdditions =
	| {
			readonly kind: "additions"
			readonly appends: "rows"
			readonly member: string
			/** The owner relations whose rows its appended members copy a column of, read as the stratum's earlier
			 * statements leave them, so it follows each statement that writes them. */
			readonly copies: ReadonlyArray<string>
			readonly owners: ReadonlyArray<OwnerChanges>
	  }
	| {
			readonly kind: "additions"
			readonly appends: "nothing"
			readonly member: string
			readonly owners: NonEmptyReadonlyArray<OwnerChanges>
	  }

/**
 * What a removals statement does to its member's rows besides redrawing their indexes: deletes and re-places those its
 * stratum deletes or puts, updates in place each stored one its stratum puts, and rewrites in place the groups its
 * stratum's plain puts' cascades reach (frontend/refill.ts plainRefills).
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
	readonly owners: ReadonlyArray<OwnerChanges>
	/** The plain relations whose puts its refills draw from, the member's rows as their cascades would leave them, which
	 * it writes ahead of each put of them, members first, so the cascade finds them changed (frontend/refill.ts
	 * plainRefills). */
	readonly refilledFrom: ReadonlyArray<string>
}

/** The relations a family statement writes: a member relation's rows, an owner's counts, or an additions or removals
 * statement's member, where it writes its rows, and owners. */
export const familyNodeRelations = (node: FamilyNode): ReadonlyArray<string> =>
	node.kind === "additions" || node.kind === "removals"
		? [...writtenMembers(node), ...node.owners.map((o) => o.relation)]
		: [node.relation]

/** The member relation an additions or removals statement writes the rows of: its member, none where it appends none. */
const writtenMembers = (node: FamilyAdditions | FamilyRemovals): ReadonlyArray<string> =>
	node.kind === "additions" && node.appends === "nothing" ? [] : [node.member]

/** A column PostgreSQL generates from its row, by key (write/family/fold.ts ColumnKey), with the keys of the columns it
 * reads. */
export interface GeneratedColumn {
	readonly key: string
	readonly reads: ReadonlyArray<string>
}

/** An operation a stratum's edits state of a member relation: an insertion, a put, a deletion, or a nested write's row. */
export type MemberOp = "insert" | "put" | "delete" | "nested"

/**
 * A stratum's edits of one member relation as its update in place writes them (write/family/edit.ts planEdits), by key
 * (write/family/fold.ts ColumnKey): the operations they state; `own`, the columns a put writes of a stored member, its
 * caller's fields but its key and its groups; `placed`, the columns its counted families draw on a member they move into
 * a freed slot or draw again from a changed step, an index, a copy of an owner's column and an accumulator, a copy of a
 * count aside, which the owner axis cascades; `refreshed`, the columns of the rows as the stratum's other changes leave
 * them where the stratum refills the relation, every column but its caller's fields an update sets, and none where it
 * refills none; and `generated`, the relation's generated columns.
 */
export interface MemberEdit {
	readonly ops: ReadonlyArray<MemberOp>
	readonly own: ReadonlyArray<string>
	readonly placed: ReadonlyArray<string>
	readonly refreshed: ReadonlyArray<string>
	readonly generated: ReadonlyArray<GeneratedColumn>
}

/**
 * The columns a member relation's update in place changes in its stratum (FamilyNode `changes`): a put's own columns;
 * where a deletion or a put removes or changes a member, the columns its counted families draw on the members they move
 * or draw again, and the refreshed ones of every row so written; and every column PostgreSQL generates from one of
 * them. An insertion and a nested write's row are inserted whole, and a sequence re-places its members by a deletion
 * and an insertion, so neither changes a column in place.
 */
export const updateChanges = (edit: MemberEdit): ReadonlyArray<string> => {
	const put = edit.ops.includes("put")
	const moves = put || edit.ops.includes("delete")
	return generating(
		[...(put ? edit.own : []), ...(moves ? [...edit.placed, ...edit.refreshed] : [])],
		edit.generated
	)
}

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

/**
 * A family of the schema, a tree's aside, as the schedule orders its statements: the family, its owner relation and its
 * member relation, and its owner axis: whether the axis is immediate, which orders the member's rows after their
 * owner's and before them going, and the columns its cascade writes on the member and reads on the owner, by key
 * (write/family/fold.ts ColumnKey).
 */
export interface FamilyPair {
	readonly family: FamilyId
	readonly owner: string
	readonly member: string
	readonly immediate: boolean
	readonly fromColumns: ReadonlyArray<string>
	readonly toColumns: ReadonlyArray<string>
}

/**
 * What a stratum's refills require of its order (write/frontend/refill.ts), members first: each refill before every put
 * action of a relation whose put its rows are drawn ahead of (`precedes`), and one family statement before another
 * (`edges`): a refill before the family statement whose change it is drawn ahead of, and a refill that carries an
 * owner's counts after its members' deletions, refills and updates in place and, where the family's owner axis is
 * immediate, before their insertions, as a count statement would.
 */
export interface RefillOrder {
	readonly precedes: ReadonlyArray<{ readonly node: FamilyNode; readonly relation: string }>
	readonly edges: ReadonlyArray<{ readonly before: FamilyNode; readonly after: FamilyNode }>
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
 * `toColumns`, each by key (write/family/fold.ts ColumnKey); `cascade` where an update of the referenced facts carries
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
const phaseOf = (a: ActionCore): 0 | 1 | 2 | 3 =>
	a.op === "delete" ? 0 : a.op === "put" ? 1 : a.serial.kind === "generated" ? 3 : 2

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
 * key, so it meets no fact the deletion frees, and either order leaves the stratum's one state. A generated addition
 * still follows it, its draws meeting a value the deletion frees.
 */
const followsOnRelation = (a: Scheduled, b: Scheduled): boolean =>
	phaseOf(a.action) < phaseOf(b.action) &&
	!(a.meeting === "nowhere" && a.action.op === "delete" && phaseOf(b.action) < 3)

/** The canonical order of a stratum's actions: relation, phase, then (the sort being stable) the order given. */
const scheduledOrder: Order.Comparator<Scheduled> = Order.combine(
	Order.mapInput(Order.compareStrings, (s: Scheduled) => s.action.relation),
	Order.mapInput(Order.compareNumbers, (s: Scheduled) => phaseOf(s.action))
)

export const canonicalActionOrder = <A extends Scheduled>(
	actions: ReadonlyArray<A>
): ReadonlyArray<A> => actions.toSorted(scheduledOrder)

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
 *   replaced key before its insertion, then the inserts with explicit or no serial values, then the generated
 *   additions. A relation whose facts meet nowhere (`Meeting`) takes its deletion in any order beside its puts and
 *   inserts, since no fact they give meets one the deletion frees. An insert after the puts meets a put's new fact as an exact repeat or a conflict witness of the insert
 *   protocol, never as a displaced occupant, which is what makes a put and an insert of one key with different
 *   payloads a key conflict; and the sequence advance after explicit serial values precedes every
 *   value a generated addition draws.
 * - Across relations, an immediate foreign key from C into P (`natives`, deferrable false) is checked at
 *   each statement, so P's additions precede C's, and C's removals precede P's. A deferred reference tolerates any
 *   order until COMMIT, so it orders nothing. A put is both a removal and an addition, but a pure set's put displaces
 *   nothing and is an addition alone, and an immediate foreign key's target is a pure set under the deferral rule (a
 *   reference into a relation that has a field outside the referenced columns is deferred): so C's put follows P's.
 *   Where the rules still order actions in a cycle, as a deletion and an insertion of one relation whose facts meet around a put of
 *   another that references it, no order keeps every key at every statement, and that cycle is the schedule.
 *
 * Family statements are ordered by the same keys, and among themselves only where the family planner's rows require
 * it, never into one order across the stratum's families, which no key requires and which closed cycles through keys
 * that hold none:
 * - one member relation's deletion, update in place and insertion, in that order: a counted removal frees its slot by
 *   the deletion before the update moves the last member into it, and a re-placed row is deleted before it is
 *   inserted again, the family's (group, index) key being immediate;
 * - one member relation's deletion before its refill: a refilled counted group's removal frees its slot before the
 *   refill moves the last member into it;
 * - a family's count after its member's and its owner's deletions, refills and updates, and before the owner's
 *   insertions: the count falls only once every kept member below the new count holds a slot below it
 *   (`CHECK (i < ‹n›)`, which the owner axis's cascade of the count reaches at once), a moved member's update writes
 *   its copies from the owner as the read found it, before the count's cascade, and an owner's own update in place is
 *   planned before its counts; and before the member's insertions where the owner axis is immediate, since a new
 *   member carries the new count;
 * - a member's update before its owner's update or refill where the member's update writes a column the owner axis
 *   cascades into and the owner's changes a column the axis reads: the member's update writes its copies from its
 *   owner as the read found it, and the owner's write cascades its new values into them at once, deferred axis or
 *   not, so the other order would overwrite them stale;
 * - one family relation's insertion before the insertion of a family relation an immediate key names it from, and
 *   the deletion of the naming one first: an owner's insertion before its members' and their deletion before its
 *   own where the owner axis is immediate, and no order where it is deferred, as on a cycle of families; so is one
 *   member relation's additions before another's, and their removals the other way, each in its own statement.
 * Against an action, a family statement adds, removes and changes facts as the keys see them: an insertion adds, a
 * deletion removes, and an update in place or a count adds and changes facts only at the columns it changes
 * (FamilyNode `changes`), so a key over other columns orders nothing; and an action runs before the family statements
 * of its own relation, whose planner reads the stratum's own writes of an owner as landed. A refill is ordered as its
 * `refills` require, members first (`RefillOrder`).
 *
 * The actions are numbered in a canonical order (relation, then the phases above, then member order), sorted
 * topologically with that order breaking ties, and each action's dependsOn lists the earlier actions an edge orders
 * before it; family statements follow the actions in the order given, where nothing places them earlier. */
export const scheduleStratum = <A extends Scheduled>(
	actions: ReadonlyArray<A>,
	family: ReadonlyArray<FamilyNode>,
	pairs: ReadonlyArray<FamilyPair>,
	references: ReadonlyArray<ImmediateReference>,
	refills: RefillOrder
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
	/** The family statement `step` of `relation` (a member relation's rows), none where the stratum has none. */
	const rowsOf = (
		relation: string,
		step: "delete" | "refill" | "update" | "insert"
	): Vertex | undefined =>
		statements.find(
			({ node }) => node.kind === "rows" && node.relation === relation && node.statement === step
		)?.vertex
	const before = (first: Vertex | undefined, then: Vertex | undefined): void => {
		if (first !== undefined && then !== undefined && first !== then) {
			then.follows.add(first)
		}
	}
	for (const { node, vertex } of statements) {
		if (node.kind === "additions") {
			for (const other of statements) {
				if (other.node.kind === "removals") {
					before(other.vertex, vertex)
				}
			}
			continue
		}
		if (node.kind === "removals") {
			continue
		}
		if (node.kind === "rows") {
			if (node.statement === "update") {
				before(rowsOf(node.relation, "delete"), vertex)
				before(vertex, rowsOf(node.relation, "insert"))
			}
			if (node.statement === "refill") {
				before(rowsOf(node.relation, "delete"), vertex)
			}
			if (node.statement === "delete") {
				before(vertex, rowsOf(node.relation, "insert"))
			}
			continue
		}
		before(rowsOf(node.relation, "delete"), vertex)
		before(rowsOf(node.relation, "refill"), vertex)
		before(rowsOf(node.relation, "update"), vertex)
		before(vertex, rowsOf(node.relation, "insert"))
		before(rowsOf(node.member, "delete"), vertex)
		before(rowsOf(node.member, "refill"), vertex)
		before(rowsOf(node.member, "update"), vertex)
		const counted = node.family
		if (pairs.some((p) => p.immediate && sameFamily(p.family, counted))) {
			before(vertex, rowsOf(node.member, "insert"))
		}
	}
	/** The family statement `node` names, none where the stratum has none. */
	const statementOf = (node: FamilyNode): Vertex | undefined =>
		statements.find((s) => sameNode(s.node, node))?.vertex
	for (const edge of refills.edges) {
		before(statementOf(edge.before), statementOf(edge.after))
	}
	/** The family statement `step` of `relation` (a member relation's rows) as a node, none where the stratum has none. */
	const nodeOf = (relation: string, step: "refill" | "update"): FamilyNode | undefined =>
		statements.find(
			({ node }) => node.kind === "rows" && node.relation === relation && node.statement === step
		)?.node
	for (const pair of pairs) {
		const member = nodeOf(pair.member, "update")
		if (
			pair.owner === pair.member ||
			member === undefined ||
			!changesAt(member, pair.fromColumns)
		) {
			continue
		}
		for (const step of ["refill", "update"] as const) {
			const owner = nodeOf(pair.owner, step)
			if (owner !== undefined && changesAt(owner, pair.toColumns)) {
				before(rowsOf(pair.member, "update"), rowsOf(pair.owner, step))
			}
		}
	}
	for (const r of references) {
		if (r.from === r.to) {
			continue
		}
		before(rowsOf(r.to, "insert"), rowsOf(r.from, "insert"))
		before(rowsOf(r.from, "delete"), rowsOf(r.to, "delete"))
	}
	for (const p of refills.precedes) {
		const refill = statementOf(p.node)
		for (const { action, vertex } of plain) {
			if (action.action.relation === p.relation && action.action.op === "put") {
				before(refill, vertex)
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
			const a = action.action.relation
			if (node.kind === "additions" || node.kind === "removals") {
				orderFamilyWrite(action, x, node, y, references)
				continue
			}
			if (a === node.relation) {
				y.follows.add(x)
			}
			for (const r of references) {
				if (r.from === r.to) {
					continue
				}
				if (r.to === a && r.from === node.relation) {
					order(x, actionEffect(action), y, familyEffect(node, r.fromColumns), r)
				}
				if (r.to === node.relation && r.from === a) {
					order(y, familyEffect(node, r.toColumns), x, actionEffect(action), r)
				}
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

/** Whether a family statement that changes rows in place changes one of `columns`. */
const changesAt = (node: FamilyNode, columns: ReadonlyArray<string>): boolean =>
	node.kind !== "additions" &&
	node.kind !== "removals" &&
	(node.kind === "owners" || node.statement === "refill" || node.statement === "update") &&
	node.changes.some((c) => columns.includes(c))

/**
 * Orders an action `x` and a stratum's family additions or removals `y` (FamilyAdditions, FamilyRemovals): the additions
 * follow every action of a relation they insert into, every put or delete of an owner they recount, whose rows they read
 * as landed, and an owner's insert where they copy its columns; an owner the stratum inserts carries its counts and ends
 * in its own row (write/program/bind.ts freshOwners), which no recount changes; and the immediate references between
 * them order them as any two writes' do, the additions adding the rows they insert, the removals removing the rows they
 * delete and re-place and changing the rows whose indexes they redraw, adding too where they update a put or refilled
 * member in place, and either adding and changing an owner's facts at the columns its recount changes; and a removals
 * that refills a member ahead of a put of a plain relation it draws from runs before that put.
 */
const orderFamilyWrite = <V extends { readonly follows: Set<V> }>(
	action: Scheduled,
	x: V,
	node: FamilyAdditions | FamilyRemovals,
	y: V,
	references: ReadonlyArray<ImmediateReference>
): void => {
	const a = action.action.relation
	const members = writtenMembers(node)
	if (node.kind === "removals" && node.refilledFrom.includes(a) && action.action.op === "put") {
		x.follows.add(y)
	}
	if (
		node.kind === "additions" &&
		(members.includes(a) ||
			(node.owners.some((o) => o.relation === a) &&
				(action.action.op !== "insert" || (node.appends === "rows" && node.copies.includes(a)))))
	) {
		y.follows.add(x)
	}
	const effectAt = (relation: string, columns: ReadonlyArray<string>): Effect | undefined => {
		if (members.includes(relation)) {
			return node.kind === "additions"
				? { adds: true, removes: false, updates: false }
				: { adds: node.edits.some((e) => e !== "delete"), removes: true, updates: true }
		}
		const owner = node.owners.find((o) => o.relation === relation)
		if (owner === undefined) {
			return undefined
		}
		const touched = owner.changes.some((c) => columns.includes(c))
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
 * the immediate references from `m`'s member into `n`'s, as the family planner's own statements of the two relations are
 * (`scheduleStratum`): the referenced member's additions before the referencing one's, and the referencing member's
 * removals before the referenced one's; and an additions that copies a column of `n`'s member's rows into its own
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
	const referenced = writtenMembers(n)
	const referencing = writtenMembers(m)
	const copied = m.kind === "additions" && m.appends === "rows" ? m.copies : []
	if (n.kind === "additions" && referenced.some((r) => copied.includes(r))) {
		y.follows.add(x)
	}
	if (
		!references.some(
			(r) => r.from !== r.to && referencing.includes(r.from) && referenced.includes(r.to)
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

/** Whether two families are one: the same owner and count. */
const sameFamily = (a: FamilyId, b: FamilyId): boolean => a.owner === b.owner && a.count === b.count

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
 * A family statement's effect at a reference's `columns` on its relation: an insertion adds and a deletion removes;
 * an update in place and a count add and update there only where they change one of those columns, and leave the
 * reference alone otherwise.
 */
const familyEffect = (node: FamilyNode, columns: ReadonlyArray<string>): Effect => {
	if (node.kind === "rows" && node.statement === "insert") {
		return { adds: true, removes: false, updates: false }
	}
	if (node.kind === "rows" && node.statement === "delete") {
		return { adds: false, removes: true, updates: false }
	}
	const touched = changesAt(node, columns)
	return { adds: touched, removes: false, updates: touched }
}

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

/** Whether two family statements of a stratum are one: their kind, and their relation and statement, their family or
 * their member. */
export const sameNode = (a: FamilyNode, b: FamilyNode): boolean => {
	switch (a.kind) {
		case "owners":
			return (
				b.kind === "owners" &&
				a.family.owner === b.family.owner &&
				a.family.count === b.family.count
			)
		case "rows":
			return b.kind === "rows" && a.relation === b.relation && a.statement === b.statement
		case "additions":
			return b.kind === "additions" && a.member === b.member
		case "removals":
			return b.kind === "removals" && a.member === b.member
	}
}
