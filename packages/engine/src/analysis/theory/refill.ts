/**
 * What a write changes on rows already stored, and the families whose drawn values read such a change, which grizzle
 * draws again by refilling their groups (write/family/refill.ts).
 *
 * A write changes stored rows' columns three ways:
 * - a put of a relation: the fields outside its primary key that its caller writes or PostgreSQL generates;
 * - an edit of a family's members, a tree's aside: its owner's count and every column its last axis carries there (the
 *   recount), and its members' index and copies along the owner and predecessor axes (the redraw);
 * - a refill of a family: its owner's ends (its recount), and its members' predecessor copies, accumulators and, along a
 *   tree, copies of their parent's (its redraw).
 *
 * A family's owner axis, a tree's aside, carries a changed column on by its ON UPDATE CASCADE into the member's column it
 * pairs with, and PostgreSQL generates again every field generated from a changed one. A value a family draws from a
 * column only when its row is written reads such a change: a fold's step or selection, a predecessor copy, a last copy,
 * and a tree node's copy of its parent's. A write's planner draws again the families of the relation it writes for its
 * own changes, and a refill draws its own family again; every other such value is a reader, whose family is refilled.
 * A write may re-place a family member's stored rows, deleting and inserting them again, which no cascade follows: a
 * put that moves a member to another group, or that changes what an ordered family reads of it, and a delete of an
 * ordered family's member, which re-places every member after it. Every member's copy of a column a change makes on a
 * relation the stratum re-places, along a family it owns, is a reader too, as is a re-placed counted member's copy of a
 * column a change makes on its owner (`replacedBy`).
 *
 * The refills a write needs close over the changes the refills make in turn. A refill whose own changes reach it again
 * is a cycle no order of the refills draws.
 */
import { familyKey } from "#compiler/analysis/theory/families.ts"
import { readsOf } from "#compiler/analysis/theory/fill.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { DerivedReader } from "#compiler/core/causes.ts"
import { defined } from "#compiler/core/invariant.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type AxisPair, type Family, isSequence, isTreeOf } from "#compiler/ir/family.ts"
import type { NativeColumn, RelationInfo } from "#compiler/ir/law.ts"

/** A native column's identity within its relation: a field by its name, a law column by its identifier. */
const columnId = (c: NativeColumn): string =>
	c.kind === "field" ? `field:${c.field.name}` : `law:${c.column}`

/** Whether two native columns are one column of one relation. */
const sameColumn = (a: NativeColumn, b: NativeColumn): boolean => columnId(a) === columnId(b)

/** A ChangeSet member's write of `relation` by `op`, which edits the families of `edited` it is a member of. */
export interface WriteChange {
	readonly kind: "write"
	readonly relation: RelationInfo
	readonly op: "insert" | "put" | "delete"
	readonly edited: ReadonlyArray<Family>
}

/**
 * A change of stored rows that refills start from: a write; or a refill of `family`, which the path from the write
 * `origin` first reached.
 */
export type Change =
	| WriteChange
	| { readonly kind: "refill"; readonly family: Family; readonly origin: WriteChange }

/** The write a change starts from: itself, or the write whose path first reached a refill. */
export const originOf = (change: Change): WriteChange =>
	change.kind === "write" ? change : change.origin

/**
 * A column a change makes on stored rows: a put's field of `relation`; or, by an edit or a refill of `family`, a column
 * of its owner (`owner`, its recount) or of its members (`member`, its redraw).
 */
export type Changed =
	| { readonly by: "put"; readonly relation: RelationInfo; readonly column: NativeColumn }
	| {
			readonly by: "owner" | "member"
			readonly family: Family
			readonly relation: RelationInfo
			readonly column: NativeColumn
	  }

/** One owner axis a change takes on by cascade: `family`'s, carrying its owner's `pair.to` into its member's `pair.from`. */
export interface Hop {
	readonly family: Family
	readonly pair: AxisPair
}

/** A value `family` draws only when its row is written, of kind `kind`, drawn into `column` of its owner or member. */
export interface Reader {
	readonly kind: DerivedReader["kind"]
	readonly family: Family
	readonly column: NativeColumn
}

/** A change's way to a reader: the column it changes, the owner axes it cascades along, and the value that reads it. */
export interface RefillPath {
	readonly change: Change
	readonly changed: Changed
	readonly copies: ReadonlyArray<Hop>
	readonly reader: Reader
}

/** A native column's name as a refusal names it: a field's name, a law column's identifier. */
export const columnName = (c: NativeColumn): string =>
	c.kind === "field" ? c.field.name : c.column

/** The relation a reader's column is on: a fold's end and a last copy on its family's owner, any other on its member. */
const readerRelation = (reader: Reader): RelationInfo =>
	reader.kind === "fold" || reader.kind === "last" ? reader.family.owner : reader.family.member

