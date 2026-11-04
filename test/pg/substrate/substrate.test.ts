import { layer } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Option, Ref } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, matchesObject } from "#test/support/assert.ts"
import { wild } from "#test/support/kernel/naming.ts"
import {
	expectationAttempts,
	expectConstraint,
	expectSqlstate,
	inTransaction
} from "#test/support/substrate/expect.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { leftovers } from "#test/support/substrate/shared.ts"
import { freshSchema, rolePsql, roleSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * The native multi-session test substrate on the local cluster.
 *
 * Besides its sessions, psql writers, lock barriers and expectations, the substrate judges what a test leaves behind: a
 * shared database left with anything in it fails its release, and no later claim is given it while it is dirty (the
 * sweep drops it once no file runs, which this file cannot observe). (A role's session that outlives the role holds
 * the role's release until the runner's hang guard reports the test hung, kernel/sanitize.ts; no verdict is timed, so
 * that rule has no test of its own here.)
 */
const ident = quoteIdent

/** The hand-made table's constraints, named by the test itself: its key and its row check. */
const factKey = wild.constraint("fact_key")
const factCheck = wild.constraint("fact_v_check")

/**
 * One owner-created table in `schema`, granted to `role` the way a world role writing it whole is: no UPDATE unless
 * the relation is mutable (immutable by default).
 */
const createFact = (schema: string, role: Credentials, mutability: "immutable" | "mutable") =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		yield* admin.query(
			`CREATE TABLE ${ident(schema)}."fact" ("k" int4 NOT NULL, "v" text COLLATE pg_catalog.pg_c_utf8 NOT NULL, CONSTRAINT ${ident(factKey)} PRIMARY KEY ("k"), CONSTRAINT ${ident(factCheck)} CHECK (("v" <> ''::text) IS TRUE))`,
			[]
		)
		yield* admin.query(`GRANT USAGE ON SCHEMA ${ident(schema)} TO ${ident(role.role)}`, [])
		const privileges =
			mutability === "mutable" ? "SELECT, INSERT, DELETE, UPDATE" : "SELECT, INSERT, DELETE"
		yield* admin.query(`GRANT ${privileges} ON ${ident(schema)}."fact" TO ${ident(role.role)}`, [])
		return `${ident(schema)}."fact"`
	})

