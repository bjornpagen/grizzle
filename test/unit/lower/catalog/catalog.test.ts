/**
 * The compile-target catalog's recognizers (lower/shapes/catalog, rules R26-R31, R41, R42) without a database: each
 * applies exactly where its module's documented preconditions hold, and the composition is kept, applying none of its
 * own, where one fails. Every query is the language's own composition of a construct, checked by the real checker
 * (test/pg/catalog/queries.ts), and every search is exhaustive over the shapes the compositions' parameters span.
 *
 * - R26 in any spelling: the inclusive lexicographic order is recognized in every spelling and direction and orders its
 *   window as spelled; the strict order and a conjunction of field comparisons are kept.
 * - R26 and R41 on a self-match: windowed exactly where the second occurrence is free, the keys determine a row and the
 *   students the two occurrences match are one.
 * - R29 and R30: PERCENTILE_DISC exactly for gated fractions over ordinals joined on the group, PERCENTILE_CONT exactly
 *   for a fraction in [0, 1] of a double precision value.
 * - R31: MODE() exactly for take(1) of an unconditional count tied to the value ascending.
 * - R27 and R42 under the parent-set policy, and an as-of kept where its fields' types differ or its take is ordered
 *   toward the parent.
 * - R28: a share kept where its total ranges over another binding set or its join restricts the pairs.
 * - Determinism: two rewrites of one input are byte-identical, DAG and SQL, and the pass records the rewrite's
 *   certificates.
 *
 * Oracle: each module's documented preconditions turned into a checker (a specification), the set of entries a rewrite
 * applied compared to the set they admit; determinism is the universal law that one input rewrites alike. What a
 * rewritten query delivers is unit/lower/catalog/reference's and pg/catalog/agreement's; the prose of a kept
 * composition's reason is no contract.
 *
 * Features: each verdict of each search's shape classes ("recognized" and "kept" per spelling, "windowed" and "kept"
 * per head, "rewritten" and "probed" per neighbor kind), every one required of the space.
 *
 * Plants, each failing its search: the strict order recognized (catalog-r26-strict); a constant on the second
 * occurrence alone admitted (catalog-self-match-constant); a fraction of 0 admitted by the discrete gate
 * (catalog-r29-zero); a fraction of 1.5 admitted by the continuous one (catalog-r30-range); the tiebreak's direction
 * unread (catalog-r31-tiebreak); an attachment's bound parents taken whole under the automatic policy
 * (catalog-parents-auto); an as-of ordered toward the parent admitted (catalog-as-of-order); a total over another
 * source admitted (catalog-r28-source); a fresh node label that differs run to run (catalog-fresh-labels).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, constant, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import { catchRefusal, encode, everyProperty } from "#compiler/core/canonical.ts"
import { VarId } from "#compiler/core/ids.ts"
import { type Direction, directions, opposite } from "#compiler/core/order.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Rooted, RootedDag, VarDecl } from "#compiler/ir/rel.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import { ConservativeDelivery } from "#compiler/lower/conservative/deliver.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import {
	CatalogContext,
	type CatalogOptions,
	type ParentPolicy
} from "#compiler/lower/shapes/catalog/context.ts"
import { CatalogEditor } from "#compiler/lower/shapes/catalog/edit.ts"
import { NoMatch } from "#compiler/lower/shapes/catalog/exprs.ts"
import { tryBoundNeighbor } from "#compiler/lower/shapes/catalog/neighbor.ts"
import {
	type CatalogResult,
	catalogPass,
	rewriteCatalog
} from "#compiler/lower/shapes/catalog/rewrite.ts"
import { plainType } from "#compiler/scalar/native.ts"
import * as Q from "#test/pg/catalog/queries.ts"
import { checkedQuery, lab, labOptions } from "#test/pg/catalog/support.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { catalogDispatch } from "#test/support/compile.ts"
import type { AuthoredExprDesc as ExprDesc, QueryDesc } from "#test/support/fixtures/ir/desc.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import * as D from "#test/unit/check/dsl.ts"

const int8 = plainType("int8")

const rewrite = (
	desc: QueryDesc,
	options: CatalogOptions
): { readonly q: LogicalQuery; readonly r: CatalogResult<Rooted> } => {
	const q = checkedQuery(desc)
	return { q, r: succeeded(rewriteCatalog(q.dag, options)) }
}

/** The entries a rewrite applied, each once, in order. */
const rules = (r: CatalogResult): ReadonlyArray<CertificateRule> =>
	Arr.sort([...new Set(Arr.map(r.certificates, (c) => c.rule))], Order.String)

