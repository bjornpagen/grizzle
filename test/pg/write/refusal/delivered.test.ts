import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { compiledWrite } from "#adapter/apply/compile.ts"
import { runApplication } from "#adapter/apply/index.ts"
import { dbContext } from "#adapter/db/context.ts"
import { Db } from "#adapter/public/db.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	on,
	relation,
	type Schema,
	schema,
	type StatementsByName
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, bareRecord, defined, failureOf, succeeded } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A read-back attachment whose delivered type breaks raises inside its own statement, so its write commits nothing.
 *
 * An attachment delivers what immediate-constraint evidence proves: the bare child where a containment proves exactly
 * one child per parent, an option where the correlation covers a key of the child. A containment proves a child before
 * COMMIT only as an immediate foreign key, which grizzle makes of one whose target holds no field outside the referenced
 * columns: a target with a payload can be replaced at the key in passing, so its foreign key is deferred, and a read-back
 * counts its children as an option's. A write's statements, its read-backs
 * and its COMMIT go in one flight, so a breach the host found while decoding would surface only after the write had
 * committed. Each read-back statement that delivers a bare child or an option checks the count of children per parent
 * itself and raises through the installation's refusal function: PostgreSQL aborts the transaction, and the apply fails
 * with an ExecutionFailure carrying the server's report, SQLSTATE 21Z01 with the delivered type it broke as its
 * constraint. The database's answer contradicts a proof, which fails closed as a typed failure, and nothing commits.
 *
 * The breaches are made by hand, as a compiler defect would make them: the constraints behind the evidence are dropped
 * after the Db opened, and rows they forbade are inserted directly. The marker is a bare child, met with no child: Tag
 * holds its key alone, so two rows at one key are one fact, and a bare child never has too many. The holder (a deferred
 * reference into Account), the badge and the profile are options, met with too many, and the holder with none, which
 * before COMMIT is no breach. Each is met fused
 * into its parent's statement (marker, badge) and pipelined as a statement of its own (holder, profile) by the optimized
 * artifact db.apply runs, and pipelined by the conservative realization, which pipelines every attachment. Lawful rows go
 * through both artifacts first, delivered in their proved types. */
const text = str.regex(".*")

/** Five fields beyond the key pipeline the holder and the profile; one fuses the marker and the badge. */
const Account = relation(
	"Account",
	{ id: pg.integer, name: text, city: text, street: text, zip: text, country: text },
	["id"]
)
const Tag = relation("Tag", { id: pg.integer }, ["id"])
const Badge = relation("Badge", { account: pg.integer, label: text }, ["account"])
const Profile = relation(
	"Profile",
	{ account: pg.integer, a: text, b: text, c: text, d: text, e: text },
	["account"]
)
const Note = relation("Note", { id: pg.integer, account: pg.integer, tag: pg.integer }, ["id"])
const Notes = schema("Notes", { Account, Tag, Badge, Profile, Note }, [
	contained(on(Note, "account"), on(Account, "id")),
	contained(on(Note, "tag"), on(Tag, "id"))
])

type NotesInstalled = Schema<
	string,
	(typeof Notes)["relations"],
	StatementsByName<(typeof Notes)["statements"], (typeof Notes)["relations"]>
>

interface NoteFact {
	readonly id: number
	readonly account: number
	readonly tag: number
}

const account = (id: number) => ({
	id,
	name: `n${id}`,
	city: "c",
	street: "s",
	zip: "z",
	country: "k"
})
const profile = (account: number, a: string) => ({ account, a, b: "b", c: "c", d: "d", e: "e" })

/** Every note with its account as its holder and its tag as its marker, each exactly one by containment, and its badge
 * and profile, each an option. */
