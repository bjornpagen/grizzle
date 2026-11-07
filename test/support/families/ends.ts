/**
 * Every fold's end and running values as the README's family semantics state them ("Families": fold), a host model that
 * never runs grizzle's filler: each owner's end is its members' step values combined by the monoid from its identity,
 * in member order, and each named accumulator is the running value before and after its member's step.
 *
 * The space is grizzle's own rosters, so a monoid or a carrier src adds is a cell here without an edit:
 *
 * - every monoid of the closed set (ir/desc.ts monoidNames), each over every plane its admission accepts
 *   (ir/monoid.ts admits), from the plane kinds a monoid branches on: the integer types, natural apart from bigint,
 *   numeric(8, 2), money, a closed id, text, and a set over a roster of every width from one code to nine, so widths
 *   that fill whole hex digits and widths that pad the last one;
 * - every family kind: a counted family folds the commutative monoids only, its accumulators hidden; an ordered family
 *   and a tree fold every monoid, concat's pair named as its law needs and the pairs of a set of even width named too,
 *   the rest hidden.
 *
 * One family's predecessor axis carries every plane of its folds within one UNIQUE, so each monoid folds a family of
 * its own: a member relation per monoid under one owner (counted, ordered), its count field `n_<monoid>`, or a tree
 * relation per monoid. Values are exact: an integer in its own unit, numeric(8, 2) in hundredths, money in cents, a
 * closed id as its code and a set as the bit mask of its codes, text as itself.
 */
import { element, type Gen, int, string } from "@grizzle/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { int2Min, int4Min, int8Min } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type MonoidName, monoidNames } from "#compiler/ir/desc.ts"
import { monoidSpecs } from "#compiler/ir/monoid.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { bits, closedId, natural, pg } from "#compiler/public/fields.ts"
import { schema, type Statement } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { describeFieldOrThrow } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import {
	accumulatedField,
	bitsOf,
	closed,
	drawnField,
	relation
} from "#compiler/schema/relation.ts"
import {
	countedBuilder,
	finBuilder,
	foldBuilder,
	monoids,
	mutableBuilder,
	onBuilder,
	orderedBuilder,
	treeBuilder
} from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRelation, AnyRoster } from "#compiler/types/schema/relation.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"

/** The family kinds a fold folds. */
export type FamilyKind = "counted" | "ordered" | "tree"

export const familyKinds: Arr.NonEmptyReadonlyArray<FamilyKind> = ["counted", "ordered", "tree"]

/** The widths of the rosters a set is drawn over: one code to nine, the box a set's hex spelling turns on. */
export const setWidths: Arr.NonEmptyReadonlyArray<number> = nonEmpty(Arr.range(1, 9))

/** The plain plane kinds a monoid's admission and identity branch on, each one field kind. */
type PlainKind = "int2" | "int4" | "int8" | "natural" | "numeric" | "money" | "code" | "text"

const plainKinds: Arr.NonEmptyReadonlyArray<PlainKind> = [
	"int2",
	"int4",
	"int8",
	"natural",
	"numeric",
	"money",
	"code",
	"text"
]

/** A plane's kind: a plain one, or a set over the roster of `width` codes. */
export type PlaneKind =
	| { readonly kind: PlainKind }
	| { readonly kind: "bits"; readonly width: number }

/** A plane kind's name in field names and situations. */
export type PlaneLabel = PlainKind | `bits${number}`

const planeLabel = (p: PlaneKind): PlaneLabel => (p.kind === "bits" ? `bits${p.width}` : p.kind)

/** Every plane kind: each plain one, and a set over each width. */
const planeKinds: Arr.NonEmptyReadonlyArray<PlaneKind> = [
	...Arr.map(plainKinds, (kind): PlaneKind => ({ kind })),
	...Arr.map(setWidths, (width): PlaneKind => ({ kind: "bits", width }))
]

/** The handles of the roster of `width` codes, h0 to h(width - 1). */
const setHandles = (width: number): Arr.NonEmptyReadonlyArray<string> =>
	nonEmpty(Arr.map(Arr.range(0, width - 1), (c) => `h${c}`))

/** The handles of the closed id's roster, k0 to k3, in code order. */
const codeHandles: Arr.NonEmptyReadonlyArray<string> = ["k0", "k1", "k2", "k3"]

/** The rosters one schema declares: a set's per width, and the closed id's. */
interface Rosters {
	readonly sets: ReadonlyMap<number, AnyRoster>
	readonly code: AnyRoster
}

