/**
 * A stamping insert reads its clock's head once per child it stamps, on PostgreSQL 19: an insert of Log's rows, Log(child,
 * at, note) keyed (child, at, note), its at a clock of child `child`, each row leaving at out, so the insert stamps
 * them all with `greatest(c, h + 1)` per child (write/insert/stamp.ts). The stamps are worked out over the input's
 * distinct children, so the head, the child's last row by the clock's primary key read backwards under LIMIT 1
 * (write/probe.ts probeGroup `last`), is probed once per child, however many of its rows the call writes.
 *
 * The box, exhausted: 1, 3 and 10 children, each with 1 and 4 rows in the call, over a stored head at each child or
 * none. Each case's write is applied once, its statements each under EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)
 * in its place, its transaction ended by ROLLBACK (bench/write/support/writes.ts explainedChange).
 *
 * Property, per case: the scans of Log under a LIMIT, the head's probe, run once per child in all, the loops of every
 * such scan summed over the write's statements; and every statement of the write passes the structural audit
 * (test/support/write-audit.ts). Oracle: the rule, one probe per child. Kill, applied by hand: the stamps' children read
 * without their DISTINCT, so the head is probed once per row, children × rows loops.
 *
 * Features: one child and several, one row a child and several, a stored head and none.
 */
import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { Formatter } from "effect"
import { planNodes } from "#bench/harness/explain.ts"
import { explainedChange, installWrites, openFull, owner } from "#bench/write/support/writes.ts"
import {
	build,
	Log,
	type Situation,
	situations,
	stampingGen,
	writeOf
} from "#test/pg/write/stamp-probes/stamp-probes.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { writeAuditViolations } from "#test/support/write-audit.ts"

/**
 * A stamping insert's head probes read the clock's head once per child, each case installing the schema on the
 * worker's clone, as each case of the search installed it.
 *
 * Its pre-conversion budget: the box, 12 cases (test/pg/write/stamp-probes/stamp-probes.test.ts at f6a7126a8).
 */
export const aStampingInsertsHeadProbesReadTheClocksHeadOncePerChild = property.exhaust(
	finite(stampingGen),
	{
		needs: { substrate: Substrate.installing },
		situations,
		check:
			({ substrate }, k: Case<Situation>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const fx = yield* installWrites(build("StampProbes"), "stampprobes", {
								programs: {},
								logins: []
							})
							const S = build(fx.installed.declared)
							const names = namesOf(fx.installed)
							if (c.head) {
								yield* owner(
									`INSERT INTO ${names.table(Log)} (${names.column(Log, "child")}, ${names.column(Log, "at")}, ${names.column(Log, "note")}) VALUES ${Arr.join(
										Arr.map(indices(c.children), (child) => `(${child}, 1, 9)`),
										", "
									)}`
								)
							}
							const db = yield* openFull(fx, S)
							const write = writeOf(S, c)
							const plans = yield* explainedChange(db, write)
							const violations = yield* writeAuditViolations(db, write)
							assert.deepEqual(
								violations,
								[],
								"every statement of the write passes the structural audit"
							)
							const table: string = names.tableIdent(Log)
							const probes = Arr.reduce(plans, 0, (sum, p) =>
								Arr.reduce(
									Arr.filter(Arr.fromIterable(planNodes(p.plan)), (n) => n.nodeType === "Limit"),
									sum,
									(total, limit) =>
										total +
										Arr.reduce(
											Arr.filter(limit.children, (s) =>
												Option.exists(s.relation, (r) => r === table)
											),
											0,
											(loops, s) => loops + s.actualLoops
										)
								)
							)
							assert.equal(
								probes,
								c.children,
								`the head is probed once per child: ${c.children} children of ${c.rows} rows each`
							)
							k.note(c.children === 1 ? "one child" : "several children")
							k.note(c.rows === 1 ? "one row a child" : "several rows a child")
							k.note(c.head ? "a stored head" : "no head")
						})
					),
					Substrate,
					substrate
				),
		oracle: { kind: "specification", name: "one probe of the head per child the call stamps" },
		box: "1, 3 and 10 children of 1 and 4 rows each, over a stored head at each child or none",
		show: Formatter.format,
		kept: [],
		kills: []
	}
)
