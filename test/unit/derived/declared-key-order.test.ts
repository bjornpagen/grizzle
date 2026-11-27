/**
 * A key law's order orders the index that holds it, over a stored derived relation's table as over every table
 * (laws/model/model.ts naming of a UNIQUE): a law stating a proven key's fields in the order the table's own index holds
 * them, its unit first, is that index; one stating them in another order is a UNIQUE of its own, in its order, beside
 * the table's own, so a read that seeks the law's order (DECIDE7's prefix proof) finds an index of it.
 *
 * The box is declared-key-order.fixtures.ts: a document's places in the unit of the document, Placed, each place's value,
 * stored at (doc, at), and a key law over Placed stating (doc, at) or (at, doc). The oracle is the rule restated: the
 * table's keys, read off the installation's statements, are its primary key (doc, at), and (at, doc) beside it where
 * the law states that order.
 *
 * Features: each order.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order as Ord } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { succeeded } from "#test/support/assert.ts"
import { owning } from "#test/support/policy.ts"
import {
	columnOf,
	fieldsOf,
	keysOn,
	type Order,
	orderCase,
	schemaOf
} from "#test/unit/derived/declared-key-order.fixtures.ts"

type OrderFeature = `order ${Order}`

/** A key law over a stored derived relation is held by an index in the law's order. */
export const aKeyLawOverAStoredDerivedRelationIsHeldByAnIndexInTheLawsOrder = property.exhaust(
	finite(orderCase),
	{
		needs: {},
		situations: ["order doc, at", "order at, doc"] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check: (_, c: Case<OrderFeature>) => (order) =>
			Effect.sync(() => {
				const owned = owning(schemaOf(order))
				const installation = succeeded(
					compileInstallation(owned, installOptions(owned)),
					"the installation compiles"
				)
				const placed = installation.checked.canonicalOf("Placed")
				assert.equal(placed.holding.kind, "stored", "Placed is stored")
				const table = identifierOf(identity.view(placed.digest))
				const declared = Arr.join(Arr.map(fieldsOf(order), columnOf), ", ")
				const primary = Arr.join(Arr.map(["doc", "at"], columnOf), ", ")
				assert.deepEqual(
					Arr.sort(keysOn(installation, table), Ord.String),
					Arr.sort(Arr.dedupe([primary, declared]), Ord.String),
					"the table's primary key, led by its unit, and the law's key in the law's order"
				)
				c.note(`order ${order}`)
			}),
		oracle: {
			kind: "specification",
			name: "laws/model/model.ts: a key law over a stored derived relation is its table's index where that index holds its fields in the law's order, else a UNIQUE of its own in that order"
		},
		box: "a stored relation of each place's value at (doc, at), and a key law over it in either order",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/model.ts",
				original: "\t\t\t\t\t\t? sameOrder(\n",
				replacement: "\t\t\t\t\t\t? true || sameOrder(\n",
				why: "A key law stating a proven key's fields in another order is the table's own index, led by its unit: the law's order has no index, so a read seeking it finds none."
			}
		]
	}
)
