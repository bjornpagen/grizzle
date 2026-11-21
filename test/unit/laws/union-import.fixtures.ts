/** What the property of union-import.test.ts reads: its box, its schemas, and each case's judgement. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, String as Str } from "effect"
import { queryColumns } from "#compiler/analysis/theory/columns.ts"
import { navigateQuery } from "#compiler/analysis/theory/navigate.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { noClock } from "#compiler/ir/clock.ts"
import { theoryViolations } from "#compiler/laws/model/violations.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { type HostFacts, referenceRows } from "#test/unit/analysis/theory/support.ts"

const Snap = relation("Snap", { child: pg.integer, n: pg.integer, at: pg.integer }, [
	"child",
	"n",
	"at"
])

const Item = relation("Item", { child: pg.integer, n: pg.integer, stage: pg.integer }, [
	"child",
	"n"
])

const Sess = relation("Sess", { child: pg.integer, stage: pg.integer }, ["child", "stage"])

const Visit = relation(
	"Visit",
	{ child: pg.integer, stage: pg.integer, k: pg.integer, at: pg.integer },
	["child", "stage", "k"]
)

const Susp = relation(
	"Susp",
	{ child: pg.integer, stage: pg.integer, k: pg.integer, at: pg.integer },
	["child", "stage", "k"]
)

/** Every relation immutable and keyed by its child first, so the containment is unit-local, judged whole by child. */
const Base = schema("union_import", [Snap, Item, Sess, Visit, Susp], [])

/** A snapshot at its item's stage, where the child has a session of that stage: a join of three relations. */
const snaps = query(Base).rule((r) => {
	const { child, n, at } = v(Snap, "snap")
	const { stage } = v(Item, "item")
	return r
		.match(Snap, { child, n, at })
		.match(Item, { child, n, stage })
		.match(Sess, { child, stage })
		.find({ child, n, at, stage })
})

const SnapStage = derived("SnapStage", snaps)

/**
 * A rule of the union a snapshot is contained in, each reading `snaps` once, which navigation inlines into it: a visit
 * of the stage begun by the snapshot (`open`); a visit begun by it and suspended after it (`suspended`), a join of
 * one more relation; a visit begun after it (`late`).
 */
const visited = (r: Rule<typeof Base>) => {
	const { child, n, at, stage } = v(snaps, "snap")
	const { k, at: began } = v(Visit, "visit")
	return {
		matched: r.match(snaps, { child, n, at, stage }).match(Visit, { child, stage, k, at: began }),
		head: { child, n, at, stage, k, began },
		at,
		began,
		key: { child, stage, k }
	}
}

const open = (r: Rule<typeof Base>) => {
	const { matched, head, at, began } = visited(r)
	return matched.where(r.le(began, at)).find(head)
}

const suspended = (r: Rule<typeof Base>) => {
	const { matched, head, at, began, key } = visited(r)
	const { at: until } = v(Susp, "susp")
	return matched
		.match(Susp, { ...key, at: until })
		.where(r.le(began, at), r.le(at, until))
		.find(head)
}

const late = (r: Rule<typeof Base>) => {
	const { matched, head, at, began } = visited(r)
	return matched.where(r.lt(at, began)).find(head)
}

/** Every nonempty union of the three rules, in their order. */
export const unions = [
	"open",
	"suspended",
	"late",
	"open, suspended",
	"open, late",
	"suspended, late",
	"open, suspended, late"
] as const

export type Union = (typeof unions)[number]

/** The rules of a union, each its own read of `snaps`. */
const rulesOf = (union: Union) => {
	const q = query(Base)
	switch (union) {
		case "open":
			return q.rule(open)
		case "suspended":
			return q.rule(suspended)
		case "late":
			return q.rule(late)
		case "open, suspended":
			return q.rule(open).rule(suspended)
		case "open, late":
			return q.rule(open).rule(late)
		case "suspended, late":
			return q.rule(suspended).rule(late)
		case "open, suspended, late":
			return q.rule(open).rule(suspended).rule(late)
	}
}

/** How many rules a union holds. */
const widthOf = (union: Union): number => Str.split(", ")(union).length

/** Where the containment is compiled: its own level, or a level that extends it. */
export const levels = ["own", "above"] as const

export interface Shape {
	readonly union: Union
	readonly level: (typeof levels)[number]
}

/** The schema of a shape: SnapStage contained in the union of its rules, at its own level or read from one above. */
const schemaOf = (shape: Shape) => {
	const InSession = derived("InSession", rulesOf(shape.union))
	const own = schema.extend(
		[Base],
		"union_import_1",
		[SnapStage, InSession],
		[
			contained(
				on(SnapStage, "child", "n", "at", "stage"),
				on(InSession, "child", "n", "at", "stage")
			)
		]
	)
	return shape.level === "own"
		? own
		: schema.extend([own], "union_import_2", [relation("Above", { id: pg.integer }, ["id"])], [])
}

const keyOf = (shape: Shape): string => `${shape.level}: ${shape.union}`

/**
 * Each shape's artifacts with its installation, the judge's statements among it, compiled once for the box, or the
 * first refusal of either.
 */
const compiled: ReadonlyMap<string, Result.Result<SchemaArtifacts, CompileError>> = new Map(
	Arr.flatMap(levels, (level) =>
		Arr.map(unions, (union) => {
			const shape = { union, level }
			const artifacts = Result.flatMap(testArtifacts(schemaOf(shape), testCompile), (a) =>
				Result.map(compileInstallation(a.owned, installOptions(a.owned)), () => a)
			)
			return [keyOf(shape), artifacts] as const
		})
	)
)

