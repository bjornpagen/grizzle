/**
 * Counted swap-with-last through grizzle's lowering, on PostgreSQL 19rc1 (fin.md §4.2, §11, "Counted swap-with-last
 * with the deferred closure FK"): a counted family hides its index ‹i› and its fold's accumulators, so removing a
 * member moves the last member into the freed slot, refolds the hidden accumulators from that slot on, and lowers the
 * count with the new end (test/support/families/counted.ts swapWithLast). Between the delete and the move the freed
 * slot's successor has no predecessor, so the predecessor axis must be deferred, and the installed one is.
 *
 * - **Two implementations agreeing:** the reference fold (families/fold.ts) and the host's fill (runtime/write/fill.ts
 *   filler) of the families swap-with-last leaves must be one state; every swap-with-last commits to those families,
 *   its stored state that fold of them, and the end unchanged but for the removed member's step,
 *   since every monoid is commutative.
 * - **The fold's model** (fold.ts foldPredicted) judges every order: the move before the delete is refused by the key,
 *   the count before the delete by the bound (the count's cascade), each at its statement; and with the predecessor
 *   axis made immediate (SET CONSTRAINTS, the control), the prescribed order is refused at its delete by that axis
 *   whenever the slot freed is not the last.
 *
 * The box (doctrine rule 9): owner 0 with every counted family of one to four members over the five step values of
 * each counted fold seat (folds.ts), each member's removal, sent in the prescribed order, move first and count first,
 * and in the prescribed order with the predecessor axis immediate.
 *
 * Each case writes its family by one transaction that replaces the seat's rows, then sends its removal as one
 * transaction checked as its COMMIT would check it and rolled back, or ended by a real COMMIT, as the case draws its
 * end on its tape (installed.ts endGen): the box holds every case under both ends.
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/fin-predecessor-axis-deferral-swapped.patch, the counted predecessor axis
 * installed immediate and the ordered one deferred, refuses the prescribed swap-with-last at its delete and must turn
 * the property red.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	byMember,
	Disagreed,
	FOLD_SPECS,
	type FoldVerdict,
	foldInstalledOf,
	foldSeat,
	hostFilled,
	type Judging,
	judgedFold
} from "#test/pg/fin/folds.ts"
import {
	endedBy,
	type EndFeature,
	endGen,
	ends,
	refusedAtCommitBy
} from "#test/pg/fin/installed.ts"
import { assert, deepEquals, nonEmpty } from "#test/support/assert.ts"
import { swapWithLast } from "#test/support/families/counted.ts"
import {
	type FoldStatement,
	foldApplied,
	foldStoredOf,
	grizzleFold
} from "#test/support/families/fold.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** How a swap-with-last's statements are sent. */
type Sending = "prescribed" | "move first" | "count first" | "closure immediate"

const SENDINGS: Arr.NonEmptyReadonlyArray<Sending> = [
	"prescribed",
	"move first",
	"count first",
	"closure immediate"
]

interface Sketch {
	readonly values: Arr.NonEmptyReadonlyArray<number>
	readonly at: number
	readonly sending: Sending
}

const sketchGen: Gen<Sketch> = (source) => {
	const n = source.draw(int(1, 4))
	const values = nonEmpty(
		Arr.map(
			upTo(n, (i) => i + 1),
			() => source.draw(element([0, 1, 2, 3, 4] as const))
		)
	)
	return { values, at: source.draw(int(0, n - 1)), sending: source.draw(element(SENDINGS)) }
}

const sketchCases = Arr.reduce(Arr.range(1, 4), 0, (sum, n) => sum + 5 ** n * n * SENDINGS.length)

/** A plan's statements in a sending: the prescribed order, or with its first update or its count moved first. */
const sent = (
	statements: ReadonlyArray<FoldStatement>,
	sending: Sending
): ReadonlyArray<FoldStatement> => {
	const first = (kind: FoldStatement["kind"]) => {
		const at = Arr.findFirstIndex(statements, (s) => s.kind === kind)
		return Option.match(at, {
			onNone: () => statements,
			onSome: (i) => [Arr.getUnsafe(statements, i), ...Arr.remove(statements, i)]
		})
	}
	switch (sending) {
		case "prescribed":
		case "closure immediate":
			return statements
		case "move first":
			return first("update")
		case "count first":
			return first("count")
	}
}

type Position = "the last slot" | "a slot before the last"

type CountedFeature = `${string} ${Position} ${Sending} ${FoldVerdict}` | EndFeature

const COUNTED = Arr.filter(FOLD_SPECS, (s) => s.shape === "counted")

