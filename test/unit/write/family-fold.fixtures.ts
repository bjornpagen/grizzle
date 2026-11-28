/** What the properties of family-fold.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { StoredRelationName } from "#compiler/core/ids.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { FieldDesc, LiteralDesc, MonoidName } from "#compiler/ir/desc.ts"
import type { Family } from "#compiler/ir/family.ts"
import { columnKey, columnKeyOf } from "#compiler/ir/law.ts"
import { type ColumnIndex, columnIndex } from "#compiler/runtime/write/cells.ts"
import {
	closedLeaf,
	type FilledNode,
	type Filler,
	filler,
	hostEvaluator,
	type HostNode
} from "#compiler/runtime/write/fill.ts"
import { Numeric } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { hostFillOf } from "#compiler/write/program/decide.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { cellAt, cellsOf } from "#test/support/cells.ts"
import { type FoldMonoid, identityOf, type Planes } from "#test/support/families/fold.ts"
import {
	closed,
	counted,
	decodedSchema,
	f,
	field,
	fin,
	fold,
	on,
	onWhere,
	ordered,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { compiledModel } from "#test/support/unit/laws/model/natives.ts"
import { uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { upTo } from "#test/support/up-to.ts"

/** The carrier a fold's accumulator is of. */
type Carrier = "int2" | "int4" | "int8" | "natural" | "numeric" | "money" | "set" | "code"

type Accumulators = "named" | "hidden"

/**
 * The fold's step side: every member; those whose flag is true; or those whose two vectors differ, `v <> w`, whose
 * vectors a member's flag makes differ (nestingOf), so either selection holds of a member exactly where its flag is
 * true.
 */
const selections = ["none", "flag", "vectors"] as const

type Selection = (typeof selections)[number]

interface Shape {
	readonly monoid: FoldMonoid["name"]
	readonly carrier: Carrier
	readonly order: "ordered" | "counted"
	readonly accumulators: Accumulators
	readonly selection: Selection
}

/** Each monoid the reference folds, over exact integers: concat's texts are test/unit/write/concat-fill.test.ts's. */
const carriersOf: { readonly [M in FoldMonoid["name"]]: Arr.NonEmptyReadonlyArray<Carrier> } = {
	count: ["natural"],
	sum: ["int2", "int4", "int8", "natural", "numeric"],
	or: ["set"],
	twos: ["set"],
	max: ["int2", "int4", "int8", "natural", "code", "money"]
}

const SHAPES: Arr.NonEmptyReadonlyArray<Shape> = nonEmpty(
	Arr.flatMap(["count", "sum", "or", "twos", "max"] as const, (monoid) =>
		Arr.flatMap(carriersOf[monoid], (carrier) =>
			Arr.flatMap(
				[
					{ order: "ordered", accumulators: "named" },
					{ order: "ordered", accumulators: "hidden" },
					{ order: "counted", accumulators: "hidden" }
				] as const,
				(o) => Arr.map(selections, (selection): Shape => ({ monoid, carrier, ...o, selection }))
			)
		)
	)
)

const flagHandles = ["a", "b"] as const

const kindHandles = ["low", "high"] as const

const fieldOf: { readonly [C in Carrier]: FieldDesc } = {
	int2: f.smallint,
	int4: f.integer,
	int8: f.bigint,
	natural: f.natural,
	numeric: f.numeric(4, 1),
	money: f.pg("money"),
	set: { kind: "bits", roster: "Flag" },
	code: f.closedId("Kind")
}

/** A carrier's value of one exact integer: an integer's own, numeric(4, 1)'s in tenths, money's in cents, a set's bit
 * mask over the roster's handles, a closed id's code. */
const descOf = (carrier: Carrier, v: bigint): LiteralDesc => {
	switch (carrier) {
		case "int2":
		case "int4":
			return Number(v)
		case "int8":
		case "natural":
			return v
		case "numeric": {
			const magnitude = v < 0n ? -v : v
			return Numeric.of(`${v < 0n ? "-" : ""}${magnitude / 10n}.${magnitude % 10n}`)
		}
		case "money":
			return succeeded(Money.make(v))
		case "set":
			return { handles: Arr.filter(flagHandles, (_, i) => (v & (1n << BigInt(i))) !== 0n) }
		case "code":
			return defined(kindHandles[Number(v)], `the code ${v}`)
	}
}

/** A carrier's host value, as the codec admits it, from one exact integer (descOf's, as host values). */
const hostOf = (carrier: Carrier, v: bigint): unknown => {
	switch (carrier) {
		case "set":
			return new Set(Arr.filter(flagHandles, (_, i) => (v & (1n << BigInt(i))) !== 0n))
		case "int2":
		case "int4":
		case "int8":
		case "natural":
		case "numeric":
		case "money":
		case "code":
			return descOf(carrier, v)
	}
}

