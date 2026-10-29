import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { constant, element, type Gen, map, weighted } from "@grizzle/testing/gen"
import { passed, type Wild, WILD_KINDS, type WildKind, wild, wildOf } from "@grizzle/testing/lsw"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Result, Schema, Stream } from "effect"
import { isCompileError, type ValueFault } from "#compiler/core/errors.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import {
	ChangeSet,
	Compute,
	Db,
	EncodingFailure,
	ExecutionFailure,
	pg,
	query,
	relation,
	schema,
	span,
	str,
	uuid,
	v
} from "#index.ts"

import {
	type IntegerAnswer,
	type IntegerOperation,
	int4Gen,
	integerAnswer,
	integerOperations,
	operandSources,
	operandsOf,
	tappedDb
} from "#test/pg/api-errors/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, failureOf, unorderedEqual } from "#test/support/assert.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { applyRuntime } from "#test/support/runtime-db.ts"
import {
	installationGroup,
	replaceRows,
	type ReplacedStatement
} from "#test/support/substrate/replace.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * The public-API error matrix, the write side: each ApplyError that grizzle's own code decides, through db.apply, as
 * two properties.
 *
 * - EncodingFailure: a fact or parameter value its codec refuses is refused before any SQL, with the fault's word and
 *   the parameter or member it belongs to as its slot. Over drawn values, one field of an otherwise live fact at a time
 *   (an integer, a bigint, a boolean, a refined text, a uuid, a span), each a Wild value (@grizzle/testing/lsw)
 *   or one a codec documents refusing with a known fault (planted, since a wild draw rarely lands on one), passed as an
 *   array member, a Stream member, or a scalar parameter of a described member. A wild value the codec admits is
 *   answered, never a defect (drawn as an arm of its own too, since a wild draw rarely lands on one either); a refused
 *   one is EncodingFailure, a planted one with its fault, a parameter's with the parameter as its slot, with no frontend
 *   message sent and nothing stored.
 * - ExecutionFailure: a partial Compute operation in a described member carries the statement's SQLSTATE and writes
 *   nothing. Over drawn integer operations (support.ts's model of PostgreSQL's integer arithmetic, the oracle), each
 *   applied on the operands it fails on, on small ones it answers (both planted), and on drawn operands, in an insert
 *   or a put member: an operation the model fails is ExecutionFailure{server, its SQLSTATE} with nothing stored, and
 *   one it answers stores the model's value.
 *
 * Covered elsewhere through the public API: ExecutionFailure{compiler, compile} for an unchecked ChangeSet outside the
 * role's write list (test/pg/transactions/suites/apply.ts) and for a refresh outside its refresh list, TransientFailure from
 * db.apply (test/schedules/write/races.test.ts, which interleaves concurrent writers) and from
 * db.refresh (test/pg/derived/refresh/refresh.test.ts).
 *
 * Not provoked: TransportFailure and CommitUnknown arise only from a lost connection or an unacknowledged COMMIT, which
 * are infrastructure faults out of the suite's scope. A read-back's rows are converted, not validated: every value
 * PostgreSQL returns for a grizzle statement is one its column's constraints admitted, in its type's output form, and
 * the public-boundary differential reads each read-back as strictly as a read (test/pg/oracle/public/run.ts).
 */
const Typed = relation(
	"Typed",
	{
		id: uuid,
		n: pg.integer,
		b: pg.bigint,
		flag: pg.boolean,
		label: str.regex("^[a-z]{0,8}$"),
		during: span(pg.bigint)
	},
	["id"]
)
const Seed = relation("Seed", { id: uuid }, ["id"])
const Pair = relation("Pair", { id: uuid, a: pg.integer, b: pg.integer }, ["id"])
const Computed = relation("Computed", { id: uuid, value: pg.integer }, ["id"])
const Fixture = schema("ApiErrors", { Typed, Seed, Pair, Computed }, [])

const seed = "00000000-0000-4000-8000-000000000001"
/** The installation's one Seed fact, which every reset writes back with the case's rows (substrate/replace.ts). */
const seedRow = (names: Names): ReplacedStatement => ({
	sql: `INSERT INTO ${names.table(Seed)} (${names.column(Seed, "id")}) VALUES ($1::uuid)`,
	params: [seed]
})
const pair = "00000000-0000-4000-8000-000000000002"
const fresh = "00000000-0000-4000-8000-000000000003"

