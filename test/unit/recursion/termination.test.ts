/**
 * The static seen-state estimate (check/recursion/termination.ts): the product over state columns of the number of
 * values each can take. Planted over a grid walk the generated recursions (unit/recursion/certificates, one counter, a
 * tag and a mark) never build: two independent counters bounded by drawn bounds, a column computed from both, a
 * column of a drawn type copied from data, and a tag column of one literal or two. The rule restated: a bounded counter
 * counts every integer from its seed to its bound; a computed column the product of the columns it reads beside its
 * literals; data, of any type, counts once; a column of literals counts them. A set state column, which no hash
 * operator class deduplicates, is refused at every roster size, its cause naming the recursion and the column.
 *
 * Oracle: the estimate's rule restated as a formula, and the hashing rule (a specification). Features: each copied
 * column's type, a computed column, two tags, the widest grid; each roster size.
 */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { succeeded } from "#test/support/assert.ts"
import { type HeadTermDesc } from "#test/support/fixtures/ir/desc.ts"
import { idDesc } from "#test/support/ids.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import {
	compute,
	eq,
	lt,
	match,
	narrowed,
	param,
	plainVar,
	ref,
	relationSource,
	rule,
	typedLit,
	vars
} from "#test/support/unit/check/dsl.ts"
import { upTo } from "#test/support/up-to.ts"
import { Graph, theRecursive } from "#test/unit/recursion/fixtures.ts"
import {
	copied,
	type EstimateFeature,
	integer,
	integerLit,
	s,
	setsOver
} from "#test/unit/recursion/termination.fixtures.ts"

/** The seen-state estimate multiplies independent counters, a computed column by the columns it reads, data once and literals each. */
export const theSeenStateEstimateMultipliesIndependentCountersAComputedColumnByTheColumnsItReadsDataOnceAndLiteralsEach =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw((source) => [source.draw(int(1, 3)), source.draw(int(1, 3))] as const),
					source.draw((source) => [source.draw(boolean), source.draw(boolean)] as const),
					source.draw(element(copied))
				] as const
		),
		{
			needs: {},
			situations: [
				...Arr.map(copied, ([column]): EstimateFeature => `copies ${column}`),
				"a computed column",
				"two tags",
				"the widest grid"
			] satisfies ReadonlyArray<Reached<EstimateFeature>>,
			check:
				(_, c: Case<EstimateFeature>) =>
				([[bx, by], [summed, twoTags], [column, type]]) =>
					Effect.sync(() => {
						c.note(`copies ${column}`)
						if (summed) {
							c.note("a computed column")
						}
						if (twoTags) {
							c.note("two tags")
						}
						if (bx === 3 && by === 3) {
							c.note("the widest grid")
						}
						const sum: HeadTermDesc = summed
							? narrowed(compute("add", s("x"), s("y")), "integer")
							: integerLit(0)
						const q = succeeded(
							checkAuthored(
								checking(Graph),
								{
									stage: {
										kind: "recursive",
										recursive: {
											name: "Grid",
											row: {
												node: idDesc,
												x: integer,
												y: integer,
												sum: integer,
												d: type,
												tag: integer
											},
											base: [
												rule({
													vars: vars("Vertex", "id", column),
													matches: [
														match(relationSource("Vertex"), {
															id: ref("Vertex", "id"),
															[column]: ref("Vertex", column)
														})
													],
													where: [eq(ref("Vertex", "id"), param("start", idDesc))],
													head: {
														node: ref("Vertex", "id"),
														x: integerLit(0),
														y: integerLit(0),
														sum: integerLit(0),
														d: ref("Vertex", column),
														tag: integerLit(1)
													},
													interiors: [],
													attach: []
												})
											],
											rec: [
												rule({
													vars: [
														...Arr.map(["node", "x", "y", "d", "tag"], (v) =>
															plainVar(`self.${v}`)
														),
														...vars("Edge", "to")
													],
													matches: [
														match(
															{ kind: "self" },
															{ node: s("node"), x: s("x"), y: s("y"), d: s("d"), tag: s("tag") }
														),
														match(relationSource("Edge"), {
															from: s("node"),
															to: ref("Edge", "to")
														})
													],
													where: [lt(s("x"), integerLit(bx)), lt(s("y"), integerLit(by))],
													head: {
														node: ref("Edge", "to"),
														x: compute("add", s("x"), integerLit(1)),
														y: compute("add", s("y"), integerLit(1)),
														sum,
														d: s("d"),
														tag: twoTags ? integerLit(2) : s("tag")
													},
													interiors: [],
													attach: []
												})
											]
										}
									}
								},
								checkOptions("query")
							)
						)
						/**
						 * x counts 0..bx and y 0..by; sum, their exact sum narrowed into integer under its guard, its literal beside
						 * x * y when computed from them; d, data, once; tag its literals.
						 */
						const counts = (BigInt(bx) + 1n) * (BigInt(by) + 1n)
						const cert = theRecursive(q).termination
						assert.equal(cert.kind, "boundedState")
						assert.equal(
							cert.stateEstimate,
							counts * (summed ? 1n + counts : 1n) * (twoTags ? 2n : 1n)
						)
					}),
			oracle: {
				kind: "specification",
				name: "termination.ts: counters multiply, a computed column by the columns it reads beside its literal, data once, literals each"
			},
			box: "two counters each bounded below one to three, a computed column or a literal, one tag or two, and each Vertex column copied as data",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/recursion/termination.ts",
					original:
						"\t\tconst count = range === undefined ? valueCount(all) : range[1] - range[0] + 1n",
					replacement:
						"\t\tconst count = range === undefined ? valueCount(all) : range[1] - range[0]",
					why: "A counter's count of states one short of every integer from its least value to its greatest; the estimate search fails."
				}
			]
		}
	)

