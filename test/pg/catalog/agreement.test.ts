import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { boolean, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import type { TestContext } from "vitest"
import { indices } from "#compiler/core/array.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import { canonicalZero } from "#compiler/ir/carriers.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { RelNode, ValidDag } from "#compiler/ir/rel.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import { Delivery } from "#compiler/lower/conservative/deliver.ts"
import type { CatalogOptions } from "#compiler/lower/shapes/catalog/context.ts"
import { CatalogEditor } from "#compiler/lower/shapes/catalog/edit.ts"
import { rewriteCatalog } from "#compiler/lower/shapes/catalog/rewrite.ts"
import * as Q from "#test/pg/catalog/queries.ts"
import {
	appliedRules,
	catalogLowering,
	type Facts,
	factsGen,
	labFacts,
	labOptions,
	oracleCase
} from "#test/pg/catalog/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { catalogDispatch } from "#test/support/compile.ts"
import type { AuthoredExprDesc, QueryDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import type { RawRow } from "#test/support/oracle/install/capture.ts"
import {
	conservative,
	defaultRunOptions,
	type Lowering,
	printOutcome,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import * as D from "#test/unit/check/dsl.ts"

const f8 = (value: number) => D.typedLit(value, Q.double)

/** The drawn lab facts each agreement explores: the rotating stream's cases, and a quarter as many in the floor's. */
const agreementRuns = 12

/**
 * The facts with a price of the first sitting's student, below 105, on the sitting's day and on the day before, which
 * every as-of mode and the cheap filter meet; and a sitting where the facts hold none.
 */
const withPricedSitting = (f: Facts, amount: number): Facts => {
	const [first] = f.sittings
	const sitting = first ?? ([1000, 1, 6, 1] as const)
	const [, student, day] = sitting
	return {
		...f,
		sittings: first === undefined ? [sitting] : f.sittings,
		prices: [...f.prices, [1001, student, day, amount], [1002, student, day - 1, amount]]
	}
}

/**
 * The facts a witness runs over, aimed at a delivered row while no witness has delivered one (Case.steering): half its
 * cases, by a draw of their own, priced for their first sitting (withPricedSitting); a rotating or kept case runs as
 * drawn.
 */
const aimedFacts = (f: Facts, c: Case<"delivers rows">): Facts =>
	Option.exists(c.steering, (pending) => pending.has("delivers rows")) && c.draw(boolean)
		? withPricedSitting(f, c.draw(int(0, 104)))
		: f

/**
 * Whether an entry's cases must deliver a row: a restricted shape whose answer is empty on most facts (a count bound to
 * another value) states that it need not.
 */
type Delivers = "rows" | "maybe none"

/**
 * The compile-target catalog agrees with its compositions on PostgreSQL 19 (R26-R31, R41, R42).
 *
 * Each entry's composition is written as an author writes it, checked, and lowered twice: composed (the conservative
 * lowering of the checked DAG) and native (the catalog's rewrite, its targets lowered by native.ts). Over drawn lab
 * facts (support.ts factsGen: small domains, so ties on a group's day and score, groups of one row and empty relations
 * come up), the two runs agree as raw text sets, the native run repeats no row, and the rewrite applies exactly
 * the entry's rules: a shape a recognizer must refuse applies none, so a dropped condition shows as a wrong answer. R42
 * is run in both forms: the LATERAL probe the composition already is, for an attachment's bound parent set, and the
 * ordered pass over whole inputs. Each entry's restrictions are run where they sit: Q's own predicates before the as-of
 * union, shared constants before the windows, first-occurrence conditions after them.
 *
 * Planted facts hold what a drawn population of small groups cannot: the percentile disagreements the catalog documents
 * (p = 0, which the recognizer refuses because the native form returns the first value where ceil(0) selects no
 * ordinal, and 0.07 · 100 over a group of a hundred, which it refuses because the composition's numeric ceil rounds the
 * product where the native form does not). R24 is the aggregate shapes', held by test/pg/lower-shapes over generated
 * groups.
 *
 * One entry's agreement over drawn lab facts.
 */
const agree = (
	t: TestContext,
	label: string,
	desc: QueryDesc,
	rules: ReadonlyArray<CertificateRule>,
	options: CatalogOptions,
	delivers: Delivers
) =>
	searched(
		t,
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema({ create: false, label: "catalog" })
			const side = catalogLowering(options)
			/**
			 * Planted: the lab's facts, on which an entry whose cases must deliver a row delivers one; the drawn facts of
			 * small groups do so in five to twelve of fifteen cases.
			 */
			const kept: ReadonlyArray<Kept<Facts, "delivers rows">> =
				delivers === "rows"
					? [{ note: "the lab's facts", sketch: labFacts, draws: "", reaches: ["delivers rows"] }]
					: []
			return yield* explore(
				{
					suite: `catalog/${label}`,
					draw: drawn(factsGen),
					literal: Formatter.format,
					coverage:
						delivers === "rows"
							? required<"delivers rows">(["delivers rows"], {
									cases: agreementRuns,
									sense: notesOnly
								})
							: noCoverage,
					kept,
					runs: agreementRuns,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(drawnFacts, c) =>
					Effect.gen(function* () {
						const f = aimedFacts(drawnFacts, c)
						const outcome = yield* runLabelledOracle(
							oracleCase(label, desc, f),
							conservative,
							side,
							{
								...defaultRunOptions,
								schema: { kind: "named", name: schema }
							}
						)
						assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
						assert.deepEqual(appliedRules(side.last()), Arr.sort([...rules], Order.String), label)
						if (Arr.some(outcome.right.run.statements, (st) => st.rows.length > 0)) {
							c.note("delivers rows")
						}
					})
			)
		})
	)

/** One entry's agreement over planted facts. */
const agreeOn = (label: string, desc: QueryDesc, rules: ReadonlyArray<CertificateRule>, f: Facts) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label: "catalog" })
		const side = catalogLowering(labOptions)
		const outcome = yield* runLabelledOracle(oracleCase(label, desc, f), conservative, side, {
			...defaultRunOptions,
			schema: { kind: "named", name: schema }
		})
		assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
		assert.deepEqual(appliedRules(side.last()), Arr.sort([...rules], Order.String), label)
		return outcome
	})

