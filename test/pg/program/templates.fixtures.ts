/** What the properties of templates.test.ts read: its spaces, models and helpers. */

import { type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, pipe, String as Str } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import type { InstallNames } from "#compiler/physical/ddl/names.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { defined } from "#test/support/assert.ts"
import {
	compileTemplate,
	installationSql,
	paramTexts,
	scalarsOnly,
	testCompile,
	type TestCompileOptions
} from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import { pgCluster } from "#test/support/env.ts"
import {
	Account,
	AutomaticTask,
	Kind,
	ManualTask,
	Task,
	TaskNote,
	Work
} from "#test/support/fixtures/api/work.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { owning } from "#test/support/policy.ts"
import { noTables } from "#test/support/substrate/replace.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { installTemplate, Substrate } from "#test/support/substrate/substrate.ts"

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const A = id(0x1001)

const B = id(0x1002)

const C = id(0x1003)

const t = (n: number) => id(0x3000 + n)

/** An INSERT into a relation's table, its table and columns named as the installation names them. */
export const insertInto = (
	names: PhysicalNames,
	relation: string,
	fields: ReadonlyArray<string>,
	rows: string
): string =>
	`INSERT INTO ${printObjectName(names.relation(relation))} (${Arr.join(
		Arr.map(fields, (f) => quoteIdent(names.column(relation, f))),
		", "
	)}) VALUES ${rows}`

/** The code a closed id of Kind stores for `handle`, under the installation's codes, never the handle's text. */
const kindCode = (names: InstallNames, handle: string): number =>
	codeOf(defined(names.codes.rosters.get(parsedName(Kind.name)), "the codes of Kind"), handle)

const facts = (names: InstallNames): ReadonlyArray<string> => [
	insertInto(
		names,
		Account.name,
		["id", "name"],
		`('${A}', 'alpha'), ('${B}', 'beta'), ('${C}', 'gamma')`
	),
	insertInto(
		names,
		Task.name,
		["id", "account", "kind"],
		Arr.join(
			Arr.map(
				[
					[t(1), A, "Automatic"],
					[t(2), A, "Manual"],
					[t(3), B, "Automatic"],
					[t(4), C, "Manual"],
					[t(5), A, "Automatic"]
				] as const,
				([task, account, kind]) => `('${task}', '${account}', ${kindCode(names, kind)})`
			),
			", "
		)
	),
	insertInto(
		names,
		AutomaticTask.name,
		["task", "budget"],
		`('${t(1)}', 100), ('${t(3)}', 50), ('${t(5)}', 100)`
	),
	insertInto(
		names,
		ManualTask.name,
		["task", "operator"],
		`('${t(2)}', 'ada'), ('${t(4)}', 'grace')`
	),
	insertInto(names, TaskNote.name, ["task", "note"], `('${t(1)}', 'first'), ('${t(3)}', 'third')`)
]

/** The notes the fixture's facts hold, by task: t(1)'s and t(3)'s. */
const committedNotes: ReadonlyArray<readonly [string, string]> = [
	[t(1), "first"],
	[t(3), "third"]
]

/** The fixture's tasks. */
const committedTasks: ReadonlyArray<string> = [t(1), t(2), t(3), t(4), t(5)]

/**
 * A transaction's writes before it reads the notes: notes removed, tasks removed, and notes added, each to a task of
 * the fixture with no note or to a task no fact holds, an orphan.
 */
interface TemplateCase {
	readonly removedNotes: ReadonlyArray<string>
	readonly removedTasks: ReadonlyArray<string>
	readonly added: ReadonlyArray<string>
}

export const templateCaseGen: Gen<TemplateCase> = (source) => ({
	removedNotes: source.draw(subset([t(1), t(3)], { min: 0, max: 2 })),
	removedTasks: source.draw(subset(committedTasks, { min: 0, max: 2 })),
	added: source.draw(subset([t(2), t(4), t(5), t(9), t(10), t(11)], { min: 0, max: 3 }))
})

/** The text an added note holds, as a literal: its task's id after "note ", so every note's text is its own. */
export const noteOf = (task: string): string => `'note ${task}'`

/**
 * The cells the notes query delivers in the case's transaction, sorted: each note whose task the transaction holds,
 * its task and its text.
 */