const appliedTo = (desc: QueryDesc, options: CatalogOptions): ReadonlyArray<CertificateRule> =>
	rules(rewrite(desc, options).r)

const sql = (q: LogicalQuery, r: CatalogResult<Rooted>): ReadonlyArray<string> =>
	Arr.map(
		flight(
			succeeded(
				catchRefusal(() =>
					new ConservativeDelivery(
						new LowerContext(
							r.dag,
							{
								names: productionNames(
									"lab",
									{ kind: "declared" },
									localVectorSchema,
									schemaCodes(lab)
								),
								params: q.params,
								subject: { kind: "query" }
							},
							catalogDispatch
						)
					).program(r.dag.roots[0])
				)
			).roots
		),
		(s) => s.sql.text
	)

const v = D.varRef
const s = (f: string) => D.ref("Sitting", f)

const dirs = element(directions)

/**
 * The spellings of "t before s" over (day, id) under per-field directions, inclusive or strict: the nested expansion,
 * its disjunctive normal form, each comparison with its operands swapped, the negation of the strict or inclusive
 * successor, and a conjunction of field comparisons, which is no lexicographic order.
 */
type Spelling =
	| "nested"
	| "disjunctive normal form"
	| "operands swapped"
	| "negated successor"
	| "conjunctive"

interface Field {
	readonly t: ExprDesc
	readonly s: ExprDesc
	readonly dir: Direction
}

/**
 * t strictly precedes s on one field, or precedes or equals it, in the field's direction; and the mirror image with
 * the operands swapped.
 */
const precedes = (f: Field, orEqual: boolean): ExprDesc =>
	f.dir === "asc"
		? orEqual
			? D.le(f.t, f.s)
			: D.lt(f.t, f.s)
		: orEqual
			? D.ge(f.t, f.s)
			: D.gt(f.t, f.s)

const precedesSwapped = (f: Field, orEqual: boolean): ExprDesc =>
	f.dir === "asc"
		? orEqual
			? D.ge(f.s, f.t)
			: D.gt(f.s, f.t)
		: orEqual
			? D.le(f.s, f.t)
			: D.lt(f.s, f.t)

const follows = (f: Field, orEqual: boolean): ExprDesc =>
	precedes({ t: f.s, s: f.t, dir: f.dir }, orEqual)

const spelled = (
	spelling: Spelling,
	[day, id]: readonly [Direction, Direction],
	inclusive: boolean
): ExprDesc => {
	const first: Field = { t: v("t.day"), s: s("day"), dir: day }
	const second: Field = { t: v("t.id"), s: s("id"), dir: id }
	switch (spelling) {
		case "nested":
			return Q.lexicographic([first, second], inclusive)
		case "disjunctive normal form":
			return inclusive
				? D.or(
						precedes(first, false),
						D.and(D.eq(first.t, first.s), precedes(second, false)),
						D.and(D.eq(first.t, first.s), D.eq(second.t, second.s))
					)
				: D.or(precedes(first, false), D.and(D.eq(first.t, first.s), precedes(second, false)))
		case "operands swapped":
			return D.or(
				precedesSwapped(first, false),
				D.and(D.eq(first.s, first.t), precedesSwapped(second, inclusive))
			)
		case "negated successor":
			return {
				kind: "not",
				arg: D.or(follows(first, false), D.and(D.eq(first.t, first.s), follows(second, !inclusive)))
			}
		case "conjunctive":
			return D.and(precedes(first, inclusive), precedes(second, inclusive))
	}
}