const whole: CatalogOptions = { ...labOptions, parents: "whole" }
const bound: CatalogOptions = { ...labOptions, parents: "bound" }

/** The rows a side's statements delivered. */
const rowsOf = (o: {
	readonly run: { readonly statements: ReadonlyArray<{ readonly rows: ReadonlyArray<RawRow> }> }
}): ReadonlyArray<RawRow> => Arr.flatMap(o.run.statements, (st) => st.rows)

/**
 * A group of a hundred sittings of student 1, on days and scores 1 to 100: the planted group the 0.07 · 100 and 0.375 ·
 * 100 gates need, which a drawn population of small groups never holds.
 */
const hundred: Facts = {
	...labFacts,
	sittings: Arr.map(indices(100), (k) => [k + 1, 1, k + 1, k + 1] as const)
}

/** The native targets an entry's rewrite over the lab's facts names: its windows' and ordered-set aggregates' overloads. */
const nativeTargets = (desc: QueryDesc): ReadonlyArray<string> => {
	const r = rewriteCatalog(oracleCase("ops", desc, labFacts).query.dag, labOptions)
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return Arr.flatMap(topoOrder(r.value.dag), (n): ReadonlyArray<string> =>
		n.kind === "Window" || n.kind === "OrderedSetAggregate" ? [n.op] : []
	)
}

/** The five as-of agreements of one comparison mode: bound and attached, ordered and LATERAL, and over a filtered Q. */
const asOfAgreements = (
	t: TestContext,
	mode: "le" | "lt" | "ge",
	cheap: ReadonlyArray<AuthoredExprDesc>
) =>
	Effect.gen(function* () {
		yield* agree(
			t,
			`as-of ${mode} bound, ordered`,
			Q.boundAsOf(mode, [], "day"),
			["R42"],
			labOptions,
			"rows"
		)
		yield* agree(
			t,
			`as-of ${mode} attached, ordered`,
			Q.attachedAsOf(mode, []),
			["R42"],
			whole,
			"rows"
		)
		yield* agree(
			t,
			`as-of ${mode} attached, LATERAL`,
			Q.attachedAsOf(mode, []),
			[],
			labOptions,
			"rows"
		)
		yield* agree(t, `as-of ${mode} bound, LATERAL`, Q.boundAsOf(mode, [], "day"), [], bound, "rows")
		yield* agree(
			t,
			`as-of ${mode} over prices below 105`,
			Q.boundAsOf(mode, cheap, "day"),
			["R42"],
			labOptions,
			"rows"
		)
	})

