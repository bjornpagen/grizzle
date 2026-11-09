import { assembled, byTag, cellKindOf, deliveryOf } from "#compiler/codec/delivery.ts"
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
/**
 * A family write's one reader of PostgreSQL's rows: a family's read of its stored suffixes (statements.ts
 * suffixReadSql), each kind of row read by its columns' delivery (codec/delivery.ts) and each cell by its column's
 * reader (codec/read.ts). The filler (edit.ts) never reads a text: it works on host values from here to the statement
 * that writes its texts.
 */
import { scalarReader } from "#compiler/codec/read.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import type { Cell, OutputRows } from "#compiler/core/wire.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { MemberKey, Owner } from "#compiler/runtime/write/draw.ts"
import { type ColumnKey, columnKey, fieldKey } from "#compiler/runtime/write/fill.ts"
import {
	type FillContext,
	groupOf,
	groupOfOwner,
	keyOf,
	type Values
} from "#compiler/runtime/write/keys.ts"
import {
	drawnAt,
	type EditTarget,
	membersByGroup,
	type StoredFamily,
	type StoredGroup,
	type StoredMember
} from "#compiler/write/family/edit.ts"
import type { ChainShape, ReadShape, RowLayout } from "#compiler/write/family/statements.ts"

/** An arm a read's answer holds no row of. */
const noRows: OutputRows = []

/** The rows of one answer of a read, each kind by its tag (codec/delivery.ts byTag). */
type Arms = ReadonlyMap<string, OutputRows>

/** The columns of a row of `layout`, its key's first, in the order a read delivers them. */
const layoutColumns = (layout: RowLayout): ReadonlyArray<RowLayout["columns"][number]> => [
	...layout.key,
	...layout.columns
]

/**
 * One family's reads' rows decoded (statements.ts suffixReadSql), every read of the family's (order.ts planRead) as one
 * set, each answer of `arms` read on its own: each `o` row an owner, its key and its read columns; each `m` row a
 * member, its key and its row layout's columns, each kind's rows read by its columns' delivery and each cell through
 * its column's reader, trusting PostgreSQL's output. A row two reads return is one, an owner by its group and a member
 * by its key. A row missing a cell is the read's EncodingFailure.
 */
const decodeSuffix = (
	ctx: FillContext,
	target: EditTarget,
	family: Family,
	shape: ReadShape,
	arms: ReadonlyArray<Arms>
): Result.Result<StoredFamily, EncodingFailure> => {
	const owners = new TupleMap<
		Owner,
		{ readonly values: Map<ColumnKey, unknown>; readonly count: number }
	>()
	const members = new TupleMap<MemberKey, StoredMember>()
	const failure = encodeFailure("factShape", slotPlace(target.relation.name))
	const ownerFields: ReadonlyArray<LawField> = [
		...family.group.map((g) => g.owner),
		...shape.owner.columns
	]
	const memberColumns = layoutColumns(target.layout)
	const ownerDelivery = deliveryOf(ownerFields.map((f) => cellKindOf(f.type)))
	const memberDelivery = deliveryOf(memberColumns.map((c) => cellKindOf(c.type)))
	const read = (
		type: LawField["type"],
		cell: Cell | undefined
	): Result.Result<unknown, EncodingFailure> => {
		if (cell === undefined) {
			return Result.err(failure)
		}
		return Result.ok(scalarReader(type, ctx.codes).convert(cell))
	}
	for (const answer of arms) {
		for (const cells of assembled(ownerDelivery, answer.get("o") ?? noRows)) {
			const values = new Map<ColumnKey, unknown>()
			for (const [i, f] of ownerFields.entries()) {
				const v = read(f.type, cells[i])
				if (!v.ok) {
					return v
				}
				values.set(fieldKey(f.name), v.value)
			}
			owners.set(groupOfOwner(ctx, family, values), {
				values,
				count: Number(
					drawnAt(values, fieldKey(family.count.name), `the count of ${family.owner.name}`)
				)
			})
		}
		for (const cells of assembled(memberDelivery, answer.get("m") ?? noRows)) {
			const values = new Map<ColumnKey, unknown>()
			for (const [i, c] of memberColumns.entries()) {
				const v = read(c.type, cells[i])
				if (!v.ok) {
					return v
				}
				values.set(c.key, v.value)
			}
			const key = keyOf(ctx, target.layout, values)
			if (!members.has(key)) {
				members.set(key, {
					key,
					slot: Number(
						drawnAt(values, columnKey(family.index), `the index of a ${target.relation.name}`)
					),
					group: groupOf(ctx, family, values),
					values
				})
			}
		}
	}
	const byGroup = membersByGroup(members.values())
	const groups = new TupleMap<Owner, StoredGroup>()
	for (const [group, o] of owners) {
		groups.set(group, { owner: o.values, count: o.count, members: byGroup.get(group) ?? [] })
	}
	return Result.ok({ groups, members })
}

