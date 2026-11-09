import { Array as Arr, Effect, Result } from "effect"
import { type InputTooLarge, UnreadableAnswer } from "#adapter/errors/failures.ts"
import { carried } from "#adapter/reader/analysis.ts"
import type { RelationInputs } from "#adapter/reader/relations.ts"
import { sentAnswer, type BatchStatement } from "#adapter/wire/batch.ts"
import {
	type AssembledRows,
	type AttachmentLayout,
	type Cell,
	type Codebook,
	defect,
	type EmittedText,
	type Layout,
	type OutputRows,
	outputTextOf,
	type ParamId,
	type Param,
	type Row,
	rowCell,
	rowText,
	TupleMap
} from "#compiler/plan/common.ts"
import {
	assembled,
	cellKindOf,
	type Delivery,
	deliveryOf,
	sameBytes,
	scalarReader
} from "#compiler/plan/decode.ts"
import {
	type Arrival,
	type ChoiceInput,
	columnPosition,
	type DeclaredParamSlot,
	fusedTexts,
	type FusedTexts,
	keyColumns,
	type StatementForms,
	statementOutput,
	type StatementOutput
} from "#compiler/plan/read.ts"
import type {
	ServedAttach,
	ServedAttached,
	ServedFused,
	ServedRoots,
	ServedRunStatement,
	ServedSpec,
	ServedSpine,
	ServedTree
} from "#compiler/plan/serve.ts"

/**
 * One statement execution and the Rows it delivers: what reads, read-backs, pages and db.explain share.
 *
 * A statement runs in one of two forms: as lowered, or as its whole-relation variant when a per-execution choice
 * selects it. Each form is its lowered statement, the spec emitted from it and its placeholders as an execution binds
 * them, all settled once per program (reader programs in run.ts, page programs in page/template.ts), so an execution
 * looks up no declared parameter, encoder or variant, and checks nothing its program already settled.
 *
 * - Placeholders. Every declared parameter of the read is admitted once per execution, whether or not a sent statement
 *   binds it, by one walk of the declarations (relations.ts executionInputs): a scalar's value encoded by its declared
 *   type's codec, a relation's input normalized. A placeholder binds what that walk produced, so a read's refusal never
 *   depends on which parameters the optimizer eliminated, and what is admitted is what is sent. A scalar placeholder
 *   takes its declared parameter's encoded text. A relation placeholder takes one array of its relation input
 *   (relations.ts), normalized over its slot's columns: its column's array, or the input's count, which every
 *   statement sends as emitted, so equal parameters run equal texts and the planner reads each array's length as its
 *   estimate. A page's own placeholders, its limit, size and boundary values, are its own (page/execute.ts).
 * - Forms. A statement with a variant runs it when one of its choices' inputs exceeds the choice's threshold: a
 *   relation parameter's distinct fact count, or, for a page's attachment, the requested size. Both forms deliver the
 *   same set, so the choice is cost only.
 * - Rows. A statement's answer is PostgreSQL's output texts, which the session admits as texts only, read by the
 *   statement's delivery (codec/delivery.ts): each row its columns' texts, or, where a column is bytes, its chunks
 *   assembled, each bytes value a fresh array. They become Rows (core/decoder.ts): each row's cells, and per
 *   attachment slot the child Rows under it, which the value's decoder reads through the statement's layout. An
 *   attachment statement's rows lead with the parent key texts; each parent
 *   row gets the child Rows whose parent key equals its own under the key's type, in the statement's row order, which
 *   is the child's completed order when the child is ordered. Equality is the type's, never the raw text's: each key
 *   cell is read as its carrier's cell text (codec/read.ts cellText), one text per value, so of two parent rows whose
 *   keys are equal but print differently (1.0 and 1.00, -0 and 0) both own the children the statement delivers under
 *   its one spelling. Attachments nest: a child row's own attachments are grouped under it the same way. A fused attachment's
 *   column is parsed into its children's texts (lower/shapes/attach/decode.ts), its correlated columns copied from the
 *   parent row's texts.
 * - Layouts. A statement's layout names each public column's position (a rows statement's whole heading, an attachment
 *   statement's columns after its parent key that its delivered child carries, analysis.ts, none for a zero-column
 *   result) and each attachment's slot, child layout and the delivery the analysis proved, which the decoder's stated
 *   delivery must be licensed by. Row plans and layouts are settled once per program (programRecords), so a row reads
 *   no attachment fact and builds no scope, and a decoder binds to the same layouts on every read.
 * - Records. A program's statement tree is parsed once into one record per statement (programRecords): its forms,
 *   which sent statement's answer its rows are (a fed statement's being the feeder its arrival holds), the records of
 *   the attachment statements under it, which its tree holds, and its layout; a read follows references only.
 *
 * The host values of a read's parameters, by declared name; Stream relation parameters already collected (params.ts).
 */
