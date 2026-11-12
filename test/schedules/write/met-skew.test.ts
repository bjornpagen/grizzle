/**
 * A SERIALIZABLE insertion's met row is a read SSI sees: an insertion that meets a stored row as an exact repeat, beside
 * a write another transaction read the absence of, and that transaction's deletion of the met row are a write skew,
 * which SSI refuses with 40001.
 *
 * Held(id, k, a) draws `id` by its `uuidv7()` default and is keyed by k, so a generated addition arbitrates at k: the
 * `returned` form of write/insert/protocol.ts, ON CONFLICT (k) DO SELECT, whose fetch of the occupant takes no SIRead
 * lock, so at SERIALIZABLE each met row is read again at its key under the transaction's snapshot. Mark(k) is a pure
 * set. The role `writer` inserts both, and its workload is `meet`, an insertion of Held and of Mark in one stratum that
 * reads back the Held rows it added and the stored ones it met. The role `direct` deletes Held, so generate serves
 * `writer` SERIALIZABLE (the case requires it). The stored state is m = Held(k 1, a 0) and o = Held(k 2, a 0).
 *
 * One schedule per case: D, a direct SQL session of `direct`, begins SERIALIZABLE and reads whether Mark holds a key;
 * L, a served writer of `writer`, runs `meet` and commits; D deletes a stored Held row and commits.
 *
 * Box: L's Held request repeats m exactly (k 1, a 0) or states a free key (k 3, a 0); D deletes m or o; D reads Mark at
 * L's key, 5, or at another, 6. Exhausted.
 *
 * Properties, per case:
 * - L commits, reading back as met exactly the stored m, its id included, where it repeats m, and as added exactly the
 *   row it made at k 3, with its drawn id, where it states that key.
 * - Every run is serializable: where L met m, D read the absence of L's Mark row and D deletes m, no serial order
 *   explains both (L before D would show D L's mark; D before L would leave L no m to meet), so D fails with 40001.
 *   Anywhere else D commits, or fails with 40001 where SSI judges coarser than the rows (a relation-level SIRead lock
 *   of a sequential scan), and the table ends as L, then D, leaves it.
 *
 * Oracle: specification, the two serial orders of L and D over the stated rows.
 *
 * Plant: ~/.cache/grizzle-release/DELTAMET/plants/met-unseen.patch, a SERIALIZABLE `returned` insert classing a met row
 * with no read of it under the snapshot, must turn the property red: the skew commits.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { DeltaSource } from "#compiler/types/changeset/changeset.ts"
import { assert, defined } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import type { ScheduleOutcome } from "#test/support/schedules/types.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Held = relation("Held", { id: pg.uuidv7, k: pg.integer, a: pg.integer }, ["id"])
const Mark = relation("Mark", { k: pg.integer }, ["k"])
const heldKey = key(on(Held, "k"))

/** The schema, the role `writer`, which inserts Held and Mark, and `direct`, which writes both, and their logins. */
const skew = (name: string) => {
	const base = schema(name, [Held, Mark], [heldKey])
	const writer = role(base, "writer", { Held, Mark }, { insert: ["Held", "Mark"] })
	const direct = role(base, "direct", { Held, Mark }, { write: ["Held", "Mark"] })
	const heldOf = (side: DeltaSource<typeof Held>) =>
		query(base).rule((r) => {
			const { id, k, a } = v(side, "held")
			return r.match(side, { id, k, a }).find({ id, k, a })
		})
	return {
		schema: base,
		writer,
		direct,
		server: login(base, "server", [writer], {
			workload: [
				workload(writer, {
					meet: ChangeSet.empty(base)
						.insert(Held, [])
						.insert(Mark, [])
						.read("added", (d) => heldOf(d.added(Held)))
						.read("met", (d) => heldOf(d.met(Held)))
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** One case of the box. */
interface Skew {
	/** Whether L's Held request repeats m exactly, or states the free key 3. */
	readonly repeats: boolean
	/** Whether D deletes m, or o. */
	readonly deletesMet: boolean
	/** Whether D reads Mark at L's key, or at another. */
	readonly readsMark: boolean
}

const skewGen: Gen<Skew> = (source) => ({
	repeats: source.draw(boolean),
	deletesMet: source.draw(boolean),
	readsMark: source.draw(boolean)
})

type SkewFeature =
	| "the skew through a met row refused with 40001"
	| "a met row D does not delete, D committed"
	| "a met row D deletes, beside no read of L's mark, D committed"
	| "a new row beside D's deletion, D committed"
	| "a 40001 no skew forces"

/** L's Mark key, and the one D reads otherwise. */
const markKey = 5
const otherMark = 6

/** A Held row as L reads it back. */
interface HeldRow {
	readonly id: string
	readonly k: number
	readonly a: number
}

/** A Held row as the table's state reads it: k, a and id, each as text. */
interface HeldText {
	readonly k: string
	readonly a: string
	readonly id: string
}

const heldText = (r: HeldRow): HeldText => ({ k: String(r.k), a: String(r.a), id: r.id })

const byKey = (rows: ReadonlyArray<HeldText>): ReadonlyArray<HeldText> =>
	Arr.sort(
		rows,
		Order.mapInput(Order.String, (r: HeldText) => r.k)
	)

/** Whether a schedule outcome is SSI's serialization failure: 40001 at a statement, or a COMMIT rolled back. */
const isSerialization = (o: ScheduleOutcome): boolean =>
	(o._tag === "PgError" && o.fields.code === "40001") || o._tag === "RolledBack"

layer(Substrate.layer)("a SERIALIZABLE insertion's met row", (it) => {
	it.effect("is a read SSI sees: a write skew through it never commits", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const rig = yield* openRig(skew)
				const names = namesOf(rig.installed)
				const held = names.table(Held)
				const mark = names.table(Mark)
				const column = (field: "id" | "k" | "a") => names.column(Held, field)
				const markColumn = names.column(Mark, "k")
				const l = yield* rig.servedWriter(
					"l",
					(context) => openServed(rig.served.roles.writer, {}).pipe(Effect.provideContext(context)),
					(db) =>
						answered(
							db.workload.meet.once({ params: {}, facts: { insert: { Held: [], Mark: [] } } })
						)
				)
				assert.equal(
					l.ctx.isolation,
					"serializable",
					"a role beside a deleter of Held runs SERIALIZABLE"
				)
				const { d } = yield* openActors(s, { d: { kind: "raw", as: rig.direct } })
				const heldState = Effect.map(
					s.admin.queryValues(
						`SELECT ${column("k")}::text, ${column("a")}::text, ${column("id")}::text FROM ${held} ORDER BY 1`,
						[]
					),
					(rows): ReadonlyArray<HeldText> =>
						Arr.map(rows, ([k, a, id]) => ({ k: String(k), a: String(a), id: String(id) }))
				)
				const markState = Effect.map(
					s.admin.queryValues(`SELECT ${markColumn}::text FROM ${mark} ORDER BY 1`, []),
					(rows) => Arr.map(rows, ([k]) => String(k))
				)
				return yield* exhaust(
					{
						suite: "schedules/write/met-skew",
						generator: skewGen,
						literal: Formatter.format,
						coverage: requiredInSpace<SkewFeature>([
							"the skew through a met row refused with 40001",
							"a new row beside D's deletion, D committed"
						]),
						caseHang,
						box: "L's Held request a repeat of m or a free key; D deleting m or o; D reading Mark at L's key or another",
						oracle: {
							kind: "specification",
							name: "the two serial orders of L and D over the stated rows"
						}
					},
					(c, k) =>
						Effect.gen(function* () {
							yield* rig.replace([
								`INSERT INTO ${held} (${column("k")}, ${column("a")}) VALUES (1, 0), (2, 0)`
							])
							const before = yield* heldState
							const at = (key: string): HeldText =>
								defined(
									Option.getOrUndefined(Arr.findFirst(before, (r) => r.k === key)),
									`the stored row at k ${key}`
								)
							const m = at("1")
							const o = at("2")
							const target = c.deletesMet ? m : o
							yield* d.perform({ _tag: "Begin" })
							const read = yield* d.perform({
								_tag: "Sql",
								sql: `SELECT 1 FROM ${mark} WHERE ${markColumn} = ${c.readsMark ? markKey : otherMark}`
							})
							assert.equal(read._tag, "Ok", "D reads Mark")
							const ran = yield* Effect.result(
								answered(
									l.db.workload.meet.once({
										params: {},
										facts: {
											insert: { Held: [{ k: c.repeats ? 1 : 3, a: 0 }], Mark: [{ k: markKey }] }
										}
									})
								)
							)
							const deleted = yield* d.perform({
								_tag: "Sql",
								sql: `DELETE FROM ${held} WHERE ${column("id")} = '${target.id}'`
							})
							const ended = deleted._tag === "Ok" ? yield* d.perform({ _tag: "Commit" }) : deleted
							if (ended._tag !== "Ok" && ended._tag !== "RolledBack") {
								yield* d.perform({ _tag: "Rollback" })
							}
							const after = yield* heldState
							const marks = yield* markState
							assert.ok(Result.isSuccess(ran), `L commits: ${Formatter.format(ran)}`)
							const outcome = ran.success
							assert.ok(
								outcome.kind === "accepted" || outcome.kind === "unchanged",
								`L inserts its mark: ${Formatter.format(outcome)}`
							)
							const made = Arr.filter(after, (r) => r.k === "3")
							assert.deepEqual(
								byKey(Arr.map(outcome.reads.met, heldText)),
								c.repeats ? [m] : [],
								"L reads back as met exactly the stored m it repeats, its id included"
							)
							assert.deepEqual(
								byKey(Arr.map(outcome.reads.added, heldText)),
								c.repeats ? [] : made,
								"L reads back as added exactly the row it made, its drawn id included"
							)
							assert.deepEqual(marks, [String(markKey)], "L's mark is stored")
							if (c.repeats && c.deletesMet && c.readsMark) {
								assert.ok(
									isSerialization(ended),
									`D, whose deletion of the met m and read of the absence of L's mark no serial order explains beside L, fails with 40001: ${Formatter.format(ended)}`
								)
								k.note("the skew through a met row refused with 40001")
								return
							}
							if (ended._tag !== "Ok") {
								assert.ok(
									isSerialization(ended),
									`D fails only by a serialization failure: ${Formatter.format(ended)}`
								)
								k.note("a 40001 no skew forces")
								return
							}
							assert.deepEqual(
								after,
								byKey(Arr.filter([...before, ...made], (r) => r.id !== target.id)),
								"the table ends as L, then D, leave it"
							)
							k.note(
								!c.repeats
									? "a new row beside D's deletion, D committed"
									: c.deletesMet
										? "a met row D deletes, beside no read of L's mark, D committed"
										: "a met row D does not delete, D committed"
							)
						})
				)
			})
		)
	)
})
