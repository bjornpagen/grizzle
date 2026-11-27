/**
 * The locks a drafted migration states (meta.json, deploy/locks/demand.ts fileLockSets) bound what PostgreSQL 19 holds
 * while the runner applies it, on generated migration paths.
 *
 * A path is a schema A, its successor B and B's successor C (the migration paths of test/pg/migrate-gen, renamed as a
 * user renames), each step drafted from the snapshot before and reviewed as migrate-gen reviews it, and applied by the
 * real runner, A's facts loaded after A so B and C migrate stored rows. Every transaction the runner sends runs as it
 * sends it, with a read of pg_locks after BEGIN and after each statement: the most distinct objects its backend held
 * locked between two statements, the session's own locks from before BEGIN (its apply lock) left out, a predicate lock
 * and the virtual transaction id not among them, since neither takes an entry of the shared lock table. For every file
 * of every folder, that peak is at most the count its meta records (statedLocks), and for every folder the most its
 * meta records of a file is at most twice the most a transaction of it held: the count is an upper bound, never a
 * guess, and no more than twice what PostgreSQL takes. The report of a file held past its count names what the count
 * missed, each held object by its names against the targets the count holds.
 *
 * Oracle: PostgreSQL's pg_locks of the backend that runs each file's transaction.
 *
 * Features: a fresh install and a migration over stored rows, each required; a migration of an installed schema that
 * holds no row is noted where a path draws no facts, which no witness of the renamed stream is steered to.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record } from "effect"
import { fileLockSets, lockTargetText, migrationCatalog } from "#compiler/deploy/locks/demand.ts"
import { planFiles } from "#compiler/deploy/phases/files.ts"
import { readDecodedMeta, statedLocks } from "#compiler/deploy/render/folder.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import {
	carryChain,
	planOf,
	resolveRenamedDraw,
	renamedDrawGen
} from "#test/pg/migrate-gen/support.ts"
import {
	lockDifference,
	type ProbedTransaction,
	probingSession
} from "#test/pg/migrate/lock-demand.fixtures.ts"
import {
	apply,
	carried,
	directory,
	drafted,
	factSetOf,
	noFurther
} from "#test/pg/migrate/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { installedStatements } from "#test/support/migrate/kit.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { tappedSession } from "#test/support/wire-tap.ts"

type Feature = "a fresh install" | "a migration" | "a migration over rows"

/**
 * The most a folder's count of a file's locks may exceed what a transaction of it held: twice. The count is an upper
 * bound of what each statement's every path locks (a CREATE OR REPLACE counted as a replacement, a table's TOAST
 * relations wherever a column may be stored out of line, every index of a table a query names), and a test's own
 * choice of how close an upper bound must come.
 */
const tightness = 2

