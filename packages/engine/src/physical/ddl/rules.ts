import {
	newProbes,
	oldProbes,
	type Probe,
	type ProbeParam,
	type TouchedField
} from "#compiler/analysis/theory/query.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { unsupported } from "#compiler/core/errors.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import {
	appendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { allRows, defaultOpclass, type LawField, type RelationInfo } from "#compiler/ir/law.ts"
import type { IndexRequest } from "#compiler/ir/products.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { RuleTable, RuleTrigger } from "#compiler/laws/model/model.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import { lowerOptimized, optimizedInput } from "#compiler/lower/optimize/pipeline.ts"
import { extractAccess } from "#compiler/physical/access/extract.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { unaliased } from "#compiler/physical/derived/definition.ts"
import type {
	CreateConstraintTrigger,
	Expr,
	OperandSelect,
	PlFunction,
	PlStatement,
	Revoke,
	TriggerEvent
} from "#compiler/sql/ast.ts"
import { exists, lit, ne, objectName, types } from "#compiler/sql/build.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"

/**
 * Rules over queries in the installation: each rule's deferred constraint trigger on every table it reads, and the
 * function each trigger runs.
 *
 * A rule one of whose sides reads a derived relation is held by PostgreSQL's own mechanism for a rule that spans
 * tables, the one its foreign keys are built from: a constraint trigger, AFTER the row events that can break it,
 * DEFERRABLE INITIALLY DEFERRED and FOR EACH ROW, so PostgreSQL runs it at COMMIT for every row the transaction
 * touched, on the state the transaction leaves:
 *
 * - on a table the rule's breaking side reads (a containment's source, a key's or a check's relation), INSERT and an
 *   UPDATE of a column it reads, whose probes (analysis/theory/query.ts newProbes) read the side's facts the row at
 *   NEW's primary key derives;
 * - on a table a containment's target reads, DELETE and an UPDATE of a column it reads, whose probes (lostProbes) read
 *   the target tuples OLD's row may have withdrawn and the source tuples that needed them.
 *
 * Each probe is a query description grizzle's own compiler checks and lowers, through the optimized lowering under the
 * transaction's evidence, since another deferred constraint may still be pending when it runs; each of its
 * parameters is a field of NEW or OLD, read in place. A probe that returns a row raises SQLSTATE 23503 for a
 * containment, 23505 for a key and 23514 for a check, naming the rule's trigger as its constraint and the table it
 * fired on, with no DETAIL, since the writer may not see the rows. The function is SECURITY DEFINER under
 * closedSearchPath, every name it reads schema-qualified, and EXECUTE on it is revoked from PUBLIC at once. Every
 * writer is SERIALIZABLE (isolation.ts), so PostgreSQL's SSI orders each probe's reads against a concurrent write.
 *
 * Each probe's access paths (physical/access/extract.ts) are law-maintenance index requests of the rule, so a probe
 * reads by index wherever the planner can, and its cost follows the write.
 */
export const addRules = (b: InstallBuilder): ReadonlyArray<IndexRequest> => {
	const catalog = evidenceCatalog({ laws: b.model, views: [] })
	return b.model.rules.flatMap((rule) =>
		rule.tables.flatMap((table) => addRuleTable(b, catalog, rule, table))
	)
}

/** A compiled probe: the statement whose rows break the rule, its outputs unaliased, and its index requests. */
interface Compiled {
	readonly statement: OperandSelect
	readonly requests: ReadonlyArray<IndexRequest>
}

const touched = (f: LawField): TouchedField => ({ name: f.name, desc: f.desc })

/** The SQLSTATE condition a rule's kind raises under. */
const conditionOf = (rule: RuleTrigger): string => {
	switch (rule.rule.kind) {
		case "contained":
			return "foreign_key_violation"
		case "key":
			return "unique_violation"
		case "check":
			return "check_violation"
	}
}