const rostersOf = (): Rosters => ({
	sets: new Map(Arr.map(setWidths, (w) => [w, closed(`R${w}`, setHandles(w), [])] as const)),
	code: closed("K", codeHandles, [])
})

const setRoster = (rosters: Rosters, width: number): AnyRoster =>
	defined(rosters.sets.get(width), `the roster of ${width} codes`)

/** Text of at most eight letters: a concat's pieces and running texts, bounded so the family's axes key them. */
const textField = str.regex("^[a-c]{0,8}$")

/** A plane kind's field. */
const fieldOf = (rosters: Rosters, p: PlaneKind): FieldBase => {
	switch (p.kind) {
		case "int2":
			return pg.smallint
		case "int4":
			return pg.integer
		case "int8":
			return pg.bigint
		case "natural":
			return natural
		case "numeric":
			return pg.numeric(8, 2)
		case "money":
			return pg.money
		case "code":
			return closedId(rosters.code)
		case "text":
			return textField
		case "bits":
			return bits(setRoster(rosters, p.width))
	}
}

/** A plane kind's scalar type, which a monoid's admission reads. */
const typeOf = (p: PlaneKind): ScalarType =>
	describeFieldOrThrow(fieldOf(rostersOf(), p), SourceLoc(`plane ${planeLabel(p)}`, [])).scalar

/** A value of a plane: exact units, or text, concat's. */
export type Value = bigint | string

/** One value per plane, in plane order. */
export type Planes = Arr.NonEmptyReadonlyArray<Value>

/**
 * A fold of the space: its monoid over one plane kind, its member's step field (none for count, which steps by one),
 * its owner's end field per plane, and its member's (before, after) fields per plane where it names them.
 */
export interface Cell {
	readonly monoid: MonoidName
	readonly plane: PlaneKind
	readonly step: string | undefined
	readonly ends: Arr.NonEmptyReadonlyArray<string>
	readonly pairs: ReadonlyArray<{ readonly before: string; readonly after: string }>
}

/** A cell's name in situations: its monoid and its plane. */
export type CellLabel = `${MonoidName} over ${PlaneLabel}`

export const cellLabel = (c: Cell): CellLabel => `${c.monoid} over ${planeLabel(c.plane)}`

/** Whether a family of `kind` names a cell's accumulators: concat's always, a set's of even width outside a counted
 * family, never a counted family's, whose order is hidden. */
const namesPairs = (kind: FamilyKind, monoid: MonoidName, p: PlaneKind): boolean =>
	kind !== "counted" &&
	(!monoidSpecs[monoid].commutative || (p.kind === "bits" && p.width % 2 === 0))

/** Every cell a family of `kind` folds, by monoid: each monoid's planes its admission accepts, a counted family's
 * commutative monoids only. */
const cellsOf = (kind: FamilyKind): ReadonlyArray<Arr.NonEmptyReadonlyArray<Cell>> =>
	Arr.flatMap(monoidNames, (monoid) => {
		const spec = monoidSpecs[monoid]
		if (kind === "counted" && !spec.commutative) {
			return []
		}
		const cells = Arr.map(
			Arr.filter(planeKinds, (p) => spec.admits(typeOf(p))),
			(p): Cell => {
				const label = `${monoid}_${planeLabel(p)}`
				const planes = Arr.range(0, spec.planes - 1)
				return {
					monoid,
					plane: p,
					step: spec.step === "none" ? undefined : `x_${planeLabel(p)}`,
					ends: nonEmpty(Arr.map(planes, (i) => `e_${label}_${i}`)),
					pairs: namesPairs(kind, monoid, p)
						? Arr.map(planes, (i) => ({ before: `b_${label}_${i}`, after: `a_${label}_${i}` }))
						: []
				}
			}
		)
		return Arr.isReadonlyArrayNonEmpty(cells) ? [cells] : []
	})

/** The identity of each plane of a cell's monoid, in exact units: 0, the empty set, max's least value, the empty text. */
export const identityOf = (c: Cell): Planes => {
	switch (c.monoid) {
		case "count":
		case "sum":
		case "or":
			return [0n]
		case "twos":
			return [0n, 0n]
		case "concat":
			return [""]
		case "max":
			switch (c.plane.kind) {
				case "int2":
					return [BigInt(int2Min.value)]
				case "int4":
					return [BigInt(int4Min.value)]
				case "int8":
				case "money":
					return [int8Min.value]
				case "natural":
				case "code":
				case "bits":
				case "numeric":
				case "text":
					return [0n]
			}
	}
}

