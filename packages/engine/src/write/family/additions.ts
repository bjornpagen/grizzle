/**
 * A stratum's family additions as one statement: every member its edits append, inserted with the values its families
 * draw, and every owner those appends recount, computed by PostgreSQL from the groups as the statement finds them, so
 * the write reads nothing back to the host and goes in the call's one flight.
 *
 * For each member relation the stratum appends to, its appended rows are those of each of its sources (`RowSource`) no
 * stored row repeats exactly (rule 0: no change): its insert and put slots' facts, and the rows its stratum's nested
 * writes fill, which the host's walk drew every sequence column of (write/family/nesting.ts). Each of its families draws
 * the rows of the sources it draws, every family its slots' and a counted family its nested rows', a union where it
 * draws both:
 *
 * - the groups they join, each with its kept count, the slots past its stored members, `max(index) + 1`, which the
 *   group's (group, index) key reads in one probe: a group's members hold its slots 0 … n − 1 at every statement of a
 *   write, its removals' statement (write/family/removals.ts) leaving them dense again;
 * - each group's seed, its stored member at the kept count's slot less one, which the first appended member's
 *   predecessor copies and accumulators continue;
 * - the appended members at the kept count's slots on, in key order (a counted family's order is hidden), each with
 *   its group's new count and its owner's columns: a stored owner's, else those of the owner a nested write of the
 *   stratum inserts in this statement, else the copy's base, so its insert meets the family's owner axis at the
 *   statement's end, as a member naming no owner does;
 * - its scan (write/family/scan.ts), which draws each appended member's index, copy of the count, owner copies,
 *   predecessor copies and fold planes in slot order.
 *
 * A counted family of a mutable owner whose drawn values read a settled copy, a copy along its own owner axis of an
 * owner column its own fill writes, its count or a generated field over it (ir/fill.ts AppendStart `whole`), draws each
 * group its scan draws whole instead: an append changes that copy on every member, so the scan runs from slot 0 over
 * the group's stored members, at their own slots, and its appended rows after them, each copy at the group's new count
 * as the host's fill draws a fresh group, and the statement updates the stored members in place at every column the
 * family draws beside inserting the appended ones (`wholeRows`, `redrawnUpdate`). Its owner's recount reads the scan's
 * last member as any other's, and the owner axis's cascade finds every member already holding the new values.
 *
 * A counted family's fresh groups are no scan's: a group whose owner the stratum inserts and which holds no stored
 * member, its kept count 0, is the call's whole, which the host drew, its owner's counts and ends and every member's
 * columns (runtime/write/bind.ts freshOwners), and the statement takes the host's members of it in the scan's place
 * (`HostDrawn`), so each group is drawn by one engine. Whether the host drew a group is read beside its kept count with no
 * join, and an exact repeat of a stored owner whose group holds stored members is the scan's, past them. A closed
 * owner's family takes no member once inserted, and its groups' kept counts are never read: a closed owner the stratum
 * restates, met stored, holds a member at each slot the host drew, and the member's insert, arbitrating every object,
 * meets its new member there, a met row no stored row holds the key of, which the statement refuses on the family's
 * rule alone, witnessed by the member's key (`metRefusal`), in the call's one flight.
 *
 * The appended rows are inserted whole, each with every family's columns. Each mutable owner they join, and each the
 * stratum puts whose groups its edits touch, whose recount the removals leave to this statement after the put, is
 * recounted by one UPDATE of its relation, where its count or an end changes: each family's count, and each end from
 * its last member, which the owner axis cascades into its stored members at the statement's end; a stratum that
 * appends nothing still writes this statement for those puts. An owner the stratum inserts
 * carries its counts and ends in its own insert, which its appends meet (runtime/write/bind.ts freshOwners), and an immutable
 * owner's family is fixed when it is inserted, so no role holds UPDATE on it and this statement writes none.
 * Immediate foreign keys are checked at the statement's end, so a member and its owner's new count are judged together.
 *
 * The statement returns each recounted owner's count and ends after and before, and then the facts it inserted, each
 * part's rows behind its tag, which the outcome reads as a family statement's. PostgreSQL runs a data-modifying CTE as
 * the statement reads its rows, so every recount runs before any insert: a write appending to a stored group writes its
 * owner's row first, and of two writes appending to one group at once the later meets that row and fails with 40001,
 * never at the (group, index) key both drew from their snapshots.
 */
