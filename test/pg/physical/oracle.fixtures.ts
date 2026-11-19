/** What the properties of oracle.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option, Order, pipe, String as Str } from "effect"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { type FixtureWorlds, worldsExpectation } from "#test/pg/physical/support.ts"
import { expectedCatalog, projectCatalog } from "#test/support/catalog/expected.ts"
import { type Catalog, readCatalog } from "#test/support/catalog/read.ts"
import { verifyErasure } from "#test/support/catalog/verify.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"

export type PhysicalFeature =
	| "text domain"
	| "deferred foreign key"
	| "law index"
	| "contract domain"
	| "span key"
	| "vector column"
	| "text domain judged both ways"

export const situations = [
	"text domain",
	"deferred foreign key",
	"law index",
	"contract domain",
	"span key",
	"vector column",
	"text domain judged both ways"
] as const satisfies ReadonlyArray<PhysicalFeature>

/** Every CHECK of a catalog's tables, `<table>.<constraint>`, to PostgreSQL's deparsed definition of it. */
const checksOf = (catalog: Catalog): ReadonlyMap<string, string> =>
	new Map(
		Arr.flatMap(catalog.tables, (t) =>
			Arr.flatMap(t.constraints, (k) =>
				k.type === "c" ? [[`${t.name}.${k.name}`, k.definition] as const] : []
			)
		)
	)

/** The constraint of a `<table>.<constraint>` key of checksOf. */
export const constraintOf = (key: string): string => {
	const dot = Option.getOrThrowWith(
		pipe(key, Str.indexOf(".")),
		() => new Error(`the check key ${key} holds a dot`)
	)
	return Str.slice(dot + 1)(key)
}

/**
 * One installation's catalog: `sql` run inside a transaction on the pinned session, the catalog of `schema` read in it,
 * `probes` run in it, and the transaction rolled back. CREATE SCHEMA, CREATE ROLE, ALTER ROLE and CREATE EXTENSION are
 * transactional, so the installation leaves nothing behind. Its projection, its tables' CHECKs as PostgreSQL deparses
 * them, and what the probes found.
 */
export const installedCatalog = <A>(
	pinned: PgConnection,
	schema: string,
	sql: ReadonlyArray<string>,
	probes: Effect.Effect<A, SqlError>
) =>
	Effect.ensuring(
		Effect.gen(function* () {
			yield* pinned.query("BEGIN", [])
			for (const statement of sql) {
				yield* pinned.query(statement, [])
			}
			const installed = yield* readCatalog(pinned, [schema])
			if (installed.kind === "absent") {
				return yield* Effect.die(new Error(`the installed schema ${schema} is absent`))
			}
			const probed = yield* probes
			return {
				catalog: installed.catalog,
				projected: projectCatalog(installed.catalog),
				checks: checksOf(installed.catalog),
				probed
			}
		}),
		Effect.orDie(pinned.query("ROLLBACK", []))
	)

/**
 * The real installation's catalog holds what its manifest promises, the worlds included: every column NOT NULL but a
 * law column generated under a guard, NULL outside its selection; text columns and those of a domain with a collation
 * in pg_c_utf8; no identity column, since grizzle mints no ids; domains with no NOT NULL and every constraint validated, every
 * index valid; no enum label, a closed id being a code under its roster's int2 domain, whose one CHECK calls its names
 * constant; no grant to PUBLIC; and the owner's default privileges on functions and types reset for every schema, the
 * global form, which PUBLIC's own defaults yield to (test/pg/sql/print.test.ts), so nothing the owner creates later is
 * PUBLIC's. The erasure verifier finds no UPDATE on an immutable relation and no TRUNCATE
 * (test/pg/physical/verify.test.ts shows it finds each drift).
 */
