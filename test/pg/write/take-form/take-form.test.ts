import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { int, oneOf, uniqueArray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, pipe, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { Plan } from "#adapter/types/db.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import {
	explainStatementWith,
	findNodes,
	type PlanNode,
	parsePlan
} from "#bench/harness/explain.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { inForce } from "#compiler/write/family/order.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { installedCodes, realityWrite, testArtifacts } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { checking } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A write's take over a relation parameter's rows chooses its form per application, by the same rule a query's does
 * (`runsLargeForm`, `sentForm`).
 *
 * The ChangeSet inserts, into Latest, the first two Entry facts by seq of every account a relation parameter names: a
 * take correlated with the parameter's rows through bind, which the write front end restates with its correlation
 * explicit (`WriteFrontend.restated`). Its statement carries both forms: the LATERAL form, which
 * reads k index entries of Entry per parent, and the whole-relation form, which ranks every group of Entry in one
 * pass. An application with at most the choice's threshold of distinct parents sends the LATERAL form, one with more
 * the whole-relation form.
 *
 * The schema is installed and loaded with many accounts of many entries each, and analyzed. Each drawn parent set is
 * bound through the program (`bindWrite`), and the form it sends is run under EXPLAIN ANALYZE in a
 * transaction that is rolled back. The plan's contract, not its text: for a small set, Entry is read by index only and
 * at most k + 1 rows per parent; for a large one, in one scan, once. The rows the insert returns are, in both forms, the
 * first two entries of each named account, which the loaded facts fix. db.explain explains the form an application
 * sends: the whole-relation form ranks Entry's rows (a WindowAgg node, row_number) and the LATERAL form does not. */
const Account = relation("Account", { id: uuid }, ["id"])
const Entry = relation("Entry", { account: uuid, seq: pg.bigint, amount: pg.bigint }, [
	"account",
	"seq"
])

const Latest = relation("Latest", { account: uuid, seq: pg.bigint, amount: pg.bigint }, [
	"account",
	"seq"
])
const build = (name: string) => schema(name, { Account, Entry, Latest }, [])

const accounts = 2000
const entriesPerAccount = 30

