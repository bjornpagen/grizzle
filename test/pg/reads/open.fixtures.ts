/** What the properties of open.test.ts read: its spaces, models and helpers. */

import type { Reached } from "@bjornpagen/testing/features"
import {
	bytes as bytesGen,
	constant,
	type Gen,
	int,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, String as Str } from "effect"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import type { CallError } from "#compiler/live/index.ts"
import { bytes, date, pg, uuid, Vector } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { type AnyLogin, relation, schema } from "#compiler/public/schema.ts"
import { printRoleSetting } from "#compiler/sql/print.ts"
import {
	type RoleDefaultParameter,
	roleDefaults,
	type RoleDefaultSetting
} from "#test/pg/adapter/support.ts"
import { assert } from "#test/support/assert.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t1 } from "#test/support/fixtures/golden/work.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import type { ServedFixture } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { testVerify } from "#test/support/worlds.ts"

export const builtinCUtf8 =
	"ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C.UTF-8'"

/**
 * A query whose relation parameter carries a vector, over Work, which stores none: its arrays name
 * vector_ext.vector(3), so the template requires the vector extension in the vector schema, which Work's snapshot never
 * installs.
 */
export const vectorProbe = query(W.Work).rule((r) => {
	const wanted = r.relation("qs", { id: uuid, e: pg.vector(3) })
	const { id, kind } = v(W.Task, "task")
	return r.match(wanted, { id }).match(W.Task, { id, kind }).find({ id, kind })
})

/**
 * The same probe over Search, whose role reads its embeddings' vectors and so holds USAGE on the vector schema: a
 * database with pgvector answers it.
 */
export const searchProbe = query(search.Search).rule((r) => {
	const wanted = r.relation("qs", { id: uuid, e: pg.vector(3) })
	const { id, title } = v(search.Document, "document")
	return r.match(wanted, { id }).match(search.Document, { id, title }).find({ id, title })
})

/**
 * A schema whose every read depends on the session's output styles: a date, which DateStyle spells; a float8, which
 * extra_float_digits rounds; and bytes, which bytea_output spells. Its key is the stamp's id.
 */
export const Stamp = relation(
	"Stamp",
	{ id: uuid, day: date, ratio: pg["double precision"], blob: bytes },
	["id"]
)

export const Stamps = schema("Stamps", [Stamp], [])

/** The one stamp a case stores. */
export const stampId = "00000000-0000-4000-8000-0000000000aa"

/** A stamp's values: a day as its ISO 8601 text, a ratio and its bytes. */
interface StampRow {
	readonly day: `${string}-${string}-${string}`
	readonly ratio: number
	readonly blob: Uint8Array
}

/** Two digits of a month or a day, four of a year. */
const padded = (n: number, width: number): string => Str.padStart(width, "0")(String(n))

/**
 * A stamp drawn whole: any day of the years 1 to 9999 (the 28 days every month has), a ratio of two whole numbers, most
 * of which need more than 15 significant digits, and up to eight bytes of any value.
 */
const stampGen: Gen<StampRow> = (source) => ({
	day: `${padded(source.draw(int(1, 9999)), 4)}-${padded(source.draw(int(1, 12)), 2)}-${padded(source.draw(int(1, 28)), 2)}`,
	ratio: source.draw(int(-999, 999)) / source.draw(int(1, 999)),
	blob: source.draw(bytesGen({ min: 0, max: 8 }))
})

/** The bytes' text as a bytea input reads it: hex. */
export const byteaText = (blob: Uint8Array): string =>
	`\\x${Arr.join(
		Arr.map(Array.from(blob), (b) => Str.padStart(2, "0")(b.toString(16))),
		""
	)}`

/** The role defaults a stamp's read depends on. */
export const stampDefaults = [
	"DateStyle",
	"extra_float_digits",
	"bytea_output"
] as const satisfies ReadonlyArray<RoleDefaultParameter>

/**
 * A value other than the installation's for each role default it stores, as ALTER ROLE ... SET spells it: PostgreSQL's
 * own search path, no extra float digits, PostgreSQL's own date style, bytea's escape format, the C locale.
 */
const wrongRoleDefault: { readonly [P in RoleDefaultParameter]: string } = {
	search_path: `${quoteIdent("$user")}, ${quoteIdent("public")}`,
	extra_float_digits: quoteString("0"),
	DateStyle: quoteString("Postgres, MDY"),
	bytea_output: quoteString("escape"),
	lc_monetary: quoteString("C"),
	lc_numeric: quoteString("C"),
	lc_time: quoteString("C")
}

/**
 * The database a Db is opened against: the one Work and Search were installed in, with pgvector; a libc database
 * holding neither; or a builtin C.UTF-8 database without pgvector, where Work is installed too.
 */
