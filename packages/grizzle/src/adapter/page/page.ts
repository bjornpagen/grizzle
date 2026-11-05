import { Brand, Effect, Option, Result } from "effect"
import { missingExtension } from "#adapter/admission/expectation.ts"
import type { DbContext, RoleContext } from "#adapter/db/context.ts"
import { fromEngine, rowOptions, toResult } from "#adapter/engine.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { MissingCapability } from "#adapter/errors/failures.ts"
import { type PageCall, type PageRows, pageFlight } from "#adapter/page/execute.ts"
import { pageRequest } from "#adapter/page/request.ts"
import { type PageRuntime, pageTemplateFor } from "#adapter/page/template.ts"
import { hostParams } from "#adapter/reader/params.ts"
import type { ReadExecutor } from "#adapter/reader/reader.ts"
import { executionInputs, type ParamCodecs, paramCodecs } from "#adapter/reader/relations.ts"
import { bindGroups, type Row, type RowDecoder } from "#compiler/core/decoder.ts"
import { CompileError, type CursorError, prose } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { pageMaxSize } from "#compiler/core/policy.ts"
import * as Engine from "#compiler/core/result.ts"
import { queryInput } from "#compiler/program/compile.ts"
import type { CompiledTemplate } from "#compiler/program/template.ts"
import { queryState } from "#compiler/query/build/state.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import type { Page, PageCursor, PageEdge } from "#compiler/types/page/page.ts"

/**
 * QueryReader.page and Compiled.page.
 *
 * A page is a database continuation operation: one bounded query in the order the ordered query completes, never the
 * whole result evaluated and buffered on the host. In order, and everything before step 5 without SQL:
 *
 * 1. The request is validated (request.ts): exactly { first }, { first, after }, { last } or { last, before }, a size
 *    from 1 to pageMaxSize, an anchor that is a string. A refused shape or size is a ReadFailure whose reason is
 *    PageRequestRefused (stage request), a non-string anchor CursorError `cursorType`.
 * 2. The ordered query compiles for a page: the query compiler's template for read "page" (program/compile.ts), whose
 *    checker refuses a page over an attached query with AttachedPage, as this module refuses a builder
 *    value still inside its attachment; then its page runtime template (template.ts: the page compiler's statements
 *    and the cursor codec). As
 *    for every direct read, a query that does not compile is a ReadFailure whose reason is its CompileError (stage
 *    compile), and a capability the admitted database lacks one whose reason is MissingCapability (stage capability),
 *    never a parameter value. A handle db.compile compiled an ordered query into holds its page template, compiled
 *    the same way when the handle was.
 * 3. The parameters are made ready as a read's are: Streams collected and relation inputs normalized
 *    (reader/params.ts, reader/relations.ts), a refusal being an EncodingFailure (stage encode) or InputTooLarge
 *    (stage resource).
 * 4. An after or before token is validated against the template's codec: size, encoding, layout, generation, query,
 *    comparators and every boundary value, the first refusal being CursorError with its reason.
 * 5. The statements run in one flight (execute.ts): one statement alone, or several in one short read-only
 *    transaction, so rows and flags are one view, committed before the page returns, so a request holds
 *    nothing across requests. The artifact that runs is the template's selection for the `snapshot` context
 *    (program/context.ts).
 * 6. Each delivered edge's node is its Row decoded by the ordered query's own decoder (`rows`), bound to the request
 *    variant's layouts once per page template, a binding the query's decoder refuses failing the page as a query that
 *    does not compile; and its cursor is made from its comparison tuple (execute.ts). Every cursor is stateless: it
 *    identifies a boundary of the live query and is accepted by any later page of the same query. A tuple whose token
 *    would exceed cursorMaxBytes fails the page with CursorError `cursorTupleOversized`; a page is returned only once
 *    every cursor exists. startCursor and endCursor are the first and last edges' cursors, Option.none for an empty
 *    page.
 */
export interface PageRun<A> {
	readonly ctx: DbContext
	/** Runs the page's flight on a session of its own (reader/reader.ts). */
	readonly executor: ReadExecutor
	/**
	 * The Ordered query value, the decoder of its rows, and the page's parameters and request. The decoder is read once
	 * the query compiled for a page, since a JavaScript caller's value may be no query. The parameters come from the
	 * typed Db boundary (types/core ParamArg), each a ParamValue.
	 */
	readonly query: unknown
	readonly decoder: () => RowDecoder<A>
	readonly params: ParamMap
	readonly request: unknown
	/** Where the page's template comes from: compiled for this page, or the one a compiled handle holds. */
	readonly source: PageSource
}

/** A page's template: compiled for the page from its query, or compiled once by db.compile and held by its handle. */
export type PageSource =
	| { readonly kind: "query" }
	| { readonly kind: "compiled"; readonly page: CompiledPage }

/** A page's template: the query template compiled for a page, its page runtime template and its parameters' codecs. */
export interface CompiledPage {
	readonly compiled: CompiledTemplate
	readonly runtime: PageRuntime
	readonly codecs: ParamCodecs
}

/**
 * The page template of an ordered query for a Db's reader, in the `snapshot` context, or the compile error, or the
 * missing capability.
 *
 * A query value whose rules still read an attachment's parent variables is a child read outside its attachment:
 * the builder keeps it inside the attachment and describes it to no one (query/build/state.ts
 * publicDesc), so the page refuses it here as the checker refuses its Description, with AttachedPage.
 */
