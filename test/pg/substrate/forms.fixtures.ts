import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Effect } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { levelNameAt } from "#test/support/compile.ts"
import { Account, Work, type WorkNamed, workWorlds } from "#test/support/fixtures/api/work.ts"
import { Id } from "#test/support/ids.ts"
import {
	alteredGeneratedTemplate,
	type Generated,
	generatedTemplate,
	type Installed,
	migratedTemplate,
	noPlaceholders
} from "#test/support/install-migrate.ts"
import { rebuild } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import {
	roleSession,
	Substrate,
	type SubstrateShape,
	type SubstrateTemplate,
	worldSession
} from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Work installed through its first migration with its server login (test/support/fixtures/api/work.ts): the template the
 * forms' properties clone, built once per member.
 */
export const workTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "work",
	content: { schema: "Work", logins: ["server"], ambient: "ordinary" },
	versions: [{ schema: Work, logins: [workWorlds(Work).server], declarations: noDeclarations }],
	options: {
		label: "work",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * Work installed once more as a template of its own, its content apart from workTemplate's: the second of the closed
 * set of templates oneOfTemplates draws from.
 */
export const secondWorkTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "work, second",
	content: { schema: "Work", logins: ["server"], ambient: "ordinary", copy: "second" },
	versions: [{ schema: Work, logins: [workWorlds(Work).server], declarations: noDeclarations }],
	options: {
		label: "work",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The keys of the closed set of templates the oneOf property draws a case's from. */
const templateKeys = ["first", "second"] as const

/** A oneOf case: the template it draws among templateKeys, and the rows it writes. */
export const oneOfCase: Gen<readonly [(typeof templateKeys)[number], number]> = (source) => [
	source.draw(element(templateKeys)),
	source.draw(int(1, 4))
]

/** Every account, by id and name, over `installed`: the read the served login's workload holds (servedTemplate). */
const everyAccount = (installed: WorkNamed<string>) =>
	query(installed).rule((r) => {
		const { id, name } = v(Account, "account")
		return r.match(Account, { id, name }).find({ id, name })
	})

/** Work's full world over the schema it is given (test/support/worlds.ts fullWorld), its login reading every account. */
export const servedWorld = (installed: WorkNamed<string>) =>
	fullWorld(installed, { accounts: everyAccount(installed) })

/**
 * Work drafted and served as `grizzle generate` does, with its full world's server login (servedWorld), which Served.of
 * serves over each case's clone.
 */
export const servedTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "work served",
	content: { schema: "Work", logins: ["server of the full world, reading every account"] },
	build: (name) => {
		const named = rebuild(Work, name)
		return { schema: named, logins: [servedWorld(named).server] }
	},
	ambient: ordinarySession
})

/** How many accounts `connection` reads in the installation. */
const accounts = (
	connection: PgConnection,
	installed: Installed
): Effect.Effect<number, SqlError> =>
	Effect.map(
		connection.queryValues(`SELECT count(*)::int4 FROM ${namesOf(installed).table(Account)}`, []),
		(rows) => Number(rows[0]?.[0])
	)

/**
 * `rows` accounts written into the installation on `connection`, which finds none before: the case's clone holds the
 * template's installation and no row an earlier case wrote.
 */
export const writtenAccounts = (
	connection: PgConnection,
	installed: Installed,
	rows: number
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const before = yield* accounts(connection, installed)
		assert.equal(before, 0, "the clone holds no account")
		yield* connection.query(
			`INSERT INTO ${names.table(Account)} (${names.column(Account, "id")}, ${names.column(Account, "name")}) SELECT pg_catalog.gen_random_uuid(), 'account ' || n::text FROM pg_catalog.generate_series(1, $1::int4) AS n`,
			[rows]
		)
		const after = yield* accounts(connection, installed)
		assert.equal(after, rows, "the case's accounts")
	})

/**
 * Every login of the template's installation logs in on the case's clone with the credentials the case derives, the
 * owner login among them, and takes on a world role.
 */
export const loggedIn = (
	substrate: SubstrateShape,
	installed: Installed
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		const worlds = workWorlds(Work)
		const server = yield* substrate.session(roleSession(installed.as(worlds.server)))
		yield* server.query("SELECT 1", [])
		const owner = yield* substrate.session(roleSession(installed.ambientOwner.credentials))
		yield* owner.query("SELECT 1", [])
		const reader = yield* substrate.session(worldSession(installed.world(worlds.reader)))
		const [[role] = []] = yield* reader.values("SELECT current_user::text", [])
		assert.equal(role, installed.role(worlds.reader), "the reader's session acts as its world role")
	}).pipe(Effect.scoped)