export type HostParams = Readonly<Record<string, unknown>>

/**
 * What a record reads of a statement, whatever its placeholders and forms: its role, the heading of the relation it
 * delivers and its fused attachments, as a served program holds them (engine served/read.ts ServedRunStatement).
 */
type LoweredStatement = Pick<ServedRunStatement<unknown, ChoiceInput>, "role" | "heading" | "fused">

/** One form of a statement as an execution sends it: the spec emitted from it, and its placeholders in order. */
export interface StatementForm<Slot = DeclaredParamSlot> {
	readonly spec: ServedSpec
	readonly slots: ReadonlyArray<Slot>
}

/**
 * A statement as it runs: the statement its records read, its form, its forms (lower/shapes StatementForms): one, or its
 * whole-relation form with the choices that select it, and how the runtime has its rows.
 */
export interface RunStatement<
	S extends LoweredStatement,
	Slot = DeclaredParamSlot,
	Choice = ReadChoice
> extends StatementForm<Slot> {
	readonly statement: S
	readonly forms: StatementForms<Choice, StatementForm<Slot>>
	readonly arrival: Arrival
}

/** A read's per-execution choice: by the distinct fact count of a relation parameter. */
export interface ReadChoice {
	readonly source: ParamId
	readonly threshold: number
}

/** The form of a statement whose placeholders are `statement`'s, sent as `spec`. */
export const readForm = <Slot>(
	statement: { readonly params: ReadonlyArray<Slot> },
	spec: ServedSpec
): StatementForm<Slot> => ({ spec, slots: statement.params })

/**
 * What an execution reads, from one walk of the read's declared parameters (relations.ts executionInputs): the host
 * parameters (Streams collected), every declared scalar parameter's encoded text, and every declared relation
 * parameter's normalized input.
 */
export interface ExecutionInputs {
	readonly params: HostParams
	readonly scalars: ReadonlyMap<ParamId, Param>
	readonly relations: RelationInputs
}

/**
 * The input an execution admitted for the declared parameter `param`. The one site of the fact that every ParamId a
 * program's placeholder or choice names is a declared parameter of its read or write, which executionInputs admits on
 * every execution: the ParamId comes from the engine's lowered statement and the inputs from one walk of the
 * declarations, two runtime tables no TypeScript type ties together, so a miss is a defect of the compiler.
 */
const declaredInput = <V>(inputs: ReadonlyMap<ParamId, V>, param: ParamId): V => {
	const input = inputs.get(param)
	if (input === undefined) {
		throw defect(`the declared parameter ${param} has an admitted input`)
	}
	return input
}

/** The encoded text of the scalar input `param`. */
const scalarInput = (inputs: ExecutionInputs, param: ParamId): Param =>
	declaredInput(inputs.scalars, param)

/** The distinct fact count of the relation input `param`. */
export const inputCount = (inputs: ExecutionInputs, param: ParamId): number =>
	declaredInput(inputs.relations, param).normalized.count

/** The form `run` takes in an execution: its large form when one of its choices `exceeds` its threshold. */
export const formFor = <S extends LoweredStatement, Slot, Choice>(
	run: RunStatement<S, Slot, Choice>,
	exceeds: (choice: Choice) => boolean
): StatementForm<Slot> => {
	const forms = run.forms
	switch (forms.kind) {
		case "one":
			return run
		case "chosen":
			return Arr.some(forms.choices, exceeds) ? forms.large : run
	}
}

