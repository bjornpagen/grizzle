import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { query, v } from "#compiler/public/query.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTemplate, type FixtureSchema, testCompile } from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { AutomaticTask, Task, TaskNote, Work } from "#test/support/fixtures/api/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import {
	type CaseSketch,
	caseSketchGen,
	resolveCase
} from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"

/**
 * A template's execution context (program/compile.ts): a template compiled for `snapshot` may rest on committed-snapshot
 * evidence, one compiled for `transaction` rests on none, and the conservative lowering beside either rests on no
 * evidence, so it is one artifact whatever the context.
 *
 * Over two arms of one representation, each weighted in the draw: generated public programs
 * (test/support/oracle/public), every query read compiled as rows and every ordered one as a page too; and the planted
 * programs, named cases that reach what the generator need not: notes matches TaskNote to Task on TaskNote's deferred
 * foreign key, which committed-snapshot evidence removes and a transaction keeps; budgets attaches each budget's task,
 * fused into the optimized program's one relation beside the conservative program's two; the ordered tasks read as a
 * page.
 *
 * - No committed-snapshot certificate: a template compiled for a transaction cites none.
 * - One conservative artifact: the conservative statements compiled for a transaction are the ones compiled for a
 *   snapshot, text for text (a differential between the two contexts).
 *
 * Oracle: the specification, a transaction's template rests on no committed-snapshot evidence, and the conservative
 * lowering reads no evidence at all.
 *
 * Features: rows, page, a committed-snapshot certificate, several relations, a generated program.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): context-transaction-snapshot-evidence, a transaction's template
 * compiled under committed-snapshot evidence; context-conservative-reads-context, the conservative lowering keyed by
 * the context.
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

/** A planted program, the reads it is compiled for, and the schema it reads. */
interface Planted {
	readonly name: string
	readonly program: unknown
	readonly reads: Arr.NonEmptyReadonlyArray<Read>
}

const planted: Arr.NonEmptyReadonlyArray<Planted> = [
	{ name: "notes", program: notes, reads: ["rows"] },
	{ name: "budgets", program: budgets, reads: ["rows"] },
	{ name: "orderedTasks", program: orderedTasks, reads: ["rows", "page"] }
]

/** A case: a planted program and one of its reads, or a generated public program. */
type Sketch =
	| { readonly kind: "planted"; readonly program: Planted; readonly read: Read }
	| { readonly kind: "generated"; readonly sketch: CaseSketch }

const sketchGen: Gen<Sketch> = weighted<Sketch>([
	[
		1,
		(source) => {
			const program = source.draw(element(planted))
			return { kind: "planted", program, read: source.draw(element(program.reads)) }
		}
	],
	[3, (source) => ({ kind: "generated", sketch: source.draw(caseSketchGen) })]
])

/** One read of one program over the schema it reads, `undefined` for a planted program's own. */
interface Compiled {
	readonly program: unknown
	readonly schema: FixtureSchema | undefined
	readonly read: Read
	readonly what: string
}

type TemplateFeature =
	| Read
	| "a committed-snapshot certificate"
	| "several relations"
	| "a generated program"

/** The template of a read under a context. */
const compiled = (c: Compiled, context: TemplateContext): OracleTemplate =>
	succeeded(
		compileTemplate(c.program, c.schema, { ...testCompile, context, read: c.read }),
		`${c.what} compiled for ${context}`
	)

/** The properties over one read, and the features it reaches. */
const holds = (c: Compiled, note: (feature: TemplateFeature) => void): void => {
	const snapshot = compiled(c, "snapshot")
	const transaction = compiled(c, "transaction")
	assert.deepEqual(
		Arr.filter(transaction.certificates, (x) => x.context === "committedSnapshot"),
		[],
		`${c.what}: a transaction's template cites committed-snapshot evidence`
	)
	assert.deepEqual(
		Arr.map(transaction.conservative, (s) => s.sql),
		Arr.map(snapshot.conservative, (s) => s.sql),
		`${c.what}: the conservative artifact differs between the contexts`
	)
	if (Arr.some(snapshot.certificates, (x) => x.context === "committedSnapshot")) {
		note("a committed-snapshot certificate")
	}
	if (
		Arr.some(
			[snapshot, transaction],
			(t) =>
				Math.max(
					flight(t.programs.optimized.roots).length,
					flight(t.programs.conservative.roots).length
				) > 1
		)
	) {
		note("several relations")
	}
	note(c.read)
}

describe("a template", () => {
	it.effect(
		"rests on committed-snapshot evidence only for a snapshot, and shares one conservative artifact",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/program/context-templates",
						draw: drawn(sketchGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a transaction's template rests on no committed-snapshot evidence, and the conservative lowering on none at all"
						},
						coverage: required<TemplateFeature>(
							[
								"rows",
								"page",
								"a committed-snapshot certificate",
								"several relations",
								"a generated program"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, k) =>
						Effect.sync(() => {
							if (sketch.kind === "planted") {
								holds(
									{
										program: sketch.program.program,
										schema: undefined,
										read: sketch.read,
										what: `${sketch.program.name} as ${sketch.read}`
									},
									k.note
								)
								return
							}
							const c = k.draw(resolveCase(sketch.sketch))
							const built = buildSchema(c.schema)
							k.note("a generated program")
							for (const [i, read] of c.reads.entries()) {
								if (read.kind !== "query") {
									continue
								}
								const program = buildRoot(built, built.schema, read.query)
								const reads: ReadonlyArray<Read> =
									read.query.delivery.kind === "ordered" ? ["rows", "page"] : ["rows"]
								for (const as of reads) {
									holds(
										{
											program,
											schema: built.schema,
											read: as,
											what: `read ${i} as ${as}\n${printCase(c)}`
										},
										k.note
									)
								}
							}
						})
				)
			)
	)
})
