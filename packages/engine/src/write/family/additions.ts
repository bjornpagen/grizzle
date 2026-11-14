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
 * The appended rows are inserted whole, each with every family's columns. Each mutable owner they join, and each the
 * stratum puts whose groups its edits touch, whose recount the removals leave to this statement after the put, is
 * recounted by one UPDATE of its relation, where its count or an end changes: each family's count, and each end from
 * its last member, which the owner axis cascades into its stored members at the statement's end; a stratum that
 * appends nothing still writes this statement for those puts. An owner the stratum inserts
 * carries its counts and ends in its own insert, which its appends meet (write/program/bind.ts), and an immutable
 * owner's family is fixed when it is inserted, so no role holds UPDATE on it and this statement writes none.
 * Immediate foreign keys are checked at the statement's end, so a member and its owner's new count are judged together.
 *
 * The statement returns each recounted owner's count and ends after and before, and then the facts it inserted, each
 * part's rows behind its tag, which the outcome reads as a family statement's. PostgreSQL runs a data-modifying CTE as
 * the statement reads its rows, so every recount runs before any insert: a write appending to a stored group writes its
 * owner's row first, and of two writes appending to one group at once the later meets that row and fails with 40001,
 * never at the (group, index) key both drew from their snapshots, as the family planner's count statement before its
 * inserts did.
 */
import { appendAll } from "#compiler/core/array.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import {
	appendNonEmpty,
	extendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { operatorSchemaOf, typedEq } from "#compiler/ir/compare.ts"
import { baseLiteral, type Family, isSequence } from "#compiler/ir/family.ts"
import type { FillColumn } from "#compiler/ir/fill.ts"
import { familyKey, type LawField, type NativeColumn, type RelationInfo } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import {
	arraysSource,
	relationColumns,
	unchecked,
	WriteParams
} from "#compiler/lower/conservative/context.ts"
import { lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import { type ColumnKey, columnKey, fieldKey } from "#compiler/runtime/write/fill.ts"
import type {
	Assignment,
	Cte,
	Expr,
	FromItem,
	JoinStep,
	Select,
	SetArm
} from "#compiler/sql/ast.ts"
import {
	and,
	arrays,
	binary,
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
	not,
	notExists,
	provedCore,
	select,
	simpleSelect,
	target,
	targetAs,
	types,
	unionAll
} from "#compiler/sql/build.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import {
	type GroupState,
	type PerGroup,
	readAt,
	type Scanned,
	type ScanRows,
	scannedValue,
	scanOf,
	type Shaped
} from "#compiler/write/family/scan.ts"
import {
	candidateGate,
	endColumns,
	type LaidRows,
	type RowColumn,
	type RowLayout
} from "#compiler/write/family/statements.ts"
import {
	columnAt,
	countOver,
	type FamilyWriteSql,
	insertedResult,
	installed,
	internal,
	one,
	recountFields,
	type FamilyReturning,
	rowNumber,
	sameGroupExprs,
	shapedCte,
	type SlotReader,
	slotReader,
	taggedRows,
	updatedResult,
	updateReturning,
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
	bound,
	metFound,
	metNarrowed,
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
 *   appends to it would leave a fresh owner (write/program/bind.ts freshOwners), and where it is stored, they are its
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
		? source.slots.some(({ slot }) => slot.input.stated.some((c) => fieldKey(c.name) === key))
		: source.walked.has(key)

/** A source of the rows of an owner relation the stratum inserts that an additions statement reads an owner copy from
 * (schedule.ts CopySource `held`): one of its slots' stated facts, or the stratum's nested rows of it. */
export type OwnerRows =
	| { readonly kind: "slot"; readonly slot: MemberSlot }
	| Extract<RowSource, { readonly kind: "nestedRows" }>

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
	}>
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
		const arbitrated = memberArbitrated(w, member)
		const sources = member.sources.map((source) => ({
			source,
			appended: appendedOf(w, supply, ctes, member, source, slots, nested, arbitrated),
			scans: new Array<{ readonly family: Family; readonly scan: Scanned }>()
		}))
		/** Each source's rows with every column the families scanned so far drew. */
		const rows = new Map(sources.map((x) => [x, x.appended] as const))
		/** The member's sequence first, each family after reading the rows with every column the families before it
		 * drew: a counted family's fold may step or select the copy a sequence's owner axis gives the member. */
		const ordered = member.families.toSorted(
			(a, b) => Number(!isSequence(a.family)) - Number(!isSequence(b.family))
		)
		for (const { family, drawn: columns } of ordered) {
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
				arbitrated ? "base" : "stored"
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
		const arbitrated = memberArbitrated(w, member)
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
			arbitrated
		)
		return candidates.map(({ d, rows }) =>
			insertOf(w, supply, ctes, d, rows, gates, arbitrated, refusals)
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
	const [firstReturning, ...restReturnings] = [...recounts, ...inserts]
	if (firstReturning === undefined) {
		throw defect("a family additions statement appends or recounts a put owner")
	}
	return taggedRows(supply, ctes, [firstReturning, ...restReturnings], params, refusals)
}

