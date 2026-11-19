/**
 * Rules over queries on PostgreSQL 19rc2: a rule whose side reads a derived relation holds at every COMMIT, judged on
 * its definition, live, whoever writes and however writes interleave.
 *
 * The schema joins two and three relations, selects, projects and negates: J2 = R ⋈ S on k, J3 = J2 ⋈ U on (a, b), the
 * semijoin Semi = R ⋉ S on k projected on R's id and k, the self-join Self of R's rows of one k whose a is below
 * another's, and the anti-join Lonely of R's rows no S row shares a k with. Its rules are a containment of a
 * two-relation query in a table, of a table in a three-relation query, of a semijoin in a table, of a self-join in a
 * table, of a selection of a query in a table, and of the anti-join in a table and a table in the anti-join (so V holds
 * exactly Lonely's ids, and both an S row's insert and its delete can break one), a key over a query and a check over a
 * three-relation query: every rule kind, with a query on either side of a containment.
 *
 * Four more negate what is no table: Unpaired, R's rows whose k no S row joined with a U row on b shares (a negated
 * join); Unlisted, R's rows whose k neither an S row whose b is 1 nor a W row holds (a negated union of two rules);
 * Quiet, R's rows whose a is not 2 and whose k no W row shares (a negation inside a conjunction); and Unused, on a level
 * above, U's rows whose a no fact of J2 holds (a negated derived relation). N marks each one's rows under a code of its
 * own, contained in it both ways, so an insert into a table it negates breaks the mark of a row it withdraws and a
 * delete breaks the absent mark of a row it brings back, on every table of each negated join.
 *
 * - **The specification turned into a checker:** each rule restated over the rows, a host model of R, S, U, T, W, V and
 *   N that evaluates every derived relation itself and judges every rule over the state a transaction leaves. A
 *   transaction commits exactly when the state it leaves keeps every rule. A direct SQL writer's refusal is at COMMIT,
 *   SQLSTATE 23503 for a containment, 23505 for the key and 23514 for the check, naming a trigger the installation's
 *   constraint map maps to a rule the model judges broken, the check's under the name constraintNamesOf gives its rule;
 *   grizzle's served write answers `invariant-rejected`, naming rules the model judges broken, its witness `unreported`.
 * - **Concurrent writers:** after its serial history, each case opens two direct SQL transactions at SERIALIZABLE, each
 *   taking its snapshot, commits a ChangeSet through grizzle's served write while both are open, then runs both SQL
 *   writers' statements, both open before either commits, and reads every table back: the state committed keeps every
 *   rule, whichever of them PostgreSQL refused, by a rule or by a serialization failure.
 * - **The judge's session:** the installation holds every rule by the set judge (physical/ddl/rules.ts addRules): each
 *   statement's rows captured into the session's deltas, every rule's probes run over them at COMMIT. After each
 *   transaction, the writer's session holds no row in any table of its own pg_temp, a delta's or the sentinel's.
 * - **SET CONSTRAINTS ALL IMMEDIATE:** a direct SQL transaction may issue it at a drawn place among its writes. The
 *   state at that point and after every statement from it on must keep every rule, or the transaction is refused at the
 *   first statement that leaves a broken state; past it, the judge runs after each statement and must arm again.
 * - **A login's own pg_temp tables (a tamper):** a transaction of the installation's full-world login, after a
 *   judged write it committed and a DISCARD TEMP, creates a table of its own under the name of every delta the judge's
 *   captures write, grants it to the judge's definer, writes, and empties each before COMMIT. A write the judge captures
 *   is then refused with insufficient_privilege, and the state is as before. A tamper whose writes the judge captures
 *   none of (an insert into a table only a target reads) commits only where the state it leaves keeps every rule.
 *
 * Each case draws a history of transactions, by direct SQL or by grizzle, from coherent clusters (an R, S, U, T and W
 * row that keep every rule together), lonely rows (an R row with its V row), single inserts, deletes and, by SQL,
 * updates of drawn rows, the unwinding of a J3 fact, which deletes every row of its derivation from R, S and U in one
 * transaction while W may still need it, and the end of a lonely row, which deletes it and inserts an S row of its k in
 * one transaction while V may still hold its id: the two situations a target probe's relaxation exists for, which the
 * search requires. A lonely row and a single insert come with or without the marks they move, and the end of a lonely
 * row always with them, so a marked lonely row keeps every rule and its end, alone in its k, breaks vLonely alone. A
 * direct SQL transaction may also set savepoints and roll back to the latest, update a W row's note, which no rule
 * reads, and insert several clusters at once, each of which may omit its T or its W row, so none, one or several of
 * them break source2 or semi. A
 * transaction may also mark a negation's rows as they stand at that point (a sync), mark a picked row of one, remove a
 * picked mark, or list the k of a marked row of Unlisted no S row shares: an S row whose b is 1 and a W row of its k
 * inserted at once, each blocking the row through a negated arm of its own, with the rows every other rule then needs
 * and every other negation's marks synced, so the row's stale mark is the one rule the state breaks. Beside the drawn
 * histories, two are constructed, each from a state that keeps every rule to a last transaction of one edit: the
 * pairing of a marked row of Unpaired whose k an S row already holds, a U row of that S row's b, at the row's a,
 * inserted alone, which withdraws the row from Unpaired through U, the second table of its negated join, while the U
 * row meets a fact of J2 and the J3 fact it adds is no (2, 2); and the unpairing of a k, its one S row, the only S row
 * of its b, and the U rows of that b deleted at once, with the k's W rows, each R row of the k given a V row and every
 * other negation's marks synced, so the k's R rows come back to Unpaired unmarked. Each breaks one rule alone: the
 * paired row's stale mark, and the returned rows' missing marks. The search requires the listing, the pairing and the
 * unpairing refused: a probe that kept the target arm's other negations read the listing through neither insert, only a
 * probe of U reads the pairing, and only a probe that drops the negated arm's match after the held one reads the
 * unpairing, since each deleted row's other is gone at COMMIT. A drawn history reaches the listing rarely and never the
 * other two, so each has a history constructed to reach it (constructed), which a witness whose turn aims at it draws
 * (aimed).
 */

import { defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { printType } from "#compiler/sql/print.ts"
import { cleared } from "#test/pg/fin/installed.ts"
import {
	aims,
	alone,
	broken,
	caseGen,
	codeOf,
	Disagreed,
	emptyState,
	expectedOf,
	type Feature,
	forms,
	heldSessionRows,
	judgedIn,
	judgedTemplate,
	insufficientPrivilege,
	j3,
	Keys,
	lonely,
	negated,
	type Op,
	readState,
	RELATIONS,
	resolve,
	type Resolved,
	type Rule,
	ruleOf,
	rules,
	serializationFailure,
	type State,
	unchanged
} from "#test/pg/laws/rule-query.fixtures.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { attempt, momentText, refusalOf, refusalText, sameMoment } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Rules over queries on PostgreSQL 19rc2 commit exactly the histories whose every state keeps every rule over a query, refusing the rest by the broken rule's name, at COMMIT or at the first statement past SET CONSTRAINTS ALL IMMEDIATE that breaks one, and commit no broken state under concurrent writers or a login's own pg_temp tables.
 *
 * Its pre-conversion budget: runs 120, coverage cases 200 (test/pg/laws/rule-query.test.ts at d8eed1786).
 */
export const rulesOverQueriesOnPostgreSQL19rc2CommitExactlyTheHistoriesWhoseEveryStateKeepsEveryRuleOverAQueryRefusingTheRestByTheBrokenRulesNameAtCOMMITOrAtTheFirstStatementPastSETCONSTRAINTSALLIMMEDIATEThatBreaksOneAndCommitNoBrokenStateUnderConcurrentWritersOrALoginsOwnPgTempTables =
	property.explore(aimed(caseGen, aims), {
		needs: { judged: Substrate.seat(judgedTemplate) },
		situations: [
			"committed",
			"committed a J3 fact",
			"committed a lonely row",
			...Arr.map(forms, (f) => `committed a row of ${f}` as const),
			...Arr.map(rules, (r) => `refused by ${r}` as const),
			"a fact unwound across tables while W needs it",
			"a lonely row deleted and blocked at once while V needs it",
			"a marked row listed through both negations of its arm at once",
			"a marked row paired through its negated join's second table alone",
			"a row brought back to Unpaired by an S row and its U rows deleted at once",
			"a grizzle write committed",
			"a grizzle write refused by a rule",
			"refused at a statement past SET CONSTRAINTS ALL IMMEDIATE",
			"committed past SET CONSTRAINTS ALL IMMEDIATE",
			"a write rolled back to a savepoint",
			"a note no rule reads updated",
			"clusters with none omitting a row",
			"clusters with one omitting a row",
			"clusters with several omitting a row",
			"a tamper refused",
			"a tamper whose writes break a rule refused",
			"concurrent writers all committed",
			"concurrent writer refused",
			"concurrent writer refused by a serialization failure"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ judged }, c: Case<Feature>) =>
			(rc) =>
				Effect.flatMap(judged, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const u = yield* judgedIn(taken, "rule_query")
							const definer = yield* Effect.map(
								u.seat.session.values(
									"SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure($1)",
									[u.judge]
								),
								(rows) => String(defined(rows[0], "the judge's owner")[0])
							)

							yield* cleared(u.seat, RELATIONS)
							const keys = new Keys()
							let state: State = emptyState
							const committed = (after: State): void => {
								state = after
								c.note("committed")
								if (j3(state).length > 0) {
									c.note("committed a J3 fact")
								}
								if (lonely(state).length > 0) {
									c.note("committed a lonely row")
								}
								const rows = negated(state)
								for (const f of forms) {
									if (rows[f].length > 0) {
										c.note(`committed a row of ${f}`)
									}
								}
							}
							/** The situations a refused transaction reached, by the rules the state it leaves breaks. */
							const refusalNotes = (
								ops: ReadonlyArray<Op>,
								t: Resolved,
								breaks: ReadonlyArray<Rule>,
								needed: boolean
							): void => {
								if (needed && breaks.includes("target3")) {
									c.note("a fact unwound across tables while W needs it")
								}
								if (t.withdrawn.length > 0 && breaks.includes("vLonely")) {
									c.note("a lonely row deleted and blocked at once while V needs it")
								}
								if (t.listed.length > 0 && breaks.length === 1 && breaks.includes("nUnlisted")) {
									c.note("a marked row listed through both negations of its arm at once")
								}
								for (const situation of alone(ops, t, breaks)) {
									c.note(situation)
								}
							}
							const clusterNotes = (t: Resolved): void => {
								for (const cs of t.clusters) {
									const omitting = Arr.filter(cs, (x) => x.omit !== "none").length
									c.note(
										omitting === 0
											? "clusters with none omitting a row"
											: omitting === 1
												? "clusters with one omitting a row"
												: "clusters with several omitting a row"
									)
								}
							}
							for (const tx of rc.history) {
								const t = resolve(tx.ops, state, keys, u.seat.table)
								const breaks = broken(t.after)
								const needed = Arr.some(t.unwound, (k) =>
									Arr.some([...state.W.values()], (w) => w.k === k)
								)
								if (tx.writer === "tamper") {
									const w = u.writer
									const arming = yield* attempt(w, [`DELETE FROM ${u.seat.table("R")} WHERE false`])
									yield* w.query("DISCARD TEMP", [])
									for (const d of u.deltas) {
										yield* w.query(
											`CREATE TEMPORARY TABLE pg_temp.${quoteIdent(d.name)} (${Arr.join(
												Arr.map(
													d.columns,
													(col) => `${quoteIdent(col.name)} ${printType(col.type)}`
												),
												", "
											)})`,
											[]
										)
										yield* w.query(
											`GRANT ALL ON pg_temp.${quoteIdent(d.name)} TO ${quoteIdent(definer)}`,
											[]
										)
									}
									const verdict = yield* attempt(w, [
										...t.statements,
										...Arr.map(u.deltas, (d) => `DELETE FROM pg_temp.${quoteIdent(d.name)}`)
									])
									yield* w.query("DISCARD TEMP", [])
									if (arming.kind !== "committed") {
										return yield* new Disagreed({
											message: `a tamper's judged write, which writes nothing, was refused ${momentText(arming.moment)} by ${refusalText(arming.fields)}`
										})
									}
									if (verdict.kind === "refused") {
										if (verdict.fields.code !== insufficientPrivilege) {
											return yield* new Disagreed({
												message: `a tamper over the judge's deltas was refused ${momentText(verdict.moment)} by ${refusalText(verdict.fields)}, where a write the judge captures into a login's table must be refused ${insufficientPrivilege}: ${Formatter.format(t.statements)}`
											})
										}
										c.note("a tamper refused")
										if (breaks.length > 0) {
											c.note("a tamper whose writes break a rule refused")
										}
										clusterNotes(t)
										continue
									}
									if (breaks.length > 0) {
										return yield* new Disagreed({
											message: `a tamper over the judge's deltas committed a state breaking ${Arr.join(breaks, ", ")}: ${Formatter.format(t.statements)}`
										})
									}
									committed(t.after)
									continue
								}
								if (tx.writer === "grizzle") {
									const outcome = yield* u.write(state, t.after)
									if (outcome.kind === "accepted" || outcome.kind === "unchanged") {
										if (
											breaks.length > 0 ||
											(outcome.kind === "unchanged") !== unchanged(state, t.after)
										) {
											return yield* new Disagreed({
												message: `grizzle's write answered ${outcome.kind} where the state it leaves breaks ${Arr.join(breaks, ", ") || "nothing"}: ${Formatter.format(tx.ops)}`
											})
										}
										committed(t.after)
										c.note("a grizzle write committed")
										continue
									}
									const named =
										outcome.kind === "refused" ? Arr.map(refusedLaws(outcome.refused), ruleOf) : []
									const broke = (r: Rule | undefined): boolean =>
										r !== undefined && breaks.includes(r)
									if (
										outcome.kind !== "refused" ||
										outcome.witness.kind !== "unreported" ||
										!(outcome.refused.kind === "some"
											? Arr.some(named, broke)
											: Arr.isReadonlyArrayNonEmpty(named) && Arr.every(named, broke))
									) {
										return yield* new Disagreed({
											message: `grizzle's write answered ${Formatter.format(outcome)} where the state it leaves breaks ${Arr.join(breaks, ", ") || "nothing"}: ${Formatter.format(tx.ops)}`
										})
									}
									for (const r of named) {
										if (broke(r)) {
											c.note(`refused by ${defined(r, "a rule the refusal names")}`)
										}
									}
									c.note("a grizzle write refused by a rule")
									refusalNotes(tx.ops, t, breaks, needed)
									continue
								}
								const expected = expectedOf(t)
								const verdict = yield* attempt(u.seat.session, t.statements)
								if (verdict.kind === "committed") {
									if (expected.kind !== "committed") {
										return yield* new Disagreed({
											message: `committed where it must be refused ${momentText(expected.moment)} by ${Arr.join(expected.breaks, ", ")}: ${Formatter.format(t.statements)}`
										})
									}
								} else {
									const rule = u.refusedRule(verdict.fields)
									if (
										expected.kind !== "refused" ||
										rule === undefined ||
										!expected.breaks.includes(rule) ||
										verdict.fields.code !== codeOf(rule) ||
										(rule === "check3" && verdict.fields.constraint !== u.checkName) ||
										!sameMoment(verdict.moment, expected.moment)
									) {
										return yield* new Disagreed({
											message: `refused ${momentText(verdict.moment)} by ${refusalText(verdict.fields)} (rule ${rule ?? "none"}), where it must be ${expected.kind === "committed" ? "committed" : `refused ${momentText(expected.moment)} by ${Arr.join(expected.breaks, ", ")}`}: ${Formatter.format(t.statements)}`
										})
									}
									c.note(`refused by ${rule}`)
								}
								const held = yield* heldSessionRows(u.seat.session)
								if (held.length > 0) {
									return yield* new Disagreed({
										message: `the writer's session holds rows of ${Arr.join(held, ", ")} after its transaction ended: ${Formatter.format(t.statements)}`
									})
								}
								if (expected.kind === "committed") {
									committed(t.after)
								} else if (expected.moment.kind === "commit") {
									refusalNotes(tx.ops, t, expected.breaks, needed)
								}
								if (t.immediate.length > 0) {
									c.note(
										expected.kind === "refused" && expected.moment.kind === "statement"
											? "refused at a statement past SET CONSTRAINTS ALL IMMEDIATE"
											: expected.kind === "committed"
												? "committed past SET CONSTRAINTS ALL IMMEDIATE"
												: "committed"
									)
								}
								if (expected.kind === "committed" && t.rolledBack) {
									c.note("a write rolled back to a savepoint")
								}
								if (expected.kind === "committed" && t.renoted) {
									c.note("a note no rule reads updated")
								}
								clusterNotes(t)
							}
							const a = resolve(rc.concurrent.first, state, keys, u.seat.table)
							const b = resolve(rc.concurrent.second, state, keys, u.seat.table)
							const g = resolve(rc.concurrent.grizzle, state, keys, u.seat.table)
							const run = (session: RawSession, statements: ReadonlyArray<string>) =>
								Effect.gen(function* () {
									for (const sql of statements) {
										const refused = yield* refusalOf(session.query(sql, []))
										if (Option.isSome(refused)) {
											return refused
										}
									}
									return Option.none()
								})
							/**
							 * Each SQL writer takes its snapshot first, so grizzle's write commits while both are open and
							 * neither sees it; a writer that meets another's row lock gives up at once, so none waits on a
							 * commit that comes after it.
							 */
							const opening = ["SET LOCAL lock_timeout = '200ms'", "SELECT 1"]
							yield* u.seat.session.begin
							yield* u.second.begin
							const snapA = yield* run(u.seat.session, opening)
							const snapB = yield* run(u.second, opening)
							const grizzle = yield* u.write(state, g.after).pipe(
								Effect.map((outcome) =>
									outcome.kind === "accepted" || outcome.kind === "unchanged"
										? "committed"
										: "refused"
								),
								Effect.catchIf(
									(error) => error.kind === "transient",
									() => Effect.succeed("serialization" as const)
								)
							)
							const openA = Option.isSome(snapA) ? snapA : yield* run(u.seat.session, a.statements)
							const openB = Option.isSome(snapB) ? snapB : yield* run(u.second, b.statements)
							const commitA = Option.isSome(openA) ? openA : yield* refusalOf(u.seat.session.commit)
							if (Option.isSome(openA)) {
								yield* u.seat.session.rollback
							}
							const commitB = Option.isSome(openB) ? openB : yield* refusalOf(u.second.commit)
							if (Option.isSome(openB)) {
								yield* u.second.rollback
							}
							const now = yield* readState((sql) => u.seat.session.values(sql, []), u.seat.table)
							const after = broken(now)
							if (after.length > 0) {
								return yield* new Disagreed({
									message: `concurrent writers committed a state breaking ${Arr.join(after, ", ")}: ${Formatter.format([a.statements, b.statements, rc.concurrent.grizzle])}`
								})
							}
							const refusals = Arr.getSomes([commitA, commitB])
							c.note(
								refusals.length === 0 && grizzle === "committed"
									? "concurrent writers all committed"
									: "concurrent writer refused"
							)
							if (
								grizzle === "serialization" ||
								Arr.some(refusals, (f) => f.code === serializationFailure)
							) {
								c.note("concurrent writer refused by a serialization failure")
							}
						}),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "every rule restated over the rows: a transaction commits exactly when the state it leaves, and every state a statement past SET CONSTRAINTS ALL IMMEDIATE leaves, keeps every rule; a login's own pg_temp table under a delta's name is refused; and concurrent writers commit no state that breaks one"
		},
		budget: { runs: 120, steered: 200 },
		kept: [],
		kills: []
	})