import { appendAll, firstIndex } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	concatNonEmpty,
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { withGenerationInputs } from "#compiler/analysis/theory/fill.ts"
import { contractLawIdentity } from "#compiler/analysis/theory/theory.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { operatorSchemaOf, typedEq } from "#compiler/ir/compare.ts"
import { baseLiteral, type Family, isSequence } from "#compiler/ir/family.ts"
import type { AppendStart, FillColumn } from "#compiler/ir/fill.ts"
import {
	type Computed,
	type Head,
	headStamped,
	headText,
	type Stamped,
	stampAt
} from "#compiler/ir/instant.ts"
import {
	familyKey,
	type LawField,
	type NativeColumn,
	type RelationInfo,
	type ColumnKey,
	columnKey,
	columnKeyOf
} from "#compiler/ir/law.ts"
import { type FilledRows, walkedRows } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import {
	arraysSource,
	relationColumns,
	unchecked,
	WriteParams
} from "#compiler/lower/conservative/context.ts"
import { lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import type { LaidLayout } from "#compiler/runtime/write/nesting.ts"
import { drawnNarrowing } from "#compiler/scalar/natural.ts"
import type {
	Assignment,
	Cte,
	Expr,
	FromItem,
	JoinStep,
	Select,
	SetArm,
	Target
} from "#compiler/sql/ast.ts"
import {
	and,
	arrays,
	asc,
	binary,
	call,
	cast,
	col,
	conjunction,
	core,
	cte,
	cteRef,
	cteRefAs,
	derived,
	distinctCore,
	eq,
	exists,
	firstNonNull,
	join,
	le,
	lit,
	ne,
	not,
	notExists,
	operandSelect,
	operandUnionAll,
	or,
	provedCore,
	qualifiedCall,
	select,
	simpleSelect,
	target,
	targetAs,
	types,
	unionAll,
	windowOf
} from "#compiler/sql/build.ts"
import { assignments } from "#compiler/sql/generation.ts"
import { namedBody, namedQuery, NameSupply } from "#compiler/sql/naming.ts"
import {
	type Deferring,
	type DrawIn,
	type EditedMember,
	riderWrites
} from "#compiler/write/family/removals.ts"
import {
	type GroupState,
	type PerGroup,
	type Read,
	readAt,
	type ScanRows,
	type Scanned,
	scannedValue,
	type Shaped
} from "#compiler/write/family/scan.ts"
import {
	candidateGate,
	endColumns,
	type Arbiter,
	type LaidRows,
	type RowColumn,
	type RowLayout
} from "#compiler/write/family/statements.ts"
import {
	columnAt,
	drawnScan,
	countOver,
	type FamilyWriteSql,
	insertedResult,
	installed,
	internal,
	one,
	type OwnerReads,
	ownerReadsOf,
	type FamilyReturning,
	rowNumber,
	sameGroupExprs,
	shapedCte,
	type SlotReader,
	slotReader,
	recountUpdate,
	taggedRows,
	updatedResult,
	updateReturning,
	written
} from "#compiler/write/family/written.ts"
import type { MemberSlot } from "#compiler/write/frontend/compile.ts"
import type { CopySource, OwnerCopy } from "#compiler/write/frontend/schedule.ts"
import {
	type CallValues,
	callColumn,
	callValuesCte,
	callValuesNames,
	type HeadStamps,
	headStampsCte,
	headStampsNames
} from "#compiler/write/insert/stamp.ts"
import {
	returnedColumn,
	rowType,
	startOf,
	type WriteContext
} from "#compiler/write/insert/statement.ts"
import type { RelationUniques } from "#compiler/write/insert/unique.ts"
import {
	atFields,
	bound,
	type Equal,
	type MetAccess,
	metFound,
	metRowsOf,
	type HeldKey,
	keyedAmong,
	probeGroup,
	probeKey,
	storedAt
} from "#compiler/write/probe.ts"
import { raised, refusalGuard, refusalRank, refusalRef } from "#compiler/write/refusal.ts"

/**
 * Where a member relation's appended rows come from:
 * - its slots: its insert slot, whose facts no stored row repeats exactly are appended, and its put slot, whose facts
 *   at no key a row stores are appended, a new member or one the stratum's removals deleted from its old groups
 *   (write/family/removals.ts); every family draws them;
 * - the rows a nested write of its stratum fills (write/family/nesting.ts), every column of its row layout but those
 *   its counted families fill after the walk (`sentLayout`), those no stored row repeats at every field the walk fills
 *   (`walked`), which they state: a nested owner's counts and ends of its counted families are drawn as its stratum's
 *   appends to it would leave a fresh owner (runtime/write/bind.ts freshOwners), and where it is stored, they are its
 *   stored group's, which its counted families' appends recount. Its counted families draw them, and the walk drew its
 *   sequences'.
 */
export type RowSource =
	| {
			readonly kind: "slots"
			readonly slots: NonEmptyReadonlyArray<{
				readonly as: "inserts" | "puts"
				readonly slot: MemberSlot
				/** The fields its facts leave out that this statement stamps: a stamped nesting's root's (write/family/
				 * nesting.ts Nesting `stamps`), none for any other slot. */
				readonly stamps: ReadonlyArray<Stamped>
			}>
	  }
	| {
			readonly kind: "nestedRows"
			readonly stratum: StratumAt
			/** The columns its rows hold, their sent layout's (runtime/write/nesting.ts sentLayout) and those this statement
			 * stamps, in their layout's order. */
			readonly layout: RowLayout
			readonly walked: ReadonlySet<ColumnKey>
			/** The fields its rows leave out that this statement stamps (write/family/nesting.ts Nesting `stamps`). */
			readonly stamps: ReadonlyArray<Stamped>
	  }

/** Whether the rows of `source` state the column `key`, at which an appended row repeats a stored one: a slot's stated
 * fields (insert/input.ts RelationInput), and a nested row's every column the walk fills, and the fields the call
 * computes for either; never a column a counted family draws, which its stored group holds. */
const statesColumn = (source: RowSource, key: ColumnKey): boolean =>
	source.kind === "slots"
		? source.slots.some(
				({ slot, stamps }) =>
					slot.input.stated.some((c) => columnKeyOf(c.name) === key) || computes(stamps, key)
			)
		: source.walked.has(key) || computes(source.stamps, key)

/** Whether `stamps` fill the column `key` with the call's value, a computed field, which the call states as its host
 * rows state their fields, one value for all of them (ir/instant.ts Stamp `call`). */
const computes = (stamps: ReadonlyArray<Stamped>, key: ColumnKey): boolean =>
	stamps.some((st) => st.stamp.kind === "call" && columnKeyOf(st.field.name) === key)

/** A source of the rows of an owner relation the stratum inserts that an additions statement reads an owner copy from
 * (schedule.ts CopySource `held`): one of its slots' stated facts, or the stratum's nested rows of it. */
export type OwnerRows =
	| { readonly kind: "slot"; readonly slot: MemberSlot }
	| Extract<RowSource, { readonly kind: "nestedRows" }>

/**
 * How a family's fresh groups reach its additions statement. A group is fresh where the stratum inserts its owner and
 * stores none of its members: the call holds it whole, so the host's fresh fill draws it, its owner and its members
 * (runtime/write/bind.ts freshOwners), and the statement inserts its members as drawn, where the family's scan draws
 * every group holding a stored member, each group by one engine of one rule (ir/fill.ts FillColumn).
 * - `none`: a sequence, whose members the nested walk draws and its own statement sends;
 * - `drawn`: a counted family, its fresh groups' members in their fresh layout (write/program/decide.ts freshLayoutOf),
 *   the stratum's (ir/products.ts FilledRows `fresh`), and the stamps of the key and group fields that layout leaves
 *   out, the call's one value of each, which the statement fills the host's members with as it fills its own rows
 *   (write/frontend/compile.ts FreshFill `stamps`, `stampedSources`).
 */
export type FreshGroups =
	| { readonly kind: "none" }
	| {
			readonly kind: "drawn"
			readonly stratum: StratumAt
			readonly layout: LaidLayout
			readonly stamps: ReadonlyArray<Stamped>
	  }

/** A member relation a stratum appends to, with where its rows come from and what draws them. */
export interface AppendedMember {
	readonly relation: RelationInfo
	/**
	 * Its unique objects (write/insert/unique.ts RelationUniques): its primary key, whose law a stored row at its key with
	 * other stated fields raises, and every other object its insert's probe checks.
	 */
	readonly uniques: RelationUniques
	/** Every column its rows are written with (statements.ts rowLayout). */
	readonly layout: RowLayout
	readonly sources: NonEmptyReadonlyArray<RowSource>
	/** Its families, each drawing the appended rows of the sources it draws (`RowSource`) by the columns its fill layout
	 * gives it at the member's position in the family, in fill order (ir/fill.ts FillLayout), each group that holds
	 * stored members from where its fill order starts it (ir/fill.ts AppendStart). */
	readonly families: ReadonlyArray<{
		readonly family: Family
		readonly drawn: ReadonlyArray<FillColumn>
		readonly start: AppendStart
		readonly fresh: FreshGroups
	}>
	/** The counted families it owns, in the law model's order, whose counts and ends its rows hold (`ownedColumns`). */
	readonly owns: ReadonlyArray<Family>
	/**
	 * The member relations whose rows an edit of it refills (FamilyAdditions `riders`), each drawn again from the rows
	 * this statement appends of it (write/family/removals.ts riderWrites): a stored row a put moves to another group is
	 * inserted again at its new slot, which no cascade follows, so its own members' copies of its columns follow it here.
	 */
	readonly riders: ReadonlyArray<EditedMember>
}

/**
 * A count or an end of one of a member relation's own counted families, as its row holds it: the owner's field, the
 * family, and the column of the family's members that holds the same value, every member's copy ‹n› of the count, and
 * the last member's column the family's last axis carries into the end.
 */
interface OwnedColumn {
	readonly field: LawField
	readonly family: Family
	readonly held: NativeColumn
}

/** Each count and end of `member`'s own counted families (`OwnedColumn`), by its field's key, the first family that holds
 * it in the law model's order. */
const ownedColumns = (member: AppendedMember): ReadonlyMap<ColumnKey, OwnedColumn> => {
	const owned = new Map<ColumnKey, OwnedColumn>()
	const claim = (field: LawField, family: Family, held: NativeColumn): void => {
		const key = columnKeyOf(field.name)
		owned.getOrInsertComputed(key, () => ({ field, family, held }))
	}
	for (const family of member.owns) {
		claim(family.count, family, { kind: "law", column: family.copy })
		for (const p of family.axes.last) {
			if (p.from.kind === "field" && p.from.field.writing.kind === "accumulated") {
				claim(p.from.field, family, p.to)
			}
		}
	}
	return owned
}

/** Whether `family` draws the appended rows of `source`: every family draws its slots', a counted one its nested rows'. */
const draws = (family: Family, source: RowSource): boolean =>
	source.kind === "slots" || !isSequence(family)

/** An owner relation the stratum puts, whose groups of `families`, each a family of a member the stratum edits, its
 * additions recount after the put, as the removals leave them (write/family/removals.ts). */
export interface PutOwner {
	readonly owner: RelationInfo
	readonly slot: MemberSlot
	readonly families: NonEmptyReadonlyArray<Family>
}

/** One source's appended rows of a member relation, drawn: its rows' CTE and the scan of each family that draws it. */
interface Drawn {
	readonly member: AppendedMember
	readonly source: RowSource
	readonly appended: Shaped
	readonly scans: ReadonlyArray<{ readonly family: Family; readonly scan: Scanned }>
}

/**
 * The family additions of a stratum (see the header): its appended members' inserts and its mutable owners' recounts,
 * as one statement of the write's flight.
 */
export const additionsSql = (
	w: WriteContext,
	members: ReadonlyArray<AppendedMember>,
	putOwners: ReadonlyArray<PutOwner>,
	ownerCopies: ReadonlyArray<OwnerCopy>,
	ownerRows: ReadonlyMap<string, NonEmptyReadonlyArray<OwnerRows>>,
	deferring: ReadonlyArray<Deferring>,
	relations: ReadonlyMap<string, RelationInfo>
): FamilyWriteSql => {
	const supply = new NameSupply(w.start)
	const params = new WriteParams()
	w.cx.beginWriteStatement(supply, params)
	const ctes: Array<Cte> = []
	const stated = slotReader(w, supply, ctes)
	/** Each relation's nested rows of the stratum, a CTE pushed at its first read and shared by every later one. */
	const nestedRead = new Map<string, Shaped>()
	const sent: NestedReader = (relation, source) => {
		const known = nestedRead.get(relation.name)
		if (known !== undefined) {
			return known
		}
		const rows = nestedRowsCte(w, supply, ctes, relation, sentOf(source))
		nestedRead.set(relation.name, rows)
		return rows
	}
	/** Every source's rows as the statement reads them, each source this statement stamps with its stamps beside them
	 * (`stampedSources`). */
	const { slots, nested, stamped } = stampedSources(w, supply, ctes, members, stated, sent)
	/** The rows of an owner relation the stratum inserts whose copied columns the parameters hold (schedule.ts
	 * CopySource `held`), each source as this statement reads it (schedule.ts HeldSource): a slot's facts or the
	 * stratum's nested rows, with the stamps it takes of them where it appends the owner (`stampedSources`). */
	const ownerShapes = (owner: string): ReadonlyArray<Shaped> =>
		defined(ownerRows.get(owner), `the rows of ${owner} a held copy reads`).map((rows) =>
			rows.kind === "slot"
				? slots(owner, rows.slot)
				: nested(defined(relations.get(owner), `the owner relation ${owner}`), rows)
		)
	/** Each member's scans, one per family, of the union of the sources the family draws. */
	const scanned: Array<{ readonly family: Family; readonly scan: Scanned }> = []
	/** The updates in place of the stored members of the groups a family's appends draw whole (ir/fill.ts AppendStart). */
	const redrawn: Array<FamilyReturning> = []
	const refusals: Array<Expr> = []
	const drawn = members.flatMap((member): ReadonlyArray<Drawn> => {
		const arbiter = memberArbiter(w, member)
		const sources = member.sources.map((source) => ({
			source,
			appended: appendedOf(w, supply, ctes, member, source, slots, nested, arbiter),
			scans: new Array<{ readonly family: Family; readonly scan: Scanned }>()
		}))
		/** Each source's rows with every column the families scanned so far drew. */
		const rows = new Map(sources.map((x) => [x, x.appended] as const))
		/** The member's sequence first, each family after reading the rows with every column the families before it
		 * drew: a counted family's fold may step or select the copy a sequence's owner axis gives the member. */
		const ordered = member.families.toSorted(
			(a, b) => Number(!isSequence(a.family)) - Number(!isSequence(b.family))
		)
		for (const { family, drawn: columns, start, fresh } of ordered) {
			const read = sources.filter((x) => draws(family, x.source))
			const [first, ...rest] = read
			if (first === undefined) {
				continue
			}
			const input = unionOf(
				supply,
				ctes,
				mapNonEmpty([first, ...rest], (x) => defined(rows.get(x), "a source's rows"))
			)
			const scan = appendScan(
				w,
				supply,
				ctes,
				member,
				family,
				columns,
				input,
				(column) =>
					defined(
						ownerCopies.find((c) => c.family === familyKey(family.id) && c.column === column),
						`where ${member.relation.name}'s owner copy ${column} reads its owner`
					).source,
				() => ownerShapes(family.owner.name),
				stamped,
				arbiter,
				start,
				fresh
			)
			scanned.push({ family, scan })
			if (start.kind === "whole") {
				redrawn.push(redrawnUpdate(w, supply, ctes, member, columns, scan))
			}
			for (const x of read) {
				x.scans.push({ family, scan })
				rows.set(
					x,
					withDrawn(w, supply, ctes, member, defined(rows.get(x), "a source's rows"), scan, columns)
				)
			}
		}
		return sources.map((x) => ({ member, source: x.source, appended: x.appended, scans: x.scans }))
	})
	const inserts = members.flatMap((member) => {
		const [first, ...rest] = drawn.filter((d) => d.member === member)
		if (first === undefined) {
			return []
		}
		const arbiter = memberArbiter(w, member)
		const candidates = mapNonEmpty([first, ...rest], (d) => ({
			d,
			rows: candidatesOf(
				w,
				supply,
				ctes,
				d,
				d.source.kind === "nestedRows"
					? scanned.filter(
							(x) => x.family.owner.name === member.relation.name && !isSequence(x.family)
						)
					: []
			)
		}))
		const gates = probeGates(
			w,
			supply,
			ctes,
			member,
			mapNonEmpty(candidates, (c) => c.rows),
			arbiter
		)
		return candidates.map(({ d, rows }) =>
			insertOf(w, supply, ctes, d, rows, gates, arbiter, refusals)
		)
	})
	/** Each mutable owner relation's recounted families, each with its appends' scan and the facts of its put, by owner
	 * name. */
	const owners = new Map<string, Map<Family, Recounted>>()
	const recountedOf = (family: Family): Recounted => {
		const byFamily = owners.getOrInsertComputed(
			family.owner.name,
			() => new Map<Family, Recounted>()
		)
		const known = byFamily.get(family)
		if (known !== undefined) {
			return known
		}
		const fresh: Recounted = { family, scans: [], puts: [] }
		byFamily.set(family, fresh)
		return fresh
	}
	for (const s of scanned) {
		if (s.family.owner.mutable) {
			recountedOf(s.family).scans.push(s.scan)
		}
	}
	for (const put of putOwners) {
		const facts = slots(put.owner.name, put.slot)
		for (const family of put.families) {
			recountedOf(family).puts.push(facts)
		}
	}
	const recounts: Array<FamilyReturning> = []
	for (const [ownerName, byFamily] of owners) {
		const [first, ...rest] = [...byFamily.values()]
		if (first !== undefined) {
			const owner = defined(relations.get(ownerName), `the owner relation ${ownerName}`)
			recounts.push(recountOf(w, supply, ctes, owner, [first, ...rest]))
		}
	}
	/** Each member's riders, drawn again from the rows its families' scans append, a moved row among them. */
	const riding = members.flatMap((member): ReadonlyArray<FamilyReturning> => {
		if (!isNonEmpty(member.riders)) {
			return []
		}
		const at: DrawIn = {
			w,
			supply,
			ctes,
			slots,
			deferred: deferring.map((d) => ({ ...d, facts: slots(d.relation, d.slot) }))
		}
		return riderWrites(
			at,
			member.riders,
			(relation, family) =>
				defined(
					scanned.find(
						(x) =>
							x.family.member.name === relation && familyKey(x.family.id) === familyKey(family.id)
					),
					`the appends of ${relation} a refill starts from`
				).scan,
			relations
		)
	})
	const [firstReturning, ...restReturnings] = [...recounts, ...inserts, ...redrawn, ...riding]
	if (firstReturning === undefined) {
		defect("a family additions statement appends or recounts a put owner")
	}
	return taggedRows(supply, ctes, [firstReturning, ...restReturnings], params, refusals, w.binding)
}

/**
 * What a member relation's appends arbitrate (statements.ts Arbiter): every object, each family's group drawn from
 * its base (scan.ts GroupState) and each row the insert meets classified in its statement (`insertOf`), at SERIALIZABLE, where
 * every family of it is immutable, written whole with its owner, and it is appended from no put slot, so the statement
 * reads no stored row of a group for the members it inserts; else none, a mutable family's group and a put's member read
 * where a probe reaches them.
 */
const memberArbiter = (w: WriteContext, member: AppendedMember): Arbiter =>
	w.level === "serializable" &&
	member.families.every(({ family }) => !family.owner.mutable) &&
	member.sources.every(
		(source) => source.kind === "nestedRows" || source.slots.every(({ as }) => as === "inserts")
	)
		? "every"
		: "none"

/** `rows` with every column `scan` drew beside its own, by the member's key: what the next family's scan reads. */
const withDrawn = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: AppendedMember,
	rows: Shaped,
	scan: Scanned,
	columns: ReadonlyArray<FillColumn>
): Shaped => {
	const added = columns.map((c) => columnKey(c.column)).filter((k) => !rows.columns.has(k))
	const next = shapedCte(supply, "appended with drawn", [...rows.columns.keys(), ...added])
	const a = supply.relation(internal("drawn row"))
	const s = supply.relation(internal("drawn scan"))
	ctes.push(
		cte(
			next.name,
			select(
				provedCore(
					"keyed",
					[
						...[...rows.columns].map(([k, c]) => targetAs(col(a, c), columnAt(next, k))),
						...added.map((k) => targetAs(col(s, columnAt(scan, k)), columnAt(next, k)))
					],
					[
						join(
							cteRefAs(rows.name, a),
							cteRefAs(scan.name, s),
							and(
								mapNonEmpty(member.relation.primaryFields, (f) =>
									typedEq(
										f.type,
										col(s, columnAt(scan, columnKeyOf(f.name))),
										col(a, columnAt(rows, columnKeyOf(f.name))),
										w.names
									)
								)
							)
						)
					],
					undefined
				)
			)
		)
	)
	return next
}

/**
 * A member relation's appended rows of one source (`RowSource`): its insert slot's facts no stored row repeats exactly,
 * every field its fact carries equal (rule 0 makes such an insert no change), and its put slot's facts at no key a row
 * stores; or its nested rows no stored row repeats exactly, each with every column of its sent layout.
 *
 * A slot's rows hold every count and end of the member's own counted families (`ownedColumns`): an insert's row is a
 * fresh owner, by its key law, and holds them as its slot carries them, drawn from the stratum's appends to it
 * (runtime/write/bind.ts freshOwners), or at their starts. A put's row may be a stored one the stratum moves to another
 * group, which the removals deleted (write/family/removals.ts) and its families' members still name, so it holds each
 * as its group's members hold it, every member's copy of the count and the last member's column an end is carried
 * from, and as an insert's row does where its group holds no member.
 */
const appendedOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: AppendedMember,
	source: RowSource,
	slots: SlotReader,
	nested: NestedReader,
	arbiter: Arbiter
): Shaped => {
	const name = member.relation.name
	/** The arm of `facts`' rows no stored row repeats at `compared`, each of the appended CTE's columns, `value` read as
	 * `a`, read by the probe of the member at those columns (probe.ts storedAt); every one of them where the member's
	 * insert arbitrates its primary key (`memberArbiter`), which meets each stored repeat at its key. */
	const unstored = (
		facts: Shaped,
		compared: NonEmptyReadonlyArray<{
			readonly key: ColumnKey
			readonly column: NativeColumn
			readonly type: ScalarType
		}>,
		appended: Shaped,
		value: (a: string, key: ColumnKey) => Expr
	): SetArm => {
		const a = supply.relation(internal("appended fact"))
		const pkKeys = new Set(member.relation.primaryFields.map((f) => columnKeyOf(f.name)))
		/** The stored row at the fact's primary key, which reaches one row, equal to the fact at every other compared column,
		 * checked over that row (probe.ts Equal). */
		const repeated = (): Expr =>
			storedAt(
				w,
				supply,
				name,
				atFields(w, name, member.relation.primaryFields, (f) =>
					col(a, columnAt(facts, columnKeyOf(f.name)))
				),
				compared
					.filter((c) => !pkKeys.has(c.key))
					.map((c): Equal => ({
						column: installed(w, name, c.column),
						value: col(a, columnAt(facts, c.key)),
						type: c.type
					}))
			)
		return provedCore(
			"input",
			[...appended.columns.keys()].map((k) => targetAs(value(a, k), columnAt(appended, k))),
			[cteRefAs(facts.name, a)],
			((): Expr | undefined => {
				switch (arbiter) {
					case "every":
						return undefined
					case "none":
						return not(repeated())
				}
			})()
		)
	}
	const fieldOf = (field: { readonly name: string; readonly type: ScalarType }) => {
		const law = defined(
			member.relation.fields.find((f) => f.name === field.name),
			`the field ${field.name} of ${name}`
		)
		return {
			key: columnKeyOf(field.name),
			column: { kind: "field" as const, field: law },
			type: field.type
		}
	}
	switch (source.kind) {
		case "slots": {
			const owned = ownedColumns(member)
			const keys = [
				...new Set([
					...source.slots[0].slot.heading.map((c) => columnKeyOf(c.name)),
					...source.slots[0].stamps.map((st) => columnKeyOf(st.field.name)),
					...owned.keys()
				])
			]
			const appended = shapedCte(supply, "appended member", keys)
			const arms = mapNonEmpty(source.slots, ({ as, slot, stamps }) => {
				const compared =
					as === "inserts"
						? [
								...slot.input.stated.map(fieldOf),
								...stamps.flatMap((st) => (st.stamp.kind === "call" ? [fieldOf(st.field)] : []))
							]
						: member.relation.primaryFields.map(fieldOf)
				const [first, ...rest] = compared
				if (first === undefined) {
					defect(`the fields of ${name}'s slot, which holds its key`)
				}
				const facts = slots(name, slot)
				/** A count or end of the row's own counted family as an insert's row holds it: its slot's, or its start. */
				const fresh = (a: string, c: OwnedColumn): Expr =>
					facts.columns.has(columnKeyOf(c.field.name))
						? col(a, columnAt(facts, columnKeyOf(c.field.name)))
						: defined(startOf(w.names, c.field), `the start of ${name}'s ${c.field.name}`)
				/** A count or end of the row's own counted family as its group's members hold it, read by the probe of the
				 * group's last member at the row's key; none where the group holds no member. */
				const held = (a: string, c: OwnedColumn): Expr => {
					const of = c.family.member.name
					const column = installed(w, of, c.held)
					const last = probeGroup(
						w,
						supply,
						of,
						"last",
						mapNonEmpty(c.family.group, (g) =>
							bound(w, of, g.member, col(a, columnAt(facts, columnKeyOf(g.owner.name))))
						),
						[installed(w, of, c.family.shape.index)],
						{ read: [column], filter: () => [] }
					)
					return written(
						w,
						{
							kind: "subquery",
							query: simpleSelect([target(last.at(column))], [last.source], undefined)
						},
						c.field.type
					)
				}
				return unstored(facts, [first, ...rest], appended, (a, k) => {
					const c = owned.get(k)
					if (c === undefined) {
						return col(a, columnAt(facts, k))
					}
					return as === "puts" ? firstNonNull([held(a, c), fresh(a, c)]) : fresh(a, c)
				})
			})
			ctes.push(cte(appended.name, select(unionAll("disjoint", arms))))
			return appended
		}
		case "nestedRows": {
			const columns = [...source.layout.key, ...source.layout.columns]
			const sent = nested(member.relation, source)
			const appended = shapedCte(
				supply,
				"appended nested row",
				columns.map((c) => c.key)
			)
			const compared = columns.filter(
				(c) => c.column.kind === "field" && statesColumn(source, c.key)
			)
			const [first, ...rest] = compared
			if (first === undefined) {
				defect(`the fields of ${name}'s nested rows`)
			}
			ctes.push(
				cte(
					appended.name,
					select(unstored(sent, [first, ...rest], appended, (a, k) => col(a, columnAt(sent, k))))
				)
			)
			return appended
		}
	}
}

/** A stratum's nested rows of a relation as a family statement reads them (RowSource `nestedRows`). */
type NestedRows = Extract<RowSource, { readonly kind: "nestedRows" }>

/** A reader of a stratum's nested rows of a relation, each relation's CTE pushed once (`nestedRowsCte`), as the host
 * sends them (`sentOf`). */
type NestedReader = (relation: RelationInfo, source: NestedRows) => Shaped

/**
 * A stratum's nested rows as the host sends them: every column of their layout but those their stamps fill, which no
 * nested row sends (runtime/write/nesting.ts sentLayout), so every statement that reads them reads them alike, the one
 * that stamps them with each stamped field's column beside (`stampedSources`), and any other without it, since a stamp is
 * taken once in its stratum, by the statement that writes the rows carrying it (ir/instant.ts stampText).
 */
const sentOf = (source: NestedRows): NestedSent => {
	const stampedKeys = new Set(source.stamps.map((st) => columnKeyOf(st.field.name)))
	const unstamped = (c: RowColumn): boolean => !stampedKeys.has(c.key)
	const [key, ...keys] = source.layout.key.filter(unstamped)
	if (key === undefined) {
		defect(`the key of ${source.layout.relation}'s nested rows beyond its stamps, their child`)
	}
	return {
		stratum: source.stratum,
		layout: {
			...source.layout,
			key: [key, ...keys],
			columns: source.layout.columns.filter(unstamped)
		}
	}
}

/** Rows this statement stamps: its rows as sent, stated or drawn on the host, and the fields they leave out, each
 * stamped. */
interface Stamping {
	readonly rows: Shaped
	readonly stamps: NonEmptyReadonlyArray<Stamped>
}

/** A source's rows this statement stamps (`Stamping`), and where its view is kept. */
interface StampingSource extends Stamping {
	/** Its rows with every stamped field's column beside the rest, set once its stamps are read. */
	readonly view: (stamped: Shaped) => void
}

/** The readers of an additions statement's rows as it holds them (`stampedSources`): its slots' facts, the stratum's
 * nested rows, and any rows it stamps besides, a counted family's fresh members the host drew (`hostDrawnOf`). */
interface StampedReaders {
	readonly slots: SlotReader
	readonly nested: NestedReader
	readonly stamped: (x: Stamping) => Shaped
}

/**
 * The readers of `members`' sources as this statement reads them: a source whose rows leave out a field this statement
 * stamps (RowSource `stamps`), a stamped nesting's root's slot and its members' nested rows, read with each stamped
 * field's column beside its own, and every other source as `stated` and `sent` read it.
 *
 * Each head its sources stamp is stamped once, by one CTE of its stamps at each child its rows hold, every source's
 * children read into one DISTINCT (write/insert/stamp.ts headStampsCte), so the head is advanced once at each child,
 * and every row that carries the head's stamp, the root's own and every member's paired with it, joins that one row: a
 * member carries exactly its owner's stamp, and two of a call's rows at one child carry one. A member's child is its
 * owner's, which the walk copied, so it joins the stamp its owner's row does.
 */
const stampedSources = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	members: ReadonlyArray<AppendedMember>,
	stated: SlotReader,
	sent: NestedReader
): StampedReaders => {
	const bySlot = new Map<MemberSlot["slot"], Shaped>()
	const byRelation = new Map<string, Shaped>()
	const stamping: Array<StampingSource> = []
	for (const member of members) {
		for (const source of member.sources) {
			if (source.kind === "nestedRows") {
				const [first, ...rest] = source.stamps
				if (first !== undefined) {
					stamping.push({
						rows: sent(member.relation, source),
						stamps: [first, ...rest],
						view: (view) => {
							byRelation.set(member.relation.name, view)
						}
					})
				}
				continue
			}
			for (const { slot, stamps } of source.slots) {
				const [first, ...rest] = stamps
				if (first !== undefined) {
					stamping.push({
						rows: stated(member.relation.name, slot),
						stamps: [first, ...rest],
						view: (view) => {
							bySlot.set(slot.slot, view)
						}
					})
				}
			}
		}
	}
	/** Each computed record the sources' rows take a value of, once, its values' CTE named and pushed, evaluated once for
	 * the whole statement (write/insert/stamp.ts callValuesCte). */
	const calls = new Map<Computed, CallValues>()
	for (const x of stamping) {
		for (const { stamp } of x.stamps) {
			if (stamp.kind !== "call" || calls.has(stamp.computed)) {
				continue
			}
			const values = callValuesNames(supply, stamp.computed)
			calls.set(stamp.computed, values)
			ctes.push(callValuesCte(w, values))
		}
	}
	/** The call's value of a field of `x`'s rows, read from its record's one row, none where the call computes no value of
	 * it. */
	const calledIn = (x: Stamping, field: string): Expr | undefined => {
		for (const { field: f, stamp } of x.stamps) {
			if (stamp.kind === "call" && f.name === field) {
				const values = defined(calls.get(stamp.computed), "a computed record's values")
				return col(values.name, callColumn(values, stamp.from))
			}
		}
		return undefined
	}
	/** A field of a row of `x`, read as `r`, before its heads stamp it: its row's, or the call's value. */
	const valueIn = (x: Stamping, r: string, field: string): Expr =>
		calledIn(x, field) ?? col(r, columnAt(x.rows, columnKeyOf(field)))
	/** The rows of `x`, read as `r`, beside the values of every record they take one of, its one row each. */
	const withCalls = (x: Stamping, r: string): FromItem => {
		const called = [
			...new Set(x.stamps.flatMap((st) => (st.stamp.kind === "call" ? [st.stamp.computed] : [])))
		]
		const [firstCall, ...moreCalls] = called
		return firstCall === undefined
			? cteRefAs(x.rows.name, r)
			: {
					kind: "joins",
					first: cteRefAs(x.rows.name, r),
					steps: mapNonEmpty([firstCall, ...moreCalls], (c): JoinStep => ({
						kind: "cross",
						source: cteRef(defined(calls.get(c), "a computed record's values").name)
					}))
				}
	}
	/** Each head the sources stamp, once, its stamps' CTE named, by its spelling (ir/instant.ts headText): a scope's,
	 * every clock of it alike, or a place's. */
	const heads = new Map<string, { readonly head: Head; readonly names: HeadStamps }>()
	for (const x of stamping) {
		for (const st of headStamped(x.stamps)) {
			const { head } = stampAt(st.stamp)
			heads.getOrInsertComputed(headText(head), () => ({
				head,
				names: headStampsNames(supply, head)
			}))
		}
	}
	for (const [at, { head, names }] of heads) {
		const arms = stamping.flatMap((x) =>
			headStamped(x.stamps).flatMap((st) => {
				const { head: stamped, key } = stampAt(st.stamp)
				if (headText(stamped) !== at) {
					return []
				}
				const r = supply.relation(internal("stamped source"))
				return [
					core(
						mapNonEmpty(key, (f) => target(valueIn(x, r, f.name))),
						[
							key.some((f) => calledIn(x, f.name) !== undefined)
								? withCalls(x, r)
								: cteRefAs(x.rows.name, r)
						],
						undefined
					)
				]
			})
		)
		const [first, ...rest] = arms
		if (first === undefined) {
			defect(`a source that stamps ${at}`)
		}
		const u = supply.relation(internal("stamped children"))
		const children = select(
			distinctCore(
				mapNonEmpty(names.child, (c) => target(col(u, c))),
				[
					derived(
						namedQuery(operandSelect(operandUnionAll([first, ...rest])), names.child),
						u,
						false
					)
				],
				undefined
			)
		)
		ctes.push(headStampsCte(w, supply, head, names, children))
	}
	/** The rows of `x` with each of its stamps' fields beside their own columns, one CTE: a call's value read from its
	 * record's one row, a head's stamp joined at the row's child. */
	const viewOf = (x: Stamping): Shaped => {
		const view = shapedCte(supply, "stamped rows", [
			...x.rows.columns.keys(),
			...x.stamps.map((st) => columnKeyOf(st.field.name))
		])
		const r = supply.relation(internal("stamped row"))
		const joined = headStamped(x.stamps).map((st) => {
			const names = defined(
				heads.get(headText(stampAt(st.stamp).head)),
				"a stamped head's stamps"
			).names
			return { st, alias: supply.relation(internal("stamp")), names }
		})
		const rowsWithCalls = withCalls(x, r)
		const [firstJoin, ...moreJoins] = joined
		const from: FromItem = ((): FromItem => {
			if (firstJoin === undefined) {
				return rowsWithCalls
			}
			const headJoins = mapNonEmpty(
				[firstJoin, ...moreJoins],
				({ st, alias, names }): JoinStep => ({
					kind: "on",
					source: cteRefAs(names.name, alias),
					on: and(
						mapNonEmpty(stampAt(st.stamp).key, (f, i) =>
							eq(
								valueIn(x, r, f.name),
								col(alias, defined(names.child[i], "a stamped child column"))
							)
						)
					)
				})
			)
			return rowsWithCalls.kind === "joins"
				? { ...rowsWithCalls, steps: concatNonEmpty(rowsWithCalls.steps, headJoins) }
				: { kind: "joins", first: rowsWithCalls, steps: headJoins }
		})()
		ctes.push(
			cte(
				view.name,
				select(
					provedCore(
						"input",
						[
							...[...x.rows.columns].map(([k, c]) => targetAs(col(r, c), columnAt(view, k))),
							...x.stamps.map((st) => {
								const at = columnAt(view, columnKeyOf(st.field.name))
								if (st.stamp.kind === "call") {
									return targetAs(
										defined(calledIn(x, st.field.name), "a computed field's value"),
										at
									)
								}
								const { alias, names } = defined(
									joined.find((j) => j.st.field.name === st.field.name),
									"a stamped field's stamp"
								)
								return targetAs(col(alias, names.at), at)
							})
						],
						[from],
						undefined
					)
				)
			)
		)
		return view
	}
	for (const x of stamping) {
		x.view(viewOf(x))
	}
	return {
		slots: (relation, slot) => bySlot.get(slot.slot) ?? stated(relation, slot),
		nested: (relation, source) => byRelation.get(relation.name) ?? sent(relation, source),
		stamped: viewOf
	}
}

/** A stratum's nested rows of a relation as its statements send them: its stratum and their sent layout. */
interface NestedSent {
	readonly stratum: StratumAt
	readonly layout: RowLayout
}

/** A stratum's nested rows of `relation` as a CTE: each column of their sent layout, read from their arrays and cast into
 * its column's type as a write stores it, by key (`filledRowsCte`). */
export const nestedRowsCte = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	relation: RelationInfo,
	source: NestedSent
): Shaped =>
	filledRowsCte(w, supply, ctes, relation, source.stratum, walkedRows, [
		...source.layout.key,
		...source.layout.columns
	])

/**
 * A stratum's host-filled rows of `relation` (ir/products.ts FilledRows) as a CTE: each of `columns`, their layout's key
 * first, read from their arrays and cast into its column's type as a write stores it, by key.
 */
