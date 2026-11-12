import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import type { RoleCertificate } from "#compiler/analysis/isolation/certify.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { clockedMember, workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
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
import { offlineOwner } from "#test/pg/cli/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * A member that binds a parameter to the database's clock (workload clocked) is its program served with that one input
 * read by the server: generated logins over the clock box, each drawn program served twice, once with the call's `now`
 * and once with the clock's, compiled by the one draft `grizzle generate` and `grizzle check` run (draftSchema, then
 * servedFiles).
 *
 * Properties, each against the plain compile of the same programs:
 *
 * - Certificates: each role's certificate, its level and every reason's condition, member and relation, is the plain
 *   compile's. The certifier reads a reading as the parameter it stands for (program/isolation/extract.ts), so LEASE's
 *   reclaim, a positive whole-key read of an insert-only Claim filtered by `at + ttl < now`, certifies READ COMMITTED
 *   clocked exactly as with the host's `now`, and a range read of what is due stays SERIALIZABLE.
 * - Statements: the clocked file reads the clock by transaction_timestamp() alone, never statement_timestamp() or
 *   clock_timestamp(), and the plain file reads none.
 * - Liveness: a clocked read is served as an instant read, with no footprint, and the snapshot's live plan holds a
 *   relation exactly where a read served live reads it.
 *
 * Plants (~/.cache/grizzle-release/DBCLOCK/plants): extract-clock-opaque.patch reads a reading as an expression no
 * parameter carries, so a key bound to it is bound by no value; clock-statement-timestamp.patch reads
 * statement_timestamp(); instant-footprint.patch serves a clocked read live.
 */

const Instant = contract("Instant", pg.bigint)

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
					r.and(
						r.eq(step, r.param("step", pg.integer)),
						r.eq(attempt, r.param("attempt", pg.integer)),
						r.lt(Compute.add(Compute.base(at), ttl), Compute.base(r.param("now", Instant)))
					)
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
				.where(r.and(r.eq(key, r.param("key", pg.integer)), r.eq(at, r.param("now", Instant))))
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

const caseGen: Gen<Case> = (source) => {
	const first = source.draw(element(changeNames))
	const rest = Arr.filter(source.draw(subarray(changeNames)), (c) => c !== first)
	return {
		changes: [first, ...rest],
		reads: source.draw(subarray(readNames)),
		unit: source.draw(element(["micros", "millis"] as const))
	}
}

type Feature =
	| "a role certified READ COMMITTED"
	| "a role certified SERIALIZABLE for its own statements"
	| "the reclaim, clocked"
	| "a key bound to the reading"
	| "a range read of what is due"
	| "a whole key read by the reading"
	| "a clocked read of a relation no live read reads"
	| "a clocked read beside a live read of its relation"

