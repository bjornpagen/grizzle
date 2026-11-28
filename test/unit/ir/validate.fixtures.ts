/** What the properties of validate.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, deepEquals, nonEmpty } from "@bjornpagen/testing/assert"
import { constant, type Gen, map, oneOf, weighted } from "@bjornpagen/testing/gen"
import { type Corrupted, corrupted, type CorruptedFeature } from "@bjornpagen/testing/lsw"
import { Array as Arr, String as Str } from "effect"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { formatLoc, formatPath, SourceLoc } from "#compiler/core/loc.ts"
import type { DagTable, RelKind } from "#compiler/ir/rel.ts"
import { decodeWith } from "#compiler/ir/shape.ts"
import { type Place, placeOf, refusalLoc, succeeded } from "#test/support/assert.ts"
import { toTable } from "#test/support/dag.ts"
import {
	dagProblems,
	type DagRule,
	dagTableShape,
	validateTable
} from "#test/support/oracle/dag-validate.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { everyKind } from "#test/support/unit/ir/fixture.ts"
import { generatedDags } from "#test/support/unit/ir/population.ts"
import {
	dagCorruptions,
	type DagRefusal,
	type DagReport,
	liveVariants
} from "#test/unit/ir/corruptions.ts"

/** The label every place of a DAG's problems is under. */
const dagLabel = "relational DAG"

/**
 * What the validator reports, where, by its label and path, and in what words: the shape stage's refusal, which names
 * no rule, or a problem of the semantic stage under its rule.
 */
type Reported =
	| { readonly stage: "shape"; readonly place: Place; readonly message: string }
	| {
			readonly stage: "rules"
			readonly place: Place
			readonly rule: DagRule
			readonly message: string
	  }

/** What the validator reports of a value: the shape stage's one refusal, or every problem of the semantic stage. */
const reported = (value: unknown): ReadonlyArray<Reported> => {
	const shaped = decodeWith(dagTableShape, value, dagLabel)
	if (!shaped.ok) {
		return [
			{ stage: "shape", place: placeOf(refusalLoc(shaped.error)), message: shaped.error.message }
		]
	}
	return Arr.map(dagProblems(shaped.value), (p): Reported => ({
		stage: "rules",
		place: { label: dagLabel, path: p.path },
		rule: p.rule,
		message: p.message
	}))
}

/** Whether a reported problem is the one a corruption's site expects: its own rule, another named, or the shape's. */
const answers = (problem: Reported, report: DagReport, own: DagRule): boolean => {
	switch (report.kind) {
		case "own":
			return problem.stage === "rules" && problem.rule === own
		case "rule":
			return problem.stage === "rules" && problem.rule === report.rule
		case "shape":
			return problem.stage === "shape"
	}
}

/** What a site expects, as a failure states it. */
const expectation = (report: DagReport): string => {
	switch (report.kind) {
		case "own":
			return "its own rule"
		case "rule":
			return `"${report.rule}"`
		case "shape":
			return "the shape's refusal"
	}
}

/** A reported problem as a failure lists it: its rule, or the shape's refusal, and its path. */
const described = (p: Reported): string =>
	`${p.stage === "rules" ? p.rule : `the shape: ${p.message}`} at ${formatPath(p.place.path)}`

/** Whether `path` is `within` or a path inside it. */
const inside = (path: ReadonlyArray<string | number>, within: ReadonlyArray<string | number>) =>
	path.length >= within.length && Arr.every(within, (step, i) => path[i] === step)

/** Whether a problem stands where a corruption's refusal says: at its path, or within it. */
const meets = (problem: Reported, refusal: DagRefusal): boolean =>
	problem.place.label === dagLabel &&
	(refusal.match === "at"
		? deepEquals(problem.place.path, refusal.path)
		: inside(problem.place.path, refusal.path))

/**
 * What a case of the validator's suites reached: the live DAG or the rule its corruption broke, a node kind of a live
 * DAG, the live variant drawn, and the site a corruption broke.
 */
export type DagFeature =
	| "live"
	| CorruptedFeature<DagRule>
	| `node ${RelKind}`
	| `variant ${string}`
	| `site ${string}`

/** The prefix of every defect's message (core/invariant.ts defect). */
const defectPrefix = "grizzle internal invariant: "

/** What grizzle's own code meets running `f`: its value, or the defect it raises, as the defect's message. */
const answered = <A>(f: () => A): Result.Result<A, string> => {
	try {
		return Result.ok(f())
	} catch (caught) {
		if (Error.isError(caught) && Str.startsWith(defectPrefix)(caught.message)) {
			return Result.err(caught.message)
		}
		throw caught
	}
}

/**
 * A DAG grizzle's own code built, as validateDag answers it: shaped first, then validated, a broken rule being the
 * defect it raises.
 */
const validation = (value: unknown): Result.Result<DagTable, string> => {
	const shaped = decodeWith(dagTableShape, value, dagLabel)
	return shaped.ok ? answered(() => validateTable(shaped.value)) : Result.err(shaped.error.message)
}

/**
 * The property: a live DAG is accepted, and comes back validated; a corrupted one is a defect of the code that built
 * it, naming the first rule the validator reports with its place, its own rule among the problems reported, and gives
 * nothing back. Either way a builder that made it meets the decode's answer.
 */