const filledRowsCte = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	relation: RelationInfo,
	stratum: StratumAt,
	filled: FilledRows,
	columns: ReadonlyArray<{ readonly key: ColumnKey; readonly type: ScalarType }>
): Shaped => {
	const origin = internal(filled.kind === "walked" ? "nested rows" : "fresh members")
	const placeholders = w.cx.nestedRows(
		stratum,
		relation.name,
		filled,
		() =>
			relationColumns(
				columns.map((c) => ({ name: c.key, type: c.type })),
				() => supply.column(origin),
				(t) => w.cx.baseTypeRef(t),
				unchecked
			),
		`a family write of ${relation.name}'s ${filled.kind === "walked" ? "nested rows" : "fresh members"}`
	)
	const raw = supply.relation(origin)
	const arrayColumn = new Map(
		placeholders[0].columns.map((c) => [c.name, c.definition.name] as const)
	)
	const rows = shapedCte(
		supply,
		filled.kind === "walked" ? "nested row" : "fresh member",
		columns.map((c) => c.key)
	)
	ctes.push(
		cte(
			rows.name,
			select(
				provedCore(
					"input",
					columns.map((c) =>
						targetAs(
							written(w, col(raw, defined(arrayColumn.get(c.key), "a filled rows' array")), c.type),
							columnAt(rows, c.key)
						)
					),
					[arrays(arraysSource(placeholders), raw)],
					undefined
				)
			)
		)
	)
	return rows
}

/** The union of `shapes`, each a source's rows of one member relation, at the columns every one holds; the one shape
 * itself where there is one. */
const unionOf = (
	supply: NameSupply,
	ctes: Array<Cte>,
	shapes: NonEmptyReadonlyArray<Shaped>
): Shaped => {
	const [first, ...rest] = shapes
	if (!isNonEmpty(rest)) {
		return first
	}
	const keys = [...first.columns.keys()].filter((k) => rest.every((x) => x.columns.has(k)))
	const union = shapedCte(supply, "appended union", keys)
	ctes.push(
		cte(
			union.name,
			namedBody(
				select(
					unionAll(
						"disjoint",
						mapNonEmpty(shapes, (shape) => {
							const a = supply.relation(internal("appended source"))
							return provedCore(
								"input",
								keys.map((k) => targetAs(col(a, columnAt(shape, k)), columnAt(union, k))),
								[cteRefAs(shape.name, a)],
								undefined
							)
						})
					)
				),
				[...union.columns.values()]
			)
		)
	)
	return union
}

/**
 * The scan of `family` over a member relation's `appended` rows (see the header): the groups they join with their
 * kept counts, their seeds, the appended rows at their slots with their owners' columns, and the scan itself, each a
 * CTE pushed onto `ctes`. Where the family's appends draw its groups whole (`start`, ir/fill.ts AppendStart), each
 * group's stored members stand before its appended rows at their own slots, drawn from slot 0 (`wholeRows`).
 */
/**
 * A family's new count as its statement draws it, `count`, a bigint, for the group its member's `group` values name,
 * narrowed into its count field's carrier: where that carrier is below bigint, smallint or integer, a drawn
 * contract's (scalar/natural.ts isDrawnType), a count past the carrier's greatest value refuses the statement on the
 * count's contract, the one law a count past the bound breaks, raised under the owner's key before PostgreSQL would
 * narrow the count into the column and raise 22003, as the contract's CHECK refuses a count past its bound within the
 * carrier. A count of a bigint carrier is drawn in its own carrier, as it was.
 */
const drawnCount = (
	w: WriteContext,
	family: Family,
	group: ReadonlyArray<Expr>,
	count: Expr
): Expr => {
	const narrowing = drawnNarrowing(family.count.type)
	if (narrowing === undefined) {
		return count
	}
	const law = identifierOf(contractLawIdentity(narrowing.contract))
	const refusal = raised({
		kind: "law",
		law,
		relation: family.owner.name,
		key: family.group.map((p, i) => ({
			field: p.owner.name,
			expr: defined(group[i], "a group value"),
			type: p.owner.type
		}))
	})
	const refuse = qualifiedCall(refusalRef(w.names.schema), [
		lit.text(refusal.state, types.text),
		lit.text(law, types.text),
		refusal.detail
	])
	return {
		kind: "case",
		operand: undefined,
		whens: [
			{ when: le(count, lit.int(narrowing.greatest, types.bigint)), result: count },
			{ when: refuse, result: count }
		],
		else: count
	}
}

const appendScan = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: AppendedMember,
	family: Family,
	drawnColumns: ReadonlyArray<FillColumn>,
	appended: Shaped,
	copySource: (column: ColumnKey) => CopySource,
	ownerShapes: () => ReadonlyArray<Shaped>,
	stamped: StampedReaders["stamped"],
	arbiter: Arbiter,
	start: AppendStart,
	fresh: FreshGroups
): Scanned => {
	/** Each group's state before its drawn members (scan.ts GroupState): its base where the insert arbitrates, its stored
	 * members where a probe reads them (`memberArbiter`). */
	const state = ((): GroupState["kind"] => {
		switch (arbiter) {
			case "every":
				return "base"
			case "none":
				return "stored"
		}
	})()
	const bigint = types.bigint
	const name = member.relation.name
	const owner = family.owner
	const groupKeys = family.group.map((g) => columnKeyOf(g.member.name))
	const memberGroup = (alias: string, shape: Shaped): ReadonlyArray<Expr> =>
		groupKeys.map((k) => col(alias, columnAt(shape, k)))
	const index = installed(w, name, family.shape.index)
	/** The member's group columns bound to `keys`, a group's values in order. */
	const groupAt = (keys: ReadonlyArray<Expr>) =>
		mapNonEmpty(family.group, (g, i) => bound(w, name, g.member, defined(keys[i], "a group key")))
	const ownerReads = ownerReadsOf(drawnColumns)
	/** The owner reads each group holds: every one but, where the family's appends draw its groups whole, each a settled
	 * copy reads, which the rows draw at the group's new count (`wholeRows`). */
	const groupReads: OwnerReads =
		start.kind === "whole"
			? new Map([...ownerReads].filter(([k]) => !start.settled.includes(k)))
			: ownerReads
	/** The owner reads whose copies are `held` (schedule.ts CopySource), which the owner's rows the stratum inserts hold. */
	const heldReads = [...groupReads].filter(
		([, read]) => copySource(columnKey(read.from)) === "held"
	)
	/**
	 * The owner's rows among those the stratum inserts, which the statement's parameters hold, one CTE per source
	 * (`ownerShapes`): each row at the owner's key, the family's group order, with every owner column a `held` copy reads,
	 * its column or a generated field's generation over the fields it reads (scan.ts scannedValue), every column at once,
	 * so the groups read their owners in one pass of each source however many columns they copy (`groups`); no source
	 * repeats a key (a slot's facts are host-normalized, insert/input.ts readInput, and a stratum's nested rows are one
	 * per key, program/bind.ts nestedPlans), so a group meets at most one row of each. None where no copy is held.
	 */
	const heldOwners = isNonEmpty(heldReads)
		? ownerShapes().map((owners): PerGroup => {
				const copies: PerGroup = {
					name: supply.relation(internal("held owner")),
					group: mapNonEmpty(family.group, () => supply.column(internal("held owner key"))),
					columns: new Map(
						heldReads.map(([k]) => [k, supply.column(internal("held owner column"))] as const)
					)
				}
				const n = supply.relation(internal("inserted owner"))
				const ownerKey = family.group.map((g) =>
					col(n, columnAt(owners, columnKeyOf(g.owner.name)))
				)
				ctes.push(
					cte(
						copies.name,
						select(
							provedCore(
								"keyed",
								[
									...mapNonEmpty(copies.group, (c, i) =>
										targetAs(defined(ownerKey[i], "an owner key"), c)
									),
									...heldReads.map(([k, read]) =>
										targetAs(
											cast(
												scannedValue(w, owner, readAt(n, owners), read.to),
												w.cx.baseTypeRef(read.type)
											),
											columnAt(copies, k)
										)
									)
								],
								[cteRefAs(owners.name, n)],
								undefined
							)
						)
					)
				)
				return copies
			})
		: []
	/**
	 * The groups the appends join, each with its kept count and its owner's columns. Its kept count: 0 at `base`; else its
	 * stored last member's slot plus one, read by the probe of its group's last member (probe.ts probeGroup `last`), 0
	 * where it holds none. Its owner's columns, each from where its copy reads it (schedule.ts CopySource): a `held`
	 * copy's the owner's row among those the stratum inserts (`heldOwners`), else the stored owner's (`ownerFallback`);
	 * a `stored` or `drawn` copy's the stored owner's alone.
	 */
	const groups = {
		name: supply.relation(internal("appended group")),
		group: mapNonEmpty(family.group, () => supply.column(internal("appended group key"))),
		kept: supply.column(internal("kept count")),
		owner: new Map(
			[...groupReads.keys()].map((k) => [k, supply.column(internal("group owner column"))] as const)
		)
	}
	const g0 = supply.relation(internal("appended group row"))
	/**
	 * Where the groups are read from (`GroupRead`): a sequence's appended rows, every group the scan's; a counted family's
	 * appended rows' group keys ranked beside the host's members' (`HostDrawn`), each with whether the host drew its group,
	 * which every group CTE carries beside its kept count (`drawn`).
	 */
	const groupRead: GroupRead =
		fresh.kind === "drawn"
			? {
					kind: "ranked",
					host: hostDrawnOf(w, supply, ctes, member, family, fresh, appended, stamped),
					drawn: {
						fallen: supply.column(internal("fallback drawn")),
						side: supply.column(internal("group owner side drawn")),
						ranked: supply.column(internal("group owners drawn")),
						groups: supply.column(internal("group drawn"))
					}
				}
			: { kind: "appended" }
	const g0Keys: ReadonlyArray<Expr> =
		groupRead.kind === "ranked"
			? groupRead.host.keys.group.map((c) => col(g0, c))
			: memberGroup(g0, appended)
	/** The columns each group CTE holds the host's drawing of its groups in, beside their kept counts: one set where the
	 * host draws (`groupRead` ranked), none where it does not. */
	const drawnLane: ReadonlyArray<DrawnColumns> =
		groupRead.kind === "ranked" ? [groupRead.drawn] : []
	/** The base of an owner copy, an accumulated column's start or a fold's identity, as a literal of its type. */
	const baseOf = (read: { readonly from: NativeColumn; readonly type: LawField["type"] }): Expr =>
		lowerLiteral(
			w.names,
			defined(
				baseLiteral(family, read.from),
				`the base of ${name}'s owner copy ${columnKey(read.from)}, an accumulated column`
			),
			read.type
		)
	/**
	 * A group's copy of an owner column where no owner row the stratum inserts holds it: the stored owner's, read by the
	 * probe of the owner at the group's key where the group's state is stored, and at `base` where the copy is `drawn`
	 * (the owner's own earlier statement of this call wrote the column, which only its row holds); else, and where no
	 * owner is stored, the copy's base. At `base` a `held` copy reads the call's own rows, and a `stored` one none, its
	 * owner stored, so the family's owner axis refuses the append whatever the copy is, as it refuses any member naming no
	 * owner, whose rows take the base. Read as COALESCE, since an owner's column is never NULL (rule 0).
	 */
	const ownerFallback = (read: {
		readonly to: NativeColumn
		readonly from: NativeColumn
		readonly type: LawField["type"]
	}): Expr => {
		const stored = (): Expr => {
			const ownerRow = probeKey(
				w,
				supply,
				owner.name,
				{
					key: mapNonEmpty(family.group, (g, i) =>
						bound(w, owner.name, g.owner, defined(g0Keys[i], "a group key"))
					),
					filter: () => [],
					placed: mapNonEmpty(family.group, (g) => w.names.column(owner.name, g.owner.name))
				},
				[installed(w, owner.name, read.to)]
			)
			return {
				kind: "subquery",
				query: simpleSelect(
					[
						target(
							cast(ownerRow.at(installed(w, owner.name, read.to)), w.cx.baseTypeRef(read.type))
						)
					],
					[ownerRow.source],
					undefined
				)
			}
		}
		const reads =
			state === "stored" || copySource(columnKey(read.from)) === "drawn" ? [stored()] : []
		return firstNonNull(appendNonEmpty(reads, baseOf(read)))
	}
	/** A group's kept count, its stored last member's slot plus one, read by the probe of its last member at `keys`, 0 where
	 * it holds none. */
	const storedKept = (keys: ReadonlyArray<Expr>): Expr => {
		const last = probeGroup(w, supply, name, "last", groupAt(keys), [index], {
			read: [index],
			filter: () => []
		})
		return {
			kind: "greatest",
			args: [
				lit.int(0, bigint),
				{
					kind: "subquery",
					query: simpleSelect(
						[target(binary("+", last.at(index), lit.int(1, bigint)))],
						[last.source],
						undefined
					)
				}
			]
		}
	}
	/** The kept count of the group at `keys`: 0 at `base`, else its stored one (`storedKept`). */
	const keptAt = (keys: ReadonlyArray<Expr>): Expr =>
		state === "base" ? lit.int(0, bigint) : cast(storedKept(keys), bigint)
	/** Each appended group once, with its kept count, the host's drawing of it where the host draws (`groupRead`), and each
	 * owner column's fallback (`ownerFallback`): the groups themselves where no copy is held. */
	const fallen: PerGroup & { readonly kept: string } = isNonEmpty(heldOwners)
		? {
				name: supply.relation(internal("appended group fallback")),
				group: mapNonEmpty(family.group, () => supply.column(internal("fallback group key"))),
				kept: supply.column(internal("fallback kept count")),
				columns: new Map(
					[...groupReads.keys()].map(
						(k) => [k, supply.column(internal("fallback owner column"))] as const
					)
				)
			}
		: { ...groups, columns: groups.owner }
	/** The column fallen holds the host's drawing of each group in: the groups' own where it is the groups (no copy held),
	 * else the one the held sides read it from. */
	const fallenDrawn = drawnLane.map((d) => (isNonEmpty(heldOwners) ? d.fallen : d.groups))
	/** Fallen's drawing of each group, read off its ranked key (`hostDrew`), where the host draws. */
	const fallenDrawnTargets =
		groupRead.kind === "ranked"
			? fallenDrawn.map((c) => targetAs(hostDrew(groupRead.host, g0), c))
			: []
	ctes.push(
		cte(
			fallen.name,
			select(
				distinctCore(
					[
						...mapNonEmpty(fallen.group, (c, i) => targetAs(defined(g0Keys[i], "a group key"), c)),
						targetAs(keptAt(g0Keys), fallen.kept),
						...fallenDrawnTargets,
						...[...groupReads].map(([k, read]) =>
							targetAs(ownerFallback(read), columnAt(fallen, k))
						)
					],
					[
						groupRead.kind === "ranked"
							? cteRefAs(groupRead.host.keys.name, g0)
							: cteRefAs(appended.name, g0)
					],
					groupRead.kind === "ranked" ? appendedSide(groupRead.host, g0) : undefined
				)
			)
		)
	)
	const [firstHeld, ...restHeld] = heldOwners
	if (firstHeld !== undefined) {
		/**
		 * Each group's owner columns, a held copy's the first held source's row at the group's key, in `ownerShapes`'s
		 * order, else its fallback: the held sources' rows and the groups, each tagged with its place, those after the
		 * sources, are one UNION ALL, and first_value over each key's partition in tag order is the first that holds the
		 * key. No join pairs a group with an owner row, and no NULL stands for an absent one: a group no source holds
		 * reads its own fallback. It is the COALESCE of the held rows' values and the fallback, since no held value is
		 * NULL: each is a column of an owner row the stratum's own earlier statement inserted, NOT NULL in the owner's
		 * table (rule 0), or a generated field's generation, which that insert stored NOT NULL too.
		 */
		const sources: NonEmptyReadonlyArray<PerGroup> = [firstHeld, ...restHeld]
		const sides = {
			name: supply.relation(internal("group owner sides")),
			group: mapNonEmpty(family.group, () => supply.column(internal("group owner side key"))),
			tag: supply.column(internal("group owner side tag")),
			kept: supply.column(internal("group owner side kept count")),
			columns: new Map(
				[...groupReads.keys()].map(
					(k) => [k, supply.column(internal("group owner side column"))] as const
				)
			)
		}
		/**
		 * A side's columns: its key, its tag, its kept count, the host's drawing of its group where the host draws, `drawn`
		 * (a held owner row's false, as its kept count is 0, which no group reads: a group reads its fallen row's), and its
		 * owner columns.
		 */
		const sideTargets = (
			key: NonEmptyReadonlyArray<Expr>,
			tag: number,
			kept: Expr,
			drawn: (d: DrawnColumns) => Expr,
			value: (k: ColumnKey) => Expr
		) => [
			...mapNonEmpty(sides.group, (c, i) => targetAs(defined(key[i], "a side key"), c)),
			targetAs(lit.int(tag, types.integer), sides.tag),
			targetAs(kept, sides.kept),
			...drawnLane.map((d) => targetAs(drawn(d), d.side)),
			...[...sides.columns].map(([k, c]) => targetAs(value(k), c))
		]
		const fallenRow = supply.relation(internal("fallen group"))
		ctes.push(
			cte(
				sides.name,
				select(
					unionAll("disjoint", [
						...mapNonEmpty(sources, (copies, i) => {
							const h = supply.relation(internal("held owner row"))
							return provedCore(
								"keyed",
								sideTargets(
									mapNonEmpty(copies.group, (c) => col(h, c)),
									i,
									lit.int(0, bigint),
									() => lit.bool(false),
									(k) => {
										const column = copies.columns.get(k)
										return column === undefined
											? baseOf(defined(groupReads.get(k), "an owner read"))
											: col(h, column)
									}
								),
								[cteRefAs(copies.name, h)],
								undefined
							)
						}),
						provedCore(
							"keyed",
							sideTargets(
								mapNonEmpty(fallen.group, (c) => col(fallenRow, c)),
								sources.length,
								col(fallenRow, fallen.kept),
								(d) => col(fallenRow, d.fallen),
								(k) => col(fallenRow, columnAt(fallen, k))
							),
							[cteRefAs(fallen.name, fallenRow)],
							undefined
						)
					])
				)
			)
		)
		const ranked = supply.relation(internal("group owners"))
		const rankedColumns = new Map(
			[...groupReads.keys()].map((k) => [k, supply.column(internal("group owner value"))] as const)
		)
		const rankedGroup = mapNonEmpty(family.group, () => supply.column(internal("group owners key")))
		const rankedTag = supply.column(internal("group owners tag"))
		const rankedKept = supply.column(internal("group owners kept count"))
		const s = supply.relation(internal("group owner side"))
		const sideKey = sides.group.map((c) => col(s, c))
		ctes.push(
			cte(
				ranked,
				select(
					provedCore(
						"keyed",
						[
							...mapNonEmpty(rankedGroup, (c, i) =>
								targetAs(col(s, defined(sides.group[i], "a side key")), c)
							),
							targetAs(col(s, sides.tag), rankedTag),
							targetAs(col(s, sides.kept), rankedKept),
							...drawnLane.map((d) => targetAs(col(s, d.side), d.ranked)),
							...[...rankedColumns].map(([k, c]) => {
								const side = col(s, defined(sides.columns.get(k), "a side column"))
								return targetAs(
									heldReads.some(([h]) => h === k)
										? {
												...call("first_value", [side]),
												over: windowOf(sideKey, [asc(col(s, sides.tag))])
											}
										: side,
									c
								)
							})
						],
						[cteRefAs(sides.name, s)],
						undefined
					)
				)
			)
		)
		const r = supply.relation(internal("group owners row"))
		ctes.push(
			cte(
				groups.name,
				select(
					provedCore(
						"keyed",
						[
							...mapNonEmpty(groups.group, (c, i) =>
								targetAs(col(r, defined(rankedGroup[i], "a ranked key")), c)
							),
							targetAs(col(r, rankedKept), groups.kept),
							...drawnLane.map((d) => targetAs(col(r, d.ranked), d.groups)),
							...[...groups.owner].map(([k, c]) =>
								targetAs(col(r, defined(rankedColumns.get(k), "a ranked column")), c)
							)
						],
						[cteRefAs(ranked, r)],
						eq(col(r, rankedTag), lit.int(sources.length, types.integer))
					)
				)
			)
		)
	}
	/** Whether the group read as `g` is one the scan draws: every group but a fresh one, which the host drew whole. */
	const scanDraws = (g: string): Expr | undefined =>
		groupRead.kind === "ranked"
			? not(isFresh(col(g, groupRead.drawn.groups), col(g, groups.kept)))
			: undefined
	/** The appended rows at their slots, each with its group's first drawn slot, its new count and its owner's columns,
	 * drawn from each group's kept count: its seed the stored member before it. */
	const scanned =
		start.kind === "whole"
			? drawnScan(w, supply, ctes, {
					family,
					member: member.relation,
					drawn: drawnColumns,
					start: { kind: "base" },
					owner: ownerReads,
					columns: [...appended.columns.keys()],
					rows: (rows) =>
						wholeRows(
							w,
							supply,
							ctes,
							member,
							family,
							appended,
							groups,
							scanDraws,
							ownerReads,
							start.settled,
							rows
						)
				})
			: drawnScan(w, supply, ctes, {
					family,
					member: member.relation,
					drawn: drawnColumns,
					start:
						state === "base"
							? { kind: "base" }
							: {
									kind: "stored",
									groups: { name: groups.name, group: groups.group, first: groups.kept }
								},
					owner: ownerReads,
					columns: [...appended.columns.keys()],
					rows: (rows) => {
						const a = supply.relation(internal("appended row"))
						const g2 = supply.relation(internal("row group"))
						const aGroup = memberGroup(a, appended)
						const aKey = member.relation.primaryFields.map((f) =>
							col(a, columnAt(appended, columnKeyOf(f.name)))
						)
						const kept = col(g2, groups.kept)
						return select(
							provedCore(
								"keyed",
								[
									...mapNonEmpty(rows.group, (c, i) =>
										targetAs(defined(aGroup[i], "a group key"), c)
									),
									targetAs(
										cast(
											binary("-", binary("+", kept, rowNumber(aGroup, aKey)), lit.int(1, bigint)),
											bigint
										),
										rows.slot
									),
									targetAs(kept, rows.first),
									targetAs(
										drawnCount(
											w,
											family,
											aGroup,
											cast(binary("+", kept, countOver(aGroup)), bigint)
										),
										rows.count
									),
									...[...appended.columns].map(([k, c]) => targetAs(col(a, c), columnAt(rows, k))),
									...[...rows.owner].map(([k, c]) =>
										targetAs(col(g2, defined(groups.owner.get(k), "a group owner column")), c)
									)
								],
								[
									join(
										cteRefAs(appended.name, a),
										cteRefAs(groups.name, g2),
										sameGroupExprs(w.names, family, aGroup, g2, groups.group)
									)
								],
								scanDraws(g2)
							)
						)
					}
				})
	switch (groupRead.kind) {
		case "appended":
			return scanned
		case "ranked":
			return withHostDrawn(w, supply, ctes, family, groupRead.host, drawnColumns, scanned, keptAt)
	}
}

