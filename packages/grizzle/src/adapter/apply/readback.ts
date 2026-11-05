import { Array as Arr, type Effect } from "effect"
import { analyzedAttachmentFacts, attachmentHeads } from "#adapter/reader/analysis.ts"
import type { ExecutionInputs } from "#adapter/reader/execution.ts"
import type { InputRefusal } from "#adapter/reader/relations.ts"
import { programFlight, type ReadProgram, readProgram } from "#adapter/reader/run.ts"
import type { Flight } from "#adapter/wire/batch.ts"
import type { AttachmentLayout, Layout, Row } from "#compiler/core/decoder.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"

/**
 * Delivering a ChangeSet's read-backs.
 *
 * A read-back is a query over the post-change state and the change's own deltas, lowered as a program of statements by
 * the optimized lowering in the optimized artifact and the conservative one in the conservative artifact
 * (write/readback/lower.ts, write/conservative/realize.ts), and placed after the writes in the WriteProgram's artifact. It
 * may attach, order, take and union like any query, so its rows are delivered to the host exactly as a query's are:
 * heading groups merged on the completed order, attachments' child rows grouped under their parents by key. That
 * delivery is the reader's (reader/run.ts programFlight), and a read-back's one flight runs in the applying
 * transaction, after the write statements and before COMMIT (run.ts). The outcome's reads are the ChangeSet's reads
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
 *   (reader/analysis.ts attachmentHeads);
 * - its parameters: the ChangeSet's declared parameters by name, a ChangeSet.bind value under its private name.
 *
 * The rows are held until COMMIT succeeds: nothing a read-back read reaches the caller before.
 */
export type ArtifactKind = "optimized" | "conservative"

/** One read-back as the reader runs it. */
interface ReadBackRun {
	readonly name: string
	readonly program: ReadProgram
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

/** The Row the reads decoder reads: no texts, and each read-back's delivered Rows at its slot. */
export const readsRow = (delivered: ReadonlyArray<ReadonlyArray<Row>>): Row => ({
	group: 0,
	texts: [],
	children: delivered
})

/** The read-backs of each artifact of a write program, ready to run. */
export type ReadBacks = { readonly [K in ArtifactKind]: ReadBackRuns }

/**
 * The read-backs of artifact `kind`, ready to run, in the artifact's order: each its delivery's statements as the
 * runtime runs them, with its attachments' delivered heads read from its query.
 */
const artifactReadBacks = (
	program: CompiledWrite,
	kind: ArtifactKind,
	codes: Codebook
): ReadBackRuns => {
	const each = Arr.map(program.artifacts[kind].readBacks, (delivery): ReadBackRun => ({
		name: delivery.name,
		program: readProgram(
			delivery.run,
			analyzedAttachmentFacts(program.frontend.ir.dag, attachmentHeads(delivery.query)),
			codes
		)
	}))
	return { runs: each, layout: readsLayout(each) }
}

/**
 * The read-backs of both artifacts of `program`, under the installation's codes `codes`, built once, with the program
 * (apply/compile.ts writeEntry), so every application runs them as they are.
 */
export const readBacks = (program: CompiledWrite, codes: Codebook): ReadBacks => ({
	optimized: artifactReadBacks(program, "optimized", codes),
	conservative: artifactReadBacks(program, "conservative", codes)
})

const delivering = (row: Row): Row => row

/**
 * The flight of one read-back, reading its delivered Rows, which the reads decoder reads under the read-back's slot.
 */
export const readBackFlight = (
	run: ReadBackRun,
	inputs: ExecutionInputs
): Effect.Effect<Flight<ReadonlyArray<Row>, never>, InputRefusal> =>
	programFlight(run.program, inputs, delivering)