const windowsOf = (r: CatalogResult) =>
	Arr.flatMap(topoOrder(r.dag), (n) => (n.kind === "Window" ? [n] : []))

describe("R26: the lexicographic comparison in any spelling", () => {
	it.effect(
		"recognizes the inclusive order in every spelling and direction, and orders the window as spelled",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "each of five spellings (nested, its disjunctive normal form, operands swapped, the negated successor, a conjunction of field comparisons), each direction of each of two fields, inclusive or strict",
						oracle: {
							kind: "specification",
							name: "R26's precondition: an inclusive lexicographic comparison of paired fields, in any spelling (ordinal.ts, lexicographic.ts)"
						},
						suite: "unit/lower/catalog/lexicographic-spellings",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(
									element<Spelling>([
										"nested",
										"disjunctive normal form",
										"operands swapped",
										"negated successor",
										"conjunctive"
									])
								),
								source.draw((source) => [source.draw(dirs), source.draw(dirs)] as const),
								source.draw(boolean)
							] as const,
						coverage: requiredInSpace<`${Spelling} ${"recognized" | "kept"}`>([
							"nested recognized",
							"nested kept",
							"disjunctive normal form recognized",
							"operands swapped recognized",
							"negated successor recognized",
							"conjunctive kept"
						]),
						caseHang,
						concurrency: 1
					},
					([spelling, order, inclusive], c) =>
						Effect.sync(() => {
							const { r } = rewrite(
								Q.selfMatch(
									{ ordinal: D.count() },
									{
										...Q.plainSelfMatch,
										order: { kind: "spelled", where: spelled(spelling, order, inclusive) }
									}
								),
								labOptions
							)
							const recognized = inclusive && spelling !== "conjunctive"
							c.note(`${spelling} ${recognized ? "recognized" : "kept"}`)
							assert.deepEqual(rules(r), recognized ? ["R26"] : [])
							if (recognized) {
								assert.deepEqual(
									Arr.map(windowsOf(r), (w) => Arr.map(w.order.keys, (k) => k.dir)),
									[[...order]]
								)
							}
						})
				)
			)
	)
})

/** The fold a self-match's head computes: its ordinal, or a running maximum of the second occurrence's score. */
type Head = "ordinal" | "running maximum"
/** A further condition on the self-match: none, one on the second occurrence, or one on the first alone. */
type Extra = "none" | "on the second occurrence" | "on the first occurrence"
/** The group keys: the student and the id, the student alone, or the id alone. */
type Keys = "student and id" | "student" | "id"
/**
 * The student both occurrences match: the shared variable, one constant both fix, two different constants, which no
 * composition queries.ts writes and an edit of the checked DAG plants, or two variables the region states equal, which
 * the semantic simplification makes of `t.student = s.student` and an edit plants.
 */
type Student = "shared" | "one constant" | "different constants" | "equated"

interface SelfMatchShape {
	readonly head: Head
	readonly extra: Extra
	readonly keys: Keys
	readonly student: Student
}

/** A constant student is no variable a head can deliver, so keys a head delivers take only a student it binds. */
const selfMatchShapes: Gen<SelfMatchShape> = (source) => {
	const head = source.draw(element<Head>(["ordinal", "running maximum"]))
	const extra = source.draw(
		element<Extra>(["none", "on the second occurrence", "on the first occurrence"])
	)
	const keys = source.draw(element<Keys>(["student and id", "student", "id"]))
	const student = source.draw(
		element<Student>(
			keys === "id"
				? ["shared", "one constant", "different constants", "equated"]
				: ["shared", "equated"]
		)
	)
	return { head, extra, keys, student }
}