/** The locks a drafted migration states bound what PostgreSQL holds while each of its files runs, within twice. */
export const statedLocksBoundTheHeld = property.explore(renamedDrawGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: ["a fresh install", "a migration over rows"] satisfies ReadonlyArray<
		Reached<Feature>
	>,
	budget: { runs: 4, steered: 8 },
	check:
		({ substrate }, notes: Case<Feature>) =>
		(draw) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					Effect.gen(function* () {
						const p = notes.draw(resolveRenamedDraw(draw))
						const sub = yield* Substrate
						const x = yield* sub.schema({ create: false, label: "lock_demand" })
						const tapped = yield* tappedSession({
							cluster: sub.cluster,
							database: sub.database,
							role: sub.owner.role,
							password: sub.owner.password
						})
						const ran: Array<ProbedTransaction> = []
						const m = probingSession(
							tapped.session,
							{ database: sub.database, roles: { kind: "stems" } },
							ran
						)
						const a = { version: p.path.a, origins: p.origins.a }
						const b = { version: p.path.b, origins: p.origins.b }
						const c = { version: p.path.c, origins: p.origins.c }
						const model = carryChain({ a: p.path.a, b: p.path.b, c: p.path.c }, p.path.facts, {
							ab: carried(a, b, p.choose),
							bc: carried(b, c, p.choose),
							ac: carried(a, c, p.choose)
						})
						const steps = yield* Effect.fromResult(drafted([a, b, c], x, p.choose))
						for (const [i, step] of steps.entries()) {
							if (step.generated.change === "none") {
								continue
							}
							ran.length = 0
							yield* apply(m, directory(steps, i), noFurther)
							if (i === 0) {
								const loaded = factStatements(
									planOf(p.path.a, x),
									factSetOf(p.path.a, model.loaded)
								)
								yield* transaction(sub.admin, succeeded(loaded, "A's facts"))
							}
							notes.note(
								i === 0
									? "a fresh install"
									: Arr.some(Record.values(model.loaded), (rows) => rows.length > 0)
										? "a migration over rows"
										: "a migration"
							)
							const meta = succeeded(
								readDecodedMeta(step.generated.folder.meta),
								"the folder's meta"
							)
							const previous =
								steps[i - 1]?.generated.snapshot ??
								emptySnapshot({
									schemaName: step.generated.snapshot.schemaName,
									schema: step.generated.snapshot.schema
								})
							const counted = fileLockSets({
								schema: step.generated.snapshot.schema,
								catalog: migrationCatalog(previous, installedStatements(step.installation)),
								files: planFiles(step.generated.plan)
							})
							let most = 0
							let held = 0
							for (const file of step.files) {
								const stated = statedLocks(meta, file)
								assert.ok(stated !== undefined, `${file.name} states its locks`)
								most = Math.max(most, stated)
								for (const t of Arr.filter(ran, (r) => r.file === file.name)) {
									held = Math.max(held, t.peak)
									const set = Arr.findFirst(counted, (f) => f.file.name === file.name)
									const diff = lockDifference(
										t.names,
										t.before,
										set._tag === "Some" ? Arr.map([...set.value.locks], lockTargetText) : []
									)
									assert.ok(
										t.peak <= stated,
										`${step.generated.folder.name}/${file.name} held ${t.peak} locks, past the ${stated} its meta states; the count missed ${Arr.join(diff.missed, ", ")}`
									)
								}
							}
							assert.ok(
								most <= tightness * held,
								`${step.generated.folder.name} states ${most} locks of a file, past ${tightness} times the ${held} a transaction of it held`
							)
						}
					})
				),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "specification",
		name: "PostgreSQL's pg_locks of the backend each file's transaction runs on"
	},
	kept: [
		{
			token: ReplayToken(
				"test/pg/migrate/lock-demand.test.ts#statedLocksBoundTheHeld:-:0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.1.0.0.0.0.0.0.0.1.0.0.1.1.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"R0 renamed to Q0 beside an added column and a toggled read, then back to R0 beside another: step 2's publish drops the reader role, whose lock the transaction holds after DROP ROLE with no pg_roles row left, and the probe named it NULL ('role ' || NULL), a cell no session reads (main d9a51ea25 and fd2316a2, rotating seed 0x05b7b736)",
			since: "2026-11-25"
		},
		{
			token: ReplayToken(
				"test/pg/migrate/lock-demand.test.ts#statedLocksBoundTheHeld:-:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.2.3.0.0.0.0.0.0.1.0.0.1.0.0.0.0.0.1.0.1.0.0.1.1.0.0.0.0.0.0.0.1.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"step 3's publish comments R0's key and R1's foreign key after dropping Q0: each COMMENT keeps pg_description locked RowExclusive to the end, which the count left out, so the file held 25 locks past the 24 its meta stated (PIN 2 26760a21 and fd2316a2, rotating seed 0xa4d8eeef)",
			since: "2026-11-25"
		},
		{
			token: ReplayToken(
				"test/pg/migrate/lock-demand.test.ts#statedLocksBoundTheHeld:-:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.1.0.0.2.1.0.2.0.0.0.0.0.1.0.0.0.0.0.1.0.1.0.0.1.1.0.0.0.0.0.0.0.1.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"step 2's publish swaps R0's key to a column of its own and points R1's foreign key at it: dropping the foreign key deletes the four triggers PostgreSQL made for it, two on R1 and two on R0, each locked to the end, which the count left out, so the file held 17 locks past the 16 its meta stated, its report naming seven dropped objects transient (main's merged base, REPLAYFIX at VALUECELL's slice A)",
			since: "2026-11-26"
		},
		{
			token: ReplayToken(
				"test/pg/migrate/lock-demand.test.ts#statedLocksBoundTheHeld:-:0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.2.0.1.0.1.1.0.0.0.0.0.0.0.1.0.0.1.1.0.0.0.0.0.0.0.1.1.0.0.6bk.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"step 3's structure drops R0's view, adds a column at a placeholder and lifts R0's guards around it: the guard bracket reads pg_trigger, pg_class, pg_namespace and pg_proc with their indexes, fourteen catalogs its count states, which the names probe read after BEGIN held already, so the file measured 21 locks held and its stated 43 read as past twice that (the merged base and after, rotating seed 0x8afa3e1b); and step 2's structure adds a column of a domain a CHECK holds, which rewrites R0, its transient table and its schema counted by none, a miss the TOAST relations stated for the dropped view hid, 47 held past 45 once they went",
			since: "2026-11-26"
		},
		{
			token: ReplayToken(
				"test/pg/migrate/lock-demand.test.ts#statedLocksBoundTheHeld:-:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.1.1.1.1.1.1.0.1.0.0.0.0.0.1.0.1.0.0.1.1.0.0.0.0.0.0.0.1.0.0.1.1.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.6.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"step 2 renames K0's column's domain aside and its publish drops it: the drop deletes the domain's CHECK, which the count, its catalog knowing the CHECK under the domain's old name alone, left out, so the file held 28 locks past the 27 its meta stated once the count stated no TOAST relation no comment or drop takes (LOCKS-P3, rotating seed 0x2a4cde25)",
			since: "2026-11-26"
		},
		{
			token: ReplayToken(
				"test/pg/migrate/lock-demand.test.ts#statedLocksBoundTheHeld:-:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.2.1.0.0.0.1.2.0.0.0.1.0.0.0.0.0.1.0.1.0.0.1.1.0.0.0.0.0.0.0.1.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"step 2's validate checks R1's foreign key into R0: its query reads R0 beside R1, every index of each opened by the planner and kept, R0's key and its unique key among them, which the count left out of R0, so the file held 8 locks past the 7 its meta stated once the count came exact (LOCKS-P3, rotating seed 0x5aa006d1)",
			since: "2026-11-26"
		},
		{
			token: ReplayToken(
				"test/pg/migrate/lock-demand.test.ts#statedLocksBoundTheHeld:-:0.0.0.0.1.1.1.1.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.1.0.1.1.0.0.1.1.a.0.0.0.1.0.0.1.4.1.0.1.0.e.0.0.0.1.0.1.6.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"step 3's indexes declares R1's dependency of b on d: its restore reads each column's number by a query over pg_attribute, pg_class and pg_namespace, the three kept locked with their seven indexes, which the count left out and the names probe read after BEGIN had hidden, so the file held 18 locks past the 11 its meta stated (LOCKS-P3, seed 88888)",
			since: "2026-11-26"
		}
	],
	kills: [
		{
			file: "packages/engine/src/deploy/locks/demand.ts",
			original: "\t\t\tlocks.add(bracketReads[s.side])\n",
			replacement: "",
			why: "A guard bracket counts none of the catalogs its DO blocks read, pg_trigger, pg_class, pg_namespace and pg_proc with every index of each the planner opens, which its transaction holds to the end: a drafted folder whose data steps lift the closed relations' guards holds past the count its meta states."
		},
		{
			file: "packages/engine/src/deploy/locks/demand.ts",
			original:
				"\t\tfor (const index of this.#catalog.indexes.get(named(table)) ?? []) {\n\t\t\tthis.add([indexOf(table, index)])\n\t\t}",
			replacement:
				"\t\tfor (const index of this.#catalog.indexes.get(named(table)) ?? []) {\n\t\t\tvoid index\n\t\t}",
			why: "A query or write counts no index of the tables it names, as if the planner and the executor opened none."
		},
		{
			file: "packages/engine/src/deploy/locks/demand.ts",
			original:
				"\treturn [catalog(name), ...(row > toastTupleThresholdBytes ? toastedCatalog(name) : [])]\n",
			replacement: "\treturn [...(row > toastTupleThresholdBytes ? toastedCatalog(name) : [])]\n",
			why: "A COMMENT counts no pg_description, which CreateComments keeps locked RowExclusive to the transaction's end: a file of comments holds one lock past its count."
		},
		{
			file: "packages/engine/src/deploy/locks/demand.ts",
			original: "\t\t\tthis.dropped([notNullOf(table, column)])\n",
			replacement: "",
			why: "A table's drop counts none of its columns' NOT NULL constraints, each a pg_constraint row of its own since PostgreSQL 18, which the drop locks and deletes with it: a publish that drops Q0 holds one lock past its count for each of Q0's columns (the kept case of pg_description's comments)."
		},
		{
			file: "packages/engine/src/deploy/locks/demand.ts",
			original: '\t\t\t...(kind === "foreignKey" ? foreignKeyTriggers(table, name) : [])\n',
			replacement: "",
			why: "A dropped foreign key counts none of the four triggers PostgreSQL made for it, which its drop locks and deletes with it: a publish that drops R1's foreign key to swap R0's key holds four locks past its count (the kept case)."
		}
	]
})
