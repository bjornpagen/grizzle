/** What the properties of rel.test.ts read: its spaces, models and helpers. */

import { constant, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Record } from "effect"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { isRecord } from "#compiler/core/record.ts"
import { everyKind } from "#test/support/unit/ir/fixture.ts"
import { generatedDags } from "#test/support/unit/ir/population.ts"

/** A DAG of the every-kind fixture or a generated one, the generated four times in five. */
export const dags = weighted([
	[1, constant(everyKind(makeIdSupply()).dag)],
	[4, generatedDags]
])

/** The kinds of node that keep rows of their data input. */
export type Keeping = "Filter" | "Take" | "OrderedResult" | "Attach" | "Forbid"

/** Whether `value` holds one of `edges` at any depth below it, an edge itself holding one, never read inside an edge. */
const holdsEdge = (value: unknown, edges: ReadonlySet<unknown>): boolean =>
	edges.has(value) ||
	(isRecord(value) && Arr.some(Record.values(value), (member) => holdsEdge(member, edges)))

/**
 * The containers `rebuilt`, a rebuild of `original` over its edges' values, holds anew where `original` holds no edge:
 * each part of the rebuild that is not the original's own part (a container built anew) while the original's part
 * holds none of `edges`, by its path below `path`. A rebuild that allocates only what its edges change has none. Each
 * part built anew is read below for its own parts; an edge and its value are not read.
 */
export const copiedApart = (
	original: unknown,
	rebuilt: unknown,
	edges: ReadonlySet<unknown>,
	path: string
): ReadonlyArray<string> => {
	if (original === rebuilt || edges.has(original) || !isRecord(original) || !isRecord(rebuilt)) {
		return []
	}
	const here = holdsEdge(original, edges) ? [] : [path]
	return [
		...here,
		...Arr.flatMap(Record.keys(original), (key) =>
			copiedApart(original[key], rebuilt[key], edges, `${path}.${key}`)
		)
	]
}