/** The checked self-match of a shape, its student constants edited apart where the shape plants that. */
const selfMatchDag = (shape: SelfMatchShape) => {
	const extra =
		shape.extra === "none"
			? []
			: [
					D.gt(
						shape.extra === "on the second occurrence" ? v("t.score") : s("score"),
						D.typedLit(1, Q.double)
					)
				]
	const q = checkedQuery(
		Q.selfMatch(shape.head === "ordinal" ? { ordinal: D.count() } : { top: D.max(v("t.score")) }, {
			...Q.plainSelfMatch,
			extra,
			keys:
				shape.keys === "student and id"
					? ["student", "id"]
					: shape.keys === "student"
						? ["student"]
						: ["id"],
			student: shape.student === "shared" || shape.student === "equated" ? s("student") : D.lit(1)
		})
	)
	if (shape.student === "equated") {
		return equatedStudents(q.dag)
	}
	if (shape.student !== "different constants") {
		return q.dag
	}
	const ed = new CatalogEditor(q.dag)
	const other = ed.expr({
		kind: "literal",
		value: { kind: "int", value: 2n },
		args: [],
		type: plainType("int4"),
		nonNull: "literal"
	})
	for (const cell of ed.cells()) {
		const n = cell.current
		if (!(n.kind === "MatchRegion" && n.occurrences.length === 2)) {
			continue
		}
		const [first, second] = n.occurrences
		if (first === undefined || second === undefined) {
			continue
		}
		const constantsOf = Arr.map(second.constants, (k) =>
			k.column === "student" ? { ...k, expr: other } : k
		)
		ed.redefine(cell, { ...n, occurrences: [first, { ...second, constants: constantsOf }] })
	}
	return ed.build()
}

/**
 * The self-match with the second occurrence's student bound to a variable of its own, which the region states equal to
 * the first's: the region equality the semantic simplification makes of `t.student = s.student`.
 */
const equatedStudents = (dag: RootedDag) => {
	const ed = new CatalogEditor(dag)
	for (const cell of ed.cells()) {
		const n = cell.current
		if (!(n.kind === "MatchRegion" && n.occurrences.length === 2)) {
			continue
		}
		const [first, second] = n.occurrences
		if (first === undefined || second === undefined) {
			continue
		}
		const shared = Option.getOrThrowWith(
			Arr.findFirst(second.bindings, (b) => b.column === "student"),
			() => new Error("the second occurrence binds the student")
		).var
		const own: VarDecl = { id: VarId("t.student"), name: "t_student", type: shared.type }
		const bindings = Arr.map(second.bindings, (b) =>
			b.column === "student" ? { ...b, var: own } : b
		)
		ed.redefine(cell, {
			...n,
			vars: [...n.vars, own],
			occurrences: [first, { ...second, bindings }],
			equalities: [...n.equalities, { a: shared, b: own }]
		})
	}
	return ed.build()
}

describe("R26 and R41: the self-match's own conditions", () => {
	it.effect(
		"windows a self-match exactly where the second occurrence is free, the keys determine a row and the key holds",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "either head, every further condition, every key set, and every student binding the key set can deliver",
						oracle: {
							kind: "specification",
							name: "R26's and R41's preconditions on a self-match (ordinal.ts): the second occurrence free, the keys determining a row, one student"
						},
						suite: "unit/lower/catalog/self-match-conditions",
						literal: Formatter.format,
						generator: selfMatchShapes,
						coverage: requiredInSpace<`${Head} ${"windowed" | "kept"}`>([
							"ordinal windowed",
							"ordinal kept",
							"running maximum windowed",
							"running maximum kept"
						]),
						caseHang,
						concurrency: 1
					},
					(shape, c) =>
						Effect.sync(() => {
							const r = succeeded(rewriteCatalog(selfMatchDag(shape), labOptions))
							const windowed =
								shape.extra !== "on the second occurrence" &&
								shape.keys !== "student" &&
								(shape.student === "shared" || shape.student === "one constant")
							c.note(`${shape.head} ${windowed ? "windowed" : "kept"}`)
							assert.deepEqual(rules(r), windowed ? [shape.head === "ordinal" ? "R26" : "R41"] : [])
						})
				)
			)
	)
})

