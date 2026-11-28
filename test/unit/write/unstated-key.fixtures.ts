/** What the properties of unstated-key.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Record } from "effect"
import { drawn, generated, natural, int8 } from "#compiler/public/fields.ts"
import { key, on, relation, unit } from "#compiler/public/schema.ts"
import { Id } from "#test/support/ids.ts"

/** Owner(id, n drawn): the owner of the sequence of Member. */
export const Owner = relation("Owner", { id: Id, n: drawn(natural) }, ["id"])

/** The keys a case declares over Member's written fields, by name: each one's fields in the order it declares them. */
export const shapes = {
	"owner and index": ["owner", "at"],
	"x and index": ["x", "at"],
	"id alone": ["id"],
	"owner and x": ["owner", "x"]
} as const

type Shape = keyof typeof shapes

/** A key a case declares: a written shape, or `owner` and the generated `y`. */
type Declared = Shape | "owner and generated y"

/** The fields of a declared key, in the order it declares them. */
export const declaredFields = (shape: Declared): ReadonlyArray<string> =>
	shape === "owner and generated y" ? ["owner", "y"] : shapes[shape]

/** The unit of a row's own id, which Owner sits in, and Member where its primary key is its id alone. */
const rowUnit = unit("Row", { id: Id })

/** The units Owner and Member sit in, so both are mutable inside one: Owner's id, and the field Member's primary key
 * leads with, where it is no id. */
const unitsOf = (primary: Shape) => {
	switch (primary) {
		case "owner and index":
		case "owner and x":
			return [rowUnit, unit("Owned", { owner: Id })]
		case "x and index":
			return [rowUnit, unit("Xs", { x: int8 })]
		case "id alone":
			return [rowUnit]
	}
}

/** The member under the primary key `primary`, the declared key over it of each shape, and the units the two sit in. */
export const memberOf = (primary: Shape) => {
	const Member = relation.generated(
		"Member",
		{ id: Id, owner: Id, at: drawn(natural), x: int8 },
		shapes[primary],
		(r) => ({ y: generated(int8, r.x) })
	)
	const declared = (shape: Declared) => {
		switch (shape) {
			case "owner and index":
				return key(on(Member, "owner", "at"))
			case "x and index":
				return key(on(Member, "x", "at"))
			case "id alone":
				return key(on(Member, "id"))
			case "owner and x":
				return key(on(Member, "owner", "x"))
			case "owner and generated y":
				return key(on(Member, "owner", "y"))
		}
	}
	return { Member, declared, units: unitsOf(primary) }
}

/** A case of the box: the write, Member's primary key, the keys declared beside it in order, and how many facts. */
interface Box {
	readonly op: "put" | "delete"
	readonly primary: Shape
	readonly declared: ReadonlyArray<Declared>
	readonly facts: number
}

/** Every written shape, in the order the record states them. */
const shapeNames: Arr.NonEmptyReadonlyArray<Shape> = nonEmpty(Record.keys(shapes), "a key shape")

export const boxGen: Gen<Box> = (source) => {
	const op = source.draw(element(["put", "delete"] as const))
	const primary = source.draw(element(shapeNames))
	const others: ReadonlyArray<Declared> = [
		...Arr.filter(shapeNames, (shape) => shape !== primary),
		"owner and generated y"
	]
	return {
		op,
		primary,
		declared: source.draw(subarray(others)),
		facts: source.draw(int(1, 3))
	}
}

/** Whether two keys hold the same fields in the same order. */
export const sameFields = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (field, i) => b[i] === field)

/** Whether a key holds the drawn index. */
export const holdsIndex = (shape: Declared): boolean =>
	Arr.some(declaredFields(shape), (field) => field === "at")

/** The refusal the rule names, or none: the primary key first, then, for a put, the declared keys. */
type Expected =
	| Readonly<{ kind: "bound" }>
	| Readonly<{ kind: "primary" }>
	| Readonly<{ kind: "declared"; among: ReadonlyArray<Declared> }>

export const expectedOf = (box: Box): Expected => {
	if (holdsIndex(box.primary)) {
		return { kind: "primary" }
	}
	const among = Arr.filter(box.declared, holdsIndex)
	return box.op === "put" && Arr.isReadonlyArrayNonEmpty(among)
		? { kind: "declared", among }
		: { kind: "bound" }
}

export type Situation =
	| "put refused by its primary key"
	| "put refused by a declared key"
	| "put bound"
	| "put bound beside a declared key over a generated field"
	| "delete refused by its primary key"
	| "delete bound beside a declared key over the index"
	| "delete bound"
