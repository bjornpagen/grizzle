import { Effect, Result } from "effect"
import type { DbContext } from "#adapter/db/context.ts"
import { fromEngine } from "#adapter/engine.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { pageOf } from "#adapter/page/edges.ts"
import { type PageCall, pageFlight } from "#adapter/page/execute.ts"
import { pageRequest } from "#adapter/page/request.ts"
import type { PageRuntime } from "#adapter/page/template.ts"
import type { ReadExecutor } from "#adapter/reader/executor.ts"
import { hostParams } from "#adapter/reader/params.ts"
import { executionInputs, type ParamCodecs } from "#adapter/reader/relations.ts"
import { compiledPageTemplate } from "#adapter/served/forms.ts"
import {
	bindGroups,
	type CursorError,
	type ParamMap,
	type RowDecoder
} from "#compiler/plan/common.ts"
import type { CompiledTemplate, Page } from "#compiler/plan/read.ts"

/**
 * QueryReader.page and Compiled.page.
 *
 * A page is a database continuation operation: one bounded query in the order the ordered query completes, never the
 * whole result evaluated and buffered on the host. In order, and everything before step 5 without SQL:
 *
 * 1. The request is validated (request.ts): exactly { first }, { first, after }, { last } or { last, before }, a size
 *    that is a safe integer of at least 1, an anchor that is a string. A refused shape or size is a ReadFailure whose
 *    reason is PageRequestRefused (stage request), a non-string anchor CursorError `cursorType`.
 * 2. The ordered query compiles for a page: the query compiler's template for read "page" (program/compile.ts), whose
 *    checker refuses a page over an attached query with AttachedPage, as this module refuses a builder
 *    value still inside its attachment; then its page runtime template (template.ts: the page compiler's statements
 *    and the cursor codec). As
 *    for every direct read, a query that does not compile is a ReadFailure whose reason is its CompileError (stage
 *    compile), never a parameter value. A handle db.compile compiled an ordered query into holds its page template, compiled
 *    the same way when the handle was.
 * 3. The parameters are made ready as a read's are: Streams collected and relation inputs normalized
 *    (reader/params.ts, reader/relations.ts), a refusal being an EncodingFailure (stage encode) or InputTooLarge
 *    (stage resource).
 * 4. An after or before token is validated against the template's codec: size, encoding, layout, generation, query,
 *    comparators and every boundary value, the first refusal being CursorError with its reason.
 * 5. The statements run in one flight (execute.ts): one statement alone, or several in one short read-only
 *    transaction, so rows and flags are one view, committed before the page returns, so a request holds
 *    nothing across requests. They are the page template's, compiled for the `snapshot` context the flight runs in.
 * 6. Each delivered edge's node is its Row decoded by the ordered query's own decoder (`rows`), bound to the request
 *    variant's layouts once per page template, a binding the query's decoder refuses failing the page as a query that
 *    does not compile; and its cursor is made from its comparison tuple (execute.ts). Every cursor is stateless: it
 *    identifies a boundary of the live query and is accepted by any later page of the same query. A tuple whose token
 *    would exceed the layout's bound (codec/cursor/codec.ts cursorTokenMaxLength) fails the page with CursorError
 *    `cursorTupleOversized`; a page is returned only once every cursor exists. startCursor and endCursor are the first
 *    and last edges' cursors, Option.none for an empty page.
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
 * The page template of an ordered query for a Db's reader, in the `snapshot` context, or the compile error.
 *
 * A query value whose rules still read an attachment's parent variables is a child read outside its attachment:
 * the builder keeps it inside the attachment and describes it to no one (query/build/state.ts
 * publicDesc), so the page refuses it here as the checker refuses its Description, with AttachedPage.
 */
const compilePageTemplate = (
	ctx: DbContext,
	query: unknown
): Result.Result<CompiledPage, ReadFailure> =>
	Result.mapError(compiledPageTemplate(ctx, query), (reason) => new ReadFailure({ reason }))

/** The page's template: compiled for this page, or the compiled handle's. */
const pageTemplateOf = <A>(run: PageRun<A>): Effect.Effect<CompiledPage, ReadError> =>
	run.source.kind === "compiled"
		? Effect.succeed(run.source.page)
		: Effect.suspend(() => Effect.fromResult(compilePageTemplate(run.ctx, run.query)))

/** One page request through a reader. */
export const runPage = <A, Q>(
	run: PageRun<A>
): Effect.Effect<Page<A, Q>, ReadError | CursorError> =>
	Effect.gen(function* () {
		const request = yield* Effect.fromResult(pageRequest(run.request))
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
		/** The query's decoder bound to the request variant's layouts, once per page request. */
		const read = bindGroups(
			run.decoder(),
			runtime.artifact.requests[request.variant].layouts,
			run.ctx.bind
		)
		if (!read.ok) {
			return yield* new ReadFailure({ reason: read.error })
		}
		const flight = yield* Effect.mapError(
			pageFlight(runtime, inputs, call),
			(reason) => new ReadFailure({ reason })
		)
		const rows = yield* run.executor.run(flight)
		return yield* Effect.fromResult(pageOf<A, Q>(runtime, rows, read.value))
	})