/** A family's groups as an append's scan reads them (`appendScan`): each one's key, its kept count, and the owner
 * columns its members copy, by the owner column's key. */
interface AppendedGroups {
	readonly name: string
	readonly group: NonEmptyReadonlyArray<string>
	readonly kept: string
	readonly owner: ReadonlyMap<ColumnKey, string>
}

/**
 * The rows of a family's draw where its appends draw its groups whole (ir/fill.ts AppendStart `whole`), as `rows` shapes
 * them. In each group the scan draws (`scanDraws`), its stored members at their own slots, read by the probe of the
 * group's members in slot order, then its appended rows at the slots from its kept count on, in key order, as the kept
 * start places them; every row with each column of the member's the appended rows hold, its group's first drawn slot 0
 * and its new count, every member of the group in one window over both, a counted family's stored members being its
 * slots 0 … kept − 1. Its owner's columns: each a settled copy reads (`settled`) at the group's new count, as the
 * family's own fill writes it, the count itself or its generation over the stored owner's other fields, read once per
 * group by the probe of the owner at the group's key; every other as the groups hold it.
 */
const wholeRows = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: AppendedMember,
	family: Family,
	appended: Shaped,
	groups: AppendedGroups,
	scanDraws: (g: string) => Expr | undefined,
	ownerReads: OwnerReads,
	settled: NonEmptyReadonlyArray<ColumnKey>,
	rows: ScanRows
): Select => {
	const bigint = types.bigint
	const name = member.relation.name
	const owner = family.owner
	const index = installed(w, name, family.shape.index)
	const countKey = columnKeyOf(family.count.name)
	const settledReads = new Map(
		settled.map(
			(k) => [k, defined(ownerReads.get(k), `the owner column ${k} a settled copy reads`)] as const
		)
	)
	/** The owner fields the settled columns' generations read, but the family's count, whose new value the rows hold. */
	const inputs = [
		...new Map(
			[...settledReads.values()]
				.flatMap((read) =>
					read.to.kind === "field" ? withGenerationInputs(owner, [read.to.field]) : []
				)
				.filter((f) => f.writing.kind !== "generated" && f.name !== family.count.name)
				.map((f) => [columnKeyOf(f.name), f] as const)
		).values()
	]
	const whole = {
		name: supply.relation(internal("whole group")),
		group: mapNonEmpty(family.group, () => supply.column(internal("whole group key"))),
		kept: supply.column(internal("whole group kept count")),
		owner: new Map(
			[...groups.owner.keys()].map(
				(k) => [k, supply.column(internal("whole group owner column"))] as const
			)
		),
		inputs: new Map(
			inputs.map(
				(f) => [columnKeyOf(f.name), supply.column(internal("whole group owner field"))] as const
			)
		)
	}
	const g0 = supply.relation(internal("whole group row"))
	/** The stored owner's field `f` of the group read as `g0`, by the probe of the owner at the group's key. */
	const storedField = (f: LawField): Expr => {
		const column = w.names.column(owner.name, f.name)
		const ownerRow = probeKey(
			w,
			supply,
			owner.name,
			{
				key: mapNonEmpty(family.group, (g, i) =>
					bound(w, owner.name, g.owner, col(g0, defined(groups.group[i], "a group column")))
				),
				filter: () => [],
				placed: mapNonEmpty(family.group, (g) => w.names.column(owner.name, g.owner.name))
			},
			[column]
		)
		return {
			kind: "subquery",
			query: simpleSelect([target(ownerRow.at(column))], [ownerRow.source], undefined)
		}
	}
	ctes.push(
		cte(
			whole.name,
			select(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(whole.group, (c, i) =>
							targetAs(col(g0, defined(groups.group[i], "a group column")), c)
						),
						targetAs(col(g0, groups.kept), whole.kept),
						...[...whole.owner].map(([k, c]) =>
							targetAs(col(g0, defined(groups.owner.get(k), "a group owner column")), c)
						),
						...inputs.map((f) =>
							targetAs(
								storedField(f),
								defined(whole.inputs.get(columnKeyOf(f.name)), "an owner field column")
							)
						)
					],
					[cteRefAs(groups.name, g0)],
					scanDraws(g0)
				)
			)
		)
	)
	const columnOf = (key: ColumnKey): NativeColumn =>
		defined(
			[...member.layout.key, ...member.layout.columns].find((c) => c.key === key),
			`the column ${key} of ${name}`
		).column
	const keys = [...appended.columns.keys()]
	const u = {
		alias: supply.relation(internal("whole member")),
		group: mapNonEmpty(family.group, () => supply.column(internal("whole member group key"))),
		slot: supply.column(internal("whole member slot")),
		columns: new Map(keys.map((k) => [k, supply.column(internal("whole member column"))] as const)),
		owner: new Map(
			[...whole.owner.keys()].map(
				(k) => [k, supply.column(internal("whole member owner column"))] as const
			)
		),
		inputs: new Map(
			[...whole.inputs.keys()].map(
				(k) => [k, supply.column(internal("whole member owner field"))] as const
			)
		)
	}
	/** A group's columns beside a row of it read as `g`: its owner's columns and the settled columns' owner fields. */
	const groupTargets = (g: string): ReadonlyArray<Target> => [
		...[...whole.owner.values()].map((c) => target(col(g, c))),
		...[...whole.inputs.values()].map((c) => target(col(g, c)))
	]
	const g1 = supply.relation(internal("whole stored group"))
	const read = [...new Set([index, ...keys.map((k) => installed(w, name, columnOf(k)))])]
	const stored = probeGroup(
		w,
		supply,
		name,
		"group",
		mapNonEmpty(family.group, (g, i) =>
			bound(w, name, g.member, col(g1, defined(whole.group[i], "a group column")))
		),
		[index],
		{
			read: appendNonEmpty(
				read.filter((c) => c !== index),
				index
			),
			filter: () => []
		}
	)
	const storedArm = core(
		[
			...mapNonEmpty(whole.group, (c) => target(col(g1, c))),
			target(cast(stored.at(index), bigint)),
			...keys.map((k) => target(stored.at(installed(w, name, columnOf(k))))),
			...groupTargets(g1)
		],
		[cteRefAs(whole.name, g1), stored.source],
		undefined
	)
	const a = supply.relation(internal("whole appended row"))
	const g2 = supply.relation(internal("whole appended group"))
	const aGroup = family.group.map((g) => col(a, columnAt(appended, columnKeyOf(g.member.name))))
	const aKey = member.relation.primaryFields.map((f) =>
		col(a, columnAt(appended, columnKeyOf(f.name)))
	)
	const appendedArm = core(
		[
			...aGroup.map((x) => target(x)),
			target(
				cast(
					binary(
						"-",
						binary("+", col(g2, whole.kept), rowNumber(aGroup, aKey)),
						lit.int(1, bigint)
					),
					bigint
				)
			),
			...keys.map((k) => target(col(a, columnAt(appended, k)))),
			...groupTargets(g2)
		],
		[
			join(
				cteRefAs(appended.name, a),
				cteRefAs(whole.name, g2),
				sameGroupExprs(w.names, family, aGroup, g2, whole.group)
			)
		],
		undefined
	)
	const uGroup = mapNonEmpty(u.group, (c) => col(u.alias, c))
	/** The group's new count: its stored members and its appended rows, within its count's carrier (drawnCount). */
	const count = (): Expr => drawnCount(w, family, uGroup, cast(countOver(uGroup), bigint))
	const atRow: Read = (key) => {
		if (key === countKey) {
			return count()
		}
		const c = u.inputs.get(key)
		return c === undefined ? undefined : col(u.alias, c)
	}
	return select(
		provedCore(
			"keyed",
			[
				...mapNonEmpty(rows.group, (c, i) => targetAs(defined(uGroup[i], "a group key"), c)),
				targetAs(col(u.alias, u.slot), rows.slot),
				targetAs(lit.int(0, bigint), rows.first),
				targetAs(count(), rows.count),
				...keys.map((k) =>
					targetAs(col(u.alias, defined(u.columns.get(k), "a member column")), columnAt(rows, k))
				),
				...[...rows.owner].map(([k, c]) => {
					const settledRead = settledReads.get(k)
					return targetAs(
						settledRead === undefined
							? col(u.alias, defined(u.owner.get(k), "an owner column"))
							: cast(
									scannedValue(w, owner, atRow, settledRead.to),
									w.cx.baseTypeRef(settledRead.type)
								),
						c
					)
				})
			],
			[
				derived(
					namedQuery(operandSelect(operandUnionAll([storedArm, appendedArm])), [
						...u.group,
						u.slot,
						...u.columns.values(),
						...u.owner.values(),
						...u.inputs.values()
					]),
					u.alias,
					false
				)
			],
			undefined
		)
	)
}

