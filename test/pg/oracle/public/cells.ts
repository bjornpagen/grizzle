import {
	Array as Arr,
	Data,
	Effect,
	Formatter,
	Option,
	Record,
	Result,
	String as Str
} from "effect"
import type { DbContext } from "#adapter/db/context.ts"
import type { ReadError } from "#adapter/errors/execution.ts"
import { pageEdges } from "#adapter/page/execute.ts"
import { type PageRequestValue, pageRequest } from "#adapter/page/request.ts"
import { type PageArtifactName, type PageRuntime, pageTemplateFor } from "#adapter/page/template.ts"
import { attachmentHeads } from "#adapter/reader/analysis.ts"
import type { SentRuns } from "#adapter/reader/execution.ts"
import {
	type CompiledReadValue,
	makeReader,
	poolExecutor,
	type QueryResultValue,
	type ReadExecutor,
	type ReaderValue
} from "#adapter/reader/reader.ts"
import { deliveredRows, templateProgram } from "#adapter/reader/run.ts"
import { assembled, cellKindOf, deliveryOf } from "#compiler/codec/delivery.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import type { Layout, Row } from "#compiler/core/decoder.ts"
import { bytesChunkLength } from "#compiler/core/limits.ts"
import * as Engine from "#compiler/core/result.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import type { Cell } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { type ConservativeParamSlot, statementOutput } from "#compiler/lower/conservative/types.ts"
import { type FusedLayout, fusedElement } from "#compiler/lower/shapes/attach/decode.ts"
import type { FusedStatement } from "#compiler/lower/shapes/index.ts"
import { queryInput } from "#compiler/program/compile.ts"
import type { CompiledTemplate } from "#compiler/program/template.ts"
import type { Bytes } from "#compiler/scalar/values/bytes.ts"
import { isHostValue } from "#compiler/scalar/values/identity.ts"
import type { Page } from "#compiler/types/page/page.ts"
import { type Conversion, freshCodesOf } from "#test/pg/oracle/public/planted.ts"
import {
	type StrictCell,
	strictArrayText,
	strictDelivered,
	strictReader as strictCellReader
} from "#test/support/kernel/strict.ts"

/** Whether a value has the bytes host type: a Uint8Array over an ArrayBuffer. */
const isBytes = (value: unknown): value is Bytes =>
	value instanceof Uint8Array && value.buffer instanceof ArrayBuffer

export class CellDisagreement extends Data.TaggedError("CellDisagreement")<{
	readonly report: string
}> {
	override get message(): string {
		return this.report
	}
}

function disagree(report: string): never {
	throw new CellDisagreement({ report })
}

const misread = (type: ScalarType, text: string, what: string): never =>
	disagree(`a ${type.carrier} cell ${Formatter.format(text)}: ${what}`)

const readsAs = (type: ScalarType, text: string, value: unknown, what: string): void => {
	const codec = scalarCodec(type, freshCodesOf(type))
	const read = strictCellReader(type, freshCodesOf(type))(text)
	if (Result.isFailure(read)) {
		misread(type, text, `no output text of its type (${read.failure})`)
	} else if (
		!isHostValue(codec.spec.carrier, value) ||
		codec.text(value) !== codec.text(read.success)
	) {
		misread(type, text, what)
	}
}

/** A text cell's text: a bytes value where a text column's cell stands disagrees. */
const textCell = (cell: StrictCell, what: string): string =>
	typeof cell === "string" ? cell : disagree(`${what}: a bytes value where a text stands`)

/**
 * A cell's check under its column: a text column's conversion against its strict reading; a bytes column's cell is
 * the value its strict assembly read (checkCells), which no text spells.
 */
const cellCheck = (type: ScalarType, conversion: Conversion): ((cell: StrictCell) => void) => {
	if (type.carrier === "bytes") {
		return (cell) => {
			if (typeof cell === "string") {
				disagree(`a bytes cell that is a text: ${Str.slice(0, 32)(cell)}`)
			}
		}
	}
	const convert = conversion(type)
	return (cell) => {
		const text = textCell(cell, `a ${type.carrier} cell`)
		readsAs(type, text, convert(text), "its conversion differs from its strict reading")
	}
}