/** The observer sessions open in the case's database: the barriers' (substrate.ts build), by the label they connect under. */
export const observersIn = (substrate: SubstrateShape): Effect.Effect<number, SqlError> =>
	Effect.map(
		substrate.admin.queryValues(
			"SELECT count(*)::text FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND application_name = 'grizzle-substrate observer'",
			[]
		),
		(rows) => Number(rows[0]?.[0] ?? "-1")
	)

/** The table a case of observerOnDemand locks, in its own schema. */
export const heldTable = (schema: string): string => `${quoteIdent(schema)}.${quoteIdent("held")}`

/** An item of a size: the stored relation Sized reads. */
const Item = relation("Item", { id: Id, size: pg.integer }, ["id"])
const Items = schema("Items", [Item], [])

/** Every item's size, a materialized derived relation over Items: the view a seat's case refreshes. */
const Sized = derived.materialized(
	"Sized",
	query(Items).rule((r) => {
		const { id, size } = v(Item, "item")
		return r.match(Item, { id, size }).find({ id, size })
	})
)

/** Items under `name` and Sized over it in an extension, its level under the allocation's name for it (levelNameAt). */
const sizedAt = (name: string) =>
	schema.extend([schema(name, [Item], [])], levelNameAt(name, 1), [Sized], [])

/** The templates of seatedViews, by the state each holds Sized in. */
export type ViewTemplate = "populated" | "unpopulated"

/** The forms of a case's own write of Sized: refreshed over its items, emptied WITH NO DATA, or left as found. */
export type ViewAction = "refreshed" | "emptied" | "left"

const viewTemplates = ["populated", "unpopulated"] as const satisfies ReadonlyArray<ViewTemplate>
const viewActions = ["refreshed", "emptied", "left"] as const satisfies ReadonlyArray<ViewAction>

/** A seatedViews case: the template it takes, what it does to Sized, and the items it writes first. */
export const viewCase: Gen<readonly [ViewTemplate, ViewAction, number]> = (source) => [
	source.draw(element(viewTemplates)),
	source.draw(element(viewActions)),
	source.draw(int(0, 2))
]

const sizedSpec = (name: string) => ({
	declaredIn: import.meta,
	name,
	content: { schema: "Items", derived: ["Sized"] },
	build: (allocated: string) => ({ schema: sizedAt(allocated), logins: [] }),
	ambient: ordinarySession
})

/** Sized's view of an installation, schema-qualified and quoted. */
export const sizedView = (generated: Generated): string => namesOf(generated.installed).table(Sized)

/**
 * The templates of Sized, by the state each holds its view in: as `grizzle generate`'s first migration populates it
 * (generatedTemplate), and refreshed WITH NO DATA once installed, as an installation from its compiled script leaves it.
 */
export const viewTemplateOf: Readonly<Record<ViewTemplate, SubstrateTemplate<Generated>>> = {
	populated: generatedTemplate(sizedSpec("sized, populated")),
	unpopulated: alteredGeneratedTemplate({
		...sizedSpec("sized, unpopulated"),
		alter: (generated) =>
			Effect.gen(function* () {
				const substrate = yield* Substrate
				yield* substrate.admin.query(
					`REFRESH MATERIALIZED VIEW ${sizedView(generated)} WITH NO DATA`,
					[]
				)
			})
	})
}

/** Sized's view as a session finds it: unpopulated, or populated with its rows counted. */
export const viewState = (
	connection: PgConnection,
	view: string
): Effect.Effect<
	{ readonly populated: false } | { readonly populated: true; readonly rows: number },
	SqlError
> =>
	Effect.gen(function* () {
		const [[populated] = []] = yield* connection.queryValues(
			`SELECT relispopulated FROM pg_catalog.pg_class WHERE oid = '${view}'::regclass`,
			[]
		)
		if (populated !== true) {
			return { populated: false } as const
		}
		const [[rows] = []] = yield* connection.queryValues(`SELECT count(*)::int4 FROM ${view}`, [])
		return { populated: true, rows: Number(rows) } as const
	})

/** `count` items written into the installation on `connection`. */
export const writtenItems = (
	connection: PgConnection,
	generated: Generated,
	count: number
): Effect.Effect<void, SqlError> => {
	const names = namesOf(generated.installed)
	return Effect.asVoid(
		connection.query(
			`INSERT INTO ${names.table(Item)} (${names.column(Item, "id")}, ${names.column(Item, "size")}) SELECT pg_catalog.gen_random_uuid(), n FROM pg_catalog.generate_series(1, $1::int4) AS n`,
			[count]
		)
	)
}
