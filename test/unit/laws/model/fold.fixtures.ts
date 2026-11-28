/** What the properties of fold.test.ts read: its spaces, models and helpers. */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import type { ColumnIdent } from "#compiler/core/ids.ts"
import {
	type FieldDesc,
	type LiteralDesc,
	type MonoidName,
	monoidNames
} from "#compiler/ir/desc.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { combined, type FoldMonoid, type Planes } from "#test/support/families/fold.ts"
import {
	closed,
	counted,
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
import { type ModelValue, modelLiteral } from "#test/support/oracle/evaluate/catalog.ts"
import {
	accepts,
	assertWellFormed,
	checksOf,
	compiledModel,
	drawnColumn,
	foldLaws,
	foreignKeyShapes,
	modelOf,
	type Row
} from "#test/support/unit/laws/model/natives.ts"
import { upTo } from "#test/support/up-to.ts"

type Carrier = "int2" | "int4" | "int8" | "natural" | "numeric" | "money" | "set" | "code"

type Accumulators = "named" | "hidden"

interface Shape {
	readonly monoid: NumericMonoid
	readonly carrier: Carrier
	readonly order: "ordered" | "counted"
	readonly accumulators: Accumulators
	readonly selected: boolean
}

/**
 * The monoids the reference fold combines in exact integers (test/support/families/fold.ts): every monoid but concat,
 * which folds text, and whose natives test/unit/analysis/theory/concat.test.ts and test/unit/write/concat-fill.test.ts
 * judge.
 */
type NumericMonoid = Exclude<MonoidName, "concat">

const carriersOf: { readonly [M in NumericMonoid]: Arr.NonEmptyReadonlyArray<Carrier> } = {
	count: ["natural"],
	sum: ["int2", "int4", "int8", "natural", "numeric", "money"],
	or: ["set"],
	twos: ["set"],
	max: ["int2", "int4", "int8", "natural", "code", "money"]
}

/** The monoids of the source's roster the reference folds in exact integers. */
const numericMonoids: Arr.NonEmptyReadonlyArray<NumericMonoid> = nonEmpty(
	Arr.filter(monoidNames, (m): m is NumericMonoid => m !== "concat")
)

/** The box: every monoid of the roster on every carrier it admits, an ordered family with named or hidden accumulators
 * or a counted one with hidden ones, stepping over every member or a selected one. */
export const shapeGen: Gen<Shape> = (source) => {
	const monoid = source.draw(element(numericMonoids))
	const carrier = source.draw(element(carriersOf[monoid]))
	const order = source.draw(element(["ordered", "counted"] as const))
	const accumulators =
		order === "ordered" ? source.draw(element(["named", "hidden"] as const)) : "hidden"
	return { monoid, carrier, order, accumulators, selected: source.draw(boolean) }
}

export type Feature =
	| `monoid ${MonoidName}`
	| `carrier ${Carrier}`
	| "named accumulators"
	| "hidden accumulators"
	| "a counted family"
	| "a selected step"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"monoid count",
	"monoid sum",
	"monoid or",
	"monoid twos",
	"monoid max",
	"carrier int2",
	"carrier int4",
	"carrier int8",
	"carrier natural",
	"carrier numeric",
	"carrier money",
	"carrier set",
	"carrier code",
	"named accumulators",
	"hidden accumulators",
	"a counted family",
	"a selected step"
]

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
 * mask over the roster's codes, a closed id's code. */
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
			return Decimal.of(`${v < 0n ? "-" : ""}${magnitude / 10n}.${magnitude % 10n}`)
		}
		case "money":
			return succeeded(Money.make(v))
		case "set":
			return { handles: Arr.filter(flagHandles, (_, i) => (v & (1n << BigInt(i))) !== 0n) }
		case "code":
			return defined(kindHandles[Number(v)], `the code ${v}`)
	}
}

/** The least value of each carrier max admits, its identity there. */
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

/** The monoid as the reference reads it. */
const foldMonoid = (s: Shape): FoldMonoid => ({
	name: s.monoid,
	least: s.monoid === "max" ? leastOf[s.carrier] : 0n
})

/** A plane's identity: 0, the empty set, or the carrier's least value. */
const identity = (s: Shape): bigint => (s.monoid === "max" ? leastOf[s.carrier] : 0n)