const notes = (s: NotesInstalled) =>
	query(s)
		.rule((r) => {
			const { id, account, tag } = v(Note, "note")
			return r.match(Note, { id, account, tag }).find({ id, account, tag })
		})
		.attach(
			"holder",
			(n) =>
				query(s).rule((r) => {
					const { name, city, street, zip, country } = v(Account, "account")
					return r
						.match(Account, { id: n.account, name, city, street, zip, country })
						.find({ name, city, street, zip, country })
				}),
			"one"
		)
		.attach(
			"marker",
			(n) => query(s).rule((r) => r.match(Tag, { id: n.tag }).find({ marked: true })),
			"one"
		)
		.attach(
			"badge",
			(n) =>
				query(s).rule((r) => {
					const { label } = v(Badge, "badge")
					return r.match(Badge, { account: n.account, label }).find({ label })
				}),
			"option"
		)
		.attach(
			"profile",
			(n) =>
				query(s).rule((r) => {
					const { a, b, c, d, e } = v(Profile, "profile")
					return r.match(Profile, { account: n.account, a, b, c, d, e }).find({ a, b, c, d, e })
				}),
			"option"
		)

const write = (s: NotesInstalled, note: NoteFact) =>
	ChangeSet.empty(s)
		.insert(Note, [note])
		.read("notes", () => notes(s))

type Artifact = "optimized" | "conservative"

/** A note one artifact writes. */
interface ArtifactNote {
	readonly artifact: Artifact
	readonly id: number
}

/** A note whose read-back meets a breach: the attachment it breaks and how, and the delivered type it breaks. */
interface Breach {
	readonly label: string
	readonly note: NoteFact
	readonly delivered: "one" | "option"
}

const breaches: Arr.NonEmptyReadonlyArray<Breach> = [
	{
		label: "a pipelined option, the holder, with two children",
		note: { id: 11, account: 4, tag: 1 },
		delivered: "option"
	},
	{
		label: "a bare child, the marker, with no child",
		note: { id: 12, account: 1, tag: 404 },
		delivered: "one"
	},
	{
		label: "a fused option, the badge, with two children",
		note: { id: 14, account: 2, tag: 1 },
		delivered: "option"
	},
	{
		label: "a pipelined option, the profile, with two children",
		note: { id: 15, account: 3, tag: 1 },
		delivered: "option"
	}
]

/** Every breach, met by each artifact. */
const breachCases: Gen<{ readonly artifact: Artifact; readonly breach: Breach }> = (source) => ({
	artifact: source.draw(element<Artifact>(["optimized", "conservative"])),
	breach: source.draw(element(breaches))
})

/** An exhaustive check's budget beside its suite and generator. */
const exhaustive = {
	literal: Formatter.format,
	coverage: noCoverage,
	caseHang
} as const

