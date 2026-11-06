import type { Effect, Option } from "effect"
import type { CursorError, ReadError } from "#index.ts"
import {
	type Db,
	type Page,
	type PageCursor,
	type PageEdge,
	type PageInfo,
	type Compiled,
	pg,
	query,
	relation,
	role,
	schema,
	str,
	type Uuid,
	uuid,
	v
} from "#index.ts"
import type { Equals, Expect, IsAssignable, Not } from "#test/types/page/support.ts"

/**
 * The page types over an ordered task list. Typechecked, never
 * executed. Everything is imported from the package root, so the public route is what is tested. Every
 * `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 */
export const Title = str.regex("^.+$", "su")
export const Task = relation(
	"Task",
	{ id: uuid, account: uuid, priority: pg.integer, title: Title },
	["id"]
)
export const Work = schema("Work", { Task }, [])
export const Reader = role(Work, "reader", Work.relations)
export const tasksForAccount = query(Work).rule((r) => {
	const { id, account, priority, title } = v(Task, "task")
	return r
		.match(Task, { id, account, priority, title })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id, priority, title })
})
export const orderedTasks = tasksForAccount.orderBy(["priority", "desc"])
export const byTitle = tasksForAccount.orderBy(["title", "asc"])

declare const db: Db<typeof Reader, unknown>
type Ordered = typeof orderedTasks
const accountId = "0193d8f2-7c1e-7000-8000-0000000000a1"

/** A page is Page<Head, the ordered query>, failing with ReadError or CursorError. */
export const firstPage = db.page(orderedTasks, { account: accountId }, { first: 25 })
type FirstPage = Effect.Success<typeof firstPage>
export type FirstPageError = Expect<Equals<Effect.Error<typeof firstPage>, ReadError | CursorError>>
export type FirstPageShape = Expect<
	Equals<FirstPage, Page<FirstPage["edges"][number]["node"], Ordered>>
>

export type EdgeShape = Expect<
	Equals<FirstPage["edges"][number], PageEdge<FirstPage["edges"][number]["node"], Ordered>>
>
export type EdgeCursor = Expect<Equals<FirstPage["edges"][number]["cursor"], PageCursor<Ordered>>>
export type Info = Expect<Equals<FirstPage["pageInfo"], PageInfo<Ordered>>>
export type StartCursor = Expect<
	Equals<FirstPage["pageInfo"]["startCursor"], Option.Option<PageCursor<Ordered>>>
>
export type Flags = Expect<Equals<FirstPage["pageInfo"]["hasNextPage"], boolean>>
/** The node is the query's heading. */
export type NodeId = Expect<Equals<FirstPage["edges"][number]["node"]["id"], Uuid>>
export type NodePriority = Expect<Equals<FirstPage["edges"][number]["node"]["priority"], number>>

/**
 * A cursor is an opaque branded string: a string is not one, and one query's cursor is still accepted by another's
 * page at the type level, where only the runtime fingerprint is authoritative.
 */
declare const cursor: PageCursor<Ordered>
declare const titleCursor: PageCursor<typeof byTitle>
export type CursorIsString = Expect<IsAssignable<PageCursor<Ordered>, string>>
export type StringIsNoCursor = Expect<Not<IsAssignable<string, PageCursor<Ordered>>>>

/** The four shapes. */
export const after = db.page(orderedTasks, { account: accountId }, { first: 25, after: cursor })
export const last = db.page(orderedTasks, { account: accountId }, { last: 10 })
export const before = db.page(orderedTasks, { account: accountId }, { last: 10, before: cursor })
export const otherQuerysCursor = db.page(
	orderedTasks,
	{ account: accountId },
	{ first: 2, after: titleCursor }
)

/** Everything else is refused at the type level. */
// @ts-expect-error -- TS2345: mixed directions
export const mixed = db.page(orderedTasks, { account: accountId }, { first: 1, last: 1 })
export const firstBefore = db.page(
	orderedTasks,
	{ account: accountId },
	// @ts-expect-error -- TS2345: an anchor of the other direction
	{ first: 1, before: cursor }
)
export const bothAnchors = db.page(
	orderedTasks,
	{ account: accountId },
	// @ts-expect-error -- TS2345: both anchors
	{ first: 1, after: cursor, before: cursor }
)

export const undefinedCursor = db.page(
	orderedTasks,
	{ account: accountId },
	// @ts-expect-error -- TS2379: an explicitly supplied undefined cursor (exactOptionalPropertyTypes)
	{ first: 1, after: undefined }
)
// @ts-expect-error -- TS2322: an explicitly supplied null cursor
export const nullCursor = db.page(orderedTasks, { account: accountId }, { last: 1, before: null })
// @ts-expect-error -- TS2322: a plain string is no cursor
export const plainString = db.page(orderedTasks, { account: accountId }, { first: 1, after: "abc" })
// @ts-expect-error -- TS2345: no default page size
export const noSize = db.page(orderedTasks, { account: accountId }, {})
// @ts-expect-error -- TS2345 refusal: page needs an ordered query
export const unordered = db.page(tasksForAccount, { account: accountId }, { first: 1 })
// @ts-expect-error -- TS2322: the parameters are the query's
export const wrongParams = db.page(orderedTasks, { account: 1 }, { first: 1 })

/** A compiled ordered query's page keeps the heading and the parameters, its cursors the query's. */
declare const compiled: Compiled<
	typeof Work,
	typeof orderedTasks,
	FirstPage["edges"][number]["node"]
>
export const compiledPage = compiled.page({ account: accountId }, { last: 3, before: cursor })
export type CompiledPage = Expect<
	Equals<Effect.Error<typeof compiledPage>, ReadError | CursorError>
>
// @ts-expect-error -- TS2345: mixed directions on a compiled handle
export const compiledMixed = compiled.page({ account: accountId }, { last: 3, first: 3 })