/**
 * The fractions a percentile is drawn from: p = 0, dyadic fractions within (0, 1], 3/128 (dyadic at 2^7, the derived
 * bound) and 3/256 (dyadic, past it), the decimals 0.07, 0.1 and 0.3, whose products the numeric ceil can round, and
 * fractions outside [0, 1].
 */
const fractions = [
	0,
	1 / 64,
	3 / 128,
	3 / 256,
	0.07,
	0.1,
	0.25,
	0.3,
	0.375,
	0.5,
	63 / 64,
	1,
	1.5,
	-0.5
] as const

/**
 * The documented gate on a discrete fraction: within (0, 1], and m / 2^j with j at most 7 (percentile.ts
 * maxDyadicExponent, derived from PostgreSQL's stored-relation row bound and float8_numeric's digits), which the
 * product of 128 alone shows exactly.
 */
const discreteAdmits = (p: number): boolean => p > 0 && p <= 1 && Number.isInteger(p * 128)

type StageKind =
	| "ordinals joined on the group"
	| "ordinals not joined"
	| "a running conditional count"

const stageOf: Readonly<Record<StageKind, Q.PercentileStage>> = {
	"ordinals joined on the group": Q.ordinalStage,
	"ordinals not joined": { ...Q.ordinalStage, joined: false },
	"a running conditional count": { ...Q.ordinalStage, fold: "runningCount" }
}

describe("R29 and R30: percentiles", () => {
	it.effect(
		"selects PERCENTILE_DISC exactly for gated fractions over ordinals joined on the group",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "one or two of the fourteen fractions over each of three stages",
						oracle: {
							kind: "specification",
							name: "R29's gate: every fraction in (0, 1] and m / 2^j with j at most 7, over ordinals joined on the group (percentile.ts)"
						},
						suite: "unit/lower/catalog/discrete-percentile",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(array(element(fractions), { min: 1, max: 2 })),
								source.draw(
									element<StageKind>([
										"ordinals joined on the group",
										"ordinals not joined",
										"a running conditional count"
									])
								)
							] as const,
						coverage: requiredInSpace<"rewritten" | "a fraction refused" | "a stage refused">([
							"rewritten",
							"a fraction refused",
							"a stage refused"
						]),
						caseHang,
						concurrency: 1
					},
					([ps, stage], c) =>
						Effect.sync(() => {
							const gated = Arr.every(ps, discreteAdmits)
							const joined = stage === "ordinals joined on the group"
							c.note(!joined ? "a stage refused" : gated ? "rewritten" : "a fraction refused")
							assert.deepEqual(
								appliedTo(Q.discretePercentile(ps, stageOf[stage]), labOptions),
								gated && joined
									? ["R29"]
									: stage === "a running conditional count"
										? ["R41"]
										: ["R26"]
							)
						})
				)
			)
	)

	it.effect(
		"interpolates by PERCENTILE_CONT exactly for a fraction in [0, 1] of a double precision value",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "each of the fourteen fractions over a double precision or a numeric field",
						oracle: {
							kind: "specification",
							name: "R30's precondition: a fraction in [0, 1] of a double precision value (percentile.ts)"
						},
						suite: "unit/lower/catalog/continuous-percentile",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(element(fractions)),
								source.draw(element<"score" | "amount">(["score", "amount"]))
							] as const,
						coverage: requiredInSpace<"rewritten" | "kept">(["rewritten", "kept"]),
						caseHang,
						concurrency: 1
					},
					([p, over], c) =>
						Effect.sync(() => {
							const rewritten = p >= 0 && p <= 1 && over === "score"
							c.note(rewritten ? "rewritten" : "kept")
							assert.equal(
								appliedTo(Q.continuousPercentile(p, over), labOptions).includes("R30"),
								rewritten
							)
						})
				)
			)
	)
})

