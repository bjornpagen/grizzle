import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { boolean, element, filter, subarray } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import type * as Result from "#compiler/core/result.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import {
	lowerOptimized,
	type OptimizedProgram,
	optimizedInput
} from "#compiler/lower/optimize/pipeline.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { schemaCatalog } from "#compiler/program/schema.ts"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { messageOf } from "#test/support/message.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import { checkedLowering } from "#test/support/oracle/verify/index.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

/**
 * The optimized lowering of checked public programs builds only DAGs the validator admits.
 *
 * Each read is lowered as a template compiles it (program/compile.ts compileQuery): checked, its conservative artifact
 * lowered from the checked DAG, its optimized artifact from the checked DAG restated (everyParentTakes) and annotated
 * under the query's evidence (logical/annotate.ts queryEvidence). The optimized pipeline builds its DAG valid by
 * construction and checks nothing; the property reads the DAG it leaves back through the strict re-reader
 * (test/support/oracle/dag-validate.ts), so a rewrite that leaves a reader's checked claim unstated, an attachment's
 * delivered type or an order's keys, is the defect the re-reader raises, never a refusal of the program. The lowering
 * may refuse a program otherwise, which is not this property's subject, nor are the checker and the conservative
 * lowering.
 *
 * The rewrite this guards: an identity projection redirected onto its input hands its readers an input the demand pass
 * redefined, which states none of the projection's evidence unless it takes it over (lower/optimize/simplify/rules.ts
 * identityProjection). The readers that check that evidence are an option or bare attachment's child, by its card, and a
 * take, by the keys that make its order total. The reads are generated public programs (oracle/public/generate.ts),
 * and planted ones beside them for the take, which the generator's orders over every column rarely bring to an
 * identity.
 */

/** The handle names a drawn roster takes. */
const handleNames = ["Red", "Green", "Blue", "Amber", "Teal"] as const
type HandleName = (typeof handleNames)[number]

/** The roster forms the R07 plant reaches: the import alone binding the roster's variable, and a plain match beside it. */
type RosterFeature =
	| "an import bound to a variable only a roster match binds"
	| "roster match dropped beside a plain binder"

/** The readers of the input an identity projection was redirected onto that check the projection's evidence. */
type IdentityFeature =
	| "an option or bare child over an identity projection's input"
	| "a take over an identity projection's input"

/**
 * One read lowered as a template compiles it: refused before the optimized lowering (by the checker or the conservative
 * lowering, which are not this property's subject), or the annotated DAG and the optimized lowering's outcome.
 */
type Lowered =
	| { readonly kind: "refused before" }
	| {
			readonly kind: "lowered"
			readonly rewritten: LogicalQuery
			readonly optimized: Result.Result<OptimizedProgram, CompileError>
	  }

const lowered = (schemaValue: unknown, read: unknown): Lowered => {
	const artifacts = succeeded(testArtifacts(schemaValue, testCompile))
	const input = succeeded(queryInput(read))
	const checked = checkQuery(checking(schemaValue), input.desc, checkOptions("query"))
	if (!checked.ok) {
		return { kind: "refused before" }
	}
	const conservative = lowerConservative(conservativeInput(checked.value), {
		names: artifacts.names,
		params: checked.value.params,
		subject: { kind: "query" },
		meter: new BudgetMeter(compileBudgets)
	})
	if (!conservative.ok) {
		return { kind: "refused before" }
	}
	const rewritten = succeeded(optimizedInput(checked.value, queryEvidence))
	const catalog = schemaCatalog(artifacts)
	const optimized = lowerOptimized(rewritten, {
		names: artifacts.names,
		subject: { kind: "query" },
		catalog,
		context: "snapshot",
		meter: new BudgetMeter(compileBudgets)
	})
	if (optimized.ok) {
		validateDag(optimized.value.query.dag)
		checkedLowering({
			optimized: optimized.value,
			alignment: { kind: "aligned", conservative: conservative.value },
			context: "snapshot",
			catalog
		})
	}
	return { kind: "lowered", rewritten, optimized }
}

/**
 * Lowers one read of `schemaValue`, and notes the readers of a redirected identity projection's input; a DAG the
 * optimized lowering builds that breaks a rule is the defect the validator raises, which fails with `context`.
 */
const lowersValid = (
	schemaValue: unknown,
	read: unknown,
	n: Case<IdentityFeature>,
	context: () => string
): void => {
	let l: Lowered
	try {
		l = lowered(schemaValue, read)
	} catch (caught) {
		throw new Error(
			`the optimized lowering built a DAG that breaks a rule: ${messageOf(caught)}\n${context()}`,
			{
				cause: caught
			}
		)
	}
	if (l.kind === "refused before" || !l.optimized.ok) {
		return
	}
	/** The inputs identity projections were redirected onto, each its certificate's output. */
	const identityProjections = Arr.filter(
		l.optimized.value.certificates,
		(cert) => cert.rule === "simplify.identityProjection"
	)
	const redirected = new Set<NodeId>(Arr.flatMap(identityProjections, (cert) => cert.outputs))
	for (const node of topoOrder(l.optimized.value.query.dag)) {
		if (node.kind === "Attach" && node.delivered !== "array" && redirected.has(node.child.id)) {
			n.note("an option or bare child over an identity projection's input")
		}
		if (node.kind === "Take" && redirected.has(node.input.id)) {
			n.note("a take over an identity projection's input")
		}
	}
}

/**
 * The planted reads: takes over a projection the demand pass narrows to an identity, ordered by a key of the projection
 * alone, by it and a column, and by a column the filter reads; and the attachment of a child projecting nothing over two
 * scans, an Option of the unit relation per parent.
 */
