import { defect } from "@bjornpagen/grizzle-text/base/invariant"
/**
 * The re-check of a data step (README, Migrations): what a write that lifts the immutability guards
 * (physical/ddl/immutable.ts guardBracket) owes the judge, which compiles under the premise that no served write
 * updates or deletes a closed relation's rows (analysis/theory/query.ts isClosedRelation). Under that premise no judge or
 * upkeep reads the rows a write removes of a closed relation, and a probe of the rows a write adds to one reads none of
 * them where a sibling pins a key of it (query.ts Cover `fresh`). A data step's hand-written statements, a reviewer's at
 * a draft's placeholder or a custom migration's file, may delete or rewrite such rows, so the data step pays for the
 * premise once, in its own transaction, after its statements and before the guards stand again
 * (immutable.ts dataStepBracket, deploy/diff/diff.ts structure.recheck):
 *
 * - each stored derived relation whose definition reads a closed relation, as a holder or by reference (ir/unit.ts
 *   StoredUnit `references`), every relation under a sealed unit being closed, is made its definition's rows again, by one
 *   MERGE of its table from its definition (`refillOf`): one statement, so no transient state between a DELETE and an
 *   INSERT reaches the judge, which runs at the end of each statement once SET CONSTRAINTS ALL IMMEDIATE holds. Rows
 *   that stand equal are untouched, a row that differs past its key is updated, and every other is inserted or deleted;
 *   the judge then reads the table's own changes from its captures as it reads an upkeep's. In the judge's upkeep order,
 *   level by level, each after every stored relation it reads;
 * - each rule over a query that reads a closed relation is checked over every row (Installation ruleChecks), its
 *   violation raising 23000 under the law's identity as a migration's check of a law does (`violationCheck`), so a
 *   step that breaks it is refused naming the law, and rolled back with its transaction.
 *
 * A rule whose relations are all mutable, and a stored relation over mutable relations alone, read every side the
 * judge's premise spares nothing of, so the judge holds them as it holds a served write. Each table the re-check reads
 * is read a bounded number of times per occurrence of a law over it: a definition once per stored relation, a rule's
 * check as the migration that adds the rule runs it.
 */
import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { isClosedRelation } from "#compiler/analysis/theory/query.ts"
import type { StoredUpkeep } from "#compiler/analysis/theory/unit.ts"
import { identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { revokeOf } from "#compiler/physical/ddl/deltas.ts"
import { lastNumbered, tableNode } from "#compiler/physical/ddl/rules.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import {
	type CreateStoredTable,
	type Merge,
	type MergeWhen,
	nameKey,
	type OperandSelect,
	type PlBlock,
	type PlFunction,
	type PlStatement,
	type StoredColumnKey,
	storedColumnKey
} from "#compiler/sql/ast.ts"
import {
	and,
	call,
	col,
	derived,
	eq,
	lit,
	objectName,
	types,
	whenFound
} from "#compiler/sql/build.ts"
import { assignments, ungenerated } from "#compiler/sql/generation.ts"
import { namedQuery } from "#compiler/sql/naming.ts"

/** A rule's check over every row, by its law (Installation ruleChecks). */
export interface LawCheck {
	readonly law: LawId
	readonly query: OperandSelect
}

/**
 * A stored table's refill (DataStepRecheck `refills`): its MERGE from its definition (`refillOf`), the manifest object
 * of its table (`object`, its identity's text), and the stored columns of the holders its definition reads (`reads`),
 * which a draft's own steps re-check it by (deploy/diff/diff.ts recheck).
 */
export interface Refill {
	readonly statement: Merge
	readonly object: string
	readonly reads: ReadonlySet<StoredColumnKey>
}

/**
 * What a data step's bracket runs after its statements (the module's doc): each stored relation over a closed relation
 * refilled, in the judge's upkeep order, then each rule over a closed relation checked over every row, in law order.
 * At least one of either, else the installation has none.
 */
export interface DataStepRecheck {
	readonly refills: ReadonlyArray<Refill>
	readonly checks: ReadonlyArray<LawCheck>
}

