/** What keyed-reach.test.ts reads: its schema, its reads and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { genericPlanOf, type PlanNode, parsePlanTree, rowsRead } from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, unit } from "#compiler/public/schema.ts"
import { scanBindings } from "#test/pg/physical/plan-bindings.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { planAsRun } from "#test/support/judge.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import {
	countedAsVacuumed,
	rowsBeside,
	rowsPerPage,
	type StatedDistinct,
	statedDistinct
} from "#test/support/substrate/fill.ts"

const i = pg.integer

/** The seeks a read of an attempt makes at most: its answer, or its submission and save, and the values at its instant. */
const probes = 4

/**
 * A learner's attempts as edullm's ledger holds them: an answer attempt at its own instant, a submission naming the save
 * it submits, each save at its instant, and the values recorded at each instant, each relation keyed by the learner and
 * its own key, in the learner's unit.
 */
const Answer = relation("Answer", { child: i, attempt: i, at: i }, ["child", "attempt"])
const Submit = relation("Submit", { child: i, attempt: i, save: i }, ["child", "attempt"])
const Save = relation("Save", { child: i, save: i, at: i }, ["child", "save"])
const Value = relation("Value", { child: i, at: i, name: i, value: i }, ["child", "at", "name"])
const Learners = schema(
	"KeyedReach",
	[Answer, Submit, Save, Value],
	[unit("Learner", { child: i })]
)

/**
 * The instant an attempt's values stand at, edullm's AttemptValueAt: an answer attempt's own instant, or the instant of
 * the save a submission names, a derived relation of two rules, each keyed by the attempt.
 */
const AttemptValueAt = derived(
	"AttemptValueAt",
	query(Learners)
		.rule((r) => {
			const { child, attempt, at } = v(Answer, "answer")
			return r.match(Answer, { child, attempt, at }).find({ child, attempt, at })
		})
		.rule((r) => {
			const { child, attempt, save } = v(Submit, "submit")
			const { at } = v(Save, "save")
			return r
				.match(Submit, { child, attempt, save })
				.match(Save, { child, save, at })
				.find({ child, attempt, at })
		})
)
const Ledger = schema.extend([Learners], "KeyedReachDerived", [AttemptValueAt], [])

/** An attempt's instant, read by the attempt's whole key at the parameters. */
const valueAt = query(Ledger).rule((r) => {
	const { child, attempt, at } = v(AttemptValueAt, "valueAt")
	return r
		.match(AttemptValueAt, { child, attempt, at })
		.where(r.eq(child, r.param("child", i)), r.eq(attempt, r.param("attempt", i)))
		.find({ at })
})

/** An attempt's values, its instant read by the attempt's whole key and joined to the values recorded then. */
const valuesOf = query(Ledger).rule((r) => {
	const { child, attempt, at } = v(AttemptValueAt, "valueAt")
	const { name, value } = v(Value, "value")
	return r
		.match(AttemptValueAt, { child, attempt, at })
		.match(Value, { child, at, name, value })
		.where(r.eq(child, r.param("child", i)), r.eq(attempt, r.param("attempt", i)))
		.find({ name, value })
})

/** The reads a case explains. */
const keyedReads = { valueAt, valuesOf } as const
export type KeyedRead = keyof typeof keyedReads

/** The schemas installed through their first migration, with a reader whose workload's indexes the reads earn. */
export const keyedReachTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "keyed reach",
	fixture: Ledger,
	programs: keyedReads,
	label: "keyed_reach",
	ambient: ordinarySession
})

/** How a case's columns' statistics stand: as the stored rows' counts leave them, or stated (fill.ts statedDistinct). */
export type Statistics = "counted" | StatedDistinct

/**
 * A case: the read; the attempt asked, an answer or a submission, of child 1; `children` children stored, each of
 * `attempts` attempts, the odd ones answers and the even ones submissions of a save of their own, each instant with
 * `values` values; then `more` children stored beside them before the read is explained again; and how the columns'
 * statistics stand.
 */
