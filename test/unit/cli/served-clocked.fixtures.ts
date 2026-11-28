/** What the properties of served-clocked.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, eachServedFile } from "#cli/generate.ts"
import { type ReasonAt, reasonsOf, type RoleCertificate } from "#compiler/core/certificate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { clockedMember, workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Num, Type } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	login,
	on,
	relation,
	role,
	schema,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { servedFile } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import { succeeded } from "#test/support/assert.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { repoRoot } from "#test/support/files.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { offlineOwner } from "#test/support/pg/cli/support.ts"

const instantKey = Symbol("Instant")
const Instant = contract<typeof instantKey>()("Instant", pg.bigint)

const Step = relation("Step", { id: pg.integer }, ["id"])

const Claim = relation(
	"Claim",
	{ step: pg.integer, attempt: pg.integer, at: Instant, ttl: pg.bigint },
	["step", "attempt"]
)

const Stamp = relation("Stamp", { key: pg.integer, at: Instant }, ["key", "at"])

const Wanted = relation("Wanted", { key: pg.integer, due: Instant }, ["key"])

const Box = schema(
	"ClockBox",
	[Step, Claim, Stamp, Wanted],
	[contained(on(Claim, "step"), on(Step, "id"))]
)

/** The clock box's change programs, each reading `now` as an Instant. */
const changes = {
	/** A claim of a step's attempt, stamped with `now`. */
	claim: ChangeSet.empty(Box).insert(
		Claim,
		query(Box).rule((r) =>
			r.find({
				step: r.param("step", pg.integer),
				attempt: r.param("attempt", pg.integer),
				at: r.param("now", Instant),
				ttl: r.param("ttl", pg.bigint)
			})
		)
	),
	/** LEASE's reclaim: the next attempt, from a whole-key read of the expired one. */
	reclaim: ChangeSet.empty(Box).insert(
		Claim,
		query(Box).rule((r) => {
			const { step, attempt, at, ttl } = v(Claim, "held")
			return r
				.match(Claim, { step, attempt, at, ttl })
				.where(
					r.and([
						r.eq(step, r.param("step", pg.integer)),
						r.eq(attempt, r.param("attempt", pg.integer)),
						r.lt(Num.add(Type.base(at), ttl), Type.base(r.param("now", Instant)))
					])
				)
				.find({ step, attempt: r.param("next", pg.integer), at: r.param("now", Instant), ttl })
		})
	),
	/** A stamp keyed by its instant: a key one of whose fields is `now`. */
	stamp: ChangeSet.empty(Box).insert(
		Stamp,
		query(Box).rule((r) => r.find({ key: r.param("key", pg.integer), at: r.param("now", Instant) }))
	),
	/**
	 * A wanted row from the stamp at its key and instant: a point read of Stamp at its whole key, which `now` binds one
	 * field of, so a reading the extractor did not read as a parameter would leave the key unbound.
	 */
	fromStamp: ChangeSet.empty(Box).insert(
		Wanted,
		query(Box).rule((r) => {
			const { key, at } = v(Stamp, "stamp")
			return r
				.match(Stamp, { key, at })
				.where(r.and([r.eq(key, r.param("key", pg.integer)), r.eq(at, r.param("now", Instant))]))
				.find({ key, due: at })
		})
	),
	/** A stamp of every wanted key due at or before `now`: a range read. */
	due: ChangeSet.empty(Box).insert(
		Stamp,
		query(Box).rule((r) => {
			const { key, due } = v(Wanted, "wanted")
			return r
				.match(Wanted, { key, due })
				.where(r.le(due, r.param("now", Instant)))
				.find({ key, at: r.param("now", Instant) })
		})
	)
} as const

/** The clock box's reads: one of what is due at `now`, which a clock may bind, and two that read no clock. */
const reads = {
	dueNow: query(Box).rule((r) => {
		const { key, due } = v(Wanted, "wanted")
		return r
			.match(Wanted, { key, due })
			.where(r.le(due, r.param("now", Instant)))
			.find({ key, due })
	}),
	wanted: query(Box).rule((r) => {
		const { key, due } = v(Wanted, "wanted")
		return r.match(Wanted, { key, due }).find({ key, due })
	}),
	stamps: query(Box).rule((r) => {
		const { key, at } = v(Stamp, "stamp")
		return r.match(Stamp, { key, at }).find({ key, at })
	})
} as const

type ChangeName = keyof typeof changes

type ReadName = keyof typeof reads

/** The programs a clock may bind: each that reads `now`. */
const clockable: ReadonlySet<string> = new Set<string>([...Rec.keys(changes), "dueNow"])

