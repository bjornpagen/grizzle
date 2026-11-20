/** What the properties of routes-sound.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Result as Answered, Array as Arr, Formatter, Option, Record as Rec } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Footprint } from "#compiler/logical/routes.ts"
import { workloadQueryRead } from "#compiler/program/workload/compile.ts"
import { workload, workloadState } from "#compiler/program/workload/value.ts"
import { role, wholeEntriesOf } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	compileTestWorkload,
	inputArtifacts,
	schemaInputOf,
	testCompile
} from "#test/support/compile.ts"
import { sameIdentity } from "#test/support/kernel/identity.ts"
import { type Answer, answerEquivalence, shapeOf } from "#test/support/oracle/public/answer.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { type CaseSketch, caseSketchGen } from "#test/support/oracle/public/generate.ts"
import { expectedQuery, factsOf, referenceSchema } from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	boundRead,
	deliveredOrder,
	type OrderKey,
	plainKinds,
	type ProgramCase,
	type ProgramField,
	type ProgramRead,
	type Stored,
	type StoredFact
} from "#test/support/oracle/public/program.ts"
import { expectedStatements } from "#test/support/oracle/reference/deliver.ts"
import { Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import {
	compare,
	equal,
	literalOf,
	type Row,
	valueIdentity
} from "#test/support/oracle/reference/values.ts"

export type Feature =
	| "a fact a routed read's answer changes by"
	| "a fact a table-wide read's answer changes by"
	| "a fact of a routed table no answer changes by"
	| "a fact a read past a take changes by"

export type WorldFeature =
	| "a fact a read through a query entry changes by"
	| "a fact a read through a query entry does not change by"
	| "a fold through a query entry bound by its key"

/** What a read through `Seen` delivers: its facts, or their count, folded over a match that binds `Seen`'s key alone. */
export type SeenRead = "facts" | "count"

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

export const sound = (c: ProgramCase, note: (feature: Feature) => void): void => {
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
					if (pastTake(read)) {
						note(takeChange)
					}
				} else if (routes !== undefined && routes.size > 0) {
					note("a fact of a routed table no answer changes by")
				}
			}
		}
	}
}

/** The requirement a drawn case seldom meets, which a case whose turn aims at it is constructed to meet. */
export const routedChange: Feature = "a fact a routed read's answer changes by"

/**
 * A relation of a case holding facts, and the fields of its primary key a constructed read binds a parameter at, each
 * with its place among the relation's fields.
 */
interface Routable {
	readonly stored: Stored
	readonly facts: Arr.NonEmptyReadonlyArray<StoredFact>
	readonly keys: Arr.NonEmptyReadonlyArray<readonly [number, ProgramField]>
}

/**
 * The case's facts read by one read constructed to reach a fact a routed read's answer changes by (program.ts
 * boundRead): over a relation holding facts, drawn, its facts whose primary key field, drawn among those of plainKinds,
 * is a parameter bound to that field of one of its facts, drawn, every other field in the head. No other fact the read
 * matches answers that fact's row, since the rest of its key is in the head, so its removal changes the answer; and
 * the read's plan routes the relation by the field under the parameter. None where no relation holding facts has such
 * a key field. A drawn read of the streams the suite's label fixes is routed in one case of them, and no removal
 * changed its answer.
 */
const routedCaseGen =
	(c: ProgramCase): Gen<Option.Option<ProgramCase>> =>
	(source) => {
		const [first, ...rest] = Arr.flatMap(c.schema.relations, (stored): ReadonlyArray<Routable> => {
			const [fact, ...facts] = c.facts.get(stored.name) ?? []
			const keyed = new Set(Arr.map(stored.primaryKey, (f) => f.name))
			const [key, ...keys] = Arr.flatMap(
				stored.fields,
				(f, at): ReadonlyArray<readonly [number, ProgramField]> =>
					keyed.has(f.name) && plainKinds.has(f.kind) ? [[at, f]] : []
			)
			return fact === undefined || key === undefined
				? []
				: [{ stored, facts: [fact, ...facts], keys: [key, ...keys] }]
		})
		if (first === undefined) {
			return Option.none()
		}
		const { stored, facts, keys } = source.draw(element([first, ...rest]))
		const [at, field] = source.draw(element(keys))
		const fact = source.draw(element(facts))
		const read = boundRead(
			stored,
			new Map([[field.name, defined(fact[at], "the fact's value at the bound field").literal]])
		)
		return Option.some({ ...c, reads: [read] })
	}

/** The requirement no drawn case is known to meet, which a case whose turn aims at it is constructed to meet. */
export const takeChange: Feature = "a fact a read past a take changes by"

/** Whether a read matches an earlier read's query that takes the first k rows of its order. */
const pastTake = (read: QueryRead): boolean =>
	Arr.some(read.query.arms, (arm) =>
		Arr.some(arm.matches, (m) => m.source.kind === "import" && m.source.query.bound.kind === "take")
	)

/** A relation holding facts, a field of plainKinds at its place, and the field's least value among the facts. */
interface Ranked {
	readonly stored: Stored
	readonly at: number
	readonly field: ProgramField
	readonly least: TypedLiteral
}