const artifactsOf = (shape: Shape): SchemaArtifacts =>
	succeeded(
		defined(compiled.get(keyOf(shape)), "a shape of the box"),
		`the containment into the union of ${shape.union} compiles, with its installation`
	)

export interface Case {
	readonly shape: Shape
	readonly facts: HostFacts
}

const children = [1, 2] as const

const pairs = Arr.flatMap(children, (child) => Arr.map([1, 2], (n) => ({ child, n })))

const stagesOf = Arr.flatMap(children, (child) => Arr.map([1, 2], (stage) => ({ child, stage })))

const visitKeys = Arr.flatMap(stagesOf, (s) => Arr.map([1, 2], (k) => ({ ...s, k })))

/**
 * A drawn state of two children: snapshots of up to two of their four (child, n) pairs at one or two instants of 0 to 3,
 * each snapshotted pair's item at stage 1 or 2, one to four sessions, and up to five visits, each suspended or not, at
 * instants of 0 to 3.
 */
const factsGen: Gen<HostFacts> = (s) => {
	const snapped = s.draw(subset(pairs, { min: 0, max: 2 }))
	const visits = Arr.map(s.draw(subset(visitKeys, { min: 0, max: 5 })), (key) => ({
		...key,
		at: s.draw(int(0, 3))
	}))
	return {
		Snap: Arr.flatMap(snapped, (p) =>
			Arr.map(s.draw(subset([0, 1, 2, 3], { min: 1, max: 2 })), (at) => ({ ...p, at }))
		),
		Item: Arr.map(snapped, (p) => ({ ...p, stage: s.draw(int(1, 2)) })),
		Sess: s.draw(subset(stagesOf, { min: 1, max: 4 })),
		Visit: visits,
		Susp: Arr.flatMap(visits, (visit) =>
			s.draw(int(0, 1)) === 1 ? [{ ...visit, at: s.draw(int(0, 3)) }] : []
		)
	}
}

export const caseGen: Gen<Case> = (s) => ({
	shape: { union: s.draw(element(unions)), level: s.draw(element(levels)) },
	facts: s.draw(factsGen)
})

export type Feature =
	| "a union of one rule"
	| "a union of two rules"
	| "a union of three rules"
	| "compiled from a level above"
	| "a snapshot the union holds"
	| "a snapshot the union lacks"

export const features: readonly [Feature, ...Array<Feature>] = [
	"a union of one rule",
	"a union of two rules",
	"a union of three rules",
	"compiled from a level above",
	"a snapshot the union holds",
	"a snapshot the union lacks"
]

const loc = SourceLoc("union-import property", [])

/** A heading's names in one order, the reference's rows being keyed by name. */
const namesOf = (heading: ReadonlyArray<{ readonly name: string }>): string =>
	Arr.join(
		Arr.sort(
			Arr.map(heading, (h) => h.name),
			Order.String
		),
		","
	)

/** The snapshots of `facts` at their stage: SnapStage's rows, counted. */
const snapStageRows = (facts: HostFacts): number =>
	Arr.filter(facts["Snap"] ?? [], (snap) =>
		Arr.some(
			facts["Item"] ?? [],
			(item) =>
				item["child"] === snap["child"] &&
				item["n"] === snap["n"] &&
				Arr.some(
					facts["Sess"] ?? [],
					(sess) => sess["child"] === snap["child"] && sess["stage"] === item["stage"]
				)
		)
	).length

/**
 * One case: the shape compiles, its one rule is judged whole, and its check over every row, the violation query
 * navigated as the judge navigates it (physical/ddl/rules.ts judgedStatement), read by the reference evaluator, finds
 * exactly the facts the violation query does.
 */
export const judged = (c: Case, note: (f: Feature) => void): void => {
	const artifacts = artifactsOf(c.shape)
	const [rule, ...more] = artifacts.laws.rules
	if (rule === undefined || more.length > 0) {
		return assert.fail("the schema states one rule, the containment")
	}
	if (rule.rule.kind !== "whole") {
		return assert.fail(
			"the containment is unit-local, judged whole over the children a transaction wrote"
		)
	}
	const theory = artifacts.laws.theory
	const violations = succeeded(theoryViolations(artifacts.laws.checked, theory))
	const forbid = defined(violations.forbids.get(rule.law.id), "the containment's violation query")
	if (forbid.kind !== "Forbid") {
		return assert.fail("a Forbid node")
	}
	const meant = referenceRows(theory, violations.dag, forbid.violation, c.facts)
	const checked = succeeded(
		checkQuery(
			artifacts.laws.checked,
			navigateQuery(rule.rule.everyRow, loc, queryColumns(artifacts.laws.checked, loc), {
				kind: "perStatement",
				extent: "every"
			}),
			{
				read: "region",
				clock: noClock,
				label: "the check over every row",
				session: new CheckSession()
			}
		),
		"the checker admits the check over every row"
	)
	const root = defined(checked.dag.roots[0], "the check's root")
	assert.equal(
		namesOf(root.heading),
		namesOf(forbid.violation.heading),
		"the check states the violation's heading"
	)
	assert.deepEqual(
		referenceRows(theory, checked.dag, root, c.facts),
		meant,
		"the check over every row finds exactly the violation query's facts"
	)
	const width = widthOf(c.shape.union)
	note(
		width === 1
			? "a union of one rule"
			: width === 2
				? "a union of two rules"
				: "a union of three rules"
	)
	if (c.shape.level === "above") {
		note("compiled from a level above")
	}
	if (meant.size > 0) {
		note("a snapshot the union lacks")
	}
	if (snapStageRows(c.facts) > meant.size) {
		note("a snapshot the union holds")
	}
}
