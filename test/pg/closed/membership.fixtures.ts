/** What the properties of membership.test.ts read: its spaces, models and helpers. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	boolean,
	constant,
	element,
	type Gen,
	map,
	subset,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, Record as Rec } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { type Codebook, codecOf, codeOf } from "#compiler/ir/codes.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import { closedId } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	type AnyClosed,
	type AnyRelation,
	closed,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { closedBuilder } from "#compiler/schema/relation.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { defined, nonEmpty } from "#test/support/assert.ts"
import {
	historiesGen,
	holesOf,
	liveOf,
	type ModelSlot,
	rosterOf,
	type RosterState
} from "#test/support/closed/generate.ts"
import { paramTexts, type TemplateDeclarations } from "#test/support/compile.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Every roster history installs one to four handles and then migrates up to four times. */
const historySpace = { handles: { min: 1, max: 4 }, migrations: { min: 0, max: 4 } } as const

/** How the query reads one key field of the relation: as an item's variable, a literal handle, or a parameter. */
type KeyRead =
	| { readonly kind: "var" }
	| { readonly kind: "literal"; readonly handle: string }
	| { readonly kind: "param"; readonly handle: string }

interface MembershipCase {
	readonly rosters: NonEmptyReadonlyArray<RosterState>
	/** The key points the relation holds, each a live handle of each roster, in key order. */
	readonly facts: ReadonlyArray<ReadonlyArray<string>>
	readonly payload: boolean
	readonly reads: NonEmptyReadonlyArray<KeyRead>
}

/** The one key point of no field. */
const noPoint: ReadonlyArray<ReadonlyArray<string>> = [[]]

/** Every live key point of the rosters, a live handle of each in key order. */
const pointsOf = (rosters: ReadonlyArray<RosterState>): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.reduce(rosters, noPoint, (points, state) =>
		Arr.flatMap(points, (point) => Arr.map(liveOf(state), (handle) => [...point, handle]))
	)

const keyReadGen = (state: RosterState): Gen<KeyRead> =>
	weighted<KeyRead>([
		[4, constant({ kind: "var" })],
		[1, map(element(liveOf(state)), (handle): KeyRead => ({ kind: "literal", handle }))],
		[1, map(element(liveOf(state)), (handle): KeyRead => ({ kind: "param", handle }))]
	])

export const caseGen: Gen<MembershipCase> = (source) => {
	const rosters = nonEmpty(
		Arr.map(source.draw(historiesGen({ min: 1, max: 3 }, historySpace)), (h) => h.state),
		"a case's key rosters"
	)
	const points = pointsOf(rosters)
	return {
		rosters,
		facts: source.draw(subset(points, { min: 0, max: points.length })),
		payload: source.draw(boolean),
		reads: nonEmpty(
			Arr.map(rosters, (state) => source.draw(keyReadGen(state))),
			"a read per key field"
		)
	}
}

/** The relation's key field over roster `i`. */
const keyField = (i: number): string => `k${i}`

/** The roster of the items' ids: one handle per live key point, `i<n>` for the n-th, code n. */
export const itemIdsOf = (c: MembershipCase): RosterState => ({
	closed: parsedName("ItemId"),
	slots: nonEmpty(
		Arr.map(pointsOf(c.rosters), (_, n): ModelSlot => ({ kind: "live", handle: `i${n}` })),
		"one item at least"
	),
	spellings: { plain: 1 }
})

/**
 * The case's schema under the declared name `name`: its rosters, the closed relation Grid over their closed ids, with
 * a payload `w` of the first roster's closed id or none, and the items Item, each an id of the roster ItemId and its
 * key point, one item at every live key point.
 */
export const schemaOf = (name: string, c: MembershipCase) => {
	const declared: Record<string, AnyRelation | AnyClosed> = {}
	const keyFields: Record<string, ReturnType<typeof closedId>> = {}
	for (const [i, state] of c.rosters.entries()) {
		const roster = closedBuilder(state.closed, liveOf(state), "ordered", [])
		declared[state.closed] = roster
		keyFields[keyField(i)] = closedId(roster)
	}
	const first = defined(keyFields[keyField(0)])
	const key = nonEmpty(
		Arr.map(c.rosters, (_, i) => keyField(i)),
		"Grid's key"
	)
	const firstLive = liveOf(c.rosters[0])
	const rows = Arr.map(c.facts, (point, n): Record<string, string> => {
		const row: Record<string, string> = c.payload
			? { w: Arr.getUnsafe(firstLive, n % firstLive.length) }
			: {}
		for (const [i, handle] of point.entries()) {
			row[keyField(i)] = handle
		}
		return row
	})
	const gridFields: Record<string, ReturnType<typeof closedId>> = c.payload
		? { ...keyFields, w: first }
		: keyFields
	const Grid = closed.relation("Grid", gridFields, key, rows)
	const ids = itemIdsOf(c)
	const ItemId = closedBuilder(ids.closed, liveOf(ids), "ordered", [])
	const itemFields: Record<string, ReturnType<typeof closedId>> = {
		id: closedId(ItemId),
		...keyFields
	}
	const Item = relation("Item", itemFields, ["id"])
	declared[ids.closed] = ItemId
	declared["Grid"] = Grid
	declared["Item"] = Item
	return { base: schema(name, Rec.values(declared), []), Grid, Item }
}

