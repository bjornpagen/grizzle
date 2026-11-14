/**
 * A query entry's insertion races a commit at its key: the row it meets outside the entry is its key's law, never a
 * 42501 and never a met row; one inside the entry is met or refused as any occupant is.
 *
 * README, "Rows an insertion met" and "Writing through a role": an insertion through a query entry meets only rows
 * inside the entry. A row outside it at the key, committed after the entry's precheck, refuses the call on the key's
 * law, as the precheck refuses one committed before it. The insert's ON CONFLICT DO SELECT selects only an occupant the
 * entry's membership holds (write/insert/protocol.ts InsertEntry), so PostgreSQL's SELECT policy never meets one outside
 * it (nodeModifyTable.c ExecOnConflictSelect evaluates the WHERE first), and the request it neither inserted nor
 * returned is refused at its key.
 *
 * Seat(id, team, holder) is keyed by id. The role `holder` inserts MySeat, the seats of the session's subject, and Gate,
 * and nothing else, so generate certifies it READ COMMITTED (the case requires it): its insert is the `returned` form.
 * Its workload is `take`, an insertion of a seat through MySeat that reads back the seats it added and met, and
 * `held`, an insertion of a seat and then, in a later stratum, of a Gate row. Two served writers run as two subjects:
 * W runs `held` as carl or as ann, and the owner holds Gate in SHARE mode, so W's seat is written and uncommitted when
 * its Gate insert waits; A runs `take` as ann then, past its precheck, which cannot see W's seat, to the arbiter, where
 * it waits for W; the owner's COMMIT lets W commit, and A's statement meets W's seat.
 *
 * Box: W's subject, carl (outside ann's entry) or ann (inside it); A's seat at W's id or at another, and at W's team or
 * at another. Exhausted.
 *
 * Properties, per case:
 * - A waits for W exactly where it requests W's id, and never where it requests another.
 * - A answers the serial order W, then A: at W's id, carl's seat refuses the call on Seat's key law, the witness A's
 *   submitted id, never 42501 or any other failure; ann's own seat met as an exact repeat is unchanged, read back whole
 *   as met; ann's own seat at another team refuses the call on the key law; at another id A inserts its seat, reading it
 *   back as added.
 * - The table ends as that serial order leaves it.
 *
 * Oracle: specification, the serial order W, then A, over the stated seats.
 *
 * Plant: ~/.cache/grizzle-release/DELTAMET/plants/met-entry-unwhered.patch, the entry's DO SELECT with no WHERE, must
 * turn the property red: carl's seat meets SELECT's policy, 42501.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Fiber, Formatter, Order, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, login, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { assert, deepEquals } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { tokenOf } from "#test/support/worlds.ts"

const Subject = str.regex("^u_[a-z]{1,8}$")
const Seat = relation("Seat", { id: pg.integer, team: pg.integer, holder: Subject }, ["id"])
/** The relation a held call inserts last, which the owner's SHARE lock holds it at. */
const Gate = relation("Gate", { id: pg.uuidv7, n: pg.integer }, ["id"])