export const installedAsPromised = (
	desc: SchemaDesc,
	worlds: FixtureWorlds,
	installation: Installation,
	catalog: Catalog
): void => {
	assert.deepEqual(projectCatalog(catalog), expectedCatalog(installation))
	assert.deepEqual(verifyErasure(catalog, worldsExpectation(desc, installation, worlds)), [])
	/** The law columns generated under a guard, each NULL outside its selection (ir/law.ts LawColumnValue), by their
	 * installed table and column: every other column is NOT NULL. */
	const guarded = new Set(
		Arr.flatMap(installation.laws.natives, (n) =>
			n.object.kind === "LawColumn" &&
			n.object.value.kind === "generated" &&
			n.object.value.guard.length > 0
				? [`${installation.names.relation(n.object.relation.name).name}.${n.object.column}`]
				: []
		)
	)
	for (const t of catalog.tables) {
		for (const c of t.columns) {
			const nullable = guarded.has(`${t.name}.${c.name}`)
			assert.equal(
				c.notNull,
				!nullable,
				nullable
					? `${t.name}.${c.name}, a guarded law column, is NULL outside its selection`
					: `${t.name}.${c.name} is NOT NULL`
			)
			if (
				c.type.name === "text" ||
				Arr.some(catalog.domains, (d) => d.name === c.type.name && Option.isSome(d.collation))
			) {
				assert.deepEqual(c.collation, Option.some("pg_catalog.pg_c_utf8"), `${t.name}.${c.name}`)
			}
			assert.notEqual(
				c.generation.kind,
				"identity",
				`${t.name}.${c.name} is no identity: grizzle mints no ids`
			)
		}
		for (const k of t.constraints) {
			assert.equal(k.validated, true, `${t.name}.${k.name} is validated`)
		}
	}
	for (const d of catalog.domains) {
		assert.equal(d.notNull, false, `domain ${d.name} carries no NOT NULL`)
		for (const k of d.constraints) {
			assert.equal(k.validated, true, `${d.name}.${k.name} is validated`)
		}
	}
	for (const x of catalog.indexes) {
		assert.equal(x.valid, true, `index ${x.name} is valid`)
	}
	assert.equal(
		catalog.enumLabels,
		0,
		"a closed id is a code under its roster's domain: no enum label"
	)
	for (const roster of rostersOf(installation.owned)) {
		const name = installation.names.rosterDomain(roster.closed).name
		const domain = defined(
			Arr.findFirst(catalog.domains, (d) => d.name === name).pipe(Option.getOrUndefined),
			`the domain of roster ${roster.closed}`
		)
		assert.deepEqual(
			{ base: domain.base.name, calls: Arr.map(domain.constraints, (k) => k.calls.length) },
			{ base: "int2", calls: [1] },
			`roster ${roster.closed}'s domain`
		)
		for (const called of Arr.flatMap(domain.constraints, (k) => k.calls)) {
			assert.ok(
				Arr.some(catalog.functions, (f) => f.name === called),
				`the names constant ${called} of roster ${roster.closed}`
			)
		}
	}
	const everything = [
		...catalog.schemaGrants,
		...Arr.flatMap(catalog.tables, (t) => t.grants),
		...Arr.flatMap(catalog.sequences, (s) => s.grants),
		...Arr.flatMap(catalog.domains, (d) => d.grants),
		...Arr.flatMap(catalog.functions, (f) => f.grants)
	]
	assert.deepEqual(
		Arr.filter(everything, (g) => g.grantee === "PUBLIC"),
		[]
	)
	const global = Arr.filter(
		catalog.defaultAcls,
		(d) => d.role === catalog.owner && Option.isNone(d.schema)
	)
	assert.deepEqual(
		Arr.sort(
			Arr.map(global, (d) => d.objectType),
			Order.String
		),
		["T", "f"],
		"the owner's defaults on types and functions are reset in the global form"
	)
	assert.deepEqual(
		Arr.flatMap(global, (d) => Arr.filter(d.grants, (g) => g.grantee === "PUBLIC")),
		[],
		"the owner's global defaults grant PUBLIC nothing"
	)
}
