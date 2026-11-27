/** What the properties of recompile.test.ts read: its spaces, models and helpers. */

import { Array as Arr } from "effect"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { type QueryTemplate } from "#compiler/program/compile.ts"
import { type ExecutionRequest } from "#compiler/program/template.ts"

/**
 * The compilation the runtime runs, over generated programs built through the public builders: a compilation is a
 * function of its query and schema alone.
 *
 * Each case draws a public program (oracle/public/generate.ts) and compiles every query read as a Db compiles it
 * (program/template.ts templateFor), then each again after the case's other reads compiled in between: every read
 * compiles, and again to the same statements, so nothing one compilation leaves behind answers another.
 *
 * How every read here is compiled: as a Db's reads are, for the snapshot context, read as rows.
 *
 * Features: a read compiled; a read compiled again after another read.
 */
export const request: ExecutionRequest = {
	context: "snapshot",
	read: "rows",
	clock: noClock,
	source: transactionClock
}

/** The statements a template emits, as text. */
export const statementsOf = (t: QueryTemplate) => ({
	optimized: Arr.map(t.optimized, (s) => s.sql)
})

/** What a case reaches: a compiled read, and one compiled again after others. */
export type RecompileFeature = "compiled" | "compiled again after another read"