/** A reader as a refusal names it. */
export const derivedReader = (reader: Reader): DerivedReader => ({
	kind: reader.kind,
	family: { owner: reader.family.id.owner, count: reader.family.id.count },
	relation: readerRelation(reader).name,
	column: columnName(reader.column)
})

/** The values of `l`, whose member holds `column`, that read it and are drawn only when their row is written. */
const readersIn = (l: Family, column: NativeColumn): ReadonlyArray<Reader> => {
	const field = column.kind === "field" ? column.field.name : undefined
	return [
		...l.folds.flatMap((fold): ReadonlyArray<Reader> =>
			field !== undefined &&
			((fold.step.kind === "value" && fold.step.field.name === field) ||
				fold.where.some((w) => readsOf(w).includes(field)))
				? [{ kind: "fold", family: l, column: { kind: "field", field: fold.planes[0].end } }]
				: []
		),
		...l.axes.predecessor.flatMap((p): ReadonlyArray<Reader> =>
			sameColumn(p.to, column) ? [{ kind: "predecessor", family: l, column: p.from }] : []
		),
		...l.axes.last.flatMap((p): ReadonlyArray<Reader> =>
			sameColumn(p.to, column) ? [{ kind: "last", family: l, column: p.from }] : []
		),
		...(isTreeOf(l, l.member.name)
			? l.axes.owner.flatMap((p): ReadonlyArray<Reader> =>
					sameColumn(p.to, column) ? [{ kind: "tree", family: l, column: p.from }] : []
				)
			: [])
	]
}

/**
 * The columns a change makes on stored rows, each with the families whose readers at its relation the change itself
 * draws again (`handled`): a write's planner draws every family of the relation it writes, a refill its own family.
 */
const madeBy = (
	change: Change
): ReadonlyArray<{ readonly changed: Changed; readonly handled: (l: Family) => boolean }> => {
	if (change.kind === "refill") {
		const l = change.family
		const own = (f: Family): boolean => familyKey(f.id) === familyKey(l.id)
		return [
			...l.axes.last.map((p) => ({
				changed: { by: "owner" as const, family: l, relation: l.owner, column: p.from },
				handled: own
			})),
			...[
				...l.axes.predecessor.map((p) => p.from),
				...l.folds.flatMap((fold) => fold.planes.flatMap((plane) => [plane.before, plane.after])),
				...(isTreeOf(l, l.member.name) ? l.axes.owner.map((p) => p.from) : [])
			].map((column) => ({
				changed: { by: "member" as const, family: l, relation: l.member, column },
				handled: own
			}))
		]
	}
	const relation = change.relation
	const writes = (l: Family): boolean => l.member.name === relation.name
	const key = new Set(relation.primaryFields.map((f) => f.name))
	const put =
		change.op === "put"
			? relation.fields.flatMap((field) =>
					!key.has(field.name) &&
					(field.writing.kind === "caller" || field.writing.kind === "generated")
						? [
								{
									changed: {
										by: "put" as const,
										relation,
										column: { kind: "field" as const, field }
									},
									handled: writes
								}
							]
						: []
				)
			: []
	const edits = change.edited.flatMap((h) =>
		h.member.name !== relation.name || h.members.kind === "tree"
			? []
			: [
					...[{ kind: "field" as const, field: h.count }, ...h.axes.last.map((p) => p.from)].map(
						(column) => ({
							changed: { by: "owner" as const, family: h, relation: h.owner, column },
							handled: () => false
						})
					),
					...[
						h.index,
						...h.axes.owner.map((p) => p.from),
						...h.axes.predecessor.map((p) => p.from)
					].map((column) => ({
						changed: { by: "member" as const, family: h, relation, column },
						handled: writes
					}))
				]
	)
	return [...put, ...edits]
}

/**
 * A change's way to a member's copy, whether or not a reader meets it: the column it changes, the owner axes it cascades
 * along before, and the one that carries it into the member's copy.
 */
export interface Carried {
	readonly change: Change
	readonly changed: Changed
	readonly copies: ReadonlyArray<Hop>
	readonly hop: Hop
}

/** A change's paths, and every way its cascade takes into a member's copy. */
interface Reached {
	readonly paths: ReadonlyArray<RefillPath>
	readonly carried: ReadonlyArray<Carried>
}

/**
 * Every path from `change` to a reader among `families`, and every owner axis its cascade takes: see the module's
 * header. Each column it makes is followed into the readers of its relation's families but those it draws again itself,
 * along every owner axis that carries it, a tree's aside, and into every field generated from it; where its relation is
 * one `replaced` names, every owner axis that carries it is a reader too, a count among them, which its family's
 * members copy as ‹n›; and so is a counted family's owner axis that carries it into a relation `replaced` names, whose
 * re-placed rows no cascade reaches either. A sequence re-places its own members and draws each from its owner as the
 * stratum leaves it, and a re-placed counted member's ‹n› is its edit's to draw (write/family/edit.ts).
 */
