/**
 * Ordered rewrites through grizzle's lowering, on PostgreSQL 19rc2 (fin.md §4.5, §11, "Ordered rewrites" and "The
 * shrink order"): a member's removal, an insertion at a slot, a swap and an append are each a rewrite of the family's
 * suffix, sent as the planner sends it, deletes, then the owner's one count update, then inserts, and each commits to
 * the families it states. Sent in the wrong order, a shrink is refused: its count update lowers the count while rows
 * remain at or above it, the owner axis's cascade carries the lower count into their copies inside that statement, and
 * the bound CHECK (i < ‹n›), never deferred, refuses it there with 23514, reporting the family's law. That is the
 * shrink-order cascade failure the RFC's history found by hand (testing doctrine, "The bar"), rediscovered here as the
 * misordered plan's refusal.
 *
 * - **A second implementation:** the families model (test/support/families/mutate.ts run) of each transaction;
 *   PostgreSQL judging grizzle's installed lowering must agree on the verdict, the moment and a constraint the model
 *   allows there, and a commit must read back as the model's families (family.ts judgedFamily).
 *
 * The box (doctrine rule 9): owner 0 with every ordered family of zero to four members beside owner 1 with one, every
 * removal, insertion of one new member at each slot, swap of two slots and append, each sent in the prescribed order,
 * with its count update first, and with its inserts before its deletes.
 *
 * Each case writes its families by one transaction that replaces the seat's rows, then sends its rewrite as one
 * transaction checked as its COMMIT would check it and rolled back, or ended by a real COMMIT, as the case draws its
 * end on its tape (installed.ts endGen): the box holds every case under both ends.
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/fin-bound-check-at-most-count.patch, the bound CHECK admitting a row at
 * the count, commits a misordered shrink the model refuses and must turn the property red.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { constraintOf, Disagreed, familySeat, judgedFamily } from "#test/pg/fin/family.ts"
import { endedBy, type EndFeature, endGen, refusedAtCommitBy } from "#test/pg/fin/installed.ts"
import { deepEquals, nonEmpty } from "#test/support/assert.ts"
import { run, settledOf, type MutationStatement } from "#test/support/families/mutate.ts"
import { type Families, familyRowsFrom, storedOf } from "#test/support/families/theorem.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** A rewrite of owner 0's family: what it does, and the slot its suffix starts at with the suffix it writes there. */
type Form = "remove" | "insert-at" | "swap" | "append"

/** How its statements are sent: as the planner sends them, the count update first, or the inserts before the deletes. */
type Sending = "prescribed" | "count first" | "inserts first"

interface Rewrite {
	readonly form: Form
	readonly members: ReadonlyArray<number>
	readonly at: number
	readonly suffix: ReadonlyArray<number>
	readonly sending: Sending
}

/** The member owner 1 holds, untouched by every rewrite of owner 0. */
const BESIDE = 100

/** A new member, numbered after every member. */
const NEW = 50

const before = (members: ReadonlyArray<number>): Families => [
	{ owner: 0, members },
	{ owner: 1, members: [BESIDE] }
]

/** Every rewrite of every family of zero to four members. */
const REWRITES: Arr.NonEmptyReadonlyArray<Omit<Rewrite, "sending">> = nonEmpty(
	Arr.flatMap(Arr.range(0, 4), (n) => {
		const members = upTo(n, (i) => i)
		const removes = Arr.map(members, (_, a) => ({
			form: "remove" as const,
			members,
			at: a,
			suffix: members.slice(a + 1)
		}))
		const inserts = upTo(n + 1, (a) => ({
			form: "insert-at" as const,
			members,
			at: a,
			suffix: [NEW, ...members.slice(a)]
		}))
		const swaps = Arr.flatMap(members, (_, i) =>
			Arr.flatMap(members, (__, j) => {
				if (j <= i) {
					return []
				}
				const swapped = Arr.map(members, (m, k) =>
					k === i ? Arr.getUnsafe(members, j) : k === j ? Arr.getUnsafe(members, i) : m
				)
				return [{ form: "swap" as const, members, at: i, suffix: swapped.slice(i) }]
			})
		)
		const appends = [{ form: "append" as const, members, at: n, suffix: [NEW] }]
		return [...removes, ...inserts, ...swaps, ...appends]
	}),
	"a rewrite"
)

const SENDINGS: Arr.NonEmptyReadonlyArray<Sending> = ["prescribed", "count first", "inserts first"]

const rewriteGen: Gen<Rewrite> = (source) => ({
	...source.draw(element(REWRITES)),
	sending: source.draw(element(SENDINGS))
})

