import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { variantOf } from "#adapter/db/handles.ts"
import { explainChange } from "#adapter/served/explain.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { explainStatementWith, parsePlan } from "#bench/harness/explain.ts"
import { lateralParentMax } from "#compiler/lower/shapes/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	Account,
	Entry,
	type FormFeature,
	Latest,
	parentsGen,
	ranked,
	rowsReadOf,
	scansOf,
	Takes,
	takesInstall,
	takesTemplate,
	taken,
	uid
} from "#test/pg/write/take-form/take-form.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * A write's take over a relation parameter's rows chooses its form per application, by the same rule a query's does
 * (`runsLargeForm`, `sentForm`).
 *
 * The ChangeSet inserts, into Latest, the first two Entry facts by seq of every account a relation parameter names: a
 * take correlated with the parameter's rows through bind, which the write front end restates with its correlation
 * explicit (`WriteFrontend.restated`). Its statement carries both forms: the LATERAL form, which
 * reads k index entries of Entry per parent, and the whole-relation form, which ranks every group of Entry in one
 * pass. An application with at most the choice's threshold of distinct parents sends the LATERAL form, one with more
 * the whole-relation form.
 *
 * The schema is installed and loaded with many accounts of many entries each, and analyzed, once per member
 * (takesTemplate), each case on the worker's seat of it. The ChangeSet is a served
 * member of the app role's workload, and each drawn parent set is bound through its loaded program (`bindWrite`), as
 * its apply binds it, and the form it sends is run under EXPLAIN ANALYZE in a transaction that is rolled back. The
 * plan's contract, not its text: for a small set, Entry is read by index only and at most k + 1 rows per parent; for a
 * large one, in one scan, once. The rows the insert returns are, in both forms, the first two entries of each named
 * account, which the loaded facts fix. Its explain explains the form an application sends: the whole-relation form
 * ranks Entry's rows (a WindowAgg node over a read of Entry, row_number) and the LATERAL form does not.
 *
 * Features: the LATERAL form for few parents and the whole-relation form for many.
 *
 * Its pre-conversion budget: runs 12, coverage cases 12 (test/pg/write/take-form/take-form.test.ts at edabdcc5f).
 */
export const aWritesTakeSendsItsLateralFormForFewParentsAndItsWholeRelationFormForMany =
	property.explore(parentsGen, {
		needs: { takes: Substrate.seat(takesTemplate) },
		situations: [
			"the LATERAL form for few parents",
			"the whole-relation form for many parents"
		] satisfies ReadonlyArray<Reached<FormFeature>>,
		check:
			({ takes }, c: Case<FormFeature>) =>
			(parents) =>
				Effect.scoped(
					Effect.flatMap(takes, (seat) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const o = yield* openedIn(Takes, {}, takesInstall, seat)
								const S = o.schema
								const names = o.installed.installation.names
								const firstTwo = query(S)
									.rule((r) => {
										const { seq, amount } = v(Entry, "entry")
										return r
											.match(Entry, {
												account: r.param("account", Entry.fields.account),
												seq,
												amount
											})
											.find({ seq, amount })
									})
									.orderBy(["seq", "asc"])
									.take(taken)
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
								const entry = names.relation("Entry").name
								const { ctx, loadWithTables } = yield* openServedDb(
									o.installed,
									o.server.roles.app,
									{}
								)
								const { members, tables } = yield* loadWithTables({ latest })
								const loaded = member(members, "latest")
								if (loaded.kind !== "change") {
									throw new Error("no ChangeSet")
								}
								const change = variantOf(ctx, loaded.variants)
								const write = change.entry.program
								const found = Arr.findFirst(write.statements, (st) =>
									st.kind === "whole" && st.step.kind === "write" ? Option.some(st) : Option.none()
								)
								if (Option.isNone(found)) {
									throw new Error("no insert statement")
								}
								const insert = found.value
								const forms = insert.forms
								if (forms.kind !== "chosen") {
									return assert.fail(
										`the insert's take is a per-execution choice, not ${forms.kind}`
									)
								}
								const threshold = Arr.reduce(
									Arr.map(forms.choices, (choice) => choice.threshold),
									Number.POSITIVE_INFINITY,
									(least, x) => Math.min(least, x)
								)
								assert.equal(
									threshold,
									lateralParentMax,
									"the choice's threshold is lateralParentMax"
								)

								const bound = bindWrite(write, {
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
											explainStatementWith(sent.text.sql, {
												serialize: { kind: "off" },
												wal: false
											}),
											texts
										)
										yield* pinned.query("ROLLBACK", [])
										yield* pinned.query("BEGIN", [])
										const rows = yield* pinned.queryValues(sent.text.sql, texts)
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
									Arr.flatMap(parents, (n) => upTo(taken, (seq) => [uid(n), String(seq)] as const)),
									"the first two entries of each named account"
								)
								const scans = scansOf(ran.plan, entry)
								if (change.call.kind !== "params") {
									return assert.fail("a ChangeSet of no array member explains with its parameters")
								}
								/** Its explain plans the insert as the application sends it. */
								const explained = yield* explainChange(
									ctx,
									tables,
									change,
									change.call.call({ accounts: Arr.map(parents, (n) => ({ id: uid(n) })) })
								)
								const ranks = Arr.some(explained, (statement) => ranked(statement.plan))
								if (parents.length <= threshold) {
									assert.equal(ranks, false, "its explain plans the LATERAL form for few parents")
									assert.equal(sent.text, insert.form.text, "few parents send the LATERAL form")
									assert.deepEqual(
										Arr.filter(scans, (n) => n.nodeType === "Seq Scan"),
										[],
										"the LATERAL form reads Entry by index only"
									)
									assert.ok(
										rowsReadOf(ran.plan, entry) <= (taken + 1) * parents.length,
										`${rowsReadOf(ran.plan, entry)} entries read for ${parents.length} parents`
									)
									c.note("the LATERAL form for few parents")
								} else {
									assert.equal(
										sent.text,
										forms.large.text,
										"many parents send the whole-relation form"
									)
									assert.equal(
										ranks,
										true,
										"its explain plans the whole-relation form for many parents"
									)
									assert.deepEqual(
										Arr.map(scans, (n) => n.actualLoops),
										[1],
										"the whole-relation form reads Entry in one scan, once"
									)
									c.note("the whole-relation form for many parents")
								}
							}),
							Substrate,
							seat.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the choice's rule restated over the parents' count, and the loaded facts' first entries of each named account"
		},
		show: Formatter.format,
		budget: { runs: 12, steered: 12 },
		kept: [],
		kills: []
	})
