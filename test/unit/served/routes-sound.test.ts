/**
 * A read's routes never miss a change that alters its answer: every committed change of a stored relation's row that
 * changes what a read answers under its binding is one the read's footprint routes to it. Over-approximation is the
 * routes' licence (a wake-up that changes nothing re-runs to an empty diff and sends nothing); a change they miss is a
 * subscriber left on a stale answer.
 *
 * A row's change is its removal or its addition: an update of a row is its old row's removal and its new row's
 * addition, which touches both rows' values, so a read whose answer an update changes changes by one of the two. So
 * over generated public cases (test/support/oracle/public), each read of a query compiled as a workload's program over
 * the case's schema, as generate plans it (program/workload/compile.ts compileWorkload), its footprint read off the
 * plan, and every fact of the case: when the reference's answer to the read over the case's facts (meaning.ts
 * expectedQuery) and over them without the fact differ (answer.ts answerEquivalence), the fact's relation is in the
 * footprint, and it routes table-wide or some routed field of the fact holds the value the read binds the field's
 * parameter to. That covers the fact's removal from the case and its addition to the case without it.
 *
 * A read the plan compiles over the case's schema runs on full roles, whose relations are the schema's, whole, so its
 * answer on every role it runs on is the reference's here; a role's own filters only narrow what it reads, and routes
 * over-approximating the full read over-approximate the narrowed one.
 *
 * Plants (~/.cache/grizzle-release/LIVE-ROUTES/plants): route-narrowed.patch routes a table its program reads table-wide
 * by its first column under the program's first parameter; route-through-take.patch lets a take pass what its consumers
 * read to its input, so a filter above a take routes the rows it ranks.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Result as Answered, Array as Arr, Effect, Formatter, Option } from "effect"
import type { Footprint } from "#compiler/logical/routes.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { type Answer, answerEquivalence, shapeOf } from "#test/support/oracle/public/answer.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { expectedQuery } from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	deliveredOrder,
	type ProgramCase,
	type ProgramRead,
	type StoredFact
} from "#test/support/oracle/public/program.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { equal, literalOf } from "#test/support/oracle/reference/values.ts"

type Feature =
	| "a fact a routed read's answer changes by"
	| "a fact a table-wide read's answer changes by"
	| "a fact of a routed table no answer changes by"

type QueryRead = Extract<ProgramRead, { readonly kind: "query" }>

const loginName = "app"
const programName = "read"

/** A read's footprint as generate plans it: the read a workload's one program over the case's schema. */
const footprintOf = (c: ProgramCase, read: QueryRead): Footprint => {
	const built = buildSchema(c.schema)
	const plan = succeeded(
		compileTestWorkload(
			[
				{
					login: loginName,
					workloads: [
						workload(built.schema, { [programName]: buildRoot(built, built.schema, read.query) })
					]
				}
			],
			built.schema,
			testCompile
		),
		"the read's workload plan"
	)
	return defined(
		plan.footprints.get(loginName)?.get(programName),
		"the footprint of the read, the plan's one program"
	)
}

/** The reference's answer to a read, none where the reference declines the read altogether. */
const answerOf = (c: ProgramCase, read: QueryRead): Answer | undefined => {
	const answered = Answered.try(() => expectedQuery(c, read, unobserved))
	return Answered.isSuccess(answered) ? answered.success : undefined
}

/** The case with `fact` of `relation` removed. */
const without = (c: ProgramCase, relation: string, fact: StoredFact): ProgramCase => ({
	...c,
	facts: new Map(
		Arr.map([...c.facts], ([name, facts]) =>
			name === relation ? [name, Arr.filter(facts, (f) => f !== fact)] : [name, facts]
		)
	)
})

/**
 * Whether `fact` of `relation` is a change the footprint routes to the read: its relation is a footprint table, read
 * table-wide or with some routed field whose value in the fact is the value the read binds its parameter to.
 */
const routed = (
	c: ProgramCase,
	read: QueryRead,
	footprint: Footprint,
	relation: string,
	fact: StoredFact
): boolean => {
	const routes = footprint.tables.get(relation)
	if (routes === undefined) {
		return false
	}
	if (routes.size === 0) {
		return true
	}
	const stored = defined(
		Arr.findFirst(c.schema.relations, (r) => r.name === relation).pipe(Option.getOrUndefined),
		`the stored relation ${relation}`
	)
	return Arr.some([...routes], ([name, param]) => {
		const bound = Arr.findFirst(read.params, (p) => p.name === param).pipe(Option.getOrUndefined)
		return Arr.some([...stored.fields.entries()], ([at, field]) => {
			const value = fact[at]
			return (
				field.name === name &&
				value !== undefined &&
				bound !== undefined &&
				equal(literalOf(value.literal, field.type), literalOf(bound.value, field.type), field.type)
			)
		})
	})
}

const sound = (c: ProgramCase, note: (feature: Feature) => void): void => {
	const printed = () => printCase(c)
	for (const read of c.reads) {
		if (read.kind !== "query") {
			continue
		}
		const before = answerOf(c, read)
		if (before === undefined) {
			continue
		}
		const footprint = footprintOf(c, read)
		const same = answerEquivalence(shapeOf(read.query), Option.isSome(deliveredOrder(read.query)))
		for (const [relation, facts] of c.facts) {
			for (const fact of facts) {
				const after = answerOf(without(c, relation, fact), read)
				const changes = after !== undefined && Option.isSome(same(before, after))
				const routes = footprint.tables.get(relation)
				if (changes) {
					assert.ok(
						routed(c, read, footprint, relation, fact),
						`removing ${Formatter.format(Arr.map(fact, (v) => v.literal))} from ${relation} changes the read's answer, and its routes ${Formatter.format(routes === undefined ? "none" : [...routes])} miss it\n${printed()}`
					)
					note(
						routes !== undefined && routes.size > 0
							? "a fact a routed read's answer changes by"
							: "a fact a table-wide read's answer changes by"
					)
				} else if (routes !== undefined && routes.size > 0) {
					note("a fact of a routed table no answer changes by")
				}
			}
		}
	}
}

describe("a read's routes", () => {
	it.effect("reach every change of a row that alters the read's answer", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the reference's answer over the case's facts with and without each fact (meaning.ts expectedQuery)"
					},
					suite: "unit/served/routes-sound",
					draw: drawn(caseSketchGen),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"a fact a routed read's answer changes by",
							"a fact a table-wide read's answer changes by",
							"a fact of a routed table no answer changes by"
						],
						{ cases: 60, sense: notesOnly }
					),
					kept: [],
					runs: 60,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(sketch, notes) => Effect.sync(() => sound(notes.draw(resolveCase(sketch)), notes.note))
			)
		)
	)
})
