/**
 * A stratum's refills as its family statements draw them (analysis/theory/refill.ts): the closure of the changes its
 * writes make on stored rows, refused where grizzle cannot draw a stale value again, and every way a change of the
 * stratum reaches a refilled family's members, which the statement of the write it starts from draws: a put of a plain
 * relation, read from its facts by its refilled members' removals statement, or an edit of a family's member relation,
 * whose own removals or additions statement the refilled members ride (write/family/removals.ts, additions.ts).
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	type Carried,
	type Change,
	type Changed,
	closureOf,
	replacedBy,
	derivedReader,
	type Hop,
	originOf,
	type RefillPath,
	refillable,
	type WriteChange
} from "#compiler/analysis/theory/refill.ts"
import type { StaleCause } from "#compiler/core/causes.ts"
import { CompileError, type RoleAccess } from "#compiler/core/errors.ts"
import type { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { Family } from "#compiler/ir/family.ts"
import { appendStartOf, type FillOrder } from "#compiler/ir/fill.ts"
import { columnKey, familyKey, type RelationInfo } from "#compiler/ir/law.ts"

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
 * A stratum's refills: the families it draws again, each after every refill whose change reaches it (Closure
 * `refills`), and each member relation a refill rewrites, with its refilled families and the ways the stratum's changes
 * reach their members. No family where the stratum's changes only cascade into a member's copy that a write of the
 * stratum draws.
 */
export interface StratumRefill {
	readonly families: ReadonlyArray<Family>
	readonly members: ReadonlyMap<StoredRelationName, NonEmptyReadonlyArray<PlainRefill>>
}

/**
 * Where a refill starts (write/family/removals.ts RefillWay): a put of a plain relation, whose facts state its changed
 * rows; an edit of a family's member relation, whose own removals statement redraws its changed rows by `family`; or
 * an append to `family`, whose additions statement recounts the owners whose count and ends its stored members copy,
 * an UPDATE the owner axis cascades into them (write/family/additions.ts recountOf), and draws the family's groups
 * whole where a value the family draws reads such a copy (ir/fill.ts AppendStart `whole`).
 */
export type RefillStart =
	| { readonly kind: "put"; readonly relation: StoredRelationName }
	| { readonly kind: "edit"; readonly relation: StoredRelationName; readonly family: Family }
	| { readonly kind: "recount"; readonly relation: StoredRelationName; readonly family: Family }

/**
 * A way a change of the stratum reaches a refilled family's members: where it starts, and the families whose owner axes
 * carry its change on, in order from the change, the last into the refilled family's member: one for an edit's and a
 * recount's way, one or more for a put's.
 */
export interface PlainRefillWay {
	readonly root: RefillStart
	readonly hops: NonEmptyReadonlyArray<Family>
}

/** A refilled family of one member relation, and the ways the stratum's changes reach its members. */
export interface PlainRefill {
	readonly family: Family
	readonly ways: NonEmptyReadonlyArray<PlainRefillWay>
}

/** Whether two ways start at one change and ride the same families' owner axes in the same order. */
const sameWay = (a: PlainRefillWay, b: PlainRefillWay): boolean =>
	a.root.kind === b.root.kind &&
	a.root.relation === b.root.relation &&
	a.hops.length === b.hops.length &&
	a.hops.every((hop, i) => {
		const other = b.hops[i]
		return other !== undefined && familyKey(hop.id) === familyKey(other.id)
	})

/**
 * The way a path that starts at a family member relation's write rides in the write's statements: an edit of the
 * relation that redraws a column of its rows a counted or ordered family it owns copies into its members, read there as
 * that copy, the rider of the edit's removals statement; or an append to a counted or ordered family of a mutable owner,
 * whose recount changes a count or an end the family's stored members copy, or a value the family draws over such a
 * copy along its own owner axis, which its appends draw whole (ir/fill.ts AppendStart, by `fill`). None for any other
 * path of a member's write, which grizzle refuses (StaleDerivedRead, `edit`).
 */
const memberWay = (
	fill: FillOrder,
	change: WriteChange,
	path: RefillPath
): PlainRefillWay | undefined => {
	const { changed, reader } = path
	const [hop, ...further] = path.copies
	if (change.op === "insert") {
		const f = reader.family
		const recount: PlainRefillWay = {
			root: { kind: "recount", relation: change.relation.name, family: f },
			hops: [f]
		}
		if (
			changed.by !== "owner" ||
			familyKey(changed.family.id) !== familyKey(f.id) ||
			f.member.name !== change.relation.name ||
			!f.owner.mutable
		) {
			return undefined
		}
		if (hop === undefined) {
			return reader.kind === "owner" ? recount : undefined
		}
		return further.length === 0 &&
			familyKey(hop.family.id) === familyKey(f.id) &&
			reader.kind !== "owner" &&
			appendStartOf(fill, f.member.name, f).kind === "whole"
			? recount
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
				hops: [reader.family]
			}
		: undefined
}