/** The schema, the role `holder`, which inserts its subject's seats and Gate, and its two logins. */
const seats = (name: string) => {
	const base = schema(name, [Seat, Gate], [])
	const Session = context("Session", { sub: Subject })
	const mine = query(base).rule((r) => {
		const { id, team, holder } = v(Seat, "seat")
		return r.match(Seat, { id, team, holder }).match(Session, { sub: holder }).find({ id, team })
	})
	const holder = role(base, "holder", { MySeat: mine, Gate }, { insert: ["MySeat", "Gate"] })
	const direct = role(base, "direct", { Seat, Gate })
	const MySeat = holder.relations.MySeat
	return {
		schema: base,
		holder,
		direct,
		server: login(base, "server", [holder], {
			workload: [
				workload(holder, {
					take: ChangeSet.empty(holder)
						.insert(MySeat, [])
						.read("added", (d) =>
							query(holder).rule((r) => {
								const { id, team } = v(d.added(MySeat), "seat")
								return r.match(d.added(MySeat), { id, team }).find({ id, team })
							})
						)
						.read("met", (d) =>
							query(holder).rule((r) => {
								const { id, team } = v(d.met(MySeat), "seat")
								return r.match(d.met(MySeat), { id, team }).find({ id, team })
							})
						),
					held: ChangeSet.sequence(
						ChangeSet.empty(holder).insert(MySeat, []),
						ChangeSet.empty(holder).insert(Gate, [])
					)
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** One case of the box. */
interface Race {
	/** Whether W runs as carl, outside ann's entry, or as ann. */
	readonly outside: boolean
	/** Whether A requests W's id, and whether at W's team. */
	readonly sameId: boolean
	readonly sameTeam: boolean
}

const raceGen: Gen<Race> = (source) => ({
	outside: source.draw(boolean),
	sameId: source.draw(boolean),
	sameTeam: source.draw(boolean)
})

type RaceFeature =
	| "an outside seat committed after the precheck, refused on the key's law"
	| "an own seat in flight met as an exact repeat"
	| "an own seat in flight at another team, refused on the key's law"
	| "a free id, inserted without waiting"

/** A seat a call reads back, as a plain record. */
const seatOf = (r: { readonly id: number; readonly team: number }) => ({ id: r.id, team: r.team })

/** W's seat, and A's at another id or team. */
const wId = 1
const wTeam = 1
const otherId = 2
const otherTeam = 2

layer(Substrate.layer)("a query entry's insertion racing a commit at its key", (it) => {
	it.effect("refuses an outside occupant on the key's law and meets an inside one", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const rig = yield* openRig(seats)
				const names = namesOf(rig.installed)
				const seatTable = names.table(Seat)
				const gate = names.table(Gate)
				const column = (field: "id" | "team" | "holder") => names.column(Seat, field)
				const openAs =
					(sub: string) => (context: Parameters<Parameters<typeof rig.servedWriter>[1]>[0]) =>
						openServed(rig.served.roles.holder, { token: tokenOf({ sub }) }).pipe(
							Effect.provideContext(context)
						)
				const a = yield* rig.servedWriter("a", openAs("u_ann"), (db) =>
					answered(db.workload.take.once({ params: {}, facts: { insert: { MySeat: [] } } }))
				)
				const carl = yield* rig.servedWriter("carl", openAs("u_carl"), (db) =>
					answered(db.workload.take.once({ params: {}, facts: { insert: { MySeat: [] } } }))
				)
				const ann = yield* rig.servedWriter("ann", openAs("u_ann"), (db) =>
					answered(db.workload.take.once({ params: {}, facts: { insert: { MySeat: [] } } }))
				)
				assert.equal(a.ctx.isolation, "readCommitted", "generate certifies holder READ COMMITTED")
				const { owner } = yield* openActors(s, {
					owner: { kind: "raw", as: rig.installed.ambientOwner.credentials }
				})
				const state = Effect.map(
					s.admin.queryValues(
						`SELECT ${column("id")}::text, ${column("team")}::text, ${column("holder")}::text FROM ${seatTable} ORDER BY 1`,
						[]
					),
					(rows) => Arr.map(rows, (row) => Arr.join(Arr.map(row, String), ","))
				)
				/** Whether a backend `waiter` waited for `holder` before `fiber` ended (collisions.test.ts). */
				const waitedOrEnded = <A>(fiber: Fiber.Fiber<A>, waiter: number, holder: number) =>
					Effect.gen(function* () {
						for (;;) {
							if (fiber.pollUnsafe() !== undefined) {
								return "ended" as const
							}
							const wait = yield* lockWaitOf(s.admin, waiter)
							if (wait?.blockedBy.includes(holder) === true) {
								return "waited" as const
							}
							yield* Effect.yieldNow
						}
					})
				return yield* exhaust(
					{
						suite: "schedules/write/entry-occupants",
						generator: raceGen,
						literal: Formatter.format,
						coverage: requiredInSpace<RaceFeature>([
							"an outside seat committed after the precheck, refused on the key's law",
							"an own seat in flight met as an exact repeat",
							"an own seat in flight at another team, refused on the key's law",
							"a free id, inserted without waiting"
						]),
						caseHang,
						box: "W as carl or as ann; A's seat at W's id or another, at W's team or another",
						oracle: {
							kind: "specification",
							name: "the serial order W, then A, over the stated seats"
						},
						concurrency: 1
					},
					(c, k) =>
						Effect.gen(function* () {
							yield* rig.replace([])
							const w = c.outside ? carl : ann
							const wSub = c.outside ? "u_carl" : "u_ann"
							const request = { id: c.sameId ? wId : otherId, team: c.sameTeam ? wTeam : otherTeam }
							yield* owner.perform({ _tag: "Begin" })
							yield* owner.perform({ _tag: "Sql", sql: `LOCK TABLE ${gate} IN SHARE MODE` })
							const fiberW = yield* Effect.forkChild(
								Effect.result(
									answered(
										w.db.workload.held.once({
											params: {},
											facts: { insert: { MySeat: [{ id: wId, team: wTeam }], Gate: [{ n: 0 }] } }
										})
									)
								),
								{ startImmediately: true }
							)
							const atGate = yield* waitedOrEnded(fiberW, w.actor.pid, owner.pid)
							assert.equal(atGate, "waited", "W writes its seat and waits at Gate")
							const fiberA = yield* Effect.forkChild(
								Effect.result(
									answered(
										a.db.workload.take.once({
											params: {},
											facts: { insert: { MySeat: [request] } }
										})
									)
								),
								{ startImmediately: true }
							)
							const waited = yield* waitedOrEnded(fiberA, a.actor.pid, w.actor.pid)
							yield* owner.perform({ _tag: "Commit" })
							const ranW = yield* Fiber.join(fiberW)
							const ranA = yield* Fiber.join(fiberA)
							const final = yield* state
							assert.ok(Result.isSuccess(ranW), `W commits its seat: ${Formatter.format(ranW)}`)
							assert.equal(
								waited === "waited",
								c.sameId,
								"A waits for W exactly where it requests W's id"
							)
							const wRow = `${wId},${wTeam},${wSub}`
							const aRow = `${request.id},${request.team},u_ann`
							assert.ok(Result.isSuccess(ranA), `A answers, never fails: ${Formatter.format(ranA)}`)
							const answer = ranA.success
							if (!c.sameId) {
								assert.ok(
									answer.kind === "accepted" &&
										deepEquals(Arr.map(answer.reads.added, seatOf), [
											{ id: request.id, team: request.team }
										]) &&
										answer.reads.met.length === 0,
									`A inserts its seat at a free id, reading it back as added: ${Formatter.format(answer)}`
								)
								assert.deepEqual(
									final,
									Arr.sort([wRow, aRow], Order.String),
									"the table holds both seats"
								)
								k.note("a free id, inserted without waiting")
								return
							}
							if (!c.outside && c.sameTeam) {
								assert.ok(
									answer.kind === "unchanged" &&
										answer.reads.added.length === 0 &&
										deepEquals(Arr.map(answer.reads.met, seatOf), [{ id: wId, team: wTeam }]),
									`A's exact repeat of ann's own seat is unchanged, met: ${Formatter.format(answer)}`
								)
								assert.deepEqual(final, [wRow], "the table holds W's seat")
								k.note("an own seat in flight met as an exact repeat")
								return
							}
							assert.ok(
								answer.kind === "refused" &&
									Arr.length(answer.refused.laws) === 1 &&
									answer.witness.kind === "key" &&
									deepEquals(answer.witness.values, { id: wId }),
								`A is refused on Seat's key law at its submitted id: ${Formatter.format(answer)}`
							)
							assert.deepEqual(final, [wRow], "the table holds W's seat alone")
							k.note(
								c.outside
									? "an outside seat committed after the precheck, refused on the key's law"
									: "an own seat in flight at another team, refused on the key's law"
							)
						})
				)
			})
		)
	)
})
