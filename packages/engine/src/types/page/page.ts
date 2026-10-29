import type { Brand, Option } from "effect"

/**
 * The query a cursor was made for exists only as a type: an optional member under a declared symbol, which no runtime
 * cursor holds.
 */
declare const PageCursorQuery: unique symbol

/**
 * An opaque string at application boundaries. The brand helps prevent mixing, but queries with identical TypeScript
 * shapes can still differ semantically; the runtime fingerprint check is authoritative.
 */
export type PageCursor<Q> = string & Brand.Brand<"PageCursor"> & { readonly [PageCursorQuery]?: Q }

/**
 * The four accepted request shapes, exactly: { first }, { first, after }, { last }, { last, before }.
 * Each variant names the control properties it may not carry as optional `never`, so a mixed direction ({ first, last }),
 * both anchors, or an anchor of the other direction ({ first, before }) is a type error, and under
 * exactOptionalPropertyTypes an explicitly supplied undefined is one too: an omitted control property is genuinely
 * absent, and a supplied cursor is a cursor. There is no default page size. The runtime
 * checks the same shapes again for a caller the types do not reach (packages/grizzle/src/adapter/page/request.ts).
 */
export type PageRequest =
	| {
			readonly first: number
			readonly after?: never
			readonly last?: never
			readonly before?: never
	  }
	| {
			readonly first: number
			readonly after: PageCursor<unknown>
			readonly last?: never
			readonly before?: never
	  }
	| {
			readonly last: number
			readonly before?: never
			readonly first?: never
			readonly after?: never
	  }
	| {
			readonly last: number
			readonly before: PageCursor<unknown>
			readonly first?: never
			readonly after?: never
	  }

/**
 * One delivered tuple and the cursor of its boundary, usable with either after or before on the same ordered query
 * and inputs.
 */
export interface PageEdge<A, Q> {
	readonly node: A
	readonly cursor: PageCursor<Q>
}

/**
 * What a page says about its neighbours in the snapshot it read: the edge cursors of its first and
 * last delivered edges, Option.none for an empty page, and the exact directional existence flags.
 */
export interface PageInfo<Q> {
	readonly startCursor: Option.Option<PageCursor<Q>>
	readonly endCursor: Option.Option<PageCursor<Q>>
	readonly hasPreviousPage: boolean
	readonly hasNextPage: boolean
}

/**
 * Cursor pagination types. packages/grizzle/src/adapter/page implements the page runtime; these are its public types.
 *
 * One page of an ordered query: its edges, each with its cursor, and the page info.
 */
export interface Page<A, Q> {
	readonly edges: ReadonlyArray<PageEdge<A, Q>>
	readonly pageInfo: PageInfo<Q>
}