export interface KeyedReachCase {
	readonly read: KeyedRead
	readonly asked: "answer" | "submission"
	readonly children: number
	readonly attempts: number
	readonly values: number
	readonly more: number
	readonly statistics: Statistics
}

export const keyedReachGen: Gen<KeyedReachCase> = (s) => ({
	read: s.draw(element<KeyedRead>(["valueAt", "valuesOf"])),
	asked: s.draw(element<KeyedReachCase["asked"]>(["answer", "submission"])),
	children: s.draw(int(2, 8)),
	attempts: s.draw(int(2, 6)),
	values: s.draw(int(1, 4)),
	more: s.draw(int(200, 600)),
	statistics: s.draw(element<Statistics>(["counted", "unique", "one value"]))
})

export type KeyedReachFeature =
	| "an answer's instant"
	| "a submission's save's instant"
	| "the values at the instant"
	| "under counted statistics"
	| "under statistics stating each value its own"
	| "under statistics stating every row one value"

/** Each relation's key columns a read of an attempt by its key binds wherever it is read: every one of its key. */
const boundKeys = (installed: Installed): ReadonlyMap<string, ReadonlyArray<string>> => {
	const names = installed.installation.names
	const holding = installed.installation.checked.holdings.get(AttemptValueAt.name)
	return new Map([
		[names.relation(Answer.name).name, ["child", "attempt"]],
		[names.relation(Submit.name).name, ["child", "attempt"]],
		[names.relation(Save.name).name, ["child", "save"]],
		[names.relation(Value.name).name, ["child", "at"]],
		...(holding?.kind === "stored"
			? [[names.relation(AttemptValueAt.name).name, ["child", "attempt"]] as const]
			: [])
	])
}

/**
 * The statements storing children `from` to `to`: each child's attempts, the odd ones answers at instant 10a and the
 * even ones submissions of save a at instant 10a + 1, each instant's values; AttemptValueAt's table, where the
 * installation stores it, filled as its upkeep fills it; then each table counted as a VACUUM counts it, and its
 * columns' statistics as the case states them.
 */
const stored = (
	installed: Installed,
	c: KeyedReachCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const grid = `FROM generate_series(${String(from)}, ${String(to)}) AS g(c), generate_series(1, ${String(c.attempts)}) AS h(a)`
	const instants = `${grid}, generate_series(1, ${String(c.values)}) AS k(n)`
	const holding = installed.installation.checked.holdings.get(AttemptValueAt.name)
	const statistics = c.statistics
	const tables = [
		...Arr.map([Answer, Submit, Save, Value], (t) => names.table(t)),
		...(holding?.kind === "stored" ? [names.table(AttemptValueAt)] : [])
	]
	return [
		`INSERT INTO ${names.table(Answer)} SELECT c, a, 10 * a ${grid} WHERE a % 2 = 1`,
		`INSERT INTO ${names.table(Save)} SELECT c, a, 10 * a + 1 ${grid} WHERE a % 2 = 0`,
		`INSERT INTO ${names.table(Submit)} SELECT c, a, a ${grid} WHERE a % 2 = 0`,
		`INSERT INTO ${names.table(Value)} SELECT c, 10 * a + 1 - a % 2, n, n ${instants}`,
		...(holding?.kind === "stored"
			? [
					`INSERT INTO ${names.table(AttemptValueAt)} (child, attempt, at) SELECT c, a, 10 * a + 1 - a % 2 ${grid}`
				]
			: []),
		...Arr.map(tables, countedAsVacuumed),
		...(statistics === "counted" ? [] : Arr.map(tables, (t) => statedDistinct(t, statistics)))
	]
}

/**
 * The law on the read's generic plan (prepared and explained under force_generic_plan, as every login's role plans the
 * statements it prepares):
 * every scan of a stored relation is a seek whose Index Cond binds every column of the relation's key the read binds
 * (`boundKeys`), the learner among them, never a scan of it whole or by a prefix the read could bind further, inside a
 * CTE of the statement as anywhere: the union of the two rules is derived at the key in each arm, never whole.
 */
