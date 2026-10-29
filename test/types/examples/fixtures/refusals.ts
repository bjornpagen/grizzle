import { Effect } from "effect"
import {
	ChangeSet,
	check,
	contained,
	contract,
	Db,
	on,
	type Predicate,
	pg,
	query,
	relation,
	role,
	schema,
	uuid,
	v
} from "#index.ts"
import { type Cents, workExample } from "#test/types/examples/work.ts"

/**
 * The refusals of the worked example's program (../work.ts) at its public API, each a type error with the diagnostic
 * it names: a parameterless program bound with anything but an object with no key, a statement over a relation no level
 * of the schema declares, a parameterized predicate in a row check or a contract, and Db.open of no role.
 * Then the refusals of typed rows: rows read at a type their query's decoder does not deliver, a look-alike descriptor,
 * an attachment stated in a delivery its child's evidence does not prove, a parameter met by a field of another type,
 * and a head entry that is no term or whose literal is no handle of the roster it is written into. The run time refuses
 * each of them too, later; the types refuse them where they are written. Every `@ts-expect-error -- TSnnnn` names the
 * diagnostic the harness requires on the next line.
 */
const W: Readonly<ReturnType<typeof workExample<"Work">>> = workExample("Work")
declare const taskId: string

export const parameterless = Effect.gen(function* () {
	const db = yield* Db.open(W.Server.roles.writer, {})
	const switchToManual = W.switchToManual({
		taskId,
		accountId: taskId,
		previousBudget: W.Cents(1500n),
		operatorName: "Ruth"
	})
	// @ts-expect-error -- TS2345: a parameterless query takes no number
	yield* db.execute(W.tasksWithoutNotes, 42)
	// @ts-expect-error -- TS2322: a parameterless query takes no parameter
	yield* db.execute(W.tasksWithoutNotes, { extra: 1 })
	// @ts-expect-error -- TS2345: a parameterless ChangeSet takes no string
	yield* db.apply(switchToManual, "x")
	// @ts-expect-error -- TS2322: a parameterless ChangeSet takes no parameter
	yield* db.apply(switchToManual, { x: 1 })
	// @ts-expect-error -- TS2322: explain of a parameterless query takes no array
	yield* db.explain(W.accountCards, [1, 2])
	const compiled = yield* db.compile(W.tasksWithoutNotes)
	// @ts-expect-error -- TS2345: a compiled parameterless query takes no boolean
	yield* compiled.execute(true)
	const compiledChange = yield* db.compile(switchToManual)
	// @ts-expect-error -- TS2322: a compiled parameterless ChangeSet takes no parameter
	yield* compiledChange.apply({ x: 1 })
	yield* db.execute(W.tasksWithoutNotes, {})
	yield* db.apply(switchToManual, {})
	// @ts-expect-error -- TS2353: automaticTasksFor takes account only
	yield* db.execute(W.automaticTasksFor, { account: taskId, extra: 1 })
	// @ts-expect-error -- TS2345: the described switch needs its operator
	yield* db.apply(W.switchToManualDescribed, { task: taskId })
}).pipe(Effect.scoped)

export const bound = W.switchToManualDescribed.bind({ task: taskId, operator: "Ruth" })
export type BoundBind = Parameters<typeof bound.bind>
// @ts-expect-error -- TS2345: ChangeSet.bind of a parameterless ChangeSet takes no number
export const boundNumber = bound.bind(42)

export const S1 = schema("S1", { Account: W.Account }, [])
// @ts-expect-error -- TS2322 refusal: a whole entry is a relation of the base under its own name
export const undeclaredEntry = role(S1, "r", { Account: W.Account, Task: W.Task })
// @ts-expect-error -- TS2345 refusal: a statement names a relation no level of the schema declares
export const undeclaredSide = schema("S2", { Task: W.Task }, [
	contained(on(W.Task, "account"), on(W.Account, "id"))
])
// @ts-expect-error -- TS2322 refusal: a whole entry is a relation of the base under its own name
export const undeclaredExtension = role(W.Work, "x", { AccountBudget: W.AccountBudget })
export const declaredExtension = role(W.Reports, "x", { AccountBudget: W.AccountBudget })