/** Whether two cells hold one value: two texts equal, or two bytes values of equal bytes. */
const sameCell = (a: StrictCell | Cell, b: StrictCell | Cell): boolean =>
	typeof a === "string" || typeof b === "string"
		? a === b
		: a.length === b.length && a.every((byte, at) => byte === b[at])

const fusedCheck = (element: Heading, conversion: Conversion): ((cell: StrictCell) => void) => {
	const checks = Arr.map(element, (c) => cellCheck(c.type, conversion))
	const [only] = checks

	const checkObject = (e: string): void => {
		const object = trustedJson<Readonly<Record<string, string>>>(e)
		if (Record.keys(object).length !== checks.length) {
			disagree(`a fused attachment element that is no object of its fields: ${e}`)
		}
		for (const [i, check] of checks.entries()) {
			const value = object[`f${i + 1}`]
			if (value === undefined) {
				disagree(`a fused attachment element without f${i + 1}: ${e}`)
			}
			check(value)
		}
	}
	return (cell) => {
		const text = textCell(cell, "a fused attachment cell")
		const elements = strictArrayText(text)
		if (Result.isFailure(elements)) {
			disagree(`a fused attachment cell that is no array output: ${text}`)
		}
		for (const e of elements.success) {
			if (e === null) {
				disagree(`a fused attachment cell with a NULL element: ${text}`)
			}
			if (only === undefined && e !== "true") {
				disagree(`a fused existence element that is not true: ${e}`)
			}
			if (only !== undefined && checks.length === 1) {
				only(e)
			}
			if (only !== undefined && checks.length > 1) {
				checkObject(e)
			}
		}
	}
}

interface Checked {
	readonly heading: Heading
	readonly own: number
	readonly fused: ReadonlyArray<{ readonly name: string; readonly layout: FusedLayout }>
	readonly layout: Layout
}

const ownFrom = (statement: FusedStatement<ConservativeParamSlot>): number =>
	statementOutput(statement.role, statement.heading, statement.fused).own(0)

interface LaidOut {
	readonly heading: Heading
	readonly own: number
}

type Flight = { readonly kind: "awaiting" } | { readonly kind: "flown"; readonly sent: SentRuns }

interface Recorded {
	readonly prepared: CompiledTemplate
	readonly desc: QueryDesc
}

/**
 * Every answer of a flight read strictly by its statement's delivery (test/support/kernel/strict.ts strictDelivered),
 * which the library's assembly must read alike, row by row and cell by cell, and every cell checked under its column.
 */
const checkCells = (
	statements: ReadonlyArray<Pick<Checked, "heading" | "fused">>,
	sent: SentRuns,
	conversion: Conversion
): void => {
	if (statements.length !== sent.length) {
		disagree(`a flight of ${sent.length} answers for ${statements.length} statements`)
	}
	for (const [i, s] of statements.entries()) {
		const checks = [
			...Arr.map(s.heading, (c) => cellCheck(c.type, conversion)),
			...Arr.map(s.fused, (f) => fusedCheck(fusedElement(f.layout), conversion))
		]
		const answer = defined(sent[i], `the answer of statement ${i}`)
		const delivery = deliveryOf([
			...Arr.map(s.heading, (c) => cellKindOf(c.type)),
			...Arr.map(s.fused, () => "text" as const)
		])
		const strict = strictDelivered(delivery, answer, bytesChunkLength.value)
		if (Result.isFailure(strict)) {
			disagree(`statement ${i}'s answer is no delivery of its columns: ${strict.failure}`)
		}
		const library = assembled(delivery, answer)
		if (
			library.length !== strict.success.length ||
			!Arr.every(
				Arr.zip(library, strict.success),
				([l, r]) => l.length === r.length && Arr.every(Arr.zip(l, r), ([x, y]) => sameCell(x, y))
			)
		) {
			disagree(`statement ${i}'s answer assembles otherwise than its strict reading`)
		}
		for (const row of strict.success) {
			checkRow(row, checks)
		}
	}
}

const checkRow = (
	row: ReadonlyArray<StrictCell>,
	checks: ReadonlyArray<(cell: StrictCell) => void>
): void => {
	if (row.length !== checks.length) {
		disagree(`a row of ${row.length} cells for ${checks.length} columns`)
	}
	for (const [k, check] of checks.entries()) {
		const cell = row[k]
		if (cell === undefined) {
			disagree(`a row without its cell ${k}`)
		}
		check(cell)
	}
}

