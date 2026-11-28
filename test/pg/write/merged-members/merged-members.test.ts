/**
 * A stratum's sources of one operation on one relation are one action over their union (write/frontend/compile.ts), on
 * PostgreSQL 19: a stratum whose inserts stamp a clock, metis's `ChangeSet.union(qti.enterTest, firstBudget)`, its
 * budgets from two queries or more, or from queries beside host rows, and its notes deleted by two queries, is one
 * statement (write/schedule/plan.ts realizationOf), which stamps the clock once, each child's moment and its budgets at
 * one instant, where each source was an action of its own, the stratum statement after statement and refused as
 * stamping the clock in several statements (write/frontend/instants.ts refuseStampedStatements).
 *
 * Schema: Moment(child, at) keyed (child, at), its at a clock of child `child` (qti's TestMoment); Budget(child, k,
 * remaining, at) keyed (child, k), its at a reference Moment's clock stamps at its child (qti's TestBudget); and Old(child,
 * at, n) keyed (child, at), its at a reference to a stored moment, so a delete of its facts compares the instant of its
 * key. Stored: three moments, a note at each, and one budget, at child 1's first moment.
 *
 * The box, exhausted: Budget's sources two queries, three, or two queries beside host rows; their facts disjoint, one
 * fact two of them give, two facts of one key from two of them, Budget's stored fact again, or another fact at its
 * key. Each case's one
 * stratum also inserts a moment of each of two children from host rows, deletes Old's notes of two ns by two queries
 * and reads back the moments it added. Each case installs the schema on a clone of its own, stores the state and applies the write once.
 *
 * Property, per case: the write's program is one write statement, a single statement writing Moment, Budget and Old
 * once each, which the read-back of the moments it added rides; and the outcome and the state after it are the model's (merged-members.fixtures.ts modelOf), the stratum's
 * meaning S' = (S \ D) ∪ A over its one snapshot: where its sources hold two facts at one key, or one at the key Budget
 * stores that differs at a field it states, it is refused on Budget's primary key's law and the state is the stored
 * one; otherwise it is accepted, each child has one new moment, Budget holds the stored budget and each other fact the
 * sources give once, at its child's new moment, the instant stamped once, and Old holds its notes but the deletes'. Oracle: specification, the model. Kills:
 * each query its own action, as before the merge, so every case's write does not compile; and a head its call already
 * advanced advanced again, so Moment's stamp and Budget's reference to it take two instants.
 *
 * Features: each shape of sources, and each way their facts meet.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import {
	attemptLabel,
	installWrites,
	observedChange,
	openFull,
	owner,
	ownerTransaction
} from "#bench/write/support/writes.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	Budget,
	build,
	children,
	deletedNs,
	mergedGen,
	modelOf,
	Moment,
	Old,
	paramsOf,
	type Situation,
	situations,
	storedBudget,
	storedMoments,
	storedOld,
	writeOf
} from "#test/pg/write/merged-members/merged-members.fixtures.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A stratum's sources of one operation on one relation are one action, so a stratum that stamps a clock is one statement, writing its sources' union at one instant. */
export const aStratumsSourcesOfOneOperationOnOneRelationAreOneActionSoAStratumThatStampsAClockIsOneStatementWritingTheirUnionAtOneInstant =
	property.exhaust(finite(mergedGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, k: Case<Situation>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							k.note(c.members)
							k.note(c.overlap)
							const s = yield* Substrate
							const fixture = build("MergedMembers")
							/** The installation's login's workload holds the case's write, so it holds every index the write reads
							 * through, Old's notes by their n among them, as generate plans an application's. */
							const fx = yield* installWrites(fixture, "mergedmembers", {
								programs: { write: writeOf(fixture, c) },
								logins: () => []
							})
							const S = build(fx.installed.declared)
							const names = namesOf(fx.installed)
							const column = (r: typeof Moment | typeof Budget | typeof Old, field: string) =>
								quoteIdent(names.columnIdent(r, field))
							for (const [child, at] of storedMoments) {
								yield* ownerTransaction([
									`SELECT FROM ${names.stampCall(Moment, "at", [`${child}`], at)}`,
									`INSERT INTO ${names.table(Moment)} (${column(Moment, "child")}, ${column(Moment, "at")}) VALUES (${child}, ${at})`
								])
							}
							yield* owner(
								`INSERT INTO ${names.table(Old)} (${column(Old, "child")}, ${column(Old, "at")}, ${column(Old, "n")}) VALUES ${Arr.join(
									Arr.map(storedOld, ([child, at, n]) => `(${child}, ${at}, ${n})`),
									", "
								)}`,
								`INSERT INTO ${names.table(Budget)} (${column(Budget, "child")}, ${column(Budget, "k")}, ${column(Budget, "remaining")}, ${column(Budget, "at")}) VALUES (${storedBudget[0]}, ${storedBudget[1]}, ${storedBudget[2]}, ${storedBudget[3]})`
							)
							/** A relation's stored rows, each field as text, joined by " | ", sorted. */
							const rowsOf = (
								r: typeof Moment | typeof Budget | typeof Old,
								fields: ReadonlyArray<string>
							) =>
								Effect.map(
									s.admin.queryValues(
										`SELECT ${Arr.join(
											Arr.map(fields, (f) => `${column(r, f)}::text`),
											", "
										)} FROM ${names.table(r)}`,
										[]
									),
									(rows) =>
										Arr.sort(
											Arr.map(rows, (row) => Arr.join(Arr.map(row, String), " | ")),
											Order.String
										)
								)
							const momentsOf = rowsOf(Moment, ["child", "at"])
							const budgetsOf = rowsOf(Budget, ["child", "k", "remaining", "at"])
							const oldOf = rowsOf(Old, ["child", "at", "n"])
							const before = {
								moments: yield* momentsOf,
								budgets: yield* budgetsOf,
								old: yield* oldOf
							}
							const db = yield* openFull(fx, S)
							const observed = yield* observedChange(db, writeOf(S, c), attemptLabel, {
								kind: "none"
							})
							const writes = Arr.filter(
								observed.statements,
								(st) =>
									st.label.kind === "write" ||
									st.label.kind === "single" ||
									st.label.kind === "readBack"
							)
							const [only, ...more] = writes
							assert.ok(
								only !== undefined && more.length === 0 && only.label.kind === "single",
								`the write is one single statement, not ${Formatter.format(Arr.map(writes, (st) => st.label))}`
							)
							assert.deepEqual(
								Arr.sort(
									Arr.map(only.label.parts, (p) => `${p.result.kind} ${p.relation}`),
									Order.String
								),
								["delete Old", "insert Budget", "insert Moment"],
								"the statement writes Moment, Budget and Old once each"
							)
							const applied = yield* observed.apply(paramsOf(c))
							const outcome = applied.value
							const after = {
								moments: yield* momentsOf,
								budgets: yield* budgetsOf,
								old: yield* oldOf
							}
							const model = modelOf(c)
							if (model.kind === "refused") {
								assert.ok(
									outcome.kind === "invariant-rejected",
									`two facts of one Budget key refuse the call, not ${outcome.kind}`
								)
								assert.deepEqual(
									Arr.map(refusedEntries(outcome.refused), (l) => l.id),
									[lawNamesOf(S).primaryKeyLaw(Budget)],
									"the refusal names Budget's primary key's law"
								)
								assert.deepEqual(after, before, "a refused call leaves the stored state")
								return
							}
							assert.ok(outcome.kind === "accepted", `the call is accepted, not ${outcome.kind}`)
							assert.equal(
								outcome.reads["entered"]?.length,
								children.length,
								"the moments it added read back from the statement that adds them"
							)
							const fresh = Arr.filter(after.moments, (m) => !before.moments.includes(m))
							const instants = new Map(
								Arr.map(fresh, (m) => {
									const [child, at] = Str.split(m, " | ")
									return [defined(child, "a moment's child"), defined(at, "a moment's at")] as const
								})
							)
							assert.deepEqual(
								Arr.sort([...instants.keys()], Order.String),
								Arr.map(children, String),
								`one new moment of each child: ${Formatter.format(fresh)}`
							)
							assert.equal(instants.size, fresh.length, "each child's moment is stamped once")
							assert.deepEqual(
								after.budgets,
								Arr.sort(
									[
										...before.budgets,
										...Arr.map(
											model.budgets,
											(b) =>
												`${b.child} | ${b.k} | ${b.remaining} | ${defined(instants.get(String(b.child)), "the child's new moment")}`
										)
									],
									Order.String
								),
								"Budget holds the stored budget and each fact its sources give once, at its child's new moment"
							)
							assert.deepEqual(
								after.old,
								Arr.filter(
									before.old,
									(o) => !Arr.some(deletedNs, (n) => Str.endsWith(` | ${n}`)(o))
								),
								"Old holds its notes but those the deletes name"
							)
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the stratum's meaning over its one snapshot (merged-members.fixtures.ts modelOf), in one statement"
		},
		box: "Budget's sources two queries, three, or two beside host rows, their facts disjoint, shared, two at one key, the stored fact again or another at its key, beside a moment of each of two children from host rows and two deletes of Old by query",
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\t\t\t\tconst group = headed.find((g) => sameHeading(g.heading, heading))\n",
				replacement: "\t\t\t\t\tconst group = headed.find(() => false)\n",
				why: "Each query of an operation on a relation is its own action, as before the merge: Budget's queries are two actions of one relation, the stratum runs statement after statement, and its write is refused as stamping Moment.at in several statements."
			},
			{
				file: "packages/engine/src/physical/ddl/stamps.ts",
				original:
					'\t\twhens: [{ when: binary("=", col(held, headStamper), thisTransaction), result: col(held, at) }],\n',
				replacement:
					'\t\twhens: [{ when: binary("=", col(held, headStamper), thisTransaction), result: stepped }],\n',
				why: "A head its own call already advanced is advanced again (physical/ddl/stamps.ts): the statement's two stamps of Moment's clock, Moment's own and Budget's reference to it, take two instants, so each budget names no moment of its child and Budget's containment in Moment refuses the call."
			}
		]
	})
