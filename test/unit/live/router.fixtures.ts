/** What the properties of router.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { admittedIdentifier, type RouteKey } from "#compiler/plan/runtime.ts"

/** A drawn subscription: its name, and the keys it registers under, at least one. */
export interface Drawn {
	readonly name: number
	readonly keys: ReadonlyArray<RouteKey>
}

const tables = ["a", "b"] as const

const columns = ["c", "d"] as const

const values = ["", "1", "x=y:z"] as const

export const keyGen: Gen<RouteKey> = (source) => {
	const table = admittedIdentifier<"table">(source.draw(element(tables)))
	return source.draw(int(0, 2)) === 0
		? { kind: "table", table }
		: {
				kind: "keyed",
				table,
				column: admittedIdentifier<"column">(source.draw(element(columns))),
				value: source.draw(element(values))
			}
}

/** Whether a key routed reaches a key registered (see the header). */
export const matches = (registered: RouteKey, routed: RouteKey): boolean =>
	registered.table === routed.table &&
	(registered.kind === "table" ||
		routed.kind === "table" ||
		(registered.column === routed.column && registered.value === routed.value))

/** The features a case shows. */
export type Feature =
	| "a keyed key reaching a keyed subscription"
	| "a keyed key reaching a table-wide one"
	| "a table key reaching a keyed one"
	| "a key reaching none"
	| "a deregistered subscription a key would have reached"
	| "one subscription reached through several keys"
