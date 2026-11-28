/** What the properties of fin.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Record as Rec } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { cellsOfLiteral, payloadsOfLiteral } from "#compiler/ir/cells.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { closedId, drawn as drawnField, natural, slot } from "#compiler/public/fields.ts"
import {
	type AnyClosed,
	type AnyRelation,
	closed,
	fin,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import {
	closedBuilder,
	closedRelation as closedRelationBuilder,
	slotField
} from "#compiler/schema/relation.ts"
import {
	countedBuilder,
	finBuilder,
	onBuilder,
	orderedBuilder
} from "#compiler/schema/statements.ts"
import type { PackConstant, SqlStatement } from "#compiler/sql/ast.ts"
import type { ConstantFunctions } from "#compiler/sql/constants.ts"
import { succeeded } from "#test/support/assert.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { ownedInput } from "#test/support/policy.ts"

const Version = closed.ordered("Version", ["v0", "v1"])

const Kind = closed.ordered("Kind", ["k0", "k1"])

const Position = closed.ordered("Position", ["p0", "p1", "p2"])

const Label = closed.ordered("Label", ["x0", "x1"])

/** The owners, each a version and a kind, in the owner prefix's index order, version-major. */
const owners: ReadonlyArray<readonly ["v0" | "v1", "k0" | "k1"]> = [
	["v0", "k0"],
	["v0", "k1"],
	["v1", "k0"],
	["v1", "k1"]
]

/** What the count relation holds for one owner: no row, or a row counting 0 to 2 slots. */
type Held = "none" | 0 | 1 | 2

/** A slotted shape: two slots, one slot, or a closed id of Label before a slot. */
type Shape = "follow" | "last" | "symbol"

interface Declaration {
	readonly held: ReadonlyArray<Held>
	readonly shape: Shape
}

/** Every count relation of the four owners, each holding no row or counting 0 to 2, under each shape: 768. */
export const declarations: Gen<Declaration> = (s) => {
	const held = Array.from({ length: owners.length }, () => s.draw(element<Held>(["none", 0, 1, 2])))
	return { held, shape: s.draw(element<Shape>(["follow", "last", "symbol"])) }
}

/** The count an owner's row gives its slots: 0 where it has no row. */
const countOf = (held: Held): number => (held === "none" ? 0 : held)

/** The block a shape's key holds after the owner prefix, at an owner counting `count` slots. */
const radicesOf = (shape: Shape, count: number): ReadonlyArray<number> =>
	shape === "follow" ? [count, count] : shape === "last" ? [count] : [2, count]

