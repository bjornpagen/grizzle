import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Schema } from "effect"
import { Compute, Db, pg, query, ReadFailure, relation, schema, uuid, v } from "#index.ts"
import {
	type IntegerAnswer,
	type IntegerOperation,
	int4Gen,
	integerAnswer,
	integerOperations,
	type Operands,
	operandSources,
	operandsOf
} from "#test/pg/api-errors/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, bareRecord } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * The public-API error matrix, the read side: what no other test provokes through a reader of an opened Db.
 *
 * - ReadError{stage: "execute"}: a partial Compute operation fails the read with the statement's execution failure,
 *   from db.execute, db.get and a compiled query's execute alike. Over drawn integer operations (support.ts's model
 *   of PostgreSQL's integer arithmetic, the oracle), each read on the operands it fails on, on small ones every
 *   operation answers (both planted), and on drawn operands, one row of each: an operation the model fails is
 *   ReadFailure{stage: "execute"} through every entry, and one it answers delivers the model's value through every
 *   entry.
 *
 * The other stages are provoked elsewhere through the public Db and asserted exactly: encode in the public-boundary
 * differential's refusal probes (test/pg/oracle/public); resource in
 * test/pg/reads/suites/reads.ts; capability in test/pg/reads/suites/open.ts; request in test/pg/page/page.test.ts; a
 * derived relation read before its first refresh in test/pg/derived. A delivered row is converted, not validated: every
 * value PostgreSQL returns for a grizzle statement is one its column's constraints admitted, in its type's output form,
 * and the public-boundary differential reads each such cell strictly (test/pg/oracle/public/cells.ts). A lost
 * connection's stages (transport, acquire from a server that is gone) are infrastructure faults out of scope.
 *
 * A read the server refused with `sqlstate`: ReadFailure whose reason is the server's report, at stage execute, carrying
 * the SQLSTATE (and PostgreSQL's message, whatever its words).
 */
const refusedWith = (failure: unknown, sqlstate: string, entry: string): void => {
	assert.ok(Schema.is(ReadFailure)(failure), `${entry}: ${String(failure)} is a ReadFailure`)
	const reason = failure.reason
	assert.ok(reason._tag === "ServerError", `${entry}: refused by the server`)
	const reported: string = reason.sqlstate
	assert.equal(reported, sqlstate, entry)
	assert.equal(failure.stage, "execute", entry)
}

const Pair = relation("Pair", { id: uuid, a: pg.integer, b: pg.integer }, ["id"])
const Fixture = schema("ApiReads", { Pair }, [])

/** The Pair row each operand source's operands are stored in. */
const pairOf: { readonly [O in Operands]: string } = {
	failing: "00000000-0000-4000-8000-000000000001",
	total: "00000000-0000-4000-8000-000000000002",
	drawn: "00000000-0000-4000-8000-000000000003"
}

type ReadFeature = `${IntegerOperation} ${"fails" | "answers"}` | `${"22012" | "22003"} read`

/** An operation and its drawn operands, read on each operand source's (support.ts operandSources). */
interface ReadCase {
	readonly op: IntegerOperation
	readonly a: number
	readonly b: number
}

const readCaseGen: Gen<ReadCase> = (source) => ({
	op: source.draw(element(integerOperations)),
	a: source.draw(int4Gen),
	b: source.draw(int4Gen)
})

/** What a read of `op` reaches when the model answers it `answer`. */
const reached = (
	op: IntegerOperation,
	answer: IntegerAnswer
): Arr.NonEmptyReadonlyArray<ReadFeature> =>
	answer.kind === "fails" ? [`${op} fails`, `${answer.sqlstate} read`] : [`${op} answers`]

/** Planted: every operation on each operand source's operands, its drawn operands both 1. */
const readKept: ReadonlyArray<Kept<ReadCase, ReadFeature>> = Arr.map(
	integerOperations,
	(op): Kept<ReadCase, ReadFeature> => ({
		note: `${op} on its failing, total and drawn operands`,
		sketch: { op, a: 1, b: 1 },
		draws: "",
		reaches: Arr.flatMap(operandSources, (operands) =>
			reached(op, integerAnswer(op, ...operandsOf(op, operands, 1, 1)))
		)
	})
)

layer(Substrate.layer, { excludeTestServices: true })("ReadError through the public API", (it) => {
	it.effect(
		"a partial Compute operation is ReadError{stage: execute} from execute, get and a compiled execute; a total one delivers its value",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* installed(Fixture, {}, { label: "real", extensions: [] })
					const s = yield* Substrate
					const names = namesOf(o.installed)
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(o.server.roles.app, {})
						return yield* explore(
							{
								suite: "api-errors/read compute",
								draw: drawn(readCaseGen),
								literal: Formatter.format,
								kept: readKept,
								runs: 60,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								steering: { kind: "none" },
								caseHang: Duration.minutes(2),
								features: features<ReadFeature>([
									...Arr.flatMap(integerOperations, (op): ReadonlyArray<ReadFeature> => [
										`${op} fails`,
										`${op} answers`
									]),
									"22012 read",
									"22003 read"
								])
							},
							({ op, a: drawnA, b: drawnB }, cx) =>
								Effect.gen(function* () {
									const rows = Arr.map(operandSources, (operands) => {
										const [a, b] = operandsOf(op, operands, drawnA, drawnB)
										return { id: pairOf[operands], a, b, answer: integerAnswer(op, a, b) }
									})
									yield* replaceRows(
										s.admin,
										installationGroup(names),
										Arr.map(rows, ({ id, a, b }) => ({
											sql: `INSERT INTO ${names.table(Pair)} (${names.column(Pair, "id")}, ${names.column(Pair, "a")}, ${names.column(Pair, "b")}) VALUES ($1::uuid, $2::int4, $3::int4)`,
											params: [id, a, b]
										}))
									)
									const computed = query(o.schema).rule((r) => {
										const { a: x, b: y } = v(Pair)
										const value =
											op === "div"
												? Compute.div(x, y)
												: op === "mod"
													? Compute.mod(x, y)
													: op === "add"
														? Compute.add(x, y)
														: op === "sub"
															? Compute.sub(x, y)
															: op === "mul"
																? Compute.mul(x, y)
																: op === "neg"
																	? Compute.neg(x)
																	: Compute.abs(x)
										return r
											.match(Pair, { id: r.param("id", Pair.fields.id), a: x, b: y })
											.find({ value })
									})
									for (const { id, answer } of rows) {
										const executed = Effect.flatMap(
											db.execute(computed, { id }),
											(found) => found.collect
										)
										const got = db.get(computed, { id })
										const compiled = Effect.scoped(
											Effect.flatMap(db.compile(computed), (handle) =>
												Effect.flatMap(handle.execute({ id }), (found) => found.collect)
											)
										)
										if (answer.kind === "fails") {
											refusedWith(yield* Effect.flip(executed), answer.sqlstate, "execute")
											refusedWith(yield* Effect.flip(got), answer.sqlstate, "get")
											refusedWith(
												yield* Effect.flip(compiled),
												answer.sqlstate,
												"a compiled execute"
											)
										} else {
											const row = bareRecord({ value: answer.value })
											assert.deepEqual(yield* executed, [row], "execute")
											assert.deepEqual(yield* got, Option.some(row), "get")
											assert.deepEqual(yield* compiled, [row], "a compiled execute")
										}
										cx.noteAll(reached(op, answer))
									}
								})
						)
					}).pipe(Effect.scoped, withLayer(o.layer))
				}).pipe(Effect.scoped)
			)
	)
})