const headingsOf = (statements: ReadonlyArray<Checked>): ReadonlyMap<Layout, LaidOut> => {
	const out = new Map<Layout, LaidOut>()
	for (const s of statements) {
		out.set(s.layout, { heading: s.heading, own: s.own })
		for (const f of s.fused) {
			out.set(fusedChildLayout(s, f.name), {
				heading: Arr.map(f.layout.columns, (c) => c.column),
				own: 0
			})
		}
	}
	return out
}

const fusedChildLayout = (s: Checked, name: string): Layout => {
	const child = s.layout.attachments.get(name)?.layouts[0]
	if (child === undefined) {
		throw new Error(`no layout of the fused attachment ${name}`)
	}
	return child
}

const isRecord = (value: unknown): value is { readonly [field: string]: unknown } =>
	typeof value === "object" && value !== null

const isRows = (value: unknown): value is ReadonlyArray<unknown> => Arr.isArray(value)

const childrenOf = (value: unknown): ReadonlyArray<unknown> =>
	Option.isOption(value)
		? Option.isSome(value)
			? [value.value]
			: []
		: isRows(value)
			? value
			: [value]

const compareRow = (
	record: unknown,
	row: Row,
	layout: Layout,
	headings: ReadonlyMap<Layout, LaidOut>
): void => {
	if (!isRecord(record)) {
		disagree("a delivered row that is no record")
	}
	const laidOut = headings.get(layout)
	if (laidOut === undefined) {
		throw new Error("a layout the read does not hold")
	}
	for (const [field, value] of Record.toEntries(record)) {
		const position = layout.columns.get(field)
		if (position === undefined) {
			compareAttachment(field, value, row, layout, headings)
		} else {
			compareColumn(field, value, position, row, laidOut)
		}
	}
}

const compareColumn = (
	field: string,
	value: unknown,
	position: number,
	row: Row,
	laidOut: LaidOut
): void => {
	const { heading, own } = laidOut
	const expected = Arr.findFirstIndex(heading, (c, i) => i >= own && c.name === field)
	if (Option.isNone(expected) || expected.value !== position) {
		disagree(`layout of ${field}`)
	}
	const column = heading[position]
	const cell = row.cells[position]
	if (column === undefined || cell === undefined) {
		disagree(`no cell ${position} of ${field}`)
	}
	if (typeof cell !== "string") {
		if (!isBytes(value) || !sameCell(cell, value) || value.buffer === cell.buffer) {
			disagree(`the delivered field ${field} differs from its cell's bytes, or shares their buffer`)
		}
		return
	}
	readsAs(
		column.type,
		cell,
		value,
		`the delivered field ${field} differs from its cell's strict reading`
	)
}

const compareAttachment = (
	field: string,
	value: unknown,
	row: Row,
	layout: Layout,
	headings: ReadonlyMap<Layout, LaidOut>
): void => {
	const at = layout.attachments.get(field)
	if (at === undefined) {
		disagree(`a delivered field ${field} its statement's layout does not hold`)
	}
	const rows = defined(row.children[at.slot], `the child slot ${at.slot}`)
	const children = childrenOf(value)
	if (children.length !== rows.length) {
		disagree(`the attachment ${field} delivers ${children.length} children of ${rows.length} rows`)
	}
	for (const [k, child] of rows.entries()) {
		const childLayout = at.layouts[child.group]
		if (childLayout === undefined) {
			throw new Error(`no layout of heading group ${child.group}`)
		}
		compareRow(children[k], child, childLayout, headings)
	}
}

const checkRecords = (
	records: ReadonlyArray<unknown>,
	rows: ReadonlyArray<Row>,
	layouts: ReadonlyArray<Layout>,
	headings: ReadonlyMap<Layout, LaidOut>
): void => {
	if (rows.length !== records.length) {
		disagree(`${records.length} delivered rows of ${rows.length}`)
	}
	for (const [i, row] of rows.entries()) {
		const layout = layouts[row.group]
		if (layout === undefined) {
			throw new Error(`no layout of heading group ${row.group}`)
		}
		compareRow(records[i], row, layout, headings)
	}
}

type SentChecked = Checked & { readonly sent: boolean }

/**
 * A delivered row as PostgreSQL sent it: each column's cell text by its field name, a bytes value's its one text (its
 * SHA-256 digest), and each attachment's children by its name, in the delivered order. Its texts spell each value
 * as the server wrote it, the one witness of the spellings a delivery met once grizzle delivers every value in its one
 * form.
 */
