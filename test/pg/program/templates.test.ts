import { layer } from "@effect/vitest"
import { Array as Arr, Effect, pipe, String as Str } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { selectArtifact } from "#compiler/program/context.ts"
import { query, v } from "#compiler/public/query.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { assert, defined, lacks } from "#test/support/assert.ts"
import {
	compileTemplate,
	installationSql,
	paramTexts,
	scalarsOnly,
	testCompile,
	type TestCompileOptions
} from "#test/support/compile.ts"

import type { Uuid } from "#compiler/public/fields.ts"
import {
	Account,
	AutomaticTask,
	ManualTask,
	Task,
	TaskNote,
	Work
} from "#test/support/fixtures/api/work.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { owning } from "#test/support/policy.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A compiled template's deferred-key hazard on PostgreSQL 19.
 *
 * The worked example's Work schema is installed by the fresh-install compiler under a fresh schema name. TaskNote
 * matched to Task on its deferred foreign key may drop the Task match in a snapshot template only (R03). Inside a write
 * transaction that has made the deferred key temporarily false, neither the transaction-context template nor the
 * artifact a snapshot template selects there delivers the orphan. Each artifact's statements run as the runtime runs
 * them: the executable texts, placeholders filled by the statement's own encoders, every result column cast to text by
 * the statement itself.
 */
const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`
const A = id(0x1001)
const B = id(0x1002)
const C = id(0x1003)
const t = (n: number) => id(0x3000 + n)

/** An INSERT into a relation's table, its table and columns named as the installation names them. */
const insertInto = (
	names: PhysicalNames,
	relation: string,
	fields: ReadonlyArray<string>,
	rows: string
): string =>
	`INSERT INTO ${printObjectName(names.relation(relation))} (${Arr.join(
		Arr.map(fields, (f) => quoteIdent(names.column(relation, f))),
		", "
	)}) VALUES ${rows}`

const facts = (names: PhysicalNames): ReadonlyArray<string> => [
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
		`('${t(1)}', '${A}', 'Automatic'), ('${t(2)}', '${A}', 'Manual'), ('${t(3)}', '${B}', 'Automatic'), ('${t(4)}', '${C}', 'Manual'), ('${t(5)}', '${A}', 'Automatic')`
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

/** TaskNote matched to Task on its deferred foreign key: R03 in a snapshot only. */
const notes = query(Work).rule((r) => {
	const { task, note } = v(TaskNote, "taskNote")
	return r.match(TaskNote, { task, note }).match(Task, { id: task }).find({ task, note })
})

type Raw = ReadonlyArray<ReadonlyArray<string>>
/** The rows a statement returns: every result column cast to text by the statement itself, never NULL. */
const rawOf = (rows: unknown): Raw => trusted<Raw>(rows)

/** The statements an artifact runs, in order, on `session`, a raw session inside its own transaction. */
const runSpecs = (
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
): QueryTemplate => {
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

layer(Substrate.layer)("compiled templates on PostgreSQL 19", (it) => {
	const installed = Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label: "template" })
		const owned = owning(Work)
		const installation = compileInstallation(owned, {
			...installOptions(owned, s.owner.role),
			installation: identity.schema(parsedSchemaName(schema))
		})
		if (!installation.ok) {
			return yield* Effect.die(new Error(installation.error.message))
		}
		yield* transaction(s.admin, [
			...installationSql(installation.value),
			...facts(installation.value.names)
		])
		return { schema, names: installation.value.names }
	})

	it.effect(
		"inside a write transaction neither the transaction template nor a snapshot template delivers an orphan",
		() =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const { schema, names } = yield* installed
				const snapshot = compiled(notes, schema, "snapshot")
				const tx = compiled(notes, schema, "transaction")
				const selected = selectArtifact(snapshot, "transaction")
				assert.equal(selected.artifact, "conservative")
				const session = yield* s.session({ ...ownerSession(), label: "writer" })
				yield* session.begin
				yield* session.query(
					insertInto(names, TaskNote.name, ["task", "note"], `('${t(9)}', 'orphan')`),
					[]
				)
				/** The rows of an artifact's first statement, the one that delivers the notes. */
				const delivered = (raws: ReadonlyArray<Raw>): Raw =>
					defined(raws[0], "the delivering statement's rows")
				const optimizedRuns = yield* runSpecs(tx.optimized, {}, session)
				const kept = delivered(optimizedRuns)
				lacks(kept.flat(), t(9))
				assert.equal(kept.length, 2)
				const selectedRuns = yield* runSpecs(selected.statements, {}, session)
				const conservative = delivered(selectedRuns)
				lacks(conservative.flat(), t(9))
				assert.equal(conservative.length, 2)
				yield* session.rollback
			})
	)
})
