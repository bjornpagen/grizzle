import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, map, weighted } from "@grizzle/testing/gen"
import { passed, type Wild, WILD_KINDS, type WildKind, wild, wildOf } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { memberOps } from "#adapter/db/handles.ts"
import type { ValueFault } from "#compiler/core/errors.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { EncodingFailure, pg, query, relation, schema, span, str, uuid, v } from "#index.ts"

import { tappedPool } from "#test/pg/api-errors/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, assertVariant } from "#test/support/assert.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import {
	installationGroup,
	replaceRows,
	type ReplacedStatement
} from "#test/support/substrate/replace.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The public-API error matrix, the write side: each ApplyError that grizzle's own code decides, through a served
 * change member's apply, as two properties.
 *
 * - EncodingFailure: a fact or parameter value its codec refuses is refused before any SQL, with the fault's word and
 *   the parameter or member it belongs to as its slot. Over drawn values, one field of an otherwise live fact at a time
 *   (an integer, a bigint, a boolean, a refined text, a uuid, a span), each a Wild value (@grizzle/testing/lsw)
 *   or one a codec documents refusing with a known fault (planted, since a wild draw rarely lands on one), passed as a
 *   call's fact of an array member, or a scalar parameter of a described member. A wild value the codec admits is
 *   answered, never a defect (drawn as an arm of its own too, since a wild draw rarely lands on one either); a refused
 *   one is EncodingFailure, a planted one with its fault, a parameter's with the parameter as its slot, with no frontend
 *   message sent and nothing stored.
 * - No Compute operation in a described member raises on a value: every one is total or stands with its proof, and a
 *   narrowing into a column without one is refused at compilation (PartialOperation, test/unit/compute/totality.test.ts),
 *   so a member's computed value is never an ExecutionFailure.
 *
 * Covered elsewhere through the public API: ExecutionFailure{compiler, compile} for an unchecked ChangeSet outside the
 * role's write list (test/pg/transactions/suites/apply.ts) and for a refresh outside its refresh list, TransientFailure from
 * an apply (test/schedules/write/races.test.ts, which interleaves concurrent writers) and from a refresh member
 * (test/pg/derived/refresh/refresh.test.ts).
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
const Fixture = schema("ApiErrors", { Typed, Seed }, [])

const seed = "00000000-0000-4000-8000-000000000001"
/** The installation's one Seed fact, which every reset writes back with the case's rows (substrate/replace.ts). */
const seedRow = (names: Names): ReplacedStatement => ({
	sql: `INSERT INTO ${names.table(Seed)} (${names.column(Seed, "id")}) VALUES ($1::uuid)`,
	params: [seed]
})
const fresh = "00000000-0000-4000-8000-000000000003"

/**
 * A JavaScript caller's parameter argument, holding a value of any type, which the types refuse and the member's
 * boundary judges: the test's own data.
 */
const callersParams = (params: Readonly<Record<string, unknown>>): ParamMap =>
	trusted<ParamMap>(params)

/**
 * The described member's parameters, every field but the key, which it reads from Seed, and a live value of each. A
 * parameters argument names exactly these: one with a key that names no parameter is refused whole, as a Fact.
 */
const liveParams = {
	n: 1,
	b: 1n,
	flag: true,
	label: "ab",
	during: { start: 0n, end: 1n }
} as const
type Param = keyof typeof liveParams
const paramFields: Arr.NonEmptyReadonlyArray<Param> = ["n", "b", "flag", "label", "during"]

/** The fields a value is drawn into, and a live value of each: the key and the described member's parameters. */
const live = { id: fresh, ...liveParams } as const
type Field = keyof typeof live
const fields: Arr.NonEmptyReadonlyArray<Field> = ["id", ...paramFields]

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

/** The form a fact is planted in: a call's fact of an array member, or a parameter of the described member. */
type Form = "array" | "parameter"
const forms: Arr.NonEmptyReadonlyArray<Form> = ["array", "parameter"]

type Drawn = { readonly kind: "planted" } | { readonly kind: "wild"; readonly wild: Wild }

/** A field and the form it is planted in: any field of a member's fact, or a parameter of the described member. */
type Pair =
	| { readonly field: Field; readonly form: "array" }
	| { readonly field: Param; readonly form: "parameter" }