layer(Substrate.layer)(
	"counted swap-with-last through grizzle's lowering on PostgreSQL 19rc1",
	(it) => {
		for (const spec of COUNTED) {
			it.effect(
				`remove every member of every counted family of at most four by swap-with-last under the deferred predecessor axis, and refuse every misorder: ${spec.label}`,
				(ctx) =>
					searched(
						ctx,
						Effect.gen(function* () {
							const f = yield* foldSeat(spec, `swap ${spec.label}`)
							const predecessor = foldInstalledOf(f, "predecessor axis")
							assert.ok(
								predecessor.length === 1 && Arr.every(predecessor, (c) => c.deferrable),
								`${spec.label}: the counted family's one predecessor axis is deferrable`
							)
							const grizzle: Judging = {
								label: spec.label,
								fold: f,
								lowering: grizzleFold("counted")
							}
							/** The control: the predecessor axis checked at each statement, as an ordered family's is. */
							const immediate: Judging = {
								...grizzle,
								label: `${spec.label} closure immediate`,
								lowering: grizzleFold("ordered")
							}
							const setImmediate = Arr.map(
								predecessor,
								(c) =>
									`SET CONSTRAINTS ${quoteIdent(f.seat.installed.schema)}.${quoteIdent(c.name)} IMMEDIATE`
							)
							const l = spec.label
							return yield* exhaust(
								{
									suite: `fin/swap-with-last ${spec.label}`,
									generator: sketchGen,
									literal: Formatter.format,
									limit: sketchCases * ends.length,
									box: "owner 0 with every counted family of one to four members over the seat's five step values, each member removed by swap-with-last, sent prescribed, move first, count first, and prescribed with the predecessor axis immediate, each case ended by a real COMMIT and by the checked end",
									oracle: {
										kind: "second-implementation",
										name: "the reference fold of the families swap-with-last leaves (families/fold.ts), beside the fold's model of each installed native's moment (fold.ts foldPredicted)"
									},
									coverage: requiredInSpace<CountedFeature>([
										"a case ended by COMMIT",
										"a case ended by SET CONSTRAINTS and ROLLBACK",
										`${l} the last slot prescribed committed`,
										`${l} a slot before the last prescribed committed`,
										`${l} a slot before the last move first refused key`,
										`${l} a slot before the last count first refused bound`,
										`${l} the last slot count first refused bound`,
										`${l} a slot before the last closure immediate refused predecessor axis`,
										`${l} the last slot closure immediate committed`
									]),
									caseHang
								},
								(sketch, c) =>
									Effect.gen(function* () {
										const members = Arr.map(sketch.values, (i, member) => ({
											member,
											x: Arr.getUnsafe(spec.domain, i),
											selected: true
										}))
										const before = foldStoredOf(spec.monoid, [{ owner: 0, members }])
										const change = swapWithLast(spec.monoid, before, 0, sketch.at)
										const reached = Arr.reduce(change.statements, before, foldApplied)
										const reference = foldStoredOf(spec.monoid, change.after)
										if (!deepEquals(byMember(reached), byMember(reference))) {
											return yield* new Disagreed({
												message: `swap-with-last's statements leave ${Formatter.format(reached)}, not the reference fold ${Formatter.format(reference)}`
											})
										}
										const host = Result.flatMap(
											Result.fromOption(
												Arr.head(change.after),
												() => "swap-with-last leaves no family"
											),
											(fam) => hostFilled(f, fam)
										)
										if (
											Result.isFailure(host) ||
											!deepEquals(byMember(host.success), byMember(reference))
										) {
											return yield* new Disagreed({
												message: `the host's fill of the family swap-with-last leaves, ${Result.isFailure(host) ? host.failure : Formatter.format(host.success)}, is not the reference fold ${Formatter.format(reference)}`
											})
										}
										const judging = sketch.sending === "closure immediate" ? immediate : grizzle
										const j = yield* judgedFold(
											judging,
											{ kind: "replaced", before },
											sent(change.statements, sketch.sending),
											sketch.sending === "closure immediate" ? setImmediate : [],
											c.draw(endGen)
										)
										const position: Position =
											sketch.at === sketch.values.length - 1
												? "the last slot"
												: "a slot before the last"
										c.note(`${l} ${position} ${sketch.sending} ${j.verdict}`)
										c.note(endedBy(j.end))
										if (Option.exists(j.moment, (m) => m.kind === "commit")) {
											c.note(refusedAtCommitBy(j.end))
										}
										if (sketch.sending === "prescribed" && j.verdict !== "committed") {
											return yield* new Disagreed({
												message: `${l}: the prescribed swap-with-last of slot ${sketch.at} was ${j.verdict}: ${Formatter.format(sketch)}`
											})
										}
									})
							)
						})
					)
			)
		}
	}
)