layer(Substrate.layer)("the compile-target catalog against its compositions", (it) => {
	it.effect("every native target names an overload PostgreSQL 19 has", () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const ops = new Set(
				Arr.flatMap(
					[
						Q.running(Q.plainSelfMatch),
						Q.boundNeighbor("next", []),
						Q.boundAsOf("le", [], "day"),
						Q.groupedShare("Sitting", false),
						Q.keyedShare(false),
						Q.discretePercentile([0.5], Q.ordinalStage),
						Q.continuousPercentile(0.5, "score"),
						Q.modeOfDays("asc", Q.plainMode)
					],
					nativeTargets
				)
			)
			assert.notEqual(ops.size, 0, "a native target")
			for (const op of ops) {
				const rows = yield* s.admin.queryValues("SELECT to_regprocedure($1)::text", [op])
				assert.equal(rows[0]?.[0], op, op)
			}
		})
	)

	it.effect("R26: ordinals agree with the self-join count, ascending, descending and mixed", (t) =>
		Effect.gen(function* () {
			yield* agree(t, "ordinal asc", Q.ordinal(["asc", "asc"]), ["R26"], labOptions, "rows")
			yield* agree(t, "ordinal desc (>=)", Q.ordinal(["desc", "desc"]), ["R26"], labOptions, "rows")
			yield* agree(
				t,
				"ordinal day desc, id asc",
				Q.ordinal(["desc", "asc"]),
				["R26"],
				labOptions,
				"rows"
			)
		})
	)

	it.effect(
		"R41: running sums, extrema, means and conditional counts agree, where no row qualifies too",
		(t) =>
			agree(
				t,
				"running aggregates",
				Q.running(Q.plainSelfMatch),
				["R26", "R41"],
				labOptions,
				"rows"
			)
	)

	it.effect(
		"R26 and R41: shared constants restrict before the windows, first-occurrence conditions after",
		(t) =>
			Effect.gen(function* () {
				/** A condition on the first occurrence keeps the rows it selects with their positions among every row. */
				const firstAbove3 = Q.running({
					...Q.plainSelfMatch,
					extra: [D.gt(D.ref("Sitting", "score"), f8(3))]
				})
				yield* agree(
					t,
					"running, first occurrence above 3",
					firstAbove3,
					["R26", "R41"],
					labOptions,
					"rows"
				)
				/** Both occurrences fixed to one student: the windows run over that student's rows only. */
				const oneStudent = Q.running({ ...Q.plainSelfMatch, student: D.lit(1), keys: ["id"] })
				yield* agree(
					t,
					"running, student 1 on both occurrences",
					oneStudent,
					["R26", "R41"],
					labOptions,
					"rows"
				)
			})
	)

	it.effect(
		"R27: successors and predecessors agree with the LATERAL take(1), bound and attached",
		(t) =>
			Effect.gen(function* () {
				yield* agree(t, "successor bound", Q.boundNeighbor("next", []), ["R27"], labOptions, "rows")
				yield* agree(
					t,
					"predecessor bound",
					Q.boundNeighbor("previous", []),
					["R27"],
					labOptions,
					"rows"
				)
				yield* agree(
					t,
					"successor attached, whole parents",
					Q.attachedNeighbor("next", "sittings"),
					["R27"],
					whole,
					"rows"
				)
				yield* agree(
					t,
					"predecessor attached, whole parents",
					Q.attachedNeighbor("previous", "sittings"),
					["R27"],
					whole,
					"rows"
				)
				/**
				 * Parents from the match's second occurrence, restricted by its first: the sittings whose score is some
				 * point's x. The window still runs over every sitting of the student.
				 */
				const secondOccurrence = Q.attachedNeighbor("next", "pointed")
				yield* agree(
					t,
					"successor attached to a second occurrence",
					secondOccurrence,
					["R27"],
					whole,
					"maybe none"
				)
				/**
				 * An attachment's delivered parents are a bound set. R27 puts the window in the parent statement, but an
				 * attachment statement receives only the delivered parents' columns, so the child would have to compute the
				 * window over all of Q itself: the LATERAL probe stays until the parent statement can carry the LEAD columns
				 * to its attachments.
				 */
				const boundParents = Q.attachedNeighbor("next", "sittings")
				yield* agree(t, "successor attached, bound parents", boundParents, [], labOptions, "rows")
				/**
				 * A restricted Q is no successor in the parent's own source: R27 refuses it, and the strict as-of mirror
				 * takes the nearest qualifying row past the parent.
				 */
				const restricted = Q.boundNeighbor("next", [D.gt(D.varRef("n.score"), f8(3))])
				yield* agree(t, "successor of a restricted source", restricted, ["R42"], labOptions, "rows")
			})
	)

	it.effect(
		"R42: as-of agrees in both forms, at equal prefixes, before the first Q row and with no Q rows",
		(t) =>
			Effect.gen(function* () {
				/**
				 * A predicate on Q alone filters Q before the union: a sitting whose nearest price fails it falls back to
				 * an earlier qualifying one, or to none.
				 */
				const cheap = [D.lt(D.varRef("p.amount"), D.lit(105n))]
				yield* asOfAgreements(t, "le", cheap)
				yield* asOfAgreements(t, "lt", cheap)
				yield* asOfAgreements(t, "ge", cheap)
				yield* agree(
					t,
					"as-of le over prices below 105, attached",
					Q.attachedAsOf("le", cheap),
					["R42"],
					whole,
					"rows"
				)
			})
	)

	it.effect("R28: shares of the total agree, grouped and keyed", (t) =>
		Effect.gen(function* () {
			yield* agree(
				t,
				"grouped share",
				Q.groupedShare("Sitting", false),
				["R28"],
				labOptions,
				"rows"
			)
			yield* agree(t, "keyed share", Q.keyedShare(false), ["R28"], labOptions, "rows")
			/** Joins that restrict the pairs keep the composition: the windows over every row would drop the restriction. */
			const restrictedPairs = Q.keyedShare(true)
			yield* agree(
				t,
				"keyed share, count bound to the id",
				restrictedPairs,
				[],
				labOptions,
				"maybe none"
			)
			yield* agree(
				t,
				"grouped share, count bound to the total",
				Q.groupedShare("Sitting", true),
				[],
				labOptions,
				"maybe none"
			)
			yield* agree(
				t,
				"grouped share over another relation",
				Q.groupedShare("Price", false),
				[],
				labOptions,
				"rows"
			)
			yield* agree(
				t,
				"grouped share over a filtered total",
				Q.groupedShare("filtered", false),
				[],
				labOptions,
				"rows"
			)
		})
	)

	it.effect("R29 and R30: percentiles agree with the selections by ordinal", (t) =>
		Effect.gen(function* () {
			yield* agree(
				t,
				"median (disc)",
				Q.discretePercentile([0.5], Q.ordinalStage),
				["R29"],
				labOptions,
				"rows"
			)
			yield* agree(
				t,
				"quartiles (disc, two fractions)",
				Q.discretePercentile([0.25, 0.75], Q.ordinalStage),
				["R29"],
				labOptions,
				"rows"
			)
			yield* agree(
				t,
				"maximum (disc, p = 1)",
				Q.discretePercentile([1], Q.ordinalStage),
				["R29"],
				labOptions,
				"rows"
			)
			yield* agree(
				t,
				"median (cont)",
				Q.continuousPercentile(0.5, "score"),
				["R30"],
				labOptions,
				"rows"
			)
			yield* agree(
				t,
				"first quartile (cont)",
				Q.continuousPercentile(0.25, "score"),
				["R30"],
				labOptions,
				"rows"
			)
			yield* agree(
				t,
				"p = 0 (cont)",
				Q.continuousPercentile(0, "score"),
				["R30"],
				labOptions,
				"rows"
			)
			/**
			 * Stages the selection must not be read through: an ordinal stage that leaves the group unbound meets every
			 * group's count, and a running conditional count is a fold of the same self-match but no position.
			 */
			const unjoined = Q.discretePercentile([0.5], { ...Q.ordinalStage, joined: false })
			yield* agree(
				t,
				"median, ordinals not joined on the group",
				unjoined,
				["R26"],
				labOptions,
				"maybe none"
			)
			yield* agree(
				t,
				"median over a running conditional count",
				Q.discretePercentile([0.5], { ...Q.ordinalStage, fold: "runningCount" }),
				["R41"],
				labOptions,
				"maybe none"
			)
		})
	)

	it.effect("R29 records the documented disagreements: p = 0 and 0.07 · 100", () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema({ create: false, label: "catalog" })
			/**
			 * The native form at fraction p, forced: the same query at p = 0.5, rewritten, its fraction replaced by p.
			 */
			const forced = (p: number): Lowering => ({
				name: `native at p = ${p}`,
				lower: ({ names }) => {
					const half = oracleCase("p = 0.5", Q.discretePercentile([0.5], Q.ordinalStage), labFacts)
					const rewritten = rewriteCatalog(half.query.dag, labOptions)
					if (!rewritten.ok) {
						return rewritten
					}
					const ed = new CatalogEditor(rewritten.value.dag)
					const cell = Option.getOrThrowWith(
						Arr.findFirst(ed.cells(), (c) => c.current.kind === "OrderedSetAggregate"),
						() => new Error("an OrderedSetAggregate node")
					)
					const osa = cell.current
					if (osa.kind !== "OrderedSetAggregate") {
						throw new Error("an OrderedSetAggregate node")
					}
					const spec = defined(osa.fractions[0], "a fraction")
					if (spec.kind !== "literal") {
						throw new Error("a literal fraction")
					}
					const literal = ed.expr({ ...spec, value: { kind: "float", value: canonicalZero(p) } })
					ed.redefine(cell, { ...osa, fractions: [literal] })
					const built = ed.build()
					return lowerNative(built, built.roots[0], names)
				}
			})

			/**
			 * p = 0: the recognizer keeps the composition (the inner ordinals still take R26), which selects nothing;
			 * the native form returns each group's first value, the recorded disagreement.
			 */
			const zero = Q.discretePercentile([0], Q.ordinalStage)
			const composedZero = yield* agreeOn("p = 0", zero, ["R26"], labFacts)
			assert.deepEqual(rowsOf(composedZero.left), [])
			const native = yield* runLabelledOracle(
				oracleCase("p = 0", zero, labFacts),
				conservative,
				forced(0),
				{
					...defaultRunOptions,
					schema: { kind: "named", name: schema }
				}
			)
			assert.equal(native.comparison.equal, false, printOutcome(native))
			/**
			 * 0.07 · 100 = 7.000000000000001 in double precision: the composition's numeric ceil keeps 15 digits and
			 * selects the seventh value, the native aggregate the eighth. The recognizer keeps the composition; the
			 * forced native form records the disagreement.
			 */
			const p7 = Q.discretePercentile([0.07], Q.ordinalStage)
			yield* agreeOn("0.07 of 100", p7, ["R26"], hundred)
			const nativeP7 = yield* runLabelledOracle(
				oracleCase("0.07 of 100", p7, hundred),
				conservative,
				forced(0.07),
				{
					...defaultRunOptions,
					schema: { kind: "named", name: schema }
				}
			)
			assert.equal(nativeP7.comparison.equal, false, printOutcome(nativeP7))
			/** A dyadic fraction of the same group, which the recognizer admits, agrees: 0.375 · 100 is 37.5 exactly. */
			const dyadic = Q.discretePercentile([0.375], Q.ordinalStage)
			yield* agreeOn("0.375 of 100", dyadic, ["R29"], hundred)
		})
	)

	it.effect("R31: the mode agrees with the count-and-take, ties to the smallest value", (t) =>
		agree(t, "mode of days", Q.modeOfDays("asc", Q.plainMode), ["R31"], labOptions, "rows")
	)
})

const lowerNative = (dag: ValidDag, root: RelNode, names: PhysicalNames) =>
	catchRefusal(() =>
		new Delivery(
			new LowerContext(
				dag,
				{
					names,
					params: [],
					subject: { kind: "query" }
				},
				catalogDispatch
			)
		).program(root)
	)
