import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { completeGroups, completeOrder, type OrderSubject } from "#compiler/logical/order.ts"
import { succeeded } from "#test/support/assert.ts"
import { Ir } from "#test/support/fixtures/ir/build.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import {
	caseGen,
	keysOf,
	type OrderFeature,
	payloadForms,
	payloads,
	rowsOf,
	specOrder,
	statesOrder,
	subjectAt,
	type UnionFeature,
	unionColumnKind,
	users,
	wrapped,
	wrappers
} from "#test/unit/analysis/logical/order.fixtures.ts"

/**
 * Completing an order is the policy's completion: the user's fields, the least narrower key, or the heading.
 *
 * Budget: 3000 runs and 3000 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/order.test.ts:309 at 8cad5bce, its runs and its coverage's cases).
 */
export const completingAnOrderIsThePolicysCompletionTheUsersFieldsTheLeastNarrowerKeyOrTheHeading =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 3000, steered: 3000 },
		situations: [
			"refused MalformedDescription",
			"refused UnsupportedOperation",
			"an order stated over a column of no order",
			"a tie broken by an unordered closed id",
			"total as stated",
			"completed by a narrower key",
			"completed by the heading",
			"a fixed column skipped",
			"the empty heading"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check:
			(_, c: Case<OrderFeature>) =>
			({ subject: s, user, rows, kindOf }) =>
				Effect.sync(() => {
					const got = completeOrder(s, user)
					const want = specOrder(s, user, kindOf)
					if (
						Arr.some(
							user,
							(k) =>
								Arr.some(s.heading, (h) => h.name === k.column) && !statesOrder(kindOf(k.column))
						)
					) {
						c.note("an order stated over a column of no order")
					}
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
					if (
						Arr.some(
							got.value.keys.slice(user.length),
							(k) => kindOf(k.column) === "unordered closed id"
						)
					) {
						c.note("a tie broken by an unordered closed id")
					}
					if (s.heading.length === 0) {
						c.note("the empty heading")
					}
					c.note(
						want.step === "stated"
							? "total as stated"
							: want.step === "key"
								? "completed by a narrower key"
								: "completed by the heading"
					)
					if (Arr.some(s.fixed, (field) => !Arr.some(user, (k) => k.column === field))) {
						c.note("a fixed column skipped")
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
				original: "\tconst settled = (c: string) => ordered.has(c) || fixed.has(c)",
				replacement: "\tconst settled = (c: string) => ordered.has(c)",
				why: "A fixed column appended to the order (logical/order.ts completeOrder); the completion property fails."
			},
			{
				file: "packages/engine/src/scalar/registry.ts",
				original: '\t"bits",\n\t"bytes",\n\t"tsvector",\n\t"variant"\n])',
				replacement: '\t"bits",\n\t"variant"\n])',
				why: "A completion breaks no tie by bytes or a search document (scalar/registry.ts breaksTies), so a keyless heading holding one is refused where format 8 delivered it; the completion property fails."
			},
			{
				file: "packages/engine/src/scalar/registry.ts",
				original: '\t"code",\n\t"bits",\n',
				replacement: "",
				why: "A completion breaks no tie by an unordered roster's closed id or a set's bits (scalar/registry.ts breaksTies), so an order that needs one is refused, or completed by another key; the completion property fails."
			},
			{
				file: "packages/engine/src/logical/order.ts",
				original: '\t\tif (!hasCapability(column.type, "ordering")) {',
				replacement: "\t\tif (!breaksTies(column.type)) {",
				why: "An order the caller states names an unordered roster's closed id, which has no admitted order (logical/order.ts completeOrder admits it); the completion property fails."
			}
		]
	})

/**
 * Completing an order over a union of different headings orders every heading group by the union's own key where one
 * lies within the fields every group holds, and otherwise each group by its own, after the user's fields and, where
 * they hold no key of the union, its discriminant, for a union read through a bound, a join, a set operation or an
 * attachment as for the union itself, and through a filter that fixes the discriminant, which no order then appends.
 */