/** A value as exact units: text, which only concat holds, fails the case. */
const units = (v: Value): bigint =>
	typeof v === "bigint" ? v : assert.fail(`exact units, not the text ${v}`)

/**
 * Each plane's after from the befores and the step, as the README states each monoid: count adds one, sum adds x, or
 * unites, twos keeps the handles seen once and those seen twice, max keeps the greater, concat appends.
 */
const combine = (m: MonoidName, befores: Planes, x: Value | undefined): Planes => {
	const [first, second = 0n] = befores
	switch (m) {
		case "count":
			return [units(first) + 1n]
		case "sum":
			return [units(first) + units(defined(x, "a sum's step"))]
		case "or":
			return [units(first) | units(defined(x, "an or's step"))]
		case "twos": {
			const step = units(defined(x, "a twos' step"))
			return [units(first) | step, units(second) | (units(first) & step)]
		}
		case "max": {
			const step = units(defined(x, "a max's step"))
			return [units(first) > step ? first : step]
		}
		case "concat":
			return [`${String(first)}${String(defined(x, "a concat's step"))}`]
	}
}

/** A member's running values: each plane before its step and after it. */
export interface Running {
	readonly before: Planes
	readonly after: Planes
}

/** The fold of a cell over its members' steps in order: each member's running values, and the end. */
export const foldOf = (
	c: Cell,
	steps: ReadonlyArray<Value | undefined>
): { readonly running: ReadonlyArray<Running>; readonly end: Planes } => {
	let at = identityOf(c)
	const running: Array<Running> = []
	for (const x of steps) {
		const after = combine(c.monoid, at, x)
		running.push({ before: at, after })
		at = after
	}
	return { running, end: at }
}

/** A plane's value as the host value a fact holds and a stored row reads back. */
export const hostOf = (p: PlaneKind, v: Value): unknown => {
	switch (p.kind) {
		case "int2":
		case "int4":
			return Number(units(v))
		case "int8":
		case "natural":
			return units(v)
		case "numeric":
			return Decimal.fromMinorUnits(units(v))
		case "money":
			return Money.of(units(v))
		case "code":
			return defined(codeHandles[Number(units(v))], "a closed id's code")
		case "text":
			return String(v)
		case "bits": {
			const mask = units(v)
			return new Set(Arr.filter(setHandles(p.width), (_, c) => (mask & (1n << BigInt(c))) !== 0n))
		}
	}
}

/** The step values of a plane kind: a box of small units per carrier, every subset of a set's roster, short texts. */
const stepGen = (p: PlaneKind): Gen<Value> => {
	switch (p.kind) {
		case "int2":
		case "int4":
		case "int8":
			return (source) => BigInt(source.draw(int(-3, 6)))
		case "natural":
			return (source) => BigInt(source.draw(int(0, 6)))
		case "numeric":
		case "money":
			return (source) => BigInt(source.draw(int(-450, 450)))
		case "code":
			return (source) => BigInt(source.draw(int(0, codeHandles.length - 1)))
		case "text":
			return string(element(["a", "b", "c"]), { min: 0, max: 2 })
		case "bits":
			return (source) => BigInt(source.draw(int(0, 2 ** p.width - 1)))
	}
}

/** One monoid's family: its member relation, its count field on its owner, and its cells. */
export interface Group {
	readonly monoid: MonoidName
	readonly member: AnyRelation
	readonly count: string
	readonly cells: Arr.NonEmptyReadonlyArray<Cell>
}

/**
 * A schema of one family kind: its groups, its owner relation (a counted or an ordered family's, which a tree's schema
 * declares and folds nothing into), the schema value under a declared name, and its stored relations' names.
 */
export interface FoldSchema {
	readonly kind: FamilyKind
	readonly groups: Arr.NonEmptyReadonlyArray<Group>
	readonly owner: AnyRelation
	readonly value: (declared: string) => ReturnType<typeof schemaOf>
	readonly relations: Arr.NonEmptyReadonlyArray<string>
}

/** A schema of the space's relations and statements under a declared name. */
const schemaOf = (
	name: string,
	relations: Readonly<Record<string, AnyRoster | AnyRelation>>,
	statements: ReadonlyArray<Statement>
) => schema(name, relations, statements)

/** A field and its name. */
type Named = readonly [name: string, field: FieldBase]