/** Each carrier's small values, the identity among them: a box of three a plane, four for a set. */
const valuesOf = (s: Shape): ReadonlyArray<bigint> => {
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

const schemaOf = (s: Shape): SchemaDesc => {
	const type = fieldOf[s.carrier]
	const start = descOf(s.carrier, identity(s))
	const accumulated = () => f.accumulated(type, start)
	const planeNames = upTo(planes(s), (p) => p)
	const named = s.accumulators === "named"
	const step = [
		"owner",
		...(s.monoid === "count" ? [] : ["x"]),
		...(named ? Arr.flatMap(planeNames, (p) => [`before${p}`, `after${p}`]) : [])
	]
	const selection = {
		kind: "compare" as const,
		op: "eq" as const,
		left: field("flag"),
		right: { kind: "literal" as const, value: true }
	}
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
				s.selected ? onWhere("Member", step, selection) : on("Member", step),
				on("Owner", ["id", ...Arr.map(planeNames, (p) => `end${p}`)])
			)
		],
		bases: []
	}
}

/** Every combination of `n` values from `values`. */
const tuples = (values: ReadonlyArray<bigint>, n: number): ReadonlyArray<ReadonlyArray<bigint>> =>
	n === 0 ? [[]] : Arr.flatMap(tuples(values, n - 1), (t) => Arr.map(values, (v) => [...t, v]))

/** The accumulator columns of each plane, by name: a named field's, or a hidden drawn column's identifier. */
const columnsOf = (model: LawModel, s: Shape) =>
	upTo(planes(s), (p) =>
		s.accumulators === "named"
			? { before: `before${p}`, after: `after${p}` }
			: {
					before: drawnColumn(model, "Member", `before 0.${p}`),
					after: drawnColumn(model, "Member", `after 0.${p}`)
				}
	)

const fieldNamed = (model: LawModel, relationName: string, name: string): LawField =>
	defined(
		Arr.findFirst(
			defined(model.theory.relations[relationName]).fields,
			(x) => x.name === name
		).pipe((o) => (o._tag === "Some" ? o.value : undefined)),
		`the field ${relationName}.${name}`
	)

const checkMember = (model: LawModel, s: Shape, law: ReturnType<typeof foldLaws>[number]): void => {
	const [check, ...more] = checksOf(model, "Member", law)
	assert.ok(check !== undefined && more.length === 0, "the fold states one CHECK on its member")
	const type = fieldNamed(model, "Owner", "end0").type
	const value = (v: bigint): ModelValue =>
		modelLiteral(succeeded(irLiteral(descOf(s.carrier, v), type)))
	const cols = columnsOf(model, s)
	const index = s.order === "ordered" ? "at" : drawnColumn(model, "Member", "index")
	const values = valuesOf(s)
	const m = foldMonoid(s)
	const iota = identity(s)
	const xs = s.monoid === "count" ? [0n] : values
	for (const befores of tuples(values, planes(s))) {
		const before = defined(nonEmpty(befores)) satisfies Planes
		for (const x of xs) {
			const stepped = combined(m, before, x)
			for (const selected of [false, true]) {
				const due = !s.selected || selected ? stepped : before
				const candidates = tuples([...new Set([...values, ...due])], planes(s))
				for (const after of candidates) {
					for (const slot of [0n, 1n]) {
						const fitsCarrier = Arr.every(after, (a) => s.carrier !== "code" || a < 2n)
						if (!fitsCarrier) {
							continue
						}
						const row: Row = new Map<string, ModelValue>([
							[index, slot],
							["flag", selected],
							...(s.monoid === "count" ? [] : [["x", value(x)] as const]),
							...Arr.flatMap(cols, (c, p) => [
								[c.before, value(defined(before[p]))] as const,
								[c.after, value(defined(after[p]))] as const
							])
						])
						const combineHolds = Arr.every(after, (a, p) => a === due[p])
						const pinned = slot > 0n || Arr.every(before, (b) => b === iota)
						assert.equal(
							accepts(check, row),
							combineHolds && pinned,
							`slot ${slot}, before ${Arr.join(Arr.map(before, String), "/")}, x ${x}, selected ${selected}, after ${Arr.join(Arr.map(after, String), "/")}`
						)
					}
				}
			}
		}
	}
}

const checkOwner = (model: LawModel, s: Shape, law: ReturnType<typeof foldLaws>[number]): void => {
	const [check, ...more] = checksOf(model, "Owner", law)
	assert.ok(check !== undefined && more.length === 0, "the fold states one CHECK on its owner")
	const type = fieldNamed(model, "Owner", "end0").type
	const value = (v: bigint): ModelValue =>
		modelLiteral(succeeded(irLiteral(descOf(s.carrier, v), type)))
	for (const ends of tuples(valuesOf(s), planes(s))) {
		for (const n of [0n, 1n]) {
			const row: Row = new Map<string, ModelValue>([
				["n", n],
				...Arr.map(ends, (e, p) => [`end${p}`, value(e)] as const)
			])
			assert.equal(
				accepts(check, row),
				n > 0n || Arr.every(ends, (e) => e === identity(s)),
				`n ${n}, ends ${Arr.join(Arr.map(ends, String), "/")}`
			)
		}
	}
}

