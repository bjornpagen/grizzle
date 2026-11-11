/**
 * Row order through grizzle's lowering, on PostgreSQL 19rc1 (fin.md §11, "Row order"): a single INSERT whose rows
 * arrive successor before predecessor passes the family's immediate predecessor axis, since a foreign key is checked at
 * the end of its statement, not per row; and the same rows split so a successor's statement ends before its
 * predecessor's begins are refused at that statement when the family is ordered (its predecessor axis immediate), and
 * commit when it is counted (its predecessor axis deferred, for swap-with-last).
 *
 * - **A second implementation:** the families model of each transaction (test/support/families/mutate.ts run), which
 *   checks each constraint at the moment the RFC's lowering does; PostgreSQL, judging grizzle's installed lowering,
 *   must agree on the verdict, the moment and a constraint the model allows there (family.ts judgedFamily).
 *
 * The box (doctrine rule 9): owners 0 and 1 with families whose lengths sum to at most five, for each shape every order
 * of all their rows in one INSERT, and every cut of the rows in descending and in ascending slot order into two
 * INSERTs.
 *
 * Each case's transaction runs on a seat with no rows and is checked as its COMMIT would check it and rolled back, or
 * ends by a real COMMIT whose rows are read and cleared, as the case draws its end on its tape (installed.ts endGen):
 * the box requires both ends.
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/fin-predecessor-axis-deferral-swapped.patch, the ordered predecessor axis
 * installed deferred, commits a split the model refuses and must turn the property red.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int, shuffled } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { Disagreed, familySeat, judgedFamily } from "#test/pg/fin/family.ts"
import { endedBy, type EndFeature, endGen, refusedAtCommitBy } from "#test/pg/fin/installed.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { run, settledOf, type MutationStatement } from "#test/support/families/mutate.ts"
import {
	type Families,
	type FamilyRow,
	SHAPES,
	type Shape,
	storedOf
} from "#test/support/families/theorem.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** Every pair of families of owners 0 and 1, members numbered in slot order across both, lengths summing to ≤ 5. */
const FAMILIES: Arr.NonEmptyReadonlyArray<Families> = nonEmpty(
	Arr.flatMap(Arr.range(0, 5), (a) =>
		upTo(5 - a + 1, (b): Families => [
			{ owner: 0, members: upTo(a, (i) => i) },
			{ owner: 1, members: upTo(b, (m) => a + m) }
		])
	),
	"a family pair"
)

/** A write of a family pair's rows: one INSERT in an order, or the rows in a slot order cut once into two INSERTs. */
type Sent =
	| { readonly kind: "one insert"; readonly rows: ReadonlyArray<FamilyRow> }
	| {
			readonly kind: "cut"
			readonly order: "descending" | "ascending"
			readonly first: ReadonlyArray<FamilyRow>
			readonly second: ReadonlyArray<FamilyRow>
	  }

interface Sketch {
	readonly shape: Shape
	readonly families: Families
	readonly sent: Sent
}

const rowsOf = (families: Families): ReadonlyArray<FamilyRow> => storedOf(families).rows

const sketchGen: Gen<Sketch> = (source) => {
	const shape = source.draw(element(SHAPES))
	const families = source.draw(element(FAMILIES))
	const rows = rowsOf(families)
	const n = rows.length
	if (n < 2 || source.draw(element(["one insert", "cut"] as const)) === "one insert") {
		return {
			shape,
			families,
			sent: { kind: "one insert", rows: source.draw(shuffled(rows, { min: n, max: n })) }
		}
	}
	const order = source.draw(element(["descending", "ascending"] as const))
	const sorted = Arr.sort(
		rows,
		order === "ascending"
			? Order.mapInput(Order.Number, (r: FamilyRow) => r.at)
			: Order.mapInput(Order.flip(Order.Number), (r: FamilyRow) => r.at)
	)
	const at = source.draw(int(1, n - 1))
	return {
		shape,
		families,
		sent: { kind: "cut", order, first: sorted.slice(0, at), second: sorted.slice(at) }
	}
}