layer(Substrate.layer)("native PG test substrate", (it) => {
	it.effect(
		"fails the release of a shared substrate that leaves anything behind, and gives no later claim a dirty database",
		() =>
			Effect.gen(function* () {
				/**
				 * Each claim is a substrate of its own, built fresh: the suite's substrate is memoized under the same layer,
				 * and a claim that reused it would leave its strays to the file's own release.
				 */
				const exit = yield* Effect.exit(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						yield* substrate.admin.query('CREATE TABLE public."stray" ("k" int4)', [])
						yield* substrate.admin.query('CREATE SCHEMA "stray_schema"', [])
					}).pipe(withLayer(Layer.fresh(Substrate.layer)))
				)
				assert.ok(Exit.isFailure(exit), "the release of a claim that left objects behind fails")
				/**
				 * A claim after the failed release: whichever database it is given, the stray objects' or another, it is
				 * clean.
				 */
				const left = yield* Effect.flatMap(Substrate, (substrate) =>
					leftovers(substrate.admin)
				).pipe(withLayer(Layer.fresh(Substrate.layer)))
				assert.deepEqual(left, [])
			})
	)

	it.effect("sees PostgreSQL's native errors from a psql writer and keeps its session", () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema(freshSchema)
			const writer = yield* s.role(schema, "writer")
			const fact = yield* createFact(schema, writer, "immutable")
			const p = yield* s.psql({ ...rolePsql(writer) })
			yield* p.run(`INSERT INTO ${fact} ("k", "v") VALUES (1, 'one')`)
			/** An exact repeat raises 23505 for a direct writer (Direct SQL writers). */
			const repeat = yield* expectConstraint(
				p.run(`INSERT INTO ${fact} ("k", "v") VALUES (1, 'one')`),
				factKey,
				"23505"
			)
			matchesObject(repeat, {
				schema: Option.some(schema),
				table: Option.some("fact"),
				detail: Option.some("Key (k)=(1) already exists.")
			})
			yield* expectConstraint(
				p.run(`INSERT INTO ${fact} ("k", "v") VALUES (2, '')`),
				factCheck,
				"23514"
			)
			yield* expectSqlstate(p.run(`UPDATE ${fact} SET "v" = 'uno' WHERE "k" = 1`), "42501")
			assert.deepEqual((yield* p.run(`SELECT count(*) FROM ${fact}`)).rows, [["1"]])
			yield* expectSqlstate(inTransaction(p, p.run("SELECT 1 / 0")), "22012")
			yield* expectSqlstate(p.run("SELECT 1"), "25P02")
			yield* p.rollback
			assert.deepEqual((yield* p.run("SELECT 1")).rows, [["1"]])
		})
	)

	it.effect("detects blocked UPDATEs with the lock barrier, without sleeping", () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema(freshSchema)
			const writer = yield* s.role(schema, "writer")
			const fact = yield* createFact(schema, writer, "mutable")
			yield* s.admin.query(`INSERT INTO ${fact} ("k", "v") VALUES (1::int4, 'v0'::text)`, [])
			const a = yield* s.session({ ...roleSession(writer), label: "a" })
			const b = yield* s.session({ ...roleSession(writer), label: "b" })
			const p = yield* s.psql({ ...rolePsql(writer), label: "p" })
			const update = (next: string) =>
				`UPDATE ${fact} SET "v" = '${next}'::text WHERE "k" = 1::int4`

			const [aPid, bPid, pPid] = [yield* a.pid, yield* b.pid, yield* p.pid]

			yield* a.begin
			assert.equal((yield* a.query(update("a"), [])).rowCount, 1)

			yield* p.begin
			const psqlUpdate = yield* Effect.forkChild(p.run(update("p")))
			const psqlWait = yield* s.awaitLockWait(pPid, Option.some(aPid))
			matchesObject(psqlWait, {
				waitEvent: "transactionid",
				locktype: "transactionid",
				mode: "ShareLock",
				blockedBy: [aPid]
			})
			assert.equal((yield* s.awaitBlockedBy(aPid, writer.role)).pid, pPid)
			assert.equal(psqlUpdate.pollUnsafe(), undefined)

			yield* b.begin
			const rawUpdate = yield* Effect.forkChild(b.query(update("b"), []))
			yield* s.awaitLockWait(bPid, Option.some(pPid))
			assert.equal(rawUpdate.pollUnsafe(), undefined)

			yield* a.rollback
			assert.equal((yield* Fiber.join(psqlUpdate)).rowCount, 1)
			yield* s.awaitLockWait(bPid, Option.some(pPid))
			assert.equal(rawUpdate.pollUnsafe(), undefined)

			yield* p.commit
			yield* expectSqlstate(Fiber.join(rawUpdate), "40001")
			yield* b.rollback
			const rows = yield* s.admin.queryValues(`SELECT "v" FROM ${fact}`, [])
			assert.deepEqual(rows, [["p"]])
		})
	)

	it.effect("expectSqlstate and expectConstraint refuse the wrong outcome", () =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const schema = yield* s.schema(freshSchema)
			const writer = yield* s.role(schema, "writer")
			const fact = yield* createFact(schema, writer, "immutable")
			const a = yield* s.session({ ...roleSession(writer) })
			yield* a.query(`INSERT INTO ${fact} ("k", "v") VALUES (1::int4, 'one'::text)`, [])
			const duplicate = a.query(`INSERT INTO ${fact} ("k", "v") VALUES (1::int4, 'one'::text)`, [])
			const fields = yield* expectConstraint(duplicate, factKey, "23505")
			matchesObject(fields, {
				code: "23505",
				schema: Option.some(schema),
				table: Option.some("fact")
			})
			assert.equal(
				(yield* Effect.flip(expectSqlstate(a.values("SELECT 1::int4", []), "23505")))._tag,
				"ExpectationFailed"
			)
			assert.equal(
				(yield* Effect.flip(expectSqlstate(duplicate, "23514")))._tag,
				"ExpectationFailed"
			)
			assert.equal(
				(yield* Effect.flip(expectConstraint(duplicate, factCheck, "23505")))._tag,
				"ExpectationFailed"
			)
			assert.equal(
				(yield* Effect.flip(expectConstraint(duplicate, factKey, "23514")))._tag,
				"ExpectationFailed"
			)
			assert.equal(
				(yield* Effect.flip(expectSqlstate(Effect.fail("plain"), "23505")))._tag,
				"ExpectationFailed"
			)
		})
	)

	it.effect(
		"an expectation observes a fresh attempt after SERIALIZABLE's refusal, a bounded number of times, and fails closed",
		() =>
			Effect.gen(function* () {
				/** An attempt failing its n-th run with the SQLSTATE `codeOf` gives n, counting its runs. */
				const scripted = (codeOf: (run: number) => string) =>
					Effect.map(Ref.make(0), (runs) => ({
						attempt: Effect.flatMap(
							Ref.getAndUpdate(runs, (n) => n + 1),
							(n) => Effect.fail({ code: codeOf(n), message: `run ${n}` })
						),
						runs: Ref.get(runs)
					}))
				const refusedTwice = yield* scripted((n) =>
					n === 0 ? "40001" : n === 1 ? "40P01" : "23505"
				)
				assert.equal((yield* expectSqlstate(refusedTwice.attempt, "23505")).code, "23505")
				const refusedTwiceRuns = yield* refusedTwice.runs
				assert.equal(refusedTwiceRuns, 3)
				const alwaysRefused = yield* scripted(() => "40001")
				assert.equal(
					(yield* Effect.flip(expectConstraint(alwaysRefused.attempt, factKey, "23505")))._tag,
					"ExpectationFailed"
				)
				const alwaysRefusedRuns = yield* alwaysRefused.runs
				assert.equal(alwaysRefusedRuns, expectationAttempts)
				const refusalExpected = yield* scripted((n) => (n === 0 ? "40001" : "23505"))
				yield* expectSqlstate(refusalExpected.attempt, "40001")
				const refusalExpectedRuns = yield* refusalExpected.runs
				assert.equal(refusalExpectedRuns, 1)
			})
	)
})
