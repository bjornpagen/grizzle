import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import {
	type Drawn,
	type DrawnFeature,
	drawnFeature,
	lsw,
	passed,
	WILD_KINDS
} from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Cause, Effect, Exit, Formatter, Option, Record as Rec } from "effect"
import { openDbContext } from "#adapter/db/open.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import type { ReaderValue } from "#adapter/reader/reader.ts"
import { CompileError, CursorError } from "#compiler/core/errors.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { queryOver, queryValueDesc, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { dbReader } from "#test/support/runtime-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * The query a read takes, at an opened Db's reader: db.execute, db.page, db.get and db.compile each take a query or an
 * ordered query value the builders made, and a JavaScript caller may pass them any value (adapter/reader/reader.ts
 * queryAt). Values are drawn live, stale and wild (lsw), and each case hands its value to all four:
 *
 * - live: a query over a drawn relation of the worked example, heading a drawn nonempty set of its fields, or that
 *   query ordered by its first head field;
 * - stale: what a live query or the schema also gives a caller and is no query value: the query's own Description
 *   (query/build/query.ts queryValueDesc), which the compiler reads as a query, a ChangeSet over the schema, and the
 *   relation the query matches, which is get's key target;
 * - wild: any value JavaScript can pass.
 *
 * The oracle is the read boundary's contract: every call answers or fails with a typed failure (a ReadFailure, a
 * CursorError, or db.compile's CompileError), never a defect; a value that is no query value is refused before any
 * read of its decoder, by execute and page as a ReadFailure at stage compile and by compile as its CompileError, with
 * the relation's get, a keyed lookup, alone answering or refusing by its key; and a live query is read by execute and
 * compiled by compile.
 */
const entries = ["execute", "page", "get", "compile"] as const
type Entry = (typeof entries)[number]

/** Where a stale value comes from: the query's Description, a ChangeSet, or the relation the query matches. */
type From = "description" | "changeSet" | "relation"

type ProgramFeature = `${Entry} ${DrawnFeature<From>}` | `${Entry} wild`

/** The relations of the worked example a live query matches, each a whole relation of its schema. */
const relations = [W.Account, W.Task, W.AutomaticTask, W.ManualTask, W.TaskNote] as const

/** A live query's plan: the relation it matches, the fields it heads, and whether it is ordered by its first. */
interface Plan {
	readonly relation: (typeof relations)[number]
	readonly head: Arr.NonEmptyReadonlyArray<string>
	readonly ordered: boolean
}

/** A relation's field names, in its declared order. */
const fieldNames = (relation: {
	readonly fields: Readonly<Record<string, unknown>>
}): ReadonlyArray<string> => Rec.keys(relation.fields)

const planGen: Gen<Plan> = (source) => {
	const relation = source.draw(element(relations))
	const fields = fieldNames(relation)
	if (!Arr.isReadonlyArrayNonEmpty(fields)) {
		throw new Error(`${relation.name} declares fields`)
	}
	const first = source.draw(element(fields))
	return {
		relation,
		head: [first, ...Arr.filter(fields, (f) => f !== first && source.draw(int(0, 1)) === 1)],
		ordered: source.draw(int(0, 1)) === 1
	}
}

/** One case: the read entry, and the value drawn for it, a live or a stale one built from a plan. */
type ProgramCase = Drawn<Plan, From>

/** A stale value's plan and the kind of value it becomes. */
const staleGen: Gen<{ readonly value: Plan; readonly from: From }> = (source) => ({
	value: source.draw(planGen),
	from: source.draw(element(["description", "changeSet", "relation"] as const))
})

const caseGen: Gen<ProgramCase> = lsw<Plan, From>({
	live: planGen,
	stale: Option.some(staleGen),
	wild: WILD_KINDS
})

/**
 * The value a case passes: a wild value made hostile only here, or what its plan builds over the installed schema, the
 * query ordered as planned for a live value, and for a stale one the query's Description, a ChangeSet over the schema,
 * or the relation the query matches.
 */
const passedOf = (drawnValue: Drawn<Plan, From>, schema: object, changeSet: unknown): unknown => {
	if (drawnValue.kind === "wild") {
		return passed(drawnValue)
	}
	const plan = drawnValue.value
	const rule = queryOver(schema).rule((r: RuleValue) => {
		const vars = varsOver(plan.relation, "row")
		const bound = Rec.fromEntries(Arr.map(plan.head, (f) => [f, vars[f]] as const))
		return r.match(plan.relation, bound).find(bound)
	})
	if (drawnValue.kind === "live") {
		return plan.ordered ? rule.orderBy([plan.head[0], "asc"]) : rule
	}
	switch (drawnValue.from) {
		case "description":
			return queryValueDesc(rule)
		case "changeSet":
			return changeSet
		case "relation":
			return plan.relation
	}
}

