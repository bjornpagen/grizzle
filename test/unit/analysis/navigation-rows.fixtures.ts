/** What navigation-rows.test.ts reads: its schema, its space, the member it navigates and the reference's answers. */

import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import { queryColumns } from "#compiler/analysis/theory/columns.ts"
import { Navigation, navigateQuery } from "#compiler/analysis/theory/navigate.ts"
import { buildTheory } from "#compiler/analysis/theory/theory.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { InferredQuery, InferredRule } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { succeeded } from "#test/support/assert.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A ledger's sittings as edullm's holds them: each child's sittings of a stage, the ends of some, each item session of a
 * sitting, each attempt of an item, the attempts response processing has run on, and the sittings already final.
 */
const Sitting = relation("Sitting", { child: pg.integer, stage: pg.integer }, ["child", "stage"])
const TestEnd = relation("TestEnd", { child: pg.integer, stage: pg.integer }, ["child", "stage"])
const ItemSession = relation(
	"ItemSession",
	{ child: pg.integer, stage: pg.integer, item: pg.integer },
	["child", "stage", "item"]
)
const Attempt = relation("Attempt", { child: pg.integer, item: pg.integer, n: pg.integer }, [
	"child",
	"item",
	"n"
])
const Processed = relation("Processed", { child: pg.integer, item: pg.integer, n: pg.integer }, [
	"child",
	"item",
	"n"
])
const Final = relation("Final", { child: pg.integer, stage: pg.integer }, ["child", "stage"])
const Settle = schema(
	"NavigationRows",
	[Sitting, TestEnd, ItemSession, Attempt, Processed, Final],
	[]
)

const relations = ["Sitting", "TestEnd", "ItemSession", "Attempt", "Processed", "Final"] as const
type RelationName = (typeof relations)[number]

/** Each relation's columns, in declared order. */
const columnsOf: Readonly<Record<RelationName, ReadonlyArray<string>>> = {
	Sitting: ["child", "stage"],
	TestEnd: ["child", "stage"],
	ItemSession: ["child", "stage", "item"],
	Attempt: ["child", "item", "n"],
	Processed: ["child", "item", "n"],
	Final: ["child", "stage"]
}

/** The reference's view of the schema: each relation's int4 columns in declared order, its primary key. */
const referenceSchema: GenSchema = {
	name: "NavigationRows",
	relations: Arr.map(relations, (name) => {
		const columns = columnsOf[name]
		return {
			name,
			columns: Arr.map(columns, (c) => ({ name: c, type: int4 })),
			primaryKey: columns,
			keys: [],
			mutable: false
		}
	}),
	closed: [],
	containments: []
}

/**
 * What a sitting waits on, the query the definition negates: each item session's attempt response processing has not
 * run on, a join of two relations as edullm's ledger reads it (unprocessedAttempts), or each item session with an
 * unprocessed attempt of its own number, one relation read beside a negation.
 */
type Pending = "a join of two relations" | "one relation"

/** Where the call's rows come from: the parameters alone, or the call's child's sittings, a stored relation's rows. */
type Rows = "the call's parameters" | "the call's child's sittings"

interface Shape {
	readonly pending: Pending
	readonly rows: Rows
	/** Whether the member negates Final beside the definition, as edullm's finalize does. */
	readonly negated: boolean
}

/** A drawn case: its shape, the stored facts, and the call's child and stage. */
interface RowsCase {
	readonly shape: Shape
	readonly facts: Readonly<Record<RelationName, ReadonlyArray<ReadonlyArray<number>>>>
	readonly child: number
	readonly stage: number
}

export type Feature =
	| "a negated query that joins"
	| "a negated query of one relation"
	| "a member negation beside the definition"
	| "the call's rows read from a stored relation"
	| "a sitting the definition keeps"
	| "a sitting the definition drops"

export const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	"a negated query that joins",
	"a negated query of one relation",
	"a member negation beside the definition",
	"the call's rows read from a stored relation",
	"a sitting the definition keeps",
	"a sitting the definition drops"
]

/** A value of a small domain, so keys collide and joins meet. */
const small: Gen<number> = int(1, 2)

/** Up to `max` facts of `width` small values, distinct, as a relation keyed by all its columns holds them. */
const factsOf =
	(width: number, max: number): Gen<ReadonlyArray<ReadonlyArray<number>>> =>
	(s) =>
		Arr.dedupeWith(
			s.draw(array((t) => Array.from({ length: width }, () => t.draw(small)), { min: 0, max })),
			(a, b) => Arr.every(a, (x, i) => x === b[i])
		)