/**
 * The text of a read placeholder in one execution: a scalar's encoded text, or one array of a relation input over the
 * columns the slot shares with its input's other placeholders in the statement, the array at its part, which the
 * placeholder writes.
 */
export const readBinding = (
	slot: DeclaredParamSlot,
	inputs: ExecutionInputs
): Result.Result<Param, InputTooLarge> => {
	switch (slot.kind) {
		case "scalar":
			return Result.succeed(scalarInput(inputs, slot.param))
		case "relation":
			return declaredInput(inputs.relations, slot.param).array(
				slot.columns,
				slot.part.kind === "column" ? slot.part.index : 0
			)
	}
}

/** A statement of a flight the engine printed: its text and its parameters' texts, in placeholder order. */
export interface EmittedStatement extends BatchStatement {
	readonly sql: EmittedText
}

/** The text and placeholder texts of one execution of `form`, each placeholder bound by `bind`. */
export const executionOf = <Slot, E>(
	form: StatementForm<Slot>,
	bind: (slot: Slot) => Result.Result<Param, E>
): Result.Result<EmittedStatement, E> => {
	const encoded: Array<Param> = []
	for (const slot of form.slots) {
		const bound = bind(slot)
		if (Result.isFailure(bound)) {
			return Result.fail(bound.failure)
		}
		encoded.push(bound.success)
	}
	return Result.succeed({ sql: form.spec.sql, params: encoded })
}

/** One execution of `form`, its parameters encoded. */
export const encodeForm = <Slot, E>(
	form: StatementForm<Slot>,
	bind: (slot: Slot) => Result.Result<Param, E>
): Effect.Effect<EmittedStatement, E> =>
	Effect.suspend(() => Effect.fromResult(executionOf(form, bind)))

/** A flight's answers to the statements it sent, in the order it sent them, as PostgreSQL sent them. */
export type SentRuns = ReadonlyArray<OutputRows>

/**
 * One parent key column as a row holds it: its position among the row's texts, and its type's cell text
 * (codec/read.ts cellText), the one text of the value a cell spells, so 1.0 and 1.00 are one key, as are -0 and 0:
 * the identity the statement's read-back check partitions by natively (lower/conservative/deliver.ts
 * checkedAttachment).
 */
interface KeyRead {
	readonly at: number
	readonly cell: (cell: Cell) => string
}

/**
 * An attachment statement under a statement's rows: its record, and the parent key read from the parent's rows and from
 * the attachment's, which lead with it.
 */
interface ChildPlan<Run> {
	readonly record: StatementRecord<Run>
	readonly parent: ReadonlyArray<KeyRead>
	readonly child: ReadonlyArray<KeyRead>
}

/**
 * A fused attachment column of a statement's rows: its position after the heading, and its parse into its children's
 * texts (lower/shapes/attach/decode.ts).
 */
interface FusedPlan {
	readonly position: number
	readonly texts: FusedTexts
	/** A child's identity, over the child columns its texts hold. */
	readonly identity: RowIdentity
}

/**
 * How one statement's rows become Rows: each row's children, slot by slot, first those of the attachment statements
 * under it, then those of its fused attachment columns, the order its layout's attachment slots name.
 */
interface RowPlan<Run> {
	/** A row's identity, over every output column of the statement. */
	readonly identity: RowIdentity
	readonly children: ReadonlyArray<ChildPlan<Run>>
	readonly fused: ReadonlyArray<FusedPlan>
}

/**
 * A row's identity: each cell's value text under its column's type (codec/read.ts cellText), in column order, so two
 * rows have one identity exactly when every column holds equal values under its type's equality, 1.0 and 1.00 or -0
 * and 0 alike, whatever their spellings. It is those texts, never one text joined from them, so it costs its row's
 * arity, whatever its cells' lengths.
 */
type RowIdentity = (cells: ReadonlyArray<Cell>) => ReadonlyArray<string>

/** The identity of rows whose cells, position by position, are read by `identities`. */
const rowIdentity =
	(identities: ReadonlyArray<(cell: Cell) => string>): RowIdentity =>
	(cells) =>
		identities.map((identity, at) => identity(rowCell(cells, at)))

