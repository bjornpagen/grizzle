import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { rating, required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { RelKind } from "#compiler/ir/rel.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import {
	answerEquivalence,
	answersReport,
	mixedShapes,
	shapeOf
} from "#test/support/oracle/public/answer.ts"
import { buildMixed, buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import {
	type CaseSketch,
	caseSketchGen,
	type MixedForm,
	mixedFeatures,
	mixedForms,
	plantedNameCount,
	type ProgramFeature,
	programFeatures,
	programForms,
	resolveCase
} from "#test/support/oracle/public/generate.ts"
import { type ReferenceObserver, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { type DeclineReason, declineReasons } from "#test/support/oracle/reference/values.ts"

import {
	expectedFrom,
	expectedMixed,
	expectedMixedFrom,
	expectedQuery
} from "#test/support/oracle/public/meaning.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import type { ProgramCase, ProgramRead } from "#test/support/oracle/public/program.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

type QueryRead = Extract<ProgramRead, { readonly kind: "query" }>
type MixedRead = Extract<ProgramRead, { readonly kind: "mixed" }>

/** What a program reached, by the language's own terms (generate.ts), and the kinds of node its checked IR holds. */
type Feature = ProgramFeature | MixedForm | `checked ${RelKind}` | `declined ${DeclineReason}`

const situations: Arr.NonEmptyReadonlyArray<Feature> = [
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
	"aggregate count",
	"aggregate sum",
	"aggregate min",
	"zero-column head",
	"ordered delivery",
	...programForms,
	...mixedForms
]

/** The picks a shrunk sketch leaves at their floor: a value, a match's bindings, a stage's head, an order. */
const value0 = { cls: 0, sp: 0 }
const binds0 = Array.from({ length: 7 }, () => ({ how: 0, pick: 0, value: value0 }))
const head0 = {
	vars: [],
	names: [0, 0, 0, 0, 0, 0],
	folds: [{ fn: 0, arg: 0, padded: 0, scale: 0 }]
}
const order0 = { rotate: 0, dirs: [0, 0, 0], size: 0 }
const match0 = (derived: number) => ({ source: 0, derived, attached: 0, binds: binds0 })
const read0 = (matches: ReadonlyArray<number>, pair: number): CaseSketch["reads"][number] => ({
	rule: {
		matches: Arr.map(matches, match0),
		where: [],
		between: [],
		inSet: [],
		allen: [],
		pointIn: [],
		connective: [],
		computed: [],
		negation: { source: 0, picks: [0, 0] },
		head: head0,
		interior: {
			matches: [match0(0)],
			where: [],
			negation: { source: 0, picks: [0, 0] },
			head: head0
		}
	},
	take: order0,
	literalHead: { name: 0, kind: 0, arms: 0, values: [0, 0, 0] },
	importable: 0,
	bindImport: 0,
	named: 0,
	relationParam: { relation: 0, facts: [] },
	closure: { relation: 0, pair, name: 0 },
	attachments: [],
	order: order0,
	probe: { kind: 0, pick: 0 },
	key: { relation: 0, which: 0, fact: 0, absent: 0, roster: 0 }
})

const fact0 = (values: ReadonlyArray<{ readonly cls: number; readonly sp: number }>) => ({
	values: [...values, value0, value0, value0, value0, value0].slice(0, 7)
})

/**
 * Kept: R(k int4, f0 numeric, f1 numeric, h handle) holding (0, 1, 1) and (1, 1.0, 0), matched beside its recursive
 * closure from f1 to f0 where f1 < f0. The closure's step binds one variable to the state's 1.0 and a fact's 1, two
 * spellings of one value, and compares it with f0: the reference, which once read that comparison as one over a
 * declined value and refused the case, states it, since 1.0 and 1 are one Decimal.
 */
const kept: ReadonlyArray<Kept<CaseSketch, Feature>> = [
	{
		note: "a comparison over a variable bound to two spellings of one value, in a closure's step",
		sketch: {
			population: "delivered",
			swarm: {
				attach: 3,
				"stated delivery": 3,
				"keyed child": 3,
				"reflexive child": 3,
				"arm child": 3,
				"handle field": 3,
				"full head": 3,
				dense: 2,
				recursive: 2
			},
			perturbation: { settings: [], multiplier: 1 },
			ambient: ordinarySession,
			restorage: { shift: 0, respell: 0 },
			roster: 0,
			span: 0,
			relations: [
				{
					name: 0,
					fields: [
						{ name: 0, kind: 0, key: 0 },
						{ name: 0, kind: 11916, key: 0 },
						{ name: 0, kind: 11916, key: 0 },
						{ name: 0, kind: 0, key: 0 }
					],
					candidate: 0,
					facts: [
						fact0([value0, { cls: 32768, sp: 0 }, { cls: 32768, sp: 0 }]),
						fact0([
							{ cls: 32768, sp: 0 },
							{ cls: 32768, sp: 21846 }
						])
					]
				}
			],
			reads: [read0([0, 32768], 32768), read0([0], 0)],
			planted: {
				names: Array.from({ length: plantedNameCount }, () => 0),
				value: value0,
				handle: 0,
				padding: 0,
				side: { kind: 0, values: [0, 0, 0] }
			}
		},
		/**
		 * The swarm's thinning decisions, in the order resolution asks: the first two places a weight-2 feature could
		 * appear kept, the third left out.
		 */
		draws: "1.1.0",
		reaches: ["a recursive closure"]
	}
]

/** One query read: the builder's Description, the checker's IR and its answer, against the program's meaning. */
const judged = (
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
const judgedMixed = (
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

describe("the builder and the checker", () => {
	it.effect(
		"give every generated query read the meaning its program states, by the reference",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/meaning",
						draw: drawn(caseSketchGen),
						literal: Formatter.format,
						coverage: rating(
							required<Feature>(situations, { cases: 400, sense: notesOnly }),
							Arr.map(declineReasons, (reason) => `declined ${reason}` as const)
						),
						kept,
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(sketch, k) =>
						Effect.sync(() => {
							const c = k.draw(resolveCase(sketch))
							const observer: ReferenceObserver = {
								...unobserved,
								decline: (reason) => k.note(`declined ${reason}`)
							}
							for (const read of c.reads) {
								if (read.kind === "query") {
									judged(c, read, k.note, observer)
								} else if (read.kind === "mixed") {
									judgedMixed(c, read, k.note, observer)
								}
							}
						})
				)
			)
	)
})
