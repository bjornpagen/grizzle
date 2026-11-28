/** What the properties of public-programs.test.ts read: its spaces, models and helpers. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { boolean, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Record as Rec } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import {
	lowerOptimized,
	optimizedInput,
	type OptimizedProgram
} from "#compiler/lower/optimize/pipeline.ts"
import { queryInput } from "#compiler/program/input.ts"
import { closedId, int4 } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { costChosen } from "#compiler/sql/emit.ts"
import { succeeded } from "#test/support/assert.ts"
import { type FixtureSchema, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { messageOf } from "#test/support/message.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { checkedLowering } from "#test/support/oracle/verify/index.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { present } from "#test/support/unit/lower/support.ts"
import { upTo } from "#test/support/up-to.ts"

/** The handle names a drawn roster takes. */
export const handleNames = ["Red", "Green", "Blue", "Amber", "Teal"] as const

export type HandleName = (typeof handleNames)[number]

/** The roster forms R07 decides: the import alone binding the roster's variable, and a plain match beside it. */
export type RosterFeature =
	| "an import bound to a variable only a roster match binds"
	| "roster match dropped beside a plain binder"

/** The readers of the input an identity projection was redirected onto that check the projection's evidence. */
export type IdentityFeature =
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

export const lowered = (schemaValue: FixtureSchema, read: unknown): Lowered => {
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
	const optimizing = succeeded(optimizedInput(checked.value, queryEvidence))
	const rewritten = optimizing.query
	const catalog = evidenceCatalog(artifacts)
	const optimized = lowerOptimized(optimizing, {
		binding: costChosen,
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
export const lowersValid = (
	schemaValue: FixtureSchema,
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
const Item = relation("Item", { id: Id, x: int4, y: int4 }, ["id"])

const Items = schema("Items", [Item], [])

const Route = closed.ordered("Route", ["Red", "Green", "Blue"])

const Stop = relation("Stop", { route: closedId(Route) }, ["route"])

const Routes = schema("Routes", [Route, Stop], [])

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

export const plantedGen: Gen<PlantedRead> = oneOf<PlantedRead>([
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
export const plantedRead = (
	p: PlantedRead
): { readonly schema: FixtureSchema; readonly read: unknown } => {
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