const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1))

/** The statements a sketch sends: each owner with its count, then its INSERTs. */
const statementsOf = (sketch: Sketch): ReadonlyArray<MutationStatement> => {
	const creates = Arr.map(sketch.families, (f): MutationStatement => ({
		kind: "create",
		owner: f.owner,
		count: f.members.length
	}))
	const insert = (rows: ReadonlyArray<FamilyRow>): ReadonlyArray<MutationStatement> =>
		Arr.isReadonlyArrayNonEmpty(rows) ? [{ kind: "insert", rows }] : []
	return sketch.sent.kind === "one insert"
		? [...creates, ...insert(sketch.sent.rows)]
		: [...creates, ...insert(sketch.sent.first), ...insert(sketch.sent.second)]
}

/** Whether some row is sent before the row one slot below it in its family. */
const successorFirst = (rows: ReadonlyArray<FamilyRow>): boolean =>
	Arr.some(rows, (r, i) =>
		Arr.some(rows.slice(i + 1), (p) => p.group === r.group && p.at === r.at - 1)
	)

type OrderFeature =
	| EndFeature
	| `${Shape} one insert committed`
	| `${Shape} one insert with a successor first committed`
	| `${Shape} ${"descending" | "ascending"} cut ${"committed" | "refused"}`

layer(Substrate.layer)("row order through grizzle's lowering on PostgreSQL 19rc1", (it) => {
	it.effect(
		"pass the immediate predecessor axis on one insert of a family's rows in every order, successor first included, and check it at each statement of a cut write when ordered",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = yield* Effect.forEach(SHAPES, (shape) =>
						familySeat(shape, `order ${shape}`)
					)
					const seatOf = (shape: Shape) =>
						Arr.getUnsafe(
							Arr.filter(seats, (s) => s.shape === shape),
							0
						)
					return yield* exhaust(
						{
							suite: "fin/row-order",
							generator: sketchGen,
							literal: Formatter.format,
							box: "owners 0 and 1 with families of lengths summing to at most five, ordered and counted: every order of their rows in one INSERT, and every cut of their rows in descending and in ascending slot order into two INSERTs, after the owners, each case ended by a real COMMIT and by the checked end",
							oracle: {
								kind: "second-implementation",
								name: "the families model of each transaction (test/support/families/mutate.ts run), each constraint at the RFC lowering's moment"
							},
							coverage: requiredInSpace<OrderFeature>([
								"a case ended by COMMIT",
								"a case ended by SET CONSTRAINTS and ROLLBACK",
								"ordered one insert committed",
								"ordered one insert with a successor first committed",
								"counted one insert with a successor first committed",
								"ordered descending cut refused",
								"ordered ascending cut committed",
								"counted descending cut committed",
								"counted ascending cut committed"
							]),
							caseHang
						},
						(sketch, c) =>
							Effect.gen(function* () {
								const statements = statementsOf(sketch)
								const outcome = run(sketch.shape, [], statements)
								const j = yield* judgedFamily(
									seatOf(sketch.shape),
									{ kind: "empty" },
									statements,
									settledOf(outcome),
									c.draw(endGen)
								)
								c.note(endedBy(j.end))
								if (Option.exists(j.moment, (m) => m.kind === "commit")) {
									c.note(refusedAtCommitBy(j.end))
								}
								if (sketch.sent.kind === "one insert") {
									if (!j.committed) {
										return yield* new Disagreed({
											message: `one insert of ${Formatter.format(sketch.sent.rows)} was ${j.verdict}`
										})
									}
									c.note(
										successorFirst(sketch.sent.rows)
											? `${sketch.shape} one insert with a successor first committed`
											: `${sketch.shape} one insert committed`
									)
								} else {
									c.note(
										`${sketch.shape} ${sketch.sent.order} cut ${j.committed ? "committed" : "refused"}`
									)
								}
							})
					)
				})
			)
	)
})
