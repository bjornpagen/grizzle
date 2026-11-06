/**
 * Dependent-sum keys on closed relations, from the declaration to the planned constants (schema/relation.ts slotField,
 * schema/own.ts, physical/ddl/constants.ts plannedKey, ir/cells.ts KeySpace):
 *
 * - **The planned string is the dependent sum:** over every count relation of four owners, each counting 0 to 2 slots
 *   or holding no row, and each of three slotted shapes (two slots, one slot, a closed id before a slot), the slotted
 *   relation's pack holds exactly Σ over owners of its block, each row at the position the dependent sum's enumeration
 *   gives its key, and its owner functions hold each owner's base and count. Oracle: that enumeration, written out from
 *   the count relation's rows and the installation's codes, sharing nothing with the planner's index.
 * - **Each invalid declaration is refused by name:** a row whose slot is past its owner's count, a count past the slot
 *   roster's codes, a fin over an ordinary relation, a count that is not natural, an owner key that does not pair with
 *   the key's first fields, a slot inside the owner prefix, two owner prefixes, a slot in the payload or in an ordinary
 *   relation, a family over a closed relation's fin, and a count relation outside the schema.
 * - **A cell read as an integer:** a payload space of 2^31 - 1 codes is admitted and one of 2^31 refused, exactly at
 *   the bound (cellCodesBound), and a declared relation over 2^31 payload codes is refused where one of 2^31 - 2^16, the
 *   largest product of roster sizes below the bound, is planned.
 */
import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { cellMaxCodes } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { cellCodesBound } from "#compiler/physical/ddl/constants.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { closedId, drawn, natural, slot, uuid } from "#compiler/public/fields.ts"
import { closed, fin, relation, schema } from "#compiler/public/schema.ts"
import { pgDescriptors } from "#compiler/scalar/pg.ts"
import {
	closed as closedBuilder,
	closedRelation as closedRelationBuilder,
	slotField
} from "#compiler/schema/relation.ts"
import { finBuilder, onBuilder, orderedBuilder } from "#compiler/schema/statements.ts"
import type { PackConstant, PackRow, SqlStatement } from "#compiler/sql/ast.ts"
import {
	assert,
	defined,
	nonEmpty,
	refused,
	succeeded,
	throwsRefused
} from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownedInput } from "#test/support/policy.ts"

const Version = closed("Version", ["v0", "v1"])
const Kind = closed("Kind", ["k0", "k1"])
const Position = closed("Position", ["p0", "p1", "p2"])
const Label = closed("Label", ["x0", "x1"])

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

/** The rows the slotted relation holds: the points whose codes sum to an even number, a sparse half of the space. */
const heldPoints = (d: Declaration): ReadonlyArray<ReadonlyArray<number>> =>
	Arr.filter(pointsOf(d), (p) => Arr.reduce(p, 0, (a, b) => a + b) % 2 === 0)

