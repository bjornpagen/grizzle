import { Result } from "effect"
import { toResult } from "#adapter/engine.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isRecord } from "#compiler/core/record.ts"
import {
	compilePage,
	type PageArtifact,
	type PageTemplate,
	statedOrderOf
} from "#compiler/lower/shapes/page/compile.ts"
import { type QueryTemplate, queryInput } from "#compiler/program/compile.ts"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { compileTemplate, type TestCompileOptions, testArtifacts } from "#test/support/compile.ts"
import { conservativePage } from "#test/support/conservative.ts"

const Title = str.regex("^.+$", "su")
const Level = closed("Level", ["Low", "High"])
export const Task = relation(
	"Task",
	{ id: uuid, account: uuid, priority: pg.integer, title: Title },
	["id"]
)
const NoteText = str.regex("^[a-z0-9 ]{1,40}$", "u")
const Note = relation("Note", { task: uuid, note: NoteText }, ["task", "note"])
const Flag = relation("Flag", { task: uuid, level: closedId(Level) }, ["task"])
export const Paging = schema("Paging", { Level, Task, Note, Flag }, [
	contained(on(Note, "task"), on(Task, "id")),
	contained(on(Flag, "task"), on(Task, "id"))
])

const tasksForAccount = query(Paging).rule((r) => {
	const { id, account, priority, title } = v(Task, "task")
	return r
		.match(Task, { id, account, priority, title })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id, priority, title })
})

/** Priority descending, the retained id appended ascending; a mixed-direction seek. */
export const priorityDescendingTasks = tasksForAccount.orderBy(["priority", "desc"])
/** Every key descending: one native row comparison. */
export const descendingTasks = tasksForAccount.orderBy(["priority", "desc"], ["id", "desc"])
/** Every key ascending. */
export const ascendingTasks = tasksForAccount.orderBy(["priority", "asc"])

/** A keyless projection whose equal titles collapse into one answer: the order is the title itself. */
export const titles = query(Paging)
	.rule((r) => {
		const { account, title } = v(Task, "task")
		return r
			.match(Task, { account, title })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ title })
	})
	.orderBy(["title", "desc"])

/** A grouped result: the task count per priority of one account. */
export const priorityCounts = query(Paging)
	.rule((r) => {
		const { id, account, priority } = v(Task, "task")
		return r
			.match(Task, { id, account, priority })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ priority, tasks: r.count() })
	})
	.orderBy(["tasks", "desc"])

/** Each task of one account with its notes attached. */
export const tasksWithNotes = query(Paging)
	.rule((r) => {
		const { id, account, priority } = v(Task, "task")
		return r
			.match(Task, { id, account, priority })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ id, priority })
	})
	.attach(
		"notes",
		(parent) =>
			query(Paging).rule((r) => {
				const { note } = v(Note, "note")
				return r.match(Note, { task: parent.id, note }).find({ note })
			}),
		"array"
	)
	.orderBy(["priority", "asc"])

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
			.where(r.eq(account, r.param("account", uuid)))
			.find({ level: Level.handle("High"), id, priority })
	})
	.rule((r) => {
		const { id, account, title } = v(Task, "task")
		return r
			.match(Task, { id, account, title })
			.match(Flag, { task: id, level: "Low" })
			.where(r.eq(account, r.param("account", uuid)))
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
			.where(r.eq(account, r.param("account", uuid)))
			.find({ level: Level.handle("High"), id, priority, title })
	})
	.rule((r) => {
		const { id, account, title } = v(Task, "task")
		return r
			.match(Task, { id, account, title })
			.match(Flag, { task: id, level: "Low" })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ level: Level.handle("Low"), id, title })
	})
	.orderBy(["title", "asc"])

/**
 * Boundary values: a double precision with -0, NaN and the infinities, an exact numeric, a bigint
 * at its extremes and text beyond the BMP, each the leading order field of one query.
 */
const Label = str.regex("^.*$", "su")
export const Measure = relation(
	"Measure",
	{ id: uuid, x: pg.float8, amount: pg.numeric(161, 40), big: pg.bigint, label: Label },
	["id"]
)
export const Measures = schema("Measures", { Measure }, [])

const measures = query(Measures).rule((r) => {
	const { id, x, amount, big, label } = v(Measure, "measure")
	return r.match(Measure, { id, x, amount, big, label }).find({ id, x, amount, big, label })
})
export const byX = measures.orderBy(["x", "asc"])
export const byXDesc = measures.orderBy(["x", "desc"])
export const byAmount = measures.orderBy(["amount", "desc"], ["id", "asc"])
export const byBig = measures.orderBy(["big", "asc"], ["id", "desc"])
export const byLabel = measures.orderBy(["label", "asc"])
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
		const artifacts = yield* toResult(
			testArtifacts(isRecord(ordered) ? ordered["schema"] : undefined, options)
		)
		const { desc } = yield* toResult(queryInput(ordered))
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