/** A host value's canonical text, which two host values of one carrier share exactly when they are equal. */
const textOf = (value: unknown): string => {
	if (value instanceof Numeric) {
		return `numeric ${value.text}`
	}
	if (value instanceof Money) {
		return `money ${value.minorUnits}`
	}
	if (value instanceof Set) {
		return `set ${Arr.join(
			Arr.filter(flagHandles, (h) => value.has(h)),
			","
		)}`
	}
	return `${typeof value} ${String(value)}`
}

const leastOf: { readonly [C in Carrier]: bigint } = {
	int2: -32_768n,
	int4: -2_147_483_648n,
	int8: -9_223_372_036_854_775_808n,
	natural: 0n,
	numeric: 0n,
	money: -9_223_372_036_854_775_808n,
	set: 0n,
	code: 0n
}

export const foldMonoid = (s: Shape): FoldMonoid => ({
	name: s.monoid,
	least: s.monoid === "max" ? leastOf[s.carrier] : 0n
})

/** Each carrier's small values, its identity among them. */
const valuesOf = (s: Shape): Arr.NonEmptyReadonlyArray<bigint> => {
	switch (s.carrier) {
		case "set":
			return [0n, 1n, 2n, 3n]
		case "code":
			return [0n, 1n]
		case "natural":
			return [0n, 1n, 2n]
		case "numeric":
			return [0n, 5n, 15n]
		case "int2":
		case "int4":
		case "int8":
		case "money":
			return s.monoid === "max" ? [leastOf[s.carrier], -1n, 2n] : [-1n, 0n, 2n]
	}
}

const planes = (s: Shape): 1 | 2 => (s.monoid === "twos" ? 2 : 1)

/** The fold's schema: Owner(id, n, end…) and Member(id, owner, [at,] [x,] flag, [before…, after…]). */
const schemaOf = (s: Shape): SchemaDesc => {
	const type = fieldOf[s.carrier]
	const start = descOf(s.carrier, identityOf(foldMonoid(s))[0])
	const accumulated = () => f.accumulated(type, start)
	const planeNames = upTo(planes(s), (p) => p)
	const named = s.accumulators === "named"
	const step = [
		"owner",
		...(s.monoid === "count" ? [] : ["x"]),
		...(named ? Arr.flatMap(planeNames, (p) => [`before${p}`, `after${p}`]) : [])
	]
	const vector: FieldDesc = { kind: "vector", dimensions: 3 }
	const side = (() => {
		switch (s.selection) {
			case "none":
				return on("Member", step)
			case "flag":
				return onWhere("Member", step, {
					kind: "compare",
					op: "eq",
					left: field("flag"),
					right: { kind: "literal", value: true }
				})
			case "vectors":
				return onWhere("Member", step, {
					kind: "compare",
					op: "ne",
					left: field("v"),
					right: field("w")
				})
		}
	})()
	return {
		name: "Folds",
		relations: [
			closed.ordered("Flag", flagHandles),
			closed.ordered("Kind", kindHandles),
			relation(
				"Owner",
				{
					id: f.uuid,
					n: f.drawn,
					...Rec.fromEntries(Arr.map(planeNames, (p) => [`end${p}`, accumulated()] as const))
				},
				["id"]
			),
			relation(
				"Member",
				{
					id: f.uuid,
					owner: f.uuid,
					...(s.order === "ordered" ? { at: f.drawn } : {}),
					...(s.monoid === "count" ? {} : { x: type }),
					flag: f.boolean,
					...(s.selection === "vectors" ? { v: vector, w: vector } : {}),
					...(named
						? Rec.fromEntries(
								Arr.flatMap(planeNames, (p) => [
									[`before${p}`, accumulated()] as const,
									[`after${p}`, accumulated()] as const
								])
							)
						: {})
				},
				["id"]
			)
		],
		statements: [
			s.order === "ordered"
				? ordered(on("Member", ["owner", "at"]), fin("Owner", "n"))
				: counted(on("Member", ["owner"]), fin("Owner", "n")),
			fold(
				fin("Owner", "n"),
				s.monoid,
				side,
				on("Owner", ["id", ...Arr.map(planeNames, (p) => `end${p}`)])
			)
		],
		bases: []
	}
}

/** A shape's compiled fill: its family, its filler, and the column index its filler lays rows out by, built once; none
 * for a fold its typing refuses. */
export interface Compiled {
	readonly family: Family
	readonly fill: Filler
	readonly columns: ColumnIndex
}

