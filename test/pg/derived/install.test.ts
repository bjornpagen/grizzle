import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noFeatures } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Order,
	pipe,
	Schema,
	String as Str
} from "effect"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { columnType } from "#compiler/physical/ddl/names.ts"
import { Compute } from "#compiler/public/compute.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { printObjectName, printType, quoteIdent } from "#compiler/sql/print.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { assert, lacks, succeeded } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import {
	type Installed,
	installMigrated as install,
	loadMigrated as load
} from "#test/support/install-migrate.ts"
import { namesOf, parsedName } from "#test/support/kernel/naming.ts"
import { checkedIn } from "#test/support/policy.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import * as K from "#test/unit/derived/kit.ts"

/** Derived relations installed on PostgreSQL 19 (gate).
 *
 * - the inferred descriptors hold: every view column's catalog type, typmod and collation is the one its inferred field
 *   descriptor names, for every aggregate overload, refinement, roster and contract;
 * - a view column of refined text has its pattern's domain, whether a stored field declares the pattern or not, a role
 *   reading the relation reads it through its world's view, and a role refreshing it refreshes the materialized view;
 * - a refresh inside an owner's transaction with a deferred containment temporarily false (transaction evidence)
 *   equals the definition evaluated by the conservative lowering on the same snapshot.
 *
 * That every refreshed view equals its definition, over drawn levels, take forms and aggregates, is the derived
 * oracle's; the installed catalog is the catalog spec checker's. */

/** The rows, at least one, of a catalog query whose columns are text: rows from PostgreSQL are external input, decoded. */
const rowsOf =
	<A>(row: Schema.Codec<A>) =>
	<E, R>(rows: Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E, R>) =>
		Effect.flatMap(rows, Schema.decodeUnknownEffect(Schema.NonEmptyArray(row)))
const textRows1 = rowsOf(Schema.Tuple([Schema.String]))
const textRows3 = rowsOf(Schema.Tuple([Schema.String, Schema.String, Schema.String]))