export const expectedNotes = (c: TemplateCase): ReadonlyArray<string> => {
	const tasks = new Set(Arr.filter(committedTasks, (x) => !c.removedTasks.includes(x)))
	const held = [
		...Arr.filter(committedNotes, ([x]) => !c.removedNotes.includes(x)),
		...Arr.map(c.added, (x): readonly [string, string] => [x, `note ${x}`])
	]
	const kept = Arr.filter(held, ([x]) => tasks.has(x))
	return Arr.sort(
		Arr.flatMap(kept, (pair): ReadonlyArray<string> => [pair[0], pair[1]]),
		Order.String
	)
}

export type TemplateFeature =
	| "an orphan note inserted"
	| "a note orphaned by its task's removal"
	| "a note removed"
	| "a note added to a task"

export const templateFeatures = (c: TemplateCase): ReadonlyArray<TemplateFeature> => {
	const kept = Arr.filter(committedNotes, ([x]) => !c.removedNotes.includes(x))
	return [
		...(Arr.some(c.added, (x) => !committedTasks.includes(x))
			? ["an orphan note inserted" as const]
			: []),
		...(Arr.some(kept, ([x]) => c.removedTasks.includes(x))
			? ["a note orphaned by its task's removal" as const]
			: []),
		...(c.removedNotes.length > 0 ? ["a note removed" as const] : []),
		...(Arr.some(c.added, (x) => committedTasks.includes(x) && !c.removedTasks.includes(x))
			? ["a note added to a task" as const]
			: [])
	]
}

/** TaskNote matched to Task on its deferred foreign key: R03 in a snapshot only. */
const notes = query(Work).rule((r) => {
	const { task, note } = v(TaskNote, "taskNote")
	return r.match(TaskNote, { task, note }).match(Task, { id: task }).find({ task, note })
})

export type Raw = ReadonlyArray<ReadonlyArray<string>>

/** The rows a statement returns: every result column cast to text by the statement itself, never NULL. */
const rawOf = (rows: unknown): Raw => trusted<Raw>(rows)

/** The statements an artifact runs, in order, on `session`, a raw session inside its own transaction. */
export const runSpecs = (
	specs: ReadonlyArray<StatementSpec>,
	params: Readonly<Record<string, unknown>>,
	session: RawSession
) =>
	Effect.gen(function* () {
		const raws: Array<Raw> = []
		for (const spec of specs) {
			const rows = yield* Effect.map(
				session.values(spec.sql, paramTexts(spec, params, scalarsOnly)),
				rawOf
			)
			raws.push(rows)
		}
		return raws
	})

const compiled = (
	q: unknown,
	schema: string,
	context: TestCompileOptions["context"]
): OracleTemplate => {
	const r = compileTemplate(q, undefined, {
		...testCompile,
		installation: identity.schema(parsedSchemaName(schema)),
		context
	})
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return r.value
}

/**
 * Work installed from its compiled installation script with the cases' facts, once per member (substrate.ts
 * installTemplate), where the search installed it once before its cases: a case reads the installation's names, and
 * the two templates of `notes` compiled under that name, the transaction's and the snapshot's, which each
 * worker compiles once as it plans. A case writes only inside a transaction it rolls back, so its clone keeps the facts
 * and the reset empties no table.
 */
export const workTemplate = installTemplate({
	declaredIn: import.meta,
	name: "template",
	content: { schema: Work.name },
	plan: (names) =>
		Effect.gen(function* () {
			const owned = owning(Work)
			const installation = compileInstallation(owned, {
				...installOptions(owned, pgCluster.owner),
				levels: [identity.schema(parsedSchemaName(names.schema))]
			})
			if (!installation.ok) {
				return yield* Effect.die(new Error(installation.error.message))
			}
			return {
				installation: installation.value,
				snapshot: compiled(notes, names.schema, "snapshot"),
				tx: compiled(notes, names.schema, "transaction")
			}
		}),
	install: ({ installation }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			yield* transaction(s.admin, [
				...installationSql(installation, s.database),
				...facts(installation.names)
			])
		}),
	bind: ({ installation, snapshot, tx }) => ({
		names: installation.names,
		snapshot,
		tx
	}),
	reset: () => noTables
})

export const uuids = (ids: ReadonlyArray<string>) =>
	`ARRAY[${Arr.join(
		Arr.map(ids, (i) => `'${i}'`),
		", "
	)}]::uuid[]`
