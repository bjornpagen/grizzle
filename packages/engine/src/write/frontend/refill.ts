/**
 * A stratum's refills as its write front end plans them (analysis/theory/refill.ts): the closure of the changes its
 * writes make on stored rows, refused where grizzle cannot draw a stale value again, and the reads that locate every row
 * a refill rewrites and every owner row a cascade carries a change through.
 *
 * A read follows a chain from a change of the stratum to the rows it reaches, all in the one read flight before any
 * write: from a put's rows, by the keys its facts state, or from the groups an edit of a family touches, through each
 * owner axis the change cascades along (an owner's members), each refilled family's groups (a member's groups, then
 * their owners for the family's recount or their members for its redraw), to the groups a refill rewrites or the owner
 * rows a cascade reaches before it is drawn into a member. Every row a chain passes is read whole, so the host draws
 * each value along it as PostgreSQL's cascade and generated fields would.
 */
import { familyKey } from "#compiler/analysis/theory/families.ts"
import {
	type Carried,
	type Change,
	type Changed,
	type Closure,
	closureOf,
	replacedBy,
	columnName,
	derivedReader,
	type Hop,
	originOf,
	type RefillPath,
	refillable,
	type WriteChange
} from "#compiler/analysis/theory/refill.ts"
import type { StaleCause } from "#compiler/core/causes.ts"
import { CompileError, type RoleAccess } from "#compiler/core/errors.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { type Family, isTreeOf } from "#compiler/ir/family.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import {
	type GroupsOf,
	groupsKey,
	type RefillRead,
	type RowsOf,
	rowsKey,
	rowsRelation
} from "#compiler/write/family/chain.ts"
import { endColumns } from "#compiler/write/family/statements.ts"
import type { FamilyNode, RefillOrder } from "#compiler/write/frontend/schedule.ts"

/** One of a stratum's writes as its refills start from it: its change, where it is, and where a put's rows come from. */
export interface StratumWrite {
	readonly change: WriteChange
	readonly loc: SourceLoc
	/** A put's rows: its member slot's facts, or a query's rows, which the host never sees; none for any other write. */
	readonly rows:
		| { readonly kind: "slot"; readonly slot: ParamId }
		| { readonly kind: "query" }
		| { readonly kind: "none" }
}

/** What a role holds of its base, as a refill reads and rewrites it; reality holds everything. */
export type RefillHolds =
	| { readonly kind: "reality" }
	| {
			readonly kind: "role"
			readonly role: string
			readonly base: string
			readonly reads: (relation: string) => boolean
			readonly writes: (relation: string) => boolean
	  }

/**
 * A stratum's refills: its writes' closure; the reads they need; the relations whose rows a refill rewrites; the
 * families whose owners' ends a refill changes; and the order the refills require of the stratum's statements.
 */
export interface StratumRefill {
	readonly closure: Closure
	readonly reads: ReadonlyArray<RefillRead>
	readonly relations: ReadonlyArray<string>
	readonly recounted: ReadonlyArray<Family>
	readonly order: RefillOrder
}

/**
 * Where a refill starts (write/family/removals.ts RefillWay): a put of a plain relation, whose facts state its changed
 * rows; an edit of a family's member relation, whose own removals statement redraws its changed rows by `family`; or
 * an append to `family`, whose additions statement recounts the owners whose count and ends its stored members copy
 * (write/family/additions.ts recountOf).
 */
export type RefillStart =
	| { readonly kind: "put"; readonly relation: string }
	| { readonly kind: "edit"; readonly relation: string; readonly family: Family }
	| { readonly kind: "recount"; readonly relation: string; readonly family: Family }

/**
 * A way a change of the stratum reaches a refilled family's members: where it starts, and the family whose owner axis
 * carries its change into the refilled family's member.
 */
export interface PlainRefillWay {
	readonly root: RefillStart
	readonly hop: Family
}

/** A refilled family of one member relation, and the ways the stratum's changes reach its members. */
export interface PlainRefill {
	readonly family: Family
	readonly ways: NonEmptyReadonlyArray<PlainRefillWay>
}

/** Whether two ways start at one change and ride one family's owner axis. */
const sameWay = (a: PlainRefillWay, b: PlainRefillWay): boolean =>
	a.root.kind === b.root.kind &&
	a.root.relation === b.root.relation &&
	familyKey(a.hop.id) === familyKey(b.hop.id)

