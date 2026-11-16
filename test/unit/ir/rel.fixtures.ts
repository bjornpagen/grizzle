/** What the properties of rel.test.ts read: its spaces, models and helpers. */

import { constant, weighted } from "@bjornpagen/testing/gen"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { everyKind } from "#test/unit/ir/fixture.ts"
import { generatedDags } from "#test/unit/ir/population.ts"

/** A DAG of the every-kind fixture or a generated one, the generated four times in five. */
export const dags = weighted([
	[1, constant(everyKind(makeIdSupply()).dag)],
	[4, generatedDags]
])

/** The kinds of node that keep rows of their data input. */
export type Keeping = "Filter" | "Take" | "OrderedResult" | "Attach" | "Forbid"
