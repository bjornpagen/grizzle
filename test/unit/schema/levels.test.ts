import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect } from "effect"
import { conversionOf, identifierOf } from "#compiler/core/identity.ts"
import { drawn, natural, uuid } from "#compiler/public/fields.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
import { own } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import {
	checkBuilder,
	containedBuilder,
	countedBuilder,
	finBuilder,
	keyBuilder,
	mutableBuilder,
	onBuilder,
	selectBuilder
} from "#compiler/schema/statements.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * What a level may state about the levels below it, against the rule restated as the oracle: a process over a lower
 * level holds none of the code above it, so a level reaches a lower ordinary relation only as one side of a containment
 * between stored relations whose sides are fields with no selection and no span, into a key the target relation
 * declares (a deferred foreign key PostgreSQL judges at COMMIT), and never by a key, a check, `mutable` or a family.
 *
 * The box is every statement of a closed space stated at the upper level `Up` over `Lo`: a key, a check and `mutable`
 * over a lower and an upper relation; every containment from one of four sources (an upper field, a selected upper
 * field, a lower candidate key, a selected lower field) into one of five targets (a lower primary key, a lower
 * candidate key, a lower field no key holds, an upper primary key, a selected lower primary key); and a counted family
 * whose member is lower or upper over an upper owner. Each is owned, and refused with LevelRefused, naming the lower
 * relation it reaches and both levels, exactly where the oracle refuses it; every other statement owns.
 * An admitted statement's levels each install in the PostgreSQL schema their own declared name converts to.
 */

const A = relation("A", { id: uuid, x: uuid, y: uuid, n: natural }, ["id"])
const L = relation("L", { id: uuid, owner: uuid }, ["id"])
const Lo = schema("Lo", { A, L }, [key(on(A, "x"))])

const C = relation("C", { id: uuid, a: uuid, n: natural }, ["id"])
const U = relation("U", { id: uuid, count: drawn(natural) }, ["id"])
const UM = relation("UM", { id: uuid, owner: uuid }, ["id"])

/** Where a side reads: an upper or a lower relation, every fact or a selection. */
type Place = "upper" | "lower"

/** A containment's source and target, by what each reads. */
const sources = [
	{ name: "C.a", place: "upper", selected: false },
	{ name: "selected C.a", place: "upper", selected: true },
	{ name: "A.x", place: "lower", selected: false },
	{ name: "selected A.x", place: "lower", selected: true }
] as const
const targets = [
	{ name: "A.id", place: "lower", selected: false, key: true },
	{ name: "A.x", place: "lower", selected: false, key: true },
	{ name: "A.y", place: "lower", selected: false, key: false },
	{ name: "C.id", place: "upper", selected: false, key: true },
	{ name: "selected A.id", place: "lower", selected: true, key: true }
] as const

type Situation = "admitted" | "refused" | "a lower source admitted" | "a lower target admitted"

type Shape =
	| { readonly kind: "key" | "check" | "mutable"; readonly place: Place }
	| {
			readonly kind: "contained"
			readonly source: (typeof sources)[number]
			readonly target: (typeof targets)[number]
	  }
	| { readonly kind: "counted"; readonly place: Place }

const places: ReadonlyArray<Place> = ["upper", "lower"]
const shapes: ReadonlyArray<Shape> = [
	...Arr.flatMap(["key", "check", "mutable"] as const, (kind) =>
		Arr.map(places, (place): Shape => ({ kind, place }))
	),
	...Arr.flatMap(sources, (source) =>
		Arr.map(targets, (target): Shape => ({ kind: "contained", source, target }))
	),
	...Arr.map(places, (place): Shape => ({ kind: "counted", place }))
]

const shapeGen: Gen<Shape> = element(nonEmpty(shapes, "the space of shapes"))

const shapeText = (s: Shape): string => {
	switch (s.kind) {
		case "key":
		case "check":
		case "mutable":
		case "counted":
			return `${s.kind} over the ${s.place} level`
		case "contained":
			return `contained ${s.source.name} into ${s.target.name}`
	}
}

/** A relation's side over `field`, every fact or its facts with n at most 3. */
const sideOf = (r: typeof A | typeof C, selected: boolean, field: string) =>
	onBuilder(selected ? selectBuilder(r, (row: SmallRow) => row.le(row.n, 3n)) : r, [field])

