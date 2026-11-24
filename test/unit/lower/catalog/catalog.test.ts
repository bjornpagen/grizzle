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
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, boolean, element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { opposite } from "#compiler/core/order.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import { soleOrder } from "#compiler/ir/rel.ts"
import { CatalogContext } from "#compiler/lower/shapes/catalog/context.ts"
import { CatalogEditor } from "#compiler/lower/shapes/catalog/edit.ts"
import { NoMatch } from "#compiler/lower/shapes/catalog/exprs.ts"
import { tryBoundNeighbor } from "#compiler/lower/shapes/catalog/neighbor.ts"
import { catalogPass, rewriteCatalog } from "#compiler/lower/shapes/catalog/rewrite.ts"
import * as Q from "#test/pg/catalog/queries.ts"
import { checkedQuery, labOptions } from "#test/pg/catalog/support.ts"
import { succeeded } from "#test/support/assert.ts"
import * as D from "#test/unit/check/dsl.ts"
import {
	appliedTo,
	compositions,
	dirs,
	discreteAdmits,
	type Edit,
	fractions,
	type Head,
	int8,
	modes,
	type Neighbor,
	neighborQuery,
	neighborRules,
	neighbors,
	policies,
	rewrite,
	rules,
	selfMatchDag,
	selfMatchShapes,
	shares,
	spelled,
	type Spelling,
	sql,
	type StageKind,
	stageOf,
	windowsOf
} from "#test/unit/lower/catalog/catalog.fixtures.ts"

/** R26: the lexicographic comparison in any spelling recognizes the inclusive order in every spelling and direction, and orders the window as spelled. */
export const r26TheLexicographicComparisonInAnySpellingRecognizesTheInclusiveOrderInEverySpellingAndDirectionAndOrdersTheWindowAsSpelled =
	property.exhaust(
		finite(
			(source) =>
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
				] as const
		),
		{
			needs: {},
			situations: [
				"nested recognized",
				"nested kept",
				"disjunctive normal form recognized",
				"operands swapped recognized",
				"negated successor recognized",
				"conjunctive kept"
			] satisfies ReadonlyArray<Reached<`${Spelling} ${"recognized" | "kept"}`>>,
			check:
				(_, c: Case<`${Spelling} ${"recognized" | "kept"}`>) =>
				([spelling, order, inclusive]) =>
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
					}),
			oracle: {
				kind: "specification",
				name: "R26's precondition: an inclusive lexicographic comparison of paired fields, in any spelling (ordinal.ts, lexicographic.ts)"
			},
			box: "each of five spellings (nested, its disjunctive normal form, operands swapped, the negated successor, a conjunction of field comparisons), each direction of each of two fields, inclusive or strict",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/catalog/ordinal.ts",
					original:
						'\t\tdemand(l.inclusive, "the inclusive comparison: the strict one makes the first row vanish")\n',
					replacement: "",
					why: "The self-match recognizer (ordinal.ts) no longer demands the inclusive comparison, so the strict order is recognized; the R26 spelling search fails."
				}
			]
		}
	)

/** R26 and R41: the self-match's own conditions windows a self-match exactly where the second occurrence is free, the keys determine a row and the key holds. */
export const r26AndR41TheSelfMatchsOwnConditionsWindowsASelfMatchExactlyWhereTheSecondOccurrenceIsFreeTheKeysDetermineARowAndTheKeyHolds =
	property.exhaust(finite(selfMatchShapes), {
		needs: {},
		situations: [
			"ordinal windowed",
			"ordinal kept",
			"running maximum windowed",
			"running maximum kept"
		] satisfies ReadonlyArray<Reached<`${Head} ${"windowed" | "kept"}`>>,
		check: (_, c: Case<`${Head} ${"windowed" | "kept"}`>) => (shape) =>
			Effect.sync(() => {
				const r = succeeded(rewriteCatalog(selfMatchDag(shape), labOptions))
				const windowed =
					shape.extra !== "on the second occurrence" &&
					shape.keys !== "student" &&
					(shape.student === "shared" || shape.student === "one constant")
				c.note(`${shape.head} ${windowed ? "windowed" : "kept"}`)
				assert.deepEqual(rules(r), windowed ? [shape.head === "ordinal" ? "R26" : "R41"] : [])
			}),
		oracle: {
			kind: "specification",
			name: "R26's and R41's preconditions on a self-match (ordinal.ts): the second occurrence free, the keys determining a row, one student"
		},
		box: "either head, every further condition, every key set, and every student binding the key set can deliver",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/catalog/ordinal.ts",
				original:
					'\t\tdemand(\n\t\t\tconstantsOf(second).every((c) => isShared(c.column)),\n\t\t\t"no constant on the second occurrence alone (it would restrict the counted rows)"\n\t\t)\n',
				replacement: "",
				why: "The self-match recognizer no longer demands that every constant of the second occurrence be shared, so a constant on the second occurrence alone is admitted; the self-match search fails."
			}
		]
	})

