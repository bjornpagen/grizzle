/** What the properties of upgrade.test.ts read: its schemas, spaces and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, type Gen } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	type PlatformError,
	String as Str
} from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { closedId } from "#compiler/public/fields.ts"
import { closed, login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { Id } from "#test/support/ids.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The versions of the box's schema, each a roster's history over the one before: Kind first holds a, b and c; then b is
 * removed, a hole at code 1; then c is renamed d, which keeps code 2; then a and d swap names, d at code 0 and a at code
 * 2. An Item holds a code of Kind, and a name a pattern refines, so the history holds a spelling too.
 */
export type Version = 1 | 2 | 3 | 4

/** Kind's handles at each version, in code order, a hole left out. */
const handlesAt: { readonly [V in Version]: readonly [string, ...Array<string>] } = {
	1: ["a", "b", "c"],
	2: ["a", "c"],
	3: ["a", "d"],
	4: ["d", "a"]
}

/** The declarations `grizzle generate` takes to reach each version from the one before. */
export const declaredAt: { readonly [V in Version]: ReadonlyArray<string> } = {
	1: [],
	2: ["--drop", "Kind#b"],
	3: ["--rename", "Kind#c=Kind#d"],
	4: ["--rename", "Kind#a=Kind#d", "--rename", "Kind#d=Kind#a"]
}

/** The box's schema under `name` at `version`, its login `server` serving its role `reader` an Item by its id. */
export const kinds = (name: string, version: Version) => {
	const Kind = closed.ordered("Kind", handlesAt[version])
	const Item = relation("Item", { id: Id, kind: closedId(Kind), name: str.regex("^[a-z]{1,8}$") }, [
		"id"
	])
	const s = schema(name, [Kind, Item], [])
	const reader = role(s, "reader", wholeEntriesOf(s))
	return {
		schema: s,
		server: login(s, "server", [reader], { workload: [workload(s, { item: Item })] })
	}
}

/**
 * A change of the live installation a format's change of what grizzle installs makes, done by hand: a function the
 * format names otherwise, its trigger then calling it under its old name (`a function renamed`); a constant the format
 * no longer installs (`a stray constant`); a function the format defines otherwise, its volatility (`a function
 * defined otherwise`); and what format 7 and every format before it left in the database beside the installation
 * (`format 7's leftovers`): its default, SERIALIZABLE as every transaction's, which grizzle no longer sets, and a
 * replication slot its leader made, named by its decoder login, which no leader of this grizzle reads or drops.
 */
export type Shift =
	| "a function renamed"
	| "a stray constant"
	| "a function defined otherwise"
	| "format 7's leftovers"

const shifts: readonly [Shift, ...Array<Shift>] = [
	"a function renamed",
	"a stray constant",
	"a function defined otherwise",
	"format 7's leftovers"
]

/**
 * The name of the slot a leader of format 7 or before made for the installation of `schemaName`: its live source's
 * decoder login's, which ends in the source's stem (core/identity.ts identity.liveSource), here the stem alone.
 */
export const formerSlotOf = (schemaName: string): string =>
	identifierOf(identity.liveSource(schemaName))

/** A case: the last version the history reaches, the shifts a format makes, and the rows stored at each version. */
export interface UpgradeCase {
	readonly version: Version
	readonly shifts: ReadonlyArray<Shift>
}

export type UpgradeFeature =
	| Shift
	| "no shift"
	| "a hole"
	| "a renamed handle"
	| "a handle swap"
	| "a rebase of the snapshot alone"
	| "an upgrade folder"

/**
 * The box's cases: the whole history, a hole, a renamed handle and a swap among it, under each subset of the shifts, the
 * empty one included, each shift in or out by its own draw, so a finite enumeration draws each subset once.
 */
export const caseGen: Gen<UpgradeCase> = (source) => ({
	version: 4,
	shifts: Arr.filter(shifts, () => source.draw(boolean))
})

/**
 * The statements of `shift` on the installation of `schemaName` in `database`, read off its catalog, as the cluster's
 * superuser.
 */
