/**
 * A stratum's rows as the host holds them while it plans the stratum's family writes: every row its reads found, by
 * relation and key, and the same rows as the stratum's changes leave them (analysis/theory/refill.ts). The host
 * draws each change on, as PostgreSQL would: an owner axis's cascade carries an owner's changed copied columns and
 * count into its members' copies (`cascade`), and a generated field is evaluated again over its row's values
 * (edit.ts valueAt), so a row holds no generated column the stratum changes.
 */
import { type ReadonlyTupleMap, TupleMap } from "#compiler/core/tuple-map.ts"
import { familyColumnType, type Family } from "#compiler/ir/family.ts"
import type { LawRelation } from "#compiler/ir/law.ts"
import type { MemberKey, Owner } from "#compiler/write/family/draw.ts"
import {
	type FillContext,
	groupOf,
	groupOfOwner,
	same,
	type Values,
	valueAt
} from "#compiler/write/family/edit.ts"
import { type ColumnKey, columnKey, fieldKey } from "#compiler/write/family/fold.ts"
import type { RowLayout } from "#compiler/write/family/statements.ts"

/** Rows by relation name and key, each its host values by column key. */
export type RowState = Map<string, TupleMap<MemberKey, Map<ColumnKey, unknown>>>

/** A row of `state` by relation and key; none where the state holds none. */
export const rowOf = (state: RowState, relation: string, key: MemberKey): Values | undefined =>
	state.get(relation)?.get(key)

/** The rows of `relation` in `state`, by key. */
export const rowsOf = (state: RowState, relation: string): ReadonlyTupleMap<MemberKey, Values> =>
	state.get(relation) ?? new TupleMap<MemberKey, Values>()

/** Holds the values of the row of `relation` at `key`, each over any value the state already holds there. */
export const holdRow = (
	state: RowState,
	relation: string,
	key: MemberKey,
	values: Values
): void => {
	const rows = state.get(relation) ?? new TupleMap<MemberKey, Map<ColumnKey, unknown>>()
	const row = rows.get(key) ?? new Map<ColumnKey, unknown>()
	for (const [k, v] of values) {
		row.set(k, v)
	}
	rows.set(key, row)
	state.set(relation, rows)
}

/**
 * Writes `over` over the row of `relation` at `key`, where the state holds it, dropping every generated field, which
 * is evaluated again over the row (edit.ts valueAt).
 */
export const writeRow = (
	state: RowState,
	relation: LawRelation,
	key: MemberKey,
	over: Values
): void => {
	const row = state.get(relation.name)?.get(key)
	if (row === undefined) {
		return
	}
	for (const [k, v] of over) {
		row.set(k, v)
	}
	for (const f of relation.fields) {
		if (f.writing.kind === "generated") {
			row.delete(fieldKey(f.name))
		}
	}
}

/** Drops the row of `relation` at `key`. */
export const dropRow = (state: RowState, relation: string, key: MemberKey): void => {
	state.get(relation)?.delete(key)
}

/** A copy of `state` whose rows a write leaves the original's as they are. */
export const copyState = (state: RowState): RowState =>
	new Map(
		[...state].map(([relation, rows]) => {
			const copy = new TupleMap<MemberKey, Map<ColumnKey, unknown>>()
			for (const [key, row] of rows) {
				copy.set(key, new Map(row))
			}
			return [relation, copy] as const
		})
	)

/**
 * A held row's group in `family`, where the row holds every one of the family's group fields; none where it does not: a
 * row held as another family's owner holds that family's read columns alone (bind.ts holdFamily), so it is no member
 * the host can place in `family`'s groups, and PostgreSQL's cascade alone carries `family`'s owner's changes into it.
 */
const heldGroup = (ctx: FillContext, family: Family, row: Values): Owner | undefined =>
	family.group.every((g) => row.has(fieldKey(g.member.name)))
		? groupOf(ctx, family, row)
		: undefined

/**
 * The cascades of `families`' owner axes over `current`, as PostgreSQL's ON UPDATE CASCADE carries them: each member
 * row the state holds of a family whose owner's row it holds takes every column the owner axis carries that its owner
 * holds another value at than `stored` does, and the owner's count, where that changed. A tree's owner axis carries
 * nothing, its nodes' copies being the tree's refill's. Owners at a lesser depth (`depthOf`) cascade first, so a change
 * carried into a member that owns a family is carried on into that family's members.
 */
export const cascade = (
	ctx: FillContext,
	families: ReadonlyArray<Family>,
	depthOf: (relation: string) => number,
	stored: RowState,
	current: RowState
): void => {
	const order = families
		.filter((f) => f.members.kind !== "tree")
		.toSorted((a, b) => depthOf(a.owner.name) - depthOf(b.owner.name))
	for (const j of order) {
		const members = current.get(j.member.name)
		const owners = current.get(j.owner.name)
		if (members === undefined || owners === undefined) {
			continue
		}
		const byGroup = new TupleMap<Owner, Array<Map<ColumnKey, unknown>>>()
		for (const row of members.values()) {
			const group = heldGroup(ctx, j, row)
			if (group === undefined) {
				continue
			}
			const list = byGroup.get(group) ?? []
			list.push(row)
			byGroup.set(group, list)
		}
		for (const [key, now] of owners) {
			const was = stored.get(j.owner.name)?.get(key)
			const rows = byGroup.get(groupOfOwner(ctx, j, now))
			if (was === undefined || rows === undefined) {
				continue
			}
			const carried = new Map<ColumnKey, unknown>()
			for (const pair of j.axes.owner) {
				const type = pair.to.kind === "field" ? pair.to.field.type : familyColumnType(j, pair.to)
				const after = valueAt(ctx, j.owner, now, columnKey(pair.to))
				if (
					type !== undefined &&
					after !== undefined &&
					!same(ctx, type, valueAt(ctx, j.owner, was, columnKey(pair.to)), after)
				) {
					carried.set(columnKey(pair.from), after)
				}
			}
			const count = now.get(fieldKey(j.count.name))
			if (count !== undefined && !same(ctx, j.count.type, was.get(fieldKey(j.count.name)), count)) {
				carried.set(`law:${j.copy}`, count)
			}
			for (const row of rows) {
				for (const [k, v] of carried) {
					row.set(k, v)
				}
				for (const f of j.member.fields) {
					if (f.writing.kind === "generated") {
						row.delete(fieldKey(f.name))
					}
				}
			}
		}
	}
}

/**
 * The columns of `now` that hold another value than `was` does, each compared under its type in `layout`; every
 * column of `now` where `was` holds no row. A column the layout does not hold, a generated one, is none.
 */
export const changedColumns = (
	ctx: FillContext,
	layout: RowLayout,
	was: Values | undefined,
	now: Values
): Values => {
	const types = new Map([...layout.key, ...layout.columns].map((c) => [c.key, c.type] as const))
	return new Map(
		[...now].filter(([key, v]) => {
			const type = types.get(key)
			return type !== undefined && (was === undefined || !same(ctx, type, was.get(key), v))
		})
	)
}
