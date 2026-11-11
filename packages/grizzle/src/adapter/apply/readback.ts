import * as Arr from "effect/Array"
import type * as Effect from "effect/Effect"
import * as Order from "effect/Order"
import * as Result from "effect/Result"
import { type InputTooLarge, UnreadableAnswer } from "#adapter/errors/failures.ts"
import type { ExecutionInputs, HostParams, SentRuns } from "#adapter/reader/execution.ts"
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
 * A read-back is a query over the post-change state and the change's own deltas, lowered as a program of statements by
 * the optimized lowering (write/readback/lower.ts), and placed after the writes in the WriteProgram's artifact. It
 * may attach, order, take and union like any query, so its rows are delivered to the host exactly as a query's are:
 * heading groups merged on the completed order, attachments' child rows grouped under their parents by key. That
 * delivery is the reader's (reader/run.ts programFlight), and a read-back's one flight runs in the applying
 * transaction, after the write statements and before COMMIT (run.ts). A read-back riding a write statement sends
 * nothing of its own: its statements are parts of that statement, whose rows behind each part's tag are its statements'
 * answers (`riddenRows`). The outcome's reads are the ChangeSet's reads
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
/** The rows a riding read-back's statements are parts of: the write statement's position and the parts' place among
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
					riding: { statement: carried.statement, tag: carried.tag, parts: carried.parts }
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

/** A numbered part's rows in their statement's order: by their row number. */
const byNumber: Order.Order<{ readonly number: number }> = Order.mapInput(
	Order.Number,
	(numbered) => numbered.number
)

/**
 * The answers of a riding read-back's sent statements, in flight order, from the rows `rows` of the write statement it
 * rides: each part's rows behind its tag, their first `width` cells after the tag, a numbered part's put back in its
 * statement's order by the row number after them (engine write/program/artifact.ts RidingPart).
 */
const ridingRuns = (riding: Riding, rows: OutputRows): SentRuns =>
	Arr.map(riding.parts, (part, at) => {
		const own = String(riding.tag + at)
		const tagged = Arr.filter(rows, (row) => row[0] === own)
		const ordered =
			part.kind === "rows"
				? tagged
				: Arr.map(
						Arr.sort(
							Arr.map(tagged, (row) => ({ row, number: Number(row[1 + part.width]) })),
							byNumber
						),
						(numbered) => numbered.row
					)
		return Arr.map(ordered, (row) => row.slice(1, 1 + part.width))
	})

/**
 * The delivered Rows of a read-back riding the write statement whose rows are `rows`, delivered as its own flight would
 * deliver its statements' answers (reader/run.ts deliveredRows); a repeated row is UnreadableAnswer at `index`, the
 * write statement's place in the flight.
 */
export const riddenRows = (
	run: Extract<ReadBackRun, { readonly kind: "riding" }>,
	rows: OutputRows,
	params: HostParams,
	index: number
): Result.Result<ReadonlyArray<Row>, UnreadableAnswer> =>
	Result.mapError(
		deliveredRows(run.program, ridingRuns(run.riding, rows), params),
		(unreadable) => new UnreadableAnswer({ index, fate: unreadable.fate })
	)