/** One table's function and trigger of a rule, returning its probes' index requests. */
const addRuleTable = (
	b: InstallBuilder,
	catalog: ReturnType<typeof evidenceCatalog>,
	rule: RuleTrigger,
	table: RuleTable
): ReadonlyArray<IndexRequest> => {
	const relation = table.relation
	const loc = rule.law.loc
	const key = mapNonEmpty(relation.primaryFields, touched)
	const fields = relation.fields.map(touched)
	const compile = (probe: Probe): Compiled => compileProbe(b, catalog, rule, relation, probe)
	const news =
		table.touches.kind === "olds"
			? []
			: newProbes(rule.rule, relation.name, key, fields, loc).map(compile)
	const olds =
		table.touches.kind === "news"
			? []
			: oldProbes(rule.rule, relation.name, fields, loc).map(compile)
	const raise: PlStatement = {
		kind: "raise",
		message: "a write breaks a rule over a query",
		using: [
			{ option: "ERRCODE", value: lit.text(conditionOf(rule), types.text) },
			{ option: "CONSTRAINT", value: lit.text(identifierOf(rule.named), types.text) },
			{ option: "SCHEMA", value: { kind: "plSpecial", name: "TG_TABLE_SCHEMA" } },
			{ option: "TABLE", value: { kind: "plSpecial", name: "TG_TABLE_NAME" } }
		]
	}
	const probing = (
		skipped: "INSERT" | "DELETE",
		probes: ReadonlyArray<Compiled>
	): ReadonlyArray<PlStatement> =>
		probes.length === 0
			? []
			: [
					{
						kind: "if",
						branches: [
							{
								condition: ne({ kind: "plSpecial", name: "TG_OP" }, lit.text(skipped, types.text)),
								body: probes.map((p): PlStatement => ({
									kind: "if",
									branches: [{ condition: exists(p.statement), body: [raise] }],
									else: []
								}))
							}
						],
						else: []
					}
				]
	const fn = objectName(b.schema, identifierOf(table.function))
	const ddl: readonly [PlFunction, Revoke] = [
		{
			kind: "createFunction",
			language: "plpgsql",
			name: fn,
			params: [],
			returns: "trigger",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			planCacheMode: "force_custom_plan",
			body: {
				declare: [],
				body: appendNonEmpty([...probing("DELETE", news), ...probing("INSERT", olds)], {
					kind: "return",
					value: { kind: "plSpecial", name: "NEW" }
				})
			}
		},
		{
			kind: "revoke",
			privileges: ["EXECUTE"],
			on: { kind: "FUNCTION", names: [{ ...fn, args: [] }] },
			from: [{ kind: "PUBLIC" }]
		}
	]
	const reads = rule.law.reads.flatMap((name) =>
		b.model.relations.has(name) ? [b.table(name)] : []
	)
	const fnNode = b.add(
		{
			kind: "lawFunction",
			ident: b.qualified("function", table.function),
			ddl,
			reasons: [{ kind: "law", law: rule.law.id }],
			phase: "validate"
		},
		reads
	)
	const trigger: CreateConstraintTrigger = {
		kind: "createConstraintTrigger",
		name: identifierOf(rule.named),
		table: b.names.relation(relation.name),
		events: eventsOf(table, relation),
		function: fn
	}
	b.add(
		{
			kind: "lawTrigger",
			ident: {
				kind: "trigger",
				schema: b.settings.installation,
				relation: b.names.relationNamed(relation.name),
				name: rule.named
			},
			ddl: [trigger],
			reasons: [{ kind: "law", law: rule.law.id }],
			phase: "validate"
		},
		[fnNode, b.table(relation.name)]
	)
	return [...news, ...olds].flatMap((p) => p.requests)
}

/** The column identifiers of `relation`'s fields named `fields`. */
const columnsOf = (relation: RelationInfo, fields: ReadonlyArray<string>): ReadonlyArray<string> =>
	fields.flatMap((name) => relation.fields.flatMap((f) => (f.name === name ? [f.column] : [])))

/**
 * The row events a table's trigger fires on: INSERT and an UPDATE of a column read where a new row can break the rule;
 * DELETE and such an UPDATE where an old row's absence can (analysis/theory/query.ts Touches).
 */
