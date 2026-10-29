import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { constant, element, type Gen, map, oneOf } from "@grizzle/testing/gen"
import { type Corrupted, type CorruptedFeature, corruptedFeature } from "@grizzle/testing/lsw"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Record as Rec, String as Str } from "effect"
import { makeIdSupply, NodeId, ParamId } from "#compiler/core/ids.ts"
import { formatLoc, formatPath } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { relNode, toTable } from "#compiler/ir/dag.ts"
import { builtExpr, type ScalarExpr } from "#compiler/ir/expr.ts"
import {
	conservativeMeta,
	type DagTable,
	type NodeSpec,
	type RelKind,
	relKinds
} from "#compiler/ir/rel.ts"
import { conformWith, decodeWith, type Shape } from "#compiler/ir/shape.ts"
import { assert, refusalLoc, succeeded, throwsDefect } from "#test/support/assert.ts"
import {
	dagProblems,
	dagTableShape,
	validateDag,
	validateTable
} from "#test/support/oracle/dag-validate.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import {
	type DagRefusal,
	type DagRule,
	dagCorruptions,
	liveVariants
} from "#test/unit/ir/corruptions.ts"
import { everyKind, heading, scalarTypes } from "#test/unit/ir/fixture.ts"
import { generatedDags } from "#test/unit/ir/population.ts"

const locationOf = (path: ReadonlyArray<string | number>): string =>
	path.length === 0 ? "relational DAG" : `relational DAG at ${formatPath(path)}`

/** A rule broken, as the validator reports it: where, and the rule. */
interface Reported {
	readonly location: string
	readonly rule: string
}

/** What the validator reports of a value: the shape stage's one refusal, or every problem of the semantic stage. */
const reported = (value: unknown): ReadonlyArray<Reported> => {
	const shaped = decodeWith(dagTableShape, value, "relational DAG")
	if (!shaped.ok) {
		return [{ location: formatLoc(refusalLoc(shaped.error)), rule: shaped.error.message }]
	}
	return Arr.map(dagProblems(shaped.value), (p) => ({
		location: locationOf(p.path),
		rule: p.message
	}))
}

const meets = (problem: Reported, refusal: DagRefusal): boolean => {
	const expected = locationOf(refusal.path)
	if (refusal.match === "at") {
		return problem.location === expected
	}
	return (
		problem.location === expected ||
		Str.startsWith(`${expected}.`)(problem.location) ||
		Str.startsWith(`${expected}[`)(problem.location)
	)
}

/**
 * What a case of the validator's suites reached: the live DAG or the rule its corruption broke, a node kind of a live
 * DAG, the live variant drawn, and the site a corruption broke.
 */
type DagFeature =
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
 * A DAG's shape conformed as this package's own code builds one (shape.ts conformWith), read through the shape of any
 * value: what a builder that made exactly this value would meet. Its answer is the value it keeps or decodes, or the
 * defect it raises.
 */
const anyShape: Shape<unknown> = dagTableShape
const conformed = (value: unknown): Result.Result<unknown, string> =>
	answered(() => conformWith(anyShape, value, "relational DAG"))

/**
 * conformWith answers as decodeWith does: a value decodeWith refuses is the builder's defect naming exactly that
 * refusal, and any other comes back equal to its decoded copy, as the value itself, now frozen, or as that copy.
 */
const conformsAsDecoded = (value: unknown): void => {
	const decoded = decodeWith(dagTableShape, value, "relational DAG")
	const kept = conformed(value)
	if (!decoded.ok) {
		assert.deepEqual(
			kept,
			Result.err(
				`grizzle internal invariant: a value this package built has its shape: ${decoded.error.message}`
			)
		)
		return
	}
	assert.ok(kept.ok, `conformWith refuses what decodeWith accepts: ${!kept.ok ? kept.error : ""}`)
	assert.deepEqual(kept.value, decoded.value)
	if (kept.value === value) {
		assert.ok(Object.isFrozen(value))
	}
}

/**
 * A DAG grizzle's own code built, as validateDag answers it: shaped first (a value the shape refuses is conformWith's
 * defect, which conformsAsDecoded checks), then validated, a broken rule being the defect it raises.
 */