describe("R31: the mode", () => {
	it.effect(
		"takes MODE() exactly for take(1) of an unconditional count tied to the value ascending",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "either tiebreak direction, take(1) or take(2), an unconditional or a conditional count",
						oracle: {
							kind: "specification",
							name: "R31's precondition: take(1) of an unconditional count tied to the value ascending (mode.ts)"
						},
						suite: "unit/lower/catalog/mode",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(dirs),
								source.draw(int(1, 2)),
								source.draw(element<"all" | "conditional">(["all", "conditional"]))
							] as const,
						coverage: requiredInSpace<"rewritten" | "kept">(["rewritten", "kept"]),
						caseHang,
						concurrency: 1
					},
					([tiebreak, k, count], c) =>
						Effect.sync(() => {
							const rewritten = tiebreak === "asc" && k === 1 && count === "all"
							c.note(rewritten ? "rewritten" : "kept")
							assert.deepEqual(
								appliedTo(Q.modeOfDays(tiebreak, { k, count }), labOptions),
								rewritten ? ["R31"] : []
							)
						})
				)
			)
	)
})

/**
 * The neighbor and as-of compositions: a successor or predecessor, bound in a region or attached (to every sitting or
 * to the second occurrence of a match), and an as-of under <=, < or >=, bound or attached.
 */
type Neighbor =
	| { readonly kind: "bound neighbor"; readonly direction: "next" | "previous" }
	| {
			readonly kind: "attached neighbor"
			readonly direction: "next" | "previous"
			readonly parents: "sittings" | "pointed"
	  }
	| { readonly kind: "bound as-of"; readonly mode: "le" | "lt" | "ge" }
	| { readonly kind: "attached as-of"; readonly mode: "le" | "lt" | "ge" }

const neighborSides = element<"next" | "previous">(["next", "previous"])
const modes = element<"le" | "lt" | "ge">(["le", "lt", "ge"])

const neighbors = oneOf<Neighbor>([
	map(neighborSides, (direction): Neighbor => ({ kind: "bound neighbor", direction })),
	map(
		(source) =>
			[
				source.draw(neighborSides),
				source.draw(element<"sittings" | "pointed">(["sittings", "pointed"]))
			] as const,
		([direction, parents]): Neighbor => ({ kind: "attached neighbor", direction, parents })
	),
	map(modes, (mode): Neighbor => ({ kind: "bound as-of", mode })),
	map(modes, (mode): Neighbor => ({ kind: "attached as-of", mode }))
])

const neighborQuery = (n: Neighbor): QueryDesc =>
	n.kind === "bound neighbor"
		? Q.boundNeighbor(n.direction, [])
		: n.kind === "attached neighbor"
			? Q.attachedNeighbor(n.direction, n.parents)
			: n.kind === "bound as-of"
				? Q.boundAsOf(n.mode, [], "day")
				: Q.attachedAsOf(n.mode, [])

/**
 * The parent-set rule as the oracle (context.ts ParentPolicy, neighbor.ts): "bound" keeps the LATERAL probe of every
 * correlated take(1); a bound successor or as-of otherwise takes its window or pass, since its region's parents are no
 * bound set; an attached successor or as-of takes the whole-input target only where the parents are every row
 * ("whole"), since an attachment's delivered parents are a bound set that keeps the probe under "auto".
 */
const neighborRules = (n: Neighbor, parents: ParentPolicy): ReadonlyArray<CertificateRule> => {
	switch (n.kind) {
		case "bound neighbor":
			return parents === "bound" ? [] : ["R27"]
		case "attached neighbor":
			return parents === "whole" ? ["R27"] : []
		case "attached as-of":
			return parents === "whole" ? ["R42"] : []
		case "bound as-of":
			return parents === "bound" ? [] : ["R42"]
	}
}

const policies = element<ParentPolicy>(["auto", "bound", "whole"])