/**
 * Whether the fold's typing refuses it: a sum over money, which sum admits no more, since its combine `before + x` has
 * no CHECK in exact arithmetic: money's exact arithmetic is through its STABLE cast to numeric, which no CHECK holds.
 */
const refusedFold = (s: Shape): boolean => s.monoid === "sum" && s.carrier === "money"

export const checkShape = (s: Shape): void => {
	if (refusedFold(s)) {
		const e = refused(compiledModel(schemaOf(s)), "Refused")
		assert.equal(
			e.reason._tag === "Refused" ? e.reason.refusal : undefined,
			"the monoid admits the step value's type: sum an exact number, or and twos a set, max an ordered value with a least one, concat a text"
		)
		return
	}
	const model = modelOf(schemaOf(s))
	assertWellFormed(model)
	const [law, ...others] = foldLaws(model)
	assert.ok(law !== undefined && others.length === 0, "the schema states one fold")
	const cols = columnsOf(model, s)
	/** An accumulator's column as a foreign key's pair names it: a named field, or a hidden drawn column. */
	const text = (kind: "before" | "after", p: number): string =>
		s.accumulators === "named" ? `${kind}${p}` : `‹${kind} 0.${p}›`
	const fks = foreignKeyShapes(model)
	for (const [p] of cols.entries()) {
		assert.ok(
			Arr.some(
				fks,
				(fk) =>
					fk.from === "Member" &&
					fk.to === "Member" &&
					Arr.contains(fk.pairs, `${text("before", p)} → ${text("after", p)}`)
			),
			`the predecessor axis copies plane ${p}'s after into its before`
		)
		assert.ok(
			Arr.some(
				fks,
				(fk) => fk.from === "Owner" && Arr.contains(fk.pairs, `end${p} → ${text("after", p)}`)
			),
			`the last axis copies plane ${p}'s last after into its end`
		)
	}
	checkMember(model, s, law)
	checkOwner(model, s, law)
}

/** The monoids the stable-naming box folds by, each over the carrier its end holds and its identity. */
type Hidden = "count" | "sum" | "max"

const hiddenEnds: {
	readonly [M in Hidden]: { readonly type: FieldDesc; readonly start: LiteralDesc }
} = {
	count: { type: f.natural, start: 0n },
	sum: { type: f.bigint, start: 0n },
	max: { type: f.bigint, start: -9_223_372_036_854_775_808n }
}

/** Hidden folds over one counted family, in order, each into its own end. */
export const hiddenFolds = (folds: ReadonlyArray<Hidden>): SchemaDesc => ({
	name: "Folds",
	relations: [
		relation(
			"Owner",
			{
				id: f.uuid,
				n: f.drawn,
				...Rec.fromEntries(
					Arr.map(
						folds,
						(m) => [`${m}End`, f.accumulated(hiddenEnds[m].type, hiddenEnds[m].start)] as const
					)
				)
			},
			["id"]
		),
		relation("Member", { id: f.uuid, owner: f.uuid, x: f.bigint }, ["id"])
	],
	statements: [
		counted(on("Member", ["owner"]), fin("Owner", "n")),
		...Arr.map(folds, (m) =>
			fold(
				fin("Owner", "n"),
				m,
				on("Member", m === "count" ? ["owner"] : ["owner", "x"]),
				on("Owner", ["id", `${m}End`])
			)
		)
	],
	bases: []
})

/** A family's hidden folds in order, and the one a second schema removes. */
interface Removal {
	readonly folds: ReadonlyArray<Hidden>
	readonly removed: number
}

/** The box: every order of two or three distinct hidden folds, and each of them removed. */
export const removalGen: Gen<Removal> = (source) => {
	const folds = source.draw(shuffled(["count", "sum", "max"] as const, { min: 2, max: 3 }))
	return { folds, removed: source.draw(int(0, folds.length - 1)) }
}

export type NamesFeature = `${Hidden} removed` | "a fold before the removed one" | "a fold after it"

/** The identifiers of the hidden accumulators the family's folds name, each fold's in plane order, by its monoid. */
export const hiddenOf = (model: LawModel): ReadonlyMap<MonoidName, ReadonlyArray<ColumnIdent>> =>
	new Map(
		Arr.flatMap(model.families, (family) =>
			Arr.map(
				family.folds,
				(fold) =>
					[
						fold.monoid,
						Arr.flatMap(fold.planes, (p) =>
							Arr.flatMap([p.before, p.after], (c) => (c.kind === "law" ? [c.column] : []))
						)
					] as const
			)
		)
	)
