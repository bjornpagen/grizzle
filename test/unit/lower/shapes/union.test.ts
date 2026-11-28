/**
 * The union shape (shapes/union): attachments on heading groups, the in-statement bounded union, and the runtime merge
 * of group statements. What a union delivers is the optimized differential's on PostgreSQL, and a match narrowed to one
 * heading group of a bounded union, joined back on every common field, is test/pg/oracle/union-take's.
 *
 * - An attachment on the lone arm of its heading group is delivered, and one on an arm of a group of several refused,
 *   by the optimized lowering and the conservative one alike.
 * - Inside a statement, each arm of a bounded union is bounded by k under the take's order, deduplicated on the common
 *   fields before its bound exactly when the facts do not key it there; exhausted over k, the facts and overlapping
 *   arms.
 * - The runtime merge (runtime/lower/union.ts mergeHeadingGroups) keeps the first k of the union under the common
 *   order: over drawn heading groups of floats (NaN, signed zeros, infinities named beside drawn ones), enums in either
 *   roster direction and ids, each group in that order, against a reference sort of every row under PostgreSQL's B-tree
 *   order; exact decimals compare by value against a reference over their digits.
 *
 * Oracle: the shape's statement over exhaustive planted spaces (a specification); a reference sort of every row, and
 * a reference order of decimals by their digits (second implementations).
 *
 * Features: delivered and refused; keyed and deduplicated arms; every row, the first k, a NaN, a descending order;
 * decimals equal at different scales, and ordered.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { structural } from "#compiler/analysis/physical/fds.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompletedOrder } from "#compiler/ir/rel.ts"
import { emptyEnv } from "#compiler/lower/conservative/context.ts"
import { rankedOrder } from "#compiler/lower/conservative/take/order.ts"
import { orderIsTotal } from "#compiler/lower/shapes/take/order.ts"
import { armBoundedUnion } from "#compiler/lower/shapes/union/index.ts"
import { mergeHeadingGroups } from "#compiler/runtime/lower/union.ts"
import { lit, types } from "#compiler/sql/build.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { mergeComparator } from "#test/support/merge.ts"
import { fixtureCodes } from "#test/support/unit/ir/fixture.ts"
import { T } from "#test/support/unit/lower/conservative/fixtures.ts"
import { tasksByKind } from "#test/support/unit/lower/shapes/queries.ts"
import { context, shapedFacts, testOptions } from "#test/support/unit/lower/shapes/support.ts"
import {
	boundedArms,
	conservative,
	decimalOrder,
	decimalPairs,
	exact,
	mergeCaseGen,
	optimized,
	referenceCompare,
	type ScoredRow,
	takeOf,
	tasksWithPostings,
	unionOf,
	value
} from "#test/unit/lower/shapes/union.fixtures.ts"

/** Attachments on heading groups deliver the lone arm's attachment and refuse one on an arm of a group of several, in both lowerings. */
export const attachmentsOnHeadingGroupsDeliverTheLoneArmsAttachmentAndRefuseOneOnAnArmOfAGroupOfSeveralInBothLowerings =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element<"lone" | "shared">(["lone", "shared"])),
					source.draw(element<"optimized" | "conservative">(["optimized", "conservative"]))
				] as const
		),
		{
			needs: {},
			situations: ["delivered", "refused"] satisfies ReadonlyArray<
				Reached<"delivered" | "refused">
			>,
			check:
				(_, c: Case<"delivered" | "refused">) =>
				([on, lowering]) =>
					Effect.sync(() => {
						const count = catchRefusal(() =>
							(lowering === "optimized" ? optimized : conservative)(tasksWithPostings(on))
						)
						if (on === "lone") {
							assert.equal(succeeded(count), 1)
							c.note("delivered")
						} else {
							refused(count, "UnsupportedOperation")
							c.note("refused")
						}
					}),
			oracle: {
				kind: "specification",
				name: "an attachment on a lone arm delivered, one on an arm of several refused, in both lowerings"
			},
			box: "the postings attached to a heading group's lone arm or to an arm of a group of two, under either lowering",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/index.ts",
					original: "\t\tif (others.length === 0) {",
					replacement: "\t\tif (others.length >= 0) {",
					why: "The optimized delivery takes the attachments of a heading group's first arm whatever the group's size, so it delivers an attachment on an arm of several; the attachments search fails."
				}
			]
		}
	)

