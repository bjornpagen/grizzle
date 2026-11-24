/**
 * The page compiler (lower/shapes/page/compile.ts) refuses a page over a bounded heterogeneous union as
 * UnsupportedOperation: a group statement cannot tell which of its rows are among the union's first k, which only the
 * merge across groups decides.
 *
 * Inputs: the fixture's two heterogeneous unions of heading groups (test/unit/page/fixtures.ts flagged and
 * flaggedByTitle, told apart by the roster-typed level), each taken at any bound and ordered again, by its own order or
 * by its own key reversed: a page reads an Ordered query, so an order over the take is the one page a bounded union
 * can be asked for, and a take with no order after it is no page at all. An unbounded union pages, and the generated
 * page oracle (test/pg/page/generated.ts) holds that side.
 *
 * Oracle: the compiler's contract, a specification: every bounded heterogeneous union is refused, by its tag.
 *
 * Features: each union, and each order over the take: the union's own, and its key reversed.
 *
 * A union whose fields every group holds key it is ordered by that key, one order of every heading group, though a
 * group's own completion would choose a field of its own (test/unit/page/fixtures.ts flaggedWithAid): its rows are
 * delivered in it, its take read inside another statement ranks by it, and a page over it seeks by it, each compiled.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { refused, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import {
	bounded,
	type Feature,
	type Reorder,
	type Union
} from "#test/unit/page/compile.fixtures.ts"
import {
	attachedData,
	attachedDataByTask,
	attachedOrTitledReordered,
	compiledPageResult,
	flaggedWithAidByLevel,
	flaggedWithAidFirstIds,
	flaggedWithAidRows
} from "#test/unit/page/fixtures.ts"

/**
 * The page compiler refuses a bounded heterogeneous union, whatever its bound and order.
 *
 * Budget: its suite's count before the conversion (unit/page/bounded-union: 30 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const thePageCompilerRefusesABoundedHeterogeneousUnionWhateverItsBoundAndOrder =
	property.explore(
		(source) => ({
			union: source.draw(element<Union>(["flagged", "flagged by title"])),
			reorder: source.draw(element<Reorder>(["the union's own order", "its key reversed"])),
			take: source.draw(int(1, 50))
		}),
		{
			needs: {},
			situations: [
				"flagged",
				"flagged by title",
				"the union's own order",
				"its key reversed"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check:
				(_, c: Case<Feature>) =>
				({ union, reorder, take }) =>
					Effect.sync(() => {
						refused(
							compiledPageResult(bounded(union, reorder, take), testCompile),
							"UnsupportedOperation",
							`${union}, ${reorder}`
						)
						c.note(union)
						c.note(reorder)
					}),
			oracle: {
				kind: "specification",
				name: "no page over a bounded heterogeneous union, refused as UnsupportedOperation"
			},
			budget: { runs: 30, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/shapes/page/compile.ts",
					original:
						'\t\t\tcase "takeThenOrder":\n\t\t\t\treturn refuse(\n\t\t\t\t\t"UnsupportedOperation",\n\t\t\t\t\tnodeLabel(bound.take),\n\t\t\t\t\t"a page over a bounded heterogeneous union: a group statement cannot tell which of its rows are among the union\'s first k, which only the merge across groups decides"\n\t\t\t\t)',
					replacement:
						'\t\t\t\treturn refuse(\n\t\t\t\t\t"UnsupportedOperation",\n\t\t\t\t\tnodeLabel(bound.take),\n\t\t\t\t\t"a page over a bounded heterogeneous union: a group statement cannot tell which of its rows are among the union\'s first k, which only the merge across groups decides"\n\t\t\t\t)\n\t\t\tcase "takeThenOrder":',
					why: "An order over the take is paged as an unbounded union is, not refused; the property fails."
				}
			]
		}
	)

/** What a union keyed over its common fields is compiled for. */
type CommonKeyed =
	| "delivered in the union's one order"
	| "its take read inside a statement"
	| "paged by the union's key"

/**
 * A union keyed by the fields its heading groups share orders every group by that key, though a group's own completion
 * would choose a field of its own: its rows are delivered in the one order, a take of it read inside another statement
 * ranks in it, and a page over it seeks by it, where groups ordered apart would refuse both.
 */
