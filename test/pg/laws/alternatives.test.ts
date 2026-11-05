/**
 * `alternatives` through grizzle's lowering, on PostgreSQL 19rc1 (fin.md §7, w4-w7 §2.5): `alternatives(Item, "kind",
 * Kind, arms)` is its own statement, expanded with no head into plain containments: per arm relation, its key into the
 * parent selected by the handles it is the arm of (the forward), and per armed handle, the parent selected by it into
 * its arm (the reverse, deferred on the parent ↔ arm cycle). Each is refused natively, by a foreign key, never by a law
 * function or trigger.
 *
 * - **The specification turned into a checker:** fin.md §7's reading of alternatives: a state commits exactly when every
 *   arm row's parent exists with a kind the arm is armed for, and every parent of an armed kind has its arm's row; an
 *   unarmed handle needs no arm. A refusal must be 23503 by a foreign key of the relation whose write broke it, an arm's
 *   forward or the parent's reverse, reporting a law of the expansion.
 * - **A wide roster's columns counted:** a roster of 24 handles, each armed, installs on its parent at least one and at
 *   most two law columns per armed handle, linear in the roster, never one per pair.
 *
 * The box (doctrine rule 9): roster {a, b, c}, a armed by relation A, b by B, c unarmed; at most two parents of any kind
 * and every subset of arm rows for them, written parents first, then the arm rows, in one transaction.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { codeOf } from "#compiler/ir/codes.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { alternatives, closed, relation, schema } from "#compiler/public/schema.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import { assert } from "#test/support/assert.ts"
import * as D from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt, momentText, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Kind = closed("Kind", ["a", "b", "c"])
const Item = relation("Item", { id: pg.int4, kind: closedId(Kind) }, ["id"])
const A = relation("A", { item: pg.int4 }, ["item"])
const B = relation("B", { item: pg.int4 }, ["item"])

const Alternatives = schema("fin_alternatives", { Kind, Item, A, B }, [
	alternatives(Item, "kind", Kind, { a: A, b: B })
])

const RELATIONS = ["Item", "A", "B"] as const

/** A roster of 24 handles, each armed by an arm relation of its own: the wide roster whose columns are counted. */
const WIDE = 24

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

type Handle = "a" | "b" | "c"

/** A case: parents 0 and 1 present with a kind or absent, and each arm's rows among the parents' ids. */
interface Sketch {
	readonly kinds: ReadonlyArray<Handle | undefined>
	readonly a: ReadonlyArray<number>
	readonly b: ReadonlyArray<number>
}

const SUBSETS: Arr.NonEmptyReadonlyArray<ReadonlyArray<number>> = [[], [0], [1], [0, 1]]

const sketchGen: Gen<Sketch> = (source) => ({
	kinds: Arr.map([0, 1], () =>
		source.draw(element<Handle | undefined>([undefined, "a", "b", "c"]))
	),
	a: source.draw(element(SUBSETS)),
	b: source.draw(element(SUBSETS))
})

/** What breaks a state: an arm row whose parent is absent or of another kind, or a parent of an armed kind with no arm. */
type Broken = "forward" | "reverse"

const brokenOf = (s: Sketch): ReadonlyArray<Broken> => {
	const kindOf = (id: number) => s.kinds[id]
	const forward =
		Arr.some(s.a, (id) => kindOf(id) !== "a") || Arr.some(s.b, (id) => kindOf(id) !== "b")
	const reverse = Arr.some(
		s.kinds,
		(k, id) => (k === "a" && !s.a.includes(id)) || (k === "b" && !s.b.includes(id))
	)
	return [...(forward ? ["forward" as const] : []), ...(reverse ? ["reverse" as const] : [])]
}

type AlternativesFeature =
	| "committed"
	| "committed an unarmed parent"
	| `refused ${Broken}`
	| "a wide roster's columns counted"