const validation = (value: unknown): Result.Result<DagTable, string> => {
	const shaped = decodeWith(dagTableShape, value, "relational DAG")
	return shaped.ok ? answered(() => validateTable(shaped.value)) : Result.err(shaped.error.message)
}

/**
 * The property: a live DAG is accepted, and comes back validated; a corrupted one is a defect of the code that built
 * it, naming the first rule the validator reports with its place, its own rule among the problems reported, and gives
 * nothing back. Either way a builder that made it meets the decode's answer.
 */
const judged = (c: Corrupted<unknown, DagRefusal, DagRule>): DagTable | undefined => {
	conformsAsDecoded(c.value)
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
			Str.includes(first.location)(answer.error) &&
			Str.endsWith(first.rule)(answer.error),
		`"${c.rule}" broken at a ${c.at}: the defect ${answer.error} names the first problem reported`
	)
	assert.ok(
		Arr.some(problems, (p) => meets(p, c.refusal)),
		`"${c.rule}" broken at a ${c.at}: expected a problem ${c.refusal.match} ${locationOf(c.refusal.path)}; reported ${Arr.join(
			Arr.map(problems, (p) => `${p.rule} at ${p.location}`),
			"; "
		)}`
	)
	return undefined
}

/** Every rule, by the feature its corruption names. */
const ruleFeatures: ReadonlyArray<CorruptedFeature<DagRule>> = Arr.map(
	dagCorruptions,
	(c): CorruptedFeature<DagRule> => `${c.from} ${c.rule}`
)

/** The rules every population offers sites for, which the generated cases must therefore break. */
const generatedRules: ReadonlyArray<DagFeature> = Arr.flatMap(
	[
		"a column reference names a column of its node",
		"a binding names a declared variable",
		"a region declares a variable once",
		"a heading names each column once",
		"a heading is the one its kind defines",
		"a heading column has the type its kind defines",
		"a filter's predicate is boolean",
		"an expression reads its node's input only",
		"a node's read dependencies are the computed ones",
		"a node's parameter dependencies are the computed ones",
		"a logical key names heading columns",
		"the empty key needs at most one row",
		"a literal fits its type",
		"an expression's dependencies are the computed ones",
		"an expression can fail when an argument can",
		"a column reference keeps its column's type",
		"a node or expression holds its kind's properties only",
		"no field holds null"
	] satisfies ReadonlyArray<DagRule>,
	(rule) =>
		Arr.map(
			Arr.filter(dagCorruptions, (c) => c.rule === rule),
			(c): DagFeature => `${c.from} ${c.rule}`
		)
)

describe("validateDag", () => {
	it.effect(
		"raises a defect for every corruption of the every-kind fixture at every site, and accepts its live variants",
		(ctx) => {
			const fixture = succeeded(toTable(everyKind(makeIdSupply()).dag))
			const cases: Arr.NonEmptyReadonlyArray<Corrupted<unknown, DagRefusal, DagRule>> = [
				{ kind: "live", value: fixture },
				...Arr.map(liveVariants(fixture), (v): Corrupted<unknown, DagRefusal, DagRule> => ({
					kind: "live",
					value: v.value
				})),
				...Arr.flatMap(dagCorruptions, (c) =>
					Arr.map(c.sites(fixture), (b): Corrupted<unknown, DagRefusal, DagRule> => ({
						kind: c.from,
						rule: c.rule,
						at: b.at,
						value: b.value,
						refusal: b.refusal
					}))
				)
			]
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/validate-every-kind",
						literal: Formatter.format,
						generator: element(cases),
						limit: 50_000,
						features: features<DagFeature>([
							"live",
							...ruleFeatures,
							...Arr.map(relKinds, (k): DagFeature => `node ${k}`)
						]),
						caseHang: Duration.minutes(2)
					},
					(c, n) =>
						Effect.sync(() => {
							n.note(corruptedFeature(c))
							const validated = judged(c)
							if (validated !== undefined) {
								for (const node of Rec.values(validated.nodes)) {
									n.note(`node ${node.kind}`)
								}
							}
						})
				)
			)
		}
	)

	it.effect(
		"accepts the generated DAGs and their live variants, and raises a defect for each one corruption breaks",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/validate-generated",
						literal: Formatter.format,
						draw: drawn(generatedCaseGen),
						runs: 500,
						shrink: completeShrink,
						features: features<DagFeature>(["live", ...generatedRules]),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					([dag, variant, site], n) =>
						Effect.sync(() => {
							const live = liveFrom(dag, variant)
							if (live.variant.kind === "at") {
								n.note(`variant ${live.variant.at}`)
							}
							n.note("live")
							judged({ kind: "live", value: live.dag })
							for (const corruption of dagCorruptions) {
								const [first, ...rest] = corruption.sites(live.dag)
								if (first === undefined) {
									continue
								}
								const broken = pickFrom([first, ...rest], site)
								const c: Corrupted<unknown, DagRefusal, DagRule> = {
									kind: corruption.from,
									rule: corruption.rule,
									at: broken.at,
									value: broken.value,
									refusal: broken.refusal
								}
								n.note(corruptedFeature(c))
								n.pair(corruptedFeature(c), `site ${c.at}`)
								judged(c)
							}
						})
				)
			)
	)
})

