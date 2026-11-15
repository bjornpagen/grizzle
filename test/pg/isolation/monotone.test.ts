/**
 * Rules over queries monotone in a READ COMMITTED role's writes (analysis/isolation/certify.ts `laws`, DENSEATS's
 * repro), against PostgreSQL 19: a role generate certifies READ COMMITTED beside a rule its writes fire runs its writes
 * there, its rule's probes reading at COMMIT at a snapshot of their own, and every run of concurrent calls must still be
 * one some strict serial order of the same calls explains; each neighbour that breaks monotonicity stays SERIALIZABLE,
 * and forced READ COMMITTED it is caught.
 *
 * The oracle is the isolation suite's serial reference (support/race.ts runIsolationRace, test/support/schedules/serial.ts):
 * each call a direct transaction of its served write's statements at its role's level, interleaved at statement
 * boundaries; a run passes when some order of the calls that respects real time, each run alone from the race's initial
 * state, shows every statement's rows or SQLSTATE, a rule's refusal at COMMIT among them, and leaves its state.
 *
 * The shapes (monotoneShape), each R(k, n) keyed by k with `Live = R where not E` on the level above, every one but the
 * pair under `check(Below, Live, n < 3)`:
 * - the writer: the `coordinator` inserts R (`hold`) and E (`free`). Its one witness reads one row of R and E's
 *   absence, and E is only inserted, so generate certifies it READ COMMITTED. Raced: a hold of a row over the bound
 *   beside a free of its key, every order.
 * - the deleted: the `holder` inserts R and the `remover` deletes E (`unfree`): E's absence can be made true.
 * - the pair: `key(Live, n)` over the coordinator's inserts of R, two rows of one witness. Its `holdAt` inserts R and
 *   then Q, whose key into P, a relation no role writes, PostgreSQL checks at COMMIT after the rule's probe. Raced
 *   pinned: the owner locks P(1) FOR UPDATE; a hold of n at p 1 runs to its COMMIT, whose probe runs and whose check
 *   then waits on the lock; a hold of the same n at p 2 runs and commits; the owner commits. The two probes overlap,
 *   each before the other's commit, as two COMMITs do on separate connections.
 * - the gated: the `holder` inserts R, the `freer` inserts E(k) where Z(k) is absent (`free`) and the `gater` inserts
 *   Z(k) (`gate`): the freer reads Z unsealed, so it runs SERIALIZABLE and may miss another call's write, and the
 *   holder's probe reads E, which it writes (5c through the probe). Raced on NEGATION's case 3, pinned: the free reads Z
 *   and pauses before its COMMIT, the gate runs, the hold runs and is refused at its probe, then the free commits.
 * - the retired: the `holder` inserts R and E is a retirable unit's body (H its header), which no role writes and the
 *   owner retires (physical/ddl/retire.ts), deleting E's rows of a group. Raced: a hold beside the owner's retirement of
 *   the group holding E(k).
 *
 * Properties: every race of the writer is serial at generate's levels; each other shape's race is serial at generate's
 * levels, and caught (some run no serial order explains) with its writer forced READ COMMITTED (support/race.ts
 * Certifier `forced`).
 *
 * Required features: generate certifies the writer READ COMMITTED and keeps every other shape's writer SERIALIZABLE; a
 * READ COMMITTED hold refused at its probe while the free of its key was in flight, which a strict serial order places
 * before it; a READ COMMITTED hold whose probe read a free that committed after the hold's statements ran, a commit its
 * statement's snapshot never saw, so the probe's fresher read decided it; and each forced writer caught. A commit a
 * monotone probe sees can only withdraw a violation, never add one (certify.ts, its proof's second step), so no run
 * refuses a READ COMMITTED writer for a commit it saw.
 *
 * @plant test/plants/unit/analysis/isolation/monotone-polarity-flipped.patch A write's presence and absence swapped
 * in breaksAt and settable: the holder of the deleted and the coordinator of the pair certified READ COMMITTED; the
 * deleted's race at generate's levels has a run no serial order explains.
 * @plant test/plants/unit/analysis/isolation/monotone-occurrences-deduped.patch The pair's two rows of R counted once,
 * so its coordinator is certified READ COMMITTED; the pair's pinned race at generate's levels has a run no serial
 * order explains.
 * @plant test/plants/unit/analysis/isolation/monotone-retire-without-delete.patch A retirement making rows present
 * alone: the retired's holder certified READ COMMITTED; its race beside the owner's retirement at generate's levels has
 * a run no serial order explains.
 * @plant test/plants/unit/analysis/isolation/monotone-probe-5c-dropped.patch The relations a role's probes read left
 * out of its outside reads: the gated's holder certified READ COMMITTED, NEGATION's case 3 through its probe; the
 * gated's race at generate's levels has a run no serial order explains.
 */
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, retirement } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	login,
	on,
	relation,
	retirable,
	role,
	schema
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import {
	type Certifier,
	type InstalledShape,
	installShape,
	type IsolationRace,
	type RaceCall,
	runIsolationRace,
	type Shape
} from "#test/pg/isolation/support/race.ts"
import { defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import { every, type Strategy } from "#test/support/schedules/interleave.ts"
import type { Explained, RaceTxn } from "#test/support/schedules/serial.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The shapes, by the writer whose rules they test (see the header). */
type Variant = "writer" | "deleted" | "pair" | "gated" | "retired"

/** The shapes whose writer is no monotone one, each caught forced READ COMMITTED. */
type Counter = Exclude<Variant, "writer">

const counters: Arr.NonEmptyReadonlyArray<Counter> = ["deleted", "pair", "gated", "retired"]

/** The role of each shape whose writes fire its rule's probe on R. */
const writerOf = (variant: Variant): string =>
	variant === "writer" || variant === "pair" ? "coordinator" : "holder"

const R = relation("R", { k: pg.integer, n: pg.integer }, ["k"])
const E = relation("E", { k: pg.integer }, ["k"])
const Z = relation("Z", { k: pg.integer }, ["k"])
const P = relation("P", { p: pg.integer, x: pg.integer }, ["p"])
const Q = relation("Q", { k: pg.integer, p: pg.integer }, ["k"])
const H = relation("H", { g: pg.integer, retired: retirement }, ["g"])
const Body = relation("E", { g: pg.integer, k: pg.integer }, ["g", "k"])

/** The bound a live row's n stays below. */
const bound = 3

/**
 * The retired shape under the name `name`: R, and the retirable unit of H and its body E on the level below, the
 * holder's `hold` inserting R.
 */
const retiredShape = (name: string): Shape => {
	const below = schema(name, [R, H, Body], [retirable(H, [on(Body, "g")])])
	const Live = derived(
		"Live",
		query(below).rule((r) => {
			const { k, n } = v(R, "r")
			return r.match(R, { k, n }).where(r.not(Body, { k })).find({ k, n })
		})
	)
	const top = schema.extend(
		below,
		`${name}_1`,
		[Live],
		[check("Below", Live, (l) => l.lt(l.n, bound))]
	)
	const holder = role(top, "holder", { R }, { insert: ["R"] })
	const hold = ChangeSet.empty(holder).insert(
		holder.relations.R,
		query(holder).rule((r) => r.find({ k: r.param("k", pg.integer), n: r.param("n", pg.integer) }))
	)
	return {
		schema: top,
		roles: { holder },
		login: login(top, "app", [holder], { workload: [workload(holder, { hold })] })
	}
}

/** `variant`'s shape under the name `name` (see the header). */
const monotoneShape = (variant: Variant): ((name: string) => Shape) =>
	variant === "retired" ? retiredShape : plainShape(variant)

/** The shape of every variant but the retired, under the name `name`: R, E and Z on the level below. */
const plainShape =
	(variant: Exclude<Variant, "retired">) =>
	(name: string): Shape => {
		const below = schema(name, [R, E, Z, P, Q], [contained(on(Q, "p"), on(P, "p"))])
		const Live = derived(
			"Live",
			query(below).rule((r) => {
				const { k, n } = v(R, "r")
				return r.match(R, { k, n }).where(r.not(E, { k })).find({ k, n })
			})
		)
		const top = schema.extend(
			below,
			`${name}_1`,
			[Live],
			[variant === "pair" ? key(on(Live, "n")) : check("Below", Live, (l) => l.lt(l.n, bound))]
		)
		const writer = role(
			top,
			writerOf(variant),
			{ R, E, P, Q },
			{ insert: variant === "writer" ? ["R", "E"] : variant === "pair" ? ["R", "Q"] : ["R"] }
		)
		const hold = ChangeSet.empty(writer).insert(
			writer.relations.R,
			query(writer).rule((r) =>
				r.find({ k: r.param("k", pg.integer), n: r.param("n", pg.integer) })
			)
		)
		const holdAt = ChangeSet.sequence(
			hold,
			ChangeSet.empty(writer).insert(
				writer.relations.Q,
				query(writer).rule((r) =>
					r.find({ k: r.param("k", pg.integer), p: r.param("p", pg.integer) })
				)
			)
		)
		const free = ChangeSet.empty(writer).insert(
			writer.relations.E,
			query(writer).rule((r) => r.find({ k: r.param("k", pg.integer) }))
		)
		const remover = role(top, "remover", { E }, { write: ["E"] })
		const unfree = ChangeSet.empty(remover).delete(
			remover.relations.E,
			query(remover).rule((r) => {
				const row = v(remover.relations.E, "e")
				return r
					.match(remover.relations.E, row)
					.where(r.eq(row.k, r.param("k", pg.integer)))
					.find(row)
			})
		)
		const freer = role(top, "freer", { E, Z }, { insert: ["E"] })
		const gatedFree = ChangeSet.empty(freer).insert(
			freer.relations.E,
			query(freer).rule((r) =>
				r
					.where(r.not(freer.relations.Z, { k: r.param("k", pg.integer) }))
					.find({ k: r.param("k", pg.integer) })
			)
		)
		const gater = role(top, "gater", { Z }, { insert: ["Z"] })
		const gate = ChangeSet.empty(gater).insert(
			gater.relations.Z,
			query(gater).rule((r) => r.find({ k: r.param("k", pg.integer) }))
		)
		switch (variant) {
			case "writer":
				return {
					schema: top,
					roles: { coordinator: writer },
					login: login(top, "app", [writer], { workload: [workload(writer, { hold, free })] })
				}
			case "deleted":
				return {
					schema: top,
					roles: { holder: writer, remover },
					login: login(top, "app", [writer, remover], {
						workload: [workload(writer, { hold }), workload(remover, { unfree })]
					})
				}
			case "gated":
				return {
					schema: top,
					roles: { holder: writer, freer, gater },
					login: login(top, "app", [writer, freer, gater], {
						workload: [
							workload(writer, { hold }),
							workload(freer, { free: gatedFree }),
							workload(gater, { gate })
						]
					})
				}
			case "pair":
				return {
					schema: top,
					roles: { coordinator: writer },
					login: login(top, "app", [writer], { workload: [workload(writer, { holdAt })] })
				}
		}
	}

/** A call of a race, given the session it runs in. */
type Call = (session: string) => RaceCall

/** A change call of a member of a role with its parameters. */
const change =
	(role: string, member: string, params: ParamMap): Call =>
	(session) => ({ kind: "change", session, role, member, input: { kind: "params", params } })

/** The owner's retirement of group `g` of H, the unit's function no role holds. */
const retire =
	(g: number): Call =>
	(session) => ({
		kind: "owner",
		session,
		statements: (s) => [
			`SELECT ${printObjectName({ schema: s.installed.names.relation("H").schema, name: identifierOf(identity.retire("H")) })}(ARRAY[${g}]::int4[])`
		]
	})

/**
 * The owner's lock of P(p), FOR UPDATE, which a deferred check of Q's key into P waits on: a COMMIT that inserted Q at
 * p runs its rule's probe, queued first, then waits at the check until the owner commits.
 */
const lockP =
	(p: number): Call =>
	(session) => ({
		kind: "owner",
		session,
		statements: (s) => [
			`SELECT 1 FROM ${s.names.table(P)} WHERE ${s.names.column(P, "p")} = ${p} FOR UPDATE`
		]
	})

/** A race of `calls`, each in a session of its own, s0, s1, ..., from `initial`. */
const raceOf = (initial: FactSet, calls: Arr.NonEmptyReadonlyArray<Call>): IsolationRace => ({
	initial,
	calls: Arr.map(calls, (c, i) => c(`s${i}`))
})

/** The values a case races at: a key, another, a row's n over the bound, one under it, and the retired group. */
interface Values {
	readonly k: number
	readonly other: number
	readonly over: number
	readonly under: number
	readonly g: number
}

const valuesGen: Gen<Values> = (source) => {
	const k = source.draw(int(1, 3))
	return {
		k,
		other: (k % 3) + 1,
		over: source.draw(int(bound, bound + 2)),
		under: source.draw(int(0, bound - 1)),
		g: source.draw(int(1, 2))
	}
}

/** Each shape's race at `x` (see the header), and how it runs: every order, or NEGATION's case 3 pinned. */
const raceFor = (
	variant: Variant,
	x: Values
): { readonly race: IsolationRace; readonly pinned: boolean } => {
	switch (variant) {
		case "writer":
			return {
				race: raceOf({}, [
					change("coordinator", "hold", { k: x.k, n: x.over }),
					change("coordinator", "free", { k: x.k })
				]),
				pinned: false
			}
		case "deleted":
			return {
				race: raceOf({ E: [{ k: x.k }] }, [
					change("holder", "hold", { k: x.k, n: x.over }),
					change("remover", "unfree", { k: x.k })
				]),
				pinned: false
			}
		case "pair":
			return {
				race: raceOf(
					{
						P: [
							{ p: 1, x: 0 },
							{ p: 2, x: 0 }
						]
					},
					[
						lockP(1),
						change("coordinator", "holdAt", { k: x.k, n: x.under, p: 1 }),
						change("coordinator", "holdAt", { k: x.other, n: x.under, p: 2 })
					]
				),
				pinned: true
			}
		case "gated":
			return {
				race: raceOf({}, [
					change("freer", "free", { k: x.k }),
					change("gater", "gate", { k: x.k }),
					change("holder", "hold", { k: x.k, n: x.over })
				]),
				pinned: true
			}
		case "retired":
			return {
				race: raceOf({ H: [{ g: x.g, retired: false }], E: [{ g: x.g, k: x.k }] }, [
					change("holder", "hold", { k: x.k, n: x.over }),
					retire(x.g)
				]),
				pinned: false
			}
	}
}

/**
 * A pinned race: s0 runs its statements and pauses before its COMMIT, s1 then s2 run to their ends, a blocked step
 * waiting while the next runs, then s0 commits. In the gated, NEGATION's case 3: s1's span ends before s2's begins, so a
 * strict serial order places it first. In the pair, s0 is the owner's lock that s1's COMMIT waits on.
 */
const pinnedStrategy =
	<F extends string>(c: Case<F>) =>
	(txns: ReadonlyArray<RaceTxn<never>>): Strategy => {
		const s0 = defined(
			Option.getOrUndefined(Arr.findFirst(txns, (t) => t.session === "s0")),
			"the transaction of s0"
		)
		const pause = s0.kind === "direct" ? s0.statements.length : 1
		return {
			kind: "pct",
			schedule: {
				priorities: [
					"s0",
					...Arr.filter(
						Arr.map(txns, (t) => t.session),
						(s) => s !== "s0"
					)
				],
				changes: [pause]
			},
			nature: c
		}
	}

type Feature =
	| "generate certifies the writer READ COMMITTED"
	| "generate keeps every other shape's writer SERIALIZABLE"
	| "a READ COMMITTED hold refused at its probe while a free of its key was in flight"
	| "a READ COMMITTED hold whose probe read a free committed after its statements ran"
	| `the ${Counter} caught forced READ COMMITTED`

/**
 * A session's move in an explained run, where it finished: its COMMIT (`last`), or the statement before it, its last
 * write (`write`).
 */
const finished = (e: Explained<never>, session: string, which: "write" | "last") => {
	const moves = Arr.filter(e.run.moves, (m) => m.session === session)
	return Option.flatMap(
		which === "last" ? Arr.last(moves) : Arr.get(moves, moves.length - 2),
		(m) =>
			m.result._tag === "Finished" ? Option.some({ ...m.result, issued: m.issued }) : Option.none()
	)
}

/**
 * What one explained run of the writer's race reached: s0's hold refused at its COMMIT by Below while s1's free had
 * inserted E and not yet committed; or committed, s1's COMMIT finishing after s0's INSERT finished and before s0's
 * COMMIT was issued.
 */
const writerFeatures = (e: Explained<never>): ReadonlyArray<Feature> => {
	const inserted = finished(e, "s0", "write")
	const committed = finished(e, "s0", "last")
	const freed = finished(e, "s1", "write")
	const freeCommitted = finished(e, "s1", "last")
	if (
		Option.isNone(inserted) ||
		Option.isNone(committed) ||
		Option.isNone(freed) ||
		Option.isNone(freeCommitted)
	) {
		return []
	}
	const outcome = committed.value.outcome
	const refused =
		outcome._tag === "PgError" &&
		outcome.fields.code === "23514" &&
		freed.value.at < committed.value.issued &&
		freeCommitted.value.at > committed.value.at &&
		freeCommitted.value.outcome._tag === "Ok"
	const saw =
		outcome._tag === "Ok" &&
		freeCommitted.value.outcome._tag === "Ok" &&
		freeCommitted.value.at > inserted.value.at &&
		freeCommitted.value.at < committed.value.issued
	return [
		...(refused
			? [
					"a READ COMMITTED hold refused at its probe while a free of its key was in flight" as const
				]
			: []),
		...(saw
			? [
					"a READ COMMITTED hold whose probe read a free committed after its statements ran" as const
				]
			: [])
	]
}

const generate: Certifier = { kind: "generate" }

const runs = 2

layer(Substrate.layer, { excludeTestServices: true })(
	"rules over queries monotone in a READ COMMITTED writer, on PostgreSQL 19",
	(it) => {
		it.effect(
			"the monotone writer runs READ COMMITTED and every race is serial; each neighbour stays SERIALIZABLE, and forced READ COMMITTED is caught",
			(ctx) =>
				searched(
					ctx,
					Effect.scoped(
						Effect.gen(function* () {
							const installed: Readonly<Record<Variant, InstalledShape>> = {
								writer: yield* installShape(monotoneShape("writer"), generate),
								deleted: yield* installShape(monotoneShape("deleted"), generate),
								pair: yield* installShape(monotoneShape("pair"), generate),
								gated: yield* installShape(monotoneShape("gated"), generate),
								retired: yield* installShape(monotoneShape("retired"), generate)
							}
							const forced: Readonly<Record<Counter, InstalledShape>> = {
								deleted: yield* installShape(monotoneShape("deleted"), {
									kind: "forced",
									flaw: "a delete of a relation a rule reads absent left out of the occurrences writes make true",
									roles: ["holder"]
								}),
								pair: yield* installShape(monotoneShape("pair"), {
									kind: "forced",
									flaw: "a key's two rows of R counted as one occurrence",
									roles: ["coordinator"]
								}),
								gated: yield* installShape(monotoneShape("gated"), {
									kind: "forced",
									flaw: "the relations a writer's probes read left out of its outside reads",
									roles: ["holder"]
								}),
								retired: yield* installShape(monotoneShape("retired"), {
									kind: "forced",
									flaw: "a retirable unit's retirement left out of the writes that make a row absent",
									roles: ["holder"]
								})
							}
							return yield* explore(
								{
									oracle: {
										kind: "specification",
										name: "a strict serial order of the same calls"
									},
									suite: "pg/isolation/monotone",
									draw: drawn(valuesGen),
									literal: Formatter.format,
									coverage: required<Feature>(
										[
											"generate certifies the writer READ COMMITTED",
											"generate keeps every other shape's writer SERIALIZABLE",
											"a READ COMMITTED hold refused at its probe while a free of its key was in flight",
											"a READ COMMITTED hold whose probe read a free committed after its statements ran",
											...Arr.map(counters, (c) => `the ${c} caught forced READ COMMITTED` as const)
										],
										{ cases: runs, sense: notesOnly }
									),
									kept: [],
									runs,
									shrink: { kind: "bounded", candidates: 20 },
									concurrency: 1,
									steerEvery: runs,
									caseHang
								},
								(x, c) =>
									Effect.gen(function* () {
										const strategy = (pinned: boolean) =>
											pinned ? pinnedStrategy(c) : (): Strategy => every
										const variants: Arr.NonEmptyReadonlyArray<Variant> = ["writer", ...counters]
										for (const variant of variants) {
											const { race, pinned } = raceFor(variant, x)
											yield* Effect.scoped(
												runIsolationRace(installed[variant], race, strategy(pinned), (e) => {
													if (variant === "writer") {
														for (const f of writerFeatures(e)) {
															c.note(f)
														}
													}
												})
											)
										}
										const level = (variant: Variant) =>
											installed[variant].generated.get(writerOf(variant))
										if (level("writer") === "readCommitted") {
											c.note("generate certifies the writer READ COMMITTED")
										}
										if (Arr.every(counters, (v) => level(v) === "serializable")) {
											c.note("generate keeps every other shape's writer SERIALIZABLE")
										}
										for (const counter of counters) {
											const { race, pinned } = raceFor(counter, x)
											const result = yield* Effect.result(
												Effect.scoped(
													runIsolationRace(forced[counter], race, strategy(pinned), () => undefined)
												)
											)
											if (result._tag === "Failure" && result.failure._tag === "NoSerialOrder") {
												c.note(`the ${counter} caught forced READ COMMITTED`)
											} else if (result._tag === "Failure") {
												return yield* Effect.fail(result.failure)
											} else {
												return yield* Effect.die(
													new Error(
														`the ${counter}: every run is serial with its writer forced READ COMMITTED, so the oracle cannot catch it`
													)
												)
											}
										}
									})
							)
						})
					)
				)
		)
	}
)
