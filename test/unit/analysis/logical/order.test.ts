import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { completeOrder } from "#compiler/logical/order.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { Ir } from "#test/support/fixtures/ir/build.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import {
	caseGen,
	type OrderFeature,
	payloads,
	rowsOf,
	specOrder,
	subjectAt,
	type UnionFeature,
	users,
	wrapped,
	wrappers
} from "#test/unit/analysis/logical/order.fixtures.ts"

/**
 * Completing an order is the policy's completion: the user's fields, the discriminant, the least narrower key, or the
 * heading.
 *
 * Budget: 3000 runs and 3000 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/order.test.ts:309 at 8cad5bce, its runs and its coverage's cases).
 */
export const completingAnOrderIsThePolicysCompletionTheUsersFieldsTheDiscriminantTheLeastNarrowerKeyOrTheHeading =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 3000, steered: 3000 },
		situations: [
			"refused MalformedDescription",
			"refused UnsupportedOperation",
			"total as stated",
			"completed by the discriminant",
			"completed by a narrower key",
			"completed by the heading",
			"a fixed column skipped",
			"a fixed discriminant skipped",
			"the empty heading"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check:
			(_, c: Case<OrderFeature>) =>
			({ subject: s, user, rows }) =>
				Effect.sync(() => {
					const got = completeOrder(s, user)
					const want = specOrder(s, user)
					if (want.kind === "refused") {
						c.note(`refused ${want.reason}`)
						assert.ok(
							!got.ok,
							`the policy refuses, and completeOrder gives ${Formatter.format(got.ok ? got.value : undefined)}`
						)
						assert.equal(got.error.reason._tag, want.reason)
						return
					}
					if (!got.ok) {
						throw new Error(
							`completeOrder refuses (${got.error.message}) what the policy completes`
						)
					}
					assert.deepEqual(got.value.keys, want.keys)
					if (s.heading.length === 0) {
						c.note("the empty heading")
					}
					c.note(
						want.step === "stated"
							? "total as stated"
							: want.step === "discriminant"
								? "completed by the discriminant"
								: want.step === "key"
									? "completed by a narrower key"
									: "completed by the heading"
					)
					if (Arr.some(s.fixed, (field) => !Arr.some(user, (k) => k.column === field))) {
						c.note("a fixed column skipped")
					}
					if (
						want.step !== "stated" &&
						Arr.some(
							s.discriminant,
							(d) => Arr.contains(s.fixed, d) && !Arr.some(user, (k) => k.column === d)
						)
					) {
						c.note("a fixed discriminant skipped")
					}
					/** The completed order is total over every relation the subject describes: no two of its rows tie. */
					const columns = Arr.map(got.value.keys, (k) =>
						Option.getOrThrowWith(
							Arr.findFirstIndex(s.heading, (h) => h.name === k.column),
							() => new Error("a column the case's own heading holds")
						)
					)
					const kept = rowsOf(s, rows)
					for (const [i, x] of kept.entries()) {
						for (const y of kept.slice(i + 1)) {
							assert.ok(
								Arr.some(columns, (index) => x[index] !== y[index]),
								`rows ${Formatter.format(x)} and ${Formatter.format(y)} tie on ${Arr.join(
									Arr.map(got.value.keys, (k) => k.column),
									", "
								)}`
							)
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "the page completion policy written from its statement, searched over the field sets it may append, and the completed order total over generated relations"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/order.ts",
				original: "\t\tif (ordered.has(column) || fixed.has(column)) {",
				replacement: "\t\tif (ordered.has(column)) {",
				why: "A fixed column appended to the order (logical/order.ts completeOrder); the completion property fails."
			}
		]
	})

/** Completing an order over a union of different headings completes a union read through a bound, a join, a set operation or an attachment as the union, the discriminant right after the user's fields. */
export const completingAnOrderOverAUnionOfDifferentHeadingsCompletesAUnionReadThroughABoundAJoinASetOperationOrAnAttachmentAsTheUnionTheDiscriminantRightAfterTheUsersFields =
	property.exhaust(
		finite(
			(source) =>
				[source.draw(boolean), source.draw(element(wrappers)), source.draw(element(users))] as const
		),
		{
			needs: {},
			situations: Arr.flatMap(wrappers, (w): Arr.NonEmptyReadonlyArray<UnionFeature> => [
				`${w} completed`,
				`${w} refused`
			]) satisfies ReadonlyArray<Reached<UnionFeature>>,
			check:
				(_, c: Case<UnionFeature>) =>
				([keyed, wrapper, userOrder]) =>
					Effect.sync(() => {
						const user = keyed ? userOrder : Arr.filter(userOrder, (k) => k.column !== "id")
						const q = new Ir(W.workModel())
						const union = payloads(q, keyed)
						const at = wrapped(q, union, keyed, wrapper)
						const s = subjectAt(q.build(at), at)
						assert.deepEqual(s.discriminant, ["kind"])
						const own = subjectAt(q.build(union), union)
						const want = specOrder(own, user)
						const got = completeOrder(s, user)
						if (want.kind === "refused") {
							c.note(`${wrapper} refused`)
							refused(got, want.reason)
							return
						}
						c.note(`${wrapper} completed`)
						assert.deepEqual(succeeded(got).keys, want.keys)
						/** The discriminant follows the user's fields, before any arm key. */
						const keys = Arr.map(succeeded(got).keys, (k) => k.column)
						if (!Arr.some(user, (k) => k.column === "kind")) {
							assert.equal(keys[user.length], "kind")
						}
					}),
			oracle: {
				kind: "specification",
				name: "the policy's completion of the union's own subject, the discriminant right after the user's fields"
			},
			box: "a union of payloads keyed or not, read through every wrapper, under every user order",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/logical/order.ts",
					original: "\t\tif (columns.has(d)) {\n\t\t\tappend(d)",
					replacement:
						'\t\tif (columns.has(d) && !ordered.has(d) && !fixed.has(d)) {\n\t\t\tordered.add(d)\n\t\t\tkeys.push({ column: d, dir: "desc" })',
					why: "The discriminant appended descending (logical/order.ts completeOrder); the unions property fails."
				}
			]
		}
	)
