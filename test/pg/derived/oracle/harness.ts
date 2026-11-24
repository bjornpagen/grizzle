import * as Result from "@bjornpagen/grizzle-text/base/result"
import { Array as Arr, Data, Effect, Order, Record as Rec, type Scope } from "effect"
import { type DerivedAnalysis, derivedAnalysis } from "#compiler/analysis/schema.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { servedQuery } from "#compiler/ir/derived.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import type { LoginSource } from "#test/support/oracle/install/real.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { checkedIn } from "#test/support/policy.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The stored relations' oracle harness.
 *
 * A derived schema is installed by the fresh-install compiler with the derived relation extension under a fresh schema
 * name, its facts loaded as the owner, and the schema rebuilt under the installed name so its login's served file names
 * the installed roles (`explains` the rebuild). The oracle then reads, as the owner, in one read-only
 * snapshot:
 *
 * - each view's stored rows, as record text, with each row's tuple id and xmin: a row a refresh did not write keeps
 *   both, and the rows one transaction wrote share its xmin;
 * - each view's definition evaluated by the conservative lowering, the baseline that relies on no evidence,
 *   as record text over the same columns: "after each COMMIT, each stored relation equals its definition
 *   evaluated by the conservative lowering on the same snapshot".
 *
 * The conservative lowering of a definition reads a lower level's view under the installation's own names, so a
 * level-2 view is compared with its definition over the level-1 view as it is stored. */

type Facts = Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>

/** One stored row: its record text, its value's record text (valueColumn), the tuple that holds it as
 * `<ctid>/<xmin>`, and that xmin alone. The tuple carries the xmin because a ctid alone does not identify a row version:
 * a plain REFRESH MATERIALIZED VIEW swaps in a new heap and writes the same rows at the same ctids in the same order, so
 * only the xmin tells the rewritten row apart. */
export interface StoredRow {
	readonly text: string
	readonly value: string
	readonly tuple: string
	readonly xmin: string
}

/** What one snapshot read: each stored relation's rows, and each defined relation's definition rows as record text,
 * sorted, repeated rows kept, so a duplicate shows. */
export interface Snapshot {
	readonly stored: ReadonlyMap<string, ReadonlyArray<StoredRow>>
	readonly defined: ReadonlyMap<string, ReadonlyArray<string>>
}

export interface Opened {
	readonly installed: Installed
	readonly analysis: DerivedAnalysis
	/** The view of a derived relation, schema-qualified and quoted. */
	readonly view: (relation: string) => string
	/** A base table, schema-qualified and quoted. */
	readonly table: (relation: string) => string
	/** The column list of a derived relation's view, in heading order, as `"r1"."<column>"`. */
	readonly columns: (relation: string) => ReadonlyArray<string>
	/** The same columns, each as its value's text (valueColumn). */
	readonly values: (relation: string) => ReadonlyArray<string>
	/** Its definition's conservative lowering and that lowering's output columns, lowered at installation, where a
	 * lowering failure is the installation's typed failure. */
	readonly definition: (relation: string) => Definition
}

export interface Definition {
	readonly sql: string
	readonly columns: Heading
}

/**
 * A column of a read as its value's text: a float's -0 as its 0, as every delivery reads it, so a view that stored a
 * group's -0 spelling and a definition that computed its 0 read alike; every other value as it is, since every stored
 * value of the oracle's other kinds has one spelling (gen.ts).
 */
const valueColumn = (expr: string, type: ScalarType): string => {
	const carrier = baseOf(type).carrier
	return carrier === "float8" || carrier === "float4"
		? `(${expr} + 0::pg_catalog.${carrier})`
		: expr
}

/** A fixture the oracle cannot use: a refusal of a generated schema, with what the compiler said, so a counterexample
 * report shows it, or a definition the oracle cannot evaluate. */
export class OracleFixtureFailed extends Data.TaggedError("OracleFixtureFailed")<{
	readonly message: string
}> {}

const compileFailed = (e: CompileError): OracleFixtureFailed =>
	new OracleFixtureFailed({
		message: `the generated schema does not compile: ${e.message}`
	})

/** Installs `declared` (the schema built under any name) with `facts` and `logins`, each a login value or a LoginDesc
 * over the declared schema ([] for none). */