declare const needsAccount: Predicate<{ readonly account: string }>
// @ts-expect-error -- TS2322 refusal: a schema predicate reads no parameter
export const parameterizedCheck = check("NeedsAccount", W.Task, () => needsAccount)
// @ts-expect-error -- TS2345 refusal: a schema predicate reads no parameter
export const parameterizedContract = contract("NeedsAccount", pg.bigint, () => needsAccount)

// @ts-expect-error -- TS2739: Db.open opens a role reached through its login, never the schema itself
export const schemaOpened = Db.open(W.Work, {})

/**
 * A query's rows are the records its decoder assembles, so a reader delivers them at that type and no other: an id is a
 * uuid's string.
 */
export const wrongRows = Effect.gen(function* () {
	const db = yield* Db.open(W.Server.roles.reader, {})
	const result = yield* db.execute(W.automaticTasksFor, { account: taskId })
	// @ts-expect-error -- TS2322: an id is a string, as uuid's column delivers it, never a number
	const rows: ReadonlyArray<{ readonly id: number; readonly budget: Cents }> = yield* result.collect
	return rows
})

/**
 * A descriptor is a builder's value: a plain object with a descriptor's members lacks the brand only a builder sets, so
 * no relation takes it, whatever column it states.
 */
const lookAlike = {
	sql: "uuid",
	column: { kind: "convert", convert: (text: string) => text }
} as const
// @ts-expect-error -- TS2741: a look-alike lacks the brand of a builder's descriptor
export const LookAlike = relation("LookAlike", { id: lookAlike }, ["id"])

/**
 * An attachment's stated delivery is a claim its child's evidence must prove: a task has at most one note, so its note
 * is an Option and never the one child; an account has any number of tasks, so they are an array and never an Option.
 */
const tasks = query(W.Work).rule((r) => {
	const { id, account } = v(W.Task)
	return r.match(W.Task, { id, account }).find({ id, account })
})

export const noteAsOne = () =>
	tasks.attach(
		"note",
		(t) =>
			// @ts-expect-error -- TS2322 refusal: the one child needs a child the evidence proves exactly one per parent
			query(W.Work).rule((r) => {
				const { note } = v(W.TaskNote)
				return r.match(W.TaskNote, { task: t.id, note }).find({ note })
			}),
		"one"
	)

export const tasksAsOption = () =>
	tasks.attach(
		"siblings",
		(t) =>
			// @ts-expect-error -- TS2322 refusal: an Option needs a child the evidence proves at most one per parent
			query(W.Work).rule((r) => {
				const { id } = v(W.Task)
				return r.match(W.Task, { id, account: t.account }).find({ id })
			}),
		"option"
	)

/**
 * A parameter is a term of the descriptor it is declared with, and adopts nothing from its uses: a uuid parameter is a
 * string, which never meets a Cents.
 */
export const uuidAgainstCents = () =>
	query(W.Work).rule((r) => {
		const { task, budget } = v(W.AutomaticTask)
		const account = r.param("account", uuid)
		// @ts-expect-error -- TS2345: a uuid parameter never meets a Cents field
		return r.match(W.AutomaticTask, { task, budget }).where(r.eq(budget, account)).find({ task })
	})

/**
 * A head holds terms, aggregates and producers, each carrying the column its records are read through: a literal is
 * r.literal(x), and a bare literal is no head entry.
 */
export const bareLiteral = () =>
	query(W.Work).rule((r) => {
		const { id } = v(W.Task)
		// @ts-expect-error -- TS2322: a bare literal is no head entry
		return r.match(W.Task, { id }).find({ id, kind: "Manual" })
	})

/** A head literal has its literal type, so one outside the roster makes the head no Task fact. */
export const literalOutsideRoster = () =>
	ChangeSet.empty(W.Work).put(
		W.Task,
		// @ts-expect-error -- TS2345 refusal: the query's head is not a fact of the relation
		query(W.Work).rule((r) => {
			const { id, account } = v(W.Task)
			return r.match(W.Task, { id, account }).find({ id, account, kind: r.literal("Pending") })
		})
	)