/** The fields a value is drawn into, and a live value of each. */
const live = {
	id: fresh,
	n: 1,
	b: 1n,
	flag: true,
	label: "ab",
	during: { start: 0n, end: 1n }
} as const
type Field = keyof typeof live
const fields: ReadonlyArray<Field> = ["id", "n", "b", "flag", "label", "during"]

/** A value each field's codec documents refusing, with its fault (scalar/values/fault.ts). */
const planted: { readonly [F in Field]: { readonly value: unknown; readonly fault: ValueFault } } =
	{
		id: { value: "not a uuid", fault: "uuidSyntax" },
		n: { value: 2 ** 40, fault: "integerRange" },
		b: { value: 2n ** 70n, fault: "integerRange" },
		flag: { value: "yes", fault: "boolType" },
		label: { value: "a\u0000b", fault: "textNul" },
		during: { value: { start: 5n, end: 1n }, fault: "spanOrder" }
	}

type Form = "array" | "Stream" | "parameter"
const forms: Arr.NonEmptyReadonlyArray<Form> = ["array", "Stream", "parameter"]

type Drawn = { readonly kind: "planted" } | { readonly kind: "wild"; readonly wild: Wild }

interface EncodingCase {
	readonly field: Field
	readonly form: Form
	readonly value: Drawn
}

type EncodingFeature =
	| `planted ${Field} as ${Form}`
	| `wild ${WildKind} refused`
	| "wild admitted"
	| "refused by the builder"

/** The field and form pairs a case draws: a parameter of the described member carries every field but the key. */
const plantedPairs: ReadonlyArray<{ readonly field: Field; readonly form: Form }> = Arr.flatMap(
	fields,
	(field) =>
		Arr.map(
			Arr.filter(forms, (form) => form !== "parameter" || field !== "id"),
			(form) => ({ field, form })
		)
)

/**
 * One of the field and form pairs, each equally often, with a value `value` draws. A parameter of the described member
 * carries every field but the key, which the member reads from Seed.
 */
const pairCase =
	(value: Gen<Drawn>): Gen<EncodingCase> =>
	(source) => ({
		...source.draw(element(nonEmptyList(plantedPairs, "the field and form pairs"))),
		value: source.draw(value)
	})

/** A wild value of any kind. */
const anyWild: Gen<Drawn> = map(wild(WILD_KINDS), (drawn): Drawn => ({ kind: "wild", wild: drawn }))

/**
 * A wild value the integer's codec admits, in any form: -0, or a number in its range where a bigint boundary expects a
 * bigint. A wild value of a pair lands on one in about one case in eighty (the integer's pairs are three of seventeen,
 * its admitted kinds two of fourteen), which the suite's cases cannot count on.
 */
const admittedCase: Gen<EncodingCase> = (source) => ({
	field: "n",
	form: source.draw(element(forms)),
	value: {
		kind: "wild",
		wild: source.draw(wild(["negative-zero", "number-for-bigint"]))
	}
})

/** A case: half a pair's planted value, and the rest a pair's wild value, but one in sixteen an admitted wild value. */
const encodingCaseGen: Gen<EncodingCase> = weighted([
	[8, pairCase(constant({ kind: "planted" }))],
	[7, pairCase(anyWild)],
	[1, admittedCase]
])

/**
 * Planted: every field's refused value in every form, which half of the cases spread over seventeen pairs reach a few
 * times a run, and a wild value the codec admits and each required wild refusal.
 */
const encodingKept: ReadonlyArray<Kept<EncodingCase, EncodingFeature>> = [
	...Arr.map(plantedPairs, ({ field, form }): Kept<EncodingCase, EncodingFeature> => ({
		note: `the refused ${field} as ${form}`,
		sketch: { field, form, value: { kind: "planted" } },
		draws: "",
		reaches: [`planted ${field} as ${form}`]
	})),
	{
		note: "a number for an integer",
		sketch: {
			field: "n",
			form: "array",
			value: { kind: "wild", wild: wildOf("number-for-bigint") }
		},
		draws: "",
		reaches: ["wild admitted"]
	},
	{
		note: "null for an integer",
		sketch: { field: "n", form: "array", value: { kind: "wild", wild: wildOf("null") } },
		draws: "",
		reaches: ["wild null refused"]
	},
	{
		note: "a proxy for a refined text parameter",
		sketch: { field: "label", form: "parameter", value: { kind: "wild", wild: wildOf("proxy") } },
		draws: "",
		reaches: ["wild proxy refused"]
	},
	{
		note: "a lone surrogate for a refined text",
		sketch: {
			field: "label",
			form: "Stream",
			value: { kind: "wild", wild: wildOf("lone-surrogate") }
		},
		draws: "",
		reaches: ["wild lone-surrogate refused"]
	}
]