/** A cell's accumulated fields, each named for one plane, starting at that plane's identity. */
const accumulators = (
	rosters: Rosters,
	c: Cell,
	names: ReadonlyArray<readonly [name: string, plane: number]>
): ReadonlyArray<Named> => {
	const identity = identityOf(c)
	return Arr.map(names, ([name, plane]): Named => [
		name,
		accumulatedField(
			fieldOf(rosters, c.plane),
			startOf(rosters, c, defined(identity[plane], "a plane's identity")),
			[]
		)
	])
}

/** An identity as the host value an accumulated field starts at: a set's is the roster's empty Bits. */
const startOf = (rosters: Rosters, c: Cell, v: Value): unknown =>
	c.plane.kind === "bits" ? bitsOf(setRoster(rosters, c.plane.width), [], []) : hostOf(c.plane, v)

/**
 * The member fields a group's cells read and name: every step field and every named accumulator. A group is one
 * monoid's, whose cells are each over a plane of their own, so no two cells share a step field.
 */
const memberFields = (rosters: Rosters, cells: ReadonlyArray<Cell>): ReadonlyArray<Named> => [
	...Arr.flatMap(cells, (c): ReadonlyArray<Named> =>
		c.step === undefined ? [] : [[c.step, fieldOf(rosters, c.plane)]]
	),
	...Arr.flatMap(cells, (c) =>
		accumulators(
			rosters,
			c,
			Arr.flatMap(c.pairs, (p, plane): ReadonlyArray<readonly [string, number]> => [
				[p.before, plane],
				[p.after, plane]
			])
		)
	)
]

/** The end fields of a group's cells. */
const endFields = (rosters: Rosters, cells: ReadonlyArray<Cell>): ReadonlyArray<Named> =>
	Arr.flatMap(cells, (c) =>
		accumulators(
			rosters,
			c,
			Arr.map(c.ends, (end, plane): readonly [string, number] => [end, plane])
		)
	)

/** A cell's step side's terms after its group: its step field and its named accumulators. */
const stepTerms = (c: Cell): ReadonlyArray<string> => [
	...(c.step === undefined ? [] : [c.step]),
	...Arr.flatMap(c.pairs, (p) => [p.before, p.after])
]

/**
 * The schema of a family kind: for a counted or an ordered family, one mutable owner `Owner` (id, label, a count per
 * monoid and every end) and a mutable member relation `M_<monoid>` per monoid (id, its owner o, an ordered family's at,
 * its steps and named accumulators); for trees, a relation `T_<monoid>` per monoid, each its own tree, whose every node
 * holds its children's fold.
 */
export const foldSchema = (kind: FamilyKind): FoldSchema => {
	const rosters = rostersOf()
	const drawnNatural = drawnField(natural, [])
	const groups = Arr.map(cellsOf(kind), (cells): Group => {
		const monoid = Arr.headNonEmpty(cells).monoid
		const own = memberFields(rosters, cells)
		const fields: ReadonlyArray<Named> =
			kind === "tree"
				? [
						["id", pg.integer],
						["doc", pg.integer],
						["parent", pg.integer],
						["at", drawnNatural],
						["children", drawnNatural],
						["start", drawnNatural],
						["end", drawnNatural],
						...own,
						...endFields(rosters, cells)
					]
				: [
						["id", pg.integer],
						["o", pg.integer],
						...(kind === "ordered" ? [["at", drawnNatural] as const] : []),
						...own
					]
		return {
			monoid,
			member: relation(
				`${kind === "tree" ? "T" : "M"}_${monoid}`,
				Rec.fromEntries(fields),
				["id"],
				[]
			),
			count: kind === "tree" ? "children" : `n_${monoid}`,
			cells
		}
	})
	const owner = relation(
		"Owner",
		Rec.fromEntries([
			["id", pg.integer],
			["label", pg.integer],
			...Arr.flatMap(groups, (g): ReadonlyArray<Named> =>
				kind === "tree" ? [] : [[g.count, drawnNatural], ...endFields(rosters, g.cells)]
			)
		]),
		["id"],
		[]
	)
	const statements = Arr.flatMap(groups, (g): ReadonlyArray<Statement> => {
		const family =
			kind === "tree"
				? treeBuilder(onBuilder(g.member, ["parent", "at"]), finBuilder(g.member, "children"), {
						root: "doc"
					})
				: kind === "ordered"
					? orderedBuilder(onBuilder(g.member, ["o", "at"]), finBuilder(owner, g.count))
					: countedBuilder(onBuilder(g.member, ["o"]), finBuilder(owner, g.count))
		return [
			family,
			...(kind === "tree" ? [] : [mutableBuilder(g.member)]),
			...Arr.map(g.cells, (c) =>
				foldBuilder(
					family,
					monoids[c.monoid],
					onBuilder(g.member, [kind === "tree" ? "parent" : "o", ...stepTerms(c)]),
					onBuilder(kind === "tree" ? g.member : owner, ["id", ...c.ends])
				)
			)
		]
	})
	const members = Arr.map(groups, (g) => g.member)
	const stored = kind === "tree" ? members : [owner, ...members]
	const declared = Rec.fromEntries([
		...Arr.map(
			[...rosters.sets.values(), rosters.code],
			(r): readonly [string, AnyRoster | AnyRelation] => [r.name, r]
		),
		...Arr.map(stored, (r): readonly [string, AnyRoster | AnyRelation] => [r.name, r])
	])
	const all: ReadonlyArray<Statement> =
		kind === "tree" ? statements : [...statements, mutableBuilder(owner)]
	return {
		kind,
		groups: nonEmpty(groups),
		owner,
		value: (name) => schemaOf(name, declared, all),
		relations: nonEmpty(Arr.map(stored, (r) => r.name))
	}
}