const eventsOf = (
	table: RuleTable,
	relation: RelationInfo
): NonEmptyReadonlyArray<TriggerEvent> => {
	const t = table.touches
	const [first, ...events]: NonEmptyReadonlyArray<TriggerEvent> =
		t.kind === "news"
			? [{ kind: "insert" }]
			: t.kind === "olds"
				? [{ kind: "delete" }]
				: [{ kind: "insert" }, { kind: "delete" }]
	const read = t.kind === "news" ? t.news : t.kind === "olds" ? t.olds : [...t.news, ...t.olds]
	const [column, ...columns] = [...new Set(columnsOf(relation, read))]
	return column === undefined
		? [first, ...events]
		: [first, ...events, { kind: "update", columns: [column, ...columns] }]
}

/**
 * A probe checked and lowered by the optimized pipeline under the transaction's evidence, each parameter read from
 * NEW's or OLD's column in place, with the index requests of its access paths.
 */
const compileProbe = (
	b: InstallBuilder,
	catalog: ReturnType<typeof evidenceCatalog>,
	rule: RuleTrigger,
	relation: RelationInfo,
	probe: Probe
): Compiled => {
	const label = `rule ${rule.law.named.display} on ${relation.name}`
	const lowered = Result.flatMap(
		checkQuery(b.checked, probe.query, { read: "rows", label }),
		(checked) =>
			Result.map(
				Result.flatMap(optimizedInput(checked, queryEvidence), (annotated) =>
					lowerOptimized(annotated, {
						names: b.names,
						subject: { kind: "query" },
						context: "transaction",
						catalog
					})
				),
				(program) => ({ program, checked })
			)
	)
	if (!lowered.ok) {
		throw new Refusal(lowered.error)
	}
	const { program, checked } = lowered.value
	const [root, ...rest] = program.roots
	const main = root.statement
	if (
		rest.length > 0 ||
		root.attachments.length > 0 ||
		main.role.kind !== "main" ||
		main.forms.kind !== "one"
	) {
		throw new Refusal(
			unsupported(relation.loc, `${label}: a probe that lowers to one main statement`)
		)
	}
	const numbered = new Map<number, ProbeParam>(
		main.params.flatMap((p) => {
			const read = probe.params.get(p.param)
			return read === undefined ? [] : [[p.number, read] as const]
		})
	)
	const column = (field: string): string =>
		relation.fields.find((f) => f.name === field)?.column ?? missingColumn(relation, field)
	const statement = transformSelect(main.ast, {
		...identityHooks,
		expr: (e: Expr): Expr => {
			if (e.kind !== "param") {
				return e
			}
			const read = numbered.get(e.slot.number)
			return read === undefined
				? missingColumn(relation, `parameter ${e.slot.number}`)
				: {
						kind: "cast",
						expr: {
							kind: "field",
							record: { kind: "plSpecial", name: read.record },
							field: column(read.field)
						},
						type: e.type
					}
		}
	})
	const access = extractAccess([checked.dag.roots[0]], { pageable: [] })
	return {
		statement: { ...statement, body: unaliased(statement.body) },
		requests: access.paths.flatMap((path): ReadonlyArray<IndexRequest> => {
			const target = b.model.relations.get(path.relation)?.relation
			if (target === undefined || path.method === "hnsw" || path.derived) {
				return []
			}
			const keys = path.keys.flatMap((k) =>
				target.fields.flatMap((f) =>
					f.name === k.field
						? [
								{
									column: { kind: "field" as const, field: f },
									dir: k.dir,
									opclass: defaultOpclass
								}
							]
						: []
				)
			)
			return isNonEmpty(keys)
				? [
						{
							relation: target.name,
							keys,
							method: path.method,
							role: "lawMaintenance",
							use: "rule probe",
							rows: allRows,
							justification: { kind: "law", law: rule.law.id }
						}
					]
				: []
		})
	}
}

const missingColumn = (relation: RelationInfo, what: string): never => {
	throw new Refusal(
		unsupported(
			relation.loc,
			`a probe parameter reading a column of ${relation.name}; ${what} is none`
		)
	)
}
