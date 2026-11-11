import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { query, v } from "#compiler/public/query.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { AutomaticTask, Task, TaskNote, Work } from "#test/support/fixtures/api/work.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * A template's execution context (program/compile.ts): a template compiled for `snapshot` may rest on committed-snapshot
 * evidence, one compiled for `transaction` rests on none, and the conservative lowering beside either rests on no
 * evidence, so it is one artifact whatever the context.
 *
 * The programs are planted: notes matches TaskNote to Task on TaskNote's deferred foreign key, which committed-snapshot
 * evidence removes and a transaction keeps; budgets attaches each budget's task, fused into the optimized program's one
 * relation beside the conservative program's two; the ordered tasks read as a page.
 */
const notes = query(Work).rule((r) => {
	const { task, note } = v(TaskNote, "taskNote")
	return r.match(TaskNote, { task, note }).match(Task, { id: task }).find({ task, note })
})

const budgets = query(Work)
	.rule((r) => {
		const { task, budget } = v(AutomaticTask, "automaticTask")
		return r.match(AutomaticTask, { task, budget }).find({ task, budget })
	})
	.attach(
		"owner",
		(parent) =>
			query(Work).rule((r) => {
				const { account, kind } = v(Task, "task")
				return r.match(Task, { id: parent.task, account, kind }).find({ account, kind })
			}),
		"option"
	)

const orderedTasks = query(Work)
	.rule((r) => {
		const { id, kind } = v(Task, "task")
		return r.match(Task, { id, kind }).find({ id, kind })
	})
	.orderBy(["id", "asc"])

type Read = "rows" | "page"

/** A planted program and the reads it is compiled for. */
interface Program {
	readonly name: string
	readonly program: unknown
	readonly reads: Arr.NonEmptyReadonlyArray<Read>
}

const programs: Arr.NonEmptyReadonlyArray<Program> = [
	{ name: "notes", program: notes, reads: ["rows"] },
	{ name: "budgets", program: budgets, reads: ["rows"] },
	{ name: "orderedTasks", program: orderedTasks, reads: ["rows", "page"] }
]

const compiled = (program: unknown, context: TemplateContext, read: Read): OracleTemplate =>
	succeeded(compileTemplate(program, undefined, { ...testCompile, context, read }), "the template")

/** A program and one of its reads. */
const readGen: Gen<readonly [Program, Read]> = (source) => {
	const p = source.draw(element(programs))
	return [p, source.draw(element(p.reads))] as const
}

type TemplateFeature =
	| TemplateContext
	| Read
	| "a committed-snapshot certificate"
	| "several relations"

describe("a template", () => {
	it.effect(
		"rests on committed-snapshot evidence only for a snapshot, and shares one conservative artifact",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/program/context-templates",
						generator: readGen,
						literal: Formatter.format,
						/** Every read of every program: four. */
						limit: 4,
						coverage: requiredInSpace<TemplateFeature>([
							"snapshot",
							"transaction",
							"rows",
							"page",
							"a committed-snapshot certificate",
							"several relations"
						]),
						caseHang
					},
					([p, read], c) =>
						Effect.sync(() => {
							const [snapshot, transaction] = [
								compiled(p.program, "snapshot", read),
								compiled(p.program, "transaction", read)
							]
							assert.deepEqual(
								Arr.filter(transaction.certificates, (x) => x.context === "committedSnapshot"),
								[]
							)
							if (Arr.some(snapshot.certificates, (x) => x.context === "committedSnapshot")) {
								c.note("a committed-snapshot certificate")
							}
							assert.deepEqual(
								Arr.map(transaction.conservative, (s) => s.sql),
								Arr.map(snapshot.conservative, (s) => s.sql)
							)
							c.noteAll(
								Arr.flatMap([snapshot, transaction], (template): ReadonlyArray<TemplateFeature> => [
									template.context,
									...(Math.max(
										flight(template.programs.optimized.roots).length,
										flight(template.programs.conservative.roots).length
									) > 1
										? (["several relations"] as const)
										: [])
								])
							)
							c.note(read)
						})
				)
			)
	)
})
