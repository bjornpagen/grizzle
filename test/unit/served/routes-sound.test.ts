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
 * A read through a query entry is held to the same property, constructed in every case: a role whose query entry
 * `Seen` holds each fact of one of the case's relations that holds facts, and its read of `Seen`'s facts whose drawn
 * field is a parameter, bound to that field of one of the relation's facts. Its routes are its plan's, which reads the
 * entry's definition inlined (program/workload/compile.ts workloadQueryRead), and its answer the reference's over
 * that same inlined IR (reference/evaluate.ts Reference, deliver.ts expectedStatements), the case's facts with and
 * without each fact: every fact whose removal changes the answer is one the routes reach.
 *
 * Plants (~/.cache/grizzle-release/LIVE-ROUTES/plants): route-narrowed.patch routes a table its program reads table-wide
 * by its first column under the program's first parameter; route-through-take.patch lets a take pass what its consumers
 * read to its input, so a filter above a take routes the rows it ranks.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Result as Answered, Array as Arr, Effect, Formatter, Option } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Footprint } from "#compiler/logical/routes.ts"
import { workloadQueryRead } from "#compiler/program/workload/compile.ts"
import { workload, workloadState } from "#compiler/program/workload/value.ts"
import { role, wholeEntriesOf } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	compileTestWorkload,
	inputArtifacts,
	schemaInputOf,
	testCompile
} from "#test/support/compile.ts"
import { sameIdentity } from "#test/support/kernel/identity.ts"
import { caseHang } from "#test/support/limits.ts"
import { type Answer, answerEquivalence, shapeOf } from "#test/support/oracle/public/answer.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { expectedQuery, factsOf, referenceSchema } from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	deliveredOrder,
	type ProgramCase,
	type ProgramField,
	type ProgramRead,
	type Stored,
	type StoredFact
} from "#test/support/oracle/public/program.ts"
import { expectedStatements } from "#test/support/oracle/reference/deliver.ts"
import { Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { equal, literalOf, type Row, valueIdentity } from "#test/support/oracle/reference/values.ts"

type Feature =
	| "a fact a routed read's answer changes by"
	| "a fact a table-wide read's answer changes by"
	| "a fact of a routed table no answer changes by"

type WorldFeature =
	| "a fact a read through a query entry changes by"
	| "a fact a read through a query entry does not change by"

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
 * Whether `fact` of `relation` is a change the footprint routes to a read binding `params`: its relation is a footprint
 * table, read table-wide or with some routed field whose value in the fact is the value its parameter is bound to.
 */
const routed = (
	c: ProgramCase,
	params: ReadonlyArray<{ readonly name: string; readonly value: TypedLiteral }>,
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
		const bound = Arr.findFirst(params, (p) => p.name === param).pipe(Option.getOrUndefined)
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
						routed(c, read.params, footprint, relation, fact),
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

/** The parameter a read through `Seen` binds its drawn field to. */
const seenParam = "seen"

/**
 * A read through a query entry (see the header): over the case's relation `stored`, the role `seer` whose entry `Seen`
 * holds each of its facts, and the read of `Seen`'s facts whose field `field` is the parameter `seen`, the read's one
 * program of a workload over the role.
 */
const seenWorkload = (c: ProgramCase, stored: Stored, field: ProgramField) => {
	const built = buildSchema(c.schema)
	const read = built.relation(stored)
	const taken = new Set(Arr.map(c.schema.relations, (r) => r.name))
	const seenName = Arr.findFirst(["Seen", "Seen0", "Seen00"], (n) => !taken.has(n)).pipe(
		Option.getOrElse(() => `Seen${taken.size}`)
	)
	const seen: EntryValue = queryOver(built.schema).rule((r: RuleValue) => {
		const fact = varsOver(read, "fact")
		return r.match(read, fact).find(fact)
	})
	const seer = role(built.schema, "seer", { ...wholeEntriesOf(built.schema), [seenName]: seen })
	const entry = defined(seer.relations[seenName], `the role's entry ${seenName}`)
	const program = queryOver(seer).rule((r: RuleValue) => {
		const fact = varsOver(entry, "fact")
		return r
			.match(entry, fact)
			.where(r.eq(fact[field.name], r.param(seenParam, read.fields[field.name])))
			.find(fact)
	})
	return { built, w: workload(seer, { [programName]: program }) }
}

/** A delivered row's identity: each value's at its column's type. */
const rowIdentity = (
	row: Row,
	heading: ReadonlyArray<{ readonly type: Parameters<typeof valueIdentity>[1] }>
) =>
	Arr.flatMap(row, (v, i) => {
		const column = heading[i]
		return column === undefined ? [] : valueIdentity(v, column.type)
	})

/** Whether two sets of rows of one heading hold the same rows. */
const sameRows = (
	a: ReadonlyArray<Row>,
	b: ReadonlyArray<Row>,
	heading: Parameters<typeof rowIdentity>[1]
): boolean =>
	a.length === b.length &&
	Arr.every(a, (x) =>
		Arr.some(b, (y) => sameIdentity(rowIdentity(x, heading), rowIdentity(y, heading)))
	)

const worldSound = (
	c: ProgramCase,
	stored: Stored,
	field: ProgramField,
	bound: TypedLiteral,
	note: (feature: WorldFeature) => void
): void => {
	const printed = () =>
		`${printCase(c)}\nthrough Seen over ${stored.name}, ${field.name} = ${Formatter.format(bound)}`
	const { built, w } = seenWorkload(c, stored, field)
	const plan = succeeded(
		compileTestWorkload([{ login: loginName, workloads: [w] }], built.schema, testCompile),
		"the entry read's workload plan"
	)
	const footprint = defined(
		plan.footprints.get(loginName)?.get(programName),
		"the footprint of the entry read"
	)
	const state = defined(workloadState(w), "the entry read's workload")
	const desc = defined(state.desc.programs[programName], "the entry read's program")
	if (desc.kind !== "query") {
		return
	}
	const ir = succeeded(
		workloadQueryRead(
			desc.query,
			state.schema,
			succeeded(inputArtifacts(schemaInputOf(built.schema), testCompile), "the case's artifacts")
		),
		"the entry read's inlined IR"
	)
	const answer = (facts: ProgramCase) => {
		const run = Answered.try(() =>
			Arr.findFirst(
				expectedStatements(
					Reference.of(ir.dag, {
						schema: referenceSchema(c.schema),
						facts: factsOf(facts),
						params: { [seenParam]: { kind: "scalar", type: field.type, value: bound } },
						observer: unobserved
					}),
					ir.dag.roots[0]
				),
				(statement) => statement.role === "main"
			).pipe(Option.getOrUndefined)
		)
		return Answered.isSuccess(run) ? run.success : undefined
	}
	const before = answer(c)
	if (before === undefined) {
		return
	}
	for (const [relation, facts] of c.facts) {
		for (const fact of facts) {
			const after = answer(without(c, relation, fact))
			if (after === undefined) {
				continue
			}
			if (sameRows(before.rows, after.rows, before.heading)) {
				note("a fact a read through a query entry does not change by")
				continue
			}
			note("a fact a read through a query entry changes by")
			assert.ok(
				routed(c, [{ name: seenParam, value: bound }], footprint, relation, fact),
				`removing ${Formatter.format(Arr.map(fact, (v) => v.literal))} from ${relation} changes the read through Seen, and its routes ${Formatter.format([...(footprint.tables.get(relation) ?? [])])} miss it\n${printed()}`
			)
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

	it.effect("reach every change of a row that alters a read through a query entry", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the reference's answer over the read's inlined IR, the case's facts with and without each fact"
					},
					suite: "unit/served/routes-sound/world",
					draw: drawn(caseSketchGen),
					literal: Formatter.format,
					coverage: required<WorldFeature>(
						[
							"a fact a read through a query entry changes by",
							"a fact a read through a query entry does not change by"
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
				(sketch, notes) =>
					Effect.sync(() => {
						const c = notes.draw(resolveCase(sketch))
						const holding = Arr.filter(
							c.schema.relations,
							(r) => (c.facts.get(r.name) ?? []).length > 0
						)
						if (!Arr.isReadonlyArrayNonEmpty(holding)) {
							return
						}
						const stored = notes.draw(element(holding))
						const at = notes.draw(element(Arr.map(stored.fields, (field, i) => ({ field, i }))))
						const facts = c.facts.get(stored.name) ?? []
						if (!Arr.isReadonlyArrayNonEmpty(facts)) {
							return
						}
						const bound = notes.draw(element(facts))[at.i]
						if (bound !== undefined) {
							worldSound(c, stored, at.field, bound.literal, notes.note)
						}
					})
			)
		)
	)
})