/**
 * The case's facts read past a take, constructed to reach a fact a read past a take changes by: over a relation whose
 * facts hold two values or more at a field of plainKinds, drawn with the field, the first read takes every fact but
 * one, ranked by that field descending and then every other field ascending, so the one it leaves out holds the
 * field's least value; the second reads the first's rows whose field is a parameter bound to that least value (an
 * import of the first, program.ts Imported). Removing a taken fact of a greater value lets the left-out fact in, which
 * the second read answers, so its answer changes by a fact that holds no value its parameter binds: a route through
 * the take must read the relation whole. None where no relation has such a field.
 */
const takeCaseGen =
	(c: ProgramCase): Gen<Option.Option<ProgramCase>> =>
	(source) => {
		const [first, ...rest] = Arr.flatMap(c.schema.relations, (stored): ReadonlyArray<Ranked> => {
			const facts = c.facts.get(stored.name) ?? []
			return Arr.flatMap([...stored.fields.entries()], ([at, field]): ReadonlyArray<Ranked> => {
				const values = Arr.flatMap(facts, (f) =>
					Option.toArray(Option.fromNullishOr(f[at]?.literal))
				)
				const [head, ...tail] = values
				if (!plainKinds.has(field.kind) || head === undefined) {
					return []
				}
				const value = (l: TypedLiteral) => literalOf(l, field.type)
				const least = Arr.reduce(tail, head, (low, l) =>
					compare(value(l), value(low), field.type) < 0 ? l : low
				)
				return Arr.some(values, (l) => compare(value(l), value(least), field.type) > 0)
					? [{ stored, at, field, least }]
					: []
			})
		})
		if (first === undefined) {
			return Option.none()
		}
		const { stored, field, least } = source.draw(element([first, ...rest]))
		const facts = c.facts.get(stored.name) ?? []
		const whole = boundRead(stored, new Map())
		const taken: QueryRead = {
			...whole,
			query: {
				...whole.query,
				bound: {
					kind: "take",
					order: [
						{ column: { name: field.name, type: field.type }, dir: "desc" },
						...Arr.flatMap(stored.fields, (f): ReadonlyArray<OrderKey> =>
							f.name === field.name ? [] : [{ column: { name: f.name, type: f.type }, dir: "asc" }]
						)
					],
					k: facts.length - 1
				}
			}
		}
		const read = boundRead(stored, new Map([[field.name, least]]))
		const [arm, ...arms] = read.query.arms
		const [match, ...matches] = arm.matches
		const past: QueryRead = {
			...read,
			query: {
				...read.query,
				arms: [
					{
						...arm,
						matches: [
							{
								...match,
								source: {
									kind: "import",
									read: 0,
									query: taken.query,
									fields: stored.fields,
									binds: []
								}
							},
							...matches
						]
					},
					...arms
				]
			}
		}
		return Option.some({ ...c, reads: [taken, past] })
	}

/** How a case's reads are made: as drawn, or constructed to reach a routed read's change or a change past a take. */
type Reads = "drawn" | "routed" | "past a take"

/** A case's sketch: its public case's, and how its reads are made. */
type Sketch = readonly [CaseSketch, Reads]

/** A sketch whose reads are made as `reads` says. */
export const sketchGen =
	(reads: Reads): Gen<Sketch> =>
	(source) => [source.draw(caseSketchGen), reads]

/** The case a case checks, as its sketch's `reads` says: the drawn one, routedCaseGen's or takeCaseGen's. */
export const caseOf = (
	c: ProgramCase,
	reads: Reads,
	draw: <A>(generator: Gen<A>) => A
): ProgramCase => {
	switch (reads) {
		case "drawn":
			return c
		case "routed":
			return Option.getOrElse(draw(routedCaseGen(c)), () => c)
		case "past a take":
			return Option.getOrElse(draw(takeCaseGen(c)), () => c)
	}
}

/** The parameter a read through `Seen` binds its drawn field to. */
const seenParam = "seen"

/**
 * A read through a query entry (see the header): over the case's relation `stored`, the role `seer` whose entry `Seen`
 * holds each of its facts, and the read of `Seen`'s facts whose field `field` is the parameter `seen`, the read's one
 * program of a workload over the role.
 */
const seenWorkload = (c: ProgramCase, stored: Stored, field: ProgramField, shape: SeenRead) => {
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
	const keyed = new Set([...Arr.map(stored.primaryKey, (f) => f.name), field.name])
	const program = queryOver(seer).rule((r: RuleValue) => {
		const fact = varsOver(entry, "fact")
		const matched = r
			.match(entry, shape === "facts" ? fact : Rec.filter(fact, (_, name) => keyed.has(name)))
			.where(r.eq(fact[field.name], r.param(seenParam, read.fields[field.name])))
		return shape === "facts" ? matched.find(fact) : matched.find({ facts: r.count() })
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

export const worldSound = (
	c: ProgramCase,
	stored: Stored,
	field: ProgramField,
	bound: TypedLiteral,
	shape: SeenRead,
	note: (feature: WorldFeature) => void
): void => {
	const printed = () =>
		`${printCase(c)}\nthrough Seen over ${stored.name}, ${field.name} = ${Formatter.format(bound)}`
	const { built, w } = seenWorkload(c, stored, field, shape)
	const plan = succeeded(
		compileTestWorkload([{ login: loginName, workloads: [w] }], built.schema, testCompile),
		"the entry read's workload plan"
	)
	if (shape === "count") {
		note("a fold through a query entry bound by its key")
	}
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
						functions: noFunctions,
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
