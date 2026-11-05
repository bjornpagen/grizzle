import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import type { ConstraintName } from "#compiler/core/ids.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { roleReadNames } from "#compiler/physical/ddl/names.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import {
	type FixtureWorlds,
	fixtureSessions,
	fixtureWorlds,
	installed,
	worldsExpectation
} from "#test/pg/physical/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { declaredEnums } from "#test/support/catalog/declared.ts"
import { expectedCatalog, projectCatalog } from "#test/support/catalog/expected.ts"
import type { Catalog } from "#test/support/catalog/read.ts"
import { verifyErasure } from "#test/support/catalog/verify.ts"
import type { AuthoredStatementDesc, SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	type ContractNames,
	installationNamesOf,
	type Names,
	type ReportingKind
} from "#test/support/kernel/naming.ts"
import { expectConstraint, expectSqlstate, inTransaction } from "#test/support/substrate/expect.ts"
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
	kind: ReportingKind
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
 * table, a list of its fields' columns, a closed relation's enum, a serial field's identity sequence as a regclass
 * literal, and the vector type of a dimension in the installation's vector schema.
 */
interface Physical {
	readonly table: (relation: string) => string
	readonly columns: (relation: string, fields: ReadonlyArray<string>) => string
	readonly enumType: (closed: string) => string
	readonly sequence: (relation: string, field: string) => string
	readonly vector: (dimension: number) => string
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
			),
		enumType: (closed) =>
			qualified(
				Option.getOrThrowWith(
					Rec.get(installation.closedTemplates, closed),
					() => new Error(`the installation holds no closed relation ${closed}`)
				).enum
			),
		sequence: (relation, field) =>
			quoteString(qualified(installation.names.sequence(relation, field))),
		vector: (dimension) => `${quoteIdent(installation.settings.vectorSchema)}.vector(${dimension})`
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
		if (r.ident !== table) {
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
	/** Each enum is a declared closed relation, its labels the declared handles in order. */
	const enums = declaredEnums(desc)
	assert.deepEqual(
		Arr.sort(
			Arr.map(catalog.enums, (e) => e.name),
			Order.String
		),
		Arr.sort([...enums.keys()], Order.String)
	)
	for (const e of catalog.enums) {
		assert.deepEqual(e.labels, defined(enums.get(e.name), `enum ${e.name}`))
	}
	const everything = [
		...catalog.schemaGrants,
		...Arr.flatMap(catalog.tables, (t) => t.grants),
		...Arr.flatMap(catalog.sequences, (s) => s.grants),
		...Arr.flatMap(catalog.enums, (e) => e.grants),
		...Arr.flatMap(catalog.domains, (d) => d.grants)
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
				 * 125 minor units is the 1.25 the capacity selects: at most one such charge per account.
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
				const feeCapacity = statementOf(Charges, (st) => st.kind === "capacity")
				yield* expectConstraint(
					charge(4, 125n, 0n),
					constraintOfDesc(names, feeCapacity, "Unique"),
					"23505"
				)
				yield* charge(5, 126n, 0n)
				yield* w.query("RESET lc_monetary", [])
				const feeColumn = at.columns("Charge", ["fee"])
				const rows = yield* w.values(
					`SELECT ${feeColumn}::numeric::text FROM ${at.table("Charge")} ORDER BY ${feeColumn}`,
					[]
				)
				assert.deepEqual(rows, [["1.25"], ["1.26"]])
			})
	)

	it.effect("roles hold exactly their derived grants", () =>
		Effect.gen(function* () {
			const substrate = yield* Substrate
			/**
			 * An identity column refuses an explicit value without OVERRIDING SYSTEM VALUE.
			 *
			 * No role holds a privilege on an identity sequence: setval is refused, and the advance function moves the
			 * sequence past a value, so the next default is the one after it.
			 *
			 * A domain refuses an out-of-pattern value with the domain's constraint.
			 *
			 * An exact repeat of a key is a unique violation for a direct writer.
			 *
			 * UPDATE of an immutable relation is refused by privilege; of a mutable one permitted.
			 *
			 * The row CHECK, the finite CHECK and the at-most-one capacity, a UNIQUE over its source, are native:
			 * finite laws become ordinary constraints.
			 */
			const worlds = fixtureWorlds(Ledger)
			const { installation } = yield* installed(Ledger, "physical", [worlds.login])
			const names = installationNamesOf(installation)
			const at = physicalOf(installation)
			const { writer, reader } = yield* fixtureSessions(installation, worlds)
			const w = yield* substrate.session({ ...worldSession(writer) })
			const r = yield* substrate.session({ ...worldSession(reader) })
			const accountTable = at.table("Account")
			const entryTable = at.table("Entry")
			const currency = at.enumType("Currency")
			const purpose = at.enumType("Purpose")
			const opening = at.columns("Account", ["code", "currency", "opened"])
			const entryColumns = at.columns("Entry", [
				"account",
				"purpose",
				"amount",
				"refund",
				"remainder",
				"rate",
				"fee",
				"weight",
				"score",
				"ratio",
				"embedding",
				"memo"
			])
			const vector = at.vector(3)
			yield* w.query(
				`INSERT INTO ${accountTable} (${opening}) VALUES ('ABC'::text, 'Usd'::${currency}, 1::bigint)`,
				[]
			)
			const [[id]] = yield* Effect.map(
				w.values(`SELECT ${at.columns("Account", ["id"])}::text FROM ${accountTable}`, []),
				oneText
			)
			yield* expectSqlstate(
				w.query(
					`INSERT INTO ${accountTable} (${at.columns("Account", ["id", "code", "currency", "opened"])}) VALUES (99::bigint, 'XYZ'::text, 'Eur'::${currency}, 1::bigint)`,
					[]
				),
				"428C9"
			)
			yield* expectSqlstate(
				w.query(
					`SELECT pg_catalog.setval(${at.sequence("Account", "id")}::regclass, 10::bigint)`,
					[]
				),
				"42501"
			)
			const advance = installation.names.advance("Account", "id")
			yield* w.query(
				`SELECT ${quoteIdent(advance.schema)}.${quoteIdent(advance.name)}(10::bigint)`,
				[]
			)
			const rows = yield* w.values(
				`INSERT INTO ${accountTable} (${opening}) VALUES ('DEF'::text, 'Usd'::${currency}, 1::bigint) RETURNING ${at.columns("Account", ["id"])}::text`,
				[]
			)
			assert.deepEqual(rows, [["11"]])
			yield* expectConstraint(
				w.query(
					`INSERT INTO ${accountTable} (${opening}) VALUES ('abc'::text, 'Usd'::${currency}, 1::bigint)`,
					[]
				),
				names.textDomain({ name: "Account" }, "code").constraint,
				"23514"
			)
			yield* expectSqlstate(
				w.query(
					`INSERT INTO ${accountTable} (${opening}) VALUES ('ABC'::text, 'Usd'::${currency}, 1::bigint)`,
					[]
				),
				"23505"
			)
			yield* expectSqlstate(
				w.query(`UPDATE ${accountTable} SET ${at.columns("Account", ["opened"])} = 2::bigint`, []),
				"42501"
			)
			yield* expectSqlstate(w.query(`TRUNCATE ${accountTable}`, []), "42501")
			yield* w.query(
				`INSERT INTO ${entryTable} (${entryColumns})
				VALUES (${id}::bigint, 'Payroll'::${purpose}, 10::bigint, 5::bigint, true, 0.5::numeric, 1.25::numeric::money, 1::real, 2::double precision, 3.5::numeric, '[1,2,3]'::${vector}, ''::text)`,
				[]
			)
			yield* w.query(`UPDATE ${entryTable} SET ${at.columns("Entry", ["memo"])} = 'm'::text`, [])
			yield* expectConstraint(
				w.query(`UPDATE ${entryTable} SET ${at.columns("Entry", ["refund"])} = 50::bigint`, []),
				constraintOfDesc(
					names,
					statementOf(Ledger, (st) => st.kind === "check" && st.name === "RefundWithinAmount"),
					"TableCheck"
				),
				"23514"
			)
			yield* expectConstraint(
				w.query(
					`INSERT INTO ${at.table("Rounding")} (${at.columns("Rounding", ["currency", "minor"])}) VALUES ('Usd'::${currency}, 1::bigint)`,
					[]
				),
				constraintOfDesc(
					names,
					statementOf(Ledger, (st) => st.kind === "contained" && st.left.relation === "Rounding"),
					"FiniteCheck"
				),
				"23514"
			)
			yield* w.query(
				`INSERT INTO ${at.table("Rounding")} (${at.columns("Rounding", ["currency", "minor"])}) VALUES ('Usd'::${currency}, 100::bigint)`,
				[]
			)
			yield* expectConstraint(
				w.query(
					`INSERT INTO ${entryTable} (${entryColumns})
					VALUES (${id}::bigint, 'Refund'::${purpose}, 10::bigint, 5::bigint, true, 0.5::numeric, 1::numeric::money, 1::real, 2::double precision, 3.5::numeric, '[1,2,3]'::${vector}, ''::text)`,
					[]
				),
				constraintOfDesc(
					names,
					statementOf(Ledger, (st) => st.kind === "capacity"),
					"Unique"
				),
				"23505"
			)
			/**
			 * The reader reads through its world's view and writes nothing: not its view, not the table, which it
			 * cannot read either.
			 */
			const entryView = roleReadNames(installation.names, worlds.reader).relation("Entry")
			const view = `${quoteIdent(entryView.schema)}.${quoteIdent(entryView.name)}`
			yield* r.query(`SELECT count(*) FROM ${view}`, [])
			yield* expectSqlstate(r.query(`DELETE FROM ${view}`, []), "42501")
			yield* expectSqlstate(r.query(`DELETE FROM ${entryTable}`, []), "42501")
			yield* expectSqlstate(r.query(`SELECT count(*) FROM ${entryTable}`, []), "42501")
			/** The foreign key into the selected Refund entries is deferred: a payout of a Refund entry fails at COMMIT. */
			const [[entry]] = yield* Effect.map(
				w.values(`SELECT ${at.columns("Entry", ["id"])}::text FROM ${entryTable}`, []),
				oneText
			)
			yield* expectConstraint(
				inTransaction(
					w,
					Effect.gen(function* () {
						yield* w.query(
							`UPDATE ${entryTable} SET ${at.columns("Entry", ["purpose"])} = 'Refund'::${purpose}`,
							[]
						)
						yield* w.query(
							`INSERT INTO ${at.table("Payout")} (${at.columns("Payout", ["entry", "purpose"])}) VALUES (${entry}::int4, 'Refund'::${purpose})`,
							[]
						)
						yield* w.query("COMMIT", [])
					})
				),
				names.fieldConstraint({ name: "Payout" }, "fk", ["entry"]),
				"23503"
			)
		})
	)
})
