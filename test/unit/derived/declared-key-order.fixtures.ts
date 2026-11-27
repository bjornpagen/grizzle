/**
 * The box of test/unit/derived/declared-key-order.test.ts: a document's places under a unit of the document, a stored
 * derived relation of each place's value, keyed by (doc, at) on its definition's proof, and a key law over it stating
 * that key's fields in a drawn order; and the unique indexes the installation creates on its table, by their columns.
 */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, key, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { parsedName } from "#test/support/kernel/naming.ts"

/** The order a key law states the stored relation's proven key in: its unit first, as its table's primary key holds
 * it, or the other way. */
export type Order = "doc, at" | "at, doc"

const orders = ["doc, at", "at, doc"] as const satisfies ReadonlyArray<Order>

export const orderCase: Gen<Order> = (s) => s.draw(element(orders))

/** The fields of an order, in it. */
export const fieldsOf = (order: Order): ReadonlyArray<"doc" | "at"> =>
	order === "doc, at" ? ["doc", "at"] : ["at", "doc"]

/** The schema whose key law over Placed states its key in `order`. */
export const schemaOf = (order: Order) => {
	const Doc = relation("Doc", { doc: pg.integer, at: pg.integer, v: pg.integer }, ["doc", "at"])
	const base = schema("DeclaredKeyOrder", [Doc], [unit("Document", { doc: pg.integer })])
	const Placed = derived(
		"Placed",
		query(base).rule((r) => {
			const { doc, at, v: x } = v(Doc, "d")
			return r.match(Doc, { doc, at, v: x }).where(r.ge(x, 0)).find({ doc, at, v: x })
		})
	)
	const [first, second] = fieldsOf(order)
	return schema.extend(
		[base],
		"DeclaredKeyOrderTop",
		[Placed],
		[key(on(Placed, first ?? "doc", second ?? "at"))]
	)
}

/**
 * The columns of each key the installation holds on the table `table`, in their order, as texts: its primary key and each
 * UNIQUE constraint or unique index created on it.
 */
export const keysOn = (installation: Installation, table: string): ReadonlyArray<string> =>
	Arr.flatMap(installation.statements, (s): ReadonlyArray<string> => {
		if (s.kind === "createIndex" && s.unique && s.table.name === table) {
			return [
				Arr.join(
					Arr.map(s.keys, (k) => (k.key.kind === "column" ? k.key.column : "?")),
					", "
				)
			]
		}
		if (s.kind === "alterTable" && s.table.name === table) {
			return Arr.flatMap(s.actions, (a) =>
				a.kind === "addConstraint" &&
				(a.constraint.kind === "primaryKey" || a.constraint.kind === "unique")
					? [
							Arr.join(
								Arr.map(a.constraint.columns, (c) => c.column),
								", "
							)
						]
					: []
			)
		}
		return []
	})

/** A field's column identifier. */
export const columnOf = (field: string): string => identifierOf(identity.column(parsedName(field)))
