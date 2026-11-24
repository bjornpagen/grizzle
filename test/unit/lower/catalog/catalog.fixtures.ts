/** What the properties of catalog.test.ts read: its spaces, models and helpers. */

import { array, boolean, constant, element, type Gen, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import { catchRefusal } from "#compiler/core/canonical.ts"
import { VarId } from "#compiler/core/ids.ts"
import { type Direction, directions } from "#compiler/core/order.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Rooted, RootedDag, VarDecl } from "#compiler/ir/rel.ts"
import {
	carriesNothing,
	evaluatedAsItStands,
	LowerContext
} from "#compiler/lower/conservative/context.ts"
import { ConservativeDelivery } from "#compiler/lower/conservative/deliver.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { type CatalogOptions, type ParentPolicy } from "#compiler/lower/shapes/catalog/context.ts"
import { CatalogEditor } from "#compiler/lower/shapes/catalog/edit.ts"
import { type CatalogResult, rewriteCatalog } from "#compiler/lower/shapes/catalog/rewrite.ts"
import { plainType } from "#compiler/scalar/native.ts"
import * as Q from "#test/pg/catalog/queries.ts"
import { checkedQuery, lab } from "#test/pg/catalog/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { catalogDispatch } from "#test/support/compile.ts"
import type { AuthoredExprDesc as ExprDesc, QueryDesc } from "#test/support/fixtures/ir/desc.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import * as D from "#test/unit/check/dsl.ts"

export const int8 = plainType("int8")

export const rewrite = (
	desc: QueryDesc,
	options: CatalogOptions
): { readonly q: LogicalQuery; readonly r: CatalogResult<Rooted> } => {
	const q = checkedQuery(desc)
	return { q, r: succeeded(rewriteCatalog(q.dag, options)) }
}

/** The entries a rewrite applied, each once, in order. */
export const rules = (r: CatalogResult): ReadonlyArray<CertificateRule> =>
	Arr.sort([...new Set(Arr.map(r.certificates, (c) => c.rule))], Order.String)

export const appliedTo = (
	desc: QueryDesc,
	options: CatalogOptions
): ReadonlyArray<CertificateRule> => rules(rewrite(desc, options).r)

export const sql = (q: LogicalQuery, r: CatalogResult<Rooted>): ReadonlyArray<string> =>
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
							catalogDispatch,
							evaluatedAsItStands,
							carriesNothing
						)
					).program(r.dag.roots[0])
				)
			).roots
		),
		(s) => s.sql.text
	)

const v = D.varRef

const s = (f: string) => D.ref("Sitting", f)

export const dirs = element(directions)

/**
 * The spellings of "t before s" over (day, id) under per-field directions, inclusive or strict: the nested expansion,
 * its disjunctive normal form, each comparison with its operands swapped, the negation of the strict or inclusive
 * successor, and a conjunction of field comparisons, which is no lexicographic order.
 */
export type Spelling =
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

export const spelled = (
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

export const windowsOf = (r: CatalogResult) =>
	Arr.flatMap(topoOrder(r.dag), (n) => (n.kind === "Window" ? [n] : []))

/** The fold a self-match's head computes: its ordinal, or a running maximum of the second occurrence's score. */
export type Head = "ordinal" | "running maximum"

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
export const selfMatchShapes: Gen<SelfMatchShape> = (source) => {
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
export const selfMatchDag = (shape: SelfMatchShape) => {
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

/**
 * The fractions a percentile is drawn from: p = 0, dyadic fractions within (0, 1], 3/128 (dyadic at 2^7, the derived
 * bound) and 3/256 (dyadic, past it), the decimals 0.07, 0.1 and 0.3, whose products the numeric ceil can round, and
 * fractions outside [0, 1].
 */
export const fractions = [
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
export const discreteAdmits = (p: number): boolean => p > 0 && p <= 1 && Number.isInteger(p * 128)

export type StageKind =
	| "ordinals joined on the group"
	| "ordinals not joined"
	| "a running conditional count"

export const stageOf: Readonly<Record<StageKind, Q.PercentileStage>> = {
	"ordinals joined on the group": Q.ordinalStage,
	"ordinals not joined": { ...Q.ordinalStage, joined: false },
	"a running conditional count": { ...Q.ordinalStage, fold: "runningCount" }
}

/**
 * The neighbor and as-of compositions: a successor or predecessor, bound in a region or attached (to every sitting or
 * to the second occurrence of a match), and an as-of under <=, < or >=, bound or attached.
 */
export type Neighbor =
	| { readonly kind: "bound neighbor"; readonly direction: "next" | "previous" }
	| {
			readonly kind: "attached neighbor"
			readonly direction: "next" | "previous"
			readonly parents: "sittings" | "pointed"
	  }
	| { readonly kind: "bound as-of"; readonly mode: "le" | "lt" | "ge" }
	| { readonly kind: "attached as-of"; readonly mode: "le" | "lt" | "ge" }

const neighborSides = element<"next" | "previous">(["next", "previous"])

export const modes = element<"le" | "lt" | "ge">(["le", "lt", "ge"])

export const neighbors = oneOf<Neighbor>([
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

export const neighborQuery = (n: Neighbor): QueryDesc =>
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
export const neighborRules = (
	n: Neighbor,
	parents: ParentPolicy
): ReadonlyArray<CertificateRule> => {
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

export const policies = element<ParentPolicy>(["auto", "bound", "whole"])

/**
 * The compositions of every entry, under the automatic policy: the spellings' orders, percentiles, neighbors, shares,
 * modes.
 */
export const compositions = oneOf<QueryDesc>([
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

export type Edit = "none" | "the prices' day retyped bigint" | "the take's order reversed"

type Share =
	| {
			readonly kind: "grouped"
			readonly over: "Sitting" | "Price" | "filtered"
			readonly restricted: boolean
	  }
	| { readonly kind: "keyed"; readonly restricted: boolean }

export const shares = oneOf<Share>([
	map(
		(source) =>
			[
				source.draw(element<"Sitting" | "Price" | "filtered">(["Sitting", "Price", "filtered"])),
				source.draw(boolean)
			] as const,
		([over, restricted]): Share => ({ kind: "grouped", over, restricted })
	),
	map(boolean, (restricted): Share => ({ kind: "keyed", restricted }))
])
