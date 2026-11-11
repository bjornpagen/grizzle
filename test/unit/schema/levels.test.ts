/**
 * What a level may state about the levels below it, against the rule restated as the oracle: a process over a lower
 * level holds none of the code above it, so a level reaches a lower ordinary relation only as one side of a containment
 * between stored relations whose sides are fields with no span, into a side holding a key the target relation declares
 * and selected by constants alone (a deferred foreign key PostgreSQL judges at COMMIT; test/unit/laws/lowered-rules
 * draws the superkeys and constants), or as a row check over it, the level's own CHECK on the lower table
 * (test/pg/levels/level-checks), and never by a key, `mutable` or a family.
 *
 * The box is every statement of a drawn space stated at the upper level `Up` over `Lo`: a key, a check, `mutable` and
 * a counted family over a lower and an upper relation; and every containment from one of four sources (an upper field
 * or a lower candidate key, every fact or a selection) into one of seven targets (the upper primary key, or the lower
 * primary key, candidate key or a field no key holds, every fact or a selection). Each is owned, and refused with LevelRefused, naming the lower
 * relation it reaches and both levels, exactly where the oracle refuses it; every other statement owns.
 * An admitted statement's levels each install in the PostgreSQL schema their own declared name converts to.
 *
 * Plants: ~/.cache/grizzle-release/BR06/plants/levels-single-reach-admitted (a statement reaching one lower relation
 * admitted); ~/.cache/grizzle-release/LEVELCHECK/plants/levelcheck-refused (a row check over a lower relation refused
 * as LevelRefused).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
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
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const A = relation("A", { id: uuid, x: uuid, y: uuid, n: natural }, ["id"])
const L = relation("L", { id: uuid, owner: uuid }, ["id"])
const Lo = schema("Lo", [A, L], [key(on(A, "x"))])

const C = relation("C", { id: uuid, a: uuid, n: natural }, ["id"])
const U = relation("U", { id: uuid, count: drawn(natural) }, ["id"])
const UM = relation("UM", { id: uuid, owner: uuid }, ["id"])

/** Where a side reads: an upper or a lower relation. */
const places = ["upper", "lower"] as const
type Place = (typeof places)[number]

/** The fields of A a lower target names: its primary key, its candidate key, and a field no key holds. */
const targetFields = ["id", "x", "y"] as const
type TargetField = (typeof targetFields)[number]

/** The statements a shape states, each a kind of law. */
const kinds = ["key", "check", "mutable", "counted", "contained"] as const

type Situation =
	| "admitted"
	| "refused"
	| "a lower source admitted"
	| "a lower target admitted"
	| "a lower check admitted"

type Shape =
	| { readonly kind: "key" | "check" | "mutable" | "counted"; readonly place: Place }
	| {
			readonly kind: "contained"
			readonly source: { readonly place: Place; readonly selected: boolean }
			readonly target:
				| { readonly place: "lower"; readonly selected: boolean; readonly field: TargetField }
				| { readonly place: "upper" }
	  }

/**
 * A shape drawn: a law of each kind over either level, and a containment from C.a or A.x, every fact or a selection,
 * into A at each of its three fields, every fact or a selection, or into C's primary key.
 */
const shapeGen: Gen<Shape> = (source) => {
	const kind = source.draw(element(kinds))
	switch (kind) {
		case "key":
		case "check":
		case "mutable":
		case "counted":
			return { kind, place: source.draw(element(places)) }
		case "contained": {
			const from = { place: source.draw(element(places)), selected: source.draw(boolean) }
			const into = source.draw(element(places))
			return {
				kind,
				source: from,
				target:
					into === "upper"
						? { place: into }
						: {
								place: into,
								selected: source.draw(boolean),
								field: source.draw(element(targetFields))
							}
			}
		}
	}
}

const shapeText = (s: Shape): string => {
	switch (s.kind) {
		case "key":
		case "check":
		case "mutable":
		case "counted":
			return `${s.kind} over the ${s.place} level`
		case "contained":
			return `contained ${s.source.selected ? "selected " : ""}${s.source.place === "upper" ? "C.a" : "A.x"} into ${
				s.target.place === "upper"
					? "C.id"
					: `${s.target.selected ? "selected " : ""}A.${s.target.field}`
			}`
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
			return containedBuilder(
				source,
				s.target.place === "upper"
					? sideOf(C, false, "id")
					: sideOf(A, s.target.selected, s.target.field)
			)
		}
	}
}

/** The oracle: the lower relation the statement reaches against the rule, none where it is admitted. */
const refusedAt = (s: Shape): string | undefined => {
	switch (s.kind) {
		case "check":
			return undefined
		case "key":
		case "mutable":
			return s.place === "lower" ? "A" : undefined
		case "counted":
			return s.place === "lower" ? "L" : undefined
		case "contained": {
			const { source, target } = s
			if (source.place === "lower") {
				return target.place === "lower" || source.selected ? "A" : undefined
			}
			return target.place === "lower" && (target.selected || target.field === "y") ? "A" : undefined
		}
	}
}

/** The upper level over Lo stating `statement`, owned. */
const ownedUp = (statement: Statement) => {
	const Up: AnySchema = schema.extend(Lo, "Up", [C, U, UM], [statement])
	return own(defined(schemaDescOf(Up), "Up's description"))
}

describe("a level's laws over the levels below it", () => {
	it.effect(
		"reach a lower relation only by a containment of fields into a key or a row check, every other reach LevelRefused",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/schema/levels/reach",
						generator: shapeGen,
						literal: shapeText,
						box: "a key, a check, mutable and a counted family over each level; every containment of four sources into seven targets",
						oracle: {
							kind: "second-implementation",
							name: "the rule of what a level may state below it, restated per shape"
						},
						coverage: requiredInSpace<Situation>([
							"admitted",
							"refused",
							"a lower source admitted",
							"a lower target admitted",
							"a lower check admitted"
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
								if (shape.kind === "check" && shape.place === "lower") {
									c.note("a lower check admitted")
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
