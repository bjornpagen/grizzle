import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Result } from "effect"
import { compiledWrite } from "#adapter/apply/compile.ts"
import { runApplication } from "#adapter/apply/index.ts"
import { openDbContext } from "#adapter/db/open.ts"
import { toResult } from "#adapter/engine.ts"
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
import { assert, bareRecord, failureOf, succeeded } from "#test/support/assert.ts"
import { conservativeChange } from "#test/support/conservative.ts"
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
 * The breaches are made as a compiler defect would make them: the constraints behind the evidence are dropped after the
 * Db opened (Note's foreign keys, and the keys of Account, Badge and Profile), so the database may hold rows they forbid.
 * A case draws such a state: for each of three accounts, its rows of Account (none, one, or two under distinct names),
 * of Badge and of Profile; which of two tags Tag holds; the notes already stored, each over a drawn account and tag,
 * either possibly absent; then the note the write inserts over its own, and the artifact that runs it: the optimized one
 * db.apply runs, which fuses the marker and the badge into their parent's statement and pipelines the holder and the
 * profile, or the conservative realization, which pipelines every attachment.
 *
 * The oracle is a model of the delivered types over every note the read-back reads: the marker is a bare child, broken
 * by no child (Tag keeps its key, so it never has two); the holder (a deferred reference into Account), the badge and the
 * profile are options, broken by two children, and the holder's none is no breach before COMMIT. A state the model finds
 * no breach in commits the note and reads back every note with exactly its children; any breach aborts the write with
 * an ExecutionFailure the server raised, 21Z01 naming a delivered type some breach broke, and commits nothing. */
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

/** The read-back's attachments, by name. */
type Attachment = "holder" | "marker" | "badge" | "profile"

/** A drawn state of the unconstrained tables, the note the write inserts and the artifact that runs it. */
interface Drawn {
	/** Each account's rows of Account, Badge and Profile, by the account's id less one: distinct names of each. */
	readonly accounts: ReadonlyArray<
		Readonly<{
			names: ReadonlyArray<string>
			badges: ReadonlyArray<string>
			profiles: ReadonlyArray<string>
		}>
	>
	readonly tags: ReadonlyArray<number>
	readonly stored: ReadonlyArray<NoteFact>
	readonly note: NoteFact
	readonly artifact: Artifact
}

/** The accounts a state holds rows of, and one past them, which no row holds. */
const accountsDrawn = 3
/** The tags a state may hold, and one past them, which Tag never holds. */
const tagsDrawn = 2
/** The note the write inserts: an id no stored note takes. */
const writtenId = 100

/** Distinct names of one table's rows at one key: none, one or two. */
const namesGen: Gen<ReadonlyArray<string>> = subarray(["x", "y"] as const)

const noteOver =
	(id: number): Gen<NoteFact> =>
	(source) => ({
		id,
		account: source.draw(int(1, accountsDrawn + 1)),
		tag: source.draw(int(1, tagsDrawn + 1))
	})

const drawnGen: Gen<Drawn> = (source) => {
	const accounts = Arr.map(Arr.range(1, accountsDrawn), () => ({
		names: source.draw(namesGen),
		badges: source.draw(namesGen),
		profiles: source.draw(namesGen)
	}))
	const stored = source.draw(array(noteOver(0), { min: 0, max: 2 }))
	return {
		accounts,
		tags: source.draw(subarray(Arr.range(1, tagsDrawn))),
		stored: Arr.map(stored, (n, i) => ({ ...n, id: i + 1 })),
		note: source.draw(noteOver(writtenId)),
		artifact: source.draw(element(["optimized", "conservative"] as const))
	}
}

/** The rows a state holds at an account, of one of its tables. */
const rowsAt = (
	d: Drawn,
	account: number,
	of: (rows: Drawn["accounts"][number]) => ReadonlyArray<string>
): ReadonlyArray<string> =>
	Option.match(Arr.get(d.accounts, account - 1), { onNone: () => [], onSome: of })

/** A note's attachment as the model delivers it, or the delivered type its children break. */
type Delivered =
	| Readonly<{ kind: "delivered"; value: Option.Option<Readonly<Record<string, unknown>>> }>
	| Readonly<{ kind: "breached"; type: "one" | "option" }>

/** An option over a key's children: none, the one, or a breach of the option by two. */
const optionOver = (
	children: ReadonlyArray<string>,
	fact: (name: string) => Readonly<Record<string, unknown>>
): Delivered => {
	const [first, ...rest] = children
	return first === undefined
		? { kind: "delivered", value: Option.none() }
		: Arr.isReadonlyArrayNonEmpty(rest)
			? { kind: "breached", type: "option" }
			: { kind: "delivered", value: Option.some(bareRecord(fact(first))) }
}

const deliveredOf = (d: Drawn, note: NoteFact): { readonly [A in Attachment]: Delivered } => ({
	holder: optionOver(
		rowsAt(d, note.account, (a) => a.names),
		(name) => ({
			name,
			city: "c",
			street: "s",
			zip: "z",
			country: "k"
		})
	),
	marker: d.tags.includes(note.tag)
		? { kind: "delivered", value: Option.some(bareRecord({ marked: true })) }
		: { kind: "breached", type: "one" },
	badge: optionOver(
		rowsAt(d, note.account, (a) => a.badges),
		(label) => ({ label })
	),
	profile: optionOver(
		rowsAt(d, note.account, (a) => a.profiles),
		(a) => ({
			a,
			b: "b",
			c: "c",
			d: "d",
			e: "e"
		})
	)
})

const attachments: Arr.NonEmptyReadonlyArray<Attachment> = ["holder", "marker", "badge", "profile"]

type DeliveredFeature =
	| `${Attachment} breached`
	| "a stored note's attachment breached"
	| "no holder, committed"
	| `${Artifact}: every delivered type proved, committed`
	| `${Artifact}: a breach aborts the write`

layer(Substrate.layer, { excludeTestServices: true })(
	"a read-back attachment's delivered type, checked inside its statement",
	(it) => {
		it.effect(
			"a breach of any delivered type in any form aborts the write, in both artifacts, and every other state commits and delivers its proved types",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const sub = yield* Substrate
						const o = yield* installed(Notes, {}, { label: "real", extensions: [] })
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
						/**
						 * The defect: the constraints behind the evidence go. Note's foreign keys go in one pass, then the keys
						 * they reference in another.
						 */
						const passes = [
							`conrelid = '${names.table(Note)}'::regclass AND contype = 'f'`,
							`conrelid IN ('${names.table(Account)}'::regclass, '${names.table(Badge)}'::regclass, '${names.table(Profile)}'::regclass) AND contype = 'p'`
						]
						/** Writes a drawn state whole, every table emptied first. */
						const stateOf = (d: Drawn) => {
							const values = (rows: ReadonlyArray<string>): string => Arr.join(rows, ", ")
							const accountRows = Arr.flatMap(d.accounts, (a, i) =>
								Arr.map(a.names, (name) => `(${i + 1}, '${name}', 'c', 's', 'z', 'k')`)
							)
							const badgeRows = Arr.flatMap(d.accounts, (a, i) =>
								Arr.map(a.badges, (label) => `(${i + 1}, '${label}')`)
							)
							const profileRows = Arr.flatMap(d.accounts, (a, i) =>
								Arr.map(a.profiles, (x) => `(${i + 1}, '${x}', 'b', 'c', 'd', 'e')`)
							)
							const tagRows = Arr.map(d.tags, (id) => `(${id})`)
							const noteRows = Arr.map(d.stored, (n) => `(${n.id}, ${n.account}, ${n.tag})`)
							const insert = (
								table: string,
								columns: ReadonlyArray<string>,
								rows: ReadonlyArray<string>
							): ReadonlyArray<string> =>
								Arr.isReadonlyArrayNonEmpty(rows)
									? [`INSERT INTO ${table} (${Arr.join(columns, ", ")}) VALUES ${values(rows)}`]
									: []
							return [
								`TRUNCATE ${Arr.join(Arr.map([Note, Account, Tag, Badge, Profile], names.table), ", ")}`,
								...insert(
									names.table(Account),
									Arr.map(["id", "name", "city", "street", "zip", "country"] as const, (f) =>
										names.column(Account, f)
									),
									accountRows
								),
								...insert(names.table(Tag), [names.column(Tag, "id")], tagRows),
								...insert(
									names.table(Badge),
									Arr.map(["account", "label"] as const, (f) => names.column(Badge, f)),
									badgeRows
								),
								...insert(
									names.table(Profile),
									Arr.map(["account", "a", "b", "c", "d", "e"] as const, (f) =>
										names.column(Profile, f)
									),
									profileRows
								),
								...insert(
									names.table(Note),
									Arr.map(["id", "account", "tag"] as const, (f) => names.column(Note, f)),
									noteRows
								)
							]
						}
						return yield* Effect.gen(function* () {
							const { db, ctx: opened } = yield* openDbContext(o.server.roles.app, {})
							const run = (artifact: Artifact, note: NoteFact) => {
								const changes = write(s, note)
								if (artifact === "optimized") {
									return db.apply(changes, {})
								}
								const entry = succeeded(
									Result.flatMap(compiledWrite(opened, changes, opened.claims), (compiled) =>
										toResult(conservativeChange(compiled, opened))
									),
									"the ChangeSet's conservative realization compiles"
								)
								return runApplication(opened, entry, {}, changes.reads)
							}
							for (const constraints of passes) {
								const drops = yield* sql(
									`SELECT format('ALTER TABLE %s DROP CONSTRAINT %I', conrelid::regclass, conname) FROM pg_catalog.pg_constraint WHERE ${constraints}`
								)
								for (const [drop] of drops) {
									yield* sql(String(drop))
								}
							}
							return yield* explore(
								{
									suite: "pg/write/delivered",
									draw: drawn(drawnGen),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "the delivered types' model: a bare child breaks without a child, an option with two, over every note read back"
									},
									coverage: required<DeliveredFeature>(
										[
											"holder breached",
											"marker breached",
											"badge breached",
											"profile breached",
											"a stored note's attachment breached",
											"no holder, committed",
											"optimized: every delivered type proved, committed",
											"conservative: every delivered type proved, committed",
											"optimized: a breach aborts the write",
											"conservative: a breach aborts the write"
										],
										{ cases: 96, sense: notesOnly }
									),
									kept: [],
									runs: 48,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 16,
									caseHang
								},
								(d, c) =>
									Effect.gen(function* () {
										for (const statement of stateOf(d)) {
											yield* sql(statement)
										}
										const every = [...d.stored, d.note]
										const delivered = Arr.map(every, (note) => ({ note, by: deliveredOf(d, note) }))
										const breached = Arr.flatMap(delivered, ({ note, by }) =>
											Arr.flatMap(attachments, (attachment) => {
												const one = by[attachment]
												return one.kind === "breached" ? [{ note, attachment, type: one.type }] : []
											})
										)
										const label = `${d.artifact}: ${Formatter.format(d)}`
										if (Arr.isReadonlyArrayNonEmpty(breached)) {
											const failure = yield* failureOf(run(d.artifact, d.note))
											assert.ok(
												failure._tag === "ExecutionFailure" &&
													failure.reason._tag === "ServerError",
												`${label}: an ExecutionFailure the server raised, got ${String(failure)}`
											)
											const sqlstate: string = failure.reason.sqlstate
											const type: string | undefined = failure.reason.constraint
											assert.equal(sqlstate, sqlstates.grizzleDeliveredType, `${label}: a breach`)
											assert.ok(
												Arr.some(breached, (b) => b.type === type),
												`${label}: ${String(type)} is a delivered type some breach broke`
											)
											const kept = yield* stored(d.note.id)
											assert.equal(kept, 0, `${label}: nothing committed`)
											for (const b of breached) {
												c.note(`${b.attachment} breached`)
												if (b.note.id !== d.note.id) {
													c.note("a stored note's attachment breached")
												}
											}
											c.note(`${d.artifact}: a breach aborts the write`)
											return
										}
										const outcome = yield* run(d.artifact, d.note)
										if (outcome.kind !== "accepted") {
											return assert.fail(
												`${label}: a state with no breach answered ${outcome.kind}`
											)
										}
										for (const { note, by } of delivered) {
											const row = Option.getOrThrowWith(
												Arr.findFirst(outcome.reads.notes, (r) => r.id === note.id),
												() => new Error(`${label}: note ${note.id} read back`)
											)
											for (const attachment of attachments) {
												const expected = by[attachment]
												const got: Option.Option<unknown> = row[attachment]
												const want: Option.Option<unknown> =
													expected.kind === "delivered" ? expected.value : Option.none()
												assert.deepEqual(got, want, `${label}: note ${note.id}'s ${attachment}`)
											}
										}
										assert.equal(outcome.reads.notes.length, every.length, `${label}: every note`)
										const committed = yield* stored(d.note.id)
										assert.equal(committed, 1, `${label}: the note committed`)
										if (rowsAt(d, d.note.account, (a) => a.names).length === 0) {
											c.note("no holder, committed")
										}
										c.note(`${d.artifact}: every delivered type proved, committed`)
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
