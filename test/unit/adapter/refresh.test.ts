import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import {
	array,
	characterOf,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string
} from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Cause,
	Duration,
	Effect,
	Exit,
	Formatter,
	Option,
	Result,
	Schema,
	String as Str
} from "effect"
import { textArray } from "#adapter/admission/roles.ts"
import {
	CommitUnknown,
	ExecutionFailure,
	TransientFailure,
	TransportFailure
} from "#adapter/errors/execution.ts"

import {
	AcquisitionBudgetExceeded,
	ConcurrentRefresh,
	Deadlock,
	SerializationFailure,
	type ServerError,
	type TransientReason
} from "#adapter/errors/failures.ts"

import {
	concurrentRefreshDetail,
	concurrentRefreshPosition,
	populatedParams,
	populatedSql,
	refreshBlock
} from "#adapter/refresh/populated.ts"
import { classifyRefreshFailure, runRefresh } from "#adapter/refresh/run.ts"
import { refreshTargets } from "#adapter/refresh/targets.ts"
import { type CompileError, isCompileError } from "#compiler/core/errors.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { ledgerStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { RoleDesc } from "#compiler/ir/desc.ts"
import { parseSchemaInput, schemaArtifacts } from "#compiler/program/schema.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, role, schema } from "#compiler/public/schema.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import { assert, defined, refusalLoc, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { ledgerPrologue } from "#test/support/flight/model.ts"
import {
	answeringScript,
	immediateDelivery,
	refusedAnswer,
	rows,
	type Script,
	scriptedPool,
	scriptedSession,
	texts
} from "#test/support/flight/scripted.ts"
import { installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"

import { regex } from "arkregex"
/**
 * db.refresh without PostgreSQL: which views a call refreshes and in which order, its refusals before any SQL, the
 * catalog statements and the block that decide plain or CONCURRENTLY in the server, its one flight on a scripted
 * session (./support.ts), and how a failed statement or COMMIT ends the refresh.
 *
 * Three derived relations: B and A at level 1, written in that order, and C at level 2 over B.
 */
const Sitting = relation(
	"Sitting",
	{ id: uuid, student: uuid, week: pg.integer, passed: pg.boolean },
	["id"]
)
const Edu = schema("Edu", { Sitting }, [])
const weekly = query(Edu).rule((r) => {
	const { id, student, week, passed } = v(Sitting)
	return r.match(Sitting, { id, student, week, passed }).find({
		student,
		week,
		sittings: r.count(),
		passes: r.sum(Compute.cond(passed, Compute.literal(pg.integer, 1), 0))
	})
})

const totals = query(Edu).rule((r) => {
	const { id, student } = v(Sitting)
	return r.match(Sitting, { id, student }).find({ student, total: r.count() })
})
const B = derived("B", weekly)
const A = derived("A", totals)
const Level1 = schema.extend(Edu, { B, A }, [])
const busy = query(Level1).rule((r) => {
	const { student, week } = v(B)
	return r.match(B, { student, week }).find({ week, students: r.count() })
})
const C = derived("C", busy)
const Reports = schema.extend(Level1, { C }, [])
/** Full roles over Reports: one refreshing every view, one refreshing B alone, and one writing Sitting alone. */
const Refresher = role(Reports, "refresher", Reports.relations, { refresh: ["A", "B", "C"] })
const Partial = role(Reports, "partial", Reports.relations, { refresh: ["B"] })
const Recorder = role(Reports, "recorder", Reports.relations, { write: ["Sitting"] })
const Impostor = derived("B", totals)

const artifacts = succeeded(
	schemaArtifacts(succeeded(parseSchemaInput(Reports)), {
		installation: undefined,
		vectorSchema: undefined
	})
)

/** The names of Reports' installation, compiled without a database. */
const reportsNames = installationNamesOf(installationOf(Reports, { kind: "declared" }))

/** A role value's Description, as Db.open parses it. */
const declaredOf = (value: unknown): RoleDesc => {
	const desc = roleDescOf(value)
	if (desc === undefined) {
		throw new Error("a role built by role(...)")
	}
	return desc
}

const order = (
	relations: Arr.NonEmptyReadonlyArray<unknown>,
	as: RoleDesc
): ReadonlyArray<ReadonlyArray<string | number>> =>
	Arr.map(succeeded(refreshTargets(as, artifacts, relations)), (t) => [
		t.relation,
		t.level,
		t.position,
		t.view.schema,
		t.view.name
	])

const refusal = (relations: Arr.NonEmptyReadonlyArray<unknown>, as: RoleDesc): CompileError => {
	const targets = refreshTargets(as, artifacts, relations)
	if (Result.isSuccess(targets)) {
		throw new Error("expected a refusal")
	}
	return targets.failure
}

describe("db.refresh targets", () => {
	it("refreshes in level order, then declared order, each named relation once", () => {
		const expected = [
			["B", 1, 0, "edu", "b"],
			["A", 1, 1, "edu", "a"],
			["C", 2, 0, "edu", "c"]
		]
		const refresher = declaredOf(Refresher)
		assert.deepEqual(order([C, A, B], refresher), expected)
		assert.deepEqual(order([A, C, B, C, A], refresher), expected)
		assert.deepEqual(order([C], refresher), [["C", 2, 0, "edu", "c"]])
	})

	it("orders by level of schema extension and declared order, never by the depth of a definition's inputs", () => {
		/**
		 * Late is declared at level 2 after C but reads only the base, so its definition is as shallow as A's and
		 * B's: a depth order would refresh it at level 1 and sort A before B by name.
		 */
		const passes = query(Edu).rule((r) => {
			const { id, student, passed } = v(Sitting)
			return r
				.match(Sitting, { id, student, passed })
				.find({ student, passed, sittings: r.count() })
		})
		const Late = derived("Late", passes)
		const Extended = schema.extend(Level1, { C, Late }, [])
		const LateRefresher = role(Extended, "refresher", Extended.relations, {
			refresh: ["A", "B", "C", "Late"]
		})
		const built = succeeded(
			schemaArtifacts(succeeded(parseSchemaInput(Extended)), {
				installation: undefined,
				vectorSchema: undefined
			})
		)
		const targets = succeeded(refreshTargets(declaredOf(LateRefresher), built, [Late, C, A, B]))
		assert.deepEqual(
			Arr.map(targets, (t) => [t.relation, t.level, t.position]),
			[
				["B", 1, 0],
				["A", 1, 1],
				["C", 2, 0],
				["Late", 2, 1]
			]
		)
	})

	it("accepts a JavaScript look-alike of a derived relation value, checked as a built one", () => {
		assert.deepEqual(
			order([{ kind: "derived", name: "A", definition: totals }], declaredOf(Refresher)),
			[["A", 1, 1, "edu", "a"]]
		)
	})

	it("refuses a relation outside the role's refresh list with OutsideRole", () => {
		const e = refusal([B, C], declaredOf(Partial))
		assert.ok(isCompileError(e))
		assert.equal(e.reason._tag, "OutsideRole")
		assert.equal(refusal([B], declaredOf(Recorder)).reason._tag, "OutsideRole")
	})

	/** What is handed in place of a derived relation of the schema. */
	type NotDerived =
		| "a base relation"
		| "a name"
		| "a number"
		| "an empty object"
		| "a derived relation of another definition"
		| "a derived relation the schema lacks"
	const notDerived: Arr.NonEmptyReadonlyArray<readonly [NotDerived, unknown]> = [
		["a base relation", Sitting],
		["a name", "B"],
		["a number", 1],
		["an empty object", {}],
		["a derived relation of another definition", Impostor],
		["a derived relation the schema lacks", derived("D", totals)]
	]

	it.effect(
		"refuses a value that is no derived relation of the schema with MalformedDescription",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/adapter/refresh-not-derived",
						generator: element<readonly [NotDerived, unknown]>(notDerived),
						literal: (row) => Formatter.format(row[0]),
						limit: notDerived.length,
						features: features<NotDerived>(Arr.map(notDerived, ([name]) => name)),
						caseHang: Duration.minutes(2)
					},
					(row, c) =>
						Effect.sync(() => {
							const [name, value] = row
							c.note(name)
							const e = refusal([value], declaredOf(Refresher))
							assert.equal(e.reason._tag, "MalformedDescription", name)
							assert.equal(formatLoc(refusalLoc(e)), "db.refresh")
						})
				)
			)
	)
})