/** Whether a case is get by a relation, a keyed lookup: the one value that is no query value a read may answer. */
const keyedGet = (entry: Entry, drawnValue: ProgramCase): boolean =>
	entry === "get" && drawnValue.kind === "stale" && drawnValue.from === "relation"

/** What a read entry does with a value: its Effect, whatever it answers. */
const callOf = (
	reader: ReaderValue,
	entry: Entry,
	value: unknown
): Effect.Effect<unknown, ReadError | CursorError | CompileError> => {
	switch (entry) {
		case "execute":
			return reader.execute(value, {})
		case "page":
			return reader.page(value, {}, { first: 2 })
		case "get":
			return reader.get(value, {})
		case "compile":
			return Effect.scoped(reader.compile(value))
	}
}

/** Whether a failure is one of the read boundary's typed failures. */
const typed = (error: unknown): boolean =>
	error instanceof ReadFailure || error instanceof CursorError || error instanceof CompileError

/** Whether a failure is the refusal of a value that is no query value: at stage compile, or db.compile's own. */
const refusedAtCompile = (entry: Entry, error: unknown): boolean =>
	entry === "compile"
		? error instanceof CompileError
		: error instanceof ReadFailure && error.stage === "compile"

layer(Substrate.layer, { excludeTestServices: true })("the query a read takes", (it) => {
	it.effect(
		"every value a JavaScript caller passes to execute, page, get or compile is answered or refused with a typed failure, never a defect, and a value that is no query value is refused at compile",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* installed(W.Work, workFacts, { label: "programs", extensions: [] })
					return yield* Effect.gen(function* () {
						const { ctx: dbCtx } = yield* openDbContext(o.server.roles.app, {})
						const reader = dbReader(dbCtx)
						const changeSet = ChangeSet.empty(o.schema)
						return yield* explore(
							{
								suite: "pg/reads/program-values",
								oracle: {
									kind: "specification",
									name: "the read boundary's contract: a typed failure for any value, never a defect; a value that is no query value refused at compile before its decoder is read; a live query read and compiled"
								},
								draw: drawn(caseGen),
								literal: Formatter.format,
								coverage: required<ProgramFeature>(
									Arr.flatMap(entries, (entry): Arr.NonEmptyReadonlyArray<ProgramFeature> => [
										`${entry} live`,
										`${entry} stale description`,
										`${entry} stale changeSet`,
										`${entry} stale relation`,
										`${entry} wild`
									]),
									{ cases: 40, sense: notesOnly }
								),
								kept: [],
								runs: 60,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(drawnValue, k) =>
								Effect.forEach(
									entries,
									(entry) =>
										Effect.gen(function* () {
											const value = passedOf(drawnValue, o.schema, changeSet)
											const what = `${entry} of ${drawnFeature(drawnValue)}`
											const exit = yield* Effect.exit(callOf(reader, entry, value))
											const live = drawnValue.kind === "live"
											if (Exit.isFailure(exit)) {
												const error = defined(
													Option.getOrUndefined(Exit.findErrorOption(exit)),
													`${what} fails with a typed failure, never a defect: ${Cause.pretty(exit.cause)}`
												)
												assert.ok(
													typed(error),
													`${what} fails with a typed failure: ${Cause.pretty(exit.cause)}`
												)
												if (!live && !keyedGet(entry, drawnValue)) {
													assert.ok(
														refusedAtCompile(entry, error),
														`${what} is refused at compile: ${Cause.pretty(exit.cause)}`
													)
												}
											} else {
												assert.ok(
													live || keyedGet(entry, drawnValue),
													`${what} is answered, though it is no query value`
												)
											}
											if (live && (entry === "execute" || entry === "compile")) {
												assert.ok(
													Exit.isSuccess(exit),
													`${what} is read: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""}`
												)
											}
											k.note(`${entry} ${drawnFeature(drawnValue)}`)
											if (drawnValue.kind === "wild") {
												k.note(`${entry} wild`)
											}
										}),
									{ discard: true }
								)
						)
					}).pipe(Effect.scoped, withLayer(o.layer))
				}).pipe(Effect.scoped)
			)
	)
})