/** A deterministic uuid of account `n`. */
const uid = (n: number): Uuid =>
	`00000001-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const uidSql = (n: string): string =>
	`('00000001-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`

type FormFeature = "the LATERAL form for few parents" | "the whole-relation form for many parents"

/** The scans of `relation` in a plan that ran: every node that reads its rows (a Bitmap Index Scan only yields TIDs). */
const scansOf = (plan: PlanNode, relation: string): ReadonlyArray<PlanNode> =>
	findNodes(
		plan,
		(n) => Option.contains(n.relation, relation) && n.nodeType !== "Bitmap Index Scan"
	)

/** Rows a plan that ran read from `relation`, over every loop of every scan: output plus what filters removed. */
const rowsReadOf = (plan: PlanNode, relation: string): number =>
	Arr.reduce(
		scansOf(plan, relation),
		0,
		(sum, n) =>
			sum + (n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck) * n.actualLoops
	)

/** Whether a plan ranks rows: a WindowAgg node, the whole-relation form's row_number. */
const ranked = (plan: Plan): boolean => plan.node === "WindowAgg" || Arr.some(plan.children, ranked)

layer(Substrate.layer, { excludeTestServices: true })(
	"a write's take over a relation parameter",
	(it) => {
		it.effect(
			"sends its LATERAL form for few parents and its whole-relation form for many",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const o = yield* installed(build("Takes"), {}, { label: "takeform", extensions: [] })
						const S = o.schema
						const names = o.installed.installation.names
						const reality = realityWrite(
							succeeded(
								testArtifacts(S, {
									installation: o.installed.installation.settings.installation,
									vectorSchema: undefined,
									codes: installedCodes(names.codes)
								})
							)
						)
						const table = (r: string) => printObjectName(names.relation(r))
						const column = (r: string, f: string) => quoteIdent(names.column(r, f))
						yield* transaction(s.admin, [
							`INSERT INTO ${table("Account")} (${column("Account", "id")}) SELECT ${uidSql("g")} FROM pg_catalog.generate_series(0, ${accounts - 1}) AS g`,
							`INSERT INTO ${table("Entry")} (${Arr.join(
								Arr.map(["account", "seq", "amount"], (f) => column("Entry", f)),
								", "
							)}) ` +
								`SELECT ${uidSql(`g % ${accounts}`)}, (g / ${accounts})::int8, (g % 53)::int8 FROM pg_catalog.generate_series(0, ${accounts * entriesPerAccount - 1}) AS g`
						])
						yield* s.admin.query(
							`VACUUM (ANALYZE) ${Arr.join(Arr.map(["Account", "Entry", "Latest"], table), ", ")}`,
							[]
						)

						const firstTwo = query(S)
							.rule((r) => {
								const { seq, amount } = v(Entry, "entry")
								return r
									.match(Entry, { account: r.param("account", Entry.fields.account), seq, amount })
									.find({ seq, amount })
							})
							.orderBy(["seq", "asc"])
							.take(2)
						const latest = ChangeSet.empty(S).insert(
							Latest,
							query(S).rule((r) => {
								const named = r.relation("accounts", { id: Account.fields.id })
								const { id: account } = v(Account, "account")
								const top = firstTwo.bind({ account })
								const { seq, amount } = v(top, "top")
								return r
									.match(named, { id: account })
									.match(top, { seq, amount })
									.find({ account, seq, amount })
							})
						)
						const desc = changeSetDesc(latest)
						if (desc === undefined) {
							throw new Error("no ChangeSet")
						}
						const program = succeeded(
							compileWrite(checking(S), desc, reality),
							"the ChangeSet compiles"
						)
						const artifact = program.artifacts.optimized
						const found = Arr.findFirst(artifact.statements, (st) => st.step.kind === "write")
						if (Option.isNone(found)) {
							throw new Error("no insert statement")
						}
						const insert = found.value
						const forms = insert.forms
						if (forms.kind !== "chosen") {
							return assert.fail(`the insert's take is a per-execution choice, not ${forms.kind}`)
						}
						const threshold = Arr.reduce(
							Arr.map(forms.choices, (c) => c.threshold),
							Number.POSITIVE_INFINITY,
							(least, x) => Math.min(least, x)
						)
						const entry = names.relation("Entry").name
						const account = int(0, accounts - 1)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.server.roles.app, {})
							return yield* explore(
								{
									suite: "pg/write/take-form",
									/** Few parents and more than the threshold, each half of the drawn cases. */
									draw: drawn(
										oneOf([
											uniqueArray(account, (n) => n, { min: 1, max: 8 }, 10),
											uniqueArray(
												account,
												(n) => n,
												{ min: threshold + 1, max: threshold + 200 },
												10
											)
										])
									),
									literal: Formatter.format,
									coverage: required<FormFeature>(
										[
											"the LATERAL form for few parents",
											"the whole-relation form for many parents"
										],
										{ cases: 12, sense: notesOnly }
									),
									kept: [],
									runs: 12,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 16,
									caseHang
								},
								(parents, c) =>
									Effect.gen(function* () {
										const bound = bindWrite(program, {
											members: new Map(),
											params: { accounts: Arr.map(parents, (n) => ({ id: uid(n) })) },
											transport: inForce(bindFrame)
										})
										if (!bound.ok || bound.value.kind !== "bound") {
											throw new Error("the parameters bind")
										}
										const sent = bound.value.form(insert)
										const texts = succeeded(bound.value.values(insert), "the texts encode")
										const ran = yield* Effect.scoped(
											Effect.gen(function* () {
												const pinned = yield* s.admin.pin
												yield* pinned.query("BEGIN", [])
												const explained = yield* pinned.queryValues(
													explainStatementWith(sent.sql, {
														serialize: { kind: "off" },
														wal: false
													}),
													texts
												)
												yield* pinned.query("ROLLBACK", [])
												yield* pinned.query("BEGIN", [])
												const rows = yield* pinned.queryValues(sent.sql, texts)
												yield* pinned.query("ROLLBACK", [])
												return {
													plan: succeeded(parsePlan(explained[0]?.[0]), "one plan").plan,
													rows
												}
											})
										)
										/** The insert returns each fact it made present: the first two entries of each named account. */
										const returned = Arr.map(ran.rows, (row) => [row[0], row[1]] as const)
										unorderedEqual(
											returned,
											Arr.flatMap(parents, (n) => [[uid(n), "0"] as const, [uid(n), "1"] as const]),
											"the first two entries of each named account"
										)
										const scans = scansOf(ran.plan, entry)
										/** db.explain plans the insert as the application sends it. */
										const explained = yield* db.explain(latest, {
											accounts: Arr.map(parents, (n) => ({ id: uid(n) }))
										})
										const ranks = Arr.some(explained, (plan) => ranked(plan))
										if (parents.length <= threshold) {
											assert.equal(
												ranks,
												false,
												"db.explain plans the LATERAL form for few parents"
											)
											assert.equal(sent.sql, insert.spec.sql, "few parents send the LATERAL form")
											assert.deepEqual(
												Arr.filter(scans, (n) => n.nodeType === "Seq Scan"),
												[],
												"the LATERAL form reads Entry by index only"
											)
											assert.ok(
												rowsReadOf(ran.plan, entry) <= 3 * parents.length,
												`${rowsReadOf(ran.plan, entry)} entries read for ${parents.length} parents`
											)
											c.note("the LATERAL form for few parents")
										} else {
											assert.equal(
												sent.sql,
												forms.large.sql,
												"many parents send the whole-relation form"
											)
											assert.equal(
												ranks,
												true,
												"db.explain plans the whole-relation form for many parents"
											)
											assert.deepEqual(
												Arr.map(scans, (n) => n.actualLoops),
												[1],
												"the whole-relation form reads Entry in one scan, once"
											)
											c.note("the whole-relation form for many parents")
										}
									})
							)
						}).pipe(
							(body) =>
								Effect.flatMap(Layer.build(o.layer), (context) =>
									Effect.provideContext(body, context)
								),
							Effect.scoped
						)
					})
				)
		)
	}
)
