/**
 * What propagate.test.ts reads: a learner's ledger, the box of programs whose every key the statement fixes at the
 * learner's parameter reaches its stored read only through a carried column, and the stored reads and arbitrations of a
 * compiled program that do not spell that key as the parameter.
 */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema, unit } from "#compiler/public/schema.ts"
import type {
	Expr,
	FromItem,
	FromSource,
	OperandBody,
	OperandSelect,
	SelectCore,
	SqlStatement,
	Target,
	With
} from "#compiler/sql/ast.ts"
import { selectColumns } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"

/** A child's unit; each relation keyed by its child first sits in it, a stage's plan outside every unit. */
const Learner = unit("Learner", { child: pg.integer })
const Session = relation("Session", { child: pg.integer, stage: pg.integer }, ["child", "stage"])
const Plan = relation("Plan", { stage: pg.integer, path: pg.integer }, ["stage", "path"])
const Visit = relation("Visit", { child: pg.integer, stage: pg.integer, path: pg.integer }, [
	"child",
	"stage",
	"path"
])
const Mark = relation(
	"Mark",
	{ child: pg.integer, stage: pg.integer, path: pg.integer, n: pg.integer },
	["child", "stage", "path", "n"]
)
const Ledger = schema("PropagateLedger", [Session, Plan, Visit, Mark], [Learner])
const l = { Session, Plan, Visit, Mark } as const

/** The tables of the relations under Learner, by their stored name: every read of one is a read at the child. */
const unitTables: ReadonlySet<string> = new Set(["session", "visit", "mark"])

/**
 * A program of the box, each a ChangeSet of the learner's whose every read and write of a relation under Learner is at
 * the parameter `child`, which reaches the key only through a column that carries it:
 *
 * - `projected`: a read-back joining Visit to a query that projects the parameter, the child a variable both bind;
 * - `navigated`: an insert whose source matches Session and Visit at a filter of the child, the write's navigation
 *   reading Visit LATERAL at the column of Session's step;
 * - `negated`: an insert of the projected rows where Visit holds none, Visit read under NOT EXISTS at their columns;
 * - `shared`: an insert of Mark from two rules, each reading one query of every visit at the child, a node both read;
 * - `unioned`: a read-back of Visit at the rows of a union both arms of which project the parameter;
 * - `ranked`: a read-back of each projected row's last visit, a take correlated with the row;
 * - `delta`: a read-back of the marks at the visits the change added, read through delta.added.
 */
export type Program =
	| "projected"
	| "navigated"
	| "negated"
	| "shared"
	| "unioned"
	| "ranked"
	| "delta"

export const programGen: Gen<Program> = element<Program>([
	"projected",
	"navigated",
	"negated",
	"shared",
	"unioned",
	"ranked",
	"delta"
])

/** The child's stages' paths, the parameter projected as the child. */
const due = query(Ledger).rule((r) => {
	const child = r.param("child", pg.integer)
	const { stage } = v(l.Session, "s")
	const { path } = v(l.Plan, "p")
	return r
		.match(l.Session, { child, stage })
		.match(l.Plan, { stage, path })
		.find({ child, stage, path })
})

/** The rows of `due` and of the child's sessions' first paths, each arm projecting the parameter as the child. */
const either = query(Ledger)
	.rule((r) => {
		const d = due.bind({ child: r.param("child", pg.integer) })
		const { child, stage, path } = v(d, "d")
		return r.match(d, { child, stage, path }).find({ child, stage, path })
	})
	.rule((r) => {
		const child = r.param("child", pg.integer)
		const { stage } = v(l.Session, "s")
		return r.match(l.Session, { child, stage }).find({ child, stage, path: stage })
	})

/** A child's last visit at a stage: the take of one of its visits there, the last path first. */
const lastVisit = query(Ledger)
	.rule((r) => {
		const child = r.param("child", pg.integer)
		const stage = r.param("stage", pg.integer)
		const { path } = v(l.Visit, "x")
		return r.match(l.Visit, { child, stage, path }).find({ child, stage, path })
	})
	.orderBy(["path", "desc"])
	.take(1)