/** A shape's key: its monoid, carrier, order, accumulators and selection, which decide its fill. */
export const shapeKey = (s: Shape): string =>
	`${s.monoid} ${s.carrier} ${s.order} ${s.accumulators} ${s.selection}`

/** A shape's compiled fill: its family and its filler; none for a fold its typing refuses. */
const fillOf = (s: Shape): Compiled | undefined => {
	const desc = schemaOf(s)
	const model = compiledModel(desc)
	if (!model.ok) {
		return undefined
	}
	const codes = firstCodebook(rostersOf(succeeded(own(decodedSchema(desc)))))
	const family = defined(model.value.families[0], "the fold's family")
	const columns = columnIndex()
	const fill = filler(
		hostFillOf(model.value.theory.fill, [
			{ relation: StoredRelationName("Owner"), position: { kind: "top" } }
		]),
		codes,
		hostEvaluator(closedLeaf(new Map()), model.value.patterns),
		columns
	)
	return { family, fill, columns }
}

/**
 * Every shape's compiled fill, by its key (shapeKey): the box's 34,740 cases fold over the 126 shapes, so the fills are
 * compiled once, when a worker readies the box (the need's open, outside every case's deadline), and every case reads
 * its shape's. A compile that fails fails the need's open, and so the property.
 */
export const compiledFills: Need<ReadonlyMap<string, Compiled | undefined>> = {
	key: "test/unit/write/family-fold.fixtures.ts compiledFills",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const fills: ReadonlyMap<string, Compiled | undefined> = new Map(
			Arr.map(SHAPES, (s) => [shapeKey(s), fillOf(s)] as const)
		)
		return Effect.succeed(fills)
	})
}

/** One case: a fold's shape and one owner's members, each its value and whether its row is selected. */
interface FoldCase {
	readonly shape: Shape
	readonly members: ReadonlyArray<{ readonly x: bigint; readonly flag: boolean }>
}

export const caseGen: Gen<FoldCase> = (source) => {
	const shape = source.draw(element(SHAPES))
	const n = source.draw(int(0, 3))
	const values = shape.monoid === "count" ? ([0n] as const) : valuesOf(shape)
	const members = upTo(n, () => ({
		x: source.draw(element(values)),
		flag: source.draw(element([false, true]))
	}))
	return { shape, members: n === 0 ? [] : members }
}

/** A unit vector of three components, each a member's v and, where its flag is false, its w. */
const unitX = succeeded(Vector.from(Float32Array.from([1, 0, 0]), 3), "a unit vector")

/** Another unit vector, a member's w where its flag is true, so its v <> w holds exactly there. */
const unitY = succeeded(Vector.from(Float32Array.from([0, 1, 0]), 3), "a unit vector")

/**
 * The owner's nesting: its id, and its members, each its id, its value and its flag, and under the vector selection its
 * two vectors, which differ exactly where its flag is true.
 */
export const nestingOf = (c: FoldCase, columns: ColumnIndex): HostNode => ({
	relation: StoredRelationName("Owner"),
	values: cellsOf(columns, "Owner", [[columnKeyOf("id"), uuidOf(0)]]),
	texts: [],
	families: [
		{
			family: { owner: "Owner", count: "n" },
			members: Arr.map(c.members, (m, i) => ({
				relation: StoredRelationName("Member"),
				values: cellsOf(columns, "Member", [
					[columnKeyOf("id"), uuidOf(i + 1)],
					[columnKeyOf("flag"), m.flag],
					...(c.shape.selection === "vectors"
						? [
								[columnKeyOf("v"), unitX] as const,
								[columnKeyOf("w"), m.flag ? unitY : unitX] as const
							]
						: []),
					...(c.shape.monoid === "count"
						? []
						: [[columnKeyOf("x"), hostOf(c.shape.carrier, m.x)] as const])
				]),
				texts: [],
				families: []
			}))
		}
	]
})

export type FoldFeature =
	| `monoid ${MonoidName}`
	| "an empty family"
	| "a member stepped over"
	| "a member a vector comparison steps over"
	| "hidden accumulators"
	| "a counted family"

/** A row's planes at a fold's columns, each its host value's text, under the fill's column index. */
export const planesAt = (
	index: ColumnIndex,
	row: FilledNode,
	columns: ReadonlyArray<ReturnType<typeof columnKey>>
): ReadonlyArray<string> => Arr.map(columns, (k) => textOf(cellAt(index, row, k)))

/** The reference's planes, exact integers, each as its carrier's host value's text. */
export const expectedAt = (carrier: Carrier, planes: Planes): ReadonlyArray<string> =>
	Arr.map(planes, (v) => textOf(hostOf(carrier, v)))