const Item = relation("Item", { id: uuid, x: pg.integer, y: pg.integer }, ["id"])
const Items = schema("Items", { Item }, [])
const Route = closed("Route", ["Red", "Green", "Blue"])
const Stop = relation("Stop", { route: closedId(Route) }, ["route"])
const Routes = schema("Routes", { Route, Stop }, [])
const planted: Arr.NonEmptyReadonlyArray<{
	readonly name: string
	readonly schema: unknown
	readonly read: unknown
}> = [
	{
		name: "a take by the key of a projection of one column",
		schema: Items,
		read: query(Items)
			.rule((r) => {
				const { id, x } = v(Item)
				return r.match(Item, { id, x }).find({ id })
			})
			.orderBy(["id", "asc"])
			.take(1)
	},
	{
		name: "a take by the key of a filtered projection of two columns",
		schema: Items,
		read: query(Items)
			.rule((r) => {
				const { id, x } = v(Item)
				return r.match(Item, { id, x }).where(r.lt(x, 3)).find({ id, x })
			})
			.orderBy(["x", "desc"], ["id", "asc"])
			.take(2)
	},
	{
		name: "an Option of a child projecting nothing over two scans",
		schema: Routes,
		read: query(Routes)
			.rule((r) => {
				const { route } = v(Stop)
				return r.match(Stop, { route }).find({ route })
			})
			.attach(
				"stops",
				(p) =>
					query(Routes).rule((r) => {
						const { route } = v(Stop)
						return r.match(Stop, { route: p.route }).match(Stop, { route }).find({})
					}),
				"array"
			)
	}
]

describe("the optimized lowering of checked public programs", () => {
	it.effect("builds no DAG that breaks a rule for a generated read", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/lower/public-programs",
					draw: drawn(caseSketchGen),
					literal: Formatter.format,
					features: features<IdentityFeature>([
						"an option or bare child over an identity projection's input"
					]),
					kept: [],
					/**
					 * Each read compiles once without a database; an option child over an identity projection's input is
					 * about one read in fifteen, so 300 rotating cases meet it many times.
					 */
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				(sketch, n) =>
					Effect.sync(() => {
						const c = n.draw(resolveCase(sketch))
						const built = buildSchema(c.schema)
						for (const read of c.reads) {
							if (read.kind === "query") {
								lowersValid(built.schema, buildRoot(built, built.schema, read.query), n, () =>
									printCase(c)
								)
							}
						}
					})
			)
		)
	)

	it.effect("builds no DAG that breaks a rule for a planted read", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/lower/public-programs-planted",
					generator: element(planted),
					literal: Formatter.format,
					limit: planted.length,
					features: features<IdentityFeature>([
						"an option or bare child over an identity projection's input",
						"a take over an identity projection's input"
					]),
					caseHang: Duration.minutes(2)
				},
				(p, n) =>
					Effect.sync(() => {
						lowersValid(p.schema, p.read, n, () => p.name)
					})
			)
		)
	)

	it.effect(
		"lowers a roster match an import bound to its variable reads, and drops one a plain match also binds",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/lower/public-programs-roster",
						draw: drawn((source) => {
							/** Two to four distinct handles: one, and the first three of the others drawn besides it. */
							const first = source.draw(element(handleNames))
							const others = source.draw(
								filter(subarray(handleNames), (picked) => picked.length >= 2, 10)
							)
							const handles: readonly [HandleName, ...HandleName[]] = [
								first,
								...Arr.filter(others, (h) => h !== first).slice(0, 3)
							]
							return { handles, twin: source.draw(boolean) }
						}),
						literal: Formatter.format,
						features: features<RosterFeature>([
							"an import bound to a variable only a roster match binds",
							"roster match dropped beside a plain binder"
						]),
						kept: [],
						/** Each case lowers one read; a coin decides the twin, so 40 cases reach both forms many times. */
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					({ handles, twin }, n) =>
						Effect.sync(() => {
							const Tier = closed("Tier", handles)
							const Item = relation("Item", { id: uuid, tier: closedId(Tier) }, ["id"])
							const Plant = schema("Plant", { Tier, Item }, [])
							/** The items of the tier a parameter names, by their tier. */
							const ofTier = query(Plant).rule((r) => {
								const { tier } = v(Item)
								return r
									.match(Item, { tier })
									.where(r.eq(tier, r.param("k", closedId(Tier))))
									.find({ tier })
							})
							const read = query(Plant).rule((r) => {
								const { id: x } = v(Tier)
								const matched = r.match(Tier, { id: x })
								const { id } = v(Item)
								return (twin ? matched.match(Item, { id, tier: x }) : matched)
									.match(ofTier.bind({ k: x }), { tier: x })
									.find({ x })
							})
							const l = lowered(Plant, read)
							assert.ok(
								l.kind === "lowered",
								"the checker and the conservative lowering admit the read"
							)
							if (!l.optimized.ok) {
								assert.fail(`the optimized lowering refused: ${l.optimized.error.message}`)
							}
							if (!twin) {
								n.note("an import bound to a variable only a roster match binds")
								return
							}
							const dag = l.optimized.value.query.dag
							const closedSources = Arr.flatMap(topoOrder(dag), (node) =>
								node.kind === "MatchRegion"
									? Arr.filter(node.occurrences, (o) => o.source.kind === "Closed")
									: []
							)
							assert.deepEqual(
								closedSources,
								[],
								"R07 drops the roster match a plain match also binds"
							)
							n.note("roster match dropped beside a plain binder")
						})
				)
			)
	)
})