describe("R27 and R42: neighbors under the parent-set policy", () => {
	it.effect(
		"keeps the LATERAL probe for an attachment's bound parents under the automatic policy",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every neighbor and as-of composition, bound or attached, under every parent-set policy",
						oracle: {
							kind: "specification",
							name: "the parent-set rule (context.ts ParentPolicy, neighbor.ts)"
						},
						suite: "unit/lower/catalog/neighbor-parents",
						literal: Formatter.format,
						generator: (source) => [source.draw(neighbors), source.draw(policies)] as const,
						coverage: requiredInSpace<`${Neighbor["kind"]} ${"rewritten" | "probed"}`>([
							"bound neighbor rewritten",
							"bound neighbor probed",
							"attached neighbor rewritten",
							"attached neighbor probed",
							"bound as-of rewritten",
							"bound as-of probed",
							"attached as-of rewritten",
							"attached as-of probed"
						]),
						caseHang,
						concurrency: 1
					},
					([n, parents], c) =>
						Effect.sync(() => {
							const expected = neighborRules(n, parents)
							c.note(`${n.kind} ${expected.length > 0 ? "rewritten" : "probed"}`)
							assert.deepEqual(appliedTo(neighborQuery(n), { ...labOptions, parents }), expected)
						})
				)
			)
	)

	it.effect(
		"keeps an as-of comparing fields of different types, or whose take is ordered toward the parent",
		(ctx) => {
			type Edit = "none" | "the prices' day retyped bigint" | "the take's order reversed"
			return searched(
				ctx,
				exhaust(
					{
						box: "every as-of mode under no edit, its prices' day retyped bigint, or its take's order reversed",
						oracle: {
							kind: "specification",
							name: "R42's preconditions: fields of one type compared, a take ordered from the parent outward (neighbor.ts)"
						},
						suite: "unit/lower/catalog/as-of-edits",
						literal: Formatter.format,
						generator: (source) =>
							[
								source.draw(modes),
								source.draw(
									element<Edit>([
										"none",
										"the prices' day retyped bigint",
										"the take's order reversed"
									])
								)
							] as const,
						coverage: requiredInSpace<Edit>([
							"none",
							"the prices' day retyped bigint",
							"the take's order reversed"
						]),
						caseHang,
						concurrency: 1
					},
					([mode, edit], c) =>
						Effect.sync(() => {
							c.note(edit)
							const q = checkedQuery(Q.boundAsOf(mode, [], "day"))
							const ed = new CatalogEditor(q.dag)
							for (const cell of ed.cells()) {
								const n = cell.current
								if (
									edit === "the prices' day retyped bigint" &&
									n.kind === "Base" &&
									n.relation === "Price"
								) {
									ed.redefine(cell, {
										...n,
										heading: Arr.map(n.heading, (h) =>
											h.name === "day" ? { ...h, type: int8 } : h
										)
									})
								}
								if (edit === "the take's order reversed" && n.kind === "Take") {
									ed.redefine(cell, {
										...n,
										order: {
											keys: Arr.map(n.order.keys, (k) => ({
												...k,
												dir: opposite(k.dir)
											}))
										}
									})
								}
							}
							const region = Option.getOrThrowWith(
								Arr.findFirst(ed.cells(), (cell) => {
									const n = cell.current
									return (
										n.kind === "MatchRegion" &&
										Arr.some(n.occurrences, (o) => o.source.current.kind === "Take")
									)
								}),
								() => new Error("the as-of's region")
							)
							const recognized = Result.try({
								try: () => tryBoundNeighbor(new CatalogContext(ed, labOptions), region),
								catch: (thrown): unknown => thrown
							})
							assert.equal(
								Result.isFailure(recognized) && recognized.failure instanceof NoMatch,
								edit !== "none"
							)
						})
				)
			)
		}
	)
})