/**
 * The way one path of a refill's closure rides in the call's flight, or none where the family planner refills on the
 * host: a put of a plain relation whose change cascades along one owner axis into a counted or ordered family's member,
 * read there by its fold, predecessor or last axis; an edit of a family member relation that redraws a column of its
 * rows a counted or ordered family it owns copies into its members, read there as that copy; or an append to a counted
 * or ordered family of a mutable owner, whose recount changes a count or an end the family's stored members copy. Each
 * reaches a member relation the stratum does not put or delete.
 */
const flightWay = (
	path: RefillPath,
	managed: (relation: string) => boolean,
	edited: ReadonlySet<string>
): PlainRefillWay | undefined => {
	const { change, changed, reader } = path
	const [hop, ...further] = path.copies
	if (
		change.kind !== "write" ||
		reader.family.members.kind === "tree" ||
		edited.has(reader.family.member.name)
	) {
		return undefined
	}
	if (!managed(change.relation.name)) {
		return change.op === "put" &&
			hop !== undefined &&
			!isNonEmpty(further) &&
			(reader.kind === "fold" || reader.kind === "predecessor" || reader.kind === "last") &&
			hop.family.member.name === reader.family.member.name
			? { root: { kind: "put", relation: change.relation.name }, hop: hop.family }
			: undefined
	}
	if (change.op === "insert") {
		return hop === undefined &&
			changed.by === "owner" &&
			reader.kind === "owner" &&
			familyKey(changed.family.id) === familyKey(reader.family.id) &&
			reader.family.member.name === change.relation.name &&
			reader.family.owner.mutable
			? {
					root: { kind: "recount", relation: change.relation.name, family: reader.family },
					hop: reader.family
				}
			: undefined
	}
	return hop === undefined &&
		changed.by === "member" &&
		changed.relation.name === change.relation.name &&
		reader.kind === "owner" &&
		reader.family.owner.name === change.relation.name &&
		reader.family.member.name !== change.relation.name
		? {
				root: { kind: "edit", relation: change.relation.name, family: changed.family },
				hop: reader.family
			}
		: undefined
}

/**
 * Where a stratum's refills are drawn in the call's flight: every refilled family's ways from the stratum's puts of
 * relations no family has as a member (`managed`), by member relation, when every path of its closure is one, a put's
 * change cascading along one owner axis into a counted or ordered family's member and read there by its fold,
 * predecessor or last axis, and no refilled member is one the stratum edits; none otherwise, where the family planner
 * refills on the host.
 */
export const plainRefills = (
	refill: StratumRefill,
	managed: (relation: string) => boolean,
	edited: ReadonlySet<string>
): ReadonlyMap<string, ReadonlyArray<PlainRefill>> | undefined => {
	const byFamily = new Map<
		string,
		{ readonly family: Family; readonly ways: [PlainRefillWay, ...Array<PlainRefillWay>] }
	>()
	for (const path of refill.closure.paths) {
		const way = flightWay(path, managed, edited)
		if (way === undefined) {
			return undefined
		}
		const key = familyKey(path.reader.family.id)
		const known = byFamily.get(key)
		if (known === undefined) {
			byFamily.set(key, { family: path.reader.family, ways: [way] })
		} else if (!known.ways.some((w) => sameWay(w, way))) {
			known.ways.push(way)
		}
	}
	const out = new Map<string, Array<PlainRefill>>()
	for (const { family, ways } of byFamily.values()) {
		const list = out.get(family.member.name) ?? []
		list.push({ family, ways })
		out.set(family.member.name, list)
	}
	return out
}

/** A relation's family statement of kind `statement`, as the schedule names it. */
const rowsNode = (
	relation: string,
	statement: "delete" | "refill" | "update" | "insert"
): FamilyNode =>
	statement === "delete" || statement === "insert"
		? { kind: "rows", relation, statement }
		: { kind: "rows", relation, statement, changes: [] }

/** A family's count statement, as the schedule names it. */
const ownersNode = (family: Family): FamilyNode => ({
	kind: "owners",
	family: family.id,
	relation: family.owner.name,
	member: family.member.name,
	changes: []
})