/** A row of A or C as a selection reads it: its n. */
interface SmallRow {
	readonly n: unknown
	readonly le: (a: unknown, b: bigint) => unknown
}

/**
 * The statement a shape states at Up, built through the runtime builders a JavaScript caller reaches, so every shape,
 * the refused ones among them, is the description ownership judges.
 */
const statementOf = (s: Shape): Statement => {
	switch (s.kind) {
		case "key":
			return keyBuilder(onBuilder(s.place === "lower" ? A : C, ["n"]))
		case "check":
			return checkBuilder("Small", s.place === "lower" ? A : C, (row: SmallRow) =>
				row.le(row.n, 10n)
			)
		case "mutable":
			return mutableBuilder(s.place === "lower" ? A : C)
		case "counted":
			return countedBuilder(
				onBuilder(s.place === "lower" ? L : UM, ["owner"]),
				finBuilder(U, "count")
			)
		case "contained": {
			const source =
				s.source.place === "upper"
					? sideOf(C, s.source.selected, "a")
					: sideOf(A, s.source.selected, "x")
			switch (s.target.name) {
				case "A.id":
					return containedBuilder(source, sideOf(A, false, "id"))
				case "A.x":
					return containedBuilder(source, sideOf(A, false, "x"))
				case "A.y":
					return containedBuilder(source, sideOf(A, false, "y"))
				case "C.id":
					return containedBuilder(source, sideOf(C, false, "id"))
				case "selected A.id":
					return containedBuilder(source, sideOf(A, true, "id"))
			}
		}
	}
}

/** The oracle: the lower relation the statement reaches against the rule, none where it is admitted. */
const refusedAt = (s: Shape): string | undefined => {
	switch (s.kind) {
		case "key":
		case "check":
		case "mutable":
			return s.place === "lower" ? "A" : undefined
		case "counted":
			return s.place === "lower" ? "L" : undefined
		case "contained": {
			const { source, target } = s
			if (source.place === "lower") {
				return target.place === "lower" || source.selected || !target.key ? "A" : undefined
			}
			return target.place === "lower" && (target.selected || !target.key) ? "A" : undefined
		}
	}
}

/** The upper level over Lo stating `statement`, owned. */
const ownedUp = (statement: Statement) => {
	const Up: AnySchema = schema.extend(Lo, "Up", { C, U, UM }, [statement])
	return own(defined(schemaDescOf(Up), "Up's description"))
}

describe("a level's laws over the levels below it", () => {
	it.effect(
		"reach a lower relation only by a containment of fields into a key, every other reach LevelRefused",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/schema/levels/reach",
						generator: shapeGen,
						literal: shapeText,
						limit: shapes.length,
						box: "a key, a check and mutable over each level; every containment of four sources into five targets; a counted family whose member is either level",
						oracle: {
							kind: "second-implementation",
							name: "the rule of what a level may state below it, restated per shape"
						},
						coverage: requiredInSpace<Situation>([
							"admitted",
							"refused",
							"a lower source admitted",
							"a lower target admitted"
						]),
						caseHang
					},
					(shape, c) =>
						Effect.sync(() => {
							const owned = ownedUp(statementOf(shape))
							const expected = refusedAt(shape)
							if (expected === undefined) {
								assert.equal(owned.ok, true, `${shapeText(shape)} owns`)
								if (owned.ok) {
									assert.deepEqual<ReadonlyArray<string>>(
										Arr.map(owned.value.levels, (l) => identifierOf(l.installation)),
										[conversionOf("Lo"), conversionOf("Up")],
										"each level installs in the schema its own name converts to"
									)
								}
								c.note("admitted")
								if (shape.kind === "contained" && shape.source.place === "lower") {
									c.note("a lower source admitted")
								}
								if (shape.kind === "contained" && shape.target.place === "lower") {
									c.note("a lower target admitted")
								}
								return
							}
							assert.equal(owned.ok, false, `${shapeText(shape)} is refused`)
							if (owned.ok) {
								return
							}
							const reason = owned.error.reason
							assert.equal(reason._tag, "LevelRefused", shapeText(shape))
							if (reason._tag === "LevelRefused") {
								assert.equal(reason.relation, expected)
								assert.equal(reason.level, "Up")
								assert.equal(reason.below, "Lo")
							}
							c.note("refused")
						})
				)
			)
	)
})