/**
 * A law's violation check, the block a migration runs it by, a DO block of its own (deploy/render/sql.ts) or a statement
 * of the re-check (`recheckBlock`): its violation query read whole, SQLSTATE 23000 raised under the law's identity when
 * it finds a row (sql/build.ts whenFound), as the law function itself raises, so a violating file rolls back with the
 * law's identity.
 */
export const violationCheck = (law: LawId, query: OperandSelect): PlBlock => ({
	declare: [],
	body: [
		whenFound(query, [
			{
				kind: "raise",
				message: `law ${law} is violated by existing rows`,
				using: [
					{ option: "ERRCODE", value: lit.text("integrity_constraint_violation", types.text) },
					{ option: "CONSTRAINT", value: lit.text(law, types.text) }
				]
			}
		])
	]
})

/**
 * The re-check as one PL/pgSQL block (DataStepRecheck): its refills, then its checks, every one a whole read
 * (sql/ast.ts PlStatement `wholeReads`): each reads every row it reads once per data step, at no binding, so PostgreSQL
 * joins them by a hash, never a probe per row (sql/bind.ts, a whole statement's binding), each read whole or at the
 * values it fixes. No index stands for a data step alone.
 */
const recheckBlock = (r: DataStepRecheck): PlBlock => {
	const body: ReadonlyArray<PlStatement> = [
		...r.refills.map((f): PlStatement => ({ kind: "modify", statement: f.statement })),
		...r.checks.flatMap((c) => violationCheck(c.law, c.query).body)
	]
	if (!isNonEmpty(body)) {
		defect("a data step's re-check of a refill or a check at least")
	}
	return { declare: [], body: [{ kind: "wholeReads", body }] }
}

/**
 * The MERGE that makes the stored table `create` makes its definition's rows (DataStepRecheck `refills`), keyed by
 * `key`, its primary key's columns:
 *
 *   MERGE INTO <S> AS r<n+2> USING (<its definition>) AS r<n+1> (c1, …) ON <the key's columns equal>
 *     WHEN NOT MATCHED THEN INSERT (<columns>) VALUES (…)
 *     WHEN NOT MATCHED BY SOURCE THEN DELETE
 *     WHEN MATCHED AND record_image_ne(ROW(<S's other columns>), ROW(<the definition's>)) THEN UPDATE SET …
 *
 * The comparison past the key is the binary one, `*<>`'s, which the immutability guard decides a change by: a row is
 * written exactly where its stored bytes differ. A table its key spans whole has no clause of MATCHED.
 */
const refillOf = (create: CreateStoredTable, key: ReadonlyArray<string>): Merge => {
	/** The generated name the definition's derived table gives the column `column` of S's, c<i+1> at its place i. */
	const generated = (column: string): string => `c${create.columns.indexOf(column) + 1}`
	const definition = namedQuery(create.query, create.columns.map(generated))
	const source = `r${lastNumbered(definition) + 1}`
	const target = `r${lastNumbered(definition) + 2}`
	const from = (column: string) => col(source, generated(column))
	const keyed = create.columns.filter((c) => key.includes(c))
	const rest = create.columns.filter((c) => !key.includes(c))
	if (!isNonEmpty(keyed)) {
		defect(`the key of the stored table ${create.name.name} among its columns`)
	}
	return {
		kind: "merge",
		with: undefined,
		table: create.name,
		alias: target,
		using: derived(definition, source, false),
		on: and(mapNonEmpty(keyed, (c) => eq(col(target, c), from(c)))),
		whens: [
			{
				match: "NOT MATCHED",
				condition: undefined,
				action: {
					kind: "insert",
					row: mapNonEmpty(create.columns, (c) => ({ column: c, value: from(c) }))
				}
			},
			{ match: "NOT MATCHED BY SOURCE", condition: undefined, action: { kind: "delete" } },
			...(isNonEmpty(rest)
				? [
						{
							match: "MATCHED",
							condition: call("record_image_ne", [
								{ kind: "row", items: mapNonEmpty(rest, (c) => col(target, c)) },
								{ kind: "row", items: mapNonEmpty(rest, from) }
							]),
							action: {
								kind: "update",
								set: assignments(
									ungenerated,
									target,
									mapNonEmpty(rest, (c) => ({ column: c, value: from(c) }))
								)
							}
						} satisfies MergeWhen
					]
				: [])
		],
		returning: []
	}
}