const changeOf = (program: Program) => {
	switch (program) {
		case "projected":
			return ChangeSet.empty(Ledger)
				.insert(l.Visit, due)
				.read("again", () =>
					query(Ledger).rule((r) => {
						const d = due.bind({ child: r.param("child", pg.integer) })
						const { child, stage, path } = v(d, "d")
						return r
							.match(d, { child, stage, path })
							.match(l.Visit, { child, stage, path })
							.find({ child, stage, path })
					})
				)
		case "navigated":
			return ChangeSet.empty(Ledger).insert(
				l.Mark,
				query(Ledger).rule((r) => {
					const { child, stage, path } = v(l.Visit, "x")
					return r
						.match(l.Session, { child, stage })
						.match(l.Visit, { child, stage, path })
						.where(r.eq(child, r.param("child", pg.integer)))
						.find({ child, stage, path, n: r.param("n", pg.integer) })
				})
			)
		case "negated":
			return ChangeSet.empty(Ledger).insert(
				l.Visit,
				query(Ledger).rule((r) => {
					const d = due.bind({ child: r.param("child", pg.integer) })
					const { child, stage, path } = v(d, "d")
					return r
						.match(d, { child, stage, path })
						.where(r.not(l.Visit, { child, stage, path }))
						.find({ child, stage, path })
				})
			)
		case "shared": {
			const visits = query(Ledger).rule((r) => {
				const { child, stage, path } = v(l.Visit, "x")
				return r
					.match(l.Visit, { child, stage, path })
					.match(l.Plan, { stage, path })
					.find({ child, stage, path })
			})
			return ChangeSet.empty(Ledger)
				.insert(l.Visit, due)
				.read("again", () =>
					query(Ledger)
						.rule((r) => {
							const { child, stage, path } = v(visits, "w")
							return r
								.match(visits, { child, stage, path })
								.where(r.eq(child, r.param("child", pg.integer)))
								.find({ child, stage, path })
						})
						.rule((r) => {
							const { child, stage } = v(l.Session, "s")
							const { path } = v(visits, "w")
							return r
								.match(l.Session, { child, stage })
								.match(visits, { child, stage, path })
								.where(r.eq(child, r.param("child", pg.integer)))
								.find({ child, stage, path: stage })
						})
				)
		}
		case "unioned":
			return ChangeSet.empty(Ledger)
				.insert(l.Visit, due)
				.read("again", () =>
					query(Ledger).rule((r) => {
						const e = either.bind({ child: r.param("child", pg.integer) })
						const { child, stage, path } = v(e, "e")
						return r
							.match(e, { child, stage, path })
							.match(l.Visit, { child, stage, path })
							.find({ child, stage, path })
					})
				)
		case "delta":
			return ChangeSet.empty(Ledger)
				.insert(l.Visit, due)
				.read("again", (delta) =>
					query(Ledger).rule((r) => {
						const added = delta.added(l.Visit)
						const { child, stage, path } = v(added, "added")
						const { n } = v(l.Mark, "m")
						return r
							.match(added, { child, stage, path })
							.match(l.Mark, { child, stage, path, n })
							.find({ child, stage, path, n })
					})
				)
		case "ranked":
			return ChangeSet.empty(Ledger)
				.insert(l.Visit, due)
				.read("again", () =>
					query(Ledger).rule((r) => {
						const d = due.bind({ child: r.param("child", pg.integer) })
						const { child, stage, path } = v(d, "d")
						const last = lastVisit.bind({ child, stage })
						const { path: latest } = v(last, "last")
						return r
							.match(d, { child, stage, path })
							.match(last, { child, stage, path: latest })
							.find({ child, stage, path: latest })
					})
				)
	}
}

/** One statement a program's flight may send, in one form, and what fills each of its placeholders. */
interface Sent {
	readonly ast: SqlStatement
	readonly slots: ReadonlyArray<WriteParamSlot>
}

/**
 * Every statement a program's flight may send, in every form, as the borrow checker reads them
 * (program/isolation/member-facts.ts flightStatements): its write statements and its sent read-backs.
 */
export const sentOf = (program: Program): ReadonlyArray<Sent> => {
	const artifact = succeeded(
		compileWrite(
			checking(Ledger),
			defined(changeSetDesc(changeOf(program)), `the ${program} program's Description`),
			{ ...realityWrite(succeeded(testArtifacts(Ledger, testCompile))), level: "readCommitted" }
		),
		`the ${program} program compiles`
	).artifact
	return [
		...Arr.map(artifact.statements, (s): Sent => ({ ast: s.ast, slots: s.spec.paramSlots })),
		...Arr.flatMap(artifact.readBacks, (r): ReadonlyArray<Sent> =>
			r.carried.kind === "sent"
				? [{ ast: r.carried.statement.ast, slots: r.carried.statement.spec.paramSlots }]
				: []
		)
	]
}

/** An expression through its casts and collations, which keep its value. */
const uncast = (e: Expr): Expr => (e.kind === "cast" || e.kind === "collate" ? uncast(e.expr) : e)

/** The conjuncts of a condition: its AND's arguments, each split again. */
const conjunctsOf = (e: Expr | undefined): ReadonlyArray<Expr> =>
	e === undefined ? [] : e.kind === "and" ? Arr.flatMap(e.args, (a) => conjunctsOf(a)) : [e]