const reachedBy = (
	families: ReadonlyArray<Family>,
	change: Change,
	replaced: ReadonlySet<string>
): Reached => {
	const paths: Array<RefillPath> = []
	const carried: Array<Carried> = []
	for (const { changed, handled } of madeBy(change)) {
		const seen = new Set<string>()
		const reach = (
			at: RelationInfo,
			column: NativeColumn,
			own: (l: Family) => boolean,
			copies: ReadonlyArray<Hop>
		): void => {
			const visit = `${at.name}\u0000${columnId(column)}\u0000${copies.length === 0 ? "own" : "carried"}`
			if (seen.has(visit)) {
				return
			}
			seen.add(visit)
			for (const l of families) {
				if (l.member.name === at.name && !own(l)) {
					for (const reader of readersIn(l, column)) {
						paths.push({ change, changed, copies, reader })
					}
				}
			}
			for (const j of families) {
				if (j.owner.name !== at.name || j.members.kind === "tree") {
					continue
				}
				if (
					replaced.has(at.name) &&
					column.kind === "field" &&
					column.field.name === j.count.name
				) {
					paths.push({
						change,
						changed,
						copies,
						reader: { kind: "owner", family: j, column: { kind: "law", column: j.copy } }
					})
				}
				for (const pair of j.axes.owner) {
					if (!sameColumn(pair.to, column)) {
						continue
					}
					const hop = { family: j, pair }
					carried.push({ change, changed, copies, hop })
					if (replaced.has(at.name) || (replaced.has(j.member.name) && !isSequence(j))) {
						paths.push({
							change,
							changed,
							copies,
							reader: { kind: "owner", family: j, column: pair.from }
						})
					}
					reach(j.member, pair.from, () => false, [...copies, hop])
				}
			}
			if (column.kind === "field") {
				for (const g of at.fields) {
					if (
						g.writing.kind === "generated" &&
						readsOf(g.writing.expr).includes(column.field.name)
					) {
						reach(at, { kind: "field", field: g }, own, copies)
					}
				}
			}
		}
		reach(changed.relation, changed.column, handled, [])
	}
	return { paths, carried }
}

/**
 * The refills a set of changes needs, closed over the changes the refills make: every path, the paths of each change
 * before those of the refills it reaches; every way each change cascades into a member's copy; the refilled families,
 * each after every refill whose change reaches it; and, when the refills close a cycle, the refills on it in the order
 * each reaches the next, with the path that closes it.
 */
export interface Closure {
	readonly paths: ReadonlyArray<RefillPath>
	readonly carried: ReadonlyArray<Carried>
	readonly refills: ReadonlyArray<Family>
	readonly cycle:
		| { readonly path: RefillPath; readonly refills: NonEmptyReadonlyArray<Family> }
		| undefined
}

/** The closure of `roots` among `families` (`Closure`), the relations of `replaced` re-placed (`reachedBy`). */
export const closureOf = (
	families: ReadonlyArray<Family>,
	roots: ReadonlyArray<WriteChange>,
	replaced: ReadonlySet<string>
): Closure => {
	const paths: Array<RefillPath> = []
	const carried: Array<Carried> = []
	const refilled = new Map<string, Family>()
	/** Each refilled family's refills its own changes reach, by family key. */
	const next = new Map<string, Set<string>>()
	const pending: Array<Change> = [...roots]
	for (let change = pending.shift(); change !== undefined; change = pending.shift()) {
		const reached = reachedBy(families, change, replaced)
		appendAll(carried, reached.carried)
		for (const path of reached.paths) {
			paths.push(path)
			const l = path.reader.family
			const key = familyKey(l.id)
			if (change.kind === "refill") {
				const from = familyKey(change.family.id)
				const out = next.get(from) ?? new Set<string>()
				out.add(key)
				next.set(from, out)
			}
			if (!refilled.has(key)) {
				refilled.set(key, l)
				pending.push({ kind: "refill", family: l, origin: originOf(change) })
			}
		}
	}
	const order: Array<Family> = []
	const done = new Set<string>()
	const stack: Array<string> = []
	const cycles: Array<NonNullable<Closure["cycle"]>> = []
	const familyOf = (key: string): Family =>
		defined(refilled.get(key), `the refilled family ${key} a refill reaches`)
	const visit = (key: string): void => {
		if (done.has(key)) {
			return
		}
		const at = stack.indexOf(key)
		if (at >= 0) {
			const [first, ...rest] = stack.slice(at)
			const closing = paths.find(
				(p) =>
					p.change.kind === "refill" &&
					familyKey(p.change.family.id) === stack.at(-1) &&
					familyKey(p.reader.family.id) === key
			)
			if (first !== undefined && closing !== undefined) {
				cycles.push({ path: closing, refills: [familyOf(first), ...rest.map(familyOf)] })
			}
			return
		}
		stack.push(key)
		for (const k of next.get(key) ?? []) {
			visit(k)
		}
		stack.pop()
		done.add(key)
		order.push(familyOf(key))
	}
	for (const key of refilled.keys()) {
		visit(key)
	}
	return { paths, carried, refills: order.toReversed(), cycle: cycles[0] }
}