export interface SentRow {
	readonly texts: ReadonlyMap<string, string>
	readonly children: ReadonlyMap<string, ReadonlyArray<SentRow>>
}

const sentRow = (row: Row, layout: Layout): SentRow => ({
	texts: new Map(
		Arr.map([...layout.columns], ([field, at]): readonly [string, string] => {
			const cell = defined(row.cells[at], `the cell ${at} of ${field}`)
			return [field, typeof cell === "string" ? cell : sha256Hex(cell)]
		})
	),
	children: new Map(
		Arr.map([...layout.attachments], ([field, a]): readonly [string, ReadonlyArray<SentRow>] => [
			field,
			Arr.map(defined(row.children[a.slot], `the child slot ${a.slot}`), (child) =>
				sentRow(child, defined(a.layouts[child.group], `the layout of group ${child.group}`))
			)
		])
	)
})

const checkRead =
	(conversion: Conversion, codes: Codebook) =>
	(
		recorded: Option.Option<Recorded>,
		sent: SentRuns,
		params: unknown,
		records: ReadonlyArray<unknown>
	): ReadonlyArray<SentRow> => {
		const { prepared, desc } = Option.getOrThrowWith(
			recorded,
			() => new Error("a read whose template was not recorded")
		)
		const program = templateProgram(
			prepared.template,
			prepared.selection.artifact,
			attachmentHeads(desc),
			codes
		)
		const statements = Arr.map(
			program.records,
			({ run: { statement }, layout, arrival }): SentChecked => ({
				heading: statementOutput(statement.role, statement.heading, statement.fused).heading,
				own: ownFrom(statement),
				fused: statement.fused,
				layout,
				sent: arrival.kind === "sent"
			})
		)
		checkCells(
			Arr.filter(statements, (s) => s.sent),
			sent,
			conversion
		)
		const delivered = deliveredRows(program, sent, isRecord(params) ? params : {})
		if (Result.isFailure(delivered)) {
			throw new Error(`the rows PostgreSQL sent are unreadable: ${delivered.failure.message}`)
		}
		const rows = delivered.success
		checkRecords(records, rows, program.layouts, headingsOf(statements))
		return Arr.map(rows, (row) =>
			sentRow(row, defined(program.layouts[row.group], `the layout of group ${row.group}`))
		)
	}

const probeOf = (
	run: PageRuntime["artifacts"][PageArtifactName],
	request: PageRequestValue
): ReadonlyArray<Pick<Checked, "heading" | "fused">> => {
	switch (request.variant) {
		case "first":
		case "last":
			return []
		case "after":
		case "before":
			return [run.probes[run.requests[request.variant].program.probe].statement.statement]
	}
}

const checkPage =
	(ctx: DbContext, conversion: Conversion) =>
	(
		recordedPage: Option.Option<Recorded>,
		sent: SentRuns,
		request: unknown,
		page: Page<unknown, unknown>
	): void => {
		const recorded = Option.getOrThrowWith(
			recordedPage,
			() => new Error("a page whose template was not recorded")
		)
		const runtime = pageTemplateFor({
			template: recorded.prepared.template,
			desc: recorded.desc,
			artifacts: ctx.artifacts
		})
		if (Result.isFailure(runtime)) {
			throw new Error("a page whose page template does not compile")
		}
		const parsed = pageRequest(request)
		if (Result.isFailure(parsed)) {
			throw new Error("a page that answered a request its runtime refuses")
		}
		const run = runtime.success.artifacts[recorded.prepared.selection.artifact]
		const program = run.requests[parsed.success.variant]
		const statements = Arr.map(
			program.records,
			({ run: { statement }, layout, arrival }): SentChecked => ({
				heading: statementOutput(statement.role, statement.heading, statement.fused).heading,
				own: ownFrom(statement),
				fused: statement.fused,
				layout,
				sent: arrival.kind === "sent"
			})
		)
		checkCells(
			[...Arr.filter(statements, (s) => s.sent), ...probeOf(run, parsed.success)],
			sent,
			conversion
		)
		checkRecords(
			Arr.map(page.edges, (edge) => edge.node),
			Arr.map(
				Result.getOrThrow(pageEdges(program, sent, parsed.success.size)).edges,
				(edge) => edge.row
			),
			program.layouts,
			headingsOf(statements)
		)
	}

