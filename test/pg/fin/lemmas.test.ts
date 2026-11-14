/**
 * The fin lemmas through grizzle's own lowering, per direction, on PostgreSQL 19rc2 (fin.md §5.2, §11): an ordered and
 * a counted family declared with grizzle's formers and installed by their first migration, written by a direct SQL
 * writer, the owner, and judged by the families model (test/support/families), PostgreSQL the judge of the law.
 *
 * - **The specification turned into a checker:** the families theorem (theorem.ts): every owner's rows indexed by
 *   exactly 0 … n − 1. PostgreSQL must commit a state exactly when it holds.
 * - **A second implementation:** the families model of each transaction (mutate.ts), each installed constraint read as
 *   the model's by its columns' roles (family.ts), checked at the moment the RFC's lowering checks it (the owner axis
 *   and the keys at each statement, the last slot at COMMIT, the closure at each statement when ordered and at COMMIT
 *   when counted). A refusal must be at the model's moment, by a constraint the model allows there, with its SQLSTATE
 *   and the family's law.
 *
 * **Per direction:** grizzle states both directions in one former, so each is judged by its drop. Beside grizzle's
 * seat of each shape run two mutants, its installation with one direction's natives dropped by DDL in a schema of its
 * own: "within dropped" (the bound, F[g, i] ⊆ fin(O, n)'s CHECK) and "covers dropped" (the last axis and the closure,
 * fin(O, n) ⊆ F[g, i]'s foreign keys). Each is judged by the model of the constraints it keeps and must be killed, by a
 * row beyond the count and by a gap below it.
 *
 * Boxes: every state of owners 0 and 1, each absent or of count 0 to 3, with at most three rows at slots 0 to 4, every
 * copy its owner's count, written from no state (doctrine rule 9); and random programs of the families model's lawful,
 * breaking and misordered mutations (mutate.ts programGen), each step one transaction judged against the model over the
 * state before it, which one transaction replacing the seat's rows writes first.
 *
 * Each transaction judged is checked as its COMMIT would check it and rolled back, or ends by a real COMMIT, as the
 * case draws its end on its tape (installed.ts endGen): each box requires both ends, and the box of states, which meets refusals at commit,
 * a refusal at commit through each, so the search itself shows a real COMMIT never decides otherwise than the checked
 * end.
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/fin-bound-check-at-most-count.patch, the bound CHECK admitting a row at
 * the count, commits a row beyond the family and must turn both properties red.
 */