/** Whether `e` is the placeholder of the parameter `child`, through casts. */
const childParam = (e: Expr, slots: ReadonlyArray<WriteParamSlot>): boolean => {
	const u = uncast(e)
	if (u.kind !== "param") {
		return false
	}
	const slot = slots[u.slot.number - 1]
	return slot?.kind === "scalar" && slot.param === "child"
}

/**
 * A stored read of a unit relation a FROM source is, with the name its key column `child` has where the source stands:
 * the table itself under its alias; the derived table a lowering spells a scan with, `(SELECT a.c, ... FROM table AS
 * a) AS b(x, ...)`, its column at child's place; or a derived table renaming one, `(SELECT b.x, ... FROM <such> AS b)
 * AS c(y, ...)`, which the printer spells as the scan itself. None for any other source.
 */
const storedRead = (
	source: FromSource
): { readonly table: string; readonly alias: string; readonly child: string } | undefined => {
	if (source.kind === "table" && typeof source.table !== "string") {
		return unitTables.has(source.table.name)
			? { table: source.table.name, alias: source.alias, child: "child" }
			: undefined
	}
	if (source.kind !== "derived" || source.query.body.kind !== "core") {
		return undefined
	}
	const body = source.query.body
	const [inner, ...more] = body.from
	const read =
		scanOf(body) ??
		(inner !== undefined && more.length === 0 && inner.kind !== "joins" && body.where === undefined
			? storedRead(inner)
			: undefined)
	if (read === undefined) {
		return undefined
	}
	const at = Arr.findFirstIndex(body.targets, (t) => {
		const e = t.expr
		return e.kind === "column" && e.table === read.alias && e.column === read.child
	})
	const child = Option.isSome(at) ? selectColumns(source.query)[at.value] : undefined
	return child === undefined ? undefined : { table: read.table, alias: source.alias, child }
}

/**
 * The unit relation a core scans, where it is a lowering's scan of one: `SELECT a.c, ... FROM table AS a`, no condition,
 * each target a column of the table, whose reader's core holds the conditions on its rows.
 */
const scanOf = (
	core: SelectCore
): { readonly table: string; readonly alias: string; readonly child: string } | undefined => {
	const [scan, ...more] = core.from
	return scan !== undefined &&
		more.length === 0 &&
		scan.kind === "table" &&
		typeof scan.table !== "string" &&
		unitTables.has(scan.table.name) &&
		core.where === undefined &&
		Arr.every(core.targets, (t) => t.expr.kind === "column" && t.expr.table === scan.alias)
		? { table: scan.table.name, alias: scan.alias, child: "child" }
		: undefined
}

/** Whether a core renames a stored read (storedRead): its reader's core holds the conditions on its rows. */
const renames = (core: SelectCore): boolean => {
	const [inner, ...more] = core.from
	return (
		inner !== undefined &&
		more.length === 0 &&
		inner.kind === "derived" &&
		core.where === undefined &&
		storedRead(inner) !== undefined &&
		Arr.every(core.targets, (t) => t.expr.kind === "column" && t.expr.table === inner.alias)
	)
}

/** Every FROM source a core reads, a join chain's each, with the conditions its joins state. */
const sourcesOf = (
	from: ReadonlyArray<FromItem>
): { readonly sources: ReadonlyArray<FromSource>; readonly on: ReadonlyArray<Expr> } => {
	const sources: Array<FromSource> = []
	const on: Array<Expr> = []
	for (const item of from) {
		if (item.kind === "joins") {
			sources.push(item.first)
			for (const step of item.steps) {
				sources.push(step.source)
				if (step.kind !== "cross") {
					on.push(step.on)
				}
			}
		} else {
			sources.push(item)
		}
	}
	return { sources, on }
}

/**
 * The stored reads of a unit relation in `core` whose key `child` no condition of the core equates with the parameter
 * `child` where it stands: each a description of the read. A write's probe binds its key in its own `by`.
 */
const unboundIn = (
	core: SelectCore,
	slots: ReadonlyArray<WriteParamSlot>
): ReadonlyArray<string> => {
	if (scanOf(core) !== undefined || renames(core)) {
		return []
	}
	const { sources, on } = sourcesOf(core.from)
	const conditions = [...conjunctsOf(core.where), ...Arr.flatMap(on, (c) => conjunctsOf(c))]
	return Arr.flatMap(sources, (source) => {
		if (source.kind === "probe") {
			const by = Arr.findFirst(source.by.columns, (c) => c.column === "child").pipe(
				Option.getOrUndefined
			)
			return unitTables.has(source.table.name) && (by === undefined || !childParam(by.value, slots))
				? [
						`a probe of ${source.table.name} at ${by === undefined ? "no child" : "a child no parameter spells"}`
					]
				: []
		}
		const read = storedRead(source)
		if (read === undefined) {
			return []
		}
		const bound = Arr.some(conditions, (c) => {
			if (c.kind !== "binary" || c.op !== "=") {
				return false
			}
			const at = (x: Expr, y: Expr): boolean => {
				const u = uncast(x)
				return (
					u.kind === "column" &&
					u.table === read.alias &&
					u.column === read.child &&
					childParam(y, slots)
				)
			}
			return at(c.left, c.right) || at(c.right, c.left)
		})
		return bound
			? []
			: [`a read of ${read.table} whose child no condition of its core spells as the parameter`]
	})
}