/**
 * The update in place of the stored members of the groups a family's appends draw whole (ir/fill.ts AppendStart
 * `whole`): each stored row the family's scan drew again, at its key, every column the family draws set to the scan's,
 * where one changes. The scan's appended rows are none of the table's, which the statement's insert writes.
 */
const redrawnUpdate = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: AppendedMember,
	drawnColumns: ReadonlyArray<FillColumn>,
	scan: Scanned
): FamilyReturning => {
	const relation = member.relation
	const name = relation.name
	const drawn = new Set(drawnColumns.map((c) => columnKey(c.column)))
	const [first, ...rest] = member.layout.columns.filter((c) => c.settable && drawn.has(c.key))
	if (first === undefined) {
		defect(`the columns of ${name} a family it is drawn whole by draws`)
	}
	const t = supply.relation(internal("redrawn table"))
	const s = supply.relation(internal("redrawn member"))
	const value = (c: RowColumn): Expr => written(w, col(s, columnAt(scan, c.key)), c.type)
	const set = mapNonEmpty([first, ...rest], (c): Assignment => ({
		column: installed(w, name, c.column),
		value: value(c)
	}))
	const changed = mapNonEmpty([first, ...rest], (c) =>
		not(typedEq(c.type, col(t, installed(w, name, c.column)), value(c), w.names))
	)
	const [firstField, ...restFields] = keyFirstFields(relation)
	if (firstField === undefined) {
		defect(`the fields of ${name}`)
	}
	const fields: NonEmptyReadonlyArray<LawField> = [firstField, ...restFields]
	const update = supply.relation(internal("family redraw"))
	const returning = updateReturning(w, supply, relation, fields, update)
	ctes.push(
		cte(update, {
			kind: "update",
			with: undefined,
			table: w.names.relation(name),
			alias: t,
			set: assignments(w.generation(name), t, set),
			from: [cteRefAs(scan.name, s)],
			where: and([
				...mapNonEmpty(relation.primaryFields, (f) =>
					typedEq(
						f.type,
						col(t, w.names.column(name, f.name)),
						col(s, columnAt(scan, columnKeyOf(f.name))),
						w.names
					)
				),
				...keyedAmong(
					w,
					supply,
					name,
					t,
					scan.name,
					mapNonEmpty(relation.primaryFields, (field) => ({
						field,
						column: columnAt(scan, columnKeyOf(field.name))
					}))
				),
				or(changed)
			]),
			returning: returning.returning
		})
	)
	return {
		cte: update,
		columns: returning.columns,
		relation: name,
		result: updatedResult(relation, fields),
		rows: "facts"
	}
}

/**
 * Whether a group the host's drawing `drawn` says of is fresh (`FreshGroups`): the host drew it, its owner one the stratum
 * inserts, and it holds no stored member, its kept count 0, so the call holds it whole. The scan draws every other
 * group, an exact repeat's of a stored owner with stored members among them, past its stored members.
 */
const isFresh = (drawn: Expr, kept: Expr): Expr => and([drawn, eq(kept, lit.int(0, types.bigint))])

/** The tag of the host's side among the ranked keys of a family's groups (`HostDrawn`), before the appended rows'. */
const hostTag = 0

/** The tag of the appended rows' side among the ranked keys of a family's groups (`HostDrawn`). */
const appendedTag = 1

/** The columns of each group CTE of a family's scan that hold the host's drawing of the group (`GroupRead` ranked). */
interface DrawnColumns {
	/** Fallen's, where a copy is held: what the held sides read. */
	readonly fallen: string
	readonly side: string
	readonly ranked: string
	/** The groups', which the appended rows read. */
	readonly groups: string
}

/**
 * Where a family's scan reads its groups from (`appendScan`): a sequence's appended rows, each group the scan's
 * (`appended`); or a counted family's appended rows' group keys ranked beside the host's members' (`ranked`), each group
 * with whether the host drew it, which every group CTE carries in its `drawn` column.
 */
type GroupRead =
	| { readonly kind: "appended" }
	| { readonly kind: "ranked"; readonly host: HostDrawn; readonly drawn: DrawnColumns }

/**
 * The host's side of a counted family's fresh groups (`FreshGroups` drawn): the members the stratum's fresh fill drew
 * (ir/products.ts FilledRows `fresh`, in its fresh layout), and the groups of the appended rows ranked beside the host's,
 * each group's key once on each side it holds, tagged with its side, the host's first (`hostTag`), one UNION ALL, with
 * first_value over each key's partition in tag order: the host's tag exactly where the host drew the group. No join
 * pairs an appended row or a group with a member, so the statement reads each row once, whatever plan PostgreSQL picks.
 */
interface HostDrawn {
	readonly members: Shaped
	readonly keys: {
		readonly name: string
		readonly group: NonEmptyReadonlyArray<string>
		readonly tag: string
		readonly first: string
	}
}

/** The host's side of a counted family's fresh groups (`HostDrawn`) over the member's `appended` rows. */
const hostDrawnOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: AppendedMember,
	family: Family,
	fresh: Extract<FreshGroups, { readonly kind: "drawn" }>,
	appended: Shaped,
	stamped: StampedReaders["stamped"]
): HostDrawn => {
	const drawn = filledRowsCte(
		w,
		supply,
		ctes,
		member.relation,
		fresh.stratum,
		{ kind: "fresh", family: familyKey(family.id) },
		[...fresh.layout.key, ...fresh.layout.columns]
	)
	/** The host's members with the key and group fields their fresh layout leaves out, the call's one value of each,
	 * stamped as the statement stamps its own rows (FreshGroups `drawn`). */
	const [first, ...rest] = fresh.stamps
	const members = first === undefined ? drawn : stamped({ rows: drawn, stamps: [first, ...rest] })
	const sides = {
		name: supply.relation(internal("drawn group sides")),
		group: mapNonEmpty(family.group, () => supply.column(internal("drawn group side key"))),
		tag: supply.column(internal("drawn group side tag"))
	}
	/** Each group key of `shape`'s rows once, read as `alias`, tagged `tag`. */
	const side = (shape: Shaped, tag: number): SetArm => {
		const alias = supply.relation(internal("drawn group side row"))
		return distinctCore(
			[
				...mapNonEmpty(family.group, (g, i) =>
					targetAs(
						col(alias, columnAt(shape, columnKeyOf(g.member.name))),
						defined(sides.group[i], "a side key")
					)
				),
				targetAs(lit.int(tag, types.integer), sides.tag)
			],
			[cteRefAs(shape.name, alias)],
			undefined
		)
	}
	ctes.push(
		cte(
			sides.name,
			select(unionAll("disjoint", [side(members, hostTag), side(appended, appendedTag)]))
		)
	)
	const keys = {
		name: supply.relation(internal("drawn group keys")),
		group: mapNonEmpty(family.group, () => supply.column(internal("drawn group key"))),
		tag: supply.column(internal("drawn group key tag")),
		first: supply.column(internal("drawn group key first tag"))
	}
	const s = supply.relation(internal("drawn group side"))
	const sideKey = sides.group.map((c) => col(s, c))
	ctes.push(
		cte(
			keys.name,
			select(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(keys.group, (c, i) =>
							targetAs(col(s, defined(sides.group[i], "a side key")), c)
						),
						targetAs(col(s, sides.tag), keys.tag),
						targetAs(
							{
								...call("first_value", [col(s, sides.tag)]),
								over: windowOf(sideKey, [asc(col(s, sides.tag))])
							},
							keys.first
						)
					],
					[cteRefAs(sides.name, s)],
					undefined
				)
			)
		)
	)
	return { members, keys }
}

/** Whether the host drew the group of a ranked key read as `alias` (`HostDrawn`): its partition's first tag the host's. */
const hostDrew = (host: HostDrawn, alias: string): Expr =>
	eq(col(alias, host.keys.first), lit.int(hostTag, types.integer))

/** Whether a ranked key read as `alias` is an appended row's group (`HostDrawn`), not the host's. */
const appendedSide = (host: HostDrawn, alias: string): Expr =>
	eq(col(alias, host.keys.tag), lit.int(appendedTag, types.integer))

/**
 * A counted family's scanned rows and its fresh groups' members as the host drew them, as one CTE of the scan's shape
 * (`FreshGroups`): the scan's rows, every group but the fresh ones, and the host's members of each fresh group
 * (`isFresh`, the host's drawing of each true), each its group, the slot and count the host drew it at from slot 0, and
 * every column of the scan's the host's members hold: the member's key, its group's fields and every column the family
 * draws. Each fresh group's kept count is read at the member's own group key (`keptAt`), the probe the groups read, so a
 * group is the scan's or the host's whole, and its members are the appended rows of it: a group holding no stored member
 * holds no stored repeat of one, which the appended rows leave out.
 */
const withHostDrawn = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	family: Family,
	host: HostDrawn,
	drawnColumns: ReadonlyArray<FillColumn>,
	scanned: Scanned,
	keptAt: (keys: ReadonlyArray<Expr>) => Expr
): Scanned => {
	const bigint = types.bigint
	const { members } = host
	const drawnType = new Map(drawnColumns.map((c) => [columnKey(c.column), c.type] as const))
	const union: Scanned = {
		...scanned,
		name: supply.relation(internal("drawn family scan")),
		columns: new Map([...scanned.columns].filter(([k]) => members.columns.has(k)))
	}
	const sc = supply.relation(internal("scanned row"))
	const h = supply.relation(internal("host drawn member"))
	const hostAt = (key: ColumnKey): Expr => col(h, columnAt(members, key))
	/** A column the family draws as the host drew it, cast to its type's base as the scan casts it. */
	const drawnAt = (key: ColumnKey): Expr =>
		cast(hostAt(key), w.cx.baseTypeRef(defined(drawnType.get(key), "a drawn column's type")))
	const hostGroup = family.group.map((g) => hostAt(columnKeyOf(g.member.name)))
	const columns = [...union.group, union.slot, union.first, union.count, ...union.columns.values()]
	const fromScan = provedCore(
		"keyed",
		columns.map((c) => targetAs(col(sc, c), c)),
		[cteRefAs(scanned.name, sc)],
		undefined
	)
	const fromHost = provedCore(
		"keyed",
		[
			...mapNonEmpty(union.group, (c, i) => targetAs(defined(hostGroup[i], "a group key"), c)),
			targetAs(cast(drawnAt(columnKey(family.shape.index)), bigint), union.slot),
			targetAs(lit.int(0, bigint), union.first),
			targetAs(cast(drawnAt(columnKey({ kind: "law", column: family.copy })), bigint), union.count),
			...[...union.columns].map(([k, c]) => targetAs(drawnType.has(k) ? drawnAt(k) : hostAt(k), c))
		],
		[cteRefAs(members.name, h)],
		isFresh(lit.bool(true), keptAt(hostGroup))
	)
	ctes.push(cte(union.name, select(unionAll("disjoint", [fromScan, fromHost]))))
	return union
}