/**
 * A stratum's refills over the schema's `families`, from its `writes`, or the refusal of one grizzle cannot draw:
 * - a value a put changes whose rows a query states (StaleDerivedRead, `query`), and a member's copy that a change of
 *   such a put reaches by cascade before a write of the stratum draws it (CascadedCopyAppend) or a refill rewrites it;
 * - a refill of an immutable relation's rows (StaleDerivedRead, `immutable`);
 * - refills that reach a family they refill again (StaleDerivedRead, `cycle`);
 * - a refill of a tree's values, which grizzle draws only when a node is written (StaleDerivedRead, `tree`);
 * - a refill of a value that reads what another refill itself changes (StaleDerivedRead, `chained`);
 * - a family member's put or delete whose change reaches another family's value through an owner axis, but the copies
 *   a re-placed owner's members hold, and an edit's or an append's recount of an owner that a value other than its own
 *   family's members' copies reads, or its own family's values over those copies where its appends do not draw it whole
 *   (StaleDerivedRead, `edit`);
 * - a refill a role does not hold the rows of whole (OutsideRole): the members it rewrites, which its write list names,
 *   and every row its changes' cascades pass, which it holds;
 * - a way no statement of the stratum draws: a plain relation's put whose cascade passes the rows of a member the
 *   stratum puts or deletes before it reaches the refilled family (StaleDerivedRead, `passed`); a member's write whose
 *   refilled member the stratum puts or deletes too (StaleDerivedRead, `rewritten`); and a member refilled from the
 *   edits of two relations (StaleDerivedRead, `edits`).
 *
 * `edited` names the relations a write of the stratum edits as a family's members, whose owners' copies a cascade
 * reaches too; `fill` is the schema's fill order, by which an append draws its family's groups (ir/fill.ts AppendStart).
 */