/** What a name a query reads its rows from is defined as: a CTE's or a derived table's query and its column names. */
type Defined = ReadonlyMap<
	string,
	{ readonly query: OperandSelect; readonly columns: ReadonlyArray<string> }
>

/** The CTEs of a WITH, each a query, by name, over `outer`. */
const withDefined = (w: With | undefined, outer: Defined): Defined => {
	const out = new Map(outer)
	for (const cte of w?.ctes ?? []) {
		if (cte.query.kind === "select") {
			out.set(cte.name, { query: cte.query, columns: selectColumns(cte.query) })
		}
	}
	return out
}

/** Whether the `at`-th target of every arm of `body` carries the parameter `child` (carries). */
const bodyCarries = (
	body: OperandBody,
	at: number,
	defined: Defined,
	slots: ReadonlyArray<WriteParamSlot>
): boolean => {
	switch (body.kind) {
		case "core": {
			const target: Target | undefined = body.targets[at]
			const scope = new Map(defined)
			for (const source of sourcesOf(body.from).sources) {
				if (source.kind === "derived") {
					scope.set(source.alias, { query: source.query, columns: selectColumns(source.query) })
				} else if (source.kind === "cte") {
					const d = defined.get(source.name)
					if (d !== undefined) {
						scope.set(source.alias ?? source.name, d)
					}
				}
			}
			return target !== undefined && carries(target.expr, scope, slots)
		}
		case "setOp":
			return Arr.every(body.arms, (arm) =>
				arm.kind === "core"
					? bodyCarries(arm, at, defined, slots)
					: bodyCarries(arm.body, at, withDefined(arm.with, defined), slots)
			)
		case "select":
			return bodyCarries(body.body, at, withDefined(body.with, defined), slots)
	}
}

/**
 * Whether `e` carries the parameter `child`: it is the placeholder, through casts, or a column of a CTE or derived table
 * in `defined` whose query's target at that column carries it in every arm, as the borrow checker follows an INSERT's
 * values to an arbitration through its own CTEs.
 */
const carries = (e: Expr, defined: Defined, slots: ReadonlyArray<WriteParamSlot>): boolean => {
	const u = uncast(e)
	if (childParam(u, slots)) {
		return true
	}
	if (u.kind !== "column" || u.table === undefined) {
		return false
	}
	const d = defined.get(u.table)
	const at = d === undefined ? -1 : d.columns.indexOf(u.column)
	return (
		d !== undefined &&
		at >= 0 &&
		bodyCarries(d.query.body, at, withDefined(d.query.with, defined), slots)
	)
}

/**
 * Every place a statement reads or writes a unit relation without the parameter `child` at its key (the oracle): each
 * stored read whose core spells no `child = $child` (unboundIn), and each INSERT into one with ON CONFLICT whose child
 * value carries no parameter (carries).
 */
export const unboundOf = (sent: Sent): ReadonlyArray<string> => {
	const found: Array<string> = []
	transformStatement(sent.ast, {
		...identityHooks,
		core: (core) => {
			for (const read of unboundIn(core, sent.slots)) {
				found.push(read)
			}
			return core
		}
	})
	const inserts = (statement: SqlStatement, outer: Defined): void => {
		if (statement.kind !== "insert" && statement.kind !== "select") {
			return
		}
		const defined = withDefined(statement.with, outer)
		for (const cte of statement.with?.ctes ?? []) {
			if (cte.query.kind === "insert") {
				inserts(cte.query, defined)
			}
		}
		if (statement.kind !== "insert" || statement.onConflict === undefined) {
			return
		}
		const table = statement.table
		const name = typeof table === "string" ? undefined : table.name
		const at = statement.columns.indexOf("child")
		if (
			name === undefined ||
			!unitTables.has(name) ||
			at < 0 ||
			statement.source.kind !== "query"
		) {
			return
		}
		const query = statement.source.query
		if (!bodyCarries(query.body, at, withDefined(query.with, defined), sent.slots)) {
			found.push(`an arbitration of ${name} whose child carries no parameter`)
		}
	}
	inserts(sent.ast, new Map())
	return found
}
