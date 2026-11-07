import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
/**
 * A family write's one reader of PostgreSQL's rows: a family's read of its stored suffixes (statements.ts
 * suffixReadSql), each cell PostgreSQL's output text read by its column's reader (codec/read.ts). The filler
 * (edit.ts) never reads a text: it works on host values from here to the statement that writes its texts.
 */
import { scalarReader } from "#compiler/codec/read.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { LawField } from "#compiler/ir/law.ts"
import { admitValue } from "#compiler/scalar/values/identity.ts"
import { textsKey } from "#compiler/write/family/draw.ts"
import {
	type EditTarget,
	type FillContext,
	groupOf,
	groupOfOwner,
	keyOf,
	specOf,
	type StoredFamily,
	type StoredGroup,
	type StoredMember,
	type Values
} from "#compiler/write/family/edit.ts"
import { type ColumnKey, columnKey, fieldKey } from "#compiler/write/family/fold.ts"
import type { ChainShape, ReadShape } from "#compiler/write/family/statements.ts"

/**
 * One family's reads' rows decoded (statements.ts suffixReadSql), every read of the family's (order.ts planRead) as one
 * set: each `o` row an owner, its key and its read columns; each `m` row a member, its key and its row layout's columns,
 * each text read through its column's codec. A row two reads return is one, an owner by its group and a member by its
 * key. A text the codec does not read is the read's EncodingFailure.
 */
export const decodeRead = (
	ctx: FillContext,
	target: EditTarget,
	family: Family,
	shape: ReadShape,
	rows: ReadonlyArray<ReadonlyArray<OutputText>>
): Result.Result<StoredFamily, EncodingFailure> => {
	const owners = new Map<
		string,
		{ readonly values: Map<ColumnKey, unknown>; readonly count: number }
	>()
	const members = new Map<string, StoredMember>()
	const failure = encodeFailure("factShape", slotPlace(target.relation.name))
	const read = (
		type: LawField["type"],
		text: OutputText | undefined
	): Result.Result<unknown, EncodingFailure> => {
		if (text === undefined) {
			return Result.err(failure)
		}
		const converted = scalarReader(type, ctx.codes).convert(text)
		const value = admitValue(specOf(ctx, type), converted)
		return value.ok ? Result.ok(value.value) : Result.err(failure)
	}
	for (const row of rows) {
		const [tag, ...cells] = row
		if (tag === "o") {
			const values = new Map<ColumnKey, unknown>()
			const columns: ReadonlyArray<LawField> = [
				...family.group.map((g) => g.owner),
				...shape.owner.columns
			]
			for (const [i, f] of columns.entries()) {
				const v = read(f.type, cells[i])
				if (!v.ok) {
					return v
				}
				values.set(fieldKey(f.name), v.value)
			}
			const count = values.get(fieldKey(family.count.name))
			const group = textsKey(groupOfOwner(ctx, family, values))
			owners.set(group, { values, count: typeof count === "bigint" ? Number(count) : 0 })
			continue
		}
		const values = new Map<ColumnKey, unknown>()
		for (const [i, c] of [...target.layout.key, ...target.layout.columns].entries()) {
			const v = read(c.type, cells[i])
			if (!v.ok) {
				return v
			}
			values.set(c.key, v.value)
		}
		const slot = values.get(columnKey(family.index))
		const key = textsKey(keyOf(ctx, target.layout, values))
		if (!members.has(key)) {
			members.set(key, {
				key,
				slot: typeof slot === "bigint" ? Number(slot) : -1,
				group: textsKey(groupOf(ctx, family, values)),
				values
			})
		}
	}
	const groups = new Map<string, StoredGroup>()
	for (const [group, o] of owners) {
		groups.set(group, {
			owner: o.values,
			count: o.count,
			members: [...members.values()]
				.filter((m) => m.group === group)
				.toSorted((a, b) => a.slot - b.slot)
		})
	}
	return Result.ok({ groups, members })
}

/**
 * A chain read's rows decoded (statements.ts chainReadSql), every read of the chain's (order.ts planRead) as one set:
 * each row set's rows by relation and key text, a refilled tree's nodes among them, each every column of its row
 * layout; and a refilled family's stored suffixes at the chain's end, as a family's read decodes them (`decodeRead`).
 * A text the codec does not read is the read's EncodingFailure.
 */
export interface ChainRows {
	readonly rows: ReadonlyArray<{
		readonly relation: string
		readonly key: string
		readonly values: Values
	}>
	readonly end:
		| { readonly kind: "suffix"; readonly family: Family; readonly stored: StoredFamily }
		| { readonly kind: "tree"; readonly family: Family; readonly keys: ReadonlyArray<string> }
		| { readonly kind: "rows" }
}

/** One chain read's rows decoded (`ChainRows`), over the row layouts its shape names. */
export const decodeChain = (
	ctx: FillContext,
	shape: ChainShape,
	rows: ReadonlyArray<ReadonlyArray<OutputText>>
): Result.Result<ChainRows, EncodingFailure> => {
	const sets = new Map(shape.rows.map((r) => [r.tag, r] as const))
	const out: Array<ChainRows["rows"][number]> = []
	const ends: Array<ReadonlyArray<OutputText>> = []
	const nodes: Array<string> = []
	const end = shape.end
	for (const row of rows) {
		const [tag, ...cells] = row
		const set =
			tag === undefined
				? undefined
				: (sets.get(tag) ??
					(end.kind === "tree" && tag === "t"
						? { relation: end.family.member, layout: end.layout }
						: undefined))
		if (set === undefined) {
			ends.push(row)
			continue
		}
		const failure = encodeFailure("factShape", slotPlace(set.relation.name))
		const values = new Map<ColumnKey, unknown>()
		for (const [i, c] of [...set.layout.key, ...set.layout.columns].entries()) {
			const text = cells[i]
			if (text === undefined) {
				return Result.err(failure)
			}
			const value = admitValue(specOf(ctx, c.type), scalarReader(c.type, ctx.codes).convert(text))
			if (!value.ok) {
				return Result.err(failure)
			}
			values.set(c.key, value.value)
		}
		const key = textsKey(keyOf(ctx, set.layout, values))
		out.push({ relation: set.relation.name, key, values })
		if (tag === "t") {
			nodes.push(key)
		}
	}
	if (end.kind === "tree") {
		return Result.ok({ rows: out, end: { kind: "tree", family: end.family, keys: nodes } })
	}
	if (end.kind === "rows") {
		return Result.ok({ rows: out, end: { kind: "rows" } })
	}
	const stored = decodeRead(
		ctx,
		{ relation: end.family.member, layout: end.layout, families: [] },
		end.family,
		end.shape,
		ends
	)
	return stored.ok
		? Result.ok({ rows: out, end: { kind: "suffix", family: end.family, stored: stored.value } })
		: stored
}