export const rowsCaseGen: Gen<RowsCase> = (s) => ({
	shape: {
		pending: s.draw(element<Pending>(["a join of two relations", "one relation"])),
		rows: s.draw(element<Rows>(["the call's parameters", "the call's child's sittings"])),
		negated: s.draw(boolean)
	},
	facts: {
		Sitting: s.draw(factsOf(2, 4)),
		TestEnd: s.draw(factsOf(2, 4)),
		ItemSession: s.draw(factsOf(3, 5)),
		Attempt: s.draw(factsOf(3, 5)),
		Processed: s.draw(factsOf(3, 5)),
		Final: s.draw(factsOf(2, 2))
	},
	child: s.draw(small),
	stage: s.draw(small)
})

/** The pending query of a shape. */
const pendingOf = (pending: Pending) =>
	pending === "a join of two relations"
		? query(Settle).rule((r) => {
				const { child, stage, item } = v(ItemSession, "session")
				const { n } = v(Attempt, "attempt")
				return r
					.match(ItemSession, { child, stage, item })
					.match(Attempt, { child, item, n })
					.where(r.not(Processed, { child, item, n }))
					.find({ child, stage })
			})
		: query(Settle).rule((r) => {
				const { child, stage, item } = v(ItemSession, "session")
				return r
					.match(ItemSession, { child, stage, item })
					.where(r.not(Processed, { child, item, n: item }))
					.find({ child, stage })
			})

/** The sittings settled: ended, and none of their item sessions pending (edullm's SettledSitting). */
const settledOf = (pending: Pending) => {
	const waiting = pendingOf(pending)
	return query(Settle).rule((r) => {
		const { child, stage } = v(TestEnd, "end")
		return r
			.match(TestEnd, { child, stage })
			.where(r.not(waiting, { child, stage }))
			.find({ child, stage })
	})
}

const sittingHeading = { child: pg.integer, stage: pg.integer } as const

/** The rows the call binds `sittings` to. */
const rowsOf = (rows: Rows) =>
	rows === "the call's parameters"
		? query(Settle).rule((r) =>
				r.find({ child: r.param("child", pg.integer), stage: r.param("stage", pg.integer) })
			)
		: query(Settle).rule((r) => {
				const { child, stage } = v(Sitting, "sitting")
				return r
					.match(Sitting, { child, stage })
					.where(r.eq(child, r.param("child", pg.integer)))
					.find({ child, stage })
			})

const loc = SourceLoc("navigation-rows property", [])

/**
 * The member a shape writes, as the write's frontend navigates it: the call's sittings settled, beside Final's negation
 * where the shape negates it (edullm's finalizeSittingOf), its `sittings` bound to the shape's rows by ChangeSet.bind,
 * which the member reads by the parameter's name (ChangeSetDesc `boundRows`).
 */
export const memberOf = (shape: Shape): InferredQuery => {
	const settled = settledOf(shape.pending)
	const member = query(Settle).rule((r) => {
		const sittings = r.relation("sittings", sittingHeading)
		const { child, stage } = v(sittings, "sitting")
		const read = r.match(sittings, { child, stage }).match(settled, { child, stage })
		return shape.negated
			? read.where(r.not(Final, { child, stage })).find({ child, stage })
			: read.find({ child, stage })
	})
	const desc = descOf(
		ChangeSet.empty(Settle)
			.insert(Final, member)
			.bind({ sittings: rowsOf(shape.rows) })
	)
	const written = desc.strata[0]?.members[0]?.member
	if (written?.kind !== "query") {
		throw new Error("the member a shape writes is one query member")
	}
	return written.query
}

const checked = checking(Settle)

/** A shape's member navigated as the write's frontend navigates it (write/frontend/compile.ts, `perRead`). */
export const navigatedOf = (member: InferredQuery): InferredQuery =>
	navigateQuery(
		member,
		loc,
		queryColumns(checked, loc),
		{ kind: "perRead" },
		new Navigation(succeeded(buildTheory(checked)).regionFacts)
	)

/** A relation one step of a navigated query reads, and the columns a channel or a parameter binds it at. */
interface StepRead {
	readonly relation: string
	readonly keyed: ReadonlyArray<string>
}

/**
 * The columns of match `m` of rule `r` a channel or a parameter binds: bound to one, or to a variable a condition of the
 * rule equates with one, which the step prints inside its subquery, where PostgreSQL seeks the relation by it.
 */