export const installDerived = (
	declared: FixtureSchema,
	facts: Facts,
	label: string,
	logins: ReadonlyArray<LoginSource>
): Effect.Effect<
	Opened,
	OracleFixtureFailed | CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const installed = yield* Effect.mapError(
			install(declared, { ambient: ordinarySession, extensions: [], label, logins }),
			(e) => (e._tag === "CompileError" ? compileFailed(e) : e)
		)
		const analyzed = Result.map(checkedIn(installed.installation.owned), derivedAnalysis)
		if (!analyzed.ok) {
			return yield* compileFailed(analyzed.error)
		}
		const analysis = analyzed.value
		const statements = factStatements(installed.plan, facts)
		if (!statements.ok) {
			return yield* Effect.fail(statements.error)
		}
		const qualified = (relation: string) => {
			const name = installed.names.relation(relation)
			return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
		}
		yield* transaction(s.admin, statements.value)
		/** A relation name the fixture does not declare is a defect of the test that names it. */
		const heading = (relation: string) => {
			const r = analysis.relations[relation]
			if (r === undefined) {
				throw new OracleFixtureFailed({ message: `no derived relation ${relation}` })
			}
			return r
		}
		/** Every definition is lowered here, so a lowering failure fails the installation in the error channel rather
		 * than as a defect in the middle of a snapshot. */
		const definitions = new Map<string, Definition>()
		for (const [relation, r] of Rec.toEntries(analysis.relations)) {
			/** The definition over the base relations alone, every derived relation it reads through its own definition
			 * (CheckedSchema expanded), whatever the installation stores: the oracle a stored table is held against. */
			const program = lowerConservative(
				conservativeInput(servedQuery(r.query, analysis.schema.expanded())),
				{
					names: installed.names,
					params: [],
					subject: { kind: "query" }
				}
			)
			if (!program.ok) {
				return yield* Effect.fail(program.error)
			}
			const [main, ...rest] = flight(program.value.roots)
			if (rest.length > 0) {
				return yield* new OracleFixtureFailed({
					message: `${relation}'s definition lowers to ${flight(program.value.roots).length} statements`
				})
			}
			definitions.set(relation, { sql: main.sql.text, columns: r.heading })
		}
		const definition = (relation: string): Definition => {
			const known = definitions.get(relation)
			if (known === undefined) {
				throw new OracleFixtureFailed({ message: `no derived relation ${relation}` })
			}
			return known
		}
		return {
			installed,
			analysis,
			view: qualified,
			table: qualified,
			columns: (relation) =>
				Arr.map(
					heading(relation).heading,
					(c) => `"r1".${quoteIdent(installed.names.column(relation, c.name))}`
				),
			values: (relation) =>
				Arr.map(heading(relation).heading, (c) =>
					valueColumn(`"r1".${quoteIdent(installed.names.column(relation, c.name))}`, c.type)
				),
			definition
		}
	})

const viewRows = (session: PgConnection, o: Opened, relation: string) =>
	Effect.map(
		session.query(
			`SELECT ROW(${Arr.join(o.columns(relation), ", ")})::text AS "row", ROW(${Arr.join(o.values(relation), ", ")})::text AS "value", "r1".ctid::text || '/' || "r1".xmin::text AS "tuple", "r1".xmin::text AS "xmin" FROM ${o.view(relation)} AS "r1"`,
			[]
		),
		(result) =>
			Arr.sort(
				Arr.map(result.rows, (row) => ({
					text: String(row["row"]),
					value: String(row["value"]),
					tuple: String(row["tuple"]),
					xmin: String(row["xmin"])
				})),
				Order.mapInput(Order.String, (r: { readonly value: string }) => r.value)
			)
	)

const definitionRows = (session: PgConnection, o: Opened, relation: string) => {
	const { sql, columns } = o.definition(relation)
	return Effect.map(
		session.query(
			`SELECT ROW(${Arr.join(
				Arr.map(columns, (c) => valueColumn(`"r1".${quoteIdent(c.name)}`, c.type)),
				", "
			)})::text AS "row" FROM (${sql}) AS "r1"`,
			[]
		),
		(result) =>
			Arr.sort(
				Arr.map(result.rows, (row) => String(row["row"])),
				Order.String
			)
	)
}

/** The stored rows of `stored` and the definitions of `defined`, read as the owner in one read-only snapshot.
 * The snapshot is a transaction on the substrate's one admin connection, which every later admin statement of the file
 * shares (a shrink run's installation, the finalizers, the leftovers check), so any failure between BEGIN and COMMIT,
 * a failed read or a defect, rolls it back before it propagates, as `does`. */
export const snapshotOf = (
	o: Opened,
	stored: ReadonlyArray<string>,
	defined: ReadonlyArray<string>
): Effect.Effect<Snapshot, SqlError, Substrate> =>
	Effect.scoped(
		Effect.gen(function* () {
			const s = yield* Substrate
			const session = yield* s.admin.pin
			yield* session.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY", [])
			const out = yield* Effect.onError(
				Effect.gen(function* () {
					const storedRows = new Map<string, ReadonlyArray<StoredRow>>()
					for (const relation of stored) {
						const rows = yield* viewRows(session, o, relation)
						storedRows.set(relation, rows)
					}
					const definedRows = new Map<string, ReadonlyArray<string>>()
					for (const relation of defined) {
						const rows = yield* definitionRows(session, o, relation)
						definedRows.set(relation, rows)
					}
					const read: Snapshot = { stored: storedRows, defined: definedRows }
					return read
				}),
				() => Effect.ignore(session.query("ROLLBACK", []))
			)
			yield* session.query("COMMIT", [])
			return out
		})
	)