/** A fused attachment's column text as it is: its children are held to their own identities (FusedPlan). */
const itself = (cell: Cell): string => outputTextOf(cell)

/**
 * One statement of a program as a flight runs it and its readers read it: its forms (`run`), how its rows arrive, how
 * they become Rows, and its layout (core/decoder.ts), where a decoder finds each public column among its texts and each
 * attachment among a row's children. A program's records are settled once (programRecords), so a read resolves no
 * statement position, builds no plan, and a decoder binds to the same layouts each time.
 */
export interface StatementRecord<Run> {
	readonly run: Run
	readonly arrival: Arrival
	/** How its answer's rows travel, which reads them (codec/delivery.ts). */
	readonly delivery: Delivery
	readonly plan: RowPlan<Run>
	readonly layout: Layout
}

/**
 * A program's records, in flight order, and its delivered ones, the statements that are no attachment, in flight order.
 */
export interface ProgramRecords<Run> {
	readonly records: Arr.NonEmptyReadonlyArray<StatementRecord<Run>>
	readonly delivered: Arr.NonEmptyReadonlyArray<StatementRecord<Run>>
}

/** A statement's output columns (conservative/types.ts statementOutput). */
const outputOf = (statement: LoweredStatement): StatementOutput<ServedFused> =>
	statementOutput(statement.role, statement.heading, statement.fused)

/**
 * A statement as a program runs it, whatever its forms: the lowered statement it was placed as, and how the runtime has
 * its rows.
 */
export interface Arrived {
	readonly statement: LoweredStatement
	readonly arrival: Arrival
}

/** The answer of the sent statement whose rows a statement's are: its own, or its feeder's. */
export const answerOf = (arrival: Arrival): number =>
	arrival.kind === "sent" ? arrival.answer : arrival.feeder.answer

/**
 * Where a statement is in its program's tree: delivered, whose whole heading is public, or an attachment under its
 * parent's rows, whose own columns after its parent key are public where the delivered child carries them, in its
 * parent's scope on the delivered spine (none off it).
 */
type Under =
	| { readonly kind: "root" }
	| {
			readonly kind: "attachment"
			readonly attach: ServedAttach
			readonly scope: ServedSpine | undefined
	  }

/** The public columns of a statement's rows and their positions, where `under` places it. */
const columnsOf = (statement: LoweredStatement, under: Under): ReadonlyMap<string, number> => {
	const output = outputOf(statement)
	if (under.kind === "root") {
		return new Map(Arr.map(statement.heading, (column, i) => [column.name, output.own(i)]))
	}
	const { attach, scope } = under
	return new Map(
		Arr.flatMap(statement.heading, (column, i) =>
			carried(attach, scope, column.name) ? [[column.name, output.own(i)] as const] : []
		)
	)
}

/**
 * An attachment as its parent's record holds it: its child plan, and its layout but for the slot, which its parent
 * numbers.
 */
interface Attached<Run> {
	readonly name: string
	readonly plan: ChildPlan<Run>
	readonly layout: Omit<AttachmentLayout, "slot">
}

/**
 * The record of the statement `tree` holds, placed `under`, in its scope on the delivered spine `scope` (none off it),
 * after the records of the attachment statements under it, whose layouts its own holds; an attachment's parent key is
 * read by its columns' codecs under the installation's codes `codes`.
 *
 * An attachment's child is one statement, so it has one layout and its Rows are heading group 0 (rowsOf): the
 * lowering refuses to deliver an attached heterogeneous union per heading group (lower/conservative/deliver.ts), and
 * a fused child is one column.
 */