/** A certificate as the comparison reads it: its level, and each reason's condition, member and relation, in order. */
const certified = (certificate: RoleCertificate): string =>
	certificate.level === "readCommitted"
		? "readCommitted"
		: `serializable ${Arr.join(
				Arr.map(
					certificate.reasons,
					(r) => `${r.condition}:${r.member ?? "-"}:${r.relation ?? "-"}`
				),
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
const compiled = (c: Case, clocked: boolean) =>
	Effect.gen(function* () {
		const worker = role(Box, "worker", wholeEntriesOf(Box), {
			insert: ["Step", "Claim", "Stamp", "Wanted"]
		})
		const app = login(Box, "app", [worker], { workload: [workload(Box, programsOf(c, clocked))] })
		const config = yield* resolveConfig(
			defineConfig({
				schemas: [Box],
				logins: [app],
				migrations: "migrations",
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
			noDeclarations
		)
		const served = draft.served
		assert.ok(served.kind === "logins", "a schema with a login plans its logins")
		const entries = yield* servedFiles(schemaCompiled, draft.snapshotFiles, served)
		const entry = defined(
			Option.getOrUndefined(Arr.findFirst(entries, (e) => e.login === "app")),
			"the served file of login app"
		)
		return {
			certificates: Rec.fromEntries(
				Arr.map(served.certification, (i) => [i.role, certified(i.certificate)] as const)
			),
			text: entry.text,
			file: servedFile(trustedJson<unknown>(entry.text)),
			live: new Set(
				draft.snapshot.live.kind === "reads"
					? Arr.map(draft.snapshot.live.tables, (t) => t.relation)
					: []
			)
		}
	})

/** The members of the served file's one role, by name. */
const membersOf = (served: ServedFile) =>
	new Map(
		Arr.map(defined(served.roles[0], "the served role worker").members, (m) => [m.name, m] as const)
	)

layer(NodeServices.layer, { excludeTestServices: true })(
	"a member bound to the database's clock",
	(it) => {
		it.effect(
			"certifies as its program with the call's now, reads the clock by transaction_timestamp() alone, and a clocked read is served at its call's instant, never live",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "unit/cli/served-clocked",
							draw: drawn(caseGen),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the same programs compiled with the call's now: their certificates, statements and live plan"
							},
							coverage: required<Feature>(
								[
									"a role certified READ COMMITTED",
									"a role certified SERIALIZABLE for its own statements",
									"the reclaim, clocked",
									"a key bound to the reading",
									"a range read of what is due",
									"a whole key read by the reading",
									"a clocked read of a relation no live read reads",
									"a clocked read beside a live read of its relation"
								],
								{ cases: 24, sense: notesOnly }
							),
							kept: [],
							runs: 24,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(c, notes) =>
							Effect.gen(function* () {
								const plain = yield* compiled(c, false)
								const clocked = yield* compiled(c, true)
								if (c.changes.includes("reclaim")) {
									notes.note("the reclaim, clocked")
								}
								if (c.changes.includes("stamp")) {
									notes.note("a key bound to the reading")
								}
								if (c.changes.includes("due")) {
									notes.note("a range read of what is due")
								}
								if (c.changes.includes("fromStamp")) {
									notes.note("a whole key read by the reading")
								}
								for (const [name, certificate] of Rec.toEntries(plain.certificates)) {
									notes.note(
										certificate === "readCommitted"
											? "a role certified READ COMMITTED"
											: "a role certified SERIALIZABLE for its own statements"
									)
									assert.equal(
										clocked.certificates[name],
										certificate,
										`role ${name}: its certificate clocked is its certificate with the call's now`
									)
								}
								assert.ok(
									Str.includes("transaction_timestamp")(clocked.text) &&
										!Str.includes("statement_timestamp")(clocked.text) &&
										!Str.includes("clock_timestamp")(clocked.text),
									"the clocked file reads the clock by transaction_timestamp() alone"
								)
								assert.ok(
									!Str.includes("transaction_timestamp")(plain.text),
									"the plain file reads no clock"
								)
								const members = membersOf(clocked.file)
								for (const name of c.reads) {
									const member = defined(members.get(name), `the served member ${name}`)
									assert.equal(
										member.kind,
										name === "dueNow" ? "instant" : "read",
										`member ${name}: a clocked read is served at its call's instant, any other read live`
									)
								}
								const liveWanted = c.reads.includes("wanted")
								if (c.reads.includes("dueNow")) {
									notes.note(
										liveWanted
											? "a clocked read beside a live read of its relation"
											: "a clocked read of a relation no live read reads"
									)
									assert.ok(plain.live.has("Wanted"), "a plain read of what is due is live")
								}
								assert.equal(
									clocked.live.has("Wanted"),
									liveWanted,
									"the live plan holds Wanted exactly where a live read reads it"
								)
								assert.equal(
									clocked.live.has("Stamp"),
									c.reads.includes("stamps"),
									"the live plan holds Stamp exactly where a live read reads it"
								)
							})
					)
				)
		)
	}
)
