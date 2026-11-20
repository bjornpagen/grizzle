/** What batched.test.ts reads: its schema, its space, and each case's run. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import {
	attemptLabel,
	explainedChange,
	installWrites,
	observedChange,
	openFull
} from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Text = str.bytes(512, str.regex("^.*$", "su"))

/**
 * Nodes of documents, wide as edullm's qti.node is: keyed (doc, path, at), and by `seq` alone, a second key, so its
 * insert arbitrates every key and reads its met rows through the met window (sql/ast.ts FromSource `metRows`).
 */
const Wide = relation(
	"Wide",
	{ doc: pg.bigint, path: Text, at: pg.bigint, seq: pg.bigint, body: Text },
	["doc", "path", "at"]
)

/** A note a call writes first, in a stratum of its own before the insert (ChangeSet.sequence). */
const Note = relation("Note", { id: pg.bigint }, ["id"])

const build = (name: string) => schema(name, [Note, Wide], [key(on(Wide, "seq"))])

/**
 * A case: how many facts one call inserts, how wide each fact's body is, whether two of them, the first and the last,
 * share a `seq`, which the second key refuses, and whether the call writes a note first, in a stratum before the
 * insert's, in its one transaction.
 */
export interface Batched {
	readonly facts: number
	readonly body: number
	readonly pair: boolean
	readonly after: boolean
}

/**
 * Thousands of facts of hundreds of bytes: past PostgreSQL's default work_mem in one execution, whose met window sorts
 * every fact twice and whose CTEs keep them, and past one execution's share of it.
 */
export const batchedGen: Gen<Batched> = (s) => ({
	facts: s.draw(int(8000, 14000)),
	body: s.draw(int(200, 400)),
	pair: s.draw(element([false, true] as const)),
	after: s.draw(element([false, true] as const))
})

export type BatchedFeature =
	| "every fact inserted"
	| "a pair across executions refused"
	| "after a write of the same transaction"

/** Fact `i` of a case: document i mod 7, a long path, at i, `seq` i (the last the first's where the case pairs them). */
const factOf = (c: Batched, i: number) => ({
	doc: BigInt(i % 7),
	path: `document/${Str.padStart(6, "0")(String(i % 997))}/${Str.repeat(120)("p")}`,
	at: BigInt(i),
	seq: c.pair && i === c.facts - 1 ? 0n : BigInt(i),
	body: `${Str.repeat(c.body)("b")}${String(i)}`
})

/**
 * One case on a fresh installation: the call's facts inserted, after a note in a stratum of its own where the case
 * draws it, under EXPLAIN (ANALYZE, BUFFERS), rolled back, then applied. Its executions are several, each of a share of the facts within PostgreSQL's default work_mem, none of which
 * writes a temporary block: the temporary files of a write are O(B × width) for its share B, never O(N × width) for
 * its N facts. Applied, it inserts every fact once, as the host counts them; or, where two facts share `seq`, the
 * first in the first share and the last in the last, it is refused on the second key's law, as one execution of every
 * fact refuses the pair, and stores nothing, the note before it included: a batched flight a statement refuses is sent
 * again whole, every statement of its transaction with it.
 */
export const runBatched = (c: Batched, k: Case<BatchedFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("Batched"), "batched", { programs: {}, logins: [] })
			const S = build(fx.installed.declared)
			const db = yield* openFull(fx, S)
			const facts = Arr.map(indices(c.facts), (i) => factOf(c, i))
			const inserted = ChangeSet.empty(S).insert(Wide, facts)
			const change = c.after
				? ChangeSet.sequence(ChangeSet.empty(S).insert(Note, [{ id: 1n }]), inserted)
				: inserted
			if (!c.pair) {
				const plans = yield* explainedChange(db, change)
				assert.ok(
					plans.length > 1,
					`${Formatter.format(c)}: the insert of ${c.facts} facts runs in several executions, ${plans.length} ran`
				)
				assert.ok(
					Arr.every(plans, (p) => p.plan.buffers.tempWritten === 0),
					`${Formatter.format(c)}: no execution of the insert writes a temporary block, its ${plans.length} wrote ${Formatter.format(Arr.map(plans, (p) => p.plan.buffers.tempWritten))} blocks`
				)
			}
			const store = yield* observedChange(db, change, attemptLabel, { kind: "none" })
			const applied = yield* store.apply({})
			const outcome = applied.value
			if (!c.pair) {
				assert.equal(outcome.kind, "accepted", `${Formatter.format(c)}: the insert is accepted`)
				const added =
					outcome.kind === "accepted"
						? Option.getOrUndefined(Arr.findFirst(outcome.counts, (n) => n.relation === "Wide"))
								?.added
						: undefined
				assert.equal(added, BigInt(c.facts), `${Formatter.format(c)}: every fact is added once`)
				const substrate = yield* Substrate
				const stored = yield* substrate.admin.queryValues(
					`SELECT count(*)::text, count(DISTINCT seq)::text FROM ${fx.table("Wide")}`,
					[]
				)
				assert.deepEqual(
					stored,
					[[String(c.facts), String(c.facts)]],
					`${Formatter.format(c)}: the table holds every fact once`
				)
				const notes = yield* substrate.admin.queryValues(
					`SELECT count(*)::text FROM ${fx.table("Note")}`,
					[]
				)
				assert.deepEqual(
					notes,
					[[c.after ? "1" : "0"]],
					`${Formatter.format(c)}: the note the call writes first is stored with the facts`
				)
				k.note("every fact inserted")
				if (c.after) {
					k.note("after a write of the same transaction")
				}
				return
			}
			assert.equal(
				outcome.kind,
				"invariant-rejected",
				`${Formatter.format(c)}: two facts at one seq are refused, not ${outcome.kind}`
			)
			const substrate = yield* Substrate
			const left = yield* substrate.admin.queryValues(
				`SELECT (SELECT count(*) FROM ${fx.table("Note")})::text, (SELECT count(*) FROM ${fx.table("Wide")})::text`,
				[]
			)
			assert.deepEqual(
				left,
				[["0", "0"]],
				`${Formatter.format(c)}: the refused call stores nothing`
			)
			k.note("a pair across executions refused")
			if (c.after) {
				k.note("after a write of the same transaction")
			}
		})
	)
