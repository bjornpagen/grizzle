import * as Arr from "effect/Array"
import type * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { type InputTooLarge, UnreadableAnswer } from "#adapter/errors/failures.ts"
import {
	type ExecutionInputs,
	type HostParams,
	partRuns,
	taggedRun
} from "#adapter/reader/execution.ts"
import {
	deliveredRows,
	programFlight,
	type ReadProgram,
	type RiddenProgram,
	readProgram,
	riddenProgram
} from "#adapter/reader/run.ts"
import type { Flight } from "#adapter/wire/batch.ts"
import type { AttachmentLayout, Codebook, Layout, OutputRows, Row } from "#compiler/plan/common.ts"
import type { ServedCarried, ServedReadBack } from "#compiler/plan/serve.ts"

/**
 * Delivering a ChangeSet's read-backs.
 *
 * A read-back is a query over the post-change state and the change's own deltas, lowered as a program of one
 * statement by the optimized lowering (write/readback/lower.ts), and placed after the writes in the WriteProgram's
 * artifact. It may attach, order, take and union like any query, so its rows are delivered to the host exactly as a
 * query's are: heading groups merged on the completed order, attachments' child rows grouped under their parents by
 * key. That delivery is the reader's (reader/run.ts programFlight), and a read-back's one flight runs in the applying
 * transaction, after the write statements and before COMMIT (run.ts). A read-back riding a write statement sends
 * nothing of its own: its statement is a part of that statement, whose rows behind the part's tag are its statement's
 * answer (`riddenRows`). The outcome's reads are the ChangeSet's reads
 * decoder's record (write/changeset/value.ts) over one Row whose children, slot by slot in the artifact's order, are
 * the read-backs' delivered Rows: its layout (ReadBackRuns.layout) names each read-back's slot and its program's
 * layouts, one per heading group, and each read-back delivers every row.
 *
 * - its statements: the artifact delivers each read-back's statements as the runtime runs them, each with its spec in
 *   the artifact and its large form's, and how their rows combine (write/program/artifact.ts ReadBackDelivery; the
 *   optimized artifact lowers each read-back over the plan's RETURNING-filled delta carriers, the conservative
 *   realization over its state-comparison carriers);
 * - its attachments' delivered types: the write front end analyzed the read-backs' DAG with immediate-constraint
 *   evidence only (frontend/compile.ts), so each Attach node already carries the type that evidence proves; a
 *   correlation column the read-back's head does not deliver is dropped from the delivered child as a query's is
 *   (engine served/spine.ts servedSpine);
 * - its parameters: the ChangeSet's declared parameters by name, a ChangeSet.bind value under its private name.
 *
 * The rows are held until COMMIT succeeds: nothing a read-back read reaches the caller before.
 */
/** The rows a riding read-back's statement is a part of: the write statement's position and the part's place among
 * its rows (engine served/read.ts ServedCarried). */
type Riding = Omit<Extract<ServedCarried, { readonly kind: "riding" }>, "kind" | "source">

/**
 * One read-back as the reader runs it, by how its statements reach the server: sent behind the writes, its program
 * sending them; or riding a write statement, its program reading their rows from that statement's (`riding`).
 */
export type ReadBackRun =
	| { readonly kind: "sent"; readonly name: string; readonly program: ReadProgram }
	| {
			readonly kind: "riding"
			readonly name: string
			readonly program: RiddenProgram
			readonly riding: Riding
	  }

/**
 * The read-backs of an artifact, in its order, and the layout of the Row of their delivered Rows that the ChangeSet's
 * reads decoder binds to: each read-back's name at its slot, with its program's layouts, delivering every row.
 */
export interface ReadBackRuns {
	readonly runs: ReadonlyArray<ReadBackRun>
	readonly layout: Layout
}

/** The layout of the read-backs' Row. */
const readsLayout = (runs: ReadonlyArray<ReadBackRun>): Layout => ({
	columns: new Map(),
	attachments: new Map(
		Arr.map(runs, (run, slot): readonly [string, AttachmentLayout] => [
			run.name,
			{ slot, layouts: run.program.layouts, proved: "array" }
		])
	)
})

/** The Row the reads decoder reads: no cells, and each read-back's delivered Rows at its slot. */
export const readsRow = (delivered: ReadonlyArray<ReadonlyArray<Row>>): Row => ({
	group: 0,
	cells: [],
	children: delivered
})

/**
 * The read-backs of a compiled ChangeSet, ready to run, in its artifact's order, under the installation's codes
 * `codes`: each its served statements (engine served/spine.ts servedReadBacks) as the runtime runs them, with its
 * attachments' delivered heads read from its spine. Built once, with the program (served/forms.ts writeEntry) or from
 * its served file, so every application runs them as they are.
 */
export const readBacks = (served: ReadonlyArray<ServedReadBack>, codes: Codebook): ReadBackRuns => {
	const each = Arr.map(served, (readBack): ReadBackRun => {
		const carried = readBack.carried
		return carried.kind === "sent"
			? {
					kind: "sent",
					name: readBack.name,
					program: readProgram(carried.source, readBack.spine, codes)
				}
			: {
					kind: "riding",
					name: readBack.name,
					program: riddenProgram(carried.source, readBack.spine, codes),
					riding: { statement: carried.statement, tag: carried.tag, part: carried.part }
				}
	})
	return { runs: each, layout: readsLayout(each) }
}

const delivering = (row: Row): Row => row

/**
 * The flight of one read-back, reading its delivered Rows, which the reads decoder reads under the read-back's slot. A
 * read-back statement whose answer repeats a row is UnreadableAnswer (reader/run.ts programFlight).
 */
export const readBackFlight = (
	run: Extract<ReadBackRun, { readonly kind: "sent" }>,
	inputs: ExecutionInputs
): Effect.Effect<Flight<ReadonlyArray<Row>, UnreadableAnswer>, InputTooLarge> =>
	programFlight(run.program, inputs, delivering)

/**
 * The delivered Rows of a read-back riding the write statement whose rows are `rows`, delivered as its own flight would
 * deliver its statement's answer: its part's rows behind its tag, divided into its own parts' runs (reader/execution.ts
 * taggedRun, partRuns); a repeated row is UnreadableAnswer at `index`, the write statement's place in the flight.
 */
export const riddenRows = (
	run: Extract<ReadBackRun, { readonly kind: "riding" }>,
	rows: OutputRows,
	params: HostParams,
	index: number
): Result.Result<ReadonlyArray<Row>, UnreadableAnswer> =>
	Result.mapError(
		deliveredRows(
			run.program,
			partRuns(run.program.parts, taggedRun(rows, run.riding.tag, run.riding.part)),
			params
		),
		(unreadable) => new UnreadableAnswer({ index, fate: unreadable.fate })
	)