/** A rewrite's statements in its sending, and the families the prescribed order commits to. */
const statementsOf = (
	r: Rewrite
): { readonly statements: ReadonlyArray<MutationStatement>; readonly after: Families } => {
	const count = r.at + r.suffix.length
	const deleted = r.members.slice(r.at)
	const deletes: ReadonlyArray<MutationStatement> = Arr.isReadonlyArrayNonEmpty(deleted)
		? [{ kind: "delete", members: deleted }]
		: []
	const counts: ReadonlyArray<MutationStatement> =
		r.members.length === count ? [] : [{ kind: "count", owner: 0, count }]
	const rows = familyRowsFrom(0, r.suffix, r.at, count)
	const inserts: ReadonlyArray<MutationStatement> = Arr.isReadonlyArrayNonEmpty(rows)
		? [{ kind: "insert", rows }]
		: []
	const statements = (() => {
		switch (r.sending) {
			case "prescribed":
				return [...deletes, ...counts, ...inserts]
			case "count first":
				return [...counts, ...deletes, ...inserts]
			case "inserts first":
				return [...counts, ...inserts, ...deletes]
		}
	})()
	return { statements, after: before([...r.members.slice(0, r.at), ...r.suffix]) }
}

/** Whether a rewrite lowers its family's count: a shrink. */
const shrinks = (r: Rewrite): boolean => r.at + r.suffix.length < r.members.length

type RewriteFeature =
	| EndFeature
	| `${Form} ${Sending} ${"committed" | "refused"}`
	| "a shrink sent count first refused at its count by the bound, 23514, reporting the family's law"

layer(Substrate.layer)(
	"ordered rewrites and the shrink order through grizzle's lowering on PostgreSQL 19rc2",
	(it) => {
		it.effect(
			"commit every suffix rewrite sent deletes, count, inserts, and refuse a shrink whose count comes first at that count by the bound",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const f = yield* familySeat("ordered", "rewrites")
						return yield* exhaust(
							{
								suite: "fin/rewrites",
								generator: rewriteGen,
								literal: Formatter.format,
								box: "owner 0 with every ordered family of zero to four members, owner 1 with one: every removal, insertion of a new member at each slot, swap of two slots and append, each sent deletes-count-inserts, count first, and inserts before deletes, each case ended by a real COMMIT and by the checked end",
								oracle: {
									kind: "second-implementation",
									name: "the families model of each transaction (test/support/families/mutate.ts run); the prescribed order's families as the rewrite states them"
								},
								coverage: requiredInSpace<RewriteFeature>([
									"a case ended by COMMIT",
									"a case ended by SET CONSTRAINTS and ROLLBACK",
									"remove prescribed committed",
									"insert-at prescribed committed",
									"swap prescribed committed",
									"append prescribed committed",
									"remove count first refused",
									"insert-at count first committed",
									"remove inserts first refused",
									"swap inserts first refused",
									"a shrink sent count first refused at its count by the bound, 23514, reporting the family's law"
								]),
								caseHang,
								concurrency: 1
							},
							(r, c) =>
								Effect.gen(function* () {
									const { statements, after } = statementsOf(r)
									const outcome = run("ordered", before(r.members), statements)
									const j = yield* judgedFamily(
										f,
										{ kind: "replaced", before: storedOf(before(r.members)) },
										statements,
										settledOf(outcome),
										c.draw(endGen)
									)
									c.note(`${r.form} ${r.sending} ${j.committed ? "committed" : "refused"}`)
									c.note(endedBy(j.end))
									if (Option.exists(j.moment, (m) => m.kind === "commit")) {
										c.note(refusedAtCommitBy(j.end))
									}
									if (
										r.sending === "prescribed" &&
										(!j.committed ||
											outcome.kind !== "committed" ||
											!deepEquals(outcome.after, after))
									) {
										return yield* new Disagreed({
											message: `the prescribed ${r.form} of ${Formatter.format(r)} was ${j.verdict}, or committed to other families than ${Formatter.format(after)}`
										})
									}
									if (r.sending === "count first" && shrinks(r)) {
										const bound = Option.flatMap(j.refusedBy, (k) => constraintOf(f, k))
										const counted = Arr.findFirstIndex(statements, (s) => s.kind === "count")
										if (
											!Option.contains(bound, "bound") ||
											!Option.exists(
												j.moment,
												(m) => m.kind === "statement" && Option.contains(counted, m.index)
											) ||
											!Option.exists(j.refusedBy, (k) => Option.contains(k.law, f.law))
										) {
											return yield* new Disagreed({
												message: `a shrink sent count first was ${j.verdict}, not refused at its count by the bound reporting the family's law: ${Formatter.format(r)}`
											})
										}
										c.note(
											"a shrink sent count first refused at its count by the bound, 23514, reporting the family's law"
										)
									}
								})
						)
					})
				)
		)
	}
)
