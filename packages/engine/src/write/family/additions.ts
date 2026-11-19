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
 * A counted family's fresh groups are no scan's: a group whose owner the stratum inserts and which holds no stored
 * member, its kept count 0, is the call's whole, which the host drew, its owner's counts and ends and every member's
 * columns (runtime/write/bind.ts freshOwners), and the statement takes the host's members of it in the scan's place
 * (`HostDrawn`), so each group is drawn by one engine. Whether the host drew a group is read beside its kept count with no
 * join, and an exact repeat of a stored owner whose group holds stored members is the scan's, past them.
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
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { operatorSchemaOf, typedEq } from "#compiler/ir/compare.ts"
import { baseLiteral, type Family, isSequence } from "#compiler/ir/family.ts"
import type { FillColumn } from "#compiler/ir/fill.ts"
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
import type { Cte, Expr, FromItem, JoinStep, Select, SetArm } from "#compiler/sql/ast.ts"
import {
	and,
	arrays,
	asc,
	binary,
	call,
	cast,
	col,
	conjunction,
	cte,
	cteRef,
	cteRefAs,
	distinctCore,
	eq,
	exists,
	firstNonNull,
	join,
	lit,
	ne,
	not,
	notExists,
	provedCore,
	select,
	simpleSelect,
	target,
	targetAs,
	types,
	unionAll,
	windowOf
} from "#compiler/sql/build.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import {
	type Deferring,
	type DrawIn,
	type EditedMember,
	riderWrites
} from "#compiler/write/family/removals.ts"
import {
	type GroupState,
	type PerGroup,
	readAt,
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
	ownerReadsOf,
	type FamilyReturning,
	rowNumber,
	sameGroupExprs,
	shapedCte,
	type SlotReader,
	slotReader,
	recountUpdate,
	taggedRows,
	written
} from "#compiler/write/family/written.ts"
import type { MemberSlot } from "#compiler/write/frontend/compile.ts"
import type { CopySource, OwnerCopy } from "#compiler/write/frontend/schedule.ts"
import { primaryKeyShape } from "#compiler/write/frontend/targets.ts"
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
	probeGroup,
	probeKey,
	storedAt
} from "#compiler/write/probe.ts"
import { refusalGuard, refusalRank } from "#compiler/write/refusal.ts"

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
			}>
	  }
	| {
			readonly kind: "nestedRows"
			readonly stratum: StratumAt
			readonly layout: RowLayout
			readonly walked: ReadonlySet<ColumnKey>
	  }

/** Whether the rows of `source` state the column `key`, at which an appended row repeats a stored one: a slot's stated
 * fields (insert/input.ts RelationInput), and a nested row's every column the walk fills; never a column a counted
 * family draws, which its stored group holds. */
const statesColumn = (source: RowSource, key: ColumnKey): boolean =>
	source.kind === "slots"
		? source.slots.some(({ slot }) => slot.input.stated.some((c) => columnKeyOf(c.name) === key))
		: source.walked.has(key)

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
 *   the stratum's (ir/products.ts FilledRows `fresh`).
 */
