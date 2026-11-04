import { Array as Arr, Effect, Schema } from "effect"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	jsonText,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	measureTransaction,
	summarizeTransactions,
	type TransactionMeasure
} from "#bench/harness/transaction.ts"
import { fill, settle } from "#bench/query/support/kit.ts"
import {
	digestOf,
	queueSchema,
	queueBenchWorlds,
	QueueWork,
	workStanding
} from "#bench/queue/support/queue.ts"

import {
	baselineSchema,
	callsOn,
	decodeRows,
	installWrites,
	lawObjects,
	loadedByOwner,
	owner,
	plainStatement,
	probeLaws,
	tableScans,
	transactionOf,
	warmedOnce,
	writeConditions,
	writePhases,
	writerSession
} from "#bench/write/support/writes.ts"
import { pg } from "#compiler/public/fields.ts"
import { contained, on, relation as defineRelation, schema } from "#compiler/public/schema.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R09: specialize laws before emitting checkers.
 *
 * R09 states no gate paragraph, so its gate is the performance contract's "measurement that can disprove the
 * performance assumption". The assumptions: the exact native mechanisms hold for every writer and are
 * cheaper than a checker (eligible ordinary FK checks probe the referenced B-tree directly), and what
 * remains of an exhaustive alternatives law is one reverse check that dispatches the current parent kind once and
 * does not scan every arm, with an event table under which "an arm switch queues two
 * reverse checks of one key; a payload-only update queues none".
 *
 * Two fixtures. The queue example's Queue, whose alternatives over Work's standing leave one residual law, the reverse
 * obligation anchored on the Work row, beside native composite FKs from each arm, the key on Leased's seat and the
 * containment into Seat. And Parent/Child with `contained(on(Child, "parent"), on(Parent, "id"))`, a native FK, timed
 * beside the hand-written checker a compiler that did not specialize would install: a deferred constraint trigger that
 * probes the parent under FOR KEY SHARE, as PostgreSQL's own RI trigger did before the fast path; the checker's timings
 * are information. The law calls and the arms' scans are read with the law's triggers IMMEDIATE (support/writes.ts
 * probeLaws), each call by the participant whose trigger fired it, as the installation records the participants.
 */
const Parent = defineRelation("Parent", { id: pg.bigint }, ["id"])
const Child = defineRelation("Child", { id: pg.bigint, parent: pg.bigint }, ["id"])
const fkSchema = (name: string) =>
	schema(name, { Parent, Child }, [contained(on(Child, "parent"), on(Parent, "id"))])

interface Options extends Readonly<Record<string, unknown>> {
	/** Child rows per measured batch, and parents they reference. */
	readonly children: number
	readonly parents: number
	/** Work items enqueued in the probed transaction. */
	readonly items: number
	readonly samples: number
}

const ConstraintRow = Schema.Tuple([Schema.String, Schema.String, Schema.String])

const split = (sql: string) => transactionOf([plainStatement("children", sql, [])], "split")