/** Every field of a relation, key first, as its facts are returned. */
const keyFirstFields = (relation: RelationInfo): ReadonlyArray<LawField> => [
	...relation.primaryFields,
	...relation.heading.filter((f) => !relation.primaryFields.includes(f))
]

/** Every column of a member's row layout, key first (statements.ts rowLayout): what its insert writes. */
const layoutColumns = (member: AppendedMember): NonEmptyReadonlyArray<RowColumn> =>
	extendNonEmpty(member.layout.key, member.layout.columns)

/**
 * One source's appended rows of a member relation as its insert writes them, whole: each column its families draw from
 * their scans, each field its facts carry from them, and each count and end of a family the member owns at its start,
 * the family empty. A CTE of its own, which the member's probe (`probeGates`) and its insert (`insertOf`) read.
 */
const candidatesOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	d: Drawn,
	owned: ReadonlyArray<{ readonly family: Family; readonly scan: Scanned }>
): LaidRows => {
	const relation = d.member.relation
	const name = relation.name
	const a = supply.relation(internal("inserted fact"))
	const scans = d.scans.map((s) => ({ ...s, alias: supply.relation(internal("inserted scan")) }))
	const appendedKey = relation.primaryFields.map((f) =>
		col(a, columnAt(d.appended, columnKeyOf(f.name)))
	)
	const steps = scans.map((s): JoinStep => ({
		kind: "on",
		source: cteRefAs(s.scan.name, s.alias),
		on: and(
			mapNonEmpty(relation.primaryFields, (f, i) =>
				typedEq(
					f.type,
					col(s.alias, columnAt(s.scan, columnKeyOf(f.name))),
					defined(appendedKey[i], "a key column"),
					w.names
				)
			)
		)
	}))
	const from: FromItem = isNonEmpty(steps)
		? { kind: "joins", first: cteRefAs(d.appended.name, a), steps }
		: cteRefAs(d.appended.name, a)
	/** The families' drawn columns, each from the scan of the family that draws it. */
	const drawnBy = new Map<ColumnKey, Expr>()
	for (const s of scans) {
		const family = defined(
			d.member.families.find((f) => f.family === s.family),
			"a scanned family"
		)
		for (const c of family.drawn) {
			drawnBy.set(columnKey(c.column), col(s.alias, columnAt(s.scan, columnKey(c.column))))
		}
	}
	/** Each count and end of a counted family `owned` scans, which the row's appended members draw: the group's new count
	 * and its last member's column, where the scan appends to the row's group, else the row's own. */
	const recounted = new Map<ColumnKey, Expr>()
	for (const { family, scan } of owned) {
		/** The scan's last appended member of the row's group, read as `s`. */
		const at = (s: string): Expr =>
			and([
				...mapNonEmpty(family.group, (g, i) =>
					typedEq(
						g.owner.type,
						col(s, defined(scan.group[i], "a scan group column")),
						col(a, columnAt(d.appended, columnKeyOf(g.owner.name))),
						w.names
					)
				),
				eq(col(s, scan.slot), binary("-", col(s, scan.count), lit.int(1, types.bigint)))
			])
		/** The scan's value where it appends to the row's group, else the row's own: a drawn value is never NULL. */
		const fromLast = (key: ColumnKey, value: (s: string) => Expr): Expr => {
			const s = supply.relation(internal("owned scan"))
			return firstNonNull([
				{
					kind: "subquery",
					query: simpleSelect([target(value(s))], [cteRefAs(scan.name, s)], at(s))
				},
				col(a, columnAt(d.appended, key))
			])
		}
		recounted.set(
			columnKeyOf(family.count.name),
			fromLast(columnKeyOf(family.count.name), (s) => col(s, scan.count))
		)
		for (const p of family.axes.last) {
			if (p.from.kind === "field" && p.from.field.writing.kind === "accumulated") {
				const key = columnKey(p.from)
				recounted.set(
					key,
					fromLast(key, (s) => scannedValue(w, family.member, readAt(s, scan), p.to))
				)
			}
		}
	}
	const valueOf = (key: ColumnKey, field: LawField | undefined): Expr => {
		const drawnValue = drawnBy.get(key) ?? recounted.get(key)
		if (drawnValue !== undefined) {
			return drawnValue
		}
		const own = readAt(a, d.appended)(key)
		if (own !== undefined) {
			return own
		}
		const start = field === undefined ? undefined : startOf(w.names, field)
		if (start === undefined) {
			defect(`the column ${key} of ${name}, which an appended row is inserted with`)
		}
		return start
	}
	const columns = layoutColumns(d.member)
	const candidates = supply.relation(internal("candidate member"))
	const out = mapNonEmpty(columns, () => supply.column(internal("candidate member column")))
	ctes.push(
		cte(
			candidates,
			select(
				provedCore(
					"keyed",
					columns.map((c, i) =>
						targetAs(
							written(
								w,
								valueOf(c.key, c.column.kind === "field" ? c.column.field : undefined),
								c.type
							),
							defined(out[i], "a candidate column")
						)
					),
					[from],
					undefined
				)
			)
		)
	)
	return { name: candidates, columns: out }
}

/**
 * The gates of a member relation's inserts (statements.ts candidateGate) over its candidate rows, every source's
 * (`candidatesOf`): the probe at every other unique object where its inserts arbitrate its primary key
 * (`memberArbiter`), at every one, the primary key first, where they are plain INSERTs of rows no stored row repeats
 * (`appendedOf`), so a stated row that meets one is refused by its law with its own key there, a pair between two
 * sources' rows among them.
 */
const probeGates = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: AppendedMember,
	candidates: NonEmptyReadonlyArray<LaidRows>,
	arbiter: Arbiter
): ReadonlyArray<Expr> => {
	const [first, ...rest] = candidates
	const gate = candidateGate(
		w,
		supply,
		{
			relation: member.relation,
			layout: member.layout,
			uniques: member.uniques,
			arbiter
		},
		isNonEmpty(rest) ? candidatesUnion(supply, ctes, [first, ...rest]) : first
	)
	appendAll(ctes, gate.ctes)
	return gate.guards
}

/** The union of a member's sources' candidate rows, at every layout column, as its probe reads them. */
const candidatesUnion = (
	supply: NameSupply,
	ctes: Array<Cte>,
	candidates: NonEmptyReadonlyArray<LaidRows>
): LaidRows => {
	const name = supply.relation(internal("candidate union"))
	const columns = mapNonEmpty(candidates[0].columns, () =>
		supply.column(internal("candidate union column"))
	)
	ctes.push(
		cte(
			name,
			select(
				unionAll(
					"disjoint",
					mapNonEmpty(candidates, (c) => {
						const a = supply.relation(internal("candidate source"))
						return provedCore(
							"keyed",
							columns.map((out, i) =>
								targetAs(col(a, defined(c.columns[i], "a candidate column")), out)
							),
							[cteRefAs(c.name, a)],
							undefined
						)
					})
				)
			)
		)
	)
	return { name, columns }
}

/**
 * The insert of one source's candidate rows of a member relation (`candidatesOf`), gated by the member's probe
 * (`probeGates`). Where it arbitrates (`memberArbiter`), at SERIALIZABLE, ON CONFLICT DO NOTHING with no target, every
 * unique and exclusion object arbitrating, its primary key and its counted families' slot keys among them, over the
 * candidates the gates pass, so a conflict is a met row, never a 23505 or 23P01, and each appended row it did not
 * insert is classified in the statement (`metRefusal`): an exact repeat, its key's law, or a member joining a stored
 * closed owner's group, that family's law, which the statement raises (`refusals`).
 */
const insertOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	d: Drawn,
	candidates: LaidRows,
	gates: ReadonlyArray<Expr>,
	arbiter: Arbiter,
	refusals: Array<Expr>
): FamilyReturning => {
	const relation = d.member.relation
	const name = relation.name
	const columns = layoutColumns(d.member)
	const returned = keyFirstFields(relation).map((field) => ({
		field,
		alias: supply.column(internal("inserted returned"))
	}))
	const into = supply.relation(internal("inserted table"))
	const insert = supply.relation(internal("family insert"))
	const inserted = columns.map((c) => installed(w, name, c.column))
	const returning = returned.map((r) =>
		targetAs(col(into, w.names.column(name, r.field.name)), r.alias)
	)
	/** The candidates the gates pass, every column of `from` in layout order. */
	const passed = (from: LaidRows): Select =>
		select(
			provedCore(
				"keyed",
				from.columns.map((c) => target(col(from.name, c))),
				[cteRef(from.name)],
				conjunction(gates)
			)
		)
	switch (arbiter) {
		case "none":
			ctes.push(
				cte(insert, {
					kind: "insert",
					with: undefined,
					table: w.names.relation(name),
					alias: into,
					onConflict: undefined,
					columns: inserted,
					source: { kind: "query", query: passed(candidates) },
					returning
				})
			)
			break
		case "every": {
			/** The rows the arbitrated INSERT proposes, alone (sql/ast.ts FromSource `metRows`), by layout column: the
			 * candidates the gates pass. */
			const proposed: LaidRows = {
				name: supply.relation(internal("proposed member")),
				columns: mapNonEmpty(columns, () => supply.column(internal("proposed member column")))
			}
			ctes.push(cte(proposed.name, namedBody(passed(candidates), proposed.columns)))
			ctes.push(
				cte(insert, {
					kind: "insert",
					with: undefined,
					table: w.names.relation(name),
					alias: into,
					onConflict: { kind: "every", action: { kind: "doNothing" } },
					columns: inserted,
					source: {
						kind: "query",
						query: select(
							provedCore(
								"keyed",
								proposed.columns.map((c) => target(col(proposed.name, c))),
								[cteRef(proposed.name)],
								undefined
							)
						)
					},
					returning
				})
			)
			const columnOf = (key: ColumnKey): string | undefined => {
				const i = firstIndex(columns, (c) => c.key === key)
				return i === undefined ? undefined : proposed.columns[i]
			}
			refusals.push(
				metRefusal(w, supply, ctes, d, { insert, proposed: proposed.name, columnOf }, returned)
			)
			break
		}
	}
	return {
		cte: insert,
		columns: returned.map((r) => returnedColumn(col(insert, r.alias), rowType(r.field), r.alias)),
		relation: name,
		result: insertedResult(relation),
		rows: "facts"
	}
}

/**
 * The refusal of an arbitrated member insert's met rows (`insertOf`): the rows its INSERT `made.insert` proposed from
 * `made.proposed` and did not return (sql/ast.ts FromSource `metRows`), its guard, which the statement's rows read. The
 * INSERT arbitrates every object (ON CONFLICT DO NOTHING with no target) at SERIALIZABLE, where a conflicting row its
 * snapshot cannot see raises 40001, so every stored row it met is visible (sql/ast.ts FromSource `met`), and a met row is
 * exactly one of:
 * - a stored row at its primary key equal to it at every field `d`'s appended rows state: an exact repeat, no change;
 * - a stored row at its primary key unequal to it: its key's law, witnessed by its key;
 * - no stored row at its primary key, so it met a counted family's slot key, its group and hidden index, over a column
 *   the host drew from 0 for a group whose owner the stratum restates (FreshGroups `drawn`, scan.ts GroupState `base`):
 *   the group holds a stored member, a member joining a stored closed owner's family, which is refused on that family's
 *   own law, witnessed by the member's key (README "A closed owner's family is fixed when the owner is inserted"), the
 *   first such family in the member's order of its families (statements.ts memberFamilies), each read by one probe of
 *   the group for that row; or
 * - none of these: the statement's defect, as an insert's arbitration of every object raises it (write/refusal.ts
 *   ArmRefusal `defect`), since the gates probe every other object (`probeGates`) and the slot keys are the families'.
 * So the refusal is judged in the statement that meets it, and its witness is its key, with no second flight.
 */