type EncodingCase = Pair & { readonly value: Drawn }

type EncodingFeature = `planted ${Field} as ${Form}` | `wild ${WildKind} refused` | "wild admitted"

/** The field and form pairs a case draws: every field of a call's fact, and every parameter. */
const plantedPairs: Arr.NonEmptyReadonlyArray<Pair> = [
	...Arr.map(fields, (field): Pair => ({ field, form: "array" })),
	...Arr.map(paramFields, (field): Pair => ({ field, form: "parameter" }))
]

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
	...Arr.map(plantedPairs, (pair): Kept<EncodingCase, EncodingFeature> => ({
		note: `the refused ${pair.field} as ${pair.form}`,
		sketch: { ...pair, value: { kind: "planted" } },
		draws: "",
		reaches: [`planted ${pair.field} as ${pair.form}`]
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
			form: "array",
			value: { kind: "wild", wild: wildOf("lone-surrogate") }
		},
		draws: "",
		reaches: ["wild lone-surrogate refused"]
	}
]

layer(Substrate.layer, { excludeTestServices: true })("ApplyError through the public API", (it) => {
	const opened = installed(
		Fixture,
		{ Seed: [{ id: seed }] },
		{ label: "real", extensions: [], programs: {} }
	)

	it.effect(
		"a value its codec refuses is EncodingFailure with its fault and slot, before any SQL; one it admits is answered",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* opened
					const s = yield* Substrate
					const names = namesOf(o.installed)
					return yield* withServedDb(o.installed, o.server.roles.app, {}, ({ ctx, load }) =>
						Effect.gen(function* () {
							const members = yield* load({
								array: changeSetOver.empty(o.schema).insert(Typed, []),
								/** The described member: every field but the key a scalar parameter of its type. */
								parameter: changeSetOver.empty(o.schema).insert(
									Typed,
									query(o.schema).rule((r) => {
										const { id } = v(Seed, "seed")
										return r.match(Seed, { id }).find({
											id,
											n: r.param("n", Typed.fields.n),
											b: r.param("b", Typed.fields.b),
											flag: r.param("flag", Typed.fields.flag),
											label: r.param("label", Typed.fields.label),
											during: r.param("during", Typed.fields.during)
										})
									})
								)
							})
							const { pool, tap } = yield* tappedPool(o.installed.as(o.server))
							const tapped = { ...ctx, pool }
							return yield* explore(
								{
									oracle: { kind: "unstated" },
									suite: "api-errors/apply encoding",
									draw: drawn(encodingCaseGen),
									literal: Formatter.format,
									kept: encodingKept,
									runs: 200,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 16,
									caseHang,
									coverage: required<EncodingFeature>(
										[
											...Arr.map(
												plantedPairs,
												({ field, form }): EncodingFeature => `planted ${field} as ${form}`
											),
											"wild admitted",
											"wild null refused",
											"wild proxy refused",
											"wild lone-surrogate refused"
										],
										{ cases: 200, sense: notesOnly }
									)
								},
								(c, cx) =>
									Effect.gen(function* () {
										yield* replaceRows(s.admin, installationGroup(names), [seedRow(names)])
										const value =
											c.value.kind === "planted" ? planted[c.field].value : passed(c.value)
										const fact: Record<string, unknown> = { ...live, [c.field]: value }
										const mark = tap.mark()
										const change = memberOps(tapped, member(members, c.form))
										const outcome = yield* Effect.result(
											c.form === "parameter"
												? Effect.suspend(() => {
														assertVariant(
															change,
															"kind",
															"program",
															"the described member takes its parameters"
														)
														return change.ops.apply(
															callersParams({ ...liveParams, [c.field]: value })
														)
													})
												: Effect.suspend(() => {
														assertVariant(
															change,
															"kind",
															"facts",
															"an array member takes its call's facts"
														)
														return change.ops.apply({ insert: { Typed: [fact] } }, {})
													})
										)
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
										const state = yield* tableState(o.installed, Typed)
										assert.deepEqual(state, [])
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
						})
					)
				}).pipe(Effect.scoped)
			)
	)
})
