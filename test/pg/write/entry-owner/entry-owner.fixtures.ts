/** What the properties of entry-owner.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import type { Uuid } from "#compiler/public/fields.ts"
import { type AnySchema, login, role } from "#compiler/public/schema.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import {
	entryRole,
	type Filter,
	type Holds,
	type Op,
	roleName,
	shopOf
} from "#test/support/families/entry-owner.ts"
import type { BuiltRole } from "#test/support/worlds/execute/build.ts"

export const holdsAll = ["neither", "count", "end", "both"] as const

export const statedFilters = ["region", "label"] as const

/** The uuid of the `n`th key of a kind: stores 0x0, items 0xa0. */
export const uuidAt = (base: number, n: number): Uuid =>
	`00000000-0000-4000-8000-${Str.padStart(12, "0")((base + n).toString(16))}`

type Region = "north" | "south"

type Label = "a" | "b" | "zz"

interface StoredStore {
	readonly key: number
	readonly region: Region
	readonly label: Label
	readonly qtys: ReadonlyArray<number>
}

interface Write {
	readonly holds: Holds
	readonly filter: Extract<Filter, "region" | "label">
	readonly op: Extract<Op, "insert" | "put">
	readonly key: number
	readonly label: Label
}

interface EntryCase {
	readonly stores: ReadonlyArray<StoredStore>
	readonly write: Write
}

export const caseGen: Gen<EntryCase> = (source) => {
	const stores = Arr.flatMap(Arr.range(1, 3), (key): ReadonlyArray<StoredStore> =>
		source.draw(element([true, false] as const))
			? [
					{
						key,
						region: source.draw(element(["north", "south"] as const)),
						label: source.draw(element(["a", "b", "zz"] as const)),
						qtys: source.draw(array(int(0, 3), { min: 0, max: 2 }))
					}
				]
			: []
	)
	return {
		stores,
		write: {
			holds: source.draw(element(holdsAll)),
			filter: source.draw(element(statedFilters)),
			op: source.draw(element(["insert", "put"] as const)),
			key: source.draw(int(1, 4)),
			label: source.draw(element(["a", "b", "zz"] as const))
		}
	}
}

/** A store's row as the model holds it and the table reads back: id, region, label, count and stock. */
export type Row = ReadonlyArray<string>

export const rowOf = (s: StoredStore): Row => [
	uuidAt(0, s.key),
	s.region,
	s.label,
	String(s.qtys.length),
	String(Arr.reduce(s.qtys, 0, (sum, q) => sum + q))
]

/** What the model expects of a write: its outcome's kind, with the laws it is refused on, and the stores it leaves. */
type Expected =
	| { readonly kind: "accepted"; readonly stores: ReadonlyArray<StoredStore> }
	| { readonly kind: "key law" }
	| { readonly kind: "outside" }
	| { readonly kind: "outside or key law" }

export type Feature =
	| `${Write["op"]}: ${"a visible store" | "an unseen store" | "a fresh key"}`
	| `${"insert" | "put"} of a fact outside the entry`
	| `a head holding ${Holds}`

export const expectedOf = (
	c: EntryCase
): { readonly expected: Expected; readonly situation: Feature } => {
	const w = c.write
	const inside = (region: Region, label: Label): boolean =>
		region === "north" && (w.filter !== "label" || label !== "zz")
	const stored = Arr.findFirst(c.stores, (s) => s.key === w.key)
	const others = Arr.filter(c.stores, (s) => s.key !== w.key)
	const where = Option.match(stored, {
		onNone: () => "a fresh key" as const,
		onSome: (s) =>
			inside(s.region, s.label) ? ("a visible store" as const) : ("an unseen store" as const)
	})
	const situation: Feature = `${w.op}: ${where}`
	const outside = !inside("north", w.label)
	if (Option.isSome(stored) && !inside(stored.value.region, stored.value.label)) {
		return { expected: outside ? { kind: "outside or key law" } : { kind: "key law" }, situation }
	}
	if (outside) {
		return { expected: { kind: "outside" }, situation: `${w.op} of a fact outside the entry` }
	}
	if (Option.isNone(stored)) {
		return {
			expected: {
				kind: "accepted",
				stores: [...c.stores, { key: w.key, region: "north", label: w.label, qtys: [] }]
			},
			situation
		}
	}
	if (w.op === "insert" && stored.value.label !== w.label) {
		return { expected: { kind: "key law" }, situation }
	}
	return {
		expected: {
			kind: "accepted",
			stores: [...others, { ...stored.value, label: w.label }]
		},
		situation
	}
}

/** The version under the declared name `name`: the box's schema, an entry role per declared shape and the keeper. */
export const versionOf = (name: string) => {
	const built = shopOf(name)
	const base: AnySchema = built.shop
	const writers = new Map(
		Arr.flatMap(holdsAll, (holds) =>
			Arr.map(
				statedFilters,
				(filter) => [roleName(holds, filter), entryRole(built, holds, filter)] as const
			)
		)
	)
	const wholes: Readonly<Record<string, EntryValue>> = { Store: built.Store, Item: built.Item }
	const write: ReadonlyArray<string> = ["Store", "Item"]
	const keeper: BuiltRole = role(base, "keeper", wholes, { write })
	const roles: readonly [BuiltRole, ...Array<BuiltRole>] = [keeper, ...writers.values()]
	return {
		built,
		keeper,
		writers,
		login: login<AnySchema, string, readonly [BuiltRole, ...Array<BuiltRole>]>(base, "desk", roles)
	}
}

export type EntryOwnerBuilt = ReturnType<typeof versionOf>