export const shiftStatements = (shift: Shift, schemaName: string, database: string) =>
	Effect.gen(function* () {
		const admin = (yield* Substrate).admin
		const s = quoteIdent(schemaName)
		switch (shift) {
			case "a function renamed": {
				const rows = yield* admin.queryValues(
					`SELECT p.proname::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname LIKE '\\_\\_immutable\\_%' ORDER BY 1 LIMIT 1`,
					[schemaName]
				)
				const [row] = trusted<ReadonlyArray<ReadonlyArray<string>>>(rows)
				const fn = defined(row?.[0], "the installation's immutability guard of Item")
				return [`ALTER FUNCTION ${s}.${quoteIdent(fn)}() RENAME TO ${quoteIdent(`${fn}_old`)}`]
			}
			case "a stray constant":
				return [
					`CREATE FUNCTION ${s}."__stray_constant"() RETURNS integer LANGUAGE sql IMMUTABLE RETURN 7`
				]
			case "a function defined otherwise":
				return [`ALTER FUNCTION ${s}."__snapshot_guard"(pg_catalog.text) STABLE`]
			case "format 7's leftovers":
				return [
					`ALTER DATABASE ${quoteIdent(database)} SET default_transaction_isolation = 'serializable'`,
					`SELECT pg_catalog.pg_create_logical_replication_slot(${quoteString(formerSlotOf(schemaName))}, 'pgoutput')`
				]
		}
	})

/**
 * The default isolation `database` holds of its own, as pg_db_role_setting lists it for every role, or none: none after
 * a fresh install and after any upgrade, since grizzle sets none and an upgrade resets a former one.
 */
export const databaseIsolation = (database: string) =>
	Effect.gen(function* () {
		const admin = (yield* Substrate).admin
		const rows = yield* admin.queryValues(
			"SELECT s.setting FROM pg_catalog.pg_db_role_setting AS d JOIN pg_catalog.pg_database AS b ON b.oid = d.setdatabase CROSS JOIN LATERAL pg_catalog.unnest(d.setconfig) AS s (setting) WHERE b.datname = $1 AND d.setrole = 0::oid AND s.setting LIKE 'default\\_transaction\\_isolation=%'",
			[database]
		)
		return Arr.map(trusted<ReadonlyArray<ReadonlyArray<string>>>(rows), ([setting]) =>
			String(setting)
		)
	})

/** The replication slots of the cluster named `name`: none after any upgrade of the installation it is a leftover of. */
export const slotsNamed = (name: string) =>
	Effect.gen(function* () {
		const admin = (yield* Substrate).admin
		const rows = yield* admin.queryValues(
			"SELECT slot_name::text FROM pg_catalog.pg_replication_slots WHERE slot_name::text = $1",
			[name]
		)
		return Arr.map(trusted<ReadonlyArray<ReadonlyArray<string>>>(rows), ([slot]) => String(slot))
	})

/** Drops the replication slot `name` where the cluster holds it: a case's own leftover, never left to hold WAL. */
export const slotDropped = (name: string) =>
	Effect.flatMap(Substrate, (s) =>
		Effect.ignore(
			s.admin.query(
				"SELECT pg_catalog.pg_drop_replication_slot(slot_name) FROM pg_catalog.pg_replication_slots WHERE slot_name::text = $1",
				[name]
			)
		)
	)

/** A snapshot.json's text recording `format`, its one `format` member replaced: the file of another format. */
export const otherFormat = (text: string, format: number): string =>
	Str.replace(formatMember, `"format": ${format}`)(text)

/** snapshot.json's `format` member as generate writes it, its number among it. */
const formatMember = regex('"format": [0-9]+')

/**
 * The items stored at `version`: one of each live handle a later version keeps, by its code, named after it; none of
 * b, whose removal validates Kind's domain over every stored code.
 */