layer(Substrate.layer, { excludeTestServices: true })(
	"a read-back attachment's delivered type, checked inside its statement",
	(it) => {
		it.effect(
			"a breach of any delivered type in any form aborts the write, in both artifacts",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const sub = yield* Substrate
						const o = yield* installed(
							Notes,
							{
								Account: [account(1), account(2), account(3)],
								Tag: [{ id: 1 }],
								Badge: [{ account: 1, label: "b1" }],
								Profile: [profile(1, "p1")]
							},
							{ label: "real", extensions: [] }
						)
						const s = o.schema
						const names = namesOf(o.installed)
						const sql = (text: string) => sub.admin.queryValues(text, [])
						const stored = (id: number) =>
							Effect.map(
								sql(
									`SELECT count(*)::text FROM ${names.table(Note)} WHERE ${names.column(Note, "id")} = ${id}`
								),
								(rows) => Number(rows[0]?.[0])
							)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.server.roles.app, {})
							const opened = defined(dbContext(db), "the opened Db's context")
							const run = (artifact: Artifact, note: NoteFact) => {
								const changes = write(s, note)
								if (artifact === "optimized") {
									return db.apply(changes, {})
								}
								const entry = succeeded(
									compiledWrite(opened, changes, opened.claims),
									"the ChangeSet compiles"
								)
								return runApplication(opened, entry, {}, artifact, changes.reads)
							}

							yield* exhaust(
								{
									...exhaustive,
									suite: "pg/write/delivered/lawful",
									generator: element<ArtifactNote>([
										{ artifact: "optimized", id: 1 },
										{ artifact: "conservative", id: 2 }
									]),
									limit: 2
								},
								({ artifact, id }) =>
									Effect.gen(function* () {
										const outcome = yield* run(artifact, { id, account: 1, tag: 1 })
										if (outcome.kind !== "accepted") {
											return assert.fail(`${artifact}: the lawful note answered ${outcome.kind}`)
										}
										const mine = Option.getOrThrowWith(
											Arr.findFirst(outcome.reads.notes, (row) => row.id === id),
											() => new Error(`${artifact}: the note read back`)
										)
										assert.deepEqual(
											mine.holder,
											Option.some(
												bareRecord({ name: "n1", city: "c", street: "s", zip: "z", country: "k" })
											),
											`${artifact}: the holder`
										)
										assert.deepEqual(
											mine.marker,
											Option.some(bareRecord({ marked: true })),
											`${artifact}: the marker`
										)
										assert.deepEqual(
											mine.badge,
											Option.some(bareRecord({ label: "b1" })),
											`${artifact}: the badge`
										)
										assert.deepEqual(
											mine.profile,
											Option.some(bareRecord({ a: "p1", b: "b", c: "c", d: "d", e: "e" })),
											`${artifact}: the profile`
										)
									})
							)

							/**
							 * The defect, by hand: the constraints behind the evidence go, and rows they forbade arrive. Note's
							 * foreign keys go in one pass, then the keys they reference in another.
							 */
							const passes = [
								`conrelid = '${names.table(Note)}'::regclass AND contype = 'f'`,
								`conrelid IN ('${names.table(Account)}'::regclass, '${names.table(Badge)}'::regclass, '${names.table(Profile)}'::regclass) AND contype = 'p'`
							]
							for (const constraints of passes) {
								const drops = yield* sql(
									`SELECT format('ALTER TABLE %s DROP CONSTRAINT %I', conrelid::regclass, conname) FROM pg_catalog.pg_constraint WHERE ${constraints}`
								)
								for (const [drop] of drops) {
									yield* sql(String(drop))
								}
							}
							yield* sql(
								`INSERT INTO ${names.table(Account)} VALUES (4, 'a', 'c', 's', 'z', 'k'), (4, 'b', 'c', 's', 'z', 'k')`
							)
							yield* sql(`INSERT INTO ${names.table(Badge)} VALUES (2, 'x'), (2, 'y')`)
							yield* sql(
								`INSERT INTO ${names.table(Profile)} VALUES (3, 'x', 'b', 'c', 'd', 'e'), (3, 'y', 'b', 'c', 'd', 'e')`
							)

							yield* exhaust(
								{
									...exhaustive,
									suite: "pg/write/delivered/no-holder",
									generator: element<ArtifactNote>([
										{ artifact: "optimized", id: 16 },
										{ artifact: "conservative", id: 17 }
									]),
									limit: 2
								},
								({ artifact, id }) =>
									Effect.gen(function* () {
										const outcome = yield* run(artifact, { id, account: 404, tag: 1 })
										if (outcome.kind !== "accepted") {
											return assert.fail(
												`${artifact}: a holder with no child answered ${outcome.kind}`
											)
										}
										const mine = Option.getOrThrowWith(
											Arr.findFirst(outcome.reads.notes, (row) => row.id === id),
											() => new Error(`${artifact}: the note read back`)
										)
										assert.deepEqual(mine.holder, Option.none(), `${artifact}: no holder`)
										const committed = yield* stored(id)
										assert.equal(committed, 1, `${artifact}: the note committed`)
									})
							)
							return yield* exhaust(
								{
									...exhaustive,
									suite: "pg/write/delivered/breaches",
									generator: breachCases,
									limit: 2 * breaches.length
								},
								({ artifact, breach }) =>
									Effect.gen(function* () {
										const label = `${artifact}: ${breach.label}`
										const failure = yield* failureOf(run(artifact, breach.note))
										assert.ok(
											failure._tag === "ExecutionFailure" && failure.reason._tag === "ServerError",
											`${label}: an ExecutionFailure the server raised, got ${String(failure)}`
										)
										const sqlstate: string = failure.reason.sqlstate
										const delivered: string | undefined = failure.reason.constraint
										assert.equal(sqlstate, sqlstates.grizzleDeliveredType, `${label}: a breach`)
										assert.equal(delivered, breach.delivered, `${label}: the type it broke`)
										const committed = yield* stored(breach.note.id)
										assert.equal(committed, 0, `${label}: nothing committed`)
									})
							)
						}).pipe(
							(body) =>
								Effect.flatMap(Layer.build(o.layer), (context) =>
									Effect.provideContext(body, context)
								),
							Effect.scoped
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