const recordOf = <Run extends Arrived>(
	tree: ServedTree<Run>,
	under: Under,
	scope: ServedSpine | undefined,
	codes: Codebook
): StatementRecord<Run> => {
	const run = tree.statement
	const statement = run.statement
	const output = outputOf(statement)
	const attached = Arr.map(tree.attachments, (child) => attachedOf(child, output, scope, codes))
	const attachments = new Map<string, AttachmentLayout>()
	for (const a of attached) {
		attachments.set(a.name, { ...a.layout, slot: attachments.size })
	}
	const fused = Arr.map(statement.fused, (f, j): FusedPlan => {
		attachments.set(f.name, {
			slot: attachments.size,
			layouts: [
				{
					columns: new Map(
						Arr.flatMap(f.layout.columns, ({ column }, i) =>
							carried(f.attach, scope, column.name) ? [[column.name, i] as const] : []
						)
					),
					attachments: new Map()
				}
			],
			proved: f.attach.judged
		})
		return {
			position: output.fusedAt(j),
			identity: rowIdentity(
				Arr.map(f.layout.columns, ({ column }) => scalarReader(column.type, codes).cellText)
			),
			texts: fusedTexts(f.layout, (column) => {
				const at = output.own(columnPosition(statement.heading, column))
				return (row) => rowText(row, at)
			})
		}
	})
	return {
		run,
		arrival: run.arrival,
		delivery: deliveryOf([
			...Arr.map(output.heading, (column) => cellKindOf(column.type)),
			...Arr.map(output.fused, () => "text" as const)
		]),
		plan: {
			identity: rowIdentity([
				...Arr.map(output.heading, (column) => scalarReader(column.type, codes).cellText),
				...Arr.map(fused, () => itself)
			]),
			children: Arr.map(attached, (a) => a.plan),
			fused
		},
		layout: { columns: columnsOf(statement, under), attachments }
	}
}

/**
 * The attachment `tree` holds under the rows of a statement of output `parent`, in the parent's scope `scope`: its
 * record, its parent key read from the parent's rows and from its own, which lead with it, and its layout.
 */
const attachedOf = <Run extends Arrived>(
	tree: ServedAttached<Run>,
	parent: StatementOutput<ServedFused>,
	scope: ServedSpine | undefined,
	codes: Codebook
): Attached<Run> => {
	const { attach } = tree
	const record = recordOf(
		tree,
		{ kind: "attachment", attach, scope },
		scope?.under.get(attach.name),
		codes
	)
	const parentKey = keyColumns(tree.statement.statement.role)
	return {
		name: attach.name,
		plan: {
			record,
			parent: Arr.map(parentKey, (c) => ({
				at: parent.own(c.at),
				cell: scalarReader(c.type, codes).cellText
			})),
			child: Arr.map(parentKey, (c, at) => ({ at, cell: scalarReader(c.type, codes).cellText }))
		},
		layout: { layouts: [record.layout], proved: attach.judged }
	}
}

/** `record` and the records of the attachment statements under it, in flight order. */
const recordsUnder = <Run>(
	record: StatementRecord<Run>
): Arr.NonEmptyReadonlyArray<StatementRecord<Run>> => [
	record,
	...Arr.flatMap(record.plan.children, (child) => recordsUnder(child.record))
]

/**
 * The records of a program's statements, each run by its `run`, on the delivered spine `spine` (servedSpine), under
 * the installation's codes `codes`: its delivered ones, each with the records of the attachment statements under its
 * rows, and all of them in flight order.
 */
export const programRecords = <Run extends Arrived>(
	roots: ServedRoots<Run>,
	spine: ServedSpine,
	codes: Codebook
): ProgramRecords<Run> => {
	const delivered = Arr.map(roots, (tree) => recordOf(tree, { kind: "root" }, spine, codes))
	return { records: Arr.flatten(Arr.map(delivered, recordsUnder)), delivered }
}

/** A parent key's map key: the identities of the cells `key` reads, in its order. */
const keyOf = (cells: ReadonlyArray<Cell>, key: ReadonlyArray<KeyRead>): ReadonlyArray<string> =>
	key.map((read) => read.cell(rowCell(cells, read.at)))

/** The rows of `record` in a flight whose sent statements answered `sent`, as its delivery assembles them. */
export const runOf = <Run>(record: StatementRecord<Run>, sent: SentRuns): AssembledRows =>
	assembled(record.delivery, sentAnswer(sent, answerOf(record.arrival)))

/** The children of a row with no attachment slot, and of a slot with no child. */
const noSlots: ReadonlyArray<ReadonlyArray<Row>> = Object.freeze([])
const noRows: ReadonlyArray<Row> = Object.freeze([])