type OpenDatabase = "installed" | "libc" | "builtin without pgvector"

/** What a role default of the opened login is when the open runs: as installed, removed, or set to a wrong value. */
type DefaultChange = "kept" | "reset" | "wrong"

/** What an open reads: Work, Search (whose Document embeddings need pgvector), or Stamps with the stamp it stores. */
type OpenTarget =
	| Readonly<{ schema: "Work" }>
	| Readonly<{ schema: "Search" }>
	| Readonly<{ schema: "Stamps"; stamp: StampRow }>

/**
 * One open: what it reads, the database, and each of the login's role defaults in the installation's own order
 * (roleDefaults).
 */
interface OpenCase {
	readonly target: OpenTarget
	readonly database: OpenDatabase
	readonly defaults: ReadonlyArray<{
		readonly setting: RoleDefaultSetting
		readonly change: DefaultChange
	}>
}

/** Any open: any schema, any database, the one it was installed in most often, and each role default changed or not. */
export const anyOpenGen: Gen<OpenCase> = (source) => ({
	target: source.draw(
		oneOf<OpenTarget>([
			constant({ schema: "Work" }),
			constant({ schema: "Search" }),
			(stamps) => ({ schema: "Stamps", stamp: stamps.draw(stampGen) })
		])
	),
	database: source.draw(
		weighted<OpenDatabase>([
			[2, constant("installed")],
			[1, constant("libc")],
			[1, constant("builtin without pgvector")]
		])
	),
	defaults: Arr.map(roleDefaults, (setting) => ({
		setting,
		change: source.draw(
			weighted<DefaultChange>([
				[2, constant("kept")],
				[1, constant("reset")],
				[1, constant("wrong")]
			])
		)
	}))
})

export type OpenFeature =
	| `role default ${Exclude<DefaultChange, "kept">} ${RoleDefaultParameter}`
	| "Work read"
	| "Search read"
	| "Stamps read"
	| "a read refused at the fence, the database without the schema's ledger"
	| "a vector probe answered"
	| "a vector probe refused by PostgreSQL"

export const openFeatures: Arr.NonEmptyReadonlyArray<Reached<OpenFeature>> = [
	...Arr.flatMap(["reset", "wrong"] as const, (change) =>
		Arr.map(roleDefaults, (setting): OpenFeature => `role default ${change} ${setting.parameter}`)
	),
	...Arr.map(stampDefaults, (parameter): Reached<OpenFeature> => [
		`role default wrong ${parameter}`,
		"Stamps read"
	]),
	"Work read",
	"Stamps read",
	"Search read",
	"a read refused at the fence, the database without the schema's ledger",
	"a vector probe answered",
	"a vector probe refused by PostgreSQL"
]

/** Whether a case's database holds its schema's installation. */
export const holdsSchema = (c: OpenCase): boolean =>
	c.database === "installed" ||
	(c.database === "builtin without pgvector" && c.target.schema === "Work")

/**
 * Changes the login role's default `setting` as `change` says, for the case's scope: removed, or stored with a wrong
 * value, and stored again as the installation stores it when the case ends.
 */
export const changedDefault = (
	loginRole: string,
	setting: RoleDefaultSetting,
	change: DefaultChange
) =>
	Effect.gen(function* () {
		if (change === "kept") {
			return
		}
		const s = yield* Substrate
		const role = quoteIdent(loginRole)
		const parameter = quoteIdent(setting.parameter)
		yield* Effect.acquireRelease(
			s.admin.query(
				change === "reset"
					? `ALTER ROLE ${role} RESET ${parameter}`
					: `ALTER ROLE ${role} SET ${parameter} = ${wrongRoleDefault[setting.parameter]}`,
				[]
			),
			() => Effect.orDie(s.admin.query(`ALTER ROLE ${role} SET ${printRoleSetting(setting)}`, []))
		)
	})

/** The DbLayer of a fixture's served login in `database`, as an application builds it. */
export const layerIn = <L extends AnyLogin>(
	database: string,
	o: {
		readonly installed: Installed
		readonly server: L
		readonly served: ServedFixture<L>
	}
) =>
	sourcedDbLayer(o.installed, {
		...clusterConnection(o.installed.cluster, database, o.installed.as(o.server).password),
		pool: clusterPool,
		login: o.served.login,
		verify: testVerify
	})

/** The probe's vector field's carrier: three dimensions. */
const e = Vector.make(Float32Array.of(1, 0, 0), 3)

/** A read the fence refused: the database holds no schema of the installation, so no ledger. */
export const noLedger = (error: CallError): void =>
	assert.equal(error.kind, "failed", "the server refused the read: no schema of the ledger")

/** The probe parameters its search set before its cases, every case reading them. */
export const qs = Object.freeze([Object.freeze({ id: t1, e })])