/**
 * Whether a write of `relation` by `op` may re-place its stored rows, deleting and inserting them again, as a member of
 * `h`: a put, which may move it to another group or, along an ordered family, change what the family reads of it; or a
 * delete of an ordered family's member, which re-places every member after it. A tree re-places none, and an immutable
 * owner's group is fixed when its owner is inserted.
 */
const replaces = (h: Family, relation: RelationInfo, op: "insert" | "put" | "delete"): boolean =>
	h.member.name === relation.name &&
	h.members.kind === "every" &&
	h.owner.mutable &&
	(op === "put" || (op === "delete" && h.index.kind === "field"))

/** The relations whose stored rows `changes` may re-place (`replaces`). */
export const replacedBy = (
	families: ReadonlyArray<Family>,
	changes: ReadonlyArray<Change>
): ReadonlySet<string> =>
	new Set(
		changes.flatMap((c) =>
			c.kind === "write" && families.some((h) => replaces(h, c.relation, c.op))
				? [c.relation.name]
				: []
		)
	)

/**
 * Whether a refill of `l` can be written: its members, which it rewrites in place, are of a mutable relation, and so is
 * its owner. An immutable relation's rows are never updated in place, and an immutable owner's family is fixed when its
 * owner is inserted, so a change that would refill such a family is refused.
 */
export const refillable = (l: Family): boolean => l.member.mutable && l.owner.mutable

/**
 * The family axes a refill writes around, by family key, which PostgreSQL then checks only at commit:
 * - `owner`: the owner axis of every family whose member relation a refill rewrites, since the refill writes those rows
 *   with every value as the stratum leaves them, their owners' new values among them, before the change reaches the
 *   owners (members first); and of every family owned by a relation a put or a delete may re-place (`replaces`), one
 *   that owns no sequence, whose rows such a write deletes and inserts again under the members that reference them (a
 *   put or a delete of a member that owns a sequence is refused). A mutable owner's axis there is deferred by the plan's
 *   own rules already (laws/model/plan.ts FamilyPlanner); an immutable owner's, which a delete of an ordered family's
 *   member re-places just the same, by this rule alone;
 * - `predecessor`: the predecessor axis of every ordered family and tree a change refills, whose members' accumulators
 *   and copies a refill rewrites in place across its statements;
 * - and the owner axis of every tree a change refills, whose nodes' copies of their parent's a refill rewrites in place.
 *
 * Decided once per schema over every change a write can make on stored rows: a put of a mutable relation, and an edit
 * of a family whose owner is mutable, an immutable owner's family being fixed when its owner is inserted.
 */
export interface RefillDeferral {
	readonly owner: ReadonlySet<string>
	readonly predecessor: ReadonlySet<string>
}

/** The refill deferral of a schema's `families` (`RefillDeferral`). */
export const refillDeferral = (families: ReadonlyArray<Family>): RefillDeferral => {
	const relations = new Map<string, RelationInfo>()
	for (const f of families) {
		relations.set(f.owner.name, f.owner)
		relations.set(f.member.name, f.member)
	}
	const roots = [...relations.values()].flatMap((relation): ReadonlyArray<WriteChange> => {
		const edited = families.filter(
			(f) => f.member.name === relation.name && f.members.kind !== "tree" && f.owner.mutable
		)
		return relation.mutable || edited.length > 0
			? [{ kind: "write", relation, op: relation.mutable ? "put" : "insert", edited }]
			: []
	})
	/** Every relation a put or a delete may re-place, but one that owns a sequence, whose put and delete are refused. */
	const replaced = new Set(
		[...relations.values()].flatMap((relation) =>
			families.some((h) => replaces(h, relation, "put") || replaces(h, relation, "delete")) &&
			!families.some((f) => f.owner.name === relation.name && isSequence(f))
				? [relation.name]
				: []
		)
	)
	const refills = closureOf(families, roots, replaced).refills.filter(refillable)
	const refilled = new Set(refills.map((l) => l.member.name))
	return {
		owner: new Set(
			families.flatMap((f) =>
				refilled.has(f.member.name) || replaced.has(f.owner.name) ? [familyKey(f.id)] : []
			)
		),
		predecessor: new Set(
			refills.flatMap((l) =>
				l.index.kind === "field" || l.members.kind === "tree" ? [familyKey(l.id)] : []
			)
		)
	}
}