/**
 * The order a stratum's refills require (schedule.ts RefillOrder), members first: each path's refill of its reader's
 * member relation runs ahead of the statement whose change would cascade into it, and a refill of the relation the
 * change is on carries that change, a recount, where a count statement would run.
 *
 * - A put of a relation no family has as a member is its plain put action, which the refill precedes; a family member's
 *   put is its relation's update in place or refill.
 * - An edit's or a refill's recount of an owner is its family's count statement, or the refill of the owner's rows
 *   that carries it; that refill runs after the family's members' deletions, refills and updates in place, the count
 *   falling only once every kept member below the new count holds a slot below it, and before their insertions where
 *   the family's owner axis is immediate (`immediate`), a new member carrying the new count.
 * - An edit's redraw of its members is their update in place or refill, and a refill's its members' refill.
 */
const refillOrder = (
	closure: Closure,
	managed: (relation: RelationInfo) => boolean,
	immediate: (family: Family) => boolean
): RefillOrder => {
	const precedes = new Map<string, RefillOrder["precedes"][number]>()
	const edges = new Map<string, RefillOrder["edges"][number]>()
	const edge = (first: FamilyNode, second: FamilyNode): void => {
		const key = (n: FamilyNode): string => {
			switch (n.kind) {
				case "owners":
					return `o:${familyKey(n.family)}`
				case "rows":
					return `${n.statement}:${n.relation}`
				case "additions":
					return `additions:${n.member}`
				case "removals":
					return `removals:${n.member}`
			}
		}
		edges.set(`${key(first)}\u0000${key(second)}`, { before: first, after: second })
	}
	for (const path of closure.paths) {
		const reader = path.reader.family.member.name
		const refill = rowsNode(reader, "refill")
		const changed = path.changed
		const at = changed.relation.name
		if (changed.by === "put") {
			if (!managed(changed.relation)) {
				precedes.set(`${reader}\u0000${at}`, { node: refill, relation: at })
				continue
			}
			edge(refill, rowsNode(at, "update"))
			if (at !== reader) {
				edge(refill, rowsNode(at, "refill"))
			}
			continue
		}
		const family = changed.family
		if (changed.by === "member") {
			if (at !== reader) {
				edge(refill, rowsNode(at, "update"))
				edge(refill, rowsNode(at, "refill"))
			}
			continue
		}
		if (at !== reader) {
			edge(refill, ownersNode(family))
			edge(refill, rowsNode(at, "refill"))
			continue
		}
		const members = family.member.name
		edge(rowsNode(members, "delete"), refill)
		edge(rowsNode(members, "update"), refill)
		if (members !== reader) {
			edge(rowsNode(members, "refill"), refill)
		}
		if (immediate(family)) {
			edge(refill, rowsNode(members, "insert"))
		}
	}
	return { precedes: [...precedes.values()], edges: [...edges.values()] }
}

/** The changed rows a change's column is on, by every chain that reaches them. */
const changedRows = (
	way: { readonly change: Change; readonly changed: Changed },
	groupsOf: (family: Family) => ReadonlyArray<GroupsOf>,
	putOf: (relation: RelationInfo) => RowsOf
): ReadonlyArray<RowsOf> => {
	const changed = way.changed
	if (changed.by === "put") {
		return [putOf(changed.relation)]
	}
	const from: ReadonlyArray<GroupsOf> =
		way.change.kind === "write"
			? [{ kind: "touched", family: changed.family }]
			: groupsOf(changed.family)
	return from.map((g): RowsOf => ({
		kind: changed.by === "owner" ? "owners" : "members",
		family: changed.family,
		from: g
	}))
}

/** Rows carried along `copies` by cascade. */
const cascaded = (rows: RowsOf, copies: ReadonlyArray<{ readonly family: Family }>): RowsOf =>
	copies.reduce(
		(from: RowsOf, hop): RowsOf => ({ kind: "cascade", family: hop.family, from }),
		rows
	)

/** Every relation whose rows a read's chain passes, the rows it reads. */
const readRelations = (read: RefillRead): ReadonlyArray<RelationInfo> => {
	const ofRows = (rows: RowsOf): ReadonlyArray<RelationInfo> => {
		switch (rows.kind) {
			case "put":
				return [rows.relation]
			case "cascade":
				return [...ofRows(rows.from), rows.family.member]
			case "owners":
			case "members":
				return [...ofGroups(rows.from), rowsRelation(rows)]
		}
	}
	const ofGroups = (groups: GroupsOf): ReadonlyArray<RelationInfo> =>
		groups.kind === "touched" ? [] : ofRows(groups.from)
	return read.kind === "rows" ? ofRows(read.rows) : ofGroups(read.groups)
}