/** R29 and R30: percentiles selects PERCENTILE_DISC exactly for gated fractions over ordinals joined on the group. */
export const r29AndR30PercentilesSelectsPERCENTILEDISCExactlyForGatedFractionsOverOrdinalsJoinedOnTheGroup =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(array(element(fractions), { min: 1, max: 2 })),
					source.draw(
						element<StageKind>([
							"ordinals joined on the group",
							"ordinals not joined",
							"a running conditional count"
						])
					)
				] as const
		),
		{
			needs: {},
			situations: ["rewritten", "a fraction refused", "a stage refused"] satisfies ReadonlyArray<
				Reached<"rewritten" | "a fraction refused" | "a stage refused">
			>,
			check:
				(_, c: Case<"rewritten" | "a fraction refused" | "a stage refused">) =>
				([ps, stage]) =>
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
					}),
			oracle: {
				kind: "specification",
				name: "R29's gate: every fraction in (0, 1] and m / 2^j with j at most 7, over ordinals joined on the group (percentile.ts)"
			},
			box: "one or two of the fourteen fractions over each of three stages",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/catalog/percentile.ts",
					original: '\t\t\tdemand(s.p > 0 && s.p <= 1, "a fraction in (0, 1]")',
					replacement: '\t\t\tdemand(s.p >= 0 && s.p <= 1, "a fraction in (0, 1]")',
					why: "R29's gate (percentile.ts) admits a fraction of 0; the discrete percentile search fails."
				}
			]
		}
	)

/** R29 and R30: percentiles interpolates by PERCENTILE_CONT exactly for a fraction in [0, 1] of a double precision value. */
export const r29AndR30PercentilesInterpolatesByPERCENTILECONTExactlyForAFractionIn01OfADoublePrecisionValue =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element(fractions)),
					source.draw(element<"score" | "amount">(["score", "amount"]))
				] as const
		),
		{
			needs: {},
			situations: ["rewritten", "kept"] satisfies ReadonlyArray<Reached<"rewritten" | "kept">>,
			check:
				(_, c: Case<"rewritten" | "kept">) =>
				([p, over]) =>
					Effect.sync(() => {
						const rewritten = p >= 0 && p <= 1 && over === "score"
						c.note(rewritten ? "rewritten" : "kept")
						assert.equal(
							appliedTo(Q.continuousPercentile(p, over), labOptions).includes("R30"),
							rewritten
						)
					}),
			oracle: {
				kind: "specification",
				name: "R30's precondition: a fraction in [0, 1] of a double precision value (percentile.ts)"
			},
			box: "each of the fourteen fractions over a double precision or a numeric field",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/catalog/percentile.ts",
					original: '\tdemand(p >= 0 && p <= 1, "a fraction in [0, 1]")',
					replacement: '\tdemand(p >= 0, "a fraction in [0, 1]")',
					why: "R30's gate admits any fraction of at least 0, 1.5 among them; the continuous percentile search fails."
				}
			]
		}
	)

/** R31: the mode takes MODE() exactly for take(1) of an unconditional count tied to the value ascending. */
export const r31TheModeTakesMODEExactlyForTake1OfAnUnconditionalCountTiedToTheValueAscending =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(dirs),
					source.draw(int(1, 2)),
					source.draw(element<"all" | "conditional">(["all", "conditional"]))
				] as const
		),
		{
			needs: {},
			situations: ["rewritten", "kept"] satisfies ReadonlyArray<Reached<"rewritten" | "kept">>,
			check:
				(_, c: Case<"rewritten" | "kept">) =>
				([tiebreak, k, count]) =>
					Effect.sync(() => {
						const rewritten = tiebreak === "asc" && k === 1 && count === "all"
						c.note(rewritten ? "rewritten" : "kept")
						assert.deepEqual(
							appliedTo(Q.modeOfDays(tiebreak, { k, count }), labOptions),
							rewritten ? ["R31"] : []
						)
					}),
			oracle: {
				kind: "specification",
				name: "R31's precondition: take(1) of an unconditional count tied to the value ascending (mode.ts)"
			},
			box: "either tiebreak direction, take(1) or take(2), an unconditional or a conditional count",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/catalog/mode.ts",
					original: '\t\t\tsecond?.column === value &&\n\t\t\tsecond.dir === "asc",',
					replacement: "\t\t\tsecond?.column === value,",
					why: "The mode recognizer (mode.ts) no longer reads the tiebreak's direction, so a value tied descending is admitted; the R31 search fails."
				}
			]
		}
	)

