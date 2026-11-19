/** What the properties of delivered.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option } from "effect"
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
import { alteredFixtureTemplate } from "#test/pg/reads/support.ts"
import { bareRecord } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A read-back attachment whose delivered type breaks raises inside its own statement, so its write commits nothing.
 *
 * An attachment delivers what immediate-constraint evidence proves: the bare child where a containment proves exactly
 * one child per parent, an option where the correlation covers a key of the child. A containment proves a child before
 * COMMIT only as an immediate foreign key, which grizzle makes of one whose target holds no field outside the
 * referenced columns: a target with a payload can be replaced at the key in passing, so its foreign key is deferred,
 * and a read-back counts its children as an option's. A write's statements, its read-backs and its COMMIT go in one
 * flight, so a breach the host found while decoding would surface only after the write had committed. Each read-back
 * statement that delivers a bare child or an option checks the count of children per parent itself and raises through
 * the installation's refusal function: PostgreSQL aborts the transaction, and the call fails as `failed`, the server's
 * report SQLSTATE 21Z01 with the delivered type it broke as its constraint. The database's answer contradicts a proof,
 * which fails closed as a typed failure, and nothing commits.
 *
 * The breaches are made as a compiler defect would make them: the constraints behind the evidence are dropped after the
 * Db opened (Note's foreign keys, and the keys of Account, Badge and Profile), so the database may hold rows they
 * forbid. A case draws such a state: for each of three accounts, its rows of Account (none, one, or two under distinct
 * names), of Badge and of Profile; which of two tags Tag holds; the notes already stored, each over a drawn account and
 * tag, either possibly absent; then the note the write inserts over its own, and the artifact that runs it, each a Db of
 * the login's full role calling its served member `write` with the note as its facts: the optimized one the login's
 * served file holds, which fuses the marker and the badge into their parent's statement and pipelines the holder and the
 * profile, or the conservative realization a served file of the login holds in its place, which pipelines every
 * attachment.
 *
 * The oracle is a model of the delivered types over every note the read-back reads: the marker is a bare child, broken
 * by no child (Tag keeps its key, so it never has two); the holder (a deferred reference into Account), the badge and
 * the profile are options, broken by two children, and the holder's none is no breach before COMMIT. A state the model
 * finds no breach in commits the note and reads back every note with exactly its children; any breach fails the write
 * as `failed`, the server's refusal, and commits nothing.
 */
const text = str.regex(".*")

/** Five fields beyond the key pipeline the holder and the profile; one fuses the marker and the badge. */
export const Account = relation(
	"Account",
	{ id: pg.integer, name: text, city: text, street: text, zip: text, country: text },
	["id"]
)

export const Tag = relation("Tag", { id: pg.integer }, ["id"])

export const Badge = relation("Badge", { account: pg.integer, label: text }, ["account"])

export const Profile = relation(
	"Profile",
	{ account: pg.integer, a: text, b: text, c: text, d: text, e: text },
	["account"]
)

export const Note = relation("Note", { id: pg.integer, account: pg.integer, tag: pg.integer }, [
	"id"
])

export const Notes = schema(
	"Notes",
	[Account, Tag, Badge, Profile, Note],
	[contained(on(Note, "account"), on(Account, "id")), contained(on(Note, "tag"), on(Tag, "id"))]
)

type NotesInstalled = Schema<
	string,
	(typeof Notes)["relations"],
	StatementsByName<(typeof Notes)["statements"], (typeof Notes)["relations"]>
>

export interface NoteFact {
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

/** The write: the note each call's facts give, inserted, and every note read back. */
const write = (s: NotesInstalled) =>
	ChangeSet.empty(s)
		.insert(Note, [])
		.read("notes", () => notes(s))

export type Artifact = "optimized" | "conservative"

/** The read-back's attachments, by name. */
type Attachment = "holder" | "marker" | "badge" | "profile"

/** A drawn state of the unconstrained tables, the note the write inserts and the artifact that runs it. */
export interface Drawn {
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

export const drawnGen: Gen<Drawn> = (source) => {
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
export const rowsAt = (
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

export const deliveredOf = (
	d: Drawn,
	note: NoteFact
): { readonly [A in Attachment]: Delivered } => ({
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

export const attachments: Arr.NonEmptyReadonlyArray<Attachment> = [
	"holder",
	"marker",
	"badge",
	"profile"
]

export type DeliveredFeature =
	| `${Attachment} breached`
	| "a stored note's attachment breached"
	| "no holder, committed"
	| `${Artifact}: every delivered type proved, committed`
	| `${Artifact}: a breach aborts the write`

/** What every case installs: Notes, its full world's workload holding the write. */
export const notesInstall = { label: "real", programs: { write: write(Notes) } } as const

/**
 * Notes installed once per member with the defect planted: the constraints behind the evidence go, Note's foreign keys
 * in one pass, then the keys they reference in another (reads/support.ts alteredFixtureTemplate), where the search
 * dropped them once before its cases.
 */
export const notesTemplate = alteredFixtureTemplate(import.meta, Notes, notesInstall, (generated) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const names = namesOf(generated.installed)
		const passes = [
			`conrelid = '${names.table(Note)}'::regclass AND contype = 'f'`,
			`conrelid IN ('${names.table(Account)}'::regclass, '${names.table(Badge)}'::regclass, '${names.table(Profile)}'::regclass) AND contype = 'p'`
		]
		for (const constraints of passes) {
			const drops = yield* s.admin.queryValues(
				`SELECT format('ALTER TABLE %s DROP CONSTRAINT %I', conrelid::regclass, conname) FROM pg_catalog.pg_constraint WHERE ${constraints}`,
				[]
			)
			for (const [drop] of drops) {
				yield* s.admin.queryValues(String(drop), [])
			}
		}
	})
)
