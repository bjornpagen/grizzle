/** What the properties of levels.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { drawn, natural } from "#compiler/public/fields.ts"
import { key, on, relation, schema, unit } from "#compiler/public/schema.ts"
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
	raceBuilder,
	selectBuilder
} from "#compiler/schema/statements.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { Id } from "#test/support/ids.ts"

const A = relation("A", { id: Id, x: Id, y: Id, n: natural }, ["id"])

const L = relation("L", { id: Id, owner: Id }, ["id"])

/** Lo, A's key over x, and the unit of a row's id, which every relation of both levels, each keyed by its id, sits in:
 * a unit is stated at or below every relation under it. */
const Lo = schema("Lo", [A, L], [key(on(A, "x")), unit("Entity", { id: Id })])

const C = relation("C", { id: Id, a: Id, n: natural }, ["id"])

const U = relation("U", { id: Id, count: drawn(natural) }, ["id"])

const UM = relation("UM", { id: Id, owner: Id }, ["id"])

/** Where a side reads: an upper or a lower relation. */
const places = ["upper", "lower"] as const

type Place = (typeof places)[number]

/** The fields of A a lower target names: its primary key, its candidate key, and a field no key holds. */
const targetFields = ["id", "x", "y"] as const

type TargetField = (typeof targetFields)[number]

/** The statements a shape states, each a kind of law. */
const kinds = ["key", "check", "mutable", "race", "counted", "contained"] as const

export type Situation =
	| "admitted"
	| "refused"
	| "a lower source admitted"
	| "a lower target admitted"
	| "a lower check admitted"
	| "a selected lower source admitted"
	| "a lower source into a selected target admitted"
	| "a lower target selected beyond constants admitted"

type Shape =
	| { readonly kind: "key" | "check" | "mutable" | "race" | "counted"; readonly place: Place }
	| {
			readonly kind: "contained"
			readonly source: { readonly place: Place; readonly selected: boolean }
			readonly target:
				| { readonly place: "lower"; readonly selected: boolean; readonly field: TargetField }
				| { readonly place: "upper"; readonly selected: boolean }
	  }

/**
 * A shape drawn: a law of each kind over either level, and a containment from C.a or A.x, every fact or a selection,
 * into A at each of its three fields, every fact or a selection, or into C's primary key, every fact or a selection.
 */
export const shapeGen: Gen<Shape> = (source) => {
	const kind = source.draw(element(kinds))
	switch (kind) {
		case "key":
		case "check":
		case "mutable":
		case "race":
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
						? { place: into, selected: source.draw(boolean) }
						: {
								place: into,
								selected: source.draw(boolean),
								field: source.draw(element(targetFields))
							}
			}
		}
	}
}

export const shapeText = (s: Shape): string => {
	switch (s.kind) {
		case "key":
		case "check":
		case "mutable":
		case "race":
		case "counted":
			return `${s.kind} over the ${s.place} level`
		case "contained":
			return `contained ${s.source.selected ? "selected " : ""}${s.source.place === "upper" ? "C.a" : "A.x"} into ${
				s.target.place === "upper"
					? `${s.target.selected ? "selected " : ""}C.id`
					: `${s.target.selected ? "selected " : ""}A.${s.target.field}`
			}`
	}
}

/** A relation's side over `field`, every fact or its facts with n at most 3, a selection that fixes no field. */
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
export const statementOf = (s: Shape): Statement => {
	switch (s.kind) {
		case "key":
			return keyBuilder(onBuilder(s.place === "lower" ? A : C, ["n"]))
		case "check":
			return checkBuilder("Small", s.place === "lower" ? A : C, (row: SmallRow) =>
				row.le(row.n, 10n)
			)
		case "mutable":
			return mutableBuilder(s.place === "lower" ? A : C)
		case "race":
			return raceBuilder(s.place === "lower" ? A : C)
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
					? sideOf(C, s.target.selected, "id")
					: sideOf(A, s.target.selected, s.target.field)
			)
		}
	}
}

/**
 * The oracle: the lower relation the statement reaches against the rule, none where it is admitted. A containment
 * reaches a lower relation on one side, its other side upper, selected or not, into a lower target only at a key
 * (A.id, its primary key, or A.x, the key Lo declares), never at y, which no key holds.
 */
export const levelRefusedAt = (s: Shape): string | undefined => {
	switch (s.kind) {
		case "check":
			return undefined
		case "key":
		case "mutable":
		case "race":
			return s.place === "lower" ? "A" : undefined
		case "counted":
			return s.place === "lower" ? "L" : undefined
		case "contained": {
			const { source, target } = s
			if (source.place === "lower") {
				return target.place === "lower" ? "A" : undefined
			}
			return target.place === "lower" && target.field === "y" ? "A" : undefined
		}
	}
}

/** The upper level over Lo stating `statement`, owned. */
export const ownedUp = (statement: Statement) => {
	const Up: AnySchema = schema.extend([Lo], "Up", [C, U, UM], [statement])
	return own(defined(schemaDescOf(Up), "Up's description"))
}