layer(Substrate.layer)("alternatives through grizzle's lowering on PostgreSQL 19rc1", (it) => {
	it.effect(
		"commit exactly the states whose every arm row has its armed parent and every armed parent its arm, refusing each arm's forward and reverse natively",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seat = yield* seatOf(Alternatives, RELATIONS, "alternatives")
					const codec = Arr.findFirst(
						[...seat.installed.names.codes.rosters.values()],
						(r) => r.roster === Kind.name
					)
					const code = (h: Handle) => codeOf(Option.getOrThrow(codec), h)
					const laws = seat.lawsOf("containment")
					return yield* exhaust(
						{
							suite: "fin/alternatives",
							generator: sketchGen,
							literal: Formatter.format,
							limit: 4 ** 2 * SUBSETS.length ** 2,
							box: "roster {a, b, c} with a armed by A, b by B and c unarmed: parents 0 and 1 each absent or of a kind, and every subset of A rows and of B rows over them, parents written first",
							oracle: {
								kind: "specification",
								name: "fin.md §7's alternatives as a checker: every arm row's parent of an armed kind, every armed parent its arm"
							},
							coverage: requiredInSpace<AlternativesFeature>([
								"committed",
								"committed an unarmed parent",
								"refused forward",
								"refused reverse"
							]),
							caseHang
						},
						(s, c) =>
							Effect.gen(function* () {
								const parents = Arr.flatMap(s.kinds, (k, id) =>
									k === undefined ? [] : [`(${id}, ${code(k)})`]
								)
								const col = (r: string, f: string) => seat.column(r, f)
								const statements = [
									...(parents.length === 0
										? []
										: [
												`INSERT INTO ${seat.table("Item")} (${col("Item", "id")}, ${col("Item", "kind")}) VALUES ${Arr.join(parents, ", ")}`
											]),
									...Arr.flatMap(["A", "B"] as const, (arm) => {
										const ids = arm === "A" ? s.a : s.b
										return ids.length === 0
											? []
											: [
													`INSERT INTO ${seat.table(arm)} (${col(arm, "item")}) VALUES ${Arr.join(
														Arr.map(ids, (id) => `(${id})`),
														", "
													)}`
												]
									})
								]
								const real = yield* attempt(seat.session, statements)
								yield* seat.session.resetStatements
								const broken = brokenOf(s)
								if (real.kind === "committed") {
									yield* cleared(seat, RELATIONS)
									if (broken.length > 0) {
										return yield* new Disagreed({
											message: `committed a state that breaks the ${Arr.join(broken, " and ")}: ${Formatter.format(s)}`
										})
									}
									c.note(Arr.contains(s.kinds, "c") ? "committed an unarmed parent" : "committed")
									return
								}
								const named = seat.refusedBy(real.fields)
								const by: Option.Option<Broken> = Option.flatMap(named, (k) =>
									k.kind !== "foreign"
										? Option.none()
										: k.relation === "Item"
											? Option.some("reverse")
											: Option.some("forward")
								)
								if (
									real.fields.code !== "23503" ||
									Option.isNone(by) ||
									!broken.includes(by.value) ||
									!Option.exists(named, (k) => Option.exists(k.law, (l) => laws.includes(l)))
								) {
									return yield* new Disagreed({
										message: `refused ${momentText(real.moment)} by ${refusalText(real.fields)}, where the state breaks ${Formatter.format(broken)}: ${Formatter.format(s)}`
									})
								}
								c.note(`refused ${by.value}`)
							})
					)
				})
			)
	)

	it.effect(
		"install a wide roster's alternatives with law columns linear in its armed handles",
		() =>
			Effect.gen(function* () {
				const handles = Arr.map(Arr.range(0, WIDE - 1), (i) => `h${i}`)
				const roster = D.closed("Wide", handles)
				const parent = D.relation("Parent", { id: D.f.integer, kind: D.f.closedId("Wide") }, ["id"])
				const arms = Arr.map(handles, (h) =>
					D.relation(`Arm_${h}`, { item: D.f.integer }, ["item"])
				)
				const wide: D.SchemaDesc = {
					name: "fin_alternatives_wide",
					extends: undefined,
					relations: [roster, parent, ...arms],
					statements: [
						D.alternatives(
							parent,
							"kind",
							roster,
							Rec.fromEntries(Arr.map(handles, (h, i) => [h, Arr.getUnsafe(arms, i)] as const))
						)
					]
				}
				const seat = yield* seatOf(wide, ["Parent"], "alternatives wide")
				const columns = Arr.filter(seat.roles("Parent"), Str.startsWith("‹"))
				assert.ok(
					columns.length >= WIDE && columns.length <= 2 * WIDE,
					`the parent's law columns number ${columns.length}, not between one and two per armed handle (${WIDE})`
				)
			}).pipe(Effect.scoped)
	)
})