/** R27 and R42: neighbors under the parent-set policy keeps the LATERAL probe for an attachment's bound parents under the automatic policy. */
export const r27AndR42NeighborsUnderTheParentSetPolicyKeepsTheLATERALProbeForAnAttachmentsBoundParentsUnderTheAutomaticPolicy =
	property.exhaust(
		finite((source) => [source.draw(neighbors), source.draw(policies)] as const),
		{
			needs: {},
			situations: [
				"bound neighbor rewritten",
				"bound neighbor probed",
				"attached neighbor rewritten",
				"attached neighbor probed",
				"bound as-of rewritten",
				"bound as-of probed",
				"attached as-of rewritten",
				"attached as-of probed"
			] satisfies ReadonlyArray<Reached<`${Neighbor["kind"]} ${"rewritten" | "probed"}`>>,
			check:
				(_, c: Case<`${Neighbor["kind"]} ${"rewritten" | "probed"}`>) =>
				([n, parents]) =>
					Effect.sync(() => {
						const expected = neighborRules(n, parents)
						c.note(`${n.kind} ${expected.length > 0 ? "rewritten" : "probed"}`)
						assert.deepEqual(appliedTo(neighborQuery(n), { ...labOptions, parents }), expected)
					}),
			oracle: {
				kind: "specification",
				name: "the parent-set rule (context.ts ParentPolicy, neighbor.ts)"
			},
			box: "every neighbor and as-of composition, bound or attached, under every parent-set policy",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/catalog/neighbor.ts",
					original: '\t\tpolicy === "whole",',
					replacement: '\t\tpolicy !== "bound",',
					why: "The attached neighbor (neighbor.ts) takes an attachment's bound parents whole under the automatic policy; the parent-set search fails."
				}
			]
		}
	)

/** R27 and R42: neighbors under the parent-set policy keeps an as-of comparing fields of different types, or whose take is ordered toward the parent. */
export const r27AndR42NeighborsUnderTheParentSetPolicyKeepsAnAsOfComparingFieldsOfDifferentTypesOrWhoseTakeIsOrderedTowardTheParent =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(modes),
					source.draw(
						element<Edit>(["none", "the prices' day retyped bigint", "the take's order reversed"])
					)
				] as const
		),
		{
			needs: {},
			situations: [
				"none",
				"the prices' day retyped bigint",
				"the take's order reversed"
			] satisfies ReadonlyArray<Reached<Edit>>,
			check:
				(_, c: Case<Edit>) =>
				([mode, edit]) =>
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
									heading: Arr.map(n.heading, (h) => (h.name === "day" ? { ...h, type: int8 } : h))
								})
							}
							if (edit === "the take's order reversed" && n.kind === "Take") {
								ed.redefine(cell, {
									...n,
									orders: [
										{
											keys: Arr.map(soleOrder(n.orders).keys, (k) => ({
												...k,
												dir: opposite(k.dir)
											}))
										}
									]
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
					}),
			oracle: {
				kind: "specification",
				name: "R42's preconditions: fields of one type compared, a take ordered from the parent outward (neighbor.ts)"
			},
			box: "every as-of mode under no edit, its prices' day retyped bigint, or its take's order reversed",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/catalog/neighbor.ts",
					original:
						'\tdemand(nearestPast(t), "a take ordered from the parent backward, the compared prefix first")\n',
					replacement: "",
					why: "R42's conditions (neighbor.ts asOfHolds) no longer demand a take ordered from the parent outward, so an as-of ordered toward the parent is admitted; the R42 search fails."
				}
			]
		}
	)

/** R28: shares keeps a share whose total ranges over another binding set or whose join restricts the pairs. */
export const r28SharesKeepsAShareWhoseTotalRangesOverAnotherBindingSetOrWhoseJoinRestrictsThePairs =
	property.exhaust(finite(shares), {
		needs: {},
		situations: ["rewritten", "kept"] satisfies ReadonlyArray<Reached<"rewritten" | "kept">>,
		check: (_, c: Case<"rewritten" | "kept">) => (share) =>
			Effect.sync(() => {
				const rewritten = !share.restricted && (share.kind === "keyed" || share.over === "Sitting")
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
			}),
		oracle: {
			kind: "specification",
			name: "R28's precondition: a total over the grouped count's own binding set, joined without restricting the pairs (share.ts)"
		},
		box: "a grouped share over each of three totals, or a keyed share, each restricted or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/catalog/share.ts",
				original: '\t\t\t\tdemand(sameSource(g.source, t.source), "both counts over one source")\n',
				replacement: "",
				why: "The grouped share (share.ts) no longer demands both counts over one source, so a total over another source is admitted; the R28 search fails."
			}
		]
	})

/** Determinism and the catalog pass produces byte-identical DAGs and SQL from identical input, and the pass records its certificates. */
export const determinismAndTheCatalogPassProducesByteIdenticalDAGsAndSQLFromIdenticalInputAndThePassRecordsItsCertificates =
	property.exhaust(finite(compositions), {
		needs: {},
		situations: ["rewritten", "kept"] satisfies ReadonlyArray<Reached<"rewritten" | "kept">>,
		check: (_, c: Case<"rewritten" | "kept">) => (desc) =>
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
			}),
		oracle: {
			kind: "universal",
			name: "one input rewrites alike, byte for byte, and the pass records the rewrite's certificates"
		},
		box: "every composition of every entry under the automatic policy",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/catalog/edit.ts",
				original: "\tnode(node: EditNode): Cell {",
				replacement:
					"\tnode(node: EditNode): Cell {\n\t\tif (Math.random() < 0.5) {\n\t\t\tthis.#fresh.node.take()\n\t\t}",
				why: "The catalog's editor (edit.ts) skips a fresh node label at random, so a fresh node label differs run to run; the determinism search fails."
			}
		]
	})