type ComputeFeature =
	| `${IntegerOperation} ${"fails" | "answers"}`
	| `${"22012" | "22003"} in ${"insert" | "put"}`

type Member = "insert" | "put"

/** An operation, its drawn operands and its member, applied on each operand source's (support.ts operandSources). */
interface ComputeCase {
	readonly op: IntegerOperation
	readonly a: number
	readonly b: number
	readonly member: Member
}

const computeCaseGen: Gen<ComputeCase> = (source) => ({
	op: source.draw(element(integerOperations)),
	a: source.draw(int4Gen),
	b: source.draw(int4Gen),
	member: source.draw(element<Member>(["insert", "put"]))
})

/** What an application of `op` in `member` reaches when the model answers it `answer`. */
const reached = (
	op: IntegerOperation,
	member: Member,
	answer: IntegerAnswer
): Arr.NonEmptyReadonlyArray<ComputeFeature> =>
	answer.kind === "fails" ? [`${op} fails`, `${answer.sqlstate} in ${member}`] : [`${op} answers`]

/**
 * Planted: every operation on each operand source's operands, its drawn operands both 1, in an insert member for every
 * other operation and in a put member for the rest, so each SQLSTATE meets each member.
 */
const computeKept: ReadonlyArray<Kept<ComputeCase, ComputeFeature>> = Arr.map(
	integerOperations,
	(op, i): Kept<ComputeCase, ComputeFeature> => {
		const member: Member = i % 2 === 0 ? "insert" : "put"
		return {
			note: `${op} on its failing, total and drawn operands in ${member}`,
			sketch: { op, a: 1, b: 1, member },
			draws: "",
			reaches: Arr.flatMap(operandSources, (operands) =>
				reached(op, member, integerAnswer(op, ...operandsOf(op, operands, 1, 1)))
			)
		}
	}
)

