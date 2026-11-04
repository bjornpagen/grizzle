import { layer } from "@effect/vitest"
import { assertInstanceOf } from "@effect/vitest/utils"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Exit, Formatter, Option } from "effect"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { ReaderValue } from "#adapter/reader/reader.ts"
import { type CursorError } from "#compiler/core/errors.ts"
import { query, v } from "#compiler/public/query.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { dbReader } from "#test/support/runtime-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A read's parameter argument at the public reader of an opened Db: the argument is a record, read by the program's
 * declared names (adapter/reader/params.ts readParams). Any other value a JavaScript caller passes, which ParamArg
 * refuses (types/core/phantom.ts), is refused ReadError{stage: "encode"} with the EncodingFailure a write gives the
 * same argument (factShape, naming no parameter), whether or not the read declares a parameter:
 * undefined, null, a number, a string, a boolean, a bigint, a symbol, a function or an array, the last two even holding
 * the parameters as properties. A record, plain or frozen, answers.
 *
 * The reads cover each door to the shared boundary: execute, page and a compiled handle's execute of a query without
 * parameters (reader/params.ts hostParams), execute of a query with one, and get by key (reader.ts get reads the key
 * through readParams itself). Every read meets every argument kind (exhaust), each kind built for that read: a
 * record holds the read's live parameters, `{}` for a read without any.
 */
const calls = [
	"execute without parameters",
	"page without parameters",
	"compiled execute without parameters",
	"execute with a parameter",
	"get by key"
] as const
type Call = (typeof calls)[number]

const records = ["a record", "a frozen record"] as const
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
type ArgumentKind = (typeof records)[number] | NonRecord

const argumentKinds: Arr.NonEmptyReadonlyArray<ArgumentKind> = [...records, ...nonRecords]

type ArgumentFeature =
	| `${Call}: ${"a record answered" | "no record refused"}`
	| `${NonRecord} refused`

const isNonRecord = (kind: ArgumentKind): kind is NonRecord =>
	Arr.some(nonRecords, (k) => k === kind)

/** The argument of `kind` for a read whose live parameters are `live`. */
const argumentOf = (kind: ArgumentKind, live: Readonly<Record<string, unknown>>): unknown => {
	switch (kind) {
		case "a record":
			return { ...live }
		case "a frozen record":
			return Object.freeze({ ...live })
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

/** A read, its live parameters, and the call that passes it an argument. */
interface Read {
	readonly live: Readonly<Record<string, unknown>>
	readonly call: (argument: unknown) => Effect.Effect<unknown, ReadError | CursorError>
}

layer(Substrate.layer, { excludeTestServices: true })("a read's parameter argument", (it) => {
	it.effect(
		"is a record: any other value is refused at encode, whether or not the read declares a parameter",
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
					return yield* Effect.gen(function* () {
						const reader: ReaderValue = dbReader(yield* Db.open(o.server.roles.app, {}))
						const compiled = yield* reader.compile(tasks)
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
							"get by key": { live: { id: t1 }, call: (a) => reader.get(W.Task, a) }
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
									...Arr.map(nonRecords, (kind): ArgumentFeature => `${kind} refused`)
								]),
								caseHang: Duration.minutes(2)
							},
							([call, kind], c) =>
								Effect.gen(function* () {
									const read = reads[call]
									const argument = argumentOf(kind, read.live)
									const what = `${call} with ${kind}`
									if (!isNonRecord(kind)) {
										yield* read.call(argument)
										c.note(`${call}: a record answered`)
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
									assertInstanceOf(refusal, ReadFailure, `${what}: not a ReadFailure`)
									const reason = refusal.reason
									if (reason._tag !== "EncodingFailure") {
										return assert.fail(
											`${what} is refused at encode by its codec, not ${reason._tag}`
										)
									}
									assert.equal(reason.reason._tag, "factShape", what)
									assert.deepEqual(reason.place, { _tag: "Fact" }, `${what} names no parameter`)
									c.note(`${call}: no record refused`)
									c.note(`${kind} refused`)
								})
						)
					}).pipe(Effect.scoped, withLayer(o.layer))
				}).pipe(Effect.scoped)
			)
	)
})
