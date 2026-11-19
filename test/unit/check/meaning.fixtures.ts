/**
 * The builder and the checker give every generated query read the meaning its program states
 * (test/support/oracle/public): each read built, checked, and evaluated by the reference over the checked IR answers
 * as the program's own meaning does, compared by the answer's contract (a set, or ordered where the read delivers in
 * order), and each heading group of a heterogeneous union's root likewise.
 *
 * Oracle: a second implementation, the program's meaning evaluated straight from the generated program against the
 * reference evaluator over the checked IR, which the strict DAG re-reader (test/support/oracle/dag-validate.ts) reads
 * first, so a checked IR no lowering can read, a column read outside every scope that binds it among them, is a defect
 * before any answer is compared. Where the reference declines a value, its reason is noted and the cases it declined
 * are measured by reason, so a class of cases it stops judging shows on the report.
 *
 * Features: the language's own terms the program reaches, each mixed form, and each node kind the checked IR holds.
 */

import { defined } from "@bjornpagen/testing/assert"
import { aimed, type Aimed, type Gen, map } from "@bjornpagen/testing/gen"
import { type Case } from "@bjornpagen/testing/property"
import { Array as Arr, Option, Result } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { RelKind } from "#compiler/ir/rel.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import {
	type Answer,
	answerEquivalence,
	answersReport,
	mixedShapes,
	shapeOf
} from "#test/support/oracle/public/answer.ts"
import { buildMixed, buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import {
	admittedSketchGen,
	type CaseSketch,
	caseSketchGen,
	type MixedForm,
	mixedFeatures,
	mixedForms,
	type ProgramFeature,
	programFeatures,
	programForms
} from "#test/support/oracle/public/generate.ts"
import {
	expectedFrom,
	expectedMixed,
	expectedMixedFrom,
	expectedQuery
} from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import type { ProgramCase, ProgramRead } from "#test/support/oracle/public/program.ts"
import { type ReferenceObserver, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import type { DeclineReason } from "#test/support/oracle/reference/values.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

type QueryRead = Extract<ProgramRead, { readonly kind: "query" }>
type MixedRead = Extract<ProgramRead, { readonly kind: "mixed" }>

/** What a program reached, by the language's own terms (generate.ts), and the kinds of node its checked IR holds. */
export type Feature =
	| "a negation deciding part of the answer"
	| ProgramFeature
	| MixedForm
	| `checked ${RelKind}`
	| `declined ${DeclineReason}`

export const situations: ReadonlyArray<Feature> = [
	"arms",
	"take",
	"attachment",
	"nested attachment",
	"join of matches",
	"roster match",
	"bind var",
	"bind literal",
	"bind param",
	"bind parent",
	"negation",
	"a negation deciding part of the answer",
	"aggregate count",
	"aggregate sum",
	"aggregate min",
	"zero-column head",
	"ordered delivery",
	...programForms,
	...mixedForms
]

/**
 * A sketch of the plain swarm turned to negations over dense facts and nothing else, where a negation decides part of
 * a read's answer about one case in fourteen, where the drawn populations reach one in a hundred and fifty.
 */
const negatingSketchGen: Gen<CaseSketch> = map(caseSketchGen, (sketch) => ({
	...sketch,
	population: "swarm",
	swarm: { negation: 3, dense: 3 }
}))

/**
 * The case sketches, each program form still pending aimed at the form-directed population, which turns every form on
 * (generate.ts admittedSketchGen), and a negation deciding part of an answer at the negating swarm.
 */
export const sketchSpace: Aimed<CaseSketch, Feature> = aimed(caseSketchGen, [
	...Arr.map(programForms, (form) => [form, admittedSketchGen] as const),
	["a negation deciding part of the answer", negatingSketchGen]
])

/**
 * Whether a read's negations decide part of its answer: its meaning holds a row, and its meaning with its arms'
 * negations taken away holds another set of rows, so a negation whose join equates fewer columns than it states takes
 * away an answer the program keeps.
 */
const negationDecides = (c: ProgramCase, read: QueryRead, meant: Answer): boolean => {
	if (
		!Arr.some(read.query.arms, (arm) => arm.negations.length > 0) ||
		!Result.isSuccess(meant) ||
		meant.success.length === 0
	) {
		return false
	}
	const unnegated: QueryRead = {
		...read,
		query: { ...read.query, arms: Arr.map(read.query.arms, (arm) => ({ ...arm, negations: [] })) }
	}
	return Option.isSome(
		answerEquivalence(shapeOf(read.query), false)(meant, expectedQuery(c, unnegated, unobserved))
	)
}

/** One query read: the builder's Description, the checker's IR and its answer, against the program's meaning. */
export const judged = (
	c: ProgramCase,
	read: QueryRead,
	note: Case<Feature>["note"],
	observer: ReferenceObserver
): void => {
	const built = buildSchema(c.schema)
	const input = succeeded(
		queryInput(buildRoot(built, built.schema, read.query)),
		`the builder refuses a program the language admits\n${printCase(c)}`
	)
	const checked = succeeded(
		checkQuery(checking(built.schema), input.desc, checkOptions("query")),
		`the checker refuses a program the language admits\n${printCase(c)}`
	)
	validateDag(checked.dag)
	for (const node of topoOrder(checked.dag)) {
		note(`checked ${node.kind satisfies RelKind}`)
	}
	for (const feature of programFeatures(read.query)) {
		note(feature)
	}
	const shape = shapeOf(read.query)
	const meant = expectedQuery(c, read, observer)
	const fromChecked = expectedFrom(
		c,
		read,
		{ dag: checked.dag, root: checked.dag.roots[0] },
		observer
	)
	if (negationDecides(c, read, meant)) {
		note("a negation deciding part of the answer")
	}
	const difference = answerEquivalence(shape, read.query.delivery.kind === "ordered")(
		meant,
		fromChecked
	)
	if (Option.isSome(difference)) {
		throw new Error(
			`${answersReport(shape, difference.value, [
				["the program's meaning", meant],
				["the checked IR", fromChecked]
			])}\n${printCase(c)}`
		)
	}
}

/**
 * One mixed read, a heterogeneous union at the root: the builder's Description, the checker's IR and each heading
 * group's answer from it, against the program's meaning of that group.
 */
export const judgedMixed = (
	c: ProgramCase,
	read: MixedRead,
	note: Case<Feature>["note"],
	observer: ReferenceObserver
): void => {
	const built = buildSchema(c.schema)
	const input = succeeded(
		queryInput(buildMixed(built, built.schema, read.root)),
		`the builder refuses a mixed root the language admits\n${printCase(c)}`
	)
	const checked = succeeded(
		checkQuery(checking(built.schema), input.desc, checkOptions("query")),
		`the checker refuses a mixed root the language admits\n${printCase(c)}`
	)
	for (const feature of mixedFeatures(read.root)) {
		note(feature)
	}
	const meant = expectedMixed(c, read.root, observer)
	const fromChecked = expectedMixedFrom(
		c,
		read.root,
		{ dag: checked.dag, root: checked.dag.roots[0] },
		observer
	)
	for (const [g, shape] of mixedShapes(read.root).entries()) {
		const meantGroup = defined(meant[g], `the meaning of group ${g}`)
		const checkedGroup = defined(fromChecked[g], `the checked IR's group ${g}`)
		const difference = answerEquivalence(shape, false)(meantGroup, checkedGroup)
		if (Option.isSome(difference)) {
			throw new Error(
				`${answersReport(shape, difference.value, [
					[`the program's meaning of group ${g}`, meantGroup],
					[`the checked IR's group ${g}`, checkedGroup]
				])}\n${printCase(c)}`
			)
		}
	}
}