interface Case {
	readonly changes: Arr.NonEmptyReadonlyArray<ChangeName>
	readonly reads: ReadonlyArray<ReadName>
	readonly unit: "micros" | "millis"
}

const changeNames: Arr.NonEmptyReadonlyArray<ChangeName> = [
	"claim",
	"reclaim",
	"stamp",
	"fromStamp",
	"due"
]

const readNames: ReadonlyArray<ReadName> = ["dueNow", "wanted", "stamps"]

export const caseGen: Gen<Case> = (source) => {
	const first = source.draw(element(changeNames))
	const rest = Arr.filter(source.draw(subarray(changeNames)), (c) => c !== first)
	return {
		changes: [first, ...rest],
		reads: source.draw(subarray(readNames)),
		unit: source.draw(element(["micros", "millis"] as const))
	}
}

export type Feature =
	| "a role certified READ COMMITTED"
	| "a role certified SERIALIZABLE for its own statements"
	| "the reclaim, clocked"
	| "a key bound to the reading"
	| "a range read of what is due"
	| "a whole key read by the reading"
	| "a clocked read of a relation no live read reads"
	| "a clocked read beside a live read of its relation"

/** A certificate as the comparison reads it: its level, and each reason's condition, member and relation, in order. */
/** A reason's place as the line spells it: its member and its relation, `-` for each it names none of. */
const placeOf = (at: ReasonAt): string => {
	switch (at.kind) {
		case "role":
			return "-:-"
		case "relation":
			return `-:${at.relation}`
		case "member":
		case "statement":
			return `${at.member}:${at.relation}`
	}
}

const certified = (certificate: RoleCertificate): string =>
	certificate.level === "readCommitted"
		? "readCommitted"
		: `serializable ${Arr.join(
				Arr.map(reasonsOf(certificate.why), (r) => `${r.condition}:${placeOf(r.at)}`),
				" "
			)}`

const file = `${repoRoot}app/grizzle.config.ts`

/** The programs of a case, each clocked where `clocked` holds and it reads `now`. */
const programsOf = (c: Case, clocked: boolean): Readonly<Record<string, unknown>> => {
	const chosen: ReadonlyArray<readonly [string, unknown]> = [
		...Arr.map(c.changes, (name) => [name, changes[name]] as const),
		...Arr.map(c.reads, (name) => [name, reads[name]] as const)
	]
	return Rec.fromEntries(
		Arr.map(
			chosen,
			([name, program]) =>
				[
					name,
					clocked && clockable.has(name) ? clockedMember(program, { now: c.unit }) : program
				] as const
		)
	)
}

/** One compile of a case's programs: each role's certificate, its served file, and the snapshot's live tables. */
export const compiled = (c: Case, clocked: boolean) =>
	Effect.gen(function* () {
		const worker = role(Box, "worker", wholeEntriesOf(Box), {
			insert: ["Step", "Claim", "Stamp", "Wanted"]
		})
		const app = login(Box, "app", [worker], { workload: [workload(Box, programsOf(c, clocked))] })
		const config = yield* resolveConfig(
			defineConfig({
				contracts: [],
				schemas: [Box],
				logins: [app],
				migrations: "migrations",
				rolePrefixBytes: 0,
				connection: () => offlineOwner
			}),
			file
		)
		const configured = defined(config.schemas[0], "the configured schema")
		const schemaCompiled = yield* Effect.fromResult(compileSchema(configured))
		const draft = yield* draftSchema(
			schemaCompiled,
			emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
			[],
			noDeclarations,
			silentPhases
		)
		const served = draft.served
		assert.ok(served.kind === "logins", "a schema with a login plans its logins")
		const entries = yield* eachServedFile(
			schemaCompiled,
			draft,
			served,
			silentPhases,
			Effect.succeed
		)
		const entry = defined(
			Option.getOrUndefined(Arr.findFirst(entries, (e) => e.login === "app")),
			"the served file of login app"
		)
		return {
			certificates: Rec.fromEntries(
				Arr.map(served.certification, (i) => [i.role, certified(i.certificate)] as const)
			),
			text: entry.text,
			file: succeeded(servedFile(jsonOf(entry.text)), "the served file"),
			live: new Set(
				draft.snapshot.live.kind === "reads"
					? Arr.map(draft.snapshot.live.tables, (t) => t.relation)
					: []
			)
		}
	})

/** The members of the served file's one role, by name. */
export const membersOf = (served: ServedFile) =>
	new Map(
		Arr.map(defined(served.roles[0], "the served role worker").members, (m) => [m.name, m] as const)
	)
