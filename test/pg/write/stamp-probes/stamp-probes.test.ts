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
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { planNodes } from "#bench/harness/explain.ts"
import { explainedChange, installWrites, openFull, owner } from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { instant, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { assert } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { writeAuditViolations } from "#test/support/write-audit.ts"

const Log = relation("Log", { child: pg.integer, at: instant, note: pg.integer }, [
	"child",
	"at",
	"note"
])

const build = (name: string) => schema(name, [Log], [])

type Schema = ReturnType<typeof build>

/** A case: how many children the call stamps, how many rows each, and whether each child holds a head before it. */
interface Stamping {
	readonly children: 1 | 3 | 10
	readonly rows: 1 | 4
	readonly head: boolean
}

const stampingGen: Gen<Stamping> = (source) => ({
	children: source.draw(element([1, 3, 10] as const)),
	rows: source.draw(element([1, 4] as const)),
	head: source.draw(element([false, true] as const))
})

const situations = [
	"one child",
	"several children",
	"one row a child",
	"several rows a child",
	"a stored head",
	"no head"
] as const

type Situation = (typeof situations)[number]

/** The call's rows: `rows` notes at each of `children` children, every instant left out. */
const writeOf = (s: Schema, c: Stamping) =>
	ChangeSet.empty(s).insert(
		Log,
		Arr.flatMap(indices(c.children), (child) =>
			Arr.map(indices(c.rows), (note) => ({ child, note }))
		)
	)

layer(Substrate.layer)("a stamping insert's head probes", (it) => {
	it.effect("read the clock's head once per child", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "pg/write/stamp-probes",
					generator: stampingGen,
					literal: Formatter.format,
					box: "1, 3 and 10 children of 1 and 4 rows each, over a stored head at each child or none",
					oracle: {
						kind: "specification",
						name: "one probe of the head per child the call stamps"
					},
					coverage: requiredInSpace<Situation>(situations),
					caseHang
				},
				(c, k) =>
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
					)
			)
		)
	)
})