/**
 * PostgreSQL's reading of a text[] literal whose elements are all quoted (array_in): inside the quotes a backslash
 * takes the next character as it is and a bare quote ends the element; any other text is no such literal.
 */
const readTextArray = (literal: string): ReadonlyArray<string> | "unread" => {
	if (literal === "{}") {
		return []
	}
	if (!Str.startsWith("{")(literal)) {
		return "unread"
	}
	const out: Array<string> = []
	let i = 1
	for (;;) {
		if (literal[i] !== '"') {
			return "unread"
		}
		i++
		let element = ""
		for (;;) {
			const ch = literal[i]
			if (ch === undefined) {
				return "unread"
			}
			if (ch === '"') {
				break
			}
			if (ch === "\\") {
				const next = literal[i + 1]
				if (next === undefined) {
					return "unread"
				}
				element += next
				i += 2
			} else {
				element += ch
				i++
			}
		}
		out.push(element)
		i++
		if (literal[i] === "}") {
			return i === literal.length - 1 ? out : "unread"
		}
		if (literal[i] !== ",") {
			return "unread"
		}
		i++
	}
}

/** A block's DETAIL: one naming a target's position, or one naming none. */
type Detail =
	| { readonly kind: "a position"; readonly position: number }
	| { readonly kind: "no position"; readonly detail: string | undefined }