const id = (n: number) => `00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The view of a derived relation and its columns, in heading order. */
const viewOf = (installed: Installed, relation: string) => {
	const a = Result.map(checkedIn(installed.installation.owned), derivedAnalysis)
	if (!a.ok) {
		throw a.error
	}
	const r = a.value.relations[relation]
	if (r === undefined) {
		throw new Error(`no derived relation ${relation}`)
	}
	const view = installed.names.relation(relation)
	const columns = Arr.map(r.heading, (c) => installed.names.column(relation, c.name))
	return { analysis: r, view: printObjectName(view), columns }
}

/** The definition's conservative lowering, the oracle baseline that relies on no evidence. */
const conservativeSql = (installed: Installed, relation: string): string => {
	const { analysis } = viewOf(installed, relation)
	const program = lowerConservative(conservativeInput(analysis.query), {
		names: installed.names,
		params: [],
		subject: { kind: "query" },
		meter: new BudgetMeter(compileBudgets)
	})
	if (!program.ok) {
		throw program.error
	}
	return flight(program.value.roots)[0].sql.text
}

/** The view's rows and its definition's rows, each as record text, read in one snapshot. */
const viewAndDefinition = (installed: Installed, relation: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const owner = yield* substrate.session({ ...ownerSession(), label: "oracle" })
		const { view, columns, analysis } = viewOf(installed, relation)
		const names = Arr.map(analysis.heading, (c) => `"${c.name}"`)
		yield* owner.begin
		const stored = yield* owner.values(
			`SELECT ROW(${Arr.join(
				Arr.map(columns, (c) => `"r1"."${c}"`),
				", "
			)})::text FROM ${view} AS "r1"`,
			[]
		)
		const defined = yield* owner.values(
			`SELECT ROW(${Arr.join(
				Arr.map(names, (n) => `"r1".${n}`),
				", "
			)})::text FROM (${conservativeSql(installed, relation)}) AS "r1"`,
			[]
		)
		yield* owner.commit
		const sorted = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
			Arr.sort(
				Arr.map(rows, (r) => String(r[0])),
				Order.String
			)
		return { stored: sorted(stored), defined: sorted(defined) }
	})

const workFacts = {
	Account: [
		{ id: id(1), name: "alpha" },
		{ id: id(2), name: "beta" },
		{ id: id(3), name: "gamma" }
	],
	Task: [
		{ id: id(11), account: id(1), kind: "Automatic" },
		{ id: id(12), account: id(1), kind: "Automatic" },
		{ id: id(13), account: id(1), kind: "Manual" },
		{ id: id(14), account: id(2), kind: "Automatic" }
	],
	AutomaticTask: [
		{ task: id(11), budget: 100n },
		{ task: id(12), budget: 100n },
		{ task: id(14), budget: 250n }
	],
	ManualTask: [{ task: id(13), operator: "ops" }]
}

/** The SQL type text of an inferred descriptor's column, as the installation names it. */
const typmodOf = (desc: FieldDesc): number =>
	desc.kind === "numeric" && "precision" in desc ? ((desc.precision << 16) | desc.scale) + 4 : -1

layer(Substrate.layer)("derived relations on PostgreSQL 19", (it) => {
	it.effect(
		"inferred descriptors hold for every aggregate overload, refinement, roster and contract",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const installed = yield* install(K.KitReports, {
						extensions: [],
						label: "derived",
						logins: []
					})
					const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
					return yield* exhaust(
						{
							suite: "derived/install/descriptors",
							generator: element(["Sums", "Means", "Extremes", "Facts", "Computed"] as const),
							literal: Formatter.format,
							limit: 5,
							features: noFeatures,
							caseHang: Duration.minutes(2)
						},
						(relation) =>
							Effect.gen(function* () {
								const { analysis, view } = viewOf(installed, relation)
								for (const c of analysis.heading) {
									const column = installed.names.column(relation, c.name)
									const desc = c.desc
									const expected = printType(columnType(installed.names, c.type).type)
									const [[sameType, typmod, collation]] = yield* textRows3(
										owner.values(
											`SELECT (a.atttypid = '${Str.replaceAll("'", "''")(expected)}'::regtype)::text, a.atttypmod::text, a.attcollation::regcollation::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = '${view}'::regclass AND a.attname = '${column}'`,
											[]
										)
									)
									assert.equal(sameType, "true", `${relation}.${c.name} is ${expected}`)
									assert.equal(Number(typmod), typmodOf(desc), `${relation}.${c.name} typmod`)
									if (baseOf(c.type).carrier === "text") {
										assert.equal(collation, "pg_c_utf8", `${relation}.${c.name} collation`)
									}
								}
							})
					)
				})
			)
	)

	it.effect(
		"a refined-text literal column has its pattern's domain, declared by a field or not",
		() =>
			Effect.gen(function* () {
				const substrate = yield* Substrate
				const Code = str.regex("^[A-Z]{3}$")
				const Coded = relation("Coded", { id: uuid, code: Code }, ["id"])
				const C = schema("C", { Coded }, [])
				const literals = query(C).rule((r) => {
					const { id } = v(Coded)
					return r.match(Coded, { id }).find({
						id,
						declared: Compute.literal(Code, "ABC"),
						undeclared: Compute.literal(str.regex("^[a-z]+$"), "abc")
					})
				})
				const Literals = derived("Literals", literals)
				const Ext = schema.extend(C, { Literals }, [])
				const viewer = role(Ext, "viewer", { Literals })
				const refresher = role(Ext, "refresher", { Coded, Literals }, { refresh: ["Literals"] })
				const installed = yield* install(Ext, {
					extensions: [],
					label: "derived",
					logins: [login(Ext, "server", [viewer, refresher])]
				})
				const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
				const { view } = viewOf(installed, "Literals")
				/** Each pattern's domain as the installation names it, as regtype prints a plain identifier. */
				const domainOf = (source: string): string => {
					const info = succeeded(textLookup(source, "u"))
					if (info.regex === "wildcard") {
						return assert.fail(`${source} is no tautology`)
					}
					const domain = installed.names.textDomain(info.regex)
					if (domain === undefined) {
						return assert.fail(`the installation names no domain of ${source}`)
					}
					return `${domain.schema}.${domain.name}`
				}
				assert.deepEqual(
					yield* owner.values(
						`SELECT a.attname::text, a.atttypid::regtype::text, a.attcollation::regcollation::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = '${view}'::regclass AND a.attnum > 0 ORDER BY a.attnum`,
						[]
					),
					[
						["declared", domainOf("^[A-Z]{3}$"), "pg_c_utf8"],
						["id", "uuid", "-"],
						["undeclared", domainOf("^[a-z]+$"), "pg_c_utf8"]
					]
				)
				yield* load(installed, { Coded: [{ id: id(1), code: "QRS" }] })
				const refreshing = yield* substrate.session({
					...worldSession(installed.world(refresher)),
					label: "refresher"
				})
				yield* refreshing.query(`REFRESH MATERIALIZED VIEW ${view}`, [])
				yield* refreshing.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`, [])
				const { stored, defined } = yield* viewAndDefinition(installed, "Literals")
				assert.deepEqual(stored, defined)
				assert.deepEqual(stored, [`(ABC,${id(1)},abc)`])
				/** The viewer reads the domain-typed columns through its world's view of Literals. */
				const viewing = yield* substrate.session({
					...worldSession(installed.world(viewer)),
					label: "viewer"
				})
				const seen = `${quoteIdent(installed.role(viewer))}.${quoteIdent(installed.names.relation("Literals").name)}`
				assert.deepEqual(
					yield* viewing.values(`SELECT "declared"::text, "undeclared"::text FROM ${seen}`, []),
					[["ABC", "abc"]]
				)
			})
	)

	it.effect(
		"a refresh inside an owner's transaction, a deferred containment false, equals the oracle",
		() =>
			Effect.gen(function* () {
				const substrate = yield* Substrate
				const ownedTasks = query(W.Work).rule((r) => {
					const { id: t, account } = v(W.Task)
					return r
						.match(W.Task, { id: t, account })
						.match(W.Account, { id: account })
						.find({ id: t })
				})
				const OwnedTasks = derived("OwnedTasks", ownedTasks)
				/** Account's name lies outside the referenced key, which makes Task.account -> Account.id deferred. */
				const Written = schema.extend(W.Work, { OwnedTasks }, [])
				const installed = yield* install(Written, {
					extensions: [],
					label: "derived",
					logins: []
				})
				const names = namesOf(installed)
				const { view, columns } = viewOf(installed, "OwnedTasks")
				const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
				const [[deferrable]] = yield* textRows1(
					owner.values(
						`SELECT condeferrable::text FROM pg_catalog.pg_constraint WHERE conrelid = '${names.table(W.Task)}'::regclass AND contype = 'f'`,
						[]
					)
				)
				assert.equal(deferrable, "true")
				yield* load(installed, workFacts)
				yield* owner.query(`REFRESH MATERIALIZED VIEW ${view}`, [])
				yield* owner.begin
				yield* owner.query("SET CONSTRAINTS ALL DEFERRED", [])
				yield* owner.query(
					`INSERT INTO ${names.table(W.Task)} (${names.column(W.Task, "id")}, ${names.column(W.Task, "account")}, ${names.column(W.Task, "kind")}) VALUES ('${id(16)}'::uuid, '${id(7)}'::uuid, 'Manual'::${printObjectName(installed.names.enumType(parsedName(W.Kind.name)))})`,
					[]
				)
				yield* owner.query(
					`INSERT INTO ${names.table(W.ManualTask)} (${names.column(W.ManualTask, "task")}, ${names.column(W.ManualTask, "operator")}) VALUES ('${id(16)}'::uuid, 'ops')`,
					[]
				)
				yield* owner.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`, [])
				const stored = yield* owner.values(
					`SELECT "r1"."${columns[0]}"::text FROM ${view} AS "r1"`,
					[]
				)
				const defined = yield* owner.values(
					`SELECT "r1"."id"::text FROM (${conservativeSql(installed, "OwnedTasks")}) AS "r1"`,
					[]
				)
				yield* owner.rollback
				const sorted = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
					Arr.sort(
						Arr.map(rows, (r) => String(r[0])),
						Order.String
					)
				assert.deepEqual(sorted(stored), sorted(defined))
				lacks(sorted(stored), id(16))
				assert.deepEqual(sorted(stored), [id(11), id(12), id(13), id(14)])
			})
	)
})
