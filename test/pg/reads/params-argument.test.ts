import { layer } from "@effect/vitest"
import { assertInstanceOf } from "@effect/vitest/utils"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Exit, Formatter, Option } from "effect"
import { type ApplyError, type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { ReaderValue } from "#adapter/reader/reader.ts"
import { type CursorError } from "#compiler/core/errors.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { dbReader, dbRuntime } from "#test/support/runtime-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A program's parameter argument at an opened Db, a read's and a ChangeSet's: the argument is a record, read by the
 * program's declared names (adapter/reader/params.ts readParams). Any other value a JavaScript caller passes, which
 * ParamArg refuses (types/core/phantom.ts), is refused with the EncodingFailure factShape naming no parameter, a
 * read's as ReadError{stage: "encode"} and a write's as itself, whether or not the program declares a parameter:
 * undefined, null, a number, a string, a boolean, a bigint, a symbol, a function or an array, the last two even holding
 * the parameters as properties. A record, plain or frozen, answers. A record with a key naming no declared parameter,
 * which ParamArg refuses too, is refused the same way by every program, and answered by get by key, whose argument
 * may be a whole fact.
 *
 * The calls cover each door to the shared boundary: execute, page and a compiled handle's execute of a query without
 * parameters (reader/params.ts hostParams), execute of a query with one, get by key (reader.ts get reads the key
 * through readKeyValues, which projects the key's fields), and db.apply of a ChangeSet without parameters and of one
 * with a read-back's parameter, and a compiled ChangeSet's apply (apply/run.ts declaredParams), each through the
 * runtime a JavaScript caller reaches. Every call meets every argument kind (exhaust), each kind built for that call: a
 * record holds the program's live parameters, `{}` for one without any.
 */
const calls = [
	"execute without parameters",
	"page without parameters",
	"compiled execute without parameters",
	"execute with a parameter",
	"get by key",
	"apply without parameters",
	"apply with a parameter",
	"compiled apply without parameters"
] as const
type Call = (typeof calls)[number]

/** The calls that apply a ChangeSet, whose refusal is the EncodingFailure itself, never wrapped in a ReadFailure. */
const writeCalls: ReadonlyArray<Call> = [
	"apply without parameters",
	"apply with a parameter",
	"compiled apply without parameters"
]

const records = ["a record", "a frozen record"] as const

/** A record of the read's live parameters and one key no parameter is named. */
const strayKey = "a record with a key naming no parameter"
const nonRecords = [
	"undefined",
	"null",
	"a number",
	"a string",
	"a boolean",
	"a bigint",
	"a symbol",
	"a function holding the parameters",
	"an array holding the parameters"
] as const
type NonRecord = (typeof nonRecords)[number]
type ArgumentKind = (typeof records)[number] | typeof strayKey | NonRecord

const argumentKinds: Arr.NonEmptyReadonlyArray<ArgumentKind> = [...records, strayKey, ...nonRecords]

type ArgumentFeature =
	| `${Call}: ${"a record answered" | "no record refused"}`
	| `${NonRecord} refused`
	| "a stray key refused"
	| "get by key: a stray key answered"

/**
 * Whether `call` answers an argument of `kind`: every read answers a record of its live parameters; a stray key is
 * answered only by get by key, whose key is read off a fact by its fields; no other value is.
 */
const answers = (call: Call, kind: ArgumentKind): boolean =>
	kind === "a record" || kind === "a frozen record" || (kind === strayKey && call === "get by key")

const isNonRecord = (kind: ArgumentKind): kind is NonRecord =>
	Arr.some(nonRecords, (k) => k === kind)

/** The argument of `kind` for a read whose live parameters are `live`. */
const argumentOf = (kind: ArgumentKind, live: Readonly<Record<string, unknown>>): unknown => {
	switch (kind) {
		case "a record":
			return { ...live }
		case "a frozen record":
			return Object.freeze({ ...live })
		case strayKey:
			return { ...live, x: 1 }
		case "undefined":
			return undefined
		case "null":
			return null
		case "a number":
			return 42
		case "a string":
			return "account"
		case "a boolean":
			return true
		case "a bigint":
			return 1n
		case "a symbol":
			return Symbol("params")
		case "a function holding the parameters":
			return Object.assign(() => undefined, live)
		case "an array holding the parameters":
			return Object.assign([], live)
	}
}

/** A program, its live parameters, and the call that passes it an argument. */
interface Read {
	readonly live: Readonly<Record<string, unknown>>
	readonly call: (argument: unknown) => Effect.Effect<unknown, ReadError | CursorError | ApplyError>
}

/** db.apply as a JavaScript caller reaches it, taking any argument (runtime-db.ts DbRuntime). */
interface ApplyValue {
	apply(changes: unknown, params: unknown): Effect.Effect<unknown, ApplyError>
}

/** A compiled ChangeSet's apply as a JavaScript caller reaches it, taking any argument. */
interface CompiledApplyValue {
	apply(params: unknown): Effect.Effect<unknown, ApplyError>
}

layer(Substrate.layer, { excludeTestServices: true })("a program's parameter argument", (it) => {
	it.effect(
		"is a record of the program's parameters: any other value is refused at encode, whether or not the program declares a parameter",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* installed(W.Work, workFacts, { label: "real", extensions: [] })
					const s = o.schema
					const tasks = query(s).rule((r) => {
						const { id } = v(W.Task, "task")
						return r.match(W.Task, { id }).find({ id })
					})
					const ordered = tasks.orderBy(["id", "asc"])
					const unchanged = ChangeSet.empty(s)
					const readBack = ChangeSet.empty(s).read("tasks", () =>
						query(s).rule((r) => {
							const { id } = v(W.Task, "task")
							return r
								.match(W.Task, { id, account: r.param("account", W.Task.fields.account) })
								.find({ id })
						})
					)
					return yield* Effect.gen(function* () {
						const db = yield* Db.open(o.server.roles.app, {})
						const reader: ReaderValue = dbReader(db)
						const compiled = yield* reader.compile(tasks)
						const runtime = defined(dbRuntime(db), "the runtime of the opened Db")
						const writer: ApplyValue = runtime.methods
						const compiledChange: CompiledApplyValue = yield* runtime.compile(unchanged)
						const reads: { readonly [C in Call]: Read } = {
							"execute without parameters": { live: {}, call: (a) => reader.execute(tasks, a) },
							"page without parameters": {
								live: {},
								call: (a) => reader.page(ordered, a, { first: 2 })
							},
							"compiled execute without parameters": { live: {}, call: (a) => compiled.execute(a) },
							"execute with a parameter": {
								live: { account: a1 },
								call: (a) => reader.execute(W.workReads(s).automaticTasksFor, a)
							},
							"get by key": { live: { id: t1 }, call: (a) => reader.get(W.Task, a) },
							"apply without parameters": { live: {}, call: (a) => writer.apply(unchanged, a) },
							"apply with a parameter": {
								live: { account: a1 },
								call: (a) => writer.apply(readBack, a)
							},
							"compiled apply without parameters": {
								live: {},
								call: (a) => compiledChange.apply(a)
							}
						}
						return yield* exhaust(
							{
								suite: "pg/reads/params-argument",
								generator: (source) =>
									[source.draw(element(calls)), source.draw(element(argumentKinds))] as const,
								literal: Formatter.format,
								limit: calls.length * argumentKinds.length,
								coverage: requiredInSpace<ArgumentFeature>([
									...Arr.flatMap(calls, (call): Arr.NonEmptyReadonlyArray<ArgumentFeature> => [
										`${call}: a record answered`,
										`${call}: no record refused`
									]),
									...Arr.map(nonRecords, (kind): ArgumentFeature => `${kind} refused`),
									"a stray key refused",
									"get by key: a stray key answered"
								]),
								caseHang,
								box: "every call of a read and a write door, each with every argument kind built for its program",
								oracle: {
									kind: "specification",
									name: "readParams's contract: a record of the program's parameters answers, any other argument is refused factShape naming no parameter, and a key's get projects its fields"
								}
							},
							([call, kind], c) =>
								Effect.gen(function* () {
									const read = reads[call]
									const argument = argumentOf(kind, read.live)
									const what = `${call} with ${kind}`
									if (answers(call, kind)) {
										yield* read.call(argument)
										c.note(
											kind === strayKey
												? "get by key: a stray key answered"
												: `${call}: a record answered`
										)
										return
									}
									const exit = yield* Effect.exit(read.call(argument))
									if (Exit.isSuccess(exit)) {
										return assert.fail(`${what} answered`)
									}
									const refusal = defined(
										Option.getOrUndefined(Exit.findErrorOption(exit)),
										`${what} fails, not dies`
									)
									if (!Arr.contains(writeCalls, call)) {
										assertInstanceOf(refusal, ReadFailure, `${what}: not a ReadFailure`)
									}
									const reason = refusal instanceof ReadFailure ? refusal.reason : refusal
									if (reason._tag !== "EncodingFailure") {
										return assert.fail(
											`${what} is refused at encode by its codec, not ${reason._tag}`
										)
									}
									assert.equal(reason.reason._tag, "factShape", what)
									assert.deepEqual(reason.place, { _tag: "Fact" }, `${what} names no parameter`)
									if (isNonRecord(kind)) {
										c.note(`${call}: no record refused`)
										c.note(`${kind} refused`)
									} else {
										c.note("a stray key refused")
									}
								})
						)
					}).pipe(Effect.scoped, withLayer(o.layer))
				}).pipe(Effect.scoped)
			)
	)
})