describe("R28: shares", () => {
	it.effect(
		"keeps a share whose total ranges over another binding set or whose join restricts the pairs",
		(ctx) => {
			type Share =
				| {
						readonly kind: "grouped"
						readonly over: "Sitting" | "Price" | "filtered"
						readonly restricted: boolean
				  }
				| { readonly kind: "keyed"; readonly restricted: boolean }
			const shares = oneOf<Share>([
				map(
					(source) =>
						[
							source.draw(
								element<"Sitting" | "Price" | "filtered">(["Sitting", "Price", "filtered"])
							),
							source.draw(boolean)
						] as const,
					([over, restricted]): Share => ({ kind: "grouped", over, restricted })
				),
				map(boolean, (restricted): Share => ({ kind: "keyed", restricted }))
			])
			return searched(
				ctx,
				exhaust(
					{
						box: "a grouped share over each of three totals, or a keyed share, each restricted or not",
						oracle: {
							kind: "specification",
							name: "R28's precondition: a total over the grouped count's own binding set, joined without restricting the pairs (share.ts)"
						},
						suite: "unit/lower/catalog/share",
						literal: Formatter.format,
						generator: shares,
						coverage: requiredInSpace<"rewritten" | "kept">(["rewritten", "kept"]),
						caseHang,
						concurrency: 1
					},
					(share, c) =>
						Effect.sync(() => {
							const rewritten =
								!share.restricted && (share.kind === "keyed" || share.over === "Sitting")
							c.note(rewritten ? "rewritten" : "kept")
							assert.deepEqual(
								appliedTo(
									share.kind === "grouped"
										? Q.groupedShare(share.over, share.restricted)
										: Q.keyedShare(share.restricted),
									labOptions
								),
								rewritten ? ["R28"] : []
							)
						})
				)
			)
		}
	)
})

/**
 * The compositions of every entry, under the automatic policy: the spellings' orders, percentiles, neighbors, shares,
 * modes.
 */
const compositions = oneOf<QueryDesc>([
	map(
		(source) => [source.draw(dirs), source.draw(dirs)] as const,
		(order) => Q.ordinal(order)
	),
	constant(Q.running(Q.plainSelfMatch)),
	map(array(element([0.25, 0.5, 0.07, 1]), { min: 1, max: 2 }), (ps) =>
		Q.discretePercentile(ps, Q.ordinalStage)
	),
	map(element([0, 0.5, 1.5]), (p) => Q.continuousPercentile(p, "score")),
	map(neighbors, neighborQuery),
	map(boolean, (restricted) => Q.groupedShare("Sitting", restricted)),
	map(dirs, (tiebreak) => Q.modeOfDays(tiebreak, Q.plainMode))
])

describe("determinism and the catalog pass", () => {
	it.effect(
		"produces byte-identical DAGs and SQL from identical input, and the pass records its certificates",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every composition of every entry under the automatic policy",
						oracle: {
							kind: "universal",
							name: "one input rewrites alike, byte for byte, and the pass records the rewrite's certificates"
						},
						suite: "unit/lower/catalog/determinism",
						literal: Formatter.format,
						generator: compositions,
						coverage: requiredInSpace<"rewritten" | "kept">(["rewritten", "kept"]),
						caseHang,
						concurrency: 1
					},
					(desc, c) =>
						Effect.sync(() => {
							const a = rewrite(desc, labOptions)
							const b = rewrite(desc, labOptions)
							c.note(a.r.certificates.length > 0 ? "rewritten" : "kept")
							assert.deepEqual(encode(a.r.dag, everyProperty), encode(b.r.dag, everyProperty))
							assert.deepEqual(sql(a.q, a.r), sql(b.q, b.r))
							const ctx = makePassContext({
								evidenceContext: "snapshot",
								catalog: labOptions.catalog
							})
							const out = succeeded(catalogPass("auto").run(a.q, ctx))
							assert.equal(out.dag.roots[0].id, a.q.dag.roots[0].id)
							assert.deepEqual(
								Arr.map(ctx.certificates.all(), (x) => x.rule),
								Arr.map(a.r.certificates, (x) => x.rule)
							)
						})
				)
			)
	)
})