const keyedColumns = (
	r: InferredRule,
	m: InferredRule["matches"][number]
): ReadonlyArray<string> => {
	const atParam = new Set(
		Arr.flatMap(r.where, (w) =>
			w.kind !== "compare" || w.op !== "eq"
				? []
				: w.left.kind === "var" && w.right.kind === "param"
					? [w.left.var]
					: w.right.kind === "var" && w.left.kind === "param"
						? [w.right.var]
						: []
		)
	)
	return Arr.filter(Rec.keys(m.bindings), (column) => {
		const e = m.bindings[column]
		return e?.kind === "param" || (e?.kind === "var" && atParam.has(e.var))
	})
}

/**
 * Every relation each step of `q` reads, at any depth: through the steps and imports it matches and the relational
 * filters of each rule, a step's, an import's or a navigated filter's, each with the columns its step binds to a channel
 * or a parameter (`keyedColumns`). An import read whole, the call's rows, is no step.
 */
export const stepReads = (q: InferredQuery): ReadonlyArray<StepRead> => {
	const out: Array<StepRead> = []
	const rules = (query: InferredQuery, inStep: boolean): void => {
		if (query.stage.kind !== "rules") {
			return
		}
		for (const arm of query.stage.arms) {
			rule(arm, inStep)
		}
	}
	const rule = (r: InferredRule, inStep: boolean): void => {
		for (const m of r.matches) {
			if (m.source.kind === "relation" && inStep) {
				out.push({ relation: m.source.name, keyed: keyedColumns(r, m) })
			} else if (m.source.kind === "step") {
				rules(m.source.query, true)
			} else if (m.source.kind === "query") {
				rules(m.source.query, inStep)
			}
		}
		for (const w of r.where) {
			if (w.kind === "absent" || w.kind === "exists") {
				if (w.source.kind === "step") {
					rules(w.source.query, true)
				} else if (w.source.kind === "query") {
					rules(w.source.query, inStep)
				}
			}
		}
	}
	rules(q, false)
	return out
}

/**
 * The rows the call binds `sittings` to, (child, stage) each: the call's parameters, or the call's child's sittings
 * stored, as the ChangeSet's bound rows evaluate before its first stratum (ChangeSetDesc `boundRows`).
 */
export const calledOf = (c: RowsCase): ReadonlyArray<ReadonlyArray<number>> =>
	c.shape.rows === "the call's parameters"
		? [[c.child, c.stage]]
		: Arr.filter(c.facts.Sitting, ([child]) => child === c.child)

/** The relation parameters a member's rules match, by name: the call's bound `sittings`, which it reads by its name. */
const relationParamsOf = (q: InferredQuery): ReadonlyArray<string> =>
	q.stage.kind === "rules"
		? Arr.dedupe(
				Arr.flatMap(q.stage.arms, (arm) =>
					Arr.flatMap(arm.matches, (m) =>
						m.source.kind === "param" || m.source.kind === "paramOf" ? [m.source.name] : []
					)
				)
			)
		: []

/** The literal of a small value, as the reference reads it. */
const literal = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** The reference's answer to `member` over a case's facts at its call: each (child, stage) it delivers, sorted. */
export const answerOf = (c: RowsCase, member: InferredQuery): ReadonlyArray<string> => {
	const ir = succeeded(checkQuery(checked, member, checkOptions("navigation-rows")))
	const reference = Reference.of(ir.dag, {
		schema: referenceSchema,
		facts: canonicalFacts(
			Rec.map(c.facts, (rows) => Arr.map(rows, (row) => Arr.map(row, literal)))
		),
		params: {
			child: { kind: "scalar", type: int4, value: literal(c.child) },
			stage: { kind: "scalar", type: int4, value: literal(c.stage) },
			...Rec.fromEntries(
				Arr.map(relationParamsOf(member), (name) => [
					name,
					{
						kind: "relation",
						heading: [
							{ name: "child", type: int4 },
							{ name: "stage", type: int4 }
						],
						rows: Arr.map(calledOf(c), (row) => Arr.map(row, literal))
					}
				])
			)
		},
		functions: noFunctions,
		observer: unobserved
	})
	const answer = reference.eval(ir.dag.roots[0], noBindings)
	return Arr.sort(
		Arr.map(answer.rows, (row) => Arr.join(Arr.map(row, String), ",")),
		Order.String
	)
}