const keyedReach = (
	installed: Installed,
	tree: Parameters<typeof scanBindings>[0],
	what: string
): void => {
	const keys = boundKeys(installed)
	for (const scan of scanBindings(tree)) {
		const key = keys.get(scan.relation)
		assert.ok(
			key !== undefined && scan.nodeType !== "Seq Scan" && Arr.every(key, (k) => scan.bound.has(k)),
			`${what}: ${scan.relation} (${scan.alias}) is read by ${scan.nodeType} binding ${Formatter.format([...scan.bound])}, where the read binds ${Formatter.format(key ?? [])}`
		)
	}
}

/**
 * One case in its one transaction, which the case's end rolls back: children 1 to `children` stored, then `more`
 * children beside them and as many again as make each table worth planning (fill.ts rowsBeside), so PostgreSQL reads a
 * table through an index wherever a statement binds its key, under no planner setting; the read of child 1's asked
 * attempt explained with ANALYZE, reading at most twice the rows its key reaches: the asked attempt's answer, or its
 * submission and the save it names, and, for `valuesOf`, the values at its instant; then planned generically, as
 * every session grizzle opens plans the statements it prepares (bench/harness/explain.ts genericPlanOf), and held to
 * the law (`keyedReach`). A union derived whole for every
 * learner reads each learner's attempts and saves, past the bound and the law.
 */
export const runKeyedReach = (
	installed: Installed,
	connection: PgConnection,
	c: KeyedReachCase,
	k: Case<KeyedReachFeature>
) =>
	Effect.gen(function* () {
		for (const sql of stored(installed, c, 1, c.children)) {
			yield* connection.query(sql, [])
		}
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const read = keyedReads[c.read]
		const template = succeeded(compileTemplate(read, undefined, options), "the read compiles")
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const attempt = c.asked === "answer" ? 1 : 2
		const params = paramTexts(
			statement,
			{ child: 1, attempt },
			declaredOf(template, read, undefined, options)
		)
		const what = `${Formatter.format(c)}: ${c.read}`
		/** The rows the key reaches: the answer, or the submission and its save, and the values at the instant. */
		const own = (c.asked === "answer" ? 1 : 2) + (c.read === "valuesOf" ? c.values : 0)
		const bound = 2 * own
		const bounded = (children: number) =>
			Effect.gen(function* () {
				const plan: PlanNode = yield* planAsRun(connection.queryValues, statement.sql, params)
				const read = rowsRead(plan)
				assert.ok(
					read <= bound,
					`${what} beside ${String(children)} children reads ${String(read)} rows, past its bound ${String(bound)} (the key reaches ${String(own)})\n${statement.sql}`
				)
			})
		/**
		 * Children enough beside the case's that a scan of each table prices past its probes (fill.ts rowsBeside), so the
		 * generic plan is judged where PostgreSQL reads a table worth planning, never one of a page or two it scans whole.
		 */
		const beside =
			c.more + Math.ceil(rowsBeside(probes, rowsPerPage(4 * 4)) / Math.floor(c.attempts / 2))
		for (const sql of stored(installed, c, c.children + 1, c.children + beside)) {
			yield* connection.query(sql, [])
		}
		yield* bounded(c.children + beside)
		const generic = yield* genericPlanOf(
			{ values: connection.queryValues },
			statement.sql,
			params.length
		)
		keyedReach(
			installed,
			succeeded(parsePlanTree(generic[0]?.[0]), "one generic plan"),
			`${what}'s generic plan\n${statement.sql}`
		)
		k.note(c.asked === "answer" ? "an answer's instant" : "a submission's save's instant")
		if (c.read === "valuesOf") {
			k.note("the values at the instant")
		}
		k.note(
			c.statistics === "counted"
				? "under counted statistics"
				: c.statistics === "unique"
					? "under statistics stating each value its own"
					: "under statistics stating every row one value"
		)
	})