layer(Substrate.layer, { excludeTestServices: true })("ApplyError through the public API", (it) => {
	const opened = installed(Fixture, { Seed: [{ id: seed }] }, { label: "real", extensions: [] })

	it.effect(
		"a value its codec refuses is EncodingFailure with its fault and slot, before any SQL; one it admits is answered",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* opened
					const s = yield* Substrate
					const names = namesOf(o.installed)
					/** The described member: every field but the key a scalar parameter of its type. */
					const described = query(o.schema).rule((r) => {
						const { id } = v(Seed)
						return r.match(Seed, { id }).find({
							id,
							n: r.param("n", Typed.fields.n),
							b: r.param("b", Typed.fields.b),
							flag: r.param("flag", Typed.fields.flag),
							label: r.param("label", Typed.fields.label),
							during: r.param("during", Typed.fields.during)
						})
					})
					return yield* Effect.gen(function* () {
						const untapped = yield* Db.open(o.server.roles.app, {})
						const { db, tap } = yield* tappedDb(untapped, o.installed.as(o.server))
						return yield* explore(
							{
								/**
								 * A builder refuses what it cannot read with a CompileError: a typed refusal before any SQL.
								 */
								suite: "api-errors/apply encoding",
								draw: drawn(encodingCaseGen),
								literal: Formatter.format,
								kept: encodingKept,
								runs: 200,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								steering: { kind: "none" },
								caseHang: Duration.minutes(2),
								features: features<EncodingFeature>([
									...Arr.map(
										plantedPairs,
										({ field, form }): EncodingFeature => `planted ${field} as ${form}`
									),
									"wild admitted",
									"wild null refused",
									"wild proxy refused",
									"wild lone-surrogate refused"
								])
							},
							(c, cx) =>
								Effect.gen(function* () {
									yield* replaceRows(s.admin, installationGroup(names), [seedRow(names)])
									const value =
										c.value.kind === "planted" ? planted[c.field].value : passed(c.value)
									const fact: Record<string, unknown> = { ...live, [c.field]: value }
									const built = Result.try(() => {
										const empty = changeSetOver.empty(o.schema)
										switch (c.form) {
											case "array":
												return empty.insert(Typed, [fact])
											case "Stream":
												return empty.insert(Typed, Stream.make(fact))
											case "parameter":
												return empty.insert(Typed, described)
										}
									})
									if (Result.isFailure(built)) {
										assert.ok(isCompileError(built.failure), String(built.failure))
										cx.note("refused by the builder")
										return
									}
									const params = c.form === "parameter" ? { ...live, [c.field]: value } : {}
									const mark = tap.mark()
									const outcome = yield* Effect.result(applyRuntime(db, built.success, params))
									if (Result.isSuccess(outcome)) {
										assert.ok(c.value.kind === "wild", `a planted ${c.field} is refused`)
										cx.note("wild admitted")
										return
									}
									const error = outcome.failure
									assert.ok(error instanceof EncodingFailure, String(error))
									assert.equal(
										tap.since(mark).frontend.length,
										0,
										"no statement before the refusal"
									)
									assert.deepEqual(yield* tableState(o.installed, Typed), [])
									if (c.form === "parameter") {
										assert.deepEqual(error.place, { _tag: "Slot", name: c.field })
									}
									if (c.value.kind === "planted") {
										assert.equal(error.reason._tag, planted[c.field].fault)
										cx.note(`planted ${c.field} as ${c.form}`)
									} else {
										cx.note(`wild ${c.value.wild.kind} refused`)
									}
								})
						)
					}).pipe(Effect.scoped, withLayer(o.layer))
				}).pipe(Effect.scoped)
			)
	)

	it.effect(
		"a partial Compute operation in a member is ExecutionFailure with its SQLSTATE and writes nothing; a total one stores its value",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* opened
					const s = yield* Substrate
					const names = namesOf(o.installed)
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(o.server.roles.app, {})
						return yield* explore(
							{
								suite: "api-errors/apply compute",
								draw: drawn(computeCaseGen),
								literal: Formatter.format,
								kept: computeKept,
								runs: 60,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								steering: { kind: "none" },
								caseHang: Duration.minutes(2),
								features: features<ComputeFeature>([
									...Arr.flatMap(integerOperations, (op): ReadonlyArray<ComputeFeature> => [
										`${op} fails`,
										`${op} answers`
									]),
									"22012 in insert",
									"22012 in put",
									"22003 in insert",
									"22003 in put"
								])
							},
							({ op, a: drawnA, b: drawnB, member }, cx) =>
								Effect.gen(function* () {
									const computed = query(o.schema).rule((r) => {
										const { id, a: x, b: y } = v(Pair)
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
										return r.match(Pair, { id, a: x, b: y }).find({ id, value })
									})
									const changes =
										member === "insert"
											? ChangeSet.empty(o.schema).insert(Computed, computed)
											: ChangeSet.empty(o.schema).put(Computed, computed)
									for (const operands of operandSources) {
										const [a, b] = operandsOf(op, operands, drawnA, drawnB)
										yield* replaceRows(s.admin, installationGroup(names), [
											seedRow(names),
											{
												sql: `INSERT INTO ${names.table(Pair)} (${names.column(Pair, "id")}, ${names.column(Pair, "a")}, ${names.column(Pair, "b")}) VALUES ($1::uuid, $2::int4, $3::int4)`,
												params: [pair, a, b]
											}
										])
										const answer = integerAnswer(op, a, b)
										if (answer.kind === "fails") {
											const error = yield* failureOf(db.apply(changes, {}))
											assert.ok(
												Schema.is(ExecutionFailure)(error) && error.reason._tag === "ServerError",
												`an ExecutionFailure the server raised: ${String(error)}`
											)
											const sqlstate: string = error.reason.sqlstate
											assert.equal(sqlstate, answer.sqlstate)
											assert.deepEqual(yield* tableState(o.installed, Computed), [])
										} else {
											const outcome = yield* db.apply(changes, {})
											assert.equal(outcome.kind, "accepted")
											unorderedEqual(yield* tableState(o.installed, Computed), [
												{ id: pair, value: answer.value }
											])
										}
										cx.noteAll(reached(op, member, answer))
									}
								})
						)
					}).pipe(Effect.scoped, withLayer(o.layer))
				}).pipe(Effect.scoped)
			)
	)
})