export type FreshGroups =
	| { readonly kind: "none" }
	| { readonly kind: "drawn"; readonly stratum: StratumAt; readonly layout: LaidLayout }

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
	 * gives it at the member's position in the family, in fill order (ir/fill.ts FillLayout). */
	readonly families: ReadonlyArray<{
		readonly family: Family
		readonly drawn: ReadonlyArray<FillColumn>
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
		if (!owned.has(key)) {
			owned.set(key, { field, family, held })
		}
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
	ownerRows: ReadonlyMap<string, ReadonlyArray<OwnerRows>>,
	deferring: ReadonlyArray<Deferring>,
	relations: ReadonlyMap<string, RelationInfo>
): FamilyWriteSql => {
	const supply = new NameSupply(w.start)
	const params = new WriteParams()
	w.cx.beginWriteStatement(supply, params)
	const ctes: Array<Cte> = []
	const slots = slotReader(w, supply, ctes)
	/** Each relation's nested rows of the stratum, a CTE pushed at its first read and shared by every later one. */
	const nestedRead = new Map<string, Shaped>()
	const nested: NestedReader = (relation, source) => {
		const known = nestedRead.get(relation.name)
		if (known !== undefined) {
			return known
		}
		const rows = nestedRowsCte(w, supply, ctes, relation, source)
		nestedRead.set(relation.name, rows)
		return rows
	}
	/** The rows of an owner relation the stratum inserts whose copied columns the parameters hold (schedule.ts
	 * CopySource `held`), each source as this statement reads it: a slot's facts or the stratum's nested rows. */
	const ownerShapes = (owner: string): ReadonlyArray<Shaped> =>
		(ownerRows.get(owner) ?? []).map((rows) =>
			rows.kind === "slot"
				? slots(owner, rows.slot)
				: nested(defined(relations.get(owner), `the owner relation ${owner}`), rows)
		)
	/** Each member's scans, one per family, of the union of the sources the family draws. */
	const scanned: Array<{ readonly family: Family; readonly scan: Scanned }> = []
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
		for (const { family, drawn: columns, fresh } of ordered) {
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
				arbiter,
				fresh
			)
			scanned.push({ family, scan })
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
		const byFamily = owners.get(family.owner.name) ?? new Map<Family, Recounted>()
		owners.set(family.owner.name, byFamily)
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
	const [firstReturning, ...restReturnings] = [...recounts, ...inserts, ...riding]
	if (firstReturning === undefined) {
		throw defect("a family additions statement appends or recounts a put owner")
	}
	return taggedRows(supply, ctes, [firstReturning, ...restReturnings], params, refusals)
}

/**
 * The key a member relation's appends arbitrate (statements.ts Arbiter): its primary key, each family's group drawn from
 * its base (scan.ts GroupState) and each stored repeat met at its key by the insert (`insertOf`), at SERIALIZABLE, where
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
		? "primaryKey"
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
			[...next.columns.values()],
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
					case "primaryKey":
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
					...owned.keys()
				])
			]
			const appended = shapedCte(supply, "appended member", keys)
			const arms = mapNonEmpty(source.slots, ({ as, slot }) => {
				const compared =
					as === "inserts"
						? slot.input.stated.map(fieldOf)
						: member.relation.primaryFields.map(fieldOf)
				const [first, ...rest] = compared
				if (first === undefined) {
					throw defect(`the fields of ${name}'s slot, which holds its key`)
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
			ctes.push(
				cte(appended.name, [...appended.columns.values()], select(unionAll("disjoint", arms)))
			)
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
				throw defect(`the fields of ${name}'s nested rows`)
			}
			ctes.push(
				cte(
					appended.name,
					[...appended.columns.values()],
					select(unstored(sent, [first, ...rest], appended, (a, k) => col(a, columnAt(sent, k))))
				)
			)
			return appended
		}
	}
}

/** A reader of a stratum's nested rows of a relation, each relation's CTE pushed once (`nestedRowsCte`). */
type NestedReader = (relation: RelationInfo, source: NestedSent) => Shaped

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
			[...rows.columns.values()],
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
			[...union.columns.values()],
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
			)
		)
	)
	return union
}