/** The count relation of a declaration: one row per owner it holds a count for. */
const modelOf = (held: ReadonlyArray<Held>) =>
	closed.relation(
		"Model",
		{ version: closedId(Version), parent: closedId(Kind), positions: natural },
		["version", "parent"],
		Arr.flatMap(held, (h, owner) => {
			const [version, parent] = defined(owners[owner])
			return h === "none" ? [] : [{ version, parent, positions: BigInt(h) }]
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

/** The schema of a declaration: its count relation Model and its slotted relation Slotted. */
const schemaOf = (d: Declaration) => {
	const Model = modelOf(d.held)
	const positionSlot = slot(closedId(Position), fin(Model, "positions"))
	const prefix = { version: closedId(Version), parent: closedId(Kind) }
	const points = Arr.map(heldPoints(d), ownerOf)
	const code = (block: ReadonlyArray<number>, i: number): number => defined(block[i])
	const Slotted =
		d.shape === "follow"
			? closed.relation(
					"Slotted",
					{ ...prefix, from: positionSlot, to: positionSlot },
					["version", "parent", "from", "to"],
					Arr.map(points, ({ version, parent, block }) => ({
						version,
						parent,
						from: positionAt(code(block, 0)),
						to: positionAt(code(block, 1))
					}))
				)
			: d.shape === "last"
				? closed.relation(
						"Slotted",
						{ ...prefix, at: positionSlot },
						["version", "parent", "at"],
						Arr.map(points, ({ version, parent, block }) => ({
							version,
							parent,
							at: positionAt(code(block, 0))
						}))
					)
				: closed.relation(
						"Slotted",
						{ ...prefix, label: closedId(Label), position: positionSlot },
						["version", "parent", "label", "position"],
						Arr.map(points, ({ version, parent, block }) => ({
							version,
							parent,
							label: labelAt(code(block, 0)),
							position: positionAt(code(block, 1))
						}))
					)
	return schema("Fin", { Version, Kind, Position, Label, Model, Slotted }, [])
}

/** A pack's rows: a pack this small fits one statement, so it lists them. */
const rowsOf = (p: PackConstant): ReadonlyArray<PackRow> =>
	p.form.kind === "rows" ? p.form.rows : assert.fail("a pack this small lists its rows")

/** The pack of the function named `name` among an installation's statements. */
const packOf = (statements: ReadonlyArray<SqlStatement>, name: string): PackConstant =>
	defined(
		Arr.flatMap(statements, (s) =>
			s.kind === "packConstant" && s.function.name === name ? [s] : []
		)[0],
		`the pack of ${name}`
	)

describe("a slotted closed relation's planned constants", () => {
	type Planned =
		| "an owner with no row"
		| "an owner counting no slot"
		| "every owner counting slots"
		| "an empty space"
		| "a closed id before a slot"
		| "two slots"

	/** Every count relation of the four owners, each holding no row or counting 0 to 2, under each shape: 768. */
	const declarations: Gen<Declaration> = (s) => {
		const held = Array.from({ length: owners.length }, () =>
			s.draw(element<Held>(["none", 0, 1, 2]))
		)
		return { held, shape: s.draw(element<Shape>(["follow", "last", "symbol"])) }
	}

	/**
	 * The pack holds Σ over owners of its block, each held row at its point's position in the dependent sum, and the
	 * owner functions hold 1 + each owner's base, its count of the blocks before it, and 1 + its count. Oracle: the
	 * enumeration (pointsOf) under the first installation's codes, each handle's code its declared position.
	 */
	const planned = (d: Declaration, c: Case<Planned>) =>
		Effect.sync(() => {
			const owned = succeeded(ownedInput(schemaOf(d)))
			const installation = succeeded(compileInstallation(owned, installOptions(owned, "owner")))
			const constant = installation.names.closed("Slotted")
			const points = pointsOf(d)
			assert.equal(
				constant.key.kind,
				"dependent",
				"a key over a count relation's prefix is a dependent sum"
			)
			const cellsPack = packOf(installation.statements, constant.function.name)
			assert.equal(
				cellsPack.cells,
				BigInt(points.length),
				"the string holds every owner's block and no more"
			)
			const position = new Map(
				Arr.map(points, (p, at) => [Arr.join(Arr.map(p, String), ","), at] as const)
			)
			assert.deepEqual(
				Arr.map(rowsOf(cellsPack), (r) => r.index),
				Arr.map(heldPoints(d), (p) =>
					BigInt(defined(position.get(Arr.join(Arr.map(p, String), ","))))
				),
				"each row lies at its key's position in the dependent sum"
			)
			if (constant.key.kind === "dependent") {
				const counts = packOf(installation.statements, constant.key.counts[0].function.name)
				assert.deepEqual(
					Arr.map(rowsOf(counts), (r) => r.payload),
					Arr.map(d.held, (h) => BigInt(countOf(h))),
					"each owner's count, every owner listed"
				)
				const bases = packOf(installation.statements, constant.key.bases.function.name)
				const blocks = Arr.map(d.held, (h) =>
					Arr.reduce(radicesOf(d.shape, countOf(h)), 1, (a, b) => a * b)
				)
				assert.deepEqual(
					Arr.map(rowsOf(bases), (r) => r.payload),
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

	it.effect("packs exactly the dependent sum, each row at its key's position", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/physical/fin-planned",
					oracle: {
						kind: "second-implementation",
						name: "the dependent sum enumerated owner by owner from the count relation's rows"
					},
					box: "every count relation of 4 owners, each holding no row or counting 0 to 2 slots, under 3 slotted shapes",
					generator: declarations,
					literal: Formatter.format,
					limit: 768,
					coverage: requiredInSpace<Planned>([
						"an owner with no row",
						"an owner counting no slot",
						"every owner counting slots",
						"an empty space",
						"a closed id before a slot",
						"two slots"
					]),
					caseHang
				},
				planned
			)
		)
	)
})

describe("an invalid slotted declaration", () => {
	const Model = modelOf([2, "none", 1, 0])
	const positionSlot = slot(closedId(Position), fin(Model, "positions"))
	const prefix = { version: closedId(Version), parent: closedId(Kind) }
	const compiled = (base: unknown) =>
		Result.flatMap(ownedInput(base), (owned) =>
			compileInstallation(owned, installOptions(owned, "owner"))
		)

	it("refuses a row whose slot is at or past its owner's count", () => {
		const Last = closed.relation(
			"Last",
			{ ...prefix, at: positionSlot },
			["version", "parent", "at"],
			[{ version: "v0", parent: "k0", at: "p2" }]
		)
		refused(
			compiled(schema("Fin", { Version, Kind, Position, Model, Last }, [])),
			"MalformedDescription"
		)
	})

	it("refuses a count past the codes of the slot's roster", () => {
		const Wide = modelOf([2, "none", 1, 0])
		const Over = closed.relation(
			"Over",
			{ version: closedId(Version), parent: closedId(Kind), positions: natural },
			["version", "parent"],
			[{ version: "v0", parent: "k0", positions: 4n }]
		)
		const Last = closed.relation(
			"Last",
			{ ...prefix, at: slot(closedId(Position), fin(Over, "positions")) },
			["version", "parent", "at"],
			[]
		)
		refused(
			compiled(schema("Fin", { Version, Kind, Position, Model: Wide, Over, Last }, [])),
			"MalformedDescription"
		)
	})

	it("refuses a fin over an ordinary relation", () => {
		const Owner = relation("Owner", { id: uuid, n: drawn(natural) }, ["id"])
		throwsRefused(
			() => slotField(closedId(Position), finBuilder(Owner, "n"), []),
			"MalformedDescription"
		)
	})

	it("refuses a count that is not natural", () => {
		const Counts = closedRelationBuilder(
			"Counts",
			{ version: closedId(Version), parent: closedId(Kind), size: pgDescriptors.integer },
			["version", "parent"],
			[],
			undefined,
			[]
		)
		const Last = closedRelationBuilder(
			"Last",
			{ ...prefix, at: slotField(closedId(Position), finBuilder(Counts, "size"), []) },
			["version", "parent", "at"],
			[],
			undefined,
			[]
		)
		refused(
			ownedInput(schema("Fin", { Version, Kind, Position, Counts, Last }, [])),
			"MalformedDescription"
		)
	})

	it("refuses an owner key that does not pair with the key's first fields, roster for roster", () => {
		const Last = closed.relation(
			"Last",
			{ parent: closedId(Kind), version: closedId(Version), at: positionSlot },
			["parent", "version", "at"],
			[]
		)
		refused(
			ownedInput(schema("Fin", { Version, Kind, Position, Model, Last }, [])),
			"MalformedDescription"
		)
	})

	it("refuses a slot inside the owner prefix, though its roster pairs with the owner key's", () => {
		const Last = closed.relation(
			"Last",
			{
				version: closedId(Version),
				at: slot(closedId(Kind), fin(Model, "positions")),
				parent: closedId(Kind)
			},
			["version", "at", "parent"],
			[]
		)
		refused(
			ownedInput(schema("Fin", { Version, Kind, Position, Model, Last }, [])),
			"MalformedDescription"
		)
	})

	it("refuses two owner prefixes in one key", () => {
		const PerVersion = closed.relation(
			"PerVersion",
			{ version: closedId(Version), positions: natural },
			["version"],
			[]
		)
		const Both = closed.relation(
			"Both",
			{
				...prefix,
				at: positionSlot,
				other: slot(closedId(Position), fin(PerVersion, "positions"))
			},
			["version", "parent", "at", "other"],
			[]
		)
		refused(
			ownedInput(schema("Fin", { Version, Kind, Position, Model, PerVersion, Both }, [])),
			"MalformedDescription"
		)
	})

	it("refuses a slot in the payload", () => {
		throwsRefused(
			() => closed.relation("Payload", { ...prefix, at: positionSlot }, ["version", "parent"], []),
			"MalformedDescription"
		)
	})

	it("refuses a slot in an ordinary relation", () => {
		throwsRefused(
			() => relation("Plain", { id: uuid, at: positionSlot }, ["id"]),
			"MalformedDescription"
		)
	})

	it("refuses a family over a closed relation's fin", () => {
		const Member = relation(
			"Member",
			{ version: closedId(Version), parent: closedId(Kind), at: drawn(natural) },
			["version", "parent", "at"]
		)
		throwsRefused(
			() =>
				orderedBuilder(
					onBuilder(Member, ["version", "parent", "at"]),
					finBuilder(Model, "positions")
				),
			"MalformedDescription"
		)
	})

	it("refuses a count relation the schema does not declare", () => {
		const Last = closed.relation(
			"Last",
			{ ...prefix, at: positionSlot },
			["version", "parent", "at"],
			[]
		)
		refused(
			ownedInput(schema("Fin", { Version, Kind, Position, Last }, [])),
			"MalformedDescription"
		)
	})
})

describe("a cell read as an integer", () => {
	it("holds 2^31 - 1 payload codes and refuses 2^31, the greatest integer's bound", () => {
		assert.equal<number>(cellMaxCodes.value, 2 ** 31 - 1)
		assert.equal(cellCodesBound(2n ** 31n - 1n, "the boundary"), undefined)
		const refusal = defined(cellCodesBound(2n ** 31n, "the boundary"))
		assert.deepEqual(refusal.reason._tag === "ResourceBound" ? refusal.reason.bound : undefined, {
			kind: "cellCodes",
			constant: "the boundary",
			limit: 2 ** 31 - 1,
			needed: 2n ** 31n
		})
	})

	/** A roster of `size` handles, h0 to h<size - 1>. */
	const rosterOf = (name: string, size: number) =>
		closedBuilder(name, nonEmpty(Array.from({ length: size }, (_, i) => `h${i}`)), [])

	it("refuses a declared payload of 2^31 codes and plans one of 2^31 - 2^16", () => {
		const Key = closed("Key", ["k"])
		const A = rosterOf("A", 32_768)
		const C = rosterOf("C", 2)
		const declared = (b: ReturnType<typeof rosterOf>) => {
			const Wide = closed.relation(
				"Wide",
				{ key: closedId(Key), a: closedId(A), b: closedId(b), c: closedId(C) },
				["key"],
				[{ key: "k", a: "h0", b: "h0", c: "h0" }]
			)
			return Result.flatMap(ownedInput(schema("Wide", { Key, A, B: b, C, Wide }, [])), (owned) =>
				compileInstallation(owned, installOptions(owned, "owner"))
			)
		}
		refused(declared(rosterOf("B", 32_768)), "ResourceBound")
		succeeded(declared(rosterOf("B", 32_767)))
	})
})