/** Every point of the space whose coordinates hold `sizes` codes each, first coordinate most significant. */
const odometer = (sizes: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<number>> => {
	const origin: ReadonlyArray<ReadonlyArray<number>> = [[]]
	return Arr.reduce(sizes, origin, (prefixes, size) =>
		Arr.flatMap(prefixes, (prefix) =>
			Array.from({ length: size }, (_, digit) => [...prefix, digit])
		)
	)
}

/**
 * The dependent sum's points in order, each its owner's index then its block's codes: every owner's block, owner by
 * owner, each block in its odometer's order at its owner's radices.
 */
const pointsOf = (d: Declaration): ReadonlyArray<ReadonlyArray<number>> =>
	Arr.flatMap(d.held, (held, owner) =>
		Arr.map(odometer(radicesOf(d.shape, countOf(held))), (local) => [owner, ...local])
	)

/**
 * The rows the slotted relation holds: the points whose codes, each weighted by its place from 1, sum to an even
 * number, a sparse half of the space that no exchange of a block's coordinates maps to itself, so a block enumerated in
 * another order of its coordinates places some row where none is held.
 */
const heldPoints = (d: Declaration): ReadonlyArray<ReadonlyArray<number>> =>
	Arr.filter(pointsOf(d), (p) => Arr.reduce(p, 0, (a, b, i) => a + (i + 1) * b) % 2 === 0)

/** The count each owner's row holds, none where it holds no row. */
const countsOf = (held: ReadonlyArray<Held>): ReadonlyArray<bigint | undefined> =>
	Arr.map(held, (h) => (h === "none" ? undefined : BigInt(h)))

/** The count relation Model: one row per owner it holds a count for. */
const modelOf = (counts: ReadonlyArray<bigint | undefined>) =>
	closed.relation(
		"Model",
		{ version: closedId(Version), parent: closedId(Kind), positions: natural },
		["version", "parent"],
		Arr.flatMap(counts, (positions, owner) => {
			const [version, parent] = defined(owners[owner])
			return positions === undefined ? [] : [{ version, parent, positions }]
		})
	)

/** The handle of a Position code. */
const positionAt = (code: number): "p0" | "p1" | "p2" =>
	defined((["p0", "p1", "p2"] as const)[code])

/** The handle of a Label code. */
const labelAt = (code: number): "x0" | "x1" => defined((["x0", "x1"] as const)[code])

/** A held point's owner, as its version and kind, and its block's codes. */
const ownerOf = (point: ReadonlyArray<number>) => {
	const [owner, ...block] = point
	const [version, parent] = defined(owners[owner ?? 0])
	return { version, parent, block }
}

/** A row of the slotted relation at an owner, each of its slots at `code`: past the owner's count when planted so. */
interface PastRow {
	readonly owner: number
	readonly code: number
}

/**
 * The slotted relation Slotted of a declaration over the count relation `Model`, holding the declaration's rows and
 * `past`'s, if any, and its slot fields keyed, or its last one left in the payload when `payload` says so.
 */
const slottedOf = (
	d: Declaration,
	Model: ReturnType<typeof modelOf>,
	past: PastRow | undefined,
	payload: boolean
) => {
	const positionSlot = slot(closedId(Position), fin(Model, "positions"))
	const prefix = { version: closedId(Version), parent: closedId(Kind) }
	const points = Arr.map(heldPoints(d), ownerOf)
	const code = (block: ReadonlyArray<number>, i: number): number => defined(block[i])
	const planted = past === undefined ? [] : [ownerOf([past.owner, past.code, past.code])]
	switch (d.shape) {
		case "follow":
			return closed.relation(
				"Slotted",
				{ ...prefix, from: positionSlot, to: positionSlot },
				payload ? ["version", "parent", "from"] : ["version", "parent", "from", "to"],
				Arr.map([...points, ...planted], ({ version, parent, block }) => ({
					version,
					parent,
					from: positionAt(code(block, 0)),
					to: positionAt(code(block, 1))
				}))
			)
		case "last":
			return closed.relation(
				"Slotted",
				{ ...prefix, at: positionSlot },
				payload ? ["version", "parent"] : ["version", "parent", "at"],
				Arr.map([...points, ...planted], ({ version, parent, block }) => ({
					version,
					parent,
					at: positionAt(code(block, 0))
				}))
			)
		case "symbol":
			return closed.relation(
				"Slotted",
				{ ...prefix, label: closedId(Label), position: positionSlot },
				payload ? ["version", "parent", "label"] : ["version", "parent", "label", "position"],
				Arr.map(
					[...points, ...Arr.map(planted, (p) => ({ ...p, block: [0, defined(p.block[0])] }))],
					({ version, parent, block }) => ({
						version,
						parent,
						label: labelAt(code(block, 0)),
						position: positionAt(code(block, 1))
					})
				)
			)
	}
}

/** The schema of a declaration: its count relation Model and its slotted relation Slotted. */
export const schemaOf = (d: Declaration) => {
	const Model = modelOf(countsOf(d.held))
	const Slotted = slottedOf(d, Model, undefined, false)
	return schema("Fin", [Version, Kind, Position, Label, Model, Slotted], [])
}

/** A schema value's installation, its refusal on the way included. */
export const compiled = (value: FixtureSchema) =>
	Result.flatMap(ownedInput(value), (owned) => compileInstallation(owned, installOptions(owned)))

/** A pack's elements, an index or a payload code each, read back from its literal over its layout. */
const elementsOf = (p: PackConstant): ReadonlyArray<bigint> =>
	succeeded(
		p.layout.kind === "cells"
			? cellsOfLiteral(p.text, p.layout.cells)
			: payloadsOfLiteral(p.text, p.layout.points)
	)

/** The payload codes a constant's functions hold, in its cells' order: its payloads', or 0 for each cell of one code. */
const payloadsOf = (
	statements: ReadonlyArray<SqlStatement>,
	f: ConstantFunctions
): ReadonlyArray<bigint> =>
	f.payloads.kind === "codes"
		? elementsOf(packOf(statements, f.payloads.function.name))
		: Arr.map(elementsOf(packOf(statements, f.cells.name)), () => 0n)

/** The pack of the function named `name` among an installation's statements. */
const packOf = (statements: ReadonlyArray<SqlStatement>, name: string): PackConstant =>
	defined(
		Arr.flatMap(statements, (s) =>
			s.kind === "packConstant" && s.function.name === name ? [s] : []
		)[0],
		`the pack of ${name}`
	)

export type Planned =
	| "an owner with no row"
	| "an owner counting no slot"
	| "every owner counting slots"
	| "an empty space"
	| "a closed id before a slot"
	| "two slots"

/**
 * The cells hold Σ over owners of its block, each held row at its point's position in the dependent sum, and the
 * owner functions hold each owner's base, its count of the blocks before it, and its count, one count function for
 * Model's fin however many slots it counts. Oracle: the enumeration (pointsOf) under the first
 * installation's codes, each handle's code its declared position.
 */
export const planned = (d: Declaration, c: Case<Planned>) =>
	Effect.sync(() => {
		const installation = succeeded(compiled(schemaOf(d)))
		const constant = installation.names.closed("Slotted")
		const points = pointsOf(d)
		assert.equal(
			constant.key.kind,
			"dependent",
			"a key over a count relation's prefix is a dependent sum"
		)
		const cellsPack = packOf(installation.statements, constant.constant.cells.name)
		assert.deepEqual(
			cellsPack.layout,
			{ kind: "cells", cells: BigInt(points.length) },
			"the key space holds every owner's block and no more"
		)
		const position = new Map(
			Arr.map(points, (p, at) => [Arr.join(Arr.map(p, String), ","), at] as const)
		)
		assert.deepEqual(
			elementsOf(cellsPack),
			Arr.map(heldPoints(d), (p) =>
				BigInt(defined(position.get(Arr.join(Arr.map(p, String), ","))))
			),
			"each row lies at its key's position in the dependent sum"
		)
		if (constant.key.kind === "dependent") {
			assert.equal(
				constant.key.counts.length,
				1,
				"every slot counts by Model's one fin, whose counts one function holds"
			)
			assert.deepEqual(
				payloadsOf(installation.statements, constant.key.counts[0]),
				Arr.map(d.held, (h) => BigInt(countOf(h))),
				"each owner's count, every owner listed"
			)
			const blocks = Arr.map(d.held, (h) =>
				Arr.reduce(radicesOf(d.shape, countOf(h)), 1, (a, b) => a * b)
			)
			assert.deepEqual(
				payloadsOf(installation.statements, constant.key.bases),
				Arr.map(blocks, (_, owner) =>
					BigInt(Arr.reduce(blocks.slice(0, owner), 0, (a, b) => a + b))
				),
				"each owner's base is the cells of the blocks before it"
			)
		}
		if (d.held.includes("none")) {
			c.note("an owner with no row")
		}
		if (d.held.includes(0)) {
			c.note("an owner counting no slot")
		}
		if (Arr.every(d.held, (h) => countOf(h) > 0)) {
			c.note("every owner counting slots")
		}
		if (points.length === 0) {
			c.note("an empty space")
		}
		if (d.shape === "symbol") {
			c.note("a closed id before a slot")
		}
		if (d.shape === "follow") {
			c.note("two slots")
		}
	})

/** The rule a planted fault breaks. */
export type FaultKind =
	| "a slot past its owner's count"
	| "a count past the slot roster's codes"
	| "a count that is not natural"
	| "an owner key that does not pair"
	| "a slot inside the owner prefix"
	| "two owner prefixes"
	| "a slot in the payload"
	| "a slot in an ordinary relation"
	| "a fin over an ordinary relation"
	| "a family over a closed relation's fin"
	| "a count relation the schema does not declare"

export const faultKinds: Arr.NonEmptyReadonlyArray<FaultKind> = [
	"a slot past its owner's count",
	"a count past the slot roster's codes",
	"a count that is not natural",
	"an owner key that does not pair",
	"a slot inside the owner prefix",
	"two owner prefixes",
	"a slot in the payload",
	"a slot in an ordinary relation",
	"a fin over an ordinary relation",
	"a family over a closed relation's fin",
	"a count relation the schema does not declare"
]

/**
 * The reason each fault's rule refuses it by: a description's malformation, or a rule the types name too (Refused),
 * a family counting by a closed relation's fin.
 */
export const faultTags: { readonly [K in FaultKind]: "MalformedDescription" | "Refused" } = {
	"a slot past its owner's count": "MalformedDescription",
	"a count past the slot roster's codes": "MalformedDescription",
	"a count that is not natural": "MalformedDescription",
	"an owner key that does not pair": "MalformedDescription",
	"a slot inside the owner prefix": "MalformedDescription",
	"two owner prefixes": "MalformedDescription",
	"a slot in the payload": "MalformedDescription",
	"a slot in an ordinary relation": "MalformedDescription",
	"a fin over an ordinary relation": "MalformedDescription",
	"a family over a closed relation's fin": "Refused",
	"a count relation the schema does not declare": "MalformedDescription"
}

/** The carriers a count may be declared with that are not natural. */
type Counting = "integer" | "bigint" | "smallint"

/** How an owner key fails to pair with the count relation's: its fields in the other order, or their rosters swapped. */
type Unpaired = "reordered" | "rosters swapped"

/** A fault and what it is planted with. */
type Fault =
	| { readonly kind: "a slot past its owner's count"; readonly past: PastRow }
	| {
			readonly kind: "a count past the slot roster's codes"
			readonly owner: number
			readonly count: bigint
	  }
	| { readonly kind: "a count that is not natural"; readonly carrier: Counting }
	| { readonly kind: "an owner key that does not pair"; readonly how: Unpaired }
	| { readonly kind: "a slot inside the owner prefix" }
	| { readonly kind: "two owner prefixes" }
	| { readonly kind: "a slot in the payload" }
	| { readonly kind: "a slot in an ordinary relation" }
	| { readonly kind: "a fin over an ordinary relation" }
	| {
			readonly kind: "a family over a closed relation's fin"
			readonly family: "ordered" | "counted"
	  }
	| { readonly kind: "a count relation the schema does not declare" }

interface Faulted {
	readonly declaration: Declaration
	readonly fault: Fault
}

/** A fault of `kind` planted in `d`, its parameters drawn: an owner and a code past its count, a count past 3. */
const faultGen =
	(d: Declaration, kind: FaultKind): Gen<Fault> =>
	(s) => {
		switch (kind) {
			case "a slot past its owner's count": {
				const owner = s.draw(int(0, owners.length - 1))
				const code = s.draw(int(countOf(defined(d.held[owner])), 2))
				return { kind, past: { owner, code } }
			}
			case "a count past the slot roster's codes":
				return {
					kind,
					owner: s.draw(int(0, owners.length - 1)),
					count: BigInt(s.draw(int(4, 6)))
				}
			case "a count that is not natural":
				return { kind, carrier: s.draw(element<Counting>(["integer", "bigint", "smallint"])) }
			case "an owner key that does not pair":
				return { kind, how: s.draw(element<Unpaired>(["reordered", "rosters swapped"])) }
			case "a family over a closed relation's fin":
				return { kind, family: s.draw(element(["ordered", "counted"] as const)) }
			case "a slot inside the owner prefix":
			case "two owner prefixes":
			case "a slot in the payload":
			case "a slot in an ordinary relation":
			case "a fin over an ordinary relation":
			case "a count relation the schema does not declare":
				return { kind }
		}
	}

export const faultedGen: Gen<Faulted> = (s) => {
	const declaration = s.draw(declarations)
	const kind = s.draw(element(faultKinds))
	return { declaration, fault: s.draw(faultGen(declaration, kind)) }
}

/** Where a refusal is reported: the path and label of its location, never its call site or prose. */
interface Site {
	readonly path: ReadonlyArray<string | number>
	readonly label: string
}

/**
 * A planted declaration, and where its rule refuses it: a builder that throws on the malformed call, at the call's
 * site, or the compiler, whose Result fails at the relation or slot the rule names.
 */
type Planted =
	| { readonly stage: "builder"; readonly attempt: () => unknown; readonly at: Site }
	| {
			readonly stage: "compile"
			readonly attempt: () => Result.Result<unknown, CompileError>
			readonly at: Site
	  }

/** The slot field a shape's key holds first. */
const firstSlot = (shape: Shape): string =>
	shape === "follow" ? "from" : shape === "last" ? "at" : "position"

const atSlot = (field: string): Site => ({
	path: ["Slotted", field],
	label: `slot Slotted.${field}`
})

/** The declaration with its fault planted, and the site the fault's rule names. */
export const plant = ({ declaration: d, fault }: Faulted): Planted => {
	const counts = countsOf(d.held)
	const Model = modelOf(counts)
	const prefix = { version: closedId(Version), parent: closedId(Kind) }
	const positionSlot = slot(closedId(Position), fin(Model, "positions"))
	const atConstant: Site = { path: [], label: "closed relation Slotted" }
	/** The schema of `relations` beside the rosters, as the compiler takes it. */
	const declaring = (relations: Readonly<Record<string, AnyRelation | AnyClosed>>) => {
		const declared: Record<string, AnyRelation | AnyClosed> = {
			Version,
			Kind,
			Position,
			Label,
			...relations
		}
		return compiled(schema("Fin", Rec.values(declared), []))
	}
	switch (fault.kind) {
		case "a slot past its owner's count":
			return {
				stage: "compile",
				attempt: () => declaring({ Model, Slotted: slottedOf(d, Model, fault.past, false) }),
				at: atConstant
			}
		case "a count past the slot roster's codes": {
			const Wide = modelOf(Arr.map(counts, (c, owner) => (owner === fault.owner ? fault.count : c)))
			return {
				stage: "compile",
				attempt: () => declaring({ Model: Wide, Slotted: slottedOf(d, Wide, undefined, false) }),
				at: atConstant
			}
		}
		case "a count that is not natural":
			return {
				stage: "compile",
				attempt: () => {
					const Counts = closedRelationBuilder(
						"Counts",
						{ ...prefix, positions: pgDescriptors[fault.carrier] },
						["version", "parent"],
						[],
						[]
					)
					const Slotted = closedRelationBuilder(
						"Slotted",
						{
							...prefix,
							at: slotField(closedId(Position), finBuilder(Counts, "positions"), [])
						},
						["version", "parent", "at"],
						[],
						[]
					)
					return declaring({ Counts, Slotted })
				},
				at: atSlot("at")
			}
		case "an owner key that does not pair":
			return {
				stage: "compile",
				attempt: () =>
					declaring({
						Model,
						Slotted:
							fault.how === "reordered"
								? closed.relation(
										"Slotted",
										{ parent: closedId(Kind), version: closedId(Version), at: positionSlot },
										["parent", "version", "at"],
										[]
									)
								: closed.relation(
										"Slotted",
										{ version: closedId(Kind), parent: closedId(Version), at: positionSlot },
										["version", "parent", "at"],
										[]
									)
					}),
				at: atSlot("at")
			}
		case "a slot inside the owner prefix":
			return {
				stage: "compile",
				attempt: () =>
					declaring({
						Model,
						Slotted: closed.relation(
							"Slotted",
							{
								version: closedId(Version),
								at: slot(closedId(Kind), fin(Model, "positions")),
								parent: closedId(Kind)
							},
							["version", "at", "parent"],
							[]
						)
					}),
				at: atSlot("at")
			}
		case "two owner prefixes": {
			const PerVersion = closed.relation(
				"PerVersion",
				{ version: closedId(Version), positions: natural },
				["version"],
				[]
			)
			return {
				stage: "compile",
				attempt: () =>
					declaring({
						Model,
						PerVersion,
						Slotted: closed.relation(
							"Slotted",
							{
								...prefix,
								at: positionSlot,
								other: slot(closedId(Position), fin(PerVersion, "positions"))
							},
							["version", "parent", "at", "other"],
							[]
						)
					}),
				at: atSlot("other")
			}
		}
		case "a slot in the payload":
			return {
				stage: "builder",
				attempt: () =>
					slottedOf({ ...d, held: Arr.map(d.held, (): Held => "none") }, Model, undefined, true),
				at: { path: [], label: "closed.relation Slotted" }
			}
		case "a slot in an ordinary relation":
			return {
				stage: "builder",
				attempt: () => relation("Slotted", { id: Id, at: positionSlot }, ["id"]),
				at: { path: [], label: "relation Slotted" }
			}
		case "a fin over an ordinary relation":
			return {
				stage: "builder",
				attempt: () =>
					slotField(
						closedId(Position),
						finBuilder(relation("Owner", { id: Id, n: drawnField(natural) }, ["id"]), "n"),
						[]
					),
				at: { path: [], label: "slot" }
			}
		case "a family over a closed relation's fin": {
			const Member = relation("Member", { ...prefix, at: drawnField(natural) }, [
				"version",
				"parent",
				"at"
			])
			const side = onBuilder(Member, ["version", "parent", "at"])
			const slots = finBuilder(Model, "positions")
			return {
				stage: "builder",
				attempt: () =>
					fault.family === "ordered" ? orderedBuilder(side, slots) : countedBuilder(side, slots),
				at: { path: [], label: `${fault.family} slots` }
			}
		}
		case "a count relation the schema does not declare":
			return {
				stage: "compile",
				attempt: () => declaring({ Slotted: slottedOf(d, Model, undefined, false) }),
				at: atSlot(firstSlot(d.shape))
			}
	}
}

/** The most payload codes a constant holds: its greatest payload code, one less, is PostgreSQL's bigint's greatest value. */
export const greatest = 2n ** 63n

export type Bounded = "at the bound" | "one past the bound" | "within the bound" | "past the bound"

/** A payload space's code count: the bound and its neighbours, or any count either side of it up to 2^72. */
export const codesGen: Gen<bigint> = weighted([
	[1, element([greatest - 1n, greatest, greatest + 1n, greatest + 2n])],
	[3, bigint(0n, 2n ** 72n)]
])

/** A roster of `size` handles, h0 to h<size - 1>. */
export const rosterOf = (name: string, size: number) =>
	closedBuilder(name, nonEmpty(Array.from({ length: size }, (_, i) => `h${i}`)), "ordered", [])

/**
 * Five payload rosters whose sizes multiply to between 2^60 and 2^65, so a drawn declaration falls either side of the
 * bound, 2^63.
 */
export const sizesGen: Gen<ReadonlyArray<number>> = (s) =>
	Array.from({ length: 5 }, () => s.draw(int(4096, 8192)))

export type Declared = "a payload within the bound planned" | "a payload past the bound refused"
