import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Exit, Formatter, Option } from "effect"
import type { CallError } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { paged } from "#compiler/public/workload.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, assertVariant, defined } from "#test/support/assert.ts"
import { answered, readOnce } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A program's parameter argument at an opened Db, a read's and a ChangeSet's: the argument, its call input's `params`,
 * is a record, read by the program's declared names (adapter/reader/params.ts readParams). Any other value a JavaScript
 * caller passes, which ParamArg refuses (types/core/phantom.ts), is refused at encode as an `input` CallError, a read's
 * and a write's alike, whether or not the program declares a parameter: undefined, null, a number, a string, a boolean,
 * a bigint, a symbol, a function or an array, the last two even holding the parameters as properties. A record, plain
 * or frozen, answers. A record with a key naming no declared parameter, which ParamArg refuses too, is refused the same
 * way by every program, and answered by a key member, whose argument may be a whole fact.
 *
 * The calls cover each door to the shared boundary, each a served member's once on a served Db: a read and a window of
 * a query without parameters (reader/params.ts hostParams), a read of a query with one, a key member (its values read
 * through readKeyValues, which projects the key's fields), and a write of a ChangeSet without parameters and of one with
 * a read-back's parameter (apply/run.ts declaredParams), each as a JavaScript caller reaches it. Every call meets every
 * argument kind (exhaust), each kind built for that call: a record holds the program's live parameters, `{}` for one
 * without any.
 *
 * - Oracle: the specification turned into a checker, ParamArg's refusals restated over the argument kinds.
 * - Plant: ~/.cache/grizzle-release/BR08/plants/params-argument-stray-key-read.patch, a record read past a key naming
 *   no parameter, must turn the property red.
 */
const calls = [
	"a read without parameters",
	"a window without parameters",
	"a read with a parameter",
	"a key member",
	"a write without parameters",
	"a write with a parameter"
] as const
type Call = (typeof calls)[number]

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
	| "a key member: a stray key answered"

/**
 * Whether `call` answers an argument of `kind`: every read answers a record of its live parameters; a stray key is
 * answered only by a key member, whose key is read off a fact by its fields; no other value is.
 */
const answers = (call: Call, kind: ArgumentKind): boolean =>
	kind === "a record" ||
	kind === "a frozen record" ||
	(kind === strayKey && call === "a key member")

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
	readonly call: (argument: unknown) => Effect.Effect<unknown, CallError>
}

layer(Substrate.layer, { excludeTestServices: true })("a program's parameter argument", (it) => {
	it.effect(
		"is a record of the program's parameters: any other value is refused at encode, whether or not the program declares a parameter",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* installed(W.Work, workFacts, {
						label: "real",
						programs: {}
					})
					const s = o.schema
					const tasks = query(s).rule((r) => {
						const { id } = v(W.Task, "task")
						return r.match(W.Task, { id }).find({ id })
					})
					return yield* withServedDb(o.installed, o.server.roles.app, {}, ({ serve }) =>
						Effect.gen(function* () {
							const served = yield* serve({
								tasks,
								ordered: paged(tasks.orderBy(["id", "asc"])),
								tasksFor: W.workReads(s).automaticTasksFor,
								task: W.Task,
								unchanged: ChangeSet.empty(s),
								readBack: ChangeSet.empty(s).read("tasks", () =>
									query(s).rule((r) => {
										const { id } = v(W.Task, "task")
										return r
											.match(W.Task, { id, account: r.param("account", W.Task.fields.account) })
											.find({ id })
									})
								)
							})
							/** A read member's once with the caller's argument as its params. */
							const readCall = (name: string, argument: unknown) =>
								readOnce(member(served, name))({ params: argument, facts: {} })
							/** A change member of no array member, applied with the caller's argument as its params. */
							const applied = (name: string, argument: unknown) => {
								const change = member(served, name)
								assertVariant(
									change,
									"shape",
									"write",
									`the member ${name} takes its parameters alone`
								)
								return answered(change.once({ params: argument, facts: {} }))
							}
							const reads: { readonly [C in Call]: Read } = {
								"a read without parameters": {
									live: {},
									call: (a) => readCall("tasks", a)
								},
								"a window without parameters": {
									live: {},
									call: (a) =>
										readOnce(member(served, "ordered"))({
											params: a,
											facts: {},
											window: { anchor: { kind: "start" }, size: 2 }
										})
								},
								"a read with a parameter": {
									live: { account: a1 },
									call: (a) => readCall("tasksFor", a)
								},
								"a key member": {
									live: { id: t1 },
									call: (a) => readCall("task", a)
								},
								"a write without parameters": { live: {}, call: (a) => applied("unchanged", a) },
								"a write with a parameter": {
									live: { account: a1 },
									call: (a) => applied("readBack", a)
								}
							}
							return yield* exhaust(
								{
									suite: "pg/reads/params-argument",
									generator: (source) =>
										[source.draw(element(calls)), source.draw(element(argumentKinds))] as const,
									literal: Formatter.format,
									coverage: requiredInSpace<ArgumentFeature>([
										...Arr.flatMap(calls, (call): Arr.NonEmptyReadonlyArray<ArgumentFeature> => [
											`${call}: a record answered`,
											`${call}: no record refused`
										]),
										...Arr.map(nonRecords, (kind): ArgumentFeature => `${kind} refused`),
										"a stray key refused",
										"a key member: a stray key answered"
									]),
									caseHang,
									box: "every call of a read and a write door, each with every argument kind built for its program",
									oracle: {
										kind: "specification",
										name: "readParams's contract: a record of the program's parameters answers, any other argument is refused factShape naming no parameter, and a key member projects its key's fields"
									},
									concurrency: 1
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
													? "a key member: a stray key answered"
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
										if (refusal.kind !== "input") {
											return assert.fail(
												`${what} is refused at encode by its codec, not ${refusal.kind}`
											)
										}
										if (isNonRecord(kind)) {
											c.note(`${call}: no record refused`)
											c.note(`${kind} refused`)
										} else {
											c.note("a stray key refused")
										}
									})
							)
						})
					)
				}).pipe(Effect.scoped)
			)
	)
})
