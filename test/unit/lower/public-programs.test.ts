import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, filter, type Gen, int, oneOf, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
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
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import { checkedLowering } from "#test/support/oracle/verify/index.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"
import { present } from "#test/unit/lower/support.ts"

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
		subject: { kind: "query" }
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
		context: "snapshot"
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
 * The reads the generator's orders over every column rarely bring to an identity: takes over a projection of Item the
 * demand pass narrows to an identity, and an attachment whose child projects nothing over its scans of Stop, the unit
 * relation per parent.
 */
const Item = relation("Item", { id: uuid, x: pg.integer, y: pg.integer }, ["id"])
const Items = schema("Items", { Item }, [])
const Route = closed("Route", ["Red", "Green", "Blue"])
const Stop = relation("Stop", { route: closedId(Route) }, ["route"])
const Routes = schema("Routes", { Route, Stop }, [])

/**
 * A take of the first `k` items, each finding its id and x and y where drawn, filtered on x where drawn, ordered by the
 * `first`th column it finds in either direction, then by its key; or the routes, each with the child of `scans` scans
 * of Stop, the first on the parent's route, finding nothing.
 */
type PlantedRead =
	| {
			readonly kind: "take"
			readonly x: boolean
			readonly y: boolean
			readonly filtered: boolean
			readonly first: number
			readonly descending: boolean
			readonly k: number
	  }
	| { readonly kind: "child"; readonly scans: number }

/** The columns a planted take finds: the key, then x and y where drawn. */
const foundOf = (x: boolean, y: boolean): ReadonlyArray<"id" | "x" | "y"> => [
	"id",
	...(x ? ["x" as const] : []),
	...(y ? ["y" as const] : [])
]

const plantedGen: Gen<PlantedRead> = oneOf<PlantedRead>([
	(source) => {
		const x = source.draw(boolean)
		const y = source.draw(boolean)
		return {
			kind: "take",
			x,
			y,
			filtered: source.draw(boolean),
			first: source.draw(int(0, foundOf(x, y).length - 1)),
			descending: source.draw(boolean),
			k: source.draw(int(1, 3))
		}
	},
	(source) => ({ kind: "child", scans: source.draw(int(1, 3)) })
])

/** A planted read and the schema it is built over. */
const plantedRead = (p: PlantedRead): { readonly schema: unknown; readonly read: unknown } => {
	if (p.kind === "child") {
		return {
			schema: Routes,
			read: queryOver(Routes)
				.rule((r: RuleValue) => {
					const { route } = varsOver(Stop, "stop")
					return r.match(Stop, { route }).find({ route })
				})
				.attach(
					"stops",
					(parent: Readonly<Record<string, unknown>>) =>
						queryOver(Routes).rule((r: RuleValue) =>
							Arr.reduce(
								upTo(p.scans - 1, (i) => varsOver(Stop, `stop${i}`)),
								r.match(Stop, { route: parent["route"] }),
								(matched, { route }) => matched.match(Stop, { route })
							).find({})
						),
					"array"
				)
		}
	}
	const found = foundOf(p.x, p.y)
	const first = present(found[p.first], "the first order column")
	const items = queryOver(Items).rule((r: RuleValue) => {
		const vars = varsOver(Item, "item")
		const matched = r.match(Item, vars)
		return (p.filtered ? matched.where(r.lt(vars["x"], 3)) : matched).find(
			Rec.fromEntries(Arr.map(found, (name) => [name, vars[name]]))
		)
	})
	const leading = [first, p.descending ? "desc" : "asc"]
	return {
		schema: Items,
		read: (first === "id" ? items.orderBy(leading) : items.orderBy(leading, ["id", "asc"])).take(
			p.k
		)
	}
}

describe("the optimized lowering of checked public programs", () => {
	it.effect("builds no DAG that breaks a rule for a generated read", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/lower/public-programs",
					draw: drawn(caseSketchGen),
					literal: Formatter.format,
					coverage: required<IdentityFeature>(
						["an option or bare child over an identity projection's input"],
						{ cases: 300, sense: notesOnly }
					),
					kept: [],
					/**
					 * Each read compiles once without a database; an option child over an identity projection's input is
					 * about one read in fifteen, so 300 rotating cases meet it many times.
					 */
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
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
					box: { kind: "unstated" },
					oracle: { kind: "unstated" },
					suite: "unit/lower/public-programs-planted",
					generator: plantedGen,
					literal: Formatter.format,
					limit: 128,
					coverage: requiredInSpace<IdentityFeature>([
						"an option or bare child over an identity projection's input",
						"a take over an identity projection's input"
					]),
					caseHang
				},
				(p, n) =>
					Effect.sync(() => {
						const { schema: planted, read } = plantedRead(p)
						lowersValid(planted, read, n, () => Formatter.format(p))
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
						oracle: { kind: "unstated" },
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
						coverage: required<RosterFeature>(
							[
								"an import bound to a variable only a roster match binds",
								"roster match dropped beside a plain binder"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						/** The rotating stream's sample, each case one read lowered and a coin deciding the twin. */
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ handles, twin }, n) =>
						Effect.sync(() => {
							const Tier = closed("Tier", handles)
							const Item = relation("Item", { id: uuid, tier: closedId(Tier) }, ["id"])
							const Plant = schema("Plant", { Tier, Item }, [])
							/** The items of the tier a parameter names, by their tier. */
							const ofTier = query(Plant).rule((r) => {
								const { tier } = v(Item, "item")
								return r
									.match(Item, { tier })
									.where(r.eq(tier, r.param("k", closedId(Tier))))
									.find({ tier })
							})
							const read = query(Plant).rule((r) => {
								const { id: x } = v(Tier, "tier")
								const matched = r.match(Tier, { id: x })
								const { id } = v(Item, "item")
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
