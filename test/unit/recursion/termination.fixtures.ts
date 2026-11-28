/** What the properties of termination.test.ts read: its spaces, models and helpers. */

import { Array as Arr } from "effect"
import type { FieldDesc } from "#compiler/ir/desc.ts"

import { closed, relation, schema } from "#compiler/public/schema.ts"
import { textDesc } from "#test/support/fixtures/ir/desc.ts"
import { Id } from "#test/support/ids.ts"
import { typedLit, varRef } from "#test/support/unit/check/dsl.ts"

export const integer: FieldDesc = { kind: "pg", type: "int4" }

export const s = (column: string) => varRef(`self.${column}`)

/** An integer literal, typed integer. */
export const integerLit = (n: number) => typedLit(n, integer)

/** A Vertex column copied as data into the state, and its declared type. */
export const copied: Arr.NonEmptyReadonlyArray<readonly [string, FieldDesc]> = [
	["active", { kind: "pg", type: "bool" }],
	["level", { kind: "closedId", roster: "Level", only: undefined }],
	["rank", { kind: "pg", type: "int2" }],
	["label", textDesc("^v[0-9]+$", "u")]
]

/**
 * A graph with a roster of `handles`, over which a recursion's state may hold a set. A set column never reaches the
 * estimate: PostgreSQL has no hash operator class for bit strings, and a recursive UNION deduplicates only by hashing,
 * so admission refuses a set state column at the row (check/recursion/state.ts requireHashing) before termination
 * reads it. The estimate's cap of a set at 2ⁿ (termination.ts domainSize) is unreachable from a recursion, whatever
 * the roster's n.
 */
export const setsOver = ([first, ...rest]: Arr.NonEmptyReadonlyArray<string>) =>
	schema(
		"Sets",
		[
			closed.ordered("Flag", [first, ...rest]),
			relation("Node", { id: Id }, ["id"]),
			relation("Link", { from: Id, to: Id }, ["from", "to"])
		],
		[]
	)

export type EstimateFeature =
	| `copies ${string}`
	| "a computed column"
	| "two tags"
	| "the widest grid"
