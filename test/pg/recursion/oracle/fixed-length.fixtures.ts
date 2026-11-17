import { Array as Arr } from "effect"
import type { RecursionOracleFeature } from "#test/pg/recursion/oracle/support.ts"
import { graphShapes, type RecursiveFeature } from "#test/support/oracle/gen/recursive.ts"

/** The situations the fixed-length population must reach: every shape, length, root binding and graph trait, and rows. */
export const fixedLengthSituations = [
	...Arr.map(graphShapes, (s): RecursiveFeature => `shape:${s}`),
	"length:1",
	"length:2",
	"length:3",
	"roots:param",
	"multiple roots carrying origin",
	"existence match",
	"direction:reverse",
	"self-loop",
	"parallel edges",
	"cycle",
	"diamond",
	"dangling edges",
	"nonempty"
] as const satisfies ReadonlyArray<RecursionOracleFeature>