/**
 * A generated DAG, the live variant a case corrupts (none, or one picked), and the site each rule is broken at: picks,
 * since the variants and the sites are known only once the DAG is drawn.
 */
const generatedCaseGen: Gen<readonly [DagTable, LiveChoice, number]> = (source) => [
	source.draw(map(generatedDags, (dag) => succeeded(toTable(dag)))),
	source.draw(
		oneOf<LiveChoice>([
			constant({ kind: "generated" }),
			map(pickGen, (pick): LiveChoice => ({ kind: "variant", pick }))
		])
	),
	source.draw(pickGen)
]

/**
 * The live artifact a case corrupts: the generated DAG, or one of its live variants, which must validate, and which
 * variant it is.
 */
type LiveChoice =
	| { readonly kind: "generated" }
	| { readonly kind: "variant"; readonly pick: number }

const liveFrom = (
	dag: DagTable,
	choice: LiveChoice
): {
	readonly dag: DagTable
	readonly variant: { readonly kind: "none" } | { readonly kind: "at"; readonly at: string }
} => {
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

/** Two distinct nodes, or two distinct expressions, under one label: what no construction makes. */
type Clash = "two nodes" | "two expressions"

describe("validateDag over a DAG of direct references", () => {
	it.effect("raises a defect for two nodes or two expressions under one label", (ctx) => {
		const clashes: Arr.NonEmptyReadonlyArray<Clash> = ["two nodes", "two expressions"]
		return searched(
			ctx,
			exhaust(
				{
					suite: "unit/ir/validate-label-clash",
					literal: Formatter.format,
					generator: element(clashes),
					limit: clashes.length,
					features: features<Clash>(clashes),
					caseHang: Duration.minutes(2)
				},
				(clash, c) =>
					Effect.sync(() => {
						c.note(clash)
						const b = new DagBuilder(makeIdSupply())
						const input = b.node({
							kind: "InputSet",
							input: { kind: "declared", param: ParamId("p") },
							heading: heading(["a", scalarTypes.bool]),
							loc: undefined,
							meta: conservativeMeta
						})
						const truth = b.expr({
							kind: "literal",
							value: { kind: "bool", value: true },
							args: [],
							type: scalarTypes.bool,
							nonNull: "literal"
						})
						const other = b.expr({
							kind: "literal",
							value: { kind: "bool", value: false },
							args: [],
							type: scalarTypes.bool,
							nonNull: "literal"
						})
						const filter = (pred: ScalarExpr): NodeSpec => ({
							kind: "Filter",
							input,
							pred,
							heading: input.heading,
							loc: undefined,
							meta: conservativeMeta
						})
						const left = relNode(NodeId("n-left"), filter(truth))
						const right =
							clash === "two nodes"
								? relNode(left.id, filter(other))
								: relNode(NodeId("n-right"), filter(builtExpr(other, truth.id)))
						const dag = b.build([
							b.node({
								kind: "Intersect",
								left,
								right,
								heading: input.heading,
								loc: undefined,
								meta: conservativeMeta
							})
						])
						throwsDefect(() => validateDag(dag))
					})
			)
		)
	})
})