/** Every position below a hundred, and the near misses of a DETAIL that names one. */
const detailGen: Gen<Detail> = oneOf<Detail>([
	map(int(0, 99), (position) => ({ kind: "a position", position })),
	map(
		element([
			undefined,
			"",
			"ConcurrentRefresh ",
			"ConcurrentRefresh 01",
			"ConcurrentRefresh -1",
			"x 1"
		]),
		(detail) => ({ kind: "no position", detail })
	)
])

type TextArrayFeature =
	| "no element"
	| "an empty element"
	| "an element with a quote"
	| "an element with a backslash"
	| "an element with a comma or brace"
	| "a repeated view"

describe("plain or CONCURRENTLY", () => {
	it.effect(
		"passes the views as one text[] literal PostgreSQL reads back as them, each once, whatever their order",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/text-array",
						draw: drawn(
							array(
								string(characterOf(["a", "Z", " ", '"', "\\", ",", "{", "}", "é", "😀"]), {
									min: 0,
									max: 5
								}),
								{ min: 0, max: 4 }
							)
						),
						literal: Formatter.format,
						features: features<TextArrayFeature>([
							"no element",
							"an empty element",
							"an element with a quote",
							"an element with a backslash",
							"an element with a comma or brace",
							"a repeated view"
						]),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(views, c) =>
						Effect.sync(() => {
							if (views.length === 0) {
								c.note("no element")
							}
							for (const view of views) {
								if (view === "") {
									c.note("an empty element")
								}
								if (Str.includes('"')(view)) {
									c.note("an element with a quote")
								}
								if (Str.includes("\\")(view)) {
									c.note("an element with a backslash")
								}
								if (regex("[,{}]", "u").test(view)) {
									c.note("an element with a comma or brace")
								}
							}
							if (new Set(views).size < views.length) {
								c.note("a repeated view")
							}
							assert.deepEqual(readTextArray(textArray(views)), views)
							const params = populatedParams("edu", views)
							const [schemaParam, viewsParam] = params
							assert.equal(schemaParam, "edu")
							const read = readTextArray(defined(viewsParam, "the views parameter"))
							assert.ok(read !== "unread", "the views parameter is no text[] literal")
							unorderedEqual(read, [...new Set(views)], "each view once")
							assert.deepEqual(
								populatedParams("edu", Arr.reverse(views)),
								params,
								"whatever their order"
							)
						})
				)
			)
	)

	it.effect(
		"names the refused target by its position in refresh order, and nothing else as one",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/adapter/refresh-position",
						generator: detailGen,
						literal: Formatter.format,
						limit: 200,
						features: features<Detail["kind"]>(["a position", "no position"]),
						caseHang: Duration.minutes(2)
					},
					(detail, c) =>
						Effect.sync(() => {
							c.note(detail.kind)
							assert.equal(
								concurrentRefreshPosition(
									detail.kind === "a position"
										? concurrentRefreshDetail(detail.position)
										: detail.detail
								),
								detail.kind === "a position" ? detail.position : undefined
							)
						})
				)
			)
	)
})

/**
 * A failure as its tag, its TransientFailure reason and the SQLSTATE of the server's report it carries, or its
 * ExecutionFailure's SQLSTATE: what a refresh's caller tells failures apart by.
 */
type Told =
	| { readonly transient: TransientReason; readonly sqlstate: string }
	| { readonly execution: string }
	| { readonly other: unknown }

const told = (failure: unknown): Told =>
	Schema.is(TransientFailure)(failure)
		? { transient: failure.reason, sqlstate: failure.error.sqlstate }
		: Schema.is(ExecutionFailure)(failure) && failure.reason._tag === "ServerError"
			? { execution: failure.reason.sqlstate }
			: { other: failure }
const serialization: Told = { transient: SerializationFailure.make(), sqlstate: "40001" }

const targetsOf = (relations: Arr.NonEmptyReadonlyArray<unknown>) =>
	succeeded(refreshTargets(declaredOf(Refresher), artifacts, relations))