const itemsAt = (version: Version): ReadonlyArray<readonly [string, number, string]> =>
	Arr.flatMap(handlesAt[version], (handle, at) =>
		handle === "b"
			? []
			: [
					[
						`00000000-0000-0000-0000-${Str.padStart(4, "0")(String(version))}${Str.padStart(8, "0")(String(at))}`,
						codeAt(version, handle),
						handle
					] as const
				]
	)

/** The statements that store `version`'s items, in one SERIALIZABLE transaction, as grizzle's guard requires. */
export const storeItems = (schemaName: string, version: Version): ReadonlyArray<string> => [
	"BEGIN ISOLATION LEVEL SERIALIZABLE",
	...Arr.map(
		itemsAt(version),
		([id, code, name]) =>
			`INSERT INTO ${quoteIdent(schemaName)}."item" (id, kind, name) VALUES ('${id}', ${code}, '${name}')`
	),
	"COMMIT"
]

/** A live handle's code at `version`: its history's, a hole at 1 once b is removed. */
const codeAt = (version: Version, handle: string): number => {
	const codes: { readonly [V in Version]: Readonly<Record<string, number>> } = {
		1: { a: 0, b: 1, c: 2 },
		2: { a: 0, c: 2 },
		3: { a: 0, d: 2 },
		4: { d: 0, a: 2 }
	}
	return defined(codes[version][handle], `${handle}'s code at version ${version}`)
}

/** The features a case reaches by its history alone. */
export const historyFeatures = (version: Version): ReadonlyArray<UpgradeFeature> => [
	...(version >= 2 ? (["a hole"] as const) : []),
	...(version >= 3 ? (["a renamed handle"] as const) : []),
	...(version >= 4 ? (["a handle swap"] as const) : [])
]

/** Every file under `dir`, by its path below it, with its text. */
export const filesUnder = (
	dir: string
): Effect.Effect<ReadonlyMap<string, string>, never, FileSystem.FileSystem> =>
	Effect.orDie(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const out = new Map<string, string>()
			const walk = (
				at: string
			): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
				Effect.gen(function* () {
					const entries = yield* fs.readDirectory(`${dir}${at}`)
					for (const entry of entries) {
						const path = `${at}/${entry}`
						const info = yield* fs.stat(`${dir}${path}`)
						if (info.type === "Directory") {
							yield* walk(path)
						} else {
							const text = yield* fs.readFileString(`${dir}${path}`)
							out.set(path, text)
						}
					}
				})
			yield* walk("")
			return out
		})
	)

/** The rows of the installation's Item, as text, by id. */
export const itemRows = (schemaName: string) =>
	Effect.gen(function* () {
		const admin = (yield* Substrate).admin
		const rows = yield* admin.queryValues(
			`SELECT id::text, kind::text, name::text FROM ${quoteIdent(schemaName)}."item" ORDER BY id`,
			[]
		)
		return trusted<ReadonlyArray<ReadonlyArray<string>>>(rows)
	})

/** Whether the folders of a migrations directory's file paths hold one named after an upgrade. */
export const upgradeFolders = (files: ReadonlyMap<string, string>): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.flatMap([...files.keys()], (path) =>
			Option.toArray(
				Option.flatMap(
					Arr.findFirst(Str.split("/")(path), (part) => Str.endsWith("_upgrade")(part)),
					Option.some
				)
			)
		)
	)

/** The snapshot files and served files of a migrations directory, by path: what a rebase writes again. */
export const committedFiles = (files: ReadonlyMap<string, string>): ReadonlyMap<string, string> =>
	new Map(
		Arr.filter([...files], ([path]) => !Arr.some(Str.split("/")(path), Str.endsWith("_upgrade")))
	)

/** An assertion that two maps of files are equal, naming the first path where they part. */
export const sameFiles = (
	actual: ReadonlyMap<string, string>,
	expected: ReadonlyMap<string, string>,
	what: string
): void => {
	assert.deepEqual(
		Arr.sort([...actual.keys()], Order.String),
		Arr.sort([...expected.keys()], Order.String),
		`${what}: the same files`
	)
	for (const [path, text] of expected) {
		assert.equal(actual.get(path), text, `${what}: ${path}`)
	}
}