export const stratumRefill = (
	fill: FillOrder,
	families: ReadonlyArray<Family>,
	writes: ReadonlyArray<StratumWrite>,
	edited: ReadonlySet<string>,
	holds: RefillHolds
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
				column: columnKey(path.changed.column),
				by: path.changed.by
			},
			copies: path.copies.map((hop) => ({
				relation: hop.family.member.name,
				column: columnKey(hop.pair.from)
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
	const treePath = closure.paths.find((p) => p.reader.family.shape.kind === "tree")
	if (treePath !== undefined) {
		const tree = treePath.reader.family.id
		return Result.err(
			stale(treePath, treePath.reader, {
				kind: "tree",
				tree: { owner: tree.owner, count: tree.count }
			})
		)
	}
	/** Every path, each starting at a write of the stratum: one that starts at a refill is refused (`chained`). */
	const paths: Array<RefillPath & { readonly change: WriteChange }> = []
	for (const p of closure.paths) {
		const change = p.change
		if (change.kind === "refill") {
			return Result.err(
				stale(p, p.reader, {
					kind: "chained",
					refill: { owner: change.family.id.owner, count: change.family.id.count }
				})
			)
		}
		paths.push({ ...p, change })
	}
	const managed = (relation: RelationInfo): boolean =>
		families.some((f) => f.member.name === relation.name)
	/** Each path with the way its write's statement draws it: a member's write's `memberWay`, which refuses any other
	 * (`edit`); a plain relation's put's, through the owner axes of the path's hops (RefillPath `hops`). A plain relation
	 * is no family's member, so only its put changes a stored row, and it reaches its readers' rows through one hop at
	 * least, the last into the reader's family's member, whichever reader it is: a fold, a predecessor or last copy, or a
	 * re-placed member's copy of its owner's column, which its own family's axis carries. */
	const ways: Array<{ readonly path: (typeof paths)[number]; readonly way: PlainRefillWay }> = []
	for (const path of paths) {
		const { change, hops } = path
		if (managed(change.relation)) {
			const way = memberWay(fill, change, path)
			if (way === undefined) {
				const reached = path.reader.family.id
				return Result.err(
					stale(path, path.reader, {
						kind: "edit",
						family: { owner: reached.owner, count: reached.count }
					})
				)
			}
			ways.push({ path, way })
			continue
		}
		if (change.op !== "put" || !isNonEmpty(hops)) {
			defect(
				`a ${change.op} of ${change.relation.name}, a plain relation, reaching a family's value: only its put changes a stored row, along an owner axis of a family it owns`
			)
		}
		ways.push({ path, way: { root: { kind: "put", relation: change.relation.name }, hops } })
	}
	const refilled = new Set(closure.refills.map((l) => l.member.name))
	/** Whether a cascade's way reaches rows a refill rewrites, or an edited relation's through an owner whose copied
	 * column a cascade changes, which the edit's copies read. */
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
				copy: columnKey(copy.from),
				owner: queriedWay.hop.family.owner.name,
				through: columnKey(copy.to),
				changed: queriedWay.changed.relation.name
			})
		)
	}
	const reaching = closure.carried.filter(reaches)
	if (closure.paths.length === 0 && !isNonEmpty(reaching)) {
		return Result.ok(undefined)
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
		/** Every relation a change's cascade passes, with the change it is attributed to: each refilled family's, from
		 * the first path to it, the changed relation and every hop's member; then each cascade's way into an edited or
		 * refilled member's copy, the changed relation and every copy's member before it. */
		const passed = [
			...closure.refills.flatMap((l) => {
				const from = readerOf(l).change
				return paths.flatMap((p) =>
					familyKey(p.reader.family.id) === familyKey(l.id)
						? [p.changed.relation, ...p.hops.map((h) => h.member)].map((relation) => ({
								relation,
								from
							}))
						: []
				)
			}),
			...reaching.flatMap((way) =>
				[way.changed.relation, ...way.copies.map((h) => h.family.member)].map((relation) => ({
					relation,
					from: way.change
				}))
			)
		]
		const unheld = passed.find(({ relation }) => !holds.reads(relation.name))
		if (unheld !== undefined) {
			return Result.err(
				refusal(
					{ kind: "read", relation: unheld.relation.name, base: holds.base },
					writeOf(unheld.from).loc
				)
			)
		}
	}
	/** The member relations the stratum puts or deletes, whose removals statements redraw their rows. */
	const removed = new Set(
		writes.flatMap((w) =>
			w.change.op !== "insert" && edited.has(w.change.relation.name) ? [w.change.relation.name] : []
		)
	)
	for (const { path, way } of ways) {
		const passes =
			way.root.kind === "put"
				? way.hops.slice(0, -1).find((h) => removed.has(h.member.name))
				: undefined
		if (passes !== undefined) {
			return Result.err(stale(path, path.reader, { kind: "passed", relation: passes.member.name }))
		}
		const member = path.reader.family.member.name
		if (way.root.kind !== "put" && removed.has(member)) {
			return Result.err(stale(path, path.reader, { kind: "rewritten", relation: member }))
		}
	}
	const byFamily = new Map<
		string,
		{ readonly family: Family; readonly ways: [PlainRefillWay, ...Array<PlainRefillWay>] }
	>()
	for (const { path, way } of ways) {
		const key = familyKey(path.reader.family.id)
		const known = byFamily.get(key)
		if (known === undefined) {
			byFamily.set(key, { family: path.reader.family, ways: [way] })
		} else if (!known.ways.some((w) => sameWay(w, way))) {
			known.ways.push(way)
		}
	}
	const members = new Map<StoredRelationName, [PlainRefill, ...Array<PlainRefill>]>()
	for (const { family, ways: familyWays } of byFamily.values()) {
		const known = members.get(family.member.name)
		if (known === undefined) {
			members.set(family.member.name, [{ family, ways: familyWays }])
		} else {
			known.push({ family, ways: familyWays })
		}
	}
	for (const [member, refills] of members) {
		const [first, ...others] = [
			...new Set(
				refills.flatMap((r) =>
					r.ways.flatMap((w) => (w.root.kind === "edit" ? [w.root.relation] : []))
				)
			)
		]
		const second = others[0]
		if (first !== undefined && second !== undefined) {
			const at = defined(
				ways.find(
					({ path, way }) =>
						path.reader.family.member.name === member &&
						way.root.kind === "edit" &&
						way.root.relation === second
				),
				"the way of the second edit that reaches a refilled member"
			)
			return Result.err(
				stale(at.path, at.path.reader, { kind: "edits", relations: [first, second] })
			)
		}
	}
	return Result.ok({ families: closure.refills, members })
}