/**
 * The scan of `family` over a member relation's `appended` rows (see the header): the groups they join with their
 * kept counts, their seeds, the appended rows at their slots with their owners' columns, and the scan itself, each a
 * CTE pushed onto `ctes`.
 */
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
	arbiter: Arbiter,
	fresh: FreshGroups
): Scanned => {
	/** Each group's state before its drawn members (scan.ts GroupState): its base where the insert arbitrates, its stored
	 * members where a probe reads them (`memberArbiter`). */
	const state = ((): GroupState["kind"] => {
		switch (arbiter) {
			case "primaryKey":
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
	/** The owner reads whose copies are `held` (schedule.ts CopySource), which the owner's rows the stratum inserts hold. */
	const heldReads = [...ownerReads].filter(
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
						[...copies.group, ...copies.columns.values()],
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
			[...ownerReads.keys()].map((k) => [k, supply.column(internal("group owner column"))] as const)
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
					host: hostDrawnOf(w, supply, ctes, member, family, fresh, appended),
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
					[...ownerReads.keys()].map(
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
			[...fallen.group, fallen.kept, ...fallenDrawn, ...fallen.columns.values()],
			select(
				distinctCore(
					[
						...mapNonEmpty(fallen.group, (c, i) => targetAs(defined(g0Keys[i], "a group key"), c)),
						targetAs(keptAt(g0Keys), fallen.kept),
						...fallenDrawnTargets,
						...[...ownerReads].map(([k, read]) =>
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
				[...ownerReads.keys()].map(
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
				[
					...sides.group,
					sides.tag,
					sides.kept,
					...drawnLane.map((d) => d.side),
					...sides.columns.values()
				],
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
											? baseOf(defined(ownerReads.get(k), "an owner read"))
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
			[...ownerReads.keys()].map((k) => [k, supply.column(internal("group owner value"))] as const)
		)
		const rankedGroup = mapNonEmpty(family.group, () => supply.column(internal("group owners key")))
		const rankedTag = supply.column(internal("group owners tag"))
		const rankedKept = supply.column(internal("group owners kept count"))
		const s = supply.relation(internal("group owner side"))
		const sideKey = sides.group.map((c) => col(s, c))
		ctes.push(
			cte(
				ranked,
				[
					...rankedGroup,
					rankedTag,
					rankedKept,
					...drawnLane.map((d) => d.ranked),
					...rankedColumns.values()
				],
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
				[...groups.group, groups.kept, ...drawnLane.map((d) => d.groups), ...groups.owner.values()],
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
	/** The appended rows at their slots, each with its group's first drawn slot, its new count and its owner's columns,
	 * drawn from each group's kept count: its seed the stored member before it. */
	const scanned = drawnScan(w, supply, ctes, {
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
						...mapNonEmpty(rows.group, (c, i) => targetAs(defined(aGroup[i], "a group key"), c)),
						targetAs(
							cast(
								binary("-", binary("+", kept, rowNumber(aGroup, aKey)), lit.int(1, bigint)),
								bigint
							),
							rows.slot
						),
						targetAs(kept, rows.first),
						targetAs(cast(binary("+", kept, countOver(aGroup)), bigint), rows.count),
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
					groupRead.kind === "ranked"
						? not(isFresh(col(g2, groupRead.drawn.groups), kept))
						: undefined
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
	appended: Shaped
): HostDrawn => {
	const members = filledRowsCte(
		w,
		supply,
		ctes,
		member.relation,
		fresh.stratum,
		{ kind: "fresh", family: familyKey(family.id) },
		[...fresh.layout.key, ...fresh.layout.columns]
	)
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
			[...sides.group, sides.tag],
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
			[...keys.group, keys.tag, keys.first],
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
	ctes.push(cte(union.name, columns, select(unionAll("disjoint", [fromScan, fromHost]))))
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
			throw defect(`the column ${key} of ${name}, which an appended row is inserted with`)
		}
		return start
	}
	const columns = layoutColumns(d.member)
	const candidates = supply.relation(internal("candidate member"))
	const out = mapNonEmpty(columns, () => supply.column(internal("candidate member column")))
	ctes.push(
		cte(
			candidates,
			out,
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
			columns,
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
 * (`probeGates`). Where it arbitrates its primary key (`memberArbiter`), ON CONFLICT at its primary key DO NOTHING, by the key's
 * constraint where it holds a span, which no column list infers, over the candidates the gates pass, and each
 * appended row it did not insert, a met row, is an exact repeat where the stored row the arbitration met at its key
 * (probe.ts metFound) equals it at every field it states, and else its key's law, which the statement raises
 * (`refusals`).
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
				cte(insert, [], {
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
		case "primaryKey": {
			/** The rows the arbitrated INSERT proposes, alone (sql/ast.ts FromSource `metRows`), by layout column: the
			 * candidates the gates pass. */
			const proposed: LaidRows = {
				name: supply.relation(internal("proposed member")),
				columns: mapNonEmpty(columns, () => supply.column(internal("proposed member column")))
			}
			ctes.push(cte(proposed.name, proposed.columns, passed(candidates)))
			ctes.push(
				cte(insert, [], {
					kind: "insert",
					with: undefined,
					table: w.names.relation(name),
					alias: into,
					onConflict:
						primaryKeyShape(relation).kind === "span"
							? {
									kind: "constraint",
									constraint: w.names.primaryKey(name),
									action: { kind: "doNothing" }
								}
							: {
									kind: "columns",
									columns: mapNonEmpty(relation.primaryFields, (f) => w.names.column(name, f.name)),
									action: { kind: "doNothing" }
								},
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
 * `made.proposed` and did not return (sql/ast.ts FromSource `metRows`), each the stored row its arbitration met at its
 * key unequal to it at some field `d`'s appended rows state, which raises its key's law; its guard, which the
 * statement's rows read. Every stored row it met is visible (sql/ast.ts FromSource `met`).
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
	const met = metRowsOf(w, supply, {
		insert: made.insert,
		proposed: made.proposed,
		columns: mapNonEmpty(
			extendNonEmpty(
				pk,
				stated.filter((f) => !pk.includes(f))
			),
			(f) => ({ column: proposedColumn(f), returned: returnedOf(f) })
		),
		key: mapNonEmpty(pk, (f) => ({
			field: f,
			column: proposedColumn(f),
			returned: returnedOf(f)
		}))
	})
	/** The stored row met at the met row's primary key, which reaches one row, and its equality to the met row at every
	 * other field the appended rows state, checked over that row (probe.ts Equal). */
	const repeat: MetAccess = {
		rows: met.alias,
		key: mapNonEmpty(pk, (f) => ({
			column: w.names.column(name, f.name),
			from: proposedColumn(f),
			schema: operatorSchemaOf(w.names, rowType(f))
		})),
		filter: () => [],
		placed: mapNonEmpty(pk, (f) => w.names.column(name, f.name))
	}
	const repeatEqual = stated
		.filter((f) => !pk.includes(f))
		.map((f): Equal => ({
			column: w.names.column(name, f.name),
			value: col(met.alias, proposedColumn(f)),
			type: rowType(f)
		}))
	/** Each met row with whether the stored row met at its key repeats it, MATERIALIZED, so the repeat is read for the
	 * met rows alone: a filter on it pushed below the met rows' anti-join would read the stored rows for every member the
	 * INSERT inserted. */
	const classed = supply.relation(internal("met member class"))
	const classedKeys = mapNonEmpty(pk, () => supply.column(internal("met member key")))
	const repeated = supply.column(internal("met member repeat"))
	ctes.push({
		...cte(
			classed,
			[...classedKeys, repeated],
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
						targetAs(metFound(w, supply, name, repeat, repeatEqual), repeated)
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
	ctes.push(
		cte(
			refused,
			refusedKeys,
			select(
				provedCore(
					"keyed",
					mapNonEmpty(classedKeys, (key, i) =>
						targetAs(col(classed, key), defined(refusedKeys[i], "a met key column"))
					),
					[cteRef(classed)],
					not(col(classed, repeated))
				)
			)
		)
	)
	const guarded = refusalGuard({
		supply,
		schema: w.names.schema,
		verdicts: refused,
		arms: [
			{
				rank: refusalRank.conflict,
				when: lit.bool(true),
				refusal: {
					kind: "law",
					law: d.member.uniques.arbiter.law,
					relation: name,
					key: pk.map((f, i) => ({
						field: f.name,
						expr: col(refused, defined(refusedKeys[i], "a met key column")),
						type: rowType(f)
					}))
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
			throw defect(`a recount of ${name}'s family ${family.id.count} with nothing to recount`)
		}
		ctes.push(
			cte(
				last.name,
				[...last.group, last.count, ...last.columns.values()],
				select(unionAll("disjoint", [firstArm, ...restArms]))
			)
		)
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
		const sideColumns = sourced.flatMap((x) => x.columns.map((c) => c.side))
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
		ctes.push(
			cte(sides, [...sideKeys, sideTag, ...sideColumns], select(unionAll("disjoint", arms)))
		)
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
				[
					...keys,
					...joined.flatMap((x) => [x.present, ...[...x.columns.values()].map((c) => c.as)])
				],
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
		at: recount.at
	}))
}
