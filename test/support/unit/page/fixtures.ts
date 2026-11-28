import { Result } from "effect"
import { toResult } from "#adapter/engine.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	compilePage,
	type PageArtifact,
	type PageTemplate,
	statedOrderOf
} from "#compiler/lower/shapes/page/compile.ts"
import { type QueryTemplate, querySchema } from "#compiler/program/compile.ts"
import { queryInput } from "#compiler/program/input.ts"
import { bytes, closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { costChosen } from "#compiler/sql/emit.ts"
import { compileTemplate, inputArtifacts, type TestCompileOptions } from "#test/support/compile.ts"
import { conservativePage } from "#test/support/conservative.ts"
import { Id } from "#test/support/ids.ts"

const Title = str.regex("^.+$", "su")
const Level = closed.ordered("Level", ["Low", "High"])
const Task = relation("Task", { id: Id, account: Id, priority: pg.integer, title: Title }, ["id"])
const NoteText = str.regex("^[a-z0-9 ]{1,40}$", "u")
const Note = relation("Note", { task: Id, note: NoteText }, ["task", "note"])
const Flag = relation("Flag", { task: Id, level: closedId(Level) }, ["task"])
export const Paging = schema(
	"Paging",
	[Level, Task, Note, Flag],
	[contained(on(Note, "task"), on(Task, "id")), contained(on(Flag, "task"), on(Task, "id"))]
)

const tasksForAccount = query(Paging).rule((r) => {
	const { id, account, priority, title } = v(Task, "task")
	return r
		.match(Task, { id, account, priority, title })
		.where(r.eq(account, r.param("account", Id)))
		.find({ id, priority, title })
})

/** Every key ascending. */
export const ascendingTasks = tasksForAccount.orderBy(["priority", "asc"])

/**
 * A union of two heading groups told apart by the roster-typed level: flagged tasks with
 * their priority, and flagged tasks with their title.
 */
export const flagged = query(Paging)
	.rule((r) => {
		const { id, account, priority } = v(Task, "task")
		return r
			.match(Task, { id, account, priority })
			.match(Flag, { task: id, level: "High" })
			.where(r.eq(account, r.param("account", Id)))
			.find({ level: Level.handle("High"), id, priority })
	})
	.rule((r) => {
		const { id, account, title } = v(Task, "task")
		return r
			.match(Task, { id, account, title })
			.match(Flag, { task: id, level: "Low" })
			.where(r.eq(account, r.param("account", Id)))
			.find({ level: Level.handle("Low"), id, title })
	})
	.orderBy(["id", "desc"])

/**
 * Two heading groups that share their title, ordered by it: the discriminant comes right after the stated title and
 * before the arm key.
 */
export const flaggedByTitle = query(Paging)
	.rule((r) => {
		const { id, account, priority, title } = v(Task, "task")
		return r
			.match(Task, { id, account, priority, title })
			.match(Flag, { task: id, level: "High" })
			.where(r.eq(account, r.param("account", Id)))
			.find({ level: Level.handle("High"), id, priority, title })
	})
	.rule((r) => {
		const { id, account, title } = v(Task, "task")
		return r
			.match(Task, { id, account, title })
			.match(Flag, { task: id, level: "Low" })
			.where(r.eq(account, r.param("account", Id)))
			.find({ level: Level.handle("Low"), id, title })
	})
	.orderBy(["title", "asc"])

/**
 * The flagged union's two heading groups, the low one holding its id again as aid, a field of that group alone whose
 * name precedes id's, unordered: the id both groups hold, with the level, keys the union, so every group is ordered
 * by the union's key (logical/order.ts completeGroups), though the low group's own completion would choose its aid.
 */
const flaggedWithAid = query(Paging)
	.rule((r) => {
		const { id, priority } = v(Task, "task")
		return r
			.match(Task, { id, priority })
			.match(Flag, { task: id, level: "High" })
			.find({ level: Level.handle("High"), id, priority })
	})
	.rule((r) => {
		const { id, title } = v(Task, "task")
		return r
			.match(Task, { id, title })
			.match(Flag, { task: id, level: "Low" })
			.find({ level: Level.handle("Low"), aid: id, id, title })
	})

/** flaggedWithAid read as it is: its rows in its canonical order, the user stating none. */
export const flaggedWithAidRows = flaggedWithAid

/** flaggedWithAid ordered by its level alone, which the union's key completes. */
export const flaggedWithAidByLevel = flaggedWithAid.orderBy(["level", "asc"])

/** The ids of flaggedWithAidByLevel's first two rows, its take read inside another statement. */
export const flaggedWithAidFirstIds = query(Paging).rule((r) => {
	const first = flaggedWithAidByLevel.take(2)
	const { id } = v(first, "first")
	return r.match(first, { id }).find({ id })
})

const Attachment = relation("Attachment", { id: Id, task: Id, data: bytes }, ["id"])

/** Paging with each task's attachments, whose data is bytes. */
const Attaching = schema(
	"Attaching",
	[Level, Task, Note, Flag, Attachment],
	[contained(on(Attachment, "task"), on(Task, "id"))]
)

/**
 * The tasks' attachments' data with its task, a projection that keeps no key: its order completes by its whole heading,
 * the bytes breaking ties, as PostgreSQL orders bytea.
 */
export const attachedData = query(Attaching).rule((r) => {
	const { task, data } = v(Attachment, "attachment")
	return r.match(Attachment, { task, data }).find({ task, data })
})

/** attachedData ordered by its task, a page's order, which its data completes. */
export const attachedDataByTask = attachedData.orderBy(["task", "asc"])

/**
 * Two heading groups whose shared field, the level, keys none of their rows: high-flagged tasks' attachments' data,
 * keyless, so its group's order completes by its data; and low-flagged tasks' titles. Its first two by level, ordered
 * again by level descending: the runtime orders the kept rows again itself.
 */
export const attachedOrTitledReordered = query(Attaching)
	.rule((r) => {
		const { id } = v(Task, "task")
		const { data } = v(Attachment, "attachment")
		return r
			.match(Flag, { task: id, level: "High" })
			.match(Attachment, { task: id, data })
			.find({ level: Level.handle("High"), data })
	})
	.rule((r) => {
		const { id, title } = v(Task, "task")
		return r
			.match(Task, { id, title })
			.match(Flag, { task: id, level: "Low" })
			.find({ level: Level.handle("Low"), title })
	})
	.orderBy(["level", "asc"])
	.take(2)
	.orderBy(["level", "desc"])

export interface CompiledPage {
	readonly query: QueryTemplate
	readonly page: PageTemplate
	/** The page oracle's conservative artifact of the same page (conservativePage). */
	readonly baseline: PageArtifact
}

/**
 * The page template of an ordered query: its query template compiled for a page, then the page compiler over the
 * stated order of its Description.
 * The ordered query's own schema is the one it is compiled against.
 *
 * The pagination fixture over the public API, and helpers that compile a page template the way the page
 * runtime does: compileQuery with read "page" (program/compile.ts), then compilePage over the template's programs
 * with the schema's physical names (program/schema.ts).
 */
export const compiledPageResult = (
	ordered: unknown,
	options: TestCompileOptions
): Result.Result<CompiledPage, CompileError> =>
	Result.gen(function* () {
		const template = yield* toResult(
			compileTemplate(ordered, undefined, { ...options, read: "page" })
		)
		const parsed = yield* toResult(queryInput(ordered))
		const source = yield* toResult(querySchema(parsed, undefined))
		const artifacts = yield* toResult(inputArtifacts(source.schema, options))
		const desc = parsed.desc
		const stated = yield* toResult(statedOrderOf(desc, SourceLoc("query", [])))
		const input = {
			binding: costChosen,
			checked: template.programs.checked,
			stated,
			optimized: template.programs.optimized,
			names: artifacts.names
		}
		const page = yield* toResult(compilePage(input))
		const baseline = yield* toResult(conservativePage(input, page))
		return { query: template, page, baseline }
	})