export const judged = (c: Corrupted<unknown, DagRefusal, DagRule>): DagTable | undefined => {
	const answer = validation(c.value)
	if (c.kind === "live") {
		assert.ok(answer.ok, `a valid DAG is refused: ${!answer.ok ? answer.error : ""}`)
		return answer.value
	}
	assert.ok(!answer.ok, `the validator accepts a DAG that breaks "${c.rule}" at a ${c.at}`)
	const problems = reported(c.value)
	const [first] = problems
	assert.ok(
		first !== undefined &&
			Str.includes(formatLoc(SourceLoc(first.place.label, first.place.path)))(answer.error) &&
			Str.endsWith(first.message)(answer.error),
		`"${c.rule}" broken at a ${c.at}: the defect ${answer.error} names the first problem reported`
	)
	assert.ok(
		Arr.some(problems, (p) => answers(p, c.refusal.reports, c.rule) && meets(p, c.refusal)),
		`"${c.rule}" broken at a ${c.at}: expected ${expectation(c.refusal.reports)} ${c.refusal.match} ${formatPath(c.refusal.path)}; reported ${Arr.join(
			Arr.map(problems, described),
			"; "
		)}`
	)
	return undefined
}

/** Every rule, by the feature its corruption names. */
export const ruleFeatures: ReadonlyArray<CorruptedFeature<DagRule>> = Arr.map(
	dagCorruptions,
	(c): CorruptedFeature<DagRule> => `${c.from} ${c.rule}`
)

/** The every-kind fixture as a table: every kind of node and expression, so a site of every rule. */
const everyKindTable: DagTable = succeeded(toTable(everyKind(makeIdSupply()).dag))

/**
 * The live DAGs the corruptions break, as tables: the every-kind fixture, which holds every kind of node and
 * expression and so offers a site to every rule, or a generated DAG, whose structure no fixture fixes.
 */
const liveTables: Gen<DagTable> = weighted([
	[1, constant(everyKindTable)],
	[3, map(generatedDags, (dag) => succeeded(toTable(dag)))]
])

/** The live variant a case corrupts: none, or one picked, since the variants are the DAG's own. */
const choiceGen: Gen<LiveChoice> = oneOf<LiveChoice>([
	constant({ kind: "generated" }),
	map(pickGen, (pick): LiveChoice => ({ kind: "variant", pick }))
])

/**
 * What a case aims at: nothing, a drawn corruption of its drawn DAG; a live DAG, where its turn aims at a node kind; or
 * a corruption of one rule, by its feature, where its turn aims at that rule. An aimed case corrupts the every-kind
 * fixture.
 */
type DagAim =
	| { readonly kind: "drawn" }
	| { readonly kind: "live" }
	| { readonly kind: "rule"; readonly rule: CorruptedFeature<DagRule> }

/** A case: a live DAG, the live variant it corrupts, and what it aims at. */
type DagCase = readonly [DagTable, LiveChoice, DagAim]

/** A case aimed at nothing: a drawn live DAG and the variant it corrupts. */
export const drawnCase: Gen<DagCase> = (source) => [
	source.draw(liveTables),
	source.draw(choiceGen),
	{ kind: "drawn" }
]

/** A case aimed at `aim`: the every-kind fixture, which offers a site to every rule, and the variant it corrupts. */
export const aimedCase =
	(aim: DagAim): Gen<DagCase> =>
	(source) => [everyKindTable, source.draw(choiceGen), aim]

/**
 * The corruption a case judges of `dag`, as its aim says: a drawn one; none, the DAG live; or, among the aimed rule's
 * corruptions that hold a site of it, one picked, broken at a site picked, and a drawn one where none holds a site.
 */
export const corruptionOf = (
	dag: DagTable,
	aim: DagAim,
	draw: <A>(generator: Gen<A>) => A
): Corrupted<unknown, DagRefusal, DagRule> => {
	switch (aim.kind) {
		case "drawn":
			return draw(corrupted(dag, dagCorruptions))
		case "live":
			return { kind: "live", value: dag }
		case "rule":
			return Arr.match(
				Arr.filter(
					dagCorruptions,
					(corruption) =>
						`${corruption.from} ${corruption.rule}` === aim.rule &&
						Arr.isReadonlyArrayNonEmpty(corruption.sites(dag))
				),
				{
					onEmpty: () => draw(corrupted(dag, dagCorruptions)),
					onNonEmpty: (aimable): Corrupted<unknown, DagRefusal, DagRule> => {
						const corruption = pickFrom(aimable, draw(pickGen))
						const broken = pickFrom(
							nonEmpty(corruption.sites(dag), "a site of a pending rule"),
							draw(pickGen)
						)
						return {
							kind: corruption.from,
							rule: corruption.rule,
							at: broken.at,
							value: broken.value,
							refusal: broken.refusal
						}
					}
				}
			)
	}
}

/**
 * The live artifact a case corrupts: the generated DAG, or one of its live variants, which must validate, and which
 * variant it is.
 */
type LiveChoice =
	| { readonly kind: "generated" }
	| { readonly kind: "variant"; readonly pick: number }

/** Which live variant a case corrupts: none, the DAG as drawn, or the one at a place. */
type LiveVariantDrawn = { readonly kind: "none" } | { readonly kind: "at"; readonly at: string }

/**
 * The live DAG a case corrupts, as its choice says: the drawn DAG, or one of its live variants, which must validate,
 * beside which variant it is.
 */
export const liveFrom = (
	dag: DagTable,
	choice: LiveChoice
): { readonly dag: DagTable; readonly variant: LiveVariantDrawn } => {
	const [first, ...rest] = liveVariants(dag)
	if (choice.kind === "generated" || first === undefined) {
		return { dag, variant: { kind: "none" } }
	}
	const chosen = pickFrom([first, ...rest], choice.pick)
	const answer = validation(chosen.value)
	if (!answer.ok) {
		throw new Error(`a live variant (${chosen.at}) is refused: ${answer.error}`)
	}
	return { dag: answer.value, variant: { kind: "at", at: chosen.at } }
}