const metRefusal = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	d: Drawn,
	made: {
		readonly insert: string
		readonly proposed: string
		readonly columnOf: (key: ColumnKey) => string | undefined
	},
	returned: ReadonlyArray<{ readonly field: LawField; readonly alias: string }>
): Expr => {
	const relation = d.member.relation
	const name = relation.name
	const pk = relation.primaryFields
	const proposedColumn = (f: LawField): string =>
		defined(made.columnOf(columnKeyOf(f.name)), `the proposed column of ${name}.${f.name}`)
	/** The INSERT's RETURNING of a field, which returns every field of the relation (`insertOf`). */
	const returnedOf = (f: LawField): string =>
		defined(
			returned.find((r) => r.field === f),
			`the returned column of ${name}.${f.name}`
		).alias
	const stated = relation.fields.filter(
		(f) =>
			d.appended.columns.has(columnKeyOf(f.name)) && statesColumn(d.source, columnKeyOf(f.name))
	)
	/** The member's counted families, each its group's fields on the member, which a met row is probed at. */
	const counted = d.member.families.flatMap(({ family }) =>
		family.shape.kind === "counted" ? [family] : []
	)
	const grouped = counted.flatMap((f) => f.group.map((g) => g.member))
	const read = [...pk, ...stated, ...grouped].filter((f, i, all) => all.indexOf(f) === i)
	const met = metRowsOf(w, supply, {
		insert: made.insert,
		proposed: made.proposed,
		columns: mapNonEmpty(extendNonEmpty(pk, read.slice(pk.length)), (f) => ({
			column: proposedColumn(f),
			returned: returnedOf(f)
		})),
		key: mapNonEmpty(pk, (f) => ({
			field: f,
			column: proposedColumn(f),
			returned: returnedOf(f)
		}))
	})
	/** The stored row of the member at `fields`, bound to the met row's values of them. */
	const metAt = (fields: NonEmptyReadonlyArray<LawField>): MetAccess => ({
		rows: met.alias,
		key: mapNonEmpty(fields, (f) => ({
			column: w.names.column(name, f.name),
			from: proposedColumn(f),
			schema: operatorSchemaOf(w.names, rowType(f))
		})),
		filter: () => [],
		placed: mapNonEmpty(fields, (f) => w.names.column(name, f.name))
	})
	/** The stored row met at the met row's primary key, which reaches one row, and its equality to the met row at every
	 * other field the appended rows state, checked over that row (probe.ts Equal). */
	const atKey = metAt(pk)
	const repeatEqual = stated
		.filter((f) => !pk.includes(f))
		.map((f): Equal => ({
			column: w.names.column(name, f.name),
			value: col(met.alias, proposedColumn(f)),
			type: rowType(f)
		}))
	/**
	 * Each met row with its class's facts, MATERIALIZED, so they are read for the met rows alone: a filter on them pushed
	 * below the met rows' anti-join would read the stored rows for every member the INSERT inserted. Whether the stored
	 * row at its key repeats it, whether one is there at all, and, for each counted family, whether its group holds a
	 * stored member.
	 */
	const classed = supply.relation(internal("met member class"))
	const classedKeys = mapNonEmpty(pk, () => supply.column(internal("met member key")))
	const repeated = supply.column(internal("met member repeat"))
	const keyed = supply.column(internal("met member at its key"))
	const joined = counted.map((family) => ({
		family,
		column: supply.column(internal("met member joins a stored group"))
	}))
	ctes.push({
		...cte(
			classed,
			select(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(pk, (f, i) =>
							targetAs(
								col(met.alias, proposedColumn(f)),
								defined(classedKeys[i], "a met key column")
							)
						),
						targetAs(metFound(w, supply, name, atKey, repeatEqual), repeated),
						targetAs(metFound(w, supply, name, atKey, []), keyed),
						...joined.map((j) =>
							targetAs(
								metFound(w, supply, name, metAt(mapNonEmpty(j.family.group, (g) => g.member)), []),
								j.column
							)
						)
					],
					[met.source],
					undefined
				)
			)
		),
		materialized: "MATERIALIZED"
	})
	const refused = supply.relation(internal("met member"))
	const refusedKeys = mapNonEmpty(pk, () => supply.column(internal("met member key")))
	const refusedKeyed = supply.column(internal("met member at its key"))
	const refusedJoined = joined.map(() => supply.column(internal("met member joins a stored group")))
	ctes.push(
		cte(
			refused,
			select(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(classedKeys, (key, i) =>
							targetAs(col(classed, key), defined(refusedKeys[i], "a met key column"))
						),
						targetAs(col(classed, keyed), refusedKeyed),
						...joined.map((j, i) =>
							targetAs(col(classed, j.column), defined(refusedJoined[i], "a joined column"))
						)
					],
					[cteRef(classed)],
					not(col(classed, repeated))
				)
			)
		)
	)
	/** The met member's key, which every arm witnesses it by. */
	const key = pk.map((f, i) => ({
		field: f.name,
		expr: col(refused, defined(refusedKeys[i], "a met key column")),
		type: rowType(f)
	}))
	const atNoKey = not(col(refused, refusedKeyed))
	const guarded = refusalGuard({
		supply,
		schema: w.names.schema,
		verdicts: refused,
		arms: [
			{
				rank: refusalRank.conflict,
				when: col(refused, refusedKeyed),
				refusal: { kind: "law", law: d.member.uniques.arbiter.law, relation: name, key }
			},
			...joined.map((j, i) => ({
				rank: refusalRank.conflict,
				when: and([
					atNoKey,
					col(refused, defined(refusedJoined[i], "a joined column")),
					...refusedJoined.slice(0, i).map((earlier) => not(col(refused, earlier)))
				]),
				refusal: { kind: "law" as const, law: j.family.law, relation: name, key }
			})),
			{
				rank: refusalRank.defect,
				when: and([atNoKey, ...refusedJoined.map((c) => not(col(refused, c)))]),
				refusal: {
					kind: "defect",
					relation: name,
					constraint: w.names.primaryKey(name),
					key
				}
			}
		]
	})
	ctes.push(guarded.cte)
	return guarded.guard
}

/** A recounted family of an owner relation: the scans of its appends, and the facts of the owner's put. */
interface Recounted {
	readonly family: Family
	readonly scans: Array<Scanned>
	readonly puts: Array<Shaped>
}

/**
 * The recount of a mutable owner relation's groups its families' appends join, or its put names: each family's count,
 * and each end, its last member's column: an appended group's from its scan, its new count and its last appended member;
 * a put owner's other group's as the removals leave it, its kept count `max(index) + 1` and its stored last member, or
 * the end's start where it has none. One UPDATE of the relation's rows whose count or end changes, every family keeping
 * its stored values where it recounts no group of the row.
 */
const recountOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	owner: RelationInfo,
	recounted: NonEmptyReadonlyArray<Recounted>
): FamilyReturning => {
	const name = owner.name
	const bigint = types.bigint
	const lasts = mapNonEmpty(recounted, ({ family, scans, puts }) => {
		const memberName = family.member.name
		const ends = family.axes.last.filter(
			(p) => p.from.kind === "field" && p.from.field.writing.kind === "accumulated"
		)
		const last = {
			name: supply.relation(internal("last member")),
			group: mapNonEmpty(family.group, () => supply.column(internal("last group key"))),
			count: supply.column(internal("last count")),
			columns: new Map(
				ends.map((p) => [columnKey(p.from), supply.column(internal("last column"))] as const)
			)
		}
		const index = installed(w, memberName, family.shape.index)
		const arms: Array<SetArm> = scans.map((scan) => {
			const sc = supply.relation(internal("last scanned"))
			return provedCore(
				"keyed",
				[
					...mapNonEmpty(last.group, (c, i) =>
						targetAs(col(sc, defined(scan.group[i], "a scan group column")), c)
					),
					targetAs(col(sc, scan.count), last.count),
					...ends.map((p) =>
						targetAs(
							scannedValue(w, family.member, readAt(sc, scan), p.to),
							columnAt(last, columnKey(p.from))
						)
					)
				],
				[cteRefAs(scan.name, sc)],
				eq(col(sc, scan.slot), binary("-", col(sc, scan.count), lit.int(1, bigint)))
			)
		})
		for (const facts of puts) {
			const p = supply.relation(internal("put owner"))
			const putKey = family.group.map((g) => col(p, columnAt(facts, columnKeyOf(g.owner.name))))
			const appended = scans.map((scan) => {
				const sc = supply.relation(internal("appended to"))
				return notExists(
					simpleSelect(
						[target(one)],
						[cteRefAs(scan.name, sc)],
						sameGroupExprs(w.names, family, putKey, sc, scan.group)
					)
				)
			})
			/** The put owner's group's stored last member, read by the probe of its group's last member. */
			const lastOf = () =>
				probeGroup(
					w,
					supply,
					memberName,
					"last",
					mapNonEmpty(family.group, (g, i) =>
						bound(w, memberName, g.member, defined(putKey[i], "a group key"))
					),
					[index],
					{ read: [index, ...ends.map((e) => installed(w, memberName, e.to))], filter: () => [] }
				)
			const stored = lastOf()
			arms.push(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(last.group, (c, i) => targetAs(defined(putKey[i], "a group key"), c)),
						targetAs(cast(binary("+", stored.at(index), lit.int(1, bigint)), bigint), last.count),
						...ends.map((e) =>
							targetAs(stored.at(installed(w, memberName, e.to)), columnAt(last, columnKey(e.from)))
						)
					],
					[cteRefAs(facts.name, p), stored.source],
					isNonEmpty(appended) ? and(appended) : undefined
				)
			)
			arms.push(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(last.group, (c, i) => targetAs(defined(putKey[i], "a group key"), c)),
						targetAs(lit.int(0, bigint), last.count),
						...ends.map((e) => {
							const type = defined(
								endColumns(family).find(
									(f) => columnKey({ kind: "field", field: f }) === columnKey(e.from)
								),
								"an end field"
							).type
							return targetAs(
								lowerLiteral(
									w.names,
									defined(
										baseLiteral(family, e.from),
										`the start of ${name}'s end ${columnKey(e.from)}`
									),
									type
								),
								columnAt(last, columnKey(e.from))
							)
						})
					],
					[cteRefAs(facts.name, p)],
					and([not(exists(simpleSelect([target(one)], [lastOf().source], undefined))), ...appended])
				)
			)
		}
		const [firstArm, ...restArms] = arms
		if (firstArm === undefined) {
			defect(`a recount of ${name}'s family ${family.id.count} with nothing to recount`)
		}
		ctes.push(cte(last.name, select(unionAll("disjoint", [firstArm, ...restArms]))))
		return { family, last }
	})
	const o = supply.relation(internal("recounted owner"))
	const ownerKey = (family: Family): ReadonlyArray<Expr> =>
		family.group.map((g) => col(o, w.names.column(name, g.owner.name)))
	/**
	 * Every recounted owner key with each family's recounted columns beside it, one row per key, which the UPDATE joins
	 * at the owner row's key and reads every column of at once: the one family's recount source itself, whose rows are
	 * its groups, one each; else every family's source as one UNION ALL, each row tagged with its family and holding its
	 * own family's columns and the others' bases, and over each key's partition, for each family, whether a row of it
	 * stands there (bool_or) and its columns (first_value with its own family's rows first). Each source is read once,
	 * never once per owner row and recounted column, no join pairs two sources, and no NULL stands for a family that
	 * recounts no group of the key: its flag is false, and the owner keeps its stored column.
	 */
	const row = supply.relation(internal("recount row"))
	const recount = ((): {
		readonly source: string
		/** The owner's key fields `source` holds, each with its column there. */
		readonly keys: NonEmptyReadonlyArray<HeldKey>
		readonly at: Expr
		readonly value: (
			x: { readonly family: Family; readonly last: PerGroup },
			column: string,
			stored: Expr
		) => Expr
	} => {
		const [only, ...others] = lasts
		if (!isNonEmpty(others)) {
			return {
				source: only.last.name,
				keys: mapNonEmpty(only.last.group, (column, i) => ({
					field: defined(only.family.group[i], "a group field").owner,
					column
				})),
				at: sameGroupExprs(w.names, only.family, ownerKey(only.family), row, only.last.group),
				value: (_, column, stored) => firstNonNull([col(row, column), stored])
			}
		}
		/** Each family's source columns, its count and its ends, each with the base its family starts it at. */
		const sourced = lasts.map((x) => ({
			...x,
			columns: [
				{ column: x.last.count, base: lit.int(0, bigint) },
				...[...x.last.columns].map(([key, column]) => {
					const field = defined(
						endColumns(x.family).find((f) => columnKeyOf(f.name) === key),
						`the end ${key} of ${name}`
					)
					return {
						column,
						base: lowerLiteral(
							w.names,
							defined(
								baseLiteral(x.family, { kind: "field", field }),
								`the start of ${name}'s end ${key}`
							),
							field.type
						)
					}
				})
			].map((c) => ({ ...c, side: supply.column(internal("recount side column")) }))
		}))
		const sides = supply.relation(internal("recount sides"))
		const sideKeys = mapNonEmpty(owner.primaryFields, () =>
			supply.column(internal("recount side key"))
		)
		const sideTag = supply.column(internal("recount side tag"))
		const arms = mapNonEmpty([only, ...others], (_, j): SetArm => {
			const x = defined(sourced[j], "a recounted family")
			const l = supply.relation(internal("recount source row"))
			return provedCore(
				"keyed",
				[
					...mapNonEmpty(sideKeys, (c, i) =>
						targetAs(col(l, defined(x.last.group[i], "a recounted group column")), c)
					),
					targetAs(lit.int(j, types.integer), sideTag),
					...sourced.flatMap((y) =>
						y.columns.map((c) => targetAs(y === x ? col(l, c.column) : c.base, c.side))
					)
				],
				[cteRefAs(x.last.name, l)],
				undefined
			)
		})
		ctes.push(cte(sides, select(unionAll("disjoint", arms))))
		const recounts = supply.relation(internal("recounts"))
		const keys = mapNonEmpty(owner.primaryFields, () => supply.column(internal("recounted key")))
		const s = supply.relation(internal("recount side"))
		const partition = sideKeys.map((c) => col(s, c))
		const joined = sourced.map((x, j) => {
			const mine = eq(col(s, sideTag), lit.int(j, types.integer))
			return {
				family: x.family,
				present: supply.column(internal("recounted family present")),
				presentValue: { ...call("bool_or", [mine]), over: windowOf(partition, []) },
				columns: new Map(
					x.columns.map((c) => [
						c.column,
						{
							as: supply.column(internal("recounted column")),
							value: {
								...call("first_value", [col(s, c.side)]),
								over: windowOf(partition, [asc(ne(col(s, sideTag), lit.int(j, types.integer)))])
							}
						}
					])
				)
			}
		})
		ctes.push(
			cte(
				recounts,
				select(
					distinctCore(
						[
							...mapNonEmpty(keys, (c, i) =>
								targetAs(col(s, defined(sideKeys[i], "a side key")), c)
							),
							...joined.flatMap((x) => [
								targetAs(x.presentValue, x.present),
								...[...x.columns.values()].map((c) => targetAs(c.value, c.as))
							])
						],
						[cteRefAs(sides, s)],
						undefined
					)
				)
			)
		)
		return {
			source: recounts,
			keys: mapNonEmpty(owner.primaryFields, (field, i) => ({
				field,
				column: defined(keys[i], "a recounted key")
			})),
			at: and(
				mapNonEmpty(owner.primaryFields, (f, i) =>
					typedEq(
						f.type,
						col(o, w.names.column(name, f.name)),
						col(row, defined(keys[i], "a recounted key")),
						w.names
					)
				)
			),
			value: (x, column, stored) => {
				const j = defined(
					joined.find((y) => y.family === x.family),
					"a recounted family"
				)
				return {
					kind: "case",
					operand: undefined,
					whens: [
						{
							when: col(row, j.present),
							result: col(row, defined(j.columns.get(column), "a recounted column").as)
						}
					],
					else: stored
				}
			}
		}
	})()
	return recountUpdate(w, supply, ctes, owner, o, lasts, recount.value, () => ({
		from: [cteRefAs(recount.source, row)],
		at: and([recount.at, ...keyedAmong(w, supply, name, o, recount.source, recount.keys)])
	}))
}
