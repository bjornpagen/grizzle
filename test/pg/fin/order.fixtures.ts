/** What the properties of order.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { familyTemplates } from "#test/pg/fin/family.ts"
import type { EndFeature } from "#test/pg/fin/installed.ts"
import { nonEmpty } from "#test/support/assert.ts"
import type { MutationStatement } from "#test/support/families/mutate.ts"
import {
	type Families,
	type FamilyRow,
	type Shape,
	SHAPES,
	storedOf
} from "#test/support/families/theorem.ts"
import { upTo } from "#test/support/up-to.ts"

/** Every pair of families of owners 0 and 1, members numbered in slot order across both, lengths summing to ≤ 5. */
const FAMILIES: Arr.NonEmptyReadonlyArray<Families> = nonEmpty(
	Arr.flatMap(Arr.range(0, 5), (a) =>
		upTo(5 - a + 1, (b): Families => [
			{ owner: 0, members: upTo(a, (i) => i) },
			{ owner: 1, members: upTo(b, (m) => a + m) }
		])
	),
	"a family pair"
)

/** A write of a family pair's rows: one INSERT in an order, or the rows in a slot order cut once into two INSERTs. */
type Sent =
	| { readonly kind: "one insert"; readonly rows: ReadonlyArray<FamilyRow> }
	| {
			readonly kind: "cut"
			readonly order: "descending" | "ascending"
			readonly first: ReadonlyArray<FamilyRow>
			readonly second: ReadonlyArray<FamilyRow>
	  }

interface Sketch {
	readonly shape: Shape
	readonly families: Families
	readonly sent: Sent
}

const rowsOf = (families: Families): ReadonlyArray<FamilyRow> => storedOf(families).rows

export const sketchGen: Gen<Sketch> = (source) => {
	const shape = source.draw(element(SHAPES))
	const families = source.draw(element(FAMILIES))
	const rows = rowsOf(families)
	const n = rows.length
	if (n < 2 || source.draw(element(["one insert", "cut"] as const)) === "one insert") {
		return {
			shape,
			families,
			sent: { kind: "one insert", rows: source.draw(shuffled(rows, { min: n, max: n })) }
		}
	}
	const order = source.draw(element(["descending", "ascending"] as const))
	const sorted = Arr.sort(
		rows,
		order === "ascending"
			? Order.mapInput(Order.Number, (r: FamilyRow) => r.at)
			: Order.mapInput(Order.flip(Order.Number), (r: FamilyRow) => r.at)
	)
	const at = source.draw(int(1, n - 1))
	return {
		shape,
		families,
		sent: { kind: "cut", order, first: sorted.slice(0, at), second: sorted.slice(at) }
	}
}

/** The statements a sketch sends: each owner with its count, then its INSERTs. */
export const statementsOf = (sketch: Sketch): ReadonlyArray<MutationStatement> => {
	const creates = Arr.map(sketch.families, (f): MutationStatement => ({
		kind: "create",
		owner: f.owner,
		count: f.members.length
	}))
	const insert = (rows: ReadonlyArray<FamilyRow>): ReadonlyArray<MutationStatement> =>
		Arr.isReadonlyArrayNonEmpty(rows) ? [{ kind: "insert", rows }] : []
	return sketch.sent.kind === "one insert"
		? [...creates, ...insert(sketch.sent.rows)]
		: [...creates, ...insert(sketch.sent.first), ...insert(sketch.sent.second)]
}

/** Whether some row is sent before the row one slot below it in its family. */
export const successorFirst = (rows: ReadonlyArray<FamilyRow>): boolean =>
	Arr.some(rows, (r, i) =>
		Arr.some(rows.slice(i + 1), (p) => p.group === r.group && p.at === r.at - 1)
	)

export type OrderFeature =
	| EndFeature
	| `${Shape} one insert committed`
	| `${Shape} one insert with a successor first committed`
	| `${Shape} ${"descending" | "ascending"} cut ${"committed" | "refused"}`

/** Each shape's family installed once per member (family.ts familyTemplates), the one a case draws seated for it. */
export const orderTemplates = familyTemplates(import.meta, "order")