/** The bounded union consumed inside a statement bounds every arm by k, deduplicating it on the common fields first exactly when the facts do not key it. */
export const theBoundedUnionConsumedInsideAStatementBoundsEveryArmByKDeduplicatingItOnTheCommonFieldsFirstExactlyWhenTheFactsDoNotKeyIt =
	property.exhaust(
		finite(
			(source) => [source.draw(int(1, 3)), source.draw(boolean), source.draw(boolean)] as const
		),
		{
			needs: {},
			situations: ["keyed", "deduplicated"] satisfies ReadonlyArray<
				Reached<"keyed" | "deduplicated">
			>,
			check:
				(_2, c: Case<"keyed" | "deduplicated">) =>
				([k, keyedArms, overlap]) =>
					Effect.sync(() => {
						const built = tasksByKind({ kind: "first", k: BigInt(k) }, overlap)
						const union = unionOf(built.dag)
						const take = takeOf(built.dag)
						const { facts } = shapedFacts(
							built.dag,
							{
								keyedBy: (_, columns) =>
									keyedArms ? { just: structural, key: columns } : undefined
							},
							"placement"
						)
						const cx = context(built.dag, facts, testOptions("Ledger"))
						const bound = lit.int(BigInt(k), types.bigint)
						const arms = boundedArms(
							armBoundedUnion(
								cx,
								facts,
								union,
								rankedOrder(take),
								orderIsTotal(facts, union, rankedOrder(take), union.heading),
								() => bound,
								emptyEnv
							)
						)
						assert.equal(
							arms.length,
							Arr.reduce(union.groups, 0, (n, g) => n + g.arms.length)
						)
						for (const arm of arms) {
							assert.deepEqual(arm.limit, {
								kind: "access",
								access: { kind: "ordered", use: "take seek" },
								expr: bound
							})
							assert.equal(arm.body.kind === "core" && arm.body.distinct === true, !keyedArms)
						}
						c.note(keyedArms ? "keyed" : "deduplicated")
					}),
			oracle: {
				kind: "specification",
				name: "each arm bounded by k, deduplicated on the common fields exactly where unkeyed"
			},
			box: "k of one to three, arms keyed by the facts or not, overlapping or not",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/union/index.ts",
					original: "\t\t\tfacts.keyedBy(arm.node, columns) === undefined",
					replacement: "\t\t\tfacts.keyedBy(arm.node, columns) === undefined || true",
					why: "Every bounded arm is deduplicated, a keyed one too; the bounded-arm search fails."
				}
			]
		}
	)

/**
 * The runtime merge of heading groups keeps the first k of every group's rows under the common order, NaN above all
 * and the roster breaking ties.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/lower/shapes/union.test.ts:391 at 8cad5bce, its runs and its coverage's cases).
 */
export const theRuntimeMergeOfHeadingGroupsKeepsTheFirstKOfEveryGroupsRowsUnderTheCommonOrderNaNAboveAllAndTheRosterBreakingTies =
	property.explore(mergeCaseGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: ["every row", "first k", "a NaN", "descending"] satisfies ReadonlyArray<
			Reached<"every row" | "first k" | "a NaN" | "descending">
		>,
		check: (_, c: Case<"every row" | "first k" | "a NaN" | "descending">) => (m) =>
			Effect.sync(() => {
				const order: CompletedOrder = {
					keys: [
						{ column: "score", dir: m.dirs.score },
						{ column: "kind", dir: m.dirs.kind },
						{ column: "id", dir: "asc" }
					]
				}
				const compare = succeeded(
					mergeComparator({
						order,
						types: { score: T.float8, kind: T.kind, id: T.int4 },
						codes: fixtureCodes
					})
				)
				const merged = mergeHeadingGroups(
					m.groups,
					compare,
					m.take.kind === "every row" ? undefined : m.take.k
				)
				const all = Arr.sort(
					Arr.flatMap(m.groups, (rows, group) => Arr.map(rows, (row) => ({ group, row }))),
					Order.mapInput(referenceCompare(m.dirs), (x: { readonly row: ScoredRow }) => x.row)
				)
				const expected = m.take.kind === "every row" ? all : all.slice(0, m.take.k)
				assert.deepEqual(
					Arr.map(merged, (x) => [x.group, x.row.kind, x.row.id]),
					Arr.map(expected, (x) => [x.group, x.row.kind, x.row.id])
				)
				c.note(m.take.kind === "every row" ? "every row" : "first k")
				if (Arr.some(m.groups, (rows) => Arr.some(rows, (r) => Number.isNaN(r.score)))) {
					c.note("a NaN")
				}
				if (m.dirs.score === "desc") {
					c.note("descending")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "a sort of every row under PostgreSQL's B-tree order, cut at k"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/lower/union.ts",
				original: "\tconst wanted = limit === undefined ? total : Math.min(limit, total)",
				replacement: "\tconst wanted = limit === undefined ? total : Math.min(limit + 1, total)",
				why: "The merge keeps one row past its take; the merge search fails."
			}
		]
	})

/**
 * The runtime merge of heading groups compares exact decimals by value, whatever their scale.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/lower/shapes/union.test.ts:497 at 8cad5bce, its runs and its coverage's cases).
 */
export const theRuntimeMergeOfHeadingGroupsComparesExactDecimalsByValueWhateverTheirScale =
	property.explore(decimalPairs, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: ["equal at different scales", "ordered"] satisfies ReadonlyArray<
			Reached<"equal at different scales" | "ordered">
		>,
		check:
			(_, c: Case<"equal at different scales" | "ordered">) =>
			([a, b]) =>
				Effect.sync(() => {
					assert.equal(Math.sign(exact({ x: value(a) }, { x: value(b) })), decimalOrder(a, b))
					if (
						decimalOrder(a, b) === 0 &&
						a.kind === "finite" &&
						b.kind === "finite" &&
						a.scale !== b.scale
					) {
						c.note("equal at different scales")
					} else {
						c.note("ordered")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "decimals ordered by their digits at a common scale, NaN above every number"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original:
					"\tconst mx = x.coefficient * pow10(scale - x.minScale)\n\tconst my = y.coefficient * pow10(scale - y.minScale)",
				replacement: "\tconst mx = x.coefficient\n\tconst my = y.coefficient",
				why: "Decimals compare by coefficient whatever their scale; the decimal-order search fails."
			}
		]
	})
