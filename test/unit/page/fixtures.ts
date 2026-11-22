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
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
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
			checked: template.programs.checked,
			stated,
			optimized: template.programs.optimized,
			names: artifacts.names
		}
		const page = yield* toResult(compilePage(input))
		const baseline = yield* toResult(conservativePage(input, page))
		return { query: template, page, baseline }
	})
