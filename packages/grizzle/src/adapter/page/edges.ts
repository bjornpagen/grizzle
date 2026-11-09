import * as Brand from "effect/Brand"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type { PageRows } from "#adapter/page/execute.ts"
import type { PageRuntime } from "#adapter/page/template.ts"
import type { CursorError, Row } from "#compiler/plan/common.ts"
import type { Page, PageCursor, PageEdge } from "#compiler/plan/read.ts"

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
