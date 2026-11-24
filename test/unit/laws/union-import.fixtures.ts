/** What the property of union-import.test.ts reads: each shape compiled, its space, and each case's judgement. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { queryColumns } from "#compiler/analysis/theory/columns.ts"
import { Navigation, navigateQuery } from "#compiler/analysis/theory/navigate.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { noClock } from "#compiler/ir/clock.ts"
import { theoryViolations } from "#compiler/laws/model/violations.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { type HostFacts, referenceRows } from "#test/unit/analysis/theory/support.ts"
import {
	type Facts,
	factsGen,
	levels,
	type Shape,
	unionSchemaOf,
	unions,
	widthOf
} from "#test/unit/laws/union-import.schema.ts"

const keyOf = (shape: Shape): string => `${shape.level}: ${shape.union}`

/**
 * Each shape's artifacts with its installation, the judge's statements among it, compiled once for the box, or the
 * first refusal of either.
 */
const compiled: ReadonlyMap<string, Result.Result<SchemaArtifacts, CompileError>> = new Map(
	Arr.flatMap(levels, (level) =>
		Arr.map(unions, (union) => {
			const shape = { union, level }
			const artifacts = Result.flatMap(testArtifacts(unionSchemaOf(shape), testCompile), (a) =>
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
	readonly facts: Facts
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
			navigateQuery(
				rule.rule.everyRow,
				loc,
				queryColumns(artifacts.laws.checked, loc),
				{ kind: "perStatement", extent: "every" },
				new Navigation(theory.regionFacts)
			),
			{
				read: "region",
				clock: noClock,
				label: "the check over every row",
				session: CheckSession.own()
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