/** The query: each item whose key fields, read as the case reads them, are a key Grid holds; its id. */
export const queryOf = (built: ReturnType<typeof schemaOf>, c: MembershipCase) =>
	query(built.base).rule((r) => {
		const vars = v(built.Item, "item")
		const id = defined(vars["id"])
		const paramOf = (i: number) => r.param(`p${i}`, defined(built.Grid.fields[keyField(i)]))
		const itemBinding: Record<string, (typeof vars)[string]> = { id }
		const gridBinding: Record<string, (typeof vars)[string] | string | ReturnType<typeof paramOf>> =
			{}
		for (const [i, read] of c.reads.entries()) {
			const field = keyField(i)
			switch (read.kind) {
				case "var": {
					const term = defined(vars[field])
					itemBinding[field] = term
					gridBinding[field] = term
					break
				}
				case "literal":
					gridBinding[field] = read.handle
					break
				case "param":
					gridBinding[field] = paramOf(i)
					break
			}
		}
		return r.match(built.Item, itemBinding).match(built.Grid, gridBinding).find({ id })
	})

/** The parameter values of the case's reads, by declared name. */
export const paramsOf = (c: MembershipCase): Readonly<Record<string, unknown>> => {
	const params: Record<string, unknown> = {}
	for (const [i, read] of c.reads.entries()) {
		if (read.kind === "param") {
			params[`p${i}`] = read.handle
		}
	}
	return params
}

/**
 * The ids the model delivers, each as the code PostgreSQL prints for it: each item, one per live point, whose point
 * agrees with a fact on every read. ItemId has no hole, so the n-th item's code is n.
 */
export const modelIds = (c: MembershipCase): ReadonlyArray<string> =>
	Arr.flatMap(pointsOf(c.rosters), (point, id) =>
		Arr.some(c.facts, (fact) =>
			Arr.every(c.reads, (read, i) =>
				read.kind === "var" ? fact[i] === point[i] : fact[i] === read.handle
			)
		)
			? [String(id)]
			: []
	)

export type MembershipFeature =
	| "a key code past its declared position"
	| "a key of two fields or more"
	| "a parameter key field"
	| "a literal key field"
	| "a payload left unread"
	| "no fact"
	| "every live point a fact"
	| "a sparse key set"
	| "R07 read the key set"

export const notesOf = (c: MembershipCase): ReadonlyArray<MembershipFeature> => {
	const points = pointsOf(c.rosters).length
	return [
		...(Arr.some(c.rosters, (state) =>
			Arr.some(holesOf(state), (h) =>
				Arr.some(state.slots.slice(h + 1), (slot) => slot.kind === "live")
			)
		)
			? (["a key code past its declared position"] as const)
			: []),
		...(c.rosters.length > 1 ? (["a key of two fields or more"] as const) : []),
		...(Arr.some(c.reads, (r) => r.kind === "param") ? (["a parameter key field"] as const) : []),
		...(Arr.some(c.reads, (r) => r.kind === "literal") ? (["a literal key field"] as const) : []),
		...(c.payload ? (["a payload left unread"] as const) : []),
		c.facts.length === 0
			? "no fact"
			: c.facts.length === points
				? "every live point a fact"
				: "a sparse key set"
	]
}

/**
 * The items, one at every live key point, the n-th with the id `i<n>`: an INSERT of their codes under the
 * installation's codes, which the roster domains admit, each code below its roster's size, holes included.
 */
export const itemsInsert = (names: PhysicalNames, c: MembershipCase, codes: Codebook): string => {
	const columns = [
		quoteIdent(names.column("Item", "id")),
		...Arr.map(c.rosters, (_, i) => quoteIdent(names.column("Item", keyField(i))))
	]
	const rows = Arr.map(pointsOf(c.rosters), (point, id) => {
		const key = Arr.map(point, (handle, i) => {
			const codec = codecOf(codes, rosterOf(defined(c.rosters[i])))
			return `${codeOf(codec, handle)}::smallint`
		})
		const item = codeOf(codecOf(codes, rosterOf(itemIdsOf(c))), `i${id}`)
		return `(${Arr.join([`${item}::smallint`, ...key], ", ")})`
	})
	return `INSERT INTO ${printObjectName(names.relation("Item"))} (${Arr.join(columns, ", ")}) VALUES ${Arr.join(rows, ", ")}`
}

/** The ids a statement delivers on PostgreSQL, as text, sorted. */
export const deliveredIds = (
	spec: StatementSpec,
	params: Readonly<Record<string, unknown>>,
	declared: TemplateDeclarations
) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rows = yield* s.admin.queryValues(spec.sql, paramTexts(spec, params, declared))
		return Arr.sort(
			Arr.map(rows, (row) => String(defined(row[0]))),
			Order.String
		)
	})

export const sorted = (ids: ReadonlyArray<string>): Array<string> => Arr.sort(ids, Order.String)