/** What a refresh runs as: the refresher's role, holding no claims. */
const eduLedger = ledgerStatements("edu")
if (!eduLedger.ok) {
	throw new Error(`the ledger statements of edu: ${eduLedger.error.message}`)
}

/** The refresher's prologue: the fence on edu's ledger, then its role with no claims. */
const asRefresher = ledgerPrologue(
	eduLedger.value,
	"edu__refresher",
	"",
	SchemaFingerprint("edu-snapshot")
)

/**
 * A session that reports the named views populated and otherwise answers as `script` says: the block succeeds unless
 * the script refuses it.
 * A session whose server answers the prologue that enters the refresher, and the populated read, as PostgreSQL does,
 * and every other statement as `script` says.
 */
const refreshSession = (populated: ReadonlyArray<string>, script: Script) =>
	scriptedSession(
		{
			...script,
			statement: (query) => {
				if (
					query.sql === asRefresher.fence.server.sql ||
					query.sql === asRefresher.enter.server.sql
				) {
					return rows()
				}
				if (query.sql === populatedSql) {
					return rows(...Arr.map(populated, (v) => [v, "true"]))
				}
				return script.statement(query)
			}
		},
		immediateDelivery
	)

/** The block's refusal of a view another refresher rewrote after the snapshot: the target at `position`. */
const rewrittenAt = (position: number): Script => ({
	...answeringScript,
	statement: (query: { readonly sql: string }) =>
		query.sql !== populatedSql
			? {
					_tag: "refused" as const,
					error: serverError({
						...nothingReported,
						sqlstate: sqlstates.grizzleConcurrentChange,
						detail: concurrentRefreshDetail(position)
					})
				}
			: rows()
})

/** The refresh of `relations` on `session`, its exit. */
const refreshOn = (
	session: ReturnType<typeof scriptedSession>,
	relations: Arr.NonEmptyReadonlyArray<unknown>
) =>
	Effect.exit(
		runRefresh(
			{ pool: scriptedPool({ lease: Effect.succeed(session) }), prologue: asRefresher },
			targetsOf(relations)
		)
	)

/** The error an exit fails with: a success, or a failure with no error, fails the assertion. */
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
	assert.ok(Exit.isFailure(exit), "the refresh fails")
	return Option.getOrThrow(Cause.findErrorOption(exit.cause))
}