/**
 * A stratum's refills over the schema's `families`, from its `writes`, or the refusal of one grizzle cannot draw:
 * - a value a put changes whose rows a query states (StaleDerivedRead, `query`), and a member's copy that a change of
 *   such a put reaches by cascade before a write of the stratum draws it (CascadedCopyAppend) or a refill rewrites it;
 * - a refill of an immutable relation's rows (StaleDerivedRead, `immutable`);
 * - refills that reach a family they refill again (StaleDerivedRead, `cycle`);
 * - a refill a role does not hold the rows of whole (OutsideRole): the members it rewrites, which its write list names,
 *   and every row its reads pass, which it holds.
 *
 * `edited` names the relations a write of the stratum edits as a family's members, whose owners' copies a cascade
 * reaches too; `immediate`, the families whose owner axis is immediate.
 */
export const stratumRefill = (
	families: ReadonlyArray<Family>,
	writes: ReadonlyArray<StratumWrite>,
	edited: ReadonlySet<string>,
	holds: RefillHolds,
	immediate: (family: Family) => boolean
): Result.Result<StratumRefill | undefined, CompileError> => {
	const changes = writes.map((w) => w.change)
	const closure = closureOf(families, changes, replacedBy(families, changes))
	if (!isNonEmpty(writes)) {
		return Result.ok(undefined)
	}
	/** The write a change of the closure starts from: its own, or the one whose path first reached the refill. */
	const writeOf = (change: Change): StratumWrite =>
		defined(
			writes.find((w) => w.change === originOf(change)),
			"the stratum's write a change of its closure starts from"
		)
	const queried = (change: Change): boolean => writeOf(change).rows.kind === "query"
	const stale = (
		path: {
			readonly change: Change
			readonly changed: Changed
			readonly copies: ReadonlyArray<Hop>
		},
		reader: RefillPath["reader"],
		cause: StaleCause
	): CompileError => {
		const write = writeOf(path.change)
		return CompileError.make({
			_tag: "StaleDerivedRead",
			at: write.loc,
			op: write.change.op,
			member: write.change.relation.name,
			changed: {
				relation: path.changed.relation.name,
				column: columnName(path.changed.column),
				by: path.changed.by
			},
			copies: path.copies.map((hop) => ({
				relation: hop.family.member.name,
				column: columnName(hop.pair.from)
			})),
			reader: derivedReader(reader),
			cause
		})
	}
	const queriedPath = closure.paths.find((p) => p.changed.by === "put" && queried(p.change))
	if (queriedPath !== undefined) {
		return Result.err(stale(queriedPath, queriedPath.reader, { kind: "query" }))
	}
	const readerOf = (l: Family): RefillPath =>
		defined(
			closure.paths.find((p) => familyKey(p.reader.family.id) === familyKey(l.id)),
			"a refilled family is a path's reader"
		)
	const fixed = closure.refills.find((l) => !refillable(l))
	if (fixed !== undefined) {
		const path = readerOf(fixed)
		return Result.err(
			stale(path, path.reader, {
				kind: "immutable",
				relation: fixed.member.mutable ? fixed.owner.name : fixed.member.name
			})
		)
	}
	if (closure.cycle !== undefined) {
		return Result.err(
			stale(closure.cycle.path, closure.cycle.path.reader, {
				kind: "cycle",
				refills: mapNonEmpty(closure.cycle.refills, (f) => ({
					owner: f.id.owner,
					count: f.id.count
				}))
			})
		)
	}
	const refilled = new Set(closure.refills.map((l) => l.member.name))
	/** Whether a cascade's way reaches rows the host draws: a refilled relation's, or an edited relation's through an
	 * owner whose copied column a cascade changes, which the edit's copies read before PostgreSQL's cascade reaches it. */
	const reaches = (way: Carried): boolean =>
		refilled.has(way.hop.family.member.name) ||
		(edited.has(way.hop.family.member.name) && way.copies.length > 0)
	const queriedWay = closure.carried.find(
		(way) => way.changed.by === "put" && queried(way.change) && reaches(way)
	)
	if (queriedWay !== undefined) {
		const member = queriedWay.hop.family.member
		const appending = writes.find((w) => w.change.relation.name === member.name)
		if (appending === undefined) {
			const l = defined(
				closure.refills.find((f) => f.member.name === member.name),
				"a refilled relation's family"
			)
			return Result.err(
				stale(
					{ ...queriedWay, copies: [...queriedWay.copies, queriedWay.hop] },
					readerOf(l).reader,
					{ kind: "query" }
				)
			)
		}
		const copy = queriedWay.hop.pair
		return Result.err(
			CompileError.make({
				_tag: "CascadedCopyAppend",
				at: appending.loc,
				op: appending.change.op,
				member: member.name,
				family: { owner: queriedWay.hop.family.id.owner, count: queriedWay.hop.family.id.count },
				copy: columnName(copy.from),
				owner: queriedWay.hop.family.owner.name,
				through: columnName(copy.to),
				changed: queriedWay.changed.relation.name
			})
		)
	}
	if (closure.paths.length === 0 && !closure.carried.some(reaches)) {
		return Result.ok(undefined)
	}
	const putOf = (relation: RelationInfo): RowsOf => {
		for (const w of writes) {
			if (w.change.relation.name === relation.name && w.rows.kind === "slot") {
				return { kind: "put", relation, slot: w.rows.slot }
			}
		}
		throw defect(`the slot of the put of ${relation.name} a change starts from`)
	}
	const known = new Map<string, ReadonlyArray<GroupsOf>>()
	const groupsOf = (family: Family): ReadonlyArray<GroupsOf> => {
		const key = familyKey(family.id)
		const had = known.get(key)
		if (had !== undefined) {
			return had
		}
		known.set(key, [])
		const found = new Map<string, GroupsOf>()
		for (const path of closure.paths) {
			if (familyKey(path.reader.family.id) !== key) {
				continue
			}
			const copies = path.reader.kind === "owner" ? [...path.copies, { family }] : path.copies
			for (const rows of changedRows(path, groupsOf, putOf)) {
				const groups: GroupsOf = { kind: "groups", family, from: cascaded(rows, copies) }
				found.set(groupsKey(groups), groups)
			}
		}
		const out = [...found.values()]
		known.set(key, out)
		return out
	}
	const reads = new Map<string, RefillRead>()
	/** The change each read follows, by the read's key: the first path's to its family, or the cascade's way. */
	const readFrom = new Map<string, Change>()
	for (const l of closure.refills) {
		for (const groups of groupsOf(l)) {
			if (groups.kind !== "groups") {
				continue
			}
			const key = `g:${groupsKey(groups)}`
			reads.set(key, { kind: "groups", groups })
			if (!readFrom.has(key)) {
				readFrom.set(key, readerOf(l).change)
			}
		}
	}
	for (const way of closure.carried) {
		if (!reaches(way)) {
			continue
		}
		for (const rows of changedRows(way, groupsOf, putOf)) {
			const read: RefillRead = {
				kind: "rows",
				rows: cascaded(rows, way.copies),
				family: way.hop.family
			}
			const key = `r:${rowsKey(read.rows)}`
			reads.set(key, read)
			if (!readFrom.has(key)) {
				readFrom.set(key, way.change)
			}
		}
	}
	if (holds.kind === "role") {
		const refusal = (access: RoleAccess, at: SourceLoc): CompileError =>
			CompileError.make({ _tag: "OutsideRole", at, role: holds.role, access })
		for (const l of closure.refills) {
			if (!holds.writes(l.member.name)) {
				return Result.err(
					refusal({ kind: "write", relation: l.member.name }, writeOf(readerOf(l).change).loc)
				)
			}
		}
		for (const [key, read] of reads) {
			for (const relation of readRelations(read)) {
				if (!holds.reads(relation.name)) {
					return Result.err(
						refusal(
							{ kind: "read", relation: relation.name, base: holds.base },
							writeOf(defined(readFrom.get(key), "the change a read follows")).loc
						)
					)
				}
			}
		}
	}
	const managed = (relation: RelationInfo): boolean =>
		families.some((f) => f.member.name === relation.name)
	return Result.ok({
		closure,
		reads: [...reads.values()],
		relations: [...refilled],
		recounted: closure.refills.filter(
			(l) => !isTreeOf(l, l.member.name) && isNonEmpty(endColumns(l))
		),
		order: refillOrder(closure, managed, immediate)
	})
}