/**
 * The installation's re-check of a data step (DataStepRecheck), from each rule's check over every row (`checks`), and
 * its function (identity.dataStepRecheck), which a custom migration's data step calls: none where no rule and no stored
 * relation reads a closed relation. SECURITY DEFINER, as the judge, its EXECUTE revoked from PUBLIC: the migration's
 * owner calls it.
 */
export const addDataStepRecheck = (
	b: InstallBuilder,
	checks: ReadonlyMap<LawId, OperandSelect>
): DataStepRecheck | undefined => {
	const relations = b.model.theory.relations
	const readsClosed = (names: Iterable<string>): boolean =>
		[...names].some((name) => isClosedRelation(relations[name]))
	/** Whether the upkeep `u`'s stored relation reads a closed relation, a holder or a relation it reads by reference,
	 * whose rows only a data step removes or rewrites. */
	const overClosed = (u: StoredUpkeep): boolean =>
		u.stored.references.length > 0 || readsClosed(u.reads.map((r) => r.relation))
	/** The stored column of `relation`'s field `field`, as a draft's steps name the columns they write (StepWrites). */
	const columnKeyOf = (relation: string, field: string): StoredColumnKey =>
		storedColumnKey(nameKey(b.names.relation(relation)), b.names.column(relation, field))
	/**
	 * The fields of a relation a stored relation reads by reference (ir/unit.ts StoredUnit `references`), every one of
	 * them a read of its refill: a step that writes any column of it may change what the definition derives.
	 */
	const referencedFields = (name: string) => {
		const relation = relations[name]
		if (relation === undefined) {
			defect(`the relation ${name} a stored relation reads by reference`)
		}
		return relation.fields
	}
	const after: Array<Node<"setup" | "structure">> = []
	const refills = b.model.theory.upkeeps.flatMap((u): ReadonlyArray<Refill> => {
		if (!overClosed(u)) {
			return []
		}
		const stored = b.storedTable(u.relation)
		const create = stored?.ddl.find((s) => s.kind === "createStoredTable")
		if (stored === undefined || create?.kind !== "createStoredTable") {
			defect(`the table of the stored relation ${u.relation}, installed before its re-check`)
		}
		after.push(stored)
		return [
			{
				statement: refillOf(
					create,
					b.storedPrimaryKey(u.relation).map((f) => b.names.column(u.relation, f))
				),
				object: stored.text,
				reads: new Set([
					...u.reads.flatMap((read) => read.columns.map((f) => columnKeyOf(read.relation, f))),
					...u.stored.references.flatMap((name) =>
						referencedFields(name).map((f) => columnKeyOf(name, f.name))
					)
				])
			}
		]
	})
	const ruled = b.model.rules.filter((r) => readsClosed(r.law.reads))
	for (const r of ruled) {
		for (const t of r.tables) {
			after.push(tableNode(b, t.relation))
		}
	}
	const rechecked: DataStepRecheck = {
		refills,
		checks: ruled.map((r) => {
			const query = checks.get(r.law.id)
			if (query === undefined) {
				defect(`the check over every row of ${r.law.named.display}`)
			}
			return { law: r.law.id, query }
		})
	}
	if (!isNonEmpty(rechecked.refills) && !isNonEmpty(rechecked.checks)) {
		return undefined
	}
	const named = identity.dataStepRecheck()
	const fn = objectName(b.schema, b.name(named))
	const ddl: readonly [PlFunction, ReturnType<typeof revokeOf>] = [
		{
			kind: "createFunction",
			advice: noAdvice,
			language: "plpgsql",
			name: fn,
			params: [],
			returns: "void",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			body: recheckBlock(rechecked)
		},
		revokeOf(fn, [])
	]
	b.add(
		{
			kind: "lawFunction",
			ident: b.qualified("function", named),
			ddl,
			reasons: [
				...ruled.map((r) => ({ kind: "law" as const, law: r.law.id })),
				...b.model.theory.upkeeps.flatMap((u) =>
					overClosed(u) ? [enforcement(`derived relation ${u.relation}`)] : []
				)
			],
			phase: "validate"
		},
		[...new Set(after)]
	)
	return rechecked
}