/**
 * Whether two cells of one identity hold one value: always, but a bytes cell, whose identity is its digest, holds its
 * bytes (scalar/values/bytes.ts sameBytes).
 */
const sameCells = (a: ReadonlyArray<Cell>, b: ReadonlyArray<Cell>): boolean =>
	a.every((cell, at) => {
		const other = b[at]
		return (
			typeof cell === "string" ||
			(other !== undefined && typeof other !== "string" && sameBytes(cell, other))
		)
	})

/**
 * Whether two of `rows` are one row: one identity (RowIdentity), and the same bytes where a column holds bytes (sameCells),
 * so two rows of one digest that differ are two. A repeat is what no statement grizzle delivers holds, since every
 * delivered statement, an attachment's and a fused child array's included, is a set by its compiled proof.
 */
const repeats = (rows: AssembledRows, identity: RowIdentity): boolean => {
	const seen = new TupleMap<ReadonlyArray<string>, Array<ReadonlyArray<Cell>>>()
	for (const cells of rows) {
		const one = identity(cells)
		const held = seen.get(one)
		if (held === undefined) {
			seen.set(one, [cells])
		} else if (held.some((other) => sameCells(other, cells))) {
			return true
		} else {
			held.push(cells)
		}
	}
	return false
}

/**
 * The server's answer to `record`'s statement holding a row twice, which its compiled proof says it cannot deliver:
 * UnreadableAnswer at the statement whose rows they are, after the read committed.
 */
const repeated = <Run>(record: StatementRecord<Run>): UnreadableAnswer =>
	new UnreadableAnswer({ index: answerOf(record.arrival), fate: "committed" })

/**
 * The Rows of `rows`, rows of `record` delivered as heading group `group` (0 unless the statement is one of a
 * heterogeneous union's heading groups), in a flight whose sent statements answered `sent`, each with the child Rows
 * of every attachment slot: an attachment statement's rows whose parent key equals the row's under the key's type, in
 * the statement's row order, then each fused column's children. A child Row is heading group 0: an attachment's child
 * is one statement of one layout (programRecords).
 *
 * Every statement's rows are a set, and so is every fused column's children: a repeat (repeats) is UnreadableAnswer,
 * never a row delivered twice. A child statement's rows lead with their parent key, so its rows are distinct exactly
 * when each parent's children are.
 */
export const rowsOf = <Run>(
	record: StatementRecord<Run>,
	sent: SentRuns,
	rows: AssembledRows,
	group: number
): Result.Result<ReadonlyArray<Row>, UnreadableAnswer> => {
	const plan = record.plan
	if (repeats(rows, plan.identity)) {
		return Result.fail(repeated(record))
	}
	const grouped: Array<{
		readonly child: ChildPlan<Run>
		readonly groups: TupleMap<ReadonlyArray<string>, Array<Row>>
	}> = []
	for (const child of plan.children) {
		const childRows = rowsOf(child.record, sent, runOf(child.record, sent), 0)
		if (Result.isFailure(childRows)) {
			return childRows
		}
		const groups = new TupleMap<ReadonlyArray<string>, Array<Row>>()
		for (const row of childRows.success) {
			const key = keyOf(row.cells, child.child)
			const known = groups.get(key)
			if (known === undefined) {
				groups.set(key, [row])
			} else {
				known.push(row)
			}
		}
		grouped.push({ child, groups })
	}
	const slots = plan.children.length + plan.fused.length
	const out: Array<Row> = []
	for (const cells of rows) {
		if (slots === 0) {
			out.push({ group, cells, children: noSlots })
			continue
		}
		const children: Array<ReadonlyArray<Row>> = []
		for (const one of grouped) {
			children.push(one.groups.get(keyOf(cells, one.child.parent)) ?? noRows)
		}
		for (const f of plan.fused) {
			const elements = f.texts(rowText(cells, f.position), cells)
			if (repeats(elements, f.identity)) {
				return Result.fail(repeated(record))
			}
			const fusedChildren: Array<Row> = []
			for (const child of elements) {
				fusedChildren.push({ group: 0, cells: child, children: noSlots })
			}
			children.push(fusedChildren)
		}
		out.push({ group, cells, children })
	}
	return Result.succeed(out)
}
