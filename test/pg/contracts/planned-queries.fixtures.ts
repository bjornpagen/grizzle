/**
 * What planned-queries.test.ts reads: its space of schemas and workloads, and each case's run.
 *
 * A case is a unit Doc and one to three of its members, each keyed by `doc` and `k0` and holding `v0`, closed or
 * mutable, a later member half the time a child of the first, a containment PostgreSQL states as a foreign key; half the
 * time the join of every member at `(doc, k0)`, a derived relation the installation stores or reads live, and half of
 * those a check of it, a rule over a query the judge holds. Its workload reads each member and the join by `doc`, inserts
 * every member at once, and puts and deletes each mutable member, a put moving its fact's value in place, a delete of
 * the first member's fact its children reference refused by their foreign key.
 */

import { defined } from "@bjornpagen/testing/assert"
import { array, boolean, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Record as Rec, type Scope } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { plannedQueriesOf, type PlannedQueries } from "#adapter/public/compile.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { pg } from "#compiler/public/fields.ts"
import { contained, mutable, on, schema, unit } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder, relationBuilder } from "#compiler/schema/relation.ts"
import { checkBuilder } from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { Relation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { defaultPool, poolFor } from "#test/pg/adapter/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { readOnce, writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { pgCluster } from "#test/support/env.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import type { SqlError } from "#test/support/pg.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { snapshotValue } from "#test/support/snapshot-json.ts"
import { superuserClient } from "#test/support/substrate/shared.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** A member of the unit: whether it is mutable, and whether it is a child of the first member at `(doc, k0)`. */
interface MemberSketch {
	readonly mutable: boolean
	readonly child: boolean
}

/** A case (see the header): its members, the first never a child, and the join and its check, each where drawn. */
export interface PlanSketch {
	readonly members: Arr.NonEmptyReadonlyArray<MemberSketch>
	readonly join: { readonly kind: "none" } | { readonly kind: "join"; readonly checked: boolean }
}

export const planGen: Gen<PlanSketch> = (source) => {
	const first: MemberSketch = { mutable: source.draw(boolean), child: false }
	const rest = source.draw(
		array((s) => ({ mutable: s.draw(boolean), child: s.draw(boolean) }), { min: 0, max: 2 })
	)
	return {
		members: [first, ...rest],
		join: source.draw(boolean) ? { kind: "join", checked: source.draw(boolean) } : { kind: "none" }
	}
}

/** The situations a case reaches, which the property requires each of. */
export type PlannedFeature =
	| "a rule over a query judged"
	| "a refused write"
	| "a mutable fact put"
	| "a referenced row deleted"
	| "a stored join kept"
	| "a read"

/** The value a lawful call's facts hold, under the check's bound, and a refused call's, past it. */
const lawful = 1n
const bound = 1000n

const memberName = (at: number): string => `M${String(at)}`
const joinName = "J"

/**
 * A generated relation value: its name, fields and key are known only at run time, so its type is the widest the
 * relation constructor gives.
 */
type RelationValue = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** A fact of the join as its check reads it: its v0, and the comparison the check makes of it. */
interface JoinRow {
	readonly v0: unknown
	readonly lt: (a: unknown, b: bigint) => unknown
}

/** The case's schema under `name`, its full world's login, whose workload holds its programs, and the programs. */
export const builtPlan = (s: PlanSketch, name: string) => {
	const members = Arr.map(s.members, (_, at): RelationValue =>
		relationBuilder(
			memberName(at),
			{ doc: pg.bigint, k0: pg.bigint, v0: pg.bigint },
			["doc", "k0"],
			[]
		)
	)
	const memberAt = (at: number): RelationValue => defined(members[at], "a member value")
	const base = schema(name, members, [
		unit("Doc", { doc: pg.bigint }),
		...Arr.flatMap(s.members, (m, at) => (m.mutable ? [mutable(memberAt(at))] : [])),
		...Arr.flatMap(s.members, (m, at) =>
			m.child ? [contained(on(memberAt(at), "doc", "k0"), on(memberAt(0), "doc", "k0"))] : []
		)
	])
	const join =
		s.join.kind === "none"
			? Option.none()
			: Option.some(
					derivedBuilder(
						joinName,
						queryOver(base).rule((r: RuleValue) => {
							const first = varsOver(memberAt(0), "j0")
							let ruled = r.match(memberAt(0), {
								doc: first["doc"],
								k0: first["k0"],
								v0: first["v0"]
							})
							for (const [at, other] of members.slice(1).entries()) {
								const m = varsOver(other, `j${String(at + 1)}`)
								ruled = ruled.match(other, { doc: first["doc"], k0: first["k0"], v0: m["v0"] })
							}
							return ruled.find({ doc: first["doc"], k0: first["k0"], v0: first["v0"] })
						}),
						[]
					)
				)
	const top = Option.match(join, {
		onNone: () => base,
		onSome: (j) => {
			const checks: ReadonlyArray<Statement> =
				s.join.kind === "join" && s.join.checked
					? [checkBuilder("Small", j, (row: JoinRow) => row.lt(row.v0, bound))]
					: []
			return schema.extend([base], `${name}_1`, [j], checks)
		}
	})
	const readOf = (relation: RelationValue | Option.Option.Value<typeof join>, at: string) =>
		queryOver(top).rule((r: RuleValue) => {
			const x = varsOver(relation, at)
			return r
				.match(relation, { doc: r.param("doc", pg.bigint), k0: x["k0"], v0: x["v0"] })
				.find({ k0: x["k0"], v0: x["v0"] })
		})
	const programs: Readonly<Record<string, unknown>> = Rec.fromEntries([
		...Arr.map(members, (m, at) => [`read${String(at)}`, readOf(m, `r${String(at)}`)] as const),
		...Option.match(join, {
			onNone: () => [],
			onSome: (j) => [["readJoin", readOf(j, "rj")] as const]
		}),
		["insertAll", Arr.reduce(members, ChangeSet.empty(top), (cs, m) => cs.insert(m, []))] as const,
		...Arr.flatMap(s.members, (m, at) =>
			m.mutable
				? [
						[`put${String(at)}`, ChangeSet.empty(top).put(memberAt(at), [])] as const,
						[`delete${String(at)}`, ChangeSet.empty(top).delete(memberAt(at), [])] as const
					]
				: []
		)
	])
	return { schema: top, programs, world: fullWorld(top, programs, []) }
}

/** One call of a case: the program it calls, what it sends, and the situation it reaches. */
interface PlanCall {
	readonly program: string
	readonly kind: "read" | "write"
	readonly facts: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>
	readonly params: Readonly<Record<string, unknown>>
	readonly reaches: ReadonlyArray<PlannedFeature>
}

/**
 * The calls of a case, in order: each read; a lawful insert of every member at document 1; where a check holds the join,
 * an insert at document 2 past its bound, which the judge refuses; and a put of each mutable member at document 1, its
 * fact's value moved, then a delete of it, the first's refused where its children reference it. `stored` is whether the installation
 * stores the join, which its upkeep keeps at each write.
 */
const callsOf = (s: PlanSketch, stored: boolean): ReadonlyArray<PlanCall> => {
	const row = (doc: bigint, v0: bigint) => [{ doc, k0: 1n, v0 }]
	const every = (doc: bigint, v0: bigint) =>
		Rec.fromEntries(Arr.map(s.members, (_, at) => [memberName(at), row(doc, v0)] as const))
	const checked = s.join.kind === "join" && s.join.checked
	return [
		...Arr.map(s.members, (_, at) => ({
			program: `read${String(at)}`,
			kind: "read" as const,
			facts: {},
			params: { doc: 1n },
			reaches: ["a read" as const]
		})),
		...(s.join.kind === "join"
			? [
					{
						program: "readJoin",
						kind: "read" as const,
						facts: {},
						params: { doc: 1n },
						reaches: ["a read" as const]
					}
				]
			: []),
		{
			program: "insertAll",
			kind: "write",
			facts: { insert: every(1n, lawful) },
			params: {},
			reaches: [
				...(checked ? (["a rule over a query judged"] as const) : []),
				...(stored ? (["a stored join kept"] as const) : [])
			]
		},
		...(checked
			? [
					{
						program: "insertAll",
						kind: "write" as const,
						facts: { insert: every(2n, bound + 1n) },
						params: {},
						reaches: ["a refused write" as const]
					}
				]
			: []),
		...Arr.flatMap(s.members, (m, at) =>
			m.mutable
				? [
						{
							program: `put${String(at)}`,
							kind: "write" as const,
							facts: { put: { [memberName(at)]: row(1n, lawful + 1n) } },
							params: {},
							reaches: ["a mutable fact put" as const]
						},
						{
							program: `delete${String(at)}`,
							kind: "write" as const,
							facts: { delete: { [memberName(at)]: row(1n, lawful + 1n) } },
							params: {},
							reaches:
								at === 0 && Arr.some(s.members, (c) => c.child)
									? (["a referenced row deleted"] as const)
									: []
						}
					]
				: []
		)
	]
}

/** The settings that turn pg_stat_statements on in the case's database alone, as second-call.fixtures.ts sets them. */
const tracked = [
	"compute_query_id = 'on'",
	"pg_stat_statements.track = 'all'",
	"pg_stat_statements.track_planning = 'on'"
] as const

/** A user and level a call's entries are counted by (PlannedQueries `by`). */
type Class = `${"login" | "role" | "owner"} ${"top" | "nested"}`

/** One call measured: its entries by class, and its bound. */
export interface Measured {
	readonly program: string
	readonly entries: ReadonlyMap<Class, number>
	readonly texts: ReadonlyArray<string>
	readonly bound: PlannedQueries
}

/**
 * The case `s` installed as `grizzle generate` drafts and serves it, its database's statements counted (pg_stat_statements
 * on for it alone), its login's bound read from the compile (plannedQueriesOf, under the snapshot its installation
 * reached), and each of its calls made on a brand-new backend, a session's first call, after pg_stat_statements_reset of
 * the database's entries: each call's entries, by the user each ran as (the login's own, its role, the installation's
 * owner) and whether it ran at the top level, and the bound of its member. `note` notes each situation a call reaches.
 */
export const measured = (
	s: PlanSketch,
	note: (feature: PlannedFeature) => void
): Effect.Effect<ReadonlyArray<Measured>, CompileError | SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const generated = yield* installGenerated(
			(name) => {
				const b = builtPlan(s, name)
				return { schema: b.schema, logins: [b.world.server] }
			},
			{ label: "planned_queries", ambient: ordinarySession }
		)
		const installed = generated.installed
		const b = builtPlan(s, installed.declared)
		const login = b.world.server
		const substrate = yield* Substrate
		for (const setting of tracked) {
			yield* substrate.admin.query(
				`ALTER DATABASE ${quoteIdent(substrate.database)} SET ${setting}`,
				[]
			)
		}
		const statistics = yield* superuserClient(
			substrate.cluster,
			pgCluster.owner,
			"planned queries statistics"
		)
		const [database] = yield* statistics.query(
			"SELECT d.oid::text FROM pg_catalog.pg_database AS d WHERE d.datname = $1::text",
			[substrate.database]
		)
		const dbid = defined(database?.[0] ?? undefined, "the case database's oid")
		const planned = yield* Effect.orDie(
			plannedQueriesOf(
				login,
				snapshotValue(installed.snapshot, installed.installation),
				login.workload
			)
		)
		const bounds = defined(planned.get("app"), "the bound of the full world's role")
		const loginRole = installed.as(login).role
		const db = yield* Effect.orDie(openServedDb(installed, login.roles.app, {}))
		const loaded = yield* Effect.orDie(db.load(b.programs))
		const out: Array<Measured> = []
		const stored = installed.installation.checked.holdings.get(joinName)?.kind === "stored"
		for (const call of callsOf(s, stored)) {
			const entries = yield* Effect.scoped(
				Effect.gen(function* () {
					const pool = yield* poolFor(installed.as(login), { ...defaultPool, pool: { max: 1 } })
					const ctx = { ...db.ctx, pool }
					yield* statistics.query("SELECT public.pg_stat_statements_reset(0, $1::oid, 0)", [dbid])
					const calls = memberCalls(ctx, member(loaded, call.program))
					yield* call.kind === "read"
						? Effect.asVoid(
								Effect.orDie(readOnce(calls)({ params: call.params, facts: call.facts }))
							)
						: Effect.asVoid(
								Effect.orDie(
									writeAnswerOf(writeOnce(calls)({ params: call.params, facts: call.facts }))
								)
							)
					return yield* statistics.query(
						"SELECT r.rolname::text, s.toplevel::text, pg_catalog.left(s.query, 120) FROM public.pg_stat_statements AS s JOIN pg_catalog.pg_roles AS r ON r.oid = s.userid WHERE s.dbid = $1::oid",
						[dbid]
					)
				})
			)
			const classes = new Map<Class, number>()
			for (const [rolname, toplevel] of entries) {
				const user =
					rolname === pgCluster.owner ? "owner" : rolname === loginRole ? "login" : "role"
				const key: Class = `${user} ${toplevel === "true" ? "top" : "nested"}`
				classes.set(key, (classes.get(key) ?? 0) + 1)
			}
			Arr.forEach(call.reaches, note)
			out.push({
				program: call.program,
				entries: classes,
				texts: Arr.map(entries, ([rolname, toplevel, text]) => `${rolname} ${toplevel} ${text}`),
				bound: defined(bounds.get(call.program), `the bound of ${call.program}`)
			})
		}
		return out
	})
