import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { contextServes, selectArtifact } from "#compiler/program/context.ts"
import { query, v } from "#compiler/public/query.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { AutomaticTask, Task, TaskNote, Work } from "#test/support/fixtures/api/work.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * Evidence-context selection (program/context.ts): which of a template's two artifacts an execution runs.
 *
 * A template compiled for `snapshot` may rest on committed-snapshot evidence and runs its conservative artifact in a
 * `transaction` execution; one compiled for `transaction` rests on none and runs its optimized artifact in either. The
 * conservative artifact rests on no evidence, so it is one artifact whatever the context.
 *
 * The programs are planted: notes matches TaskNote to Task on TaskNote's deferred foreign key, which committed-snapshot
 * evidence removes and a transaction keeps; budgets attaches each budget's task, fused into one optimized statement
 * beside two conservative ones; the ordered tasks read as a page.
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

const contexts: Arr.NonEmptyReadonlyArray<TemplateContext> = ["snapshot", "transaction"]

const compiled = (program: unknown, context: TemplateContext, read: Read): QueryTemplate =>
	succeeded(compileTemplate(program, undefined, { ...testCompile, context, read }), "the template")

/** A program and one of its reads. */
const readGen: Gen<readonly [Program, Read]> = (source) => {
	const p = source.draw(element(programs))
	return [p, source.draw(element(p.reads))] as const
}

const caseGen: Gen<readonly [Program, Read, TemplateContext, TemplateContext]> = (source) => {
	const [p, read] = source.draw(readGen)
	return [p, read, source.draw(element(contexts)), source.draw(element(contexts))] as const
}

type SelectFeature =
	| "conservative"
	| "optimized"
	| `compiled for ${TemplateContext}, run in ${TemplateContext}`

describe("selectArtifact", () => {
	it.effect("runs the optimized artifact exactly where the template's context serves", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/program/context-select",
					draw: drawn(caseGen),
					literal: Formatter.format,
					coverage: required<SelectFeature>(
						[
							"conservative",
							"optimized",
							"compiled for snapshot, run in snapshot",
							"compiled for snapshot, run in transaction",
							"compiled for transaction, run in snapshot",
							"compiled for transaction, run in transaction"
						],
						{ cases: 80, sense: notesOnly }
					),
					kept: [],
					runs: 80,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([p, read, compiledFor, runIn], c) =>
					Effect.sync(() => {
						/**
						 * Every context admits what a transaction admits; a transaction admits no committed-snapshot evidence.
						 */
						const serves = compiledFor === "transaction" || runIn === "snapshot"
						assert.equal(contextServes(compiledFor, runIn), serves)
						const template = compiled(p.program, compiledFor, read)
						const selection = selectArtifact(template, runIn)
						if (serves) {
							assert.deepEqual(selection, { artifact: "optimized", statements: template.optimized })
							c.note("optimized")
						} else {
							assert.deepEqual(selection, {
								artifact: "conservative",
								statements: template.conservative
							})
							c.note("conservative")
						}
						c.note(`compiled for ${compiledFor}, run in ${runIn}`)
					})
			)
		)
	)
})

type TemplateFeature =
	| TemplateContext
	| Read
	| "a committed-snapshot certificate"
	| "several statements"

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
							"several statements"
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
									...(Math.max(template.optimized.length, template.conservative.length) > 1
										? (["several statements"] as const)
										: [])
								])
							)
							c.note(read)
						})
				)
			)
	)
})