/** The seen-state estimate refuses a set state column, which no hash operator class deduplicates, at every roster size. */
export const theSeenStateEstimateRefusesASetStateColumnWhichNoHashOperatorClassDeduplicatesAtEveryRosterSize =
	property.exhaust(finite(int(1, 3)), {
		needs: {},
		situations: ["1 handles", "2 handles", "3 handles"] satisfies ReadonlyArray<
			Reached<`${number} handles`>
		>,
		check: (_, c: Case<`${number} handles`>) => (n) =>
			Effect.sync(() => {
				c.note(`${n} handles`)
				const handles = nonEmpty(
					upTo(n, (i) => `h${i + 1}`),
					"a roster holds one handle at least"
				)
				const set: FieldDesc = { kind: "bits", roster: "Flag" }
				const of = (members: ReadonlyArray<string>) => typedLit({ handles: members }, set)
				const r = checkAuthored(
					checking(setsOver(handles)),
					{
						stage: {
							kind: "recursive",
							recursive: {
								name: "Marks",
								row: { node: idDesc, m: set },
								base: [
									rule({
										vars: vars("Node", "id"),
										matches: [match(relationSource("Node"), { id: ref("Node", "id") })],
										where: [eq(ref("Node", "id"), param("start", idDesc))],
										head: { node: ref("Node", "id"), m: of([]) },
										interiors: [],
										attach: []
									})
								],
								rec: [
									rule({
										vars: [
											...Arr.map(["node", "m"], (v) => plainVar(`self.${v}`)),
											...vars("Link", "to")
										],
										matches: [
											match({ kind: "self" }, { node: s("node"), m: s("m") }),
											match(relationSource("Link"), {
												from: s("node"),
												to: ref("Link", "to")
											})
										],
										where: [],
										head: { node: ref("Link", "to"), m: of(handles) },
										interiors: [],
										attach: []
									})
								]
							}
						}
					},
					checkOptions("query")
				)
				assert.ok(!r.ok, "a set state column is refused")
				const reason = r.error.reason
				if (reason._tag !== "RecursionRefused") {
					return assert.fail(`refused as ${reason._tag}, not by recursion admission`)
				}
				const cause = reason.cause
				assert.ok(cause.kind === "unhashableState", `refused for ${cause.kind}`)
				const { recursion, column } = cause
				assert.deepEqual({ recursion, column }, { recursion: "Marks", column: "m" })
			}),
		oracle: {
			kind: "specification",
			name: "state.ts requireHashing: a set state column is unhashable"
		},
		box: "a set state column over a roster of one, two or three handles",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/recursion/state.ts",
				original:
					'\tif (type.carrier === "bits" || type.carrier === "bytes" || !capsOf(type).includes("hashing")) {',
				replacement:
					'\tif (type.carrier === "bytes" || (type.carrier !== "bits" && !capsOf(type).includes("hashing"))) {',
				why: "A set state column counted as hashable; the estimate-sets search fails."
			}
		]
	})