const defined = <A>(value: A | undefined, what: string): A => {
	if (value === undefined) {
		throw new Error(`no ${what}`)
	}
	return value
}

const recordingCompile = (ctx: DbContext) => {
	let last: Option.Option<Recorded> = Option.none()

	const pages = new WeakMap<object, Recorded>()
	const compile: DbContext["compile"] = (input, request) =>
		Engine.map(ctx.compile(input, request), (prepared) => {
			const recorded: Recorded = { prepared, desc: input.desc }
			last = Option.some(recorded)
			if (request.read === "page") {
				pages.set(input.desc, recorded)
			}
			return prepared
		})
	return {
		compile,
		last: (): Option.Option<Recorded> => last,
		pageOf: (query: unknown): Option.Option<Recorded> => {
			const input = queryInput(query)
			return input.ok ? Option.fromUndefinedOr(pages.get(input.value.desc)) : Option.none()
		}
	}
}

/** A reader that reads every cell strictly, and the rows its last execute delivered as PostgreSQL sent them. */
export type StrictReader = ReaderValue & { readonly sentRows: () => ReadonlyArray<SentRow> }

export const strictReaderOf = (ctx: DbContext, conversion: Conversion): StrictReader => {
	const compiler = recordingCompile(ctx)
	let lastSent: ReadonlyArray<SentRow> = []
	const context: DbContext = { ...ctx, compile: compiler.compile }
	let inProgress: Flight = { kind: "awaiting" }
	const base = poolExecutor(ctx)
	const executor: ReadExecutor = {
		run: (flight) =>
			base.run({
				statements: flight.statements,
				read: (outcomes) =>
					Effect.map(flight.read(outcomes), (delivered) => {
						inProgress = { kind: "flown", sent: Arr.map(outcomes, (o) => o.rows) }
						return delivered
					})
			})
	}
	const reader: ReaderValue = makeReader(context, executor)
	const read = checkRead(conversion, ctx.artifacts.names.codes)
	const paged = checkPage(ctx, conversion)

	const checked = <A, E>(
		answer: Effect.Effect<A, E>,
		check: (a: A, sent: SentRuns) => Effect.Effect<void, E>
	): Effect.Effect<A, E> =>
		Effect.suspend(() => {
			inProgress = { kind: "awaiting" }
			lastSent = []
			return Effect.flatMap(answer, (a) => {
				const answered = inProgress
				switch (answered.kind) {
					case "awaiting":
						return Effect.die(new Error("a read that answered without a flight"))
					case "flown":
						return Effect.as(check(a, answered.sent), a)
				}
			})
		})
	const collected =
		(
			recorded: () => Option.Option<Recorded>,
			params: unknown
		): ((result: QueryResultValue, sent: SentRuns) => Effect.Effect<void, ReadError>) =>
		(result, sent) =>
			Effect.flatMap(result.collect, (rows) =>
				Effect.sync(() => {
					lastSent = read(recorded(), sent, params, rows)
				})
			)
	return {
		sentRows: () => lastSent,
		execute: (query, params) =>
			checked(reader.execute(query, params), collected(compiler.last, params)),
		get: (target, params) =>
			checked(reader.get(target, params), (got, sent) =>
				Effect.sync(() => {
					read(compiler.last(), sent, params, Option.isSome(got) ? [got.value] : [])
				})
			),
		page: (query, params, request) =>
			checked(reader.page(query, params, request), (page, sent) =>
				Effect.sync(() => {
					paged(compiler.pageOf(query), sent, request, page)
				})
			),
		compile: (query) =>
			Effect.map(reader.compile(query), (handle): CompiledReadValue => {
				const recorded = compiler.last()
				return {
					compiled: handle.compiled,
					execute: (params) =>
						checked(
							handle.execute(params),
							collected(() => recorded, params)
						),
					get: (params) =>
						checked(handle.get(params), (got, sent) =>
							Effect.sync(() => {
								read(recorded, sent, params, Option.isSome(got) ? [got.value] : [])
							})
						),
					page: (params, request) =>
						checked(handle.page(params, request), (page, sent) =>
							Effect.sync(() => {
								paged(compiler.pageOf(query), sent, request, page)
							})
						)
				}
			})
	}
}