/**
 * One family's reads' rows decoded (`decodeSuffix`), from `answers`, one per read statement executed (order.ts
 * planRead), each as PostgreSQL sent it, so no answer's chunks meet another's.
 */
export const decodeRead = (
	ctx: FillContext,
	target: EditTarget,
	family: Family,
	shape: ReadShape,
	answers: ReadonlyArray<OutputRows>
): Result.Result<StoredFamily, EncodingFailure> =>
	decodeSuffix(ctx, target, family, shape, answers.map(byTag))

/**
 * A chain read's rows decoded (statements.ts chainReadSql), every read of the chain's (order.ts planRead) as one set:
 * each row set's rows by relation and key, a refilled tree's nodes among them, each every column of its row
 * layout; and a refilled family's stored suffixes at the chain's end, as a family's read decodes them (`decodeRead`).
 * A row missing a cell is the read's EncodingFailure.
 */
export interface ChainRows {
	readonly rows: ReadonlyArray<{
		readonly relation: string
		readonly key: MemberKey
		readonly values: Values
	}>
	readonly end:
		| { readonly kind: "suffix"; readonly family: Family; readonly stored: StoredFamily }
		| { readonly kind: "tree"; readonly family: Family; readonly keys: ReadonlyArray<MemberKey> }
		| { readonly kind: "rows" }
}

/**
 * One chain read's rows decoded (`ChainRows`), over the row layouts its shape names, from `answers`, one per read
 * statement executed, each as PostgreSQL sent it: each answer's row sets, by tag, read by their layouts' delivery, and
 * its `o` and `m` rows left for the suffix at the chain's end.
 */
export const decodeChain = (
	ctx: FillContext,
	shape: ChainShape,
	answers: ReadonlyArray<OutputRows>
): Result.Result<ChainRows, EncodingFailure> => {
	const end = shape.end
	const sets = [
		...shape.rows,
		...(end.kind === "tree" ? [{ tag: "t", relation: end.family.member, layout: end.layout }] : [])
	]
	const out: Array<ChainRows["rows"][number]> = []
	const nodes: Array<MemberKey> = []
	const arms = answers.map(byTag)
	for (const answer of arms) {
		for (const set of sets) {
			const failure = encodeFailure("factShape", slotPlace(set.relation.name))
			const columns = layoutColumns(set.layout)
			const delivery = deliveryOf(columns.map((c) => cellKindOf(c.type)))
			for (const cells of assembled(delivery, answer.get(set.tag) ?? noRows)) {
				const values = new Map<ColumnKey, unknown>()
				for (const [i, c] of columns.entries()) {
					const cell = cells[i]
					if (cell === undefined) {
						return Result.err(failure)
					}
					values.set(c.key, scalarReader(c.type, ctx.codes).convert(cell))
				}
				const key = keyOf(ctx, set.layout, values)
				out.push({ relation: set.relation.name, key, values })
				if (set.tag === "t") {
					nodes.push(key)
				}
			}
		}
	}
	if (end.kind === "tree") {
		return Result.ok({ rows: out, end: { kind: "tree", family: end.family, keys: nodes } })
	}
	if (end.kind === "rows") {
		return Result.ok({ rows: out, end: { kind: "rows" } })
	}
	const stored = decodeSuffix(
		ctx,
		{ relation: end.family.member, layout: end.layout, families: [] },
		end.family,
		end.shape,
		arms
	)
	return stored.ok
		? Result.ok({ rows: out, end: { kind: "suffix", family: end.family, stored: stored.value } })
		: stored
}