export const aUnionKeyedByTheFieldsItsGroupsShareOrdersEveryGroupByThatKeySoItsTakeReadInsideAStatementAndItsPageCompile =
	property.exhaust(
		finite((source) =>
			source.draw(
				element<CommonKeyed>([
					"delivered in the union's one order",
					"its take read inside a statement",
					"paged by the union's key"
				])
			)
		),
		{
			needs: {},
			situations: [
				"delivered in the union's one order",
				"its take read inside a statement",
				"paged by the union's key"
			] satisfies ReadonlyArray<Reached<CommonKeyed>>,
			check: (_, c: Case<CommonKeyed>) => (form) =>
				Effect.sync(() => {
					c.note(form)
					switch (form) {
						case "delivered in the union's one order": {
							const root = succeeded(compileTemplate(flaggedWithAidRows, undefined, testCompile))
								.programs.checked.dag.roots[0]
							assert.ok(root.kind === "OrderedResult", "a delivered read is an ordered result")
							assert.deepEqual(
								Arr.map(root.orders, (o) => o.keys),
								[
									[
										{ column: "level", dir: "asc" },
										{ column: "id", dir: "asc" }
									],
									[
										{ column: "level", dir: "asc" },
										{ column: "id", dir: "asc" }
									]
								],
								"every heading group by the level, then the id that keys the union"
							)
							return
						}
						case "its take read inside a statement":
							succeeded(compileTemplate(flaggedWithAidFirstIds, undefined, testCompile))
							return
						case "paged by the union's key":
							assert.deepEqual(
								Arr.map(
									succeeded(compiledPageResult(flaggedWithAidByLevel, testCompile)).page.order.keys,
									(k) => k.column
								),
								["level", "id"]
							)
							return
					}
				}),
			oracle: {
				kind: "specification",
				name: "the ruling's one order of a result that has a key: the user's fields, the discriminant, then the union's key"
			},
			box: "the flagged union with a field of one group alone named before the id, delivered unordered, taken inside a statement, and paged",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/logical/order.ts",
					original: "\t\t\t\treturn common.ok && holdsKey(subject.common, common.value.keys)",
					replacement: "\t\t\t\treturn common.ok && false",
					why: "Every heading group completed by its own fields though the union has a key over its common fields (logical/order.ts completeGroups): the low group orders by its aid, so the take inside a statement and the page are refused (take/order.ts sharedOrder) and the delivered orders differ; the property fails."
				}
			]
		}
	)

/** What a keyless heading holding bytes is compiled for. */
type BytesBreakTies =
	| "delivered, the bytes breaking ties"
	| "paged, refused"
	| "taken and ordered again over heading groups, refused"

/**
 * A keyless heading holding bytes is delivered, PostgreSQL's order of the bytes breaking its ties, where format 8 read
 * it unordered; a page that would seek by the bytes, which no parameter carries, and a take over heading groups ordered
 * again, whose kept rows the runtime orders again itself by the bytes, which the host never compares, are refused, as
 * format 8 refused both.
 */
export const aKeylessHeadingHoldingBytesIsDeliveredTheBytesBreakingItsTiesAndNeitherAPageNorAHostOrderReadsThem =
	property.exhaust(
		finite((source) =>
			source.draw(
				element<BytesBreakTies>([
					"delivered, the bytes breaking ties",
					"paged, refused",
					"taken and ordered again over heading groups, refused"
				])
			)
		),
		{
			needs: {},
			situations: [
				"delivered, the bytes breaking ties",
				"paged, refused",
				"taken and ordered again over heading groups, refused"
			] satisfies ReadonlyArray<Reached<BytesBreakTies>>,
			check: (_, c: Case<BytesBreakTies>) => (form) =>
				Effect.sync(() => {
					c.note(form)
					switch (form) {
						case "delivered, the bytes breaking ties": {
							const root = succeeded(compileTemplate(attachedData, undefined, testCompile)).programs
								.checked.dag.roots[0]
							assert.ok(root.kind === "OrderedResult", "a delivered read is an ordered result")
							assert.deepEqual(
								Arr.map(root.orders, (o) => Arr.map(o.keys, (k) => k.column)),
								[["data", "task"]],
								"the whole heading, field by field, the bytes first by name"
							)
							return
						}
						case "paged, refused":
							refused(
								compiledPageResult(attachedDataByTask, testCompile),
								"UnsupportedOperation",
								form
							)
							return
						case "taken and ordered again over heading groups, refused":
							refused(
								compileTemplate(attachedOrTitledReordered, undefined, testCompile),
								"UnsupportedOperation",
								form
							)
							return
					}
				}),
			oracle: {
				kind: "specification",
				name: "bytes break a keyless heading's ties in PostgreSQL's order; no page seeks by them and no host orders by them"
			},
			box: "the tasks' attachments' data delivered and paged, and a union of it with titles taken and ordered again",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/registry.ts",
					original: '\t"bits",\n\t"bytes",\n',
					replacement: '\t"bits",\n',
					why: "Bytes break no tie (scalar/registry.ts breaksTies): the keyless heading's order is refused where format 8 delivered it; the property fails."
				},
				{
					file: "packages/engine/src/lower/shapes/page/compile.ts",
					original: "\t\tif (unbound !== undefined) {",
					replacement: "\t\tif (unbound === null) {",
					why: "A page seeks by bytes, which no parameter carries, compiled where its anchor cannot bind; the property fails."
				},
				{
					file: "packages/engine/src/lower/conservative/deliver.ts",
					original: "\t\t\thostOrdered(plan.union, b.orders, nodeLabel(b.take))\n",
					replacement: "",
					why: "A take over heading groups ordered again by bytes compiles, whose kept rows the host would order by bytes it never reads; the property fails."
				}
			]
		}
	)