/** A member's value at each step field of its family, by field name. */
export type Steps = Readonly<Record<string, Value>>

/** A member: its key, its owner (its parent in a tree), and its value at each step field of its family. */
export interface MemberState {
	readonly id: number
	readonly owner: number
	readonly steps: Steps
}

/** An owner: its key and its label. */
export interface OwnerState {
	readonly id: number
	readonly label: number
}

/**
 * The stored state of a counted or an ordered family's schema: its owners, and each monoid's members, an owner's in slot
 * order for an ordered family, in the order the model keeps them for a counted one, whose order is hidden.
 */
export interface State {
	readonly owners: ReadonlyArray<OwnerState>
	readonly members: ReadonlyMap<MonoidName, ReadonlyArray<MemberState>>
}

/** A tree's node as its insert nests it: its key, its step values, and its children in order. */
export interface Node {
	readonly id: number
	readonly steps: Steps
	readonly children: ReadonlyArray<Node>
}

export const emptyState: State = { owners: [], members: new Map() }

/** A group's members in the state. */
export const membersOf = (state: State, monoid: MonoidName): ReadonlyArray<MemberState> =>
	state.members.get(monoid) ?? []

/** A member's step values, drawn for each step field of its group. */
export const stepsGen =
	(g: Group): Gen<Steps> =>
	(source) =>
		Rec.fromEntries(
			Arr.flatMap(g.cells, (c): ReadonlyArray<readonly [string, Value]> =>
				c.step === undefined ? [] : [[c.step, source.draw(stepGen(c.plane))]]
			)
		)

/** A member's value at a step field. */
const stepAt = (steps: Steps, field: string): Value =>
	defined(Rec.has(steps, field) ? steps[field] : undefined, `the step ${field}`)

/** A cell's step value of a member: none for count. */
export const stepOf = (c: Cell, steps: Steps): Value | undefined =>
	c.step === undefined ? undefined : stepAt(steps, c.step)

/** A member's step fields as host values, each under its field's name. */
const stepEntries = (g: Group, steps: Steps): ReadonlyArray<readonly [string, unknown]> =>
	Arr.flatMap(g.cells, (c): ReadonlyArray<readonly [string, unknown]> =>
		c.step === undefined ? [] : [[c.step, hostOf(c.plane, stepAt(steps, c.step))]]
	)

/** A fact's step fields as host values. */
export const stepFacts = (g: Group, steps: Steps): Readonly<Record<string, unknown>> =>
	Rec.fromEntries(stepEntries(g, steps))

/** `n` values, each `f` of its index. */
export const times = <A>(n: number, f: (i: number) => A): ReadonlyArray<A> =>
	Array.from({ length: n }, (_, i) => f(i))

/** A cell's planes as host values under their field names. */
const planeEntries = (
	c: Cell,
	names: ReadonlyArray<string>,
	planes: Planes
): ReadonlyArray<readonly [string, unknown]> =>
	Arr.map(names, (name, i): readonly [string, unknown] => [
		name,
		hostOf(c.plane, defined(planes[i], "a plane"))
	])

/** A cell's named running values of one member, before and after. */
const runningEntries = (c: Cell, r: Running): ReadonlyArray<readonly [string, unknown]> => [
	...planeEntries(
		c,
		Arr.map(c.pairs, (p) => p.before),
		r.before
	),
	...planeEntries(
		c,
		Arr.map(c.pairs, (p) => p.after),
		r.after
	)
]