import { runProgram } from "@bjornpagen/testing/commands"
import { drawn as drawnCase, exhaust, explore, type Oracle } from "@bjornpagen/testing/explore"
import { required, requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { quoteString } from "#compiler/sql/print.ts"
import {
	Disagreed,
	FAMILY_RELATIONS,
	type FamilySeat,
	familySeat,
	installedOf,
	judgedFamily
} from "#test/pg/fin/family.ts"
import {
	droppedSql,
	endedBy,
	type EndFeature,
	endGen,
	mutated,
	refusedAtCommitBy
} from "#test/pg/fin/installed.ts"
import { emptyStored, predicted as substratePredicted } from "#test/pg/substrate/fin.ts"
import { nonEmpty } from "#test/support/assert.ts"
import {
	BREAKING_FORMS,
	type Form,
	type Judges,
	LAWFUL_FORMS,
	machineOf,
	type Program,
	type ProgramSpace,
	programGen,
	realOf,
	run,
	type Settled,
	settledOf,
	settledUnder,
	type MutationStatement
} from "#test/support/families/mutate.ts"
import {
	type Constraint,
	type Families,
	type FamilyRow,
	SHAPES,
	type Shape,
	type Stored,
	storedOf,
	theorem
} from "#test/support/families/theorem.ts"
import { caseHang } from "#test/support/limits.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** A direction's drop: the constraints its mutant keeps. */
type Mutant = "within dropped" | "covers dropped"

const DROPPED: Readonly<Record<Mutant, ReadonlyArray<Constraint>>> = {
	"within dropped": ["bound"],
	"covers dropped": ["last", "closure"]
}

/** A seat: grizzle's family of a shape, or a mutant of it, with the constraints its model keeps. */
interface LemmaSeat {
	readonly label: Shape | `${Shape} ${Mutant}`
	readonly family: FamilySeat
	readonly installs: (c: Constraint) => boolean
	/**
	 * Whether the installed closure's ‹p› is restricted below the copy, `CASE WHEN i > 0 AND i < ‹n› THEN i − 1 END` as
	 * fin.md §5.2 states it, or plain pred(i), read off its generation expression: the two judge alike while the bound
	 * stands, and apart once the bound is dropped, since an unrestricted ‹p› also refuses a gap above the count.
	 */
	readonly restriction: "restricted" | "unrestricted"
	readonly mutant: Option.Option<Mutant>
}

const lemmaSeats = Effect.gen(function* () {
	const s = yield* Substrate
	const seats: Array<LemmaSeat> = []
	/** Whether a seat's closure ‹p› reads the copy ‹n›, read off the catalog's generation expression of ‹p›. */
	const restrictionOf = (f: FamilySeat) =>
		Effect.gen(function* () {
			const closure = installedOf(f, "closure")
			const p = Option.getOrThrow(Arr.findFirst(closure.columns, (c) => c !== "g"))
			const [row] = yield* s.admin.queryValues(
				`SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid) FROM pg_catalog.pg_attrdef AS d JOIN pg_catalog.pg_attribute AS a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = '${f.seat.table("Member")}'::regclass AND a.attname = ${quoteString(Str.slice(1, -1)(f.seat.column("Member", p)))}`,
				[]
			)
			const expr = typeof row?.[0] === "string" ? row[0] : ""
			return Str.includes(Str.slice(1, -1)(f.seat.column("Member", "‹n›")))(expr)
				? ("restricted" as const)
				: ("unrestricted" as const)
		})
	for (const shape of SHAPES) {
		const family = yield* familySeat(shape, `lemma ${shape}`)
		seats.push({
			label: shape,
			family,
			installs: () => true,
			restriction: yield* restrictionOf(family),
			mutant: Option.none()
		})
		for (const mutant of ["within dropped", "covers dropped"] as const) {
			const f = yield* familySeat(shape, `lemma ${shape} ${mutant}`)
			const restriction = yield* restrictionOf(f)
			const seat = yield* mutated(
				f.seat,
				FAMILY_RELATIONS,
				`lemma ${shape} ${mutant}`,
				Arr.map(DROPPED[mutant], (c) => droppedSql(f.seat, installedOf(f, c)))
			)
			seats.push({
				label: `${shape} ${mutant}`,
				family: { ...f, seat },
				installs: (c) => !DROPPED[mutant].includes(c),
				restriction,
				mutant: Option.some(mutant)
			})
		}
	}
	return seats
})

/** The box: two owners, each absent or of count 0 to 3, and at most three rows over slots 0 to 4. */
const box = { owners: [0, 1], counts: [0, 1, 2, 3], rows: 3, ats: [0, 1, 2, 3, 4] } as const

/** A state of the box: each owner's count or absence, and its rows as (owner, slot) cells, a multiset in cell order. */
interface StateSketch {
	readonly counts: ReadonlyArray<number | undefined>
	readonly cells: ReadonlyArray<readonly [owner: number, at: number]>
}

const CELLS = Object.freeze(
	Arr.flatMap(box.owners, (o) => Arr.map(box.ats, (at) => [o, at] as const))
)

/** Every multiset of at most `k` cells from index `from` on, in cell order. */
const multisetGen =
	(k: number, from: number): Gen<ReadonlyArray<number>> =>
	(source) => {
		if (k === 0 || source.draw(element([false, true]))) {
			return []
		}
		const first = source.draw(element(nonEmpty(upTo(CELLS.length - 1 - from + 1, (i) => from + i))))
		return [first, ...source.draw(multisetGen(k - 1, first))]
	}

const stateGen: Gen<StateSketch> = (source) => ({
	counts: Arr.map(box.owners, () =>
		source.draw(element<number | undefined>([undefined, ...box.counts]))
	),
	cells: Arr.map(source.draw(multisetGen(box.rows, 0)), (i) => Arr.getUnsafe(CELLS, i))
})

/**
 * The stored state of a sketch: each present owner's count, each row its owner's count's copy, and a row with no owner
 * a copy above every slot, 5, so its bound holds and the copy's foreign key is what refuses it.
 */
const storedOfSketch = (sketch: StateSketch): Stored => {
	const owners = new Map<number, number>()
	for (const [o, count] of sketch.counts.entries()) {
		if (count !== undefined) {
			owners.set(o, count)
		}
	}
	return {
		owners,
		rows: Arr.map(sketch.cells, ([group, at], member): FamilyRow => ({
			group,
			at,
			copy: owners.get(group) ?? 5,
			member
		}))
	}
}

/** One transaction from no state that writes a stored state: its owners, then its rows in descending slot order. */
const writeStatements = (stored: Stored): ReadonlyArray<MutationStatement> => {
	const rows = Arr.sort(stored.rows, (a: FamilyRow, b: FamilyRow) =>
		a.at > b.at ? -1 : a.at < b.at ? 1 : 0
	)
	return [
		...Arr.map([...stored.owners], ([owner, count]): MutationStatement => ({
			kind: "create",
			owner,
			count
		})),
		...(Arr.isReadonlyArrayNonEmpty(rows)
			? [{ kind: "insert", rows } satisfies MutationStatement]
			: [])
	]
}

/** What a seat's model settles a transaction over a stored state to: grizzle's every constraint, a mutant's those it keeps. */
const settledOn = (
	seat: LemmaSeat,
	before: Stored,
	statements: ReadonlyArray<MutationStatement>
): Settled => {
	if (seat.restriction === "restricted" || !seat.installs("closure")) {
		return settledUnder(seat.family.shape, seat.installs, before, statements)
	}
	/** An unrestricted closure: G2's substrate model of the constraints the seat keeps, the closure read as plain pred. */
	const model = substratePredicted(
		{
			direction: seat.installs("bound") ? "mirrors" : "covers",
			copy: "statement",
			last: "commit",
			closure: seat.family.shape === "ordered" ? "statement" : "commit",
			restriction: "unrestricted"
		},
		before,
		statements
	)
	return model.kind === "committed" ? { kind: "committed", stored: model.after } : model
}

type StateFeature =
	| `${LemmaSeat["label"]} ${"committed" | `refused ${Constraint}`}`
	| `${Shape} ${Mutant} killed`
	| EndFeature

const ORACLE: Oracle = {
	kind: "specification",
	name: "the families theorem (test/support/families/theorem.ts) as a checker, beside the families model of each transaction (mutate.ts) judging each installed constraint at its moment"
}

layer(Substrate.layer)("the fin lemmas through grizzle's lowering on PostgreSQL 19rc2", (it) => {
	it.effect(
		"commit exactly the states of the box the families theorem holds of, and kill each direction's drop",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = yield* lemmaSeats
					return yield* exhaust(
						{
							suite: "fin/lemma-states",
							generator: stateGen,
							literal: Formatter.format,
							box: "every state of owners 0 and 1, each absent or of count 0 to 3, with at most three rows over slots 0 to 4 of either owner, every copy its owner's count, written from no state in one transaction, each case ended by a real COMMIT and by the checked end",
							oracle: ORACLE,
							coverage: requiredInSpace<StateFeature>([
								"a case ended by COMMIT",
								"a case ended by SET CONSTRAINTS and ROLLBACK",
								"a case refused at a real COMMIT",
								"a case refused at its checked commit",
								"ordered committed",
								"ordered refused key",
								"ordered refused bound",
								"ordered refused copy",
								"ordered refused last",
								"ordered refused closure",
								"counted committed",
								"counted refused key",
								"counted refused bound",
								"counted refused copy",
								"counted refused last",
								"ordered within dropped killed",
								"ordered covers dropped killed",
								"counted within dropped killed",
								"counted covers dropped killed"
							]),
							caseHang,
							concurrency: 1
						},
						(sketch, c) => {
							const end = c.draw(endGen)
							return Effect.forEach(
								seats,
								(seat) =>
									Effect.gen(function* () {
										const stored = storedOfSketch(sketch)
										const statements = writeStatements(stored)
										const lawful = Result.isSuccess(theorem(stored))
										/** Uninterruptible: a seat's transaction and its clearing run whole, so one seat's failure never leaves another's rows. */
										const j = yield* Effect.uninterruptible(
											judgedFamily(
												seat.family,
												{ kind: "empty" },
												statements,
												settledOn(seat, emptyStored, statements),
												end
											)
										)
										c.note(`${seat.label} ${j.verdict}`)
										if (Option.isNone(seat.mutant)) {
											c.note(endedBy(j.end))
											if (Option.exists(j.moment, (m) => m.kind === "commit")) {
												c.note(refusedAtCommitBy(j.end))
											}
										}
										if (j.committed !== lawful) {
											if (Option.isNone(seat.mutant)) {
												return yield* new Disagreed({
													message: `${seat.label}: PostgreSQL ${j.verdict} a state whose theorem ${lawful ? "holds" : "fails"}: ${Formatter.format(sketch)}`
												})
											}
											c.note(`${seat.family.shape} ${seat.mutant.value} killed`)
										}
									}),
								{ concurrency: "unbounded", discard: true }
							)
						}
					)
				})
			)
	)

	it.effect(
		"refuse exactly the steps of random programs of family mutations the model refuses, where it refuses them, and commit the rest to the model's families",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seats = yield* Effect.forEach(SHAPES, (shape) =>
						familySeat(shape, `programs ${shape}`)
					)
					const seatOf = (shape: Shape): FamilySeat =>
						Option.getOrThrow(Arr.findFirst(seats, (s) => s.shape === shape))
					const space: ProgramSpace = {
						families: { owners: { min: 0, max: 3 }, long: { min: 3, max: 5 } },
						steps: { min: 1, max: 8 }
					}
					const programs: Gen<Program> = (source) =>
						source.draw(programGen(source.draw(element(SHAPES)), space))
					type ProgramFeature = `${Shape} ${Form} ${"committed" | "refused"}` | EndFeature
					return yield* explore(
						{
							suite: "fin/lemma-programs",
							draw: drawnCase(programs),
							literal: Formatter.format,
							coverage: required<ProgramFeature>(
								nonEmpty([
									"a case ended by COMMIT",
									"a case ended by SET CONSTRAINTS and ROLLBACK",
									...Arr.flatMap(SHAPES, (shape): ReadonlyArray<ProgramFeature> => [
										...Arr.map(
											Arr.filter(
												LAWFUL_FORMS,
												(f) => shape === "ordered" || (f !== "insert-at" && f !== "swap")
											),
											(f): ProgramFeature => `${shape} ${f} committed`
										),
										...Arr.map(BREAKING_FORMS, (f): ProgramFeature => `${shape} ${f} refused`),
										`${shape} misorder committed`,
										`${shape} misorder refused`
									])
								]),
								{ cases: 400, sense: notesOnly }
							),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang,
							oracle: ORACLE
						},
						(p, c) =>
							Effect.gen(function* () {
								const f = seatOf(p.shape)
								const step = (
									form: Form,
									statements: ReadonlyArray<MutationStatement>,
									before: Families
								): Effect.Effect<void, SqlError | TransactionRolledBack | Disagreed> =>
									Effect.gen(function* () {
										const j = yield* judgedFamily(
											f,
											{ kind: "replaced", before: storedOf(before) },
											statements,
											settledOf(run(p.shape, before, statements)),
											c.draw(endGen)
										)
										c.note(`${p.shape} ${form} ${j.committed ? "committed" : "refused"}`)
										c.note(endedBy(j.end))
										if (Option.exists(j.moment, (m) => m.kind === "commit")) {
											c.note(refusedAtCommitBy(j.end))
										}
									})
								const judges: Judges<SqlError | TransactionRolledBack | Disagreed, never> = {
									lawful: (form, m, before) => step(form, m.statements, before),
									breaking: (form, m, before) => step(form, m.statements, before),
									misordered: (m, before) => step("misorder", m.statements, before)
								}
								yield* runProgram(machineOf(p.shape, p.families, p.forms), realOf(judges), p.steps)
							})
					)
				})
			)
	)
})
