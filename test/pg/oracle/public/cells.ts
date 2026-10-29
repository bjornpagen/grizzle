import { Array as Arr, Effect, Option, Record, Result, Schema } from "effect"
import type { DbContext } from "#adapter/db/context.ts"
import type { ReadError } from "#adapter/errors/execution.ts"
import { pageEdges } from "#adapter/page/execute.ts"
import { type PageRequestValue, pageRequest } from "#adapter/page/request.ts"
import { type PageArtifactName, type PageRuntime, pageTemplateFor } from "#adapter/page/template.ts"
import { attachmentFacts } from "#adapter/reader/analysis.ts"
import type { SentRuns, StatementRun } from "#adapter/reader/execution.ts"
import {
	type CompiledReadValue,
	makeReader,
	poolExecutor,
	type QueryResultValue,
	type ReadExecutor,
	type ReaderValue
} from "#adapter/reader/reader.ts"
import { deliveredRows, templateProgram } from "#adapter/reader/run.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import type { Layout, Row } from "#compiler/core/decoder.ts"
import { pageMaxSize } from "#compiler/core/policy.ts"
import * as Engine from "#compiler/core/result.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { type ConservativeParamSlot, statementOutput } from "#compiler/lower/conservative/types.ts"
import { type FusedLayout, fusedElement } from "#compiler/lower/shapes/attach/decode.ts"
import type { FusedStatement } from "#compiler/lower/shapes/index.ts"
import { queryInput } from "#compiler/program/compile.ts"
import type { CompiledTemplate } from "#compiler/program/template.ts"
import { admittedIdentityText, isHostValue } from "#compiler/scalar/values/identity.ts"
import type { Page } from "#compiler/types/page/page.ts"
import type { Conversion } from "#test/pg/oracle/public/planted.ts"
import { strictArrayText, strictReader as strictCellReader } from "#test/support/kernel/strict.ts"

export class CellDisagreement extends Schema.TaggedError<
	CellDisagreement,
	{ readonly brand: unique symbol }
>()("CellDisagreement", { report: Schema.String }) {
	override get message(): string {
		return this.report
	}
}

function disagree(report: string): never {
	throw CellDisagreement.make({ report })
}

const misread = (type: ScalarType, text: string, what: string): never =>
	disagree(`a ${type.carrier} cell ${JSON.stringify(text)}: ${what}`)

const readsAs = (type: ScalarType, text: string, value: unknown, what: string): void => {
	const codec = scalarCodec(type)
	const read = strictCellReader(type)(text)
	if (Result.isFailure(read)) {
		misread(type, text, `no output text of its type (${read.failure})`)
	} else if (
		!isHostValue(codec.spec.carrier, value) ||
		codec.text(value) !== codec.text(read.success) ||
		admittedIdentityText(codec.spec, value) !== admittedIdentityText(codec.spec, read.success)
	) {
		misread(type, text, what)
	}
}

const cellCheck = (type: ScalarType, conversion: Conversion): ((text: string) => void) => {
	const convert = conversion(type)
	return (text) => {
		readsAs(type, text, convert(text), "its conversion differs from its strict reading")
	}
}

const elementObject = Schema.decodeUnknownResult(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
)

const fusedCheck = (element: Heading, conversion: Conversion): ((text: string) => void) => {
	const checks = Arr.map(element, (c) => cellCheck(c.type, conversion))
	const [only] = checks

	const checkObject = (e: string): void => {
		const object = elementObject(e)
		if (Result.isFailure(object) || Record.keys(object.success).length !== checks.length) {
			disagree(`a fused attachment element that is no object of its fields: ${e}`)
		}
		for (const [i, check] of checks.entries()) {
			const value = object.success[`f${i + 1}`]
			if (value === undefined) {
				disagree(`a fused attachment element without f${i + 1}: ${e}`)
			}
			check(value)
		}
	}
	return (text) => {
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

const checkCells = (
	statements: ReadonlyArray<Pick<Checked, "heading" | "fused">>,
	sent: ReadonlyArray<StatementRun>,
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
		for (const row of sent[i] ?? []) {
			checkRow(row, checks)
		}
	}
}

const checkRow = (
	row: StatementRun[number],
	checks: ReadonlyArray<(text: string) => void>
): void => {
	if (row.length !== checks.length) {
		disagree(`a row of ${row.length} cells for ${checks.length} columns`)
	}
	for (const [k, check] of checks.entries()) {
		const text = row[k]
		if (text === undefined) {
			disagree(`a row without its cell ${k}`)
		}
		check(text)
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
	const text = row.texts[position]
	if (column === undefined || text === undefined) {
		disagree(`no cell ${position} of ${field}`)
	}
	readsAs(
		column.type,
		text,
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

const checkRead =
	(conversion: Conversion) =>
	(
		recorded: Option.Option<Recorded>,
		sent: SentRuns,
		params: unknown,
		records: ReadonlyArray<unknown>
	): void => {
		const { prepared, desc } = Option.getOrThrowWith(
			recorded,
			() => new Error("a read whose template was not recorded")
		)
		const program = templateProgram(
			prepared.template,
			prepared.selection.artifact,
			attachmentFacts(prepared.template, desc)
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
		const rows = deliveredRows(program, sent, isRecord(params) ? params : {})
		checkRecords(records, rows, program.layouts, headingsOf(statements))
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
		const parsed = pageRequest(request, pageMaxSize)
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

export const strictReaderOf = (ctx: DbContext, conversion: Conversion): ReaderValue => {
	const compiler = recordingCompile(ctx)
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
	const read = checkRead(conversion)
	const paged = checkPage(ctx, conversion)

	const checked = <A, E>(
		answer: Effect.Effect<A, E>,
		check: (a: A, sent: SentRuns) => Effect.Effect<void, E>
	): Effect.Effect<A, E> =>
		Effect.suspend(() => {
			inProgress = { kind: "awaiting" }
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
					read(recorded(), sent, params, rows)
				})
			)
	return {
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