/**
 * Whether a member relation's appends meet stored rows by its insert's arbitration (`insertOf`), each family's group at
 * its base (scan.ts GroupState): at SERIALIZABLE, where every family of it is immutable, written whole with its owner,
 * and it is appended from no put slot, so the statement reads no stored row of a group for the members it inserts; a
 * mutable family's group and a put's member are read where a probe reaches them.
 */
const memberArbitrated = (w: WriteContext, member: AppendedMember): boolean =>
	w.level === "serializable" &&
	member.families.every(({ family }) => !family.owner.mutable) &&
	member.sources.every(
		(source) => source.kind === "nestedRows" || source.slots.every(({ as }) => as === "inserts")
	)

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
										col(s, columnAt(scan, fieldKey(f.name))),
										col(a, columnAt(rows, fieldKey(f.name))),
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
 */
const appendedOf = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: AppendedMember,
	source: RowSource,
	slots: SlotReader,
	nested: NestedReader,
	arbitrated: boolean
): Shaped => {
	const name = member.relation.name
	/** The arm of `facts`' rows no stored row repeats at `compared`, each of the appended CTE's columns, read by the
	 * probe of the member at those columns (probe.ts storedAt); every one of them where the member's insert is
	 * arbitrated (`memberArbitrated`), which meets each stored repeat at its key. */
	const unstored = (
		facts: Shaped,
		compared: NonEmptyReadonlyArray<{
			readonly key: ColumnKey
			readonly column: NativeColumn
			readonly type: ScalarType
		}>,
		appended: Shaped
	): SetArm => {
		const a = supply.relation(internal("appended fact"))
		const repeated = (): Expr =>
			storedAt(w, supply, name, {
				key: mapNonEmpty(compared, (c) => ({
					column: installed(w, name, c.column),
					value: col(a, columnAt(facts, c.key)),
					schema: operatorSchemaOf(w.names, c.type)
				})),
				filter: () => [],
				placed: mapNonEmpty(compared, (c) => installed(w, name, c.column))
			})
		return provedCore(
			"input",
			[...appended.columns.keys()].map((k) =>
				targetAs(col(a, columnAt(facts, k)), columnAt(appended, k))
			),
			[cteRefAs(facts.name, a)],
			arbitrated ? undefined : not(repeated())
		)
	}
	const fieldOf = (field: { readonly name: string; readonly type: ScalarType }) => {
		const law = defined(
			member.relation.fields.find((f) => f.name === field.name),
			`the field ${field.name} of ${name}`
		)
		return {
			key: fieldKey(field.name),
			column: { kind: "field" as const, field: law },
			type: field.type
		}
	}
	switch (source.kind) {
		case "slots": {
			const keys = source.slots[0].slot.heading.map((c) => fieldKey(c.name))
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
				return unstored(slots(name, slot), [first, ...rest], appended)
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
					select(unstored(sent, [first, ...rest], appended))
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
 * its column's type as a write stores it, by key. */
export const nestedRowsCte = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	relation: RelationInfo,
	source: NestedSent
): Shaped => {
	const columns = [...source.layout.key, ...source.layout.columns]
	const origin = internal("nested rows")
	const placeholders = w.cx.nestedRows(
		source.stratum,
		relation.name,
		() =>
			relationColumns(
				columns.map((c) => ({ name: c.key, type: c.type })),
				() => supply.column(origin),
				(t) => w.cx.baseTypeRef(t),
				unchecked
			),
		`a family write of ${relation.name}'s nested rows`
	)
	const raw = supply.relation(origin)
	const arrayColumn = new Map(
		placeholders[0].columns.map((c) => [c.name, c.definition.name] as const)
	)
	const rows = shapedCte(
		supply,
		"nested row",
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
							written(w, col(raw, defined(arrayColumn.get(c.key), "a nested rows' array")), c.type),
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
	state: GroupState["kind"]
): Scanned => {
	const bigint = types.bigint
	const name = member.relation.name
	const owner = family.owner
	const groupKeys = family.group.map((g) => fieldKey(g.member.name))
	const memberGroup = (alias: string, shape: Shaped): ReadonlyArray<Expr> =>
		groupKeys.map((k) => col(alias, columnAt(shape, k)))
	const index = installed(w, name, family.index)
	/** The member's group columns bound to `keys`, a group's values in order. */
	const groupAt = (keys: ReadonlyArray<Expr>) =>
		mapNonEmpty(family.group, (g, i) => bound(w, name, g.member, defined(keys[i], "a group key")))
	/** The groups the appends join, each with its kept count: 0 at `base`; else its stored last member's slot plus one,
	 * read by the probe of its group's last member (probe.ts probeGroup `last`), 0 where it holds none. */
	const groups = {
		name: supply.relation(internal("appended group")),
		group: mapNonEmpty(family.group, () => supply.column(internal("appended group key"))),
		kept: supply.column(internal("kept count"))
	}
	const g0 = supply.relation(internal("appended group row"))
	const g0Keys = memberGroup(g0, appended)
	const storedKept = (): Expr => {
		const last = probeGroup(w, supply, name, "last", groupAt(g0Keys), [index], {
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
	ctes.push(
		cte(
			groups.name,
			[...groups.group, groups.kept],
			select(
				distinctCore(
					[
						...mapNonEmpty(groups.group, (c, i) => targetAs(defined(g0Keys[i], "a group key"), c)),
						targetAs(
							state === "base" ? lit.int(0, bigint) : cast(storedKept(), bigint),
							groups.kept
						)
					],
					[cteRefAs(appended.name, g0)],
					undefined
				)
			)
		)
	)
	/** Each group's seed at `stored`: its stored member at the kept count less one, with every column a predecessor rule
	 * reads, read by the probe of the member at that slot of its group. */
	const seedReads = new Map<ColumnKey, NativeColumn>(
		drawnColumns.flatMap((c) =>
			c.rule.kind === "predecessor" ? [[columnKey(c.rule.to), c.rule.to] as const] : []
		)
	)
	const storedSeed = (): PerGroup => {
		const seed: PerGroup = {
			name: supply.relation(internal("seed")),
			group: mapNonEmpty(family.group, () => supply.column(internal("seed group key"))),
			columns: new Map(
				[...seedReads.keys()].map((k) => [k, supply.column(internal("seed column"))] as const)
			)
		}
		const g1 = supply.relation(internal("seeded group"))
		const g1Keys = groups.group.map((c) => col(g1, c))
		const reads = [...seedReads.values()].map((column) => installed(w, name, column))
		const seedMember = probeKey(
			w,
			supply,
			name,
			{
				key: appendNonEmpty(groupAt(g1Keys), {
					column: index,
					value: binary("-", col(g1, groups.kept), lit.int(1, bigint)),
					schema: undefined
				}),
				filter: () => [],
				placed: appendNonEmpty(
					mapNonEmpty(family.group, (g) => w.names.column(name, g.member.name)),
					index
				)
			},
			[index, ...reads]
		)
		ctes.push(
			cte(
				seed.name,
				[...seed.group, ...seed.columns.values()],
				select(
					provedCore(
						"keyed",
						[
							...mapNonEmpty(seed.group, (c, i) =>
								targetAs(col(g1, defined(groups.group[i], "a group column")), c)
							),
							...[...seedReads].map(([k, column]) =>
								targetAs(seedMember.at(installed(w, name, column)), columnAt(seed, k))
							)
						],
						[cteRefAs(groups.name, g1), seedMember.source],
						undefined
					)
				)
			)
		)
		return seed
	}
	const group: GroupState =
		state === "base" ? { kind: "base" } : { kind: "stored", seed: storedSeed() }
	/** The appended rows at their slots, each with its group's first drawn slot, its new count and its owner's columns. */
	const ownerReads = new Map(
		drawnColumns.flatMap((c) =>
			c.rule.kind === "ownerCopy"
				? [[columnKey(c.rule.to), { to: c.rule.to, from: c.column, type: c.type }] as const]
				: []
		)
	)
	const rows: ScanRows = {
		name: supply.relation(internal("appended rows")),
		group: mapNonEmpty(family.group, () => supply.column(internal("row group key"))),
		slot: supply.column(internal("row slot")),
		first: supply.column(internal("row first slot")),
		count: supply.column(internal("row count")),
		columns: new Map(
			[...appended.columns.keys()].map((k) => [k, supply.column(internal("row column"))] as const)
		),
		owner: new Map(
			[...ownerReads.keys()].map((k) => [k, supply.column(internal("row owner column"))] as const)
		)
	}
	const a = supply.relation(internal("appended row"))
	const g2 = supply.relation(internal("row group"))
	const aGroup = memberGroup(a, appended)
	const aKey = member.relation.primaryFields.map((f) =>
		col(a, columnAt(appended, fieldKey(f.name)))
	)
	/**
	 * An appended row's copy of an owner column, from where the copy reads it (schedule.ts CopySource): a `held` copy the
	 * owner's row among those the stratum inserts, which the statement's parameters hold, else the stored owner's; a
	 * `stored` or `drawn` copy the stored owner's alone, a drawn one's owner written by an earlier statement. A group
	 * that names no owner at all takes the copy's base, so its row is inserted and the family's owner axis refuses it at
	 * the statement's end, as it refuses any member naming no owner. Read as COALESCE, since an owner's column is never
	 * NULL (rule 0).
	 */
	const ownerValue = (read: {
		readonly to: NativeColumn
		readonly from: NativeColumn
		readonly type: LawField["type"]
	}): Expr => {
		const base = defined(
			baseLiteral(family, read.from),
			`the base of ${name}'s owner copy ${columnKey(read.from)}, an accumulated column`
		)
		/** The stored owner's column, read by the probe of the owner at the row's group (`reads`). */
		const stored = (): Expr => {
			const ownerRow = probeKey(
				w,
				supply,
				owner.name,
				{
					key: mapNonEmpty(family.group, (g, i) =>
						bound(w, owner.name, g.owner, defined(aGroup[i], "a group key"))
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
		/** The owner among rows the stratum inserts, which the statement's parameters hold: its column, or a generated
		 * field's generation over the fields it reads (scan.ts scannedValue). */
		const inserted = (owners: Shaped): Expr => {
			const n = supply.relation(internal("inserted owner"))
			return {
				kind: "subquery",
				query: simpleSelect(
					[target(cast(scannedValue(w, owner, n, owners, read.to), w.cx.baseTypeRef(read.type)))],
					[cteRefAs(owners.name, n)],
					and(
						mapNonEmpty(family.group, (g, i) =>
							typedEq(
								g.owner.type,
								col(n, columnAt(owners, fieldKey(g.owner.name))),
								defined(aGroup[i], "a group key"),
								w.names
							)
						)
					)
				)
			}
		}
		const source = copySource(columnKey(read.from))
		const held = source === "held" ? ownerShapes().map(inserted) : []
		/** The stored owner is read where the group's state is stored, and at `base` where the copy is `drawn`: the
		 * owner's own earlier statement of this call wrote the column, which only its row holds. At `base` a `held` copy
		 * reads the call's own rows, and a `stored` one none, its owner stored, so the family's owner axis refuses the
		 * append whatever the copy is. */
		const reads = state === "stored" || source === "drawn" ? appendNonEmpty(held, stored()) : held
		return firstNonNull(appendNonEmpty(reads, lowerLiteral(w.names, base, read.type)))
	}
	const kept = col(g2, groups.kept)
	ctes.push(
		cte(
			rows.name,
			[
				...rows.group,
				rows.slot,
				rows.first,
				rows.count,
				...rows.columns.values(),
				...rows.owner.values()
			],
			select(
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
						...[...ownerReads].map(([k, read]) =>
							targetAs(ownerValue(read), defined(rows.owner.get(k), "an owner column"))
						)
					],
					[
						join(
							cteRefAs(appended.name, a),
							cteRefAs(groups.name, g2),
							sameGroupExprs(w.names, family, aGroup, g2, groups.group)
						)
					],
					undefined
				)
			)
		)
	)
	const scan = scanOf(w, supply, {
		family,
		member: member.relation,
		drawn: drawnColumns,
		rows,
		group
	})
	ctes.push(scan.cte)
	return scan.rows
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
		col(a, columnAt(d.appended, fieldKey(f.name)))
	)
	const steps = scans.map((s): JoinStep => ({
		kind: "on",
		source: cteRefAs(s.scan.name, s.alias),
		on: and(
			mapNonEmpty(relation.primaryFields, (f, i) =>
				typedEq(
					f.type,
					col(s.alias, columnAt(s.scan, fieldKey(f.name))),
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
						col(a, columnAt(d.appended, fieldKey(g.owner.name))),
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
			fieldKey(family.count.name),
			fromLast(fieldKey(family.count.name), (s) => col(s, scan.count))
		)
		for (const p of family.axes.last) {
			if (p.from.kind === "field" && p.from.field.writing.kind === "accumulated") {
				const key = columnKey(p.from)
				recounted.set(
					key,
					fromLast(key, (s) => scannedValue(w, family.member, s, scan, p.to))
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
 * (`memberArbitrated`), at every one, the primary key first, where they are plain INSERTs of rows no stored row repeats
 * (`appendedOf`), so a stated row that meets one is refused by its law with its own key there, a pair between two
 * sources' rows among them.
 */
const probeGates = (
	w: WriteContext,
	supply: NameSupply,
	ctes: Array<Cte>,
	member: AppendedMember,
	candidates: NonEmptyReadonlyArray<LaidRows>,
	arbitrated: boolean
): ReadonlyArray<Expr> => {
	const [first, ...rest] = candidates
	const gate = candidateGate(
		w,
		supply,
		{
			relation: member.relation,
			layout: member.layout,
			uniques: member.uniques,
			arbiter: arbitrated ? "primaryKey" : "none"
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
 * (`probeGates`). Where it is arbitrated (`memberArbitrated`), ON CONFLICT at its primary key DO NOTHING, by the key's
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
	arbitrated: boolean,
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
	if (!arbitrated) {
		ctes.push(
			cte(insert, [], {
				kind: "insert",
				with: undefined,
				table: w.names.relation(name),
				alias: into,
				overriding: undefined,
				onConflict: undefined,
				columns: inserted,
				source: { kind: "query", query: passed(candidates) },
				returning
			})
		)
	} else {
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
				overriding: undefined,
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
			const i = columns.findIndex((c) => c.key === key)
			return i < 0 ? undefined : proposed.columns[i]
		}
		refusals.push(
			metRefusal(w, supply, ctes, d, { insert, proposed: proposed.name, columnOf }, returned)
		)
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
		defined(made.columnOf(fieldKey(f.name)), `the proposed column of ${name}.${f.name}`)
	const stated = relation.fields.filter(
		(f) => d.appended.columns.has(fieldKey(f.name)) && statesColumn(d.source, fieldKey(f.name))
	)
	const met = metRowsOf(w, supply, {
		insert: made.insert,
		proposed: made.proposed,
		columns: mapNonEmpty(
			extendNonEmpty(
				pk,
				stated.filter((f) => !pk.includes(f))
			),
			proposedColumn
		),
		key: mapNonEmpty(pk, (f) => ({
			field: f,
			column: proposedColumn(f),
			returned: defined(
				returned.find((r) => r.field === f),
				"a returned key column"
			).alias
		}))
	})
	const repeat = metNarrowed(
		{
			rows: met.alias,
			key: mapNonEmpty(pk, (f) => ({
				column: w.names.column(name, f.name),
				from: proposedColumn(f),
				schema: operatorSchemaOf(w.names, rowType(f))
			})),
			filter: () => [],
			placed: mapNonEmpty(pk, (f) => w.names.column(name, f.name))
		},
		(inner) =>
			stated.map((f) =>
				typedEq(
					rowType(f),
					col(inner, w.names.column(name, f.name)),
					col(met.alias, proposedColumn(f)),
					w.names
				)
			)
	)
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
						targetAs(metFound(w, supply, name, repeat), repeated)
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
		const index = installed(w, memberName, family.index)
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
							scannedValue(w, family.member, sc, scan, p.to),
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
			const putKey = family.group.map((g) => col(p, columnAt(facts, fieldKey(g.owner.name))))
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
	/** The recount source's row of the owner row's group, read as `l`. */
	const at = (family: Family, last: PerGroup, l: string) =>
		sameGroupExprs(w.names, family, ownerKey(family), l, last.group)
	const hasGroup = (family: Family, last: PerGroup): Expr => {
		const l = supply.relation(internal("recount source"))
		return exists(simpleSelect([target(one)], [cteRefAs(last.name, l)], at(family, last, l)))
	}
	/**
	 * A family's recounted value of an owner column, its stored one where it recounts no group of the row: a recounted
	 * count or end is never NULL.
	 */
	const valueAt = (family: Family, last: PerGroup, column: string, stored: Expr): Expr => {
		const l = supply.relation(internal("recount value"))
		return firstNonNull([
			{
				kind: "subquery",
				query: simpleSelect([target(col(l, column))], [cteRefAs(last.name, l)], at(family, last, l))
			},
			stored
		])
	}
	const sets: Array<Assignment> = []
	const changed: Array<Expr> = []
	for (const { family, last } of lasts) {
		const assign = (field: LawField, column: string): void => {
			const installedColumn = w.names.column(name, field.name)
			/** The column's recounted value, built apart for the SET and for the WHERE that tests it changed. */
			const value = (): Expr =>
				written(w, valueAt(family, last, column, col(o, installedColumn)), field.type)
			sets.push({ column: installedColumn, value: value() })
			changed.push({
				kind: "not",
				expr: typedEq(field.type, col(o, installedColumn), value(), w.names)
			})
		}
		assign(family.count, last.count)
		for (const [key, column] of last.columns) {
			assign(
				defined(
					endColumns(family).find((f) => fieldKey(f.name) === key),
					`the end ${key} of ${name}`
				),
				column
			)
		}
	}
	const [firstSet, ...restSets] = sets
	const [firstChange, ...restChanges] = changed
	if (firstSet === undefined || firstChange === undefined) {
		throw defect(`a recount of ${name} sets its counts`)
	}
	const fields = recountFields(
		owner,
		recounted.map((r) => r.family)
	)
	const update = supply.relation(internal("family recount"))
	const returning = updateReturning(w, supply, owner, fields, update)
	const [firstLast, ...restLasts] = lasts
	ctes.push(
		cte(update, [], {
			kind: "update",
			with: undefined,
			table: w.names.relation(name),
			alias: o,
			set: [firstSet, ...restSets],
			from: [],
			where: and([
				restLasts.length === 0
					? hasGroup(firstLast.family, firstLast.last)
					: { kind: "or", args: mapNonEmpty(lasts, (x) => hasGroup(x.family, x.last)) },
				restChanges.length === 0 ? firstChange : { kind: "or", args: [firstChange, ...restChanges] }
			]),
			returning: returning.returning
		})
	)
	return {
		cte: update,
		columns: returning.columns,
		relation: name,
		result: updatedResult(owner, fields),
		rows: "counts"
	}
}