describe("how a refresh ends", () => {
	it.effect("fails with TransientFailure on 40001 and 40P01 at any statement", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/adapter/refresh-transients",
					generator: element<readonly ["40001" | "40P01", TransientReason]>([
						["40001", SerializationFailure.make()],
						["40P01", Deadlock.make()]
					]),
					literal: (row) => Formatter.format(row[0]),
					limit: 2,
					features: features<"40001" | "40P01">(["40001", "40P01"]),
					caseHang: Duration.minutes(2)
				},
				([sqlstate, reason], c) =>
					Effect.sync(() => {
						c.note(sqlstate)
						const raised = serverError({ ...nothingReported, sqlstate })
						assert.deepEqual(
							classifyRefreshFailure(raised),
							TransientFailure.make({ reason, error: raised })
						)
					})
			)
		)
	)

	/**
	 * The other refusals of a refresh statement: a privilege refusal, and a 23505 or a 21000, which contradict a view's
	 * proven key.
	 */
	type OtherRefusal = "42501" | "23505" | "21000"
	const otherRefusals: Arr.NonEmptyReadonlyArray<readonly [OtherRefusal, ServerError]> = [
		["42501", serverError({ ...nothingReported, sqlstate: "42501" })],
		[
			"23505",
			serverError({
				...nothingReported,
				sqlstate: "23505",
				constraint: reportsNames.viewKeyIndex(B, ["student", "week"])
			})
		],
		["21000", serverError({ ...nothingReported, sqlstate: "21000" })]
	]

	it.effect(
		"fails closed on every other refusal, a 23505 or a 21000 among them: ExecutionFailure with the server's report, committing nothing",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/adapter/refresh-refusals",
						generator: element<readonly [OtherRefusal, ServerError]>(otherRefusals),
						literal: (row) => Formatter.format(row[0]),
						limit: otherRefusals.length,
						features: features<OtherRefusal>(Arr.map(otherRefusals, ([sqlstate]) => sqlstate)),
						caseHang: Duration.minutes(2)
					},
					([sqlstate, raised], c) =>
						Effect.gen(function* () {
							c.note(sqlstate)
							const denied = classifyRefreshFailure(raised)
							assert.ok(Schema.is(ExecutionFailure)(denied))
							assert.equal(denied.reason, raised)
							const session = refreshSession(["b"], {
								...answeringScript,
								statement: (query) =>
									query.sql !== populatedSql ? { _tag: "refused", error: raised } : rows()
							})
							const failure = failureOf(yield* refreshOn(session, [B]))
							assert.ok(Schema.is(ExecutionFailure)(failure))
							assert.deepEqual(failure.reason, raised)
							assert.deepEqual(session.committed(), [])
						})
				)
			)
	)

	it.effect(
		"reads populated views, then the block that checks and refreshes in refresh order, and commits, in one SERIALIZABLE flight",
		() =>
			Effect.gen(function* () {
				const session = refreshSession(["b"], { ...answeringScript, statement: () => rows() })
				const exit = yield* refreshOn(session, [C, A, B])
				assert.ok(Exit.isSuccess(exit), "the refresh succeeds")
				const [only, ...rest] = session.flights()
				assert.deepEqual(rest, [])
				assert.deepEqual(texts(only), [
					"BEGIN ISOLATION LEVEL SERIALIZABLE",
					asRefresher.fence.server.sql,
					asRefresher.enter.server.sql,
					populatedSql,
					refreshBlock([
						{ schema: "edu", name: "b" },
						{ schema: "edu", name: "a" },
						{ schema: "edu", name: "c" }
					]),
					"COMMIT"
				])
				assert.deepEqual(
					Arr.map(exit.value.statements, (s) => [s.relation, s.concurrently]),
					[
						["B", true],
						["A", false],
						["C", false]
					]
				)
			})
	)

	it.effect(
		"refuses a plain refresh of a view another refresher populated after the snapshot, refreshing nothing",
		() =>
			Effect.gen(function* () {
				const position = Option.getOrThrow(
					Arr.findFirstIndex(targetsOf([A, B]), (t) => t.relation === "A")
				)
				const session = refreshSession(["b"], rewrittenAt(position))
				const failure = failureOf(yield* refreshOn(session, [A, B]))
				assert.deepEqual(told(failure), {
					transient: ConcurrentRefresh.make({ relation: "A" }),
					sqlstate: sqlstates.grizzleConcurrentChange
				})
				assert.equal(session.flights().length, 1)
				assert.deepEqual(session.committed(), [])
				/** A 40Z01 that names no target is no ConcurrentRefresh. */
				const stray = refreshSession(["b"], rewrittenAt(9))
				const strayFailure = failureOf(yield* refreshOn(stray, [A, B]))
				assert.deepEqual(told(strayFailure), { execution: sqlstates.grizzleConcurrentChange })
			})
	)

	it.effect(
		"ends as a refused statement or COMMIT, a lost COMMIT, a lost connection or a failed acquisition say",
		() =>
			Effect.gen(function* () {
				/** A refresh statement's refusal inside the block keeps its SQLSTATE. */
				const refreshing = (sqlstate: string) =>
					refreshSession(["b"], {
						...answeringScript,
						statement: (query) => (query.sql !== populatedSql ? refusedAnswer(sqlstate) : rows())
					})
				assert.deepEqual(
					(yield* refreshOn(refreshing("40001"), [B])).pipe(failureOf, told),
					serialization
				)
				const atCommit = refreshSession(["b"], {
					...answeringScript,
					statement: () => rows(),
					commit: () => serverError({ ...nothingReported, sqlstate: "40001" })
				})
				assert.deepEqual((yield* refreshOn(atCommit, [B])).pipe(failureOf, told), serialization)
				const lostCommit = refreshSession(["b"], {
					...answeringScript,
					statement: () => rows(),
					commit: () => "lose"
				})
				assert.ok((yield* refreshOn(lostCommit, [B])).pipe(failureOf, Schema.is(CommitUnknown)))
				/** Lost at a statement of the one flight, which carried COMMIT: the commit's fate is unknown. */
				const lost = scriptedSession(
					{ ...answeringScript, statement: () => ({ _tag: "lose" }) },
					immediateDelivery
				)
				assert.ok((yield* refreshOn(lost, [B])).pipe(failureOf, Schema.is(CommitUnknown)))
				const unacquired = yield* Effect.exit(
					runRefresh(
						{
							prologue: asRefresher,
							pool: scriptedPool({
								lease: Effect.fail(
									AcquisitionBudgetExceeded.make({ millis: 1, sessions: 1, leased: 1, max: 1 })
								)
							})
						},
						targetsOf([B])
					)
				)
				const acquire = failureOf(unacquired)
				assert.ok(Schema.is(TransportFailure)(acquire) && acquire.stage === "acquire")
			})
	)
})