/** @internal */
export default defineGate({
	name: "write-specialize",
	gates: ["R09"],
	title:
		"Native specialization: the FK fast path beside a trigger checker, and the alternatives reverse check",
	scope:
		"Child batches under a native FK, timed beside a hand-written deferred trigger checker; the queue's alternatives " +
		"law: its catalog, its trigger calls per event and the arms its reverse check reads.",
	phases: writePhases,
	options: {
		full: { children: 100000, parents: 10000, items: 5000, samples: 9 },
		quick: { children: 2000, parents: 200, items: 50, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			/** 1. The native FK beside the hand-written trigger checker. */
			const fk = yield* installWrites(fkSchema("Fks"), "benchspecfk", {
				programs: {},
				logins: []
			})
			yield* fill(fk, "Parent", options.parents, { id: "g::int8" })
			const B = yield* baselineSchema("benchspechand")
			yield* owner(
				`CREATE TABLE ${B}.parent (id int8 PRIMARY KEY)`,
				`CREATE TABLE ${B}.child (id int8 PRIMARY KEY, parent int8 NOT NULL)`,
				`CREATE INDEX ON ${B}.child (parent)`,
				`CREATE FUNCTION ${B}.child_parent() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
	PERFORM 1 FROM ${B}.parent WHERE id = NEW.parent FOR KEY SHARE;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'child_parent', MESSAGE = 'no parent';
	END IF;
	RETURN NULL;
END $f$`,
				`CREATE CONSTRAINT TRIGGER child_parent AFTER INSERT ON ${B}.child DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${B}.child_parent()`,
				`INSERT INTO ${B}.parent SELECT g FROM pg_catalog.generate_series(1, ${options.parents}) AS g`
			)
			yield* settle(fk)
			yield* owner(`VACUUM (ANALYZE) ${B}.parent`)
			const fkWriter = yield* writerSession(fk, fk.world.app, "m15c specialize fk writer")
			const hand = yield* s.session({ ...ownerSession(), label: "m15c specialize hand-written" })
			const childSql = (table: string, idCol: string, parentCol: string, first: number) =>
				`INSERT INTO ${table} (${idCol}, ${parentCol}) SELECT ${first} + g, 1 + (g % ${options.parents}) FROM pg_catalog.generate_series(1, ${options.children}) AS g`
			const native: Array<TransactionMeasure> = []
			const checker: Array<TransactionMeasure> = []
			for (let i = 0; i < options.samples; i++) {
				const first = i * options.children
				const nativeRun = yield* measureTransaction(
					fkWriter,
					split(
						childSql(
							fk.table("Child"),
							fk.column("Child", "id"),
							fk.column("Child", "parent"),
							first
						)
					)
				)
				native.push(nativeRun)
				const checkerRun = yield* measureTransaction(
					hand,
					split(childSql(`${B}.child`, "id", "parent", first))
				)
				checker.push(checkerRun)
			}
			/** The native FK refuses an orphan. */
			const orphanNative = yield* measureTransaction(
				fkWriter,
				transactionOf(
					[
						plainStatement(
							"orphan",
							`INSERT INTO ${fk.table("Child")} (${fk.column("Child", "id")}, ${fk.column("Child", "parent")}) VALUES (-1, -1)`,
							[]
						)
					],
					"plain"
				)
			)
			const rows = yield* s.admin.queryValues(
				`SELECT c.conname::text, c.condeferrable::text, c.condeferred::text FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.connamespace WHERE n.nspname = $1::text AND c.contype = 'f'`,
				[fk.installed.schema]
			)
			const fkConstraints = decodeRows(ConstraintRow, rows)

			/**
			 * 2. The queue's alternatives. Its reverse law is read through the door from the alternatives value that declares
			 * it.
			 */
			const queue = queueSchema("Queue")
			const worlds = queueBenchWorlds(queue)
			const q = yield* installWrites(queue, "benchspecqueue", {
				programs: {},
				logins: [worlds.workers, worlds.enqueuers]
			})
			const law = namesOf(q.installed).alternativesOf(workStanding).reverse
			const reverse = namesOf(q.installed).residual(law)
			const residuals = q.installed.installation.laws.residuals
			const objects = yield* lawObjects(q)
			const W = q.table("Work")
			const c = (rel: string, f: string) => q.column(rel, f)
			const kind = q.enumType("Kind")
			const standing = q.enumType("Standing")
			const resource = q.enumType("Resource")
			yield* fill(q, "Seat", 16, { resource: `'gpu'::${resource}`, seat: "g::int4" })
			/** Items 1..items are wanted and stay so; the probe enqueues fresh ones. */
			const workRows = (from: number, n: number) =>
				`INSERT INTO ${W} (${Arr.join(
					Arr.map(["key", "kind", "slot", "standing", "epoch", "enqueued"], (f) => c("Work", f)),
					", "
				)}) ` +
				`SELECT ${digestOf("g")}, 'render'::${kind}, 0, 'wanted'::${standing}, 0, g FROM pg_catalog.generate_series(${from}, ${from + n - 1}) AS g`
			const wantedRows = (from: number, n: number) =>
				`INSERT INTO ${q.table("Wanted")} (${Arr.join(
					Arr.map(["key", "due", "attempts"], (f) => c("Wanted", f)),
					", "
				)}) SELECT ${digestOf("g")}, 0, 0 FROM pg_catalog.generate_series(${from}, ${from + n - 1}) AS g`
			yield* owner("BEGIN", workRows(1, options.items), wantedRows(1, options.items), "COMMIT")
			yield* settle(q)
			const enqueuer = yield* writerSession(q, worlds.enqueuer, "m15c specialize enqueuer")
			const worker = yield* writerSession(q, worlds.worker, "m15c specialize worker")
			const fresh = options.items + 1
			/**
			 * With the law IMMEDIATE it fires at each statement's end, so the statements run in an order whose every
			 * intermediate state keeps the law: an arm before its parent, the new arm before the switch.
			 */
			const enqueue = yield* probeLaws(
				enqueuer,
				q,
				law,
				[wantedRows(fresh, options.items), workRows(fresh, options.items)],
				[]
			)
			const key1 = `(${digestOf("1")})`
			const armSwitch = yield* probeLaws(
				worker,
				q,
				law,
				[
					`INSERT INTO ${q.table("Leased")} (${Arr.join(
						Arr.map(["key", "resource", "seat", "epoch", "expires"], (f) => c("Leased", f)),
						", "
					)}) VALUES (${key1}, 'gpu'::${resource}, 1, 1, 1000)`,
					`UPDATE ${W} SET ${c("Work", "standing")} = 'leased'::${standing}, ${c("Work", "epoch")} = ${c("Work", "epoch")} + 1 WHERE ${c("Work", "key")} = ${key1}`,
					`DELETE FROM ${q.table("Wanted")} WHERE ${c("Wanted", "key")} = ${key1}`
				],
				[]
			)
			const payloadOnly = yield* probeLaws(
				worker,
				q,
				law,
				[
					`UPDATE ${W} SET ${c("Work", "enqueued")} = ${c("Work", "enqueued")} + 1 WHERE ${c("Work", "key")} = ${key1}`
				],
				[]
			)
			const constraintRows = yield* s.admin.queryValues(
				`SELECT cl.relname::text, c.contype::text, pg_catalog.count(*)::text FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_class AS cl ON cl.oid = c.conrelid JOIN pg_catalog.pg_namespace AS n ON n.oid = c.connamespace WHERE n.nspname = $1::text GROUP BY 1, 2 ORDER BY 1, 2`,
				[q.installed.schema]
			)
			const constraints = decodeRows(ConstraintRow, constraintRows)
			const constraintText = Arr.join(
				Arr.map(constraints, (r) => Arr.join(r, ":")),
				", "
			)
			/**
			 * The scans of the arms a check must not read: every arm but the parent's current kind. The arm switch's own DELETE
			 * reads Wanted, so its other arms are Done and Refused.
			 */
			const armScans = (scans: (typeof enqueue)["scans"], arms: ReadonlyArray<string>) =>
				Arr.reduce(
					Arr.map(arms, (rel) => tableScans(scans, q.relationName(rel))),
					0,
					(sum, a) => sum + a.seq + a.idx
				)
			const notWanted = ["Leased", "Done", "Refused"]
			const notLeased = ["Done", "Refused"]
			/** The law's calls on its arm participants, every participant but the parent Work. */
			const armCalls = (probe: typeof enqueue) =>
				Arr.reduce(
					Arr.filter(probe.calls, (p) => p.relation !== QueueWork.name),
					0,
					(sum, p) => sum + p.calls
				)
			const fkForeignKeyOf = (rel: string) =>
				Arr.some(
					constraints,
					([table, contype]) => table === q.relationName(rel) && contype === "f"
				)

			const n = summarizeTransactions(native)
			const h = summarizeTransactions(checker)
			const cases: Array<CaseRecord<"R09">> = [
				{
					name: `${options.children} children under a native FK and under a trigger checker`,
					gates: ["R09"],
					conditions: writeConditions({
						workload: `one INSERT of ${options.children} children of existing parents, then the deferred checks and COMMIT`,
						schemaState: loadedByOwner,
						data: `${options.parents} parents; children spread evenly over them`,
						parameters: { children: options.children, parents: options.parents },
						semantics:
							"every child has its parent; the native FK accepts the batch and refuses an orphan",
						cache: warmedOnce
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: { native: n, triggerChecker: h },
					loads: {},
					measures: {
						fkConstraints: Arr.join(
							Arr.map(fkConstraints, (r) => Arr.join(r, ":")),
							", "
						)
					}
				},
				{
					name: "the queue's alternatives: the catalog and the reverse check's events",
					gates: ["R09"],
					conditions: writeConditions({
						workload:
							"an enqueue of Work and Wanted facts; an arm switch from wanted to leased; a payload-only Work update; each with the law's triggers IMMEDIATE, rolled back",
						schemaState: loadedByOwner,
						data: `${options.items} wanted items, 16 gpu seats`,
						parameters: { items: options.items },
						semantics: "every statement keeps the alternatives law",
						cache: warmedOnce
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						residualLaws: Arr.join(
							Arr.map(residuals, (r) => r.lawId),
							", "
						),
						lawFunctions: Arr.join(objects.functions, ", "),
						reverseTriggers: Arr.join(
							Arr.map(reverse.units, (u) => `${u.relation}.${u.event}.${u.trigger}`),
							", "
						),
						constraints: constraintText,
						enqueueLawCalls: jsonText(enqueue.calls),
						enqueueArmScans: armScans(enqueue.scans, notWanted),
						armSwitchLawCalls: jsonText(armSwitch.calls),
						armSwitchArmScans: armScans(armSwitch.scans, notLeased),
						payloadOnlyLawCalls: payloadOnly.total,
						scans: jsonText(armSwitch.scans)
					}
				}
			]
			const r09: VerdictInput = {
				checks: [
					mechanism(
						"the containment is a native foreign key, with no residual law",
						fkConstraints.length === 1 && fk.installed.installation.laws.residuals.length === 0,
						jsonText(fkConstraints)
					),
					mechanism(
						"the alternatives leave exactly one residual law, the reverse obligation, whose units' functions are the ones installed",
						residuals.length === 1 &&
							objects.functions.length === reverse.units.length &&
							Arr.every(reverse.units, (u) => objects.functions.includes(u.function)),
						`${Arr.join(
							Arr.map(residuals, (r) => r.lawId),
							", "
						)} | ${Arr.join(objects.functions, ", ")}`
					),
					mechanism(
						"every arm and Leased's seat containment are native foreign keys",
						Arr.every(["Wanted", "Leased", "Done", "Refused"], fkForeignKeyOf),
						constraintText
					),
					mechanism(
						"an enqueue fires the reverse check once per parent insertion and never for an arm insertion",
						callsOn(enqueue, QueueWork.name) === options.items && armCalls(enqueue) === 0,
						jsonText(enqueue.calls)
					),
					mechanism(
						"the reverse check dispatches the current kind once: no other arm is read",
						armScans(enqueue.scans, notWanted) === 0 && armScans(armSwitch.scans, notLeased) === 0,
						jsonText(armSwitch.scans)
					),
					mechanism(
						"an arm switch queues two reverse checks of one key",
						armSwitch.total === 2,
						jsonText(armSwitch.calls)
					),
					mechanism(
						"a payload-only update queues none",
						payloadOnly.total === 0,
						jsonText(payloadOnly.calls)
					),
					equivalence(
						"the native FK accepts every lawful batch",
						n.outcomes.committed === n.samples,
						jsonText(n.outcomes)
					),
					equivalence(
						"the native FK refuses an orphan with 23503",
						orphanNative.outcome.kind === "failed" && orphanNative.outcome.sqlstate === "23503",
						jsonText(orphanNative.outcome)
					)
				]
			}
			return { cases, verdicts: { R09: r09 } }
		})
})
