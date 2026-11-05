import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import type { ConstraintName } from "#compiler/core/ids.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { NativeKind } from "#compiler/ir/law.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	type FixtureWorlds,
	fixtureSessions,
	fixtureWorlds,
	installed,
	worldsExpectation
} from "#test/pg/physical/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { expectedCatalog, projectCatalog } from "#test/support/catalog/expected.ts"
import type { Catalog } from "#test/support/catalog/read.ts"
import { verifyErasure } from "#test/support/catalog/verify.ts"
import type { AuthoredStatementDesc, SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { type ContractNames, installationNamesOf, type Names } from "#test/support/kernel/naming.ts"
import { expectConstraint } from "#test/support/substrate/expect.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { Charges, fixtures, Ledger } from "#test/unit/physical/fixtures.ts"

/** The statement of a fixture that `is` picks, the one a refusal's constraint enforces. */
const statementOf = (
	desc: SchemaDesc,
	is: (s: AuthoredStatementDesc) => boolean
): AuthoredStatementDesc => {
	const [statement, ...more] = Arr.filter(desc.statements, is)
	if (statement === undefined || more.length > 0) {
		throw new Error(`expected one such statement of ${desc.name}`)
	}
	return statement
}

/** The constraint of `kind` an authored statement's law is reported by. */
const constraintOfDesc = (
	names: Names,
	statement: AuthoredStatementDesc,
	kind: NativeKind
): ConstraintName => names.constraintOf(names.lawOfDesc(statement), kind)

/** A checked contract's domain CHECK. */
const checkOf = (contract: ContractNames): ConstraintName => {
	if (contract.kind !== "checked") {
		throw new Error("expected a contract with a CHECK")
	}
	return contract.constraint
}

/**
 * The physical names of an installation's objects, read from the installation and quoted for SQL text: a relation's
 * table, and a list of its fields' columns.
 */
interface Physical {
	readonly table: (relation: string) => string
	readonly columns: (relation: string, fields: ReadonlyArray<string>) => string
}

const qualified = (o: { readonly schema: string; readonly name: string }) =>
	`${quoteIdent(o.schema)}.${quoteIdent(o.name)}`

const physicalOf = (installation: Installation): Physical => {
	const names = installationNamesOf(installation)
	return {
		table: (relation) =>
			qualified({ schema: names.schema, name: names.tableIdent({ name: relation }) }),
		columns: (relation, fields) =>
			Arr.join(
				Arr.map(fields, (f) => quoteIdent(names.columnIdent({ name: relation }, f))),
				", "
			)
	}
}

/** A nonempty result of one text column, as PostgreSQL returns it. */
const oneText = (rows: unknown): Arr.NonEmptyReadonlyArray<readonly [string]> =>
	trusted<Arr.NonEmptyReadonlyArray<readonly [string]>>(rows)

/**
 * The fresh-install schema compiler on PostgreSQL 19.
 *
 * Every fixture installs with its worlds (support.ts fixtureWorlds: a full writer and a reader in one login), and its
 * installed catalog equals the manifest's promise, the logins, roles, their defaults, memberships, views and grants
 * included; every column is NOT NULL and the columns of text or of a domain with a collation are pg_c_utf8, domains
 * carry no NOT NULL and CHECKs named by their domain, enums are in roster order, identities have named sequences,
 * PUBLIC holds no grant, every constraint is validated and every index valid, and the erasure verifier finds no UPDATE
 * on an immutable relation and no TRUNCATE; test/pg/physical/verify.test.ts shows it finds each drift. A role's grants
 * are exercised as a direct writer meets them: the writer writes its tables and is refused what grizzle grants no one,
 * and the reader reads through its world's views and writes nothing.
 *
 * A fresh install leaves every constraint validated and every index valid.
 */
/** The identity sequence of the installed column `column` of the installed table `table`, as `<schema>.<sequence>`. */
const sequenceOf = (installation: Installation, table: string, column: string): string => {
	for (const r of Rec.values(installation.owned.relations)) {
		if (r.kind !== "relation" || r.ident !== table) {
			continue
		}
		const field = Arr.findFirst(Rec.values(r.fields), (f) => f.column === column)
		if (Option.isSome(field)) {
			const s = installation.names.sequence(r.name, field.value.name)
			return `${s.schema}.${s.name}`
		}
	}
	throw new Error(`no owned field is installed as ${table}.${column}`)
}

const checkInvariants = (
	desc: SchemaDesc,
	worlds: FixtureWorlds,
	installation: Installation,
	catalog: Catalog
) => {
	assert.deepEqual(projectCatalog(catalog), expectedCatalog(installation))
	assert.deepEqual(verifyErasure(catalog, worldsExpectation(desc, installation, worlds)), [])
	for (const t of catalog.tables) {
		for (const c of t.columns) {
			assert.equal(c.notNull, true, `${t.name}.${c.name} is NOT NULL`)
			if (
				c.type.name === "text" ||
				Arr.some(catalog.domains, (d) => d.name === c.type.name && Option.isSome(d.collation))
			) {
				assert.deepEqual(c.collation, Option.some("pg_catalog.pg_c_utf8"), `${t.name}.${c.name}`)
			}
			if (c.generation.kind === "identity") {
				assert.equal(c.generation.sequence, sequenceOf(installation, t.name, c.name))
			}
		}
	}
	for (const d of catalog.domains) {
		assert.equal(d.notNull, false, `domain ${d.name} carries no NOT NULL`)
		for (const k of d.constraints) {
			assert.equal(k.validated, true)
		}
	}
	for (const t of catalog.tables) {
		for (const k of t.constraints) {
			assert.equal(k.validated, true, `${t.name}.${k.name} is validated`)
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
}

layer(Substrate.layer)("fresh install", (it) => {
	for (const fixture of fixtures) {
		it.effect(
			`${fixture.name}: the installed catalog equals the manifest and the erasure shape holds`,
			() =>
				Effect.gen(function* () {
					const worlds = fixtureWorlds(fixture.desc)
					const { installation, catalog } = yield* installed(fixture.desc, "physical", [
						worlds.login
					])
					checkInvariants(fixture.desc, worlds, installation, catalog)
				})
		)
	}

	it.effect("future objects grant PUBLIC nothing: the owner's default privileges are reset", () =>
		Effect.gen(function* () {
			const { catalog } = yield* installed(Ledger, "physical", [])
			const owner = catalog.owner
			const global = Arr.filter(
				catalog.defaultAcls,
				(d) => d.role === owner && Option.isNone(d.schema)
			)
			assert.deepEqual(
				Arr.sort(
					Arr.map(global, (d) => d.objectType),
					Order.String
				),
				["T", "f"]
			)
			for (const d of global) {
				assert.deepEqual(
					Arr.filter(d.grants, (g) => g.grantee === "PUBLIC"),
					[]
				)
			}
		})
	)

	it.effect(
		"money constants in CHECKs and index predicates do not depend on the writer's lc_monetary",
		() =>
			Effect.gen(function* () {
				const substrate = yield* Substrate
				/**
				 * The install itself is the first check: PostgreSQL refuses a STABLE cast in an index predicate (42P17).
				 *
				 * Any role may set lc_monetary. Under a locale with no fractional digits, numeric::money and bigint::money
				 * count whole units, so a cast evaluated per row would move every money constant.
				 *
				 * One minor unit: below the domain's 1.00, and the surcharge the row CHECK forbids.
				 *
				 * 125 minor units is the 1.25 the key over the selected side selects, `key(on(select(Charge, fee = 1.25),
				 * account))`: at most one such charge per account. Charges of any other fee lie outside the selection, their
				 * law columns NULL, and the key's UNIQUE is NULLS DISTINCT, so two of them under one account are no repeat.
				 */
				const worlds = fixtureWorlds(Charges)
				const { installation } = yield* installed(Charges, "physical", [worlds.login])
				const names = installationNamesOf(installation)
				const at = physicalOf(installation)
				const { writer } = yield* fixtureSessions(installation, worlds)
				const w = yield* substrate.session({ ...worldSession(writer) })
				const account = "00000000-0000-4000-8000-000000000001"
				yield* w.query(
					`INSERT INTO ${at.table("Account")} (${at.columns("Account", ["id"])}) VALUES ('${account}'::uuid)`,
					[]
				)
				yield* w.query("SET lc_monetary = 'ja_JP.UTF-8'", [])
				const [[monetary]] = yield* Effect.map(w.values("SHOW lc_monetary", []), oneText)
				assert.equal(monetary, "ja_JP.UTF-8")
				const charge = (n: number, fee: bigint, surcharge: bigint) =>
					w.query(
						`INSERT INTO ${at.table("Charge")} (${at.columns("Charge", ["id", "account", "fee", "surcharge"])}) VALUES ('00000000-0000-4000-8000-00000000010${n}'::uuid, '${account}'::uuid, ${fee}::bigint::money, ${surcharge}::bigint::money)`,
						[]
					)
				yield* expectConstraint(charge(1, 1n, 0n), checkOf(names.contract("Fee")), "23514")
				const surchargeCheck = statementOf(
					Charges,
					(st) => st.kind === "check" && st.name === "SurchargeNotPenny"
				)
				yield* expectConstraint(
					charge(2, 100n, 1n),
					constraintOfDesc(names, surchargeCheck, "TableCheck"),
					"23514"
				)
				yield* charge(3, 125n, 0n)
				const feeKey = statementOf(Charges, (st) => st.kind === "key")
				yield* expectConstraint(
					charge(4, 125n, 0n),
					constraintOfDesc(names, feeKey, "Unique"),
					"23505"
				)
				yield* charge(5, 126n, 0n)
				yield* charge(6, 127n, 0n)
				yield* w.query("RESET lc_monetary", [])
				const feeColumn = at.columns("Charge", ["fee"])
				const rows = yield* w.values(
					`SELECT ${feeColumn}::numeric::text FROM ${at.table("Charge")} ORDER BY ${feeColumn}`,
					[]
				)
				assert.deepEqual(rows, [["1.25"], ["1.26"], ["1.27"]])
			})
	)
})
