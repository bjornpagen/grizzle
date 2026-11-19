/** What the properties of monotone.test.ts read: its spaces, models and helpers. */

import type { Case } from "@bjornpagen/testing/explore"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
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
	certifiedShapeTemplate,
	generatedShapeTemplate,
	type InstalledShape,
	type IsolationRace,
	type RaceCall,
	type Shape
} from "#test/pg/isolation/support/race.ts"
import { defined } from "#test/support/assert.ts"
import type { Generated } from "#test/support/install-migrate.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"
import type { Strategy } from "#test/support/schedules/interleave.ts"
import type { Explained, RaceTxn } from "#test/support/schedules/serial.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/** The shapes, by the writer whose rules they test (see the header). */
export type Variant = "writer" | "deleted" | "pair" | "gated" | "retired"

/** The shapes whose writer is no monotone one, each caught forced READ COMMITTED. */
export type Counter = Exclude<Variant, "writer">

export const counters: Arr.NonEmptyReadonlyArray<Counter> = ["deleted", "pair", "gated", "retired"]

/** The role of each shape whose writes fire its rule's probe on R. */
export const writerOf = (variant: Variant): string =>
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
export const monotoneShape = (variant: Variant): ((name: string) => Shape) =>
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

/** The owner's retirement of group `g` of H, the unit's function no role holds, its counts each a bigint[] row
 * (physical/ddl/retire.ts), read as text, as a schedule compares rows (schedules/actors.ts textOfValue). */
const retire =
	(g: number): Call =>
	(session) => ({
		kind: "owner",
		session,
		statements: (s) => [
			`SELECT "c"::text AS "counts" FROM ${printObjectName({ schema: s.installed.names.relation("H").schema, name: identifierOf(identity.retire("H")) })}(ARRAY[${g}]::int4[]) AS "c"`
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

export const valuesGen: Gen<Values> = (source) => {
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
export const raceFor = (
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
export const pinnedStrategy =
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

export type Feature =
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
export const writerFeatures = (e: Explained<never>): ReadonlyArray<Feature> => {
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

/** Each variant's shape installed once per member as generate certifies it (race.ts generatedShapeTemplate). */
export const generatedShapes: Readonly<Record<Variant, SubstrateTemplate<Generated>>> = {
	writer: generatedShapeTemplate(import.meta, "monotone writer", monotoneShape("writer")),
	deleted: generatedShapeTemplate(import.meta, "monotone deleted", monotoneShape("deleted")),
	pair: generatedShapeTemplate(import.meta, "monotone pair", monotoneShape("pair")),
	gated: generatedShapeTemplate(import.meta, "monotone gated", monotoneShape("gated")),
	retired: generatedShapeTemplate(import.meta, "monotone retired", monotoneShape("retired"))
}

/**
 * Each counter's shape installed once per member with its writer forced READ COMMITTED, the flaw it stands for stated
 * (race.ts certifiedShapeTemplate).
 */
export const forcedShapes: Readonly<Record<Counter, SubstrateTemplate<InstalledShape>>> = {
	deleted: certifiedShapeTemplate(
		import.meta,
		"monotone forced deleted",
		monotoneShape("deleted"),
		{
			kind: "forced",
			flaw: "a delete of a relation a rule reads absent left out of the occurrences writes make true",
			roles: ["holder"]
		}
	),
	pair: certifiedShapeTemplate(import.meta, "monotone forced pair", monotoneShape("pair"), {
		kind: "forced",
		flaw: "a key's two rows of R counted as one occurrence",
		roles: ["coordinator"]
	}),
	gated: certifiedShapeTemplate(import.meta, "monotone forced gated", monotoneShape("gated"), {
		kind: "forced",
		flaw: "the relations a writer's probes read left out of its outside reads",
		roles: ["holder"]
	}),
	retired: certifiedShapeTemplate(
		import.meta,
		"monotone forced retired",
		monotoneShape("retired"),
		{
			kind: "forced",
			flaw: "a retirable unit's retirement left out of the writes that make a row absent",
			roles: ["holder"]
		}
	)
}

export const runs = 2