export const compilePageTemplate = (
	ctx: DbContext,
	query: unknown
): Result.Result<CompiledPage, ReadFailure> => {
	const compiled = Result.mapError(
		compiledPageTemplate(ctx, query),
		(reason) => new ReadFailure({ reason })
	)
	if (Result.isFailure(compiled)) {
		return compiled
	}
	const missing = missingExtension(
		compiled.success.compiled.template.requirements,
		ctx.installedExtensions
	)
	if (missing !== undefined) {
		return Result.fail(new ReadFailure({ reason: new MissingCapability({ capability: missing }) }))
	}
	return Result.succeed(compiled.success)
}

/**
 * The page template of an ordered query compiled for a role, or the refusal of a query read inside its attachment, or
 * its CompileError: what a page compiles for its call, and what db.compile and the layer's workload hold for an
 * ordered query, whose callers check its capability against the admitted database.
 */
export const compiledPageTemplate = (
	role: RoleContext,
	query: unknown
): Result.Result<CompiledPage, CompileError> => {
	if ((queryState(query)?.pending.size ?? 0) > 0) {
		return Result.fail(
			CompileError.make(
				prose(
					"AttachedPage",
					SourceLoc("page", []),
					"a page over a query read by an attachment: its rules read a parent variable, and a long child list is its own top-level query keyed by the parent"
				)
			)
		)
	}
	return Result.flatMap(
		toResult(
			Engine.flatMap(queryInput(query), (input) =>
				role.compile(input, {
					context: "snapshot",
					read: "page"
				})
			)
		),
		(compiled) =>
			Result.map(
				pageTemplateFor({
					template: compiled.template,
					desc: compiled.desc,
					artifacts: role.artifacts
				}),
				(runtime): CompiledPage => ({
					compiled,
					runtime,
					codecs: paramCodecs(compiled.template.params)
				})
			)
	)
}

/** The page's template: compiled for this page, or the compiled handle's. */
const pageTemplateOf = <A>(run: PageRun<A>): Effect.Effect<CompiledPage, ReadError> =>
	run.source.kind === "compiled"
		? Effect.succeed(run.source.page)
		: Effect.suspend(() => Effect.fromResult(compilePageTemplate(run.ctx, run.query)))

/**
 * A cursor token the page's codec made, for the page's query Q: the brand's constructor, which checks nothing; the
 * codec that made the token is its check.
 */
const pageCursor = <Q>(token: string): PageCursor<Q> => Brand.nominal<PageCursor<Q>>()(token)

/**
 * The Page of a page's rows, each node its Row read by `read`, every cursor made before it is returned; each cursor is
 * branded for Q, the query its handle reads (a direct page's query, or a compiled handle's).
 */
export const pageOf = <A, Q>(
	runtime: PageRuntime,
	rows: PageRows,
	read: (row: Row) => A
): Result.Result<Page<A, Q>, CursorError> => {
	const edges: Array<PageEdge<A, Q>> = []
	for (const edge of rows.edges) {
		const token = runtime.codec.encode(edge.tuple)
		if (!token.ok) {
			return Result.fail(token.error)
		}
		edges.push(Object.freeze({ node: read(edge.row), cursor: pageCursor<Q>(token.value) }))
	}
	const first = edges[0]
	const last = edges[edges.length - 1]
	return Result.succeed(
		Object.freeze({
			edges: Object.freeze(edges),
			pageInfo: Object.freeze({
				startCursor: first === undefined ? Option.none() : Option.some(first.cursor),
				endCursor: last === undefined ? Option.none() : Option.some(last.cursor),
				hasPreviousPage: rows.hasPreviousPage,
				hasNextPage: rows.hasNextPage
			})
		})
	)
}

/** One page request through a reader. */
export const runPage = <A, Q>(
	run: PageRun<A>
): Effect.Effect<Page<A, Q>, ReadError | CursorError> =>
	Effect.gen(function* () {
		const request = yield* Effect.fromResult(pageRequest(run.request, pageMaxSize))
		const { compiled, runtime, codecs } = yield* pageTemplateOf(run)
		const values = yield* hostParams(compiled.template.params, run.params)
		const inputs = yield* Effect.fromResult(
			Result.mapError(executionInputs(codecs, values), (reason) => new ReadFailure({ reason }))
		)
		const call: PageCall =
			request.variant === "first" || request.variant === "last"
				? request
				: {
						variant: request.variant,
						size: request.size,
						boundary: (yield* fromEngine(runtime.codec.decode(request.cursor))).texts
					}
		const artifact = compiled.selection.artifact
		/** The query's decoder bound to the request variant's layouts, once per page request. */
		const read = bindGroups(
			run.decoder(),
			runtime.artifacts[artifact].requests[request.variant].layouts,
			rowOptions
		)
		if (!read.ok) {
			return yield* new ReadFailure({ reason: read.error })
		}
		const flight = yield* Effect.mapError(
			pageFlight(runtime, artifact, inputs, call),
			(reason) => new ReadFailure({ reason })
		)
		const rows = yield* run.executor.run(flight)
		return yield* Effect.fromResult(pageOf<A, Q>(runtime, rows, read.value))
	})