/** A row of the model: its fields' host values by name. */
export type ModelRow = Readonly<Record<string, unknown>>

/** The rows the model stores for a counted or an ordered family's schema, by relation: each owner's, each member's. */
export const storedRows = (
	s: FoldSchema,
	state: State
): ReadonlyMap<string, ReadonlyArray<ModelRow>> => {
	const folds = Arr.map(state.owners, (o) => ({
		owner: o,
		families: Arr.map(s.groups, (g) => {
			const mine = Arr.filter(membersOf(state, g.monoid), (m) => m.owner === o.id)
			return {
				g,
				mine,
				cells: Arr.map(g.cells, (c) => ({
					c,
					folded: foldOf(
						c,
						Arr.map(mine, (m) => stepOf(c, m.steps))
					)
				}))
			}
		})
	}))
	const owners = Arr.map(folds, ({ owner, families }) =>
		Rec.fromEntries([
			["id", owner.id],
			["label", owner.label],
			...Arr.flatMap(families, ({ g, mine, cells }): ReadonlyArray<readonly [string, unknown]> => [
				[g.count, BigInt(mine.length)],
				...Arr.flatMap(cells, ({ c, folded }) => planeEntries(c, c.ends, folded.end))
			])
		])
	)
	const memberRows = (g: Group): ReadonlyArray<ModelRow> =>
		Arr.flatMap(folds, ({ families }) =>
			Arr.flatMap(families, (f) =>
				f.g !== g
					? []
					: Arr.map(f.mine, (m, slot) =>
							Rec.fromEntries([
								["id", m.id],
								["o", m.owner],
								...(s.kind === "ordered" ? [["at", BigInt(slot)] as const] : []),
								...stepEntries(g, m.steps),
								...Arr.flatMap(f.cells, ({ c, folded }) =>
									Arr.isReadonlyArrayNonEmpty(c.pairs)
										? runningEntries(c, defined(folded.running[slot], "a member's running values"))
										: []
								)
							])
						)
			)
		)
	return new Map([
		[s.owner.name, owners],
		...Arr.map(s.groups, (g) => [g.member.name, memberRows(g)] as const)
	])
}

/**
 * The rows the model stores for a tree's relation: each node with its tree's drawn fields, its steps and its fold of its
 * children; a root's named running values are its own step from the identity, as its family's pin admits it alone.
 */
export const treeRows = (g: Group, trees: ReadonlyArray<Node>): ReadonlyArray<ModelRow> => {
	const out: Array<ModelRow> = []
	const visit = (
		node: Node,
		doc: number,
		parent: number,
		at: number,
		start: number,
		running: (c: Cell) => Running
	): number => {
		const folds = Arr.map(g.cells, (c) => ({
			c,
			folded: foldOf(
				c,
				Arr.map(node.children, (child) => stepOf(c, child.steps))
			)
		}))
		let next = start + 1
		for (const [i, child] of node.children.entries()) {
			next = visit(child, doc, node.id, i, next, (c) =>
				defined(
					Option.getOrUndefined(Arr.findFirst(folds, (f) => f.c === c))?.folded.running[i],
					"a child's running values"
				)
			)
		}
		out.push(
			Rec.fromEntries([
				["id", node.id],
				["doc", doc],
				["parent", parent],
				["at", BigInt(at)],
				["children", BigInt(node.children.length)],
				["start", BigInt(start)],
				["end", BigInt(next)],
				...stepEntries(g, node.steps),
				...Arr.flatMap(folds, ({ c, folded }) => [
					...planeEntries(c, c.ends, folded.end),
					...(Arr.isReadonlyArrayNonEmpty(c.pairs) ? runningEntries(c, running(c)) : [])
				])
			])
		)
		return next
	}
	for (const root of trees) {
		visit(root, root.id, root.id, 0, 0, (c) => ({
			before: identityOf(c),
			after: combine(c.monoid, identityOf(c), stepOf(c, root.steps))
		}))
	}
	return out
}

/** A tree's insert fact: its steps and its children nested at `children`, the root naming its tree by `doc`. */
export const treeFact = (g: Group, node: Node, root: boolean): ModelRow =>
	Rec.fromEntries([
		["id", node.id],
		...(root ? [["doc", node.id] as const] : []),
		...stepEntries(g, node.steps),
		["children", Arr.map(node.children, (child) => treeFact(g, child, false))]
	])
