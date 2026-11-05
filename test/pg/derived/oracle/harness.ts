import {
	Array as Arr,
	type Context,
	Data,
	Effect,
	Layer,
	Order,
	Record as Rec,
	type Scope
} from "effect"
import type { DbContext } from "#adapter/db/context.ts"
import { openDb as openRuntime } from "#adapter/db/open.ts"
import type { OpenError, ReadError } from "#adapter/errors/execution.ts"
import type { ReaderValue } from "#adapter/reader/reader.ts"
import type { DbLayerOf } from "#adapter/types/layer.ts"
import { type DerivedAnalysis, derivedAnalysis } from "#compiler/analysis/schema.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import type { AnyLogin, AnyLoginRole } from "#compiler/public/schema.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import {
	complementOf,
	CurrentPerturbation,
	perturbedContext
} from "#test/support/oracle/perturb.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { checkedIn } from "#test/support/policy.ts"
import { contextOf, dbReader } from "#test/support/runtime-db.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayerIn, tokenOf } from "#test/support/worlds.ts"

/** The refresh oracle's harness.
 *
 * A derived schema is installed by the fresh-install compiler with the derived relation extension under a fresh schema
 * name, its facts loaded as the owner, and the schema rebuilt under the installed name so Db.open logs in as the
 * installed roles (`explains` the rebuild). The oracle then reads, as the owner, in one read-only
 * snapshot:
 *
 * - each view's stored rows, as record text, with each row's tuple id and xmin: a row a refresh did not write keeps
 *   both, and the rows one transaction wrote share its xmin;
 * - each view's definition evaluated by the conservative lowering, the baseline that relies on no evidence,
 *   as record text over the same columns: "after db.refresh, each named view equals its definition
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

/** The rows a snapshot read for `relation`; a relation it did not read is a defect of the caller. */
export const readOf = <A>(reads: ReadonlyMap<string, A>, relation: string): A => {
	const rows = reads.get(relation)
	if (rows === undefined) {
		throw new OracleFixtureFailed({ message: `the snapshot did not read ${relation}` })
	}
	return rows
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
	declared: unknown,
	facts: Facts,
	label: string,
	logins: ReadonlyArray<unknown>
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
		yield* transaction(s.admin, statements.value)
		const qualified = (relation: string) => {
			const name = installed.names.relation(relation)
			return `${quoteIdent(name.schema)}.${quoteIdent(name.name)}`
		}
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
			const program = lowerConservative(conservativeInput(r.query), {
				names: installed.names,
				params: [],
				subject: { kind: "query" }
			})
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

/** The context a Db of a role of `login` runs on: a DbLayer built in the scope, exactly as an application builds one,
 * through the substrate's target. When the scope closes, the layer closes its pool; the substrate's release of the
 * login's role, at the end of the installation's scope, is the one judge of a session left behind. The harness's config
 * is always one a connection can use, so a refusal of it is a defect of the harness. */
const dbContextAs = (
	o: Opened,
	login: AnyLogin
): Effect.Effect<Context.Context<DbLayerOf<AnyLogin>>, never, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		return yield* Effect.orDie(Layer.build(loginLayerIn(s.database, o.installed, login)))
	})

/** Opens `role`, a role reached through its login over the schema rebuilt under the installed name, in the scope, through the runtime
 * Db.open runs: a generated schema's type is known only at run time, and the typed facade is
 * the type tests' subject. It yields the Db's reader, the one db.execute dispatches to, and the Db's contexts for
 * refresh reports.
 *
 * `ctx` carries the case's plan perturbation, so every refresh through it sets the case's planner settings in its
 * transaction, and `again` its complement (perturb.ts complementOf), the plan of a second reading. */
export const openCaseDb = (
	o: Opened,
	role: AnyLoginRole
): Effect.Effect<
	{ readonly db: ReaderValue; readonly ctx: DbContext; readonly again: DbContext },
	OpenError,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const perturbation = yield* CurrentPerturbation
		const context = yield* dbContextAs(o, role.login)
		const db = yield* openRuntime(role, { token: tokenOf({}) }).pipe(Effect.provideContext(context))
		return {
			db: dbReader(db),
			ctx: perturbedContext(contextOf(db), perturbation),
			again: perturbedContext(contextOf(db), complementOf(perturbation))
		}
	})

/** Every fact of a derived relation, read through the Db: a query matching each of its fields. */
export const readAll = (
	db: ReaderValue,
	top: unknown,
	value: unknown,
	columns: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<unknown>, ReadError> =>
	Effect.flatMap(
		db.execute(
			query(top).rule((r: RuleValue) => {
				const vars = v(value, "value")
				const bound = Rec.fromEntries(Arr.map(columns, (c) => [c, vars[c]]))
				return r.match(value, bound).find(bound)
			}),
			{}
		),
		(result) => result.collect
	)

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

/** Replaces every base relation's facts with `facts`, as the owner, in one transaction (`installationGroup`). Every base relation's table is truncated first and the facts inserted in the order given, so a
 * reload of the same facts rewrites every base row. */
export const reload = (
	o: Opened,
	facts: Facts
): Effect.Effect<void, CompileError | SqlError | TransactionRolledBack, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const inserts = factStatements(o.installed.plan, facts)
		if (!inserts.ok) {
			return yield* Effect.fail(inserts.error)
		}
		yield* replaceRows(
			s.admin,
			installationGroup(namesOf(o.installed)),
			Arr.map(inserts.value, (sql) => ({ sql, params: [] }))
		)
	})