export const completingAnOrderOverAUnionOfDifferentHeadingsOrdersEveryGroupByTheUnionsKeyWhereItHasOneElseEachByItsOwnAfterTheUsersFieldsAndTheDiscriminantReadThroughABoundAJoinASetOperationOrAnAttachmentAsTheUnion =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element(payloadForms)),
					source.draw(element(wrappers)),
					source.draw(element(users))
				] as const
		),
		{
			needs: {},
			situations: Arr.flatMap(wrappers, (w): Arr.NonEmptyReadonlyArray<UnionFeature> => [
				`${w} keyed`,
				`${w} keyed, a group's own key first`,
				`${w} keyless`
			]) satisfies ReadonlyArray<Reached<UnionFeature>>,
			check:
				(_, c: Case<UnionFeature>) =>
				([form, wrapper, userOrder]) =>
					Effect.sync(() => {
						const keyed = form !== "keyless"
						const user = keyed ? userOrder : Arr.filter(userOrder, (k) => k.column !== "id")
						const q = new Ir(W.workModel())
						const union = payloads(q, form)
						const at = wrapped(q, union, keyed, wrapper)
						const s = subjectAt(q.build(at), at)
						const own = subjectAt(q.build(union), union)
						assert.ok(
							s.kind === "groups" && own.kind === "groups",
							"a subject of two heading groups"
						)
						assert.deepEqual(s.discriminant, ["kind"])
						c.note(`${wrapper} ${form}`)
						/** `subject` read where the union is: a filter that fixes its discriminant fixes it in every group. */
						const here = (subject: OrderSubject): OrderSubject => ({
							...subject,
							fixed: [...new Set([...subject.fixed, ...s.common.fixed])]
						})
						/** Whether `columns`, with the columns `subject` fixes, hold a key of it. */
						const holds = (subject: OrderSubject, columns: ReadonlySet<string>): boolean =>
							Arr.some(keysOf(subject), (key) =>
								Arr.every(key, (members) =>
									Arr.some(members, (m) => columns.has(m) || Arr.contains(subject.fixed, m))
								)
							)
						/**
						 * The run every group's order begins with: the user's fields, then the discriminant where they hold no key
						 * of the union's own subject.
						 */
						const named = new Set(Arr.map(user, (k) => k.column))
						const run = holds(here(own.common), named)
							? user
							: [
									...user,
									...Arr.map(
										Arr.filter(
											own.discriminant,
											(d) => !named.has(d) && !Arr.contains(s.common.fixed, d)
										),
										(column) => ({ column, dir: "asc" as const })
									)
								]
						/** The union's own order: the run completed over the fields every group holds, where they hold a key. */
						const common = specOrder(here(own.common), run, unionColumnKind)
						const united =
							common.kind === "order" &&
							holds(here(own.common), new Set(Arr.map(common.keys, (k) => k.column)))
						assert.equal(
							united,
							keyed,
							"the fields every arm holds key the union exactly where it is keyed"
						)
						const got = succeeded(completeGroups(s, user))
						assert.equal(got.length, own.groups.length, "one order per heading group")
						for (const [gi, group] of own.groups.entries()) {
							const want = united ? common : specOrder(here(group), run, unionColumnKind)
							assert.ok(want.kind === "order", `heading group ${gi} completes`)
							assert.deepEqual(defined(got[gi], "a group's order").keys, want.keys)
						}
						if (
							form === "keyed, a group's own key first" &&
							!named.has("id") &&
							wrapper !== "filtered to one kind"
						) {
							/** The manual group alone would complete by its aid, which the union's one order never reads. */
							const manual = specOrder(
								defined(own.groups[1], "the manual group"),
								run,
								unionColumnKind
							)
							assert.ok(manual.kind === "order" && Arr.some(manual.keys, (k) => k.column === "aid"))
						}
					}),
			oracle: {
				kind: "specification",
				name: "the policy's completion of the union's own subject, where the fields every arm holds key it, else of each heading group's own subject, after the user's fields and, where they hold no key of the union's own subject, its discriminant unless fixed"
			},
			box: "a union of payloads keyed, keyed with a group's own key named first, or keyless, read through every wrapper, under every user order",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/logical/order.ts",
					original:
						"\t\t\t\t\t: Result.eachNonEmpty(subject.groups, (group) => completeFrom(group, run))",
					replacement:
						"\t\t\t\t\t: Result.eachNonEmpty(subject.groups, () => completeFrom(subject.common, run))",
					why: "Every heading group of a union with no key over its common fields ordered by those fields alone (logical/order.ts completeGroups): a group whose common fields hold no key of it ties, and its rows' order is the plan's; the unions property fails."
				},
				{
					file: "packages/engine/src/logical/order.ts",
					original: "\t\t\t\treturn common.ok && holdsKey(subject.common, common.value.keys)",
					replacement: "\t\t\t\treturn common.ok && false",
					why: "Every heading group completed by its own fields even where a key of the union lies within the fields every group holds (logical/order.ts completeGroups): the manual group orders by its aid, apart from the union's one order, so a take over the union read inside a statement and a page over it are refused; the unions property fails."
				},
				{
					file: "packages/engine/src/logical/order.ts",
					original: '\t\t\t\t\t\t\t\t.map((column): OrderKey => ({ column, dir: "asc" }))',
					replacement: '\t\t\t\t\t\t\t\t.map((column): OrderKey => ({ column, dir: "desc" }))',
					why: "The discriminant appended descending (logical/order.ts completeGroups), so groups follow their roster backwards; the unions property fails."
				},
				{
					file: "packages/engine/src/logical/order.ts",
					original:
						"\t\t\t\t\t\t\t\t.filter((d) => !named.has(d) && !subject.common.fixed.includes(d))",
					replacement: "\t\t\t\t\t\t\t\t.filter((d) => !named.has(d))",
					why: "A discriminant the union is read under one value of appended to the order (logical/order.ts completeGroups), a column constant per evaluation that breaks no tie; the unions property fails."
				}
			]
		}
	)
