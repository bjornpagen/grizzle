import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { QueryColumns } from "#compiler/analysis/theory/columns.ts"
import { type ImportSharing, navigateQuery } from "#compiler/analysis/theory/navigate.ts"
import {
	everyRowProbes,
	type LawSide,
	type ProbedRule,
	type ProbeSide,
	probes,
	type QueryRule,
	type RuleLaw,
	touchedOn,
	type WholeRule
} from "#compiler/analysis/theory/query.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { canonicalEquals, canonicalTextOf, Refusal, unwrap } from "#compiler/core/canonical.ts"
import { unsupported } from "#compiler/core/errors.ts"
import { type Identity, identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { weightOf } from "#compiler/core/zset.ts"
import { noClock } from "#compiler/ir/clock.ts"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import {
	defaultOpclass,
	type LawIndexKey,
	type LawIndexRequest,
	type LawLookup,
	type NativeColumn,
	type RelationInfo
} from "#compiler/ir/law.ts"
import { baseTypeRef } from "#compiler/ir/physical.ts"
import type { IndexRequest, PhysicalReason } from "#compiler/ir/products.ts"
import type { DeltaSide, RelNode } from "#compiler/ir/rel.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { RuleTable, RuleTrigger } from "#compiler/laws/model/model.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import type { DeltaRelation } from "#compiler/lower/conservative/types.ts"
import { lowerOptimized, optimizedInput } from "#compiler/lower/optimize/pipeline.ts"
import { extractLookups, extractSuffixSeeks } from "#compiler/physical/access/extract.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { unaliased } from "#compiler/physical/derived/definition.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type {
	ColumnDefinition,
	CreateTransitionTrigger,
	Expr,
	FromSource,
	Insert,
	ObjectName,
	OperandSelect,
	PlBlock,
	PlFunction,
	PlStatement,
	Revoke,
	TransitionEvent,
	TransitionTable,
	TypeRef
} from "#compiler/sql/ast.ts"
import { transitionTables } from "#compiler/sql/ast.ts"
import {
	and,
	call,
	col,
	core,
	cUtf8Collation,
	derived,
	desc,
	eq,
	exists,
	gt,
	le,
	lit,
	not,
	notExists,
	objectName,
	operandSelect,
	operandUnionAll,
	or,
	provedCore,
	provedSelect,
	qualifiedCall,
	select,
	setOperation,
	simpleSelect,
	targetAs,
	types,
	whenFound,
	windowOf
} from "#compiler/sql/build.ts"
import { assignments, ungenerated } from "#compiler/sql/generation.ts"
import { printTableName, sessionTableOurs, sessionTableStands } from "#compiler/sql/print.ts"
import { type StoredColumns, storedColumns } from "#compiler/sql/stored.ts"

/** A compiled probe: the statement whose rows break the rule, its outputs unaliased, and its index requests. */
interface Compiled {
	readonly statement: OperandSelect
	readonly requests: ReadonlyArray<IndexRequest>
}

/**
 * The statements a guarded block of the judge runs, each once, in the order its first probe compiled: a set under
 * canonical equality (core/canonical.ts canonicalEquals), so a probe that compiles to a statement the block holds adds
 * nothing, and the block keeps the statement first compiled. Two occurrences of the touched relation that hold nothing
 * of its row apart (two arms of a derived relation that read it alike) are two probes of one statement, which a COMMIT
 * would otherwise run twice. A block holds a few probes, so asking each held statement is a short walk where a text of
 * every probe would encode each whole. A probe's index requests are its statement's chain's, so two probes of one
 * statement request the same indexes.
 */
const probeStatements = (
	compiled: NonEmptyReadonlyArray<Compiled>
): NonEmptyReadonlyArray<OperandSelect> => {
	const [first, ...rest] = compiled
	const held: [OperandSelect, ...Array<OperandSelect>] = [first.statement]
	for (const p of rest) {
		if (!held.some((s) => canonicalEquals(s, p.statement))) {
			held.push(p.statement)
		}
	}
	return held
}

/** The SQLSTATE condition a rule's kind raises under. */
const conditionOf = (rule: RuleTrigger): string => conditionOfRule(rule.rule)

/** The SQLSTATE condition a rule raises under, its law's. */
const conditionOfRule = (rule: QueryRule): string => {
	switch (rule.kind) {
		case "contained":
		case "key":
		case "check":
			return conditionOfLaw(rule)
		case "whole":
			return conditionOfLaw(rule.law)
	}
}

/** The SQLSTATE condition a law raises under: 23503 for a containment, 23505 for a key, 23514 for a check. */
const conditionOfLaw = (law: RuleLaw<LawSide>): string => {
	switch (law.kind) {
		case "contained":
			return "foreign_key_violation"
		case "key":
			return "unique_violation"
		case "check":
			return "check_violation"
	}
}

/** The column identifiers of `relation`'s fields named `fields`. */
const columnsOf = (relation: RelationInfo, fields: ReadonlyArray<string>): ReadonlyArray<string> =>
	fields.flatMap((name) => relation.fields.flatMap((f) => (f.name === name ? [f.column] : [])))

/**
 * A probe over its region (analysis/theory/query.ts probes), the rows the transaction wrote of `relation` on one side,
 * navigated, checked and lowered as every query the judge reads is (`judgedStatement`), with the index requests of the
 * chain that runs.
 *
 * Navigation makes the probe one chain of steps from its region, each a lookup of one relation by the columns the steps
 * before it bound, so no estimate PostgreSQL makes, with statistics or none, turns it into a join of every relation the
 * probe reads, and planning it costs a plan of each step. Its index requests are that chain's access paths
 * (`requestsOf`): each step's lookup by the columns it is bound at, so the indexes requested are exactly those the
 * probe's reads use, and the read of the region asks none, its rows the session's delta.
 */
const compileProbe = (
	b: InstallBuilder,
	catalog: ReturnType<typeof evidenceCatalog>,
	rule: RuleTrigger,
	relation: RelationInfo,
	probe: InferredQuery,
	deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined
): Compiled =>
	judgedStatement(
		b,
		catalog,
		rule,
		probe,
		b.columns,
		`rule ${rule.law.named.display} on ${relation.name}`,
		relation.loc,
		deltas,
		"perUnit"
	)

/**
 * A query the judge reads, a probe over its region or a unit-scoped rule's violation over its units: navigated wherever
 * it joins (analysis/theory/navigate.ts navigateQuery), so each relation a join of it reads, a derived relation's
 * definition included and a negated one's too, is a step read by the columns its region, its unit or the steps before it
 * bound, never a join PostgreSQL may plan as a product it filters afterwards; then checked as a region read
 * (check/checker.ts QueryRead `region`) and lowered by the optimized pipeline under the transaction's evidence, each
 * Delta node read from the session's delta table `deltas` names (RegionLowering), to one main statement of no
 * parameter, its outputs unaliased; with the index requests of `rule` its checked DAG's access paths are
 * (`requestsOf`). It reads each suffix test of a text its requests' indexes hold the suffix key of as the key's range
 * (sql/suffix.ts seekingSuffixes), and of no other. Navigation reads the
 * heading of each union it splits in `columns`: the installation's (InstallBuilder `columns`), at the definition a
 * walked copy of it was walked from where the query is a whole rule's violation over its units (WholeRule `definitionOf`).
 */
const judgedStatement = (
	b: InstallBuilder,
	catalog: ReturnType<typeof evidenceCatalog>,
	rule: RuleTrigger,
	query: InferredQuery,
	columns: QueryColumns,
	label: string,
	loc: SourceLoc,
	deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined,
	sharing: Exclude<ImportSharing, "perRead">
): Compiled => {
	const checked = unwrap(
		checkQuery(b.checked, navigateQuery(query, loc, columns, sharing), {
			read: "region",
			label,
			clock: noClock,
			session: new CheckSession()
		})
	)
	const requests = requestsOf(b, rule, checked.dag.roots[0])
	const lowered = unwrap(
		Result.flatMap(optimizedInput(checked, queryEvidence), (annotated) =>
			lowerOptimized(annotated, {
				names: { ...b.names, suffixed: suffixedBy(b, requests) },
				subject: { kind: "ruleRegion", deltas },
				context: "transaction",
				catalog
			})
		)
	)
	const program = lowered
	const parts = program.parts
	if (
		parts.kind !== "one" ||
		parts.delivered.role.kind !== "main" ||
		program.statement.forms.kind !== "one"
	) {
		throw new Refusal(
			unsupported(loc, `${label}: a judged query that lowers to one main statement`)
		)
	}
	const main = parts.delivered
	if (main.params.length > 0) {
		throw new Refusal(unsupported(loc, `${label}: a judged query that reads a parameter`))
	}
	const statement = main.ast
	return { statement: { ...statement, body: unaliased(statement.body) }, requests }
}

/**
 * The text columns the indexes of law `requests` hold the suffix key of (physical/indexes/engine.ts KeyTerm `suffix`),
 * by its table and column: a judged read reads each suffix test of those its own seeks read through as the key's range
 * (sql/suffix.ts seekingSuffixes), and of no other.
 */
const suffixedBy = (b: InstallBuilder, requests: ReadonlyArray<IndexRequest>): StoredColumns =>
	storedColumns(
		requests.flatMap((r) => {
			const target = b.target(r.relation)
			return r.role === "lawMaintenance" && target.kind === "built"
				? r.blocks.flat().flatMap((k) =>
						k.column.kind === "suffix"
							? [
									{
										table: b.names.relation(r.relation),
										column: target.column({ kind: "field", field: k.column.of.field.name })
									}
								]
							: []
					)
				: []
		})
	)

/**
 * The index requests of a judged query's access paths (physical/access/extract.ts), read from the root of its checked
 * DAG: law-maintenance requests of `rule`, so a judged read reads by index wherever the planner can. Each is one block
 * of its columns (ir/law.ts LawIndexRequest), but a whole rule's (`unitLead`), whose first block is its unit's key; and
 * a suffix seek's (`seekRequestsOf`).
 */
const requestsOf = (
	b: InstallBuilder,
	rule: RuleTrigger,
	root: RelNode
): ReadonlyArray<IndexRequest> => [
	...lookupRequestsOf(b, rule, root),
	...seekRequestsOf(b, rule, root)
]

/**
 * The requests of a judged query's suffix seeks (physical/access/extract.ts SuffixSeek): a B-tree whose first block is
 * the columns the seek's probe fixes by equality, where it fixes any, and whose last key is the suffix key of the text
 * it seeks (ir/law.ts SuffixColumn), which its range reads (sql/suffix.ts).
 */
const seekRequestsOf = (
	b: InstallBuilder,
	rule: RuleTrigger,
	root: RelNode
): ReadonlyArray<IndexRequest> =>
	extractSuffixSeeks([root], { pageable: [] }).flatMap((seek): ReadonlyArray<IndexRequest> => {
		const target = b.model.relations.get(seek.relation)?.relation
		const text = target?.fields.find((f) => f.name === seek.column)
		if (target === undefined || text === undefined) {
			return []
		}
		const fixed = seek.fixed.flatMap((name): ReadonlyArray<LawIndexKey> =>
			target.fields.flatMap((f) =>
				f.name === name
					? [{ column: { kind: "field", field: f }, dir: "asc", opclass: defaultOpclass }]
					: []
			)
		)
		const suffix: LawIndexKey = {
			column: { kind: "suffix", of: { kind: "field", field: text } },
			dir: "asc",
			opclass: defaultOpclass
		}
		return [
			{
				relation: target.name,
				blocks: isNonEmpty(fixed) ? [fixed, [suffix]] : [[suffix]],
				reads: { kind: "rows" },
				method: "btree",
				role: "lawMaintenance",
				use: "rule probe",
				justification: { kind: "law", law: rule.law.id }
			}
		]
	})

/** The requests of a judged query's lookups (`requestsOf`). */
const lookupRequestsOf = (
	b: InstallBuilder,
	rule: RuleTrigger,
	root: RelNode
): ReadonlyArray<IndexRequest> =>
	extractLookups([root], { pageable: [] }).flatMap(
		({ path, binds }): ReadonlyArray<IndexRequest> => {
			const target = b.model.relations.get(path.relation)?.relation
			if (target === undefined || path.method === "hnsw" || path.method === "gin" || path.derived) {
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
			const lead = isNonEmpty(keys) ? unitLead(rule, target, keys, binds) : undefined
			return lead === undefined
				? []
				: [
						{
							relation: target.name,
							...lead,
							method: path.method,
							role: "lawMaintenance",
							use: "rule probe",
							justification: { kind: "law", law: rule.law.id }
						}
					]
		}
	)

/**
 * The blocks of a judged read's request over `relation` by `keys`, and what each lookup of it reads (ir/law.ts
 * LawIndexRequest), `binds` the columns each lookup through its path fixes by equality (physical/access/paths.ts
 * Lookup): one block of its keys for a probed rule's, which reads rows; for a whole rule's, first the fields `relation`
 * holds its unit's key in (ir/unit.ts Unit holders) that the read's path binds, the longest run of them from the first in
 * the unit key's order, then the rest, so an index the request asks for never reads past the unit and none another
 * column leads serves it, and a lookup that binds every one of those fields reads one unit. Its judge reads the units a
 * transaction wrote, every holder leading with that key (analysis/theory/unit.ts), so every read inside its steps binds
 * the unit; a whole rule's read whose path binds no field of it is its check over every row's first read, the
 * violation query's own (WholeRule `everyRow`), a scan of its relation the check makes once, which asks for no index
 * (undefined): an index led by the literals it is read at, a node's kind, would cost every write of the relation for a
 * read one migration makes.
 */
const unitLead = (
	rule: RuleTrigger,
	target: RelationInfo,
	keys: NonEmptyReadonlyArray<LawIndexKey>,
	binds: ReadonlyArray<ReadonlyArray<string>>
): Pick<LawIndexRequest, "blocks" | "reads"> | undefined => {
	const r = rule.rule
	const relation = target.name
	switch (r.kind) {
		case "contained":
		case "key":
		case "check":
			return { blocks: [keys], reads: { kind: "rows" } }
		case "whole": {
			const holder = defined(
				r.unit.holders.find((h) => h.relation === relation),
				`${relation}, a relation the whole rule ${rule.law.named.display} reads, among its unit's holders`
			)
			const keyOf = (field: string): LawIndexKey | undefined =>
				keys.find((k) => k.column.kind === "field" && k.column.field.name === field)
			const bound: Array<LawIndexKey> = []
			for (const field of holder.fields) {
				const key = keyOf(field)
				if (key === undefined) {
					break
				}
				bound.push(key)
			}
			const rest = keys.filter((k) => !bound.includes(k))
			const lookups = binds.map((columns): ReadonlyArray<NativeColumn> =>
				target.fields.flatMap((field): ReadonlyArray<NativeColumn> =>
					columns.includes(field.name) ? [{ kind: "field", field }] : []
				)
			)
			const reads: LawLookup =
				bound.length === holder.fields.length && isNonEmpty(lookups)
					? { kind: "unit", lookups }
					: { kind: "rows" }
			return isNonEmpty(bound)
				? { blocks: isNonEmpty(rest) ? [bound, rest] : [bound], reads }
				: undefined
		}
	}
}

/**
 * A block of the judge's statements that holds one rule, ordered among the judge's blocks by its rule's trigger, and the
 * deltas its statements read, those of each side its rule's writes can break on each table they read (RuleTable
 * touches): a probe's region is the one delta of its table's side, a whole rule's region every delta of its unit's
 * holders on each side its occurrences read (analysis/theory/unit.ts regionOf). Over deltas that hold no row its
 * region is empty and every statement of it finds none, so the judge runs it only where one of them holds a row
 * (`addRules`).
 */
interface Judged {
	readonly rule: RuleTrigger
	readonly order: string
	readonly reads: NonEmptyReadonlyArray<SessionDelta>
	readonly body: NonEmptyReadonlyArray<PlStatement>
}

/**
 * The stem of the name of a session's delta of each side (identity.ruleDelta), which its table of pg_temp is named by:
 * the side of what a transaction adds is `news` and of what it removes `olds`, as every installed judge and capture
 * names them.
 */
const deltaStem = { added: "news", removed: "olds" } as const satisfies Record<ProbeSide, string>

/**
 * A session's delta of one side of a table (`addRules`): the name of its table of pg_temp, its columns, its relation's
 * heading in the canonical order a query reads it in, a Delta node's (check/checker.ts), each of its field's base type,
 * so no session's table depends on a domain a migration alters or drops (PostgreSQL refuses ALTER DOMAIN ... ADD
 * CONSTRAINT over another session's temporary table, and DROP DOMAIN while one names it), and the table's own columns:
 * the heading's, then, on the side of news, the count of each image (`countColumn`).
 */
interface SessionDelta {
	readonly ident: Identity<"ruleDelta">
	readonly name: string
	readonly columns: NonEmptyReadonlyArray<ColumnDefinition>
	readonly table: NonEmptyReadonlyArray<ColumnDefinition>
}

/**
 * The column a side of news counts each image it holds in (`addRules`): the image's weight in the transaction's change,
 * a Z-set (core/zset.ts weightOf), 1 for an image a statement put and -1 for one it removed. No heading column is so
 * named: a declared field's column never starts with `__`, and a law column's name carries its digest after its stem.
 */
export const countColumn = "__count"

/**
 * One side of a table the judge holds: its delta, and the columns a statement's UPDATE of a row must change for the
 * row to stand in it, the key and every column a rule reads on that side (analysis/theory/query.ts Touches), none
 * where no rule's facts on that side read a column the UPDATE can change. A row's image is its value in those columns.
 */
interface JudgedSide {
	readonly side: ProbeSide
	readonly delta: SessionDelta
	readonly read: ReadonlyArray<string>
}

/** A table the judge holds: its relation, the rules over queries that read it in trigger-name order, and its sides. */
interface JudgedTable {
	readonly relation: RelationInfo
	readonly rules: NonEmptyReadonlyArray<{ readonly rule: RuleTrigger; readonly table: RuleTable }>
	readonly sides: NonEmptyReadonlyArray<JudgedSide>
}

/** The catalog table `name` of pg_catalog under `alias`. */
const catalogTable = (name: string, alias: string): FromSource => ({
	kind: "table",
	table: objectName("pg_catalog", name),
	alias
})

/** The table of pg_temp named `name`. */
const sessionTable = (name: string): ObjectName => objectName(temporarySchema, name)

/** That the session's table named `name`, which stands, holds a row, read under `alias`. */
const holding = (name: string, alias: string): Expr =>
	exists(simpleSelect([], [{ kind: "table", table: sessionTable(name), alias }], undefined))

/**
 * The refusal of a session table some other role made under the judge's name: a login that creates one first could
 * empty it before COMMIT, so the judge never reads a table its definer did not create.
 */
const foreign = (name: string): PlStatement => foreignOf(lit.text(name, types.text))

/** The refusal of a session table some other role made under the judge's name (`foreign`), the table's name `table`. */
const foreignOf = (table: Expr): PlStatement => ({
	kind: "raise",
	message: "a session table of the rule judge that the judge's definer does not own",
	using: [
		{ option: "ERRCODE", value: lit.text("insufficient_privilege", types.text) },
		{ option: "SCHEMA", value: lit.text(temporarySchema, types.text) },
		{ option: "TABLE", value: table }
	]
})

/** Creates the delta where the session holds none, and refuses one the definer does not own (`foreign`). */
const ensured = (delta: SessionDelta): PlStatement => ({
	kind: "if",
	branches: [
		{
			condition: not(sessionTableStands(delta.name)),
			body: [
				{
					kind: "createSessionTable",
					name: delta.name,
					columns: delta.table,
					notNull: false,
					primaryKey: undefined
				}
			]
		},
		{ condition: not(sessionTableOurs(delta.name, [], [])), body: [foreign(delta.name)] }
	],
	else: []
})

/**
 * Creates the sentinel and its trigger, which runs `judge`, where the session holds none, and refuses one the definer
 * does not own or whose trigger runs no judge of this installation (`foreign`): a sentinel left without its trigger, by a
 * DROP ... CASCADE of the judge, would arm nothing.
 */
const armedSentinel = (sentinel: string, judge: ObjectName): PlStatement => ({
	kind: "if",
	branches: [
		{
			condition: not(sessionTableStands(sentinel)),
			body: [
				{
					kind: "createSessionTable",
					name: sentinel,
					columns: sentinelTable,
					notNull: false,
					primaryKey: undefined
				},
				{ kind: "createSessionTrigger", name: sentinel, table: sentinel, function: judge }
			]
		},
		{
			condition: not(
				sessionTableOurs(
					sentinel,
					[catalogTable("pg_trigger", "r3")],
					[
						eq(col("r3", "tgrelid"), col("r2", "oid")),
						eq(
							col("r3", "tgfoid"),
							call("to_regprocedure", [lit.text(`${printTableName(judge)}()`, types.text)])
						)
					]
				)
			),
			body: [foreign(sentinel)]
		}
	],
	else: []
})

/**
 * The sentinel's one row where none stands, written by a capture after its rows and its marks (`marked`), so its
 * written set names each of `deltas` that holds a row:
 *
 *   INSERT INTO pg_temp.<sentinel> (__written)
 *   SELECT ARRAY(SELECT '<delta>' WHERE EXISTS (SELECT FROM pg_temp.<delta>) UNION ...)
 *   WHERE NOT EXISTS (SELECT FROM pg_temp.<sentinel>)
 *
 * The row's INSERT fires the judge's trigger: deferred, at COMMIT or SET CONSTRAINTS ALL IMMEDIATE, as before; after
 * SET CONSTRAINTS ALL IMMEDIATE, at the end of this statement of the capture, inside it, since PostgreSQL fires an
 * AFTER trigger at the end of the statement that queued it, a function's own among them. Written before the capture's
 * rows, the row fired the judge there over a written set none of them was in yet, so no write after SET CONSTRAINTS
 * ALL IMMEDIATE was judged, and its rows stood in its deltas for a later transaction's judge to read.
 */
const arming = (sentinel: string, deltas: NonEmptyReadonlyArray<SessionDelta>): PlStatement => {
	const [first, second, ...rest] = mapNonEmpty(deltas, (d, at) =>
		provedCore(
			"oneRow",
			[{ expr: lit.text(d.name, types.text), alias: undefined }],
			[],
			holding(d.name, `r${at + 2}`)
		)
	)
	return {
		kind: "modify",
		statement: {
			kind: "insert",
			with: undefined,
			table: sessionTable(sentinel),
			alias: undefined,
			onConflict: undefined,
			returning: [],
			columns: [writtenColumn],
			source: {
				kind: "query",
				query: provedSelect(
					"oneRow",
					[
						{
							expr: {
								kind: "array",
								query: select(
									second === undefined ? first : setOperation("UNION", [first, second, ...rest])
								)
							},
							alias: undefined
						}
					],
					[],
					notExists(
						simpleSelect(
							[],
							[{ kind: "table", table: sessionTable(sentinel), alias: "r1" }],
							undefined
						)
					)
				)
			}
		}
	}
}

/**
 * Marks `delta` in the transaction's written set, the sentinel row's (`writtenColumn`), where the delta holds a row:
 * every row a delta holds is the transaction's, since the judge deletes every row of each delta it reads (`partBody`)
 * and a rolled-back write's go with it, so the
 * set names exactly the deltas the transaction wrote a row into, each once, which the judge reads in place of every
 * delta the session holds (`addRules`).
 *
 *   IF EXISTS (SELECT FROM pg_temp.<delta>) THEN
 *     UPDATE pg_temp.<sentinel> SET __written = __written || '<delta>' WHERE NOT __written @> '{<delta>}'
 *   END IF
 */
const marked = (sentinel: string, delta: SessionDelta): PlStatement => {
	const set = col("r2", writtenColumn)
	return {
		kind: "if",
		branches: [
			{
				condition: holding(delta.name, "r1"),
				body: [
					{
						kind: "modify",
						statement: {
							kind: "update",
							with: undefined,
							table: sessionTable(sentinel),
							alias: "r2",
							set: assignments(ungenerated, "r2", [
								{
									column: writtenColumn,
									value: {
										kind: "binary",
										op: "||",
										left: set,
										right: lit.text(delta.name, types.text),
										schema: undefined
									}
								}
							]),
							from: [],
							where: not({
								kind: "binary",
								op: "@>",
								left: set,
								right: namesOf([delta.name]),
								schema: undefined
							}),
							returning: []
						}
					}
				]
			}
		],
		else: []
	}
}

/** A row's image on a side (`JudgedSide`): its primary key's columns, then every other column the side reads. */
const imageOf = (relation: RelationInfo, side: JudgedSide): NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = mapNonEmpty(relation.primaryFields, (f): string => f.column)
	return [first, ...rest, ...side.read.filter((c) => c !== first && !rest.includes(c))]
}

/**
 * The rows of one side a statement wrote into its delta: every row of the transition table `rows`, or, for an UPDATE,
 * each row the other transition table holds no row of with the same image (`imageOf`), so an UPDATE of columns no rule
 * reads there captures nothing. Every row stands once in a transition table, and its key with it, so the rows are a
 * set. The side of olds takes the rows a statement found as they are. The side of news counts each image by its
 * weight (core/zset.ts weightOf): 1 for a row the statement put (`news`), -1 for one it removed (`olds`), which the
 * judge nets (`netted`). A removal is counted only once the delta holds a row: before any image the transaction put
 * stands there it cancels none, and an image it removed that the transaction puts again is then judged as any it put,
 * so a write that only removes rows logs none.
 */
const captured = (
	relation: RelationInfo,
	side: JudgedSide,
	rows: TransitionTable,
	other: TransitionTable | undefined
): PlStatement => {
	const columns = mapNonEmpty(side.delta.columns, (c) => c.name)
	const unchanged =
		other === undefined
			? []
			: [
					notExists(
						simpleSelect(
							[],
							[{ kind: "transition", table: other, alias: "r2" }],
							and(mapNonEmpty(imageOf(relation, side), (c) => eq(col("r2", c), col("r1", c))))
						)
					)
				]
	const counted = side.side === "added"
	const removed = rows === transitionTables.olds
	const where = [...unchanged, ...(counted && removed ? [holding(side.delta.name, "r3")] : [])]
	const insert: Insert = {
		kind: "insert",
		with: undefined,
		table: sessionTable(side.delta.name),
		alias: undefined,
		onConflict: undefined,
		returning: [],
		columns: counted ? [...columns, countColumn] : columns,
		source: {
			kind: "query",
			query: provedSelect(
				"keyed",
				[
					...columns.map((c) => ({ expr: col("r1", c), alias: undefined })),
					...(counted
						? [
								{
									expr: lit.int(weightOf[removed ? "removed" : "added"], types.smallint),
									alias: undefined
								}
							]
						: [])
				],
				[{ kind: "transition", table: rows, alias: "r1" }],
				isNonEmpty(where) ? and(where) : undefined
			)
		}
	}
	return { kind: "modify", statement: insert }
}

/**
 * The side of news a delta nets (`addRules`'s judge): it deletes every row of an image whose counts sum to 0 or less,
 * and every row but one of each other image, which stands at COMMIT and stood nowhere before the transaction, so the
 * delta holds delta.added of its relation's images, each once: the relation's rows as the transaction leaves them minus
 * those it found (check/checker.ts Delta). That is the Z-set's one netting rule (core/zset.ts): an image's sum is its
 * weights, its puts less its removals, whatever order a statement's captures ran in, 1 where the transaction put it and
 * it stands, -1 where it removed one it found, 0 otherwise; and it stands added where its sum is positive (sideOf). An
 * image of sum -1 goes too: a removal is counted only to cancel a put, and one the transaction puts again is judged as
 * any it put. A later statement's captures count on from what the delta holds, so the judge at SET CONSTRAINTS ALL
 * IMMEDIATE nets it again from there.
 */
const netted = (relation: RelationInfo, side: JudgedSide): PlStatement => {
	const image = mapNonEmpty(imageOf(relation, side), (c) => col("r2", c))
	const counts = simpleSelect(
		[
			targetAs(col("r2", "ctid"), "c1"),
			targetAs(
				{
					...call("sum", [col("r2", countColumn)]),
					over: windowOf(image, [])
				},
				"c2"
			),
			targetAs(
				{ ...call("row_number", []), over: windowOf(image, [desc(col("r2", countColumn))]) },
				"c3"
			)
		],
		[{ kind: "table", table: sessionTable(side.delta.name), alias: "r2" }],
		undefined
	)
	return {
		kind: "modify",
		statement: {
			kind: "delete",
			with: undefined,
			table: sessionTable(side.delta.name),
			alias: "r1",
			using: [],
			where: {
				kind: "inQuery",
				expr: col("r1", "ctid"),
				query: simpleSelect(
					[{ expr: col("r3", "c1"), alias: undefined }],
					[derived(counts, "r3", ["c1", "c2", "c3"], false)],
					or([
						le(col("r3", "c2"), lit.int(0, types.bigint)),
						gt(col("r3", "c3"), lit.int(1, types.bigint))
					])
				),
				not: false
			},
			returning: []
		}
	}
}

/** A rule's RAISE, today's per-row one, naming the rule's table by literals: the judge fires on its sentinel. */
const raiseOf = (b: InstallBuilder, rule: RuleTrigger, relation: RelationInfo): PlStatement => {
	const installed = b.names.relation(relation.name)
	return {
		kind: "raise",
		message: "a write breaks a rule over a query",
		using: [
			{ option: "ERRCODE", value: lit.text(conditionOf(rule), types.text) },
			{ option: "CONSTRAINT", value: lit.text(identifierOf(rule.named), types.text) },
			{ option: "SCHEMA", value: lit.text(installed.schema, types.text) },
			{ option: "TABLE", value: lit.text(installed.name, types.text) }
		]
	}
}

/** Each table a rule over a query reads, with its rules in trigger-name order and the sides they read of it. */
const judgedTables = (b: InstallBuilder): ReadonlyArray<JudgedTable> => {
	const ordered = b.model.rules.toSorted((x, y) =>
		compareStrings(identifierOf(x.named), identifierOf(y.named))
	)
	const byRelation = new Map<
		string,
		Array<{ readonly rule: RuleTrigger; readonly table: RuleTable }>
	>()
	for (const rule of ordered) {
		for (const t of rule.tables) {
			const held = byRelation.get(t.relation.name) ?? []
			held.push({ rule, table: t })
			byRelation.set(t.relation.name, held)
		}
	}
	return [...byRelation.values()].flatMap((held): ReadonlyArray<JudgedTable> => {
		const [head, ...more] = held
		if (head === undefined) {
			return []
		}
		const relation = head.table.relation
		const columns = mapNonEmpty(relation.heading, (f): ColumnDefinition => {
			const type = baseTypeRef(b.names, f.type)
			return {
				name: f.column,
				type,
				collation: type.kind === "builtin" && type.name === "text" ? cUtf8Collation : undefined
			}
		})
		const sides = (["added", "removed"] as const).flatMap((side): ReadonlyArray<JudgedSide> => {
			const read = held.flatMap(({ table: t }) => {
				const f = touchedOn(t.touches, side)
				return f === undefined ? [] : [f]
			})
			const table =
				side === "added"
					? appendNonEmpty(columns, {
							name: countColumn,
							type: types.smallint,
							collation: undefined
						})
					: columns
			const ident = identity.ruleDelta(
				headNonEmpty(b.names.levels),
				relation.name,
				deltaStem[side],
				canonicalTextOf(table)
			)
			return read.length === 0
				? []
				: [
						{
							side,
							delta: { ident, name: b.name(ident), columns, table },
							read: [...new Set(columnsOf(relation, read.flat()))]
						}
					]
		})
		const [s0, ...ss] = sides
		return s0 === undefined ? [] : [{ relation, rules: [head, ...more], sides: [s0, ...ss] }]
	})
}

/**
 * The name of the sentinel's one column, of the judge's variable and of each part's parameter: the transaction's written
 * set, the names of the deltas its captures wrote a row into since the judge last ran (`marked`), which the judge reads
 * once a run, from the sentinel's row, and runs its parts by.
 */
const writtenColumn = "__written"

/** text[]: the names of session tables. */
const namesType: TypeRef = {
	kind: "builtin",
	name: "text",
	precision: undefined,
	scale: undefined,
	array: true
}

/** The sentinel's declaration: its one column, the written set. */
const sentinelTable: NonEmptyReadonlyArray<ColumnDefinition> = [
	{ name: writtenColumn, type: namesType, collation: undefined }
]

/** The judge's, or a part's, written set (`writtenColumn`). */
const written: Expr = { kind: "plVar", name: writtenColumn }

/** The text[] literal of `names`, each element quoted. */
const namesOf = (names: NonEmptyReadonlyArray<string>): Expr =>
	lit.text(
		`{${names.map((n) => `"${n.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`,
		namesType
	)

/** That the transaction wrote a row into the delta named `name`: the written set names it. */
const wrote = (name: string): Expr => ({
	kind: "binary",
	op: "@>",
	left: written,
	right: namesOf([name]),
	schema: undefined
})

/**
 * The name of a part's variable that holds the names of its deltas that hold a row once netted (`partBody`): one set,
 * so a part's PL/pgSQL names one variable however many deltas it holds, and PostgreSQL's compile of it, which looks
 * every word of its text up among its variables, costs no more than the text.
 */
const rowedName = "__rowed"

/** A part's `rowedName`. */
const rowedSet: Expr = { kind: "plVar", name: rowedName }

/** Whether any of `deltas` holds a row once netted: the condition a block runs on, and a delta is stood up on. */
const anyRowed = (deltas: NonEmptyReadonlyArray<SessionDelta>): Expr => ({
	kind: "binary",
	op: "&&",
	left: rowedSet,
	right: namesOf(mapNonEmpty(deltas, (d) => d.name)),
	schema: undefined
})

/** A part of the judge (`partsOf`): its deltas, by name, and its blocks, in the judge's order. */
interface JudgePart {
	readonly deltas: NonEmptyReadonlyArray<SessionDelta>
	readonly blocks: NonEmptyReadonlyArray<Judged>
}

/**
 * The judge's parts: the classes of its blocks under reading a delta in common, each with every delta its blocks read,
 * so no block of one part reads a delta of another, and a transaction that writes no delta of a part runs none of it. A
 * learner's relations and a content package's are parts apart, joined by no rule's region, so a session that writes a
 * learner's rows compiles and runs the learner's part alone. In the order of each part's first block.
 */
const partsOf = (judged: ReadonlyArray<Judged>): ReadonlyArray<JudgePart> => {
	const parent = new Map<string, string>()
	const root = (name: string): string => {
		let at = name
		for (let up = parent.get(at); up !== undefined && up !== at; up = parent.get(at)) {
			at = up
		}
		return at
	}
	for (const j of judged) {
		for (const d of j.reads) {
			if (!parent.has(d.name)) {
				parent.set(d.name, d.name)
			}
			parent.set(root(d.name), root(headNonEmpty(j.reads).name))
		}
	}
	const byRoot = new Map<
		string,
		{ readonly deltas: Set<SessionDelta>; readonly blocks: Array<Judged> }
	>()
	for (const j of judged) {
		const at = root(headNonEmpty(j.reads).name)
		const part = byRoot.get(at) ?? { deltas: new Set(), blocks: [] }
		for (const d of j.reads) {
			part.deltas.add(d)
		}
		part.blocks.push(j)
		byRoot.set(at, part)
	}
	return [...byRoot.values()].flatMap((part): ReadonlyArray<JudgePart> => {
		const [d0, ...ds] = [...part.deltas].toSorted((x, y) => compareStrings(x.name, y.name))
		const [b0, ...bs] = part.blocks
		return d0 === undefined || b0 === undefined
			? []
			: [{ deltas: [d0, ...ds], blocks: [b0, ...bs] }]
	})
}

/**
 * A part's body, run where the transaction wrote a row into one of its deltas, `written` the names of those it wrote
 * (`marked`):
 *
 * - the names of its written deltas that hold a row once netted, into `rowedName`: each side of news netted first
 *   (`netted`), so it holds delta.added, and read again, since the images it held may all cancel; a side of olds holds
 *   the rows it was marked for. A delta the transaction did not write is never read: a session's deltas of every
 *   relation an earlier transaction wrote hold no row of this one;
 * - each delta a block reads beside the one that ran it, stood up where such a block runs (`ensured`, which refuses a
 *   table another role made under its name): a whole rule's region reads the delta of each side it reads of each holder
 *   of its unit, and a transaction that wrote one of them need not have written the others, which the session then may
 *   not hold. A delta every block that reads it runs on alone stands wherever one of them runs, its own row having run
 *   it;
 * - each block, where a delta it reads holds a row: over deltas that hold none its region is empty, and every statement
 *   of it finds no row.
 */
const partBody = (
	part: JudgePart,
	sideOf: (name: string) => { readonly t: JudgedTable; readonly s: JudgedSide }
): PlBlock => {
	const flags = mapNonEmpty(part.deltas, (delta): PlStatement => {
		const { t, s } = sideOf(delta.name)
		const record: PlStatement = {
			kind: "assign",
			target: rowedName,
			value: {
				kind: "binary",
				op: "||",
				left: rowedSet,
				right: lit.text(delta.name, types.text),
				schema: undefined
			}
		}
		const kept: NonEmptyReadonlyArray<PlStatement> =
			s.side === "added"
				? [
						netted(t.relation, s),
						{
							kind: "if",
							branches: [{ condition: holding(delta.name, "r1"), body: [record] }],
							else: []
						}
					]
				: [record]
		return {
			kind: "if",
			branches: [{ condition: wrote(delta.name), body: kept }],
			else: []
		}
	})
	const stoodUp = part.deltas.flatMap((delta): ReadonlyArray<PlStatement> => {
		const besides = [
			...new Set(
				part.blocks.flatMap((j) =>
					j.reads.includes(delta) ? j.reads.filter((d) => d !== delta) : []
				)
			)
		].toSorted((x, y) => compareStrings(x.name, y.name))
		return isNonEmpty(besides)
			? [
					{
						kind: "if",
						branches: [{ condition: anyRowed(besides), body: [ensured(delta)] }],
						else: []
					}
				]
			: []
	})
	return {
		declare: [{ name: rowedName, type: namesType }],
		body: [
			{ kind: "assign", target: rowedName, value: lit.text("{}", namesType) },
			headNonEmpty(flags),
			...flags.slice(1),
			...stoodUp,
			...part.blocks.map((j): PlStatement => ({
				kind: "if",
				branches: [{ condition: anyRowed(j.reads), body: j.body }],
				else: []
			})),
			...part.deltas.map(emptied)
		]
	}
}

/**
 * The rows of `delta` deleted once its part has read them, where the transaction's written set names it, which a capture
 * that wrote a row there marked (`marked`), so the delta stands: the delta holds the rows of one run of the judge alone,
 * and no COMMIT truncates it (`addRules`).
 *
 *   IF __written @> '{<delta>}' THEN DELETE FROM pg_temp.<delta> AS r1; END IF
 */
const emptied = (delta: SessionDelta): PlStatement => ({
	kind: "if",
	branches: [
		{
			condition: wrote(delta.name),
			body: [
				{
					kind: "modify",
					statement: {
						kind: "delete",
						with: undefined,
						table: sessionTable(delta.name),
						alias: "r1",
						using: [],
						where: undefined,
						returning: []
					}
				}
			]
		}
	],
	else: []
})

/**
 * Rules over queries in the installation, held by the set judge: each table a rule over a query reads captures the rows
 * each statement writes of it, and one judge runs every rule's probes once over them, at COMMIT, on the state the
 * transaction leaves. A rule one of whose sides reads a derived relation is judged over the rows the transaction wrote:
 *
 * - of a table the rule's breaking side reads (a containment's source, a key's or a check's relation), the rows an
 *   INSERT or an UPDATE of a column it reads leaves and that stand at COMMIT, whose probes of the added side
 *   (analysis/theory/query.ts probes) read the side's facts each row derives from its image in the delta, never from the
 *   table again;
 * - of a table a containment's target reads, the rows a DELETE or such an UPDATE found, whose probes of the removed side
 *   read the target tuples each row may have withdrawn and the source tuples that needed them;
 * - of a table a side reads inside a negation, the other way round: inserted rows where a containment's target negates
 *   it, whose probes read the target tuples each now blocks, and deleted rows where the breaking side does, whose probes
 *   read the side's facts each no longer blocks.
 *
 * The parts:
 *
 * - Capture: on each table, an AFTER statement trigger per event its rules read (sql/ast.ts CreateTransitionTrigger):
 *   INSERT where a rule reads NEW, DELETE where one reads either side, UPDATE where one reads a column on either side.
 *   A statement that wrote no row captures nothing: its function reads its transition table first, and stands up no
 *   delta and arms no judge where it is empty. Otherwise it writes the rows the statement wrote into the session's delta
 *   of each side (`captured`), every column of
 *   the relation's heading, typed by its base type, an UPDATE's only where it changed the row's image, its key or a
 *   column the side reads: into the side of olds, delta.removed, the rows as the statement found them; into the side of
 *   news, the transaction's net write, each image the statement put counted 1 and each it removed counted -1. Each delta
 *   is a table of pg_temp, created at the session's first capture of that side, ON COMMIT PRESERVE ROWS, so it lives
 *   as long as the session, and holds one transaction's rows: the judge deletes every row of each delta it reads, once
 *   its part has read them, and a rolled-back write's go with it. No COMMIT truncates a delta or the sentinel:
 *   PostgreSQL truncates every ON COMMIT DELETE ROWS table of a session at each COMMIT of a transaction that touched a
 *   temporary relation (tablecmds.c PreCommit_on_commit_actions), whether it wrote the table or not, each truncation an
 *   ACCESS EXCLUSIVE lock, a rebuild of its indexes and its TOAST table's, and invalidations every backend reads, so a
 *   session that held a delta of each of 18 sides paid 18 truncations at every judged COMMIT. Its columns name no domain: a session's table typed by one
 *   would block DROP DOMAIN and ALTER DOMAIN ... ADD CONSTRAINT in every other session while it lives.
 * - Arming: a capture that writes the rows a statement put, or those it found into the side of olds, writes them, marks
 *   each delta it wrote in the sentinel's row where it stands (`marked`), and last inserts the one row of the session's
 *   sentinel where none stands, a table of pg_temp created with it, naming the deltas it wrote (`arming`). Its
 *   DEFERRABLE INITIALLY DEFERRED constraint trigger runs the judge, so the judge runs once, at COMMIT, or at SET
 *   CONSTRAINTS ALL IMMEDIATE and after each statement from then on, there at the end of the capture's insert of the
 *   row, after its rows. A sentinel that holds its row arms nothing more. The row holds the transaction's written set,
 *   the names of the deltas its captures wrote a row into. A DELETE that only cancels images of news arms and marks nothing: it can break no rule, and the images
 *   it cancels were put by a statement that armed the judge and marked their delta.
 * - The judge: it reads the written set and deletes the sentinel's row, so a later statement arms it again into a new
 *   set. Its rules stand in parts (`partsOf`), each a function of its own (identity.ruleJudgePart): the classes of the
 *   rules' blocks under reading a delta in common, so a part's rules read only its deltas, and the judge runs a part
 *   only where the transaction wrote one of them. A transaction reads, judges and compiles only the parts of the
 *   relations it wrote: a learner's write never reads a content package's rules, nor stands up their deltas, nor
 *   compiles their PL/pgSQL, and no COMMIT reads a catalog, or a delta of a relation another transaction of its
 *   session wrote, which holds none of its rows. A part reads each of its written deltas once, netting a side of news
 *   to delta.added first (`netted`), the images the transaction leaves that it did not find; then, for each
 *   rule in trigger-name order, each table it reads and each side it reads there, where that side's delta holds a row,
 *   it runs each probe of the side over its region (`compileProbe`), the session's delta, and a whole rule's violation
 *   over its units where any delta its region reads holds one (`partBody`), each read whole as a PERFORM and raised
 *   where it found a row (sql/build.ts whenFound, as a migration's check of the law is), never as IF EXISTS, which
 *   PostgreSQL plans for a first row a holding rule never returns: SQLSTATE 23503 for a containment, 23505 for a key and
 *   23514 for a check, naming the rule's trigger name as its constraint and
 *   the rule's table, with no DETAIL, since the writer may not see the rows. Over deltas that hold no row a rule's region
 *   is empty, so a transaction runs exactly the rules over the relations it wrote. Each part deletes every row of each
 *   delta the written set names once its rules have read them (`emptied`), so a judge that runs again after SET
 *   CONSTRAINTS ALL IMMEDIATE reads the rows the statements since its last run wrote: each statement's rows are judged
 *   once, on the state as it stood when they were, and a later statement that breaks a rule through them writes rows of
 *   its own the rule's other side reads, which that run judges.
 *
 * The side of news is the transaction's net write so that a probe of the facts a row adds never reads that row from its
 * table, where without statistics PostgreSQL prices a read at the key's index the same as one at an index of a strict
 * subset of the key's columns, a qti attribute's (name, package): one row each (selfuncs.c btcostestimate, the unique
 * key's one tuple against two default equalities' clamped to one), and the shorter tree wins, reading every row of the
 * subset at every row of the delta. A probe's lookup of any other table at its key remains PostgreSQL's choice, which
 * statistics make (README, Rules over queries).
 * - Tamper: pg_temp is one namespace per session, which every role of it writes, so a login could create a delta or the
 *   sentinel first, own it and empty it before COMMIT. Every capture checks the sentinel and the delta it writes, and a
 *   part every delta it stands up: each must be the definer's own temporary table (`ours`), the sentinel's trigger the
 *   judge, or the statement is refused, insufficient_privilege naming the table (`foreign`). The judge reads only the
 *   deltas the written set names, each checked by the capture that marked it, and the set itself the sentinel's row,
 *   which no other role may write. Every function is SECURITY
 *   DEFINER under closedSearchPath, every name it reads schema-qualified, EXECUTE revoked from PUBLIC.
 *
 * Every writer of a guarded table is SERIALIZABLE (isolation.ts), so PostgreSQL's SSI orders each probe's reads against
 * a concurrent write there. A READ COMMITTED role writes a table the rule reads only where certification proves the
 * rule monotone in its writes (analysis/isolation/certify.ts `laws`): its probes read at COMMIT, at a snapshot of their
 * own, and a write they miss can only withdraw a violation, never add one.
 *
 * The judge lives as long as the installation: every installation holds it, one name (identity.ruleJudge), its rules
 * none or many, and a migration replaces it in place and never drops it, since every session's sentinel's trigger names
 * it and PostgreSQL refuses to drop a function a trigger of another session runs. Its parts hold no session's trigger,
 * and a part whose deltas change is another function, the old one dropped. A migration that adds an installation's
 * first rule over a query or removes its last one changes only the judge's body, its parts and the captures. Each probe's access paths
 * (physical/access/extract.ts) are law-maintenance index requests of the rule, so a probe reads by index wherever the
 * planner can, and its cost follows the write.
 */
export const addRules = (
	b: InstallBuilder
): {
	readonly requests: ReadonlyArray<IndexRequest>
	readonly checks: ReadonlyMap<LawId, OperandSelect>
} => {
	const catalog = evidenceCatalog({ laws: b.model, views: [] })
	const tables = judgedTables(b)
	const judge = objectName(b.schema, b.name(identity.ruleJudge()))
	const sentinelIdent = identity.ruleSentinel(
		headNonEmpty(b.names.levels),
		canonicalTextOf(sentinelTable)
	)
	const sentinel = b.name(sentinelIdent)
	const deltaOf = (t: JudgedTable, side: ProbeSide): SessionDelta | undefined =>
		t.sides.find((s) => s.side === side)?.delta
	const requests: Array<IndexRequest> = []
	const tableOf = (relation: string): JudgedTable | undefined =>
		tables.find((t) => t.relation.name === relation)
	/**
	 * The session's delta of `t`'s side `side` as a Delta node reads it, each field of its relation's heading in the
	 * column of its own name, the delta's (`judgedTables`); none of the facts a write met.
	 */
	const sessionDelta = (t: JudgedTable, side: DeltaSide): DeltaRelation | undefined => {
		const delta = side === "met" ? undefined : deltaOf(t, side)
		return delta === undefined
			? undefined
			: {
					kind: "table",
					table: sessionTable(delta.name),
					columns: t.relation.heading.map((f) => ({ field: f.name, column: f.column }))
				}
	}
	/**
	 * The judge's blocks of a probed rule over one table it reads: one per side of the table its touches name, each
	 * probe of it (analysis/theory/query.ts probes), read over that side's delta.
	 */
	const probedBlocks = (
		rule: RuleTrigger,
		probed: ProbedRule,
		rt: RuleTable
	): ReadonlyArray<Judged> => {
		const relation = rt.relation
		const t = defined(
			tableOf(relation.name),
			`the judged table ${relation.name}, a table its rule reads`
		)
		const deltas = (name: string, side: DeltaSide): DeltaRelation | undefined =>
			name === relation.name ? sessionDelta(t, side) : undefined
		const raise = raiseOf(b, rule, relation)
		const sideBlock = (side: ProbeSide): ReadonlyArray<Judged> => {
			if (touchedOn(rt.touches, side) === undefined) {
				return []
			}
			const delta = deltaOf(t, side)
			const compiled = probes(probed, relation.name, side, rule.law.loc).map((probe) =>
				compileProbe(b, catalog, rule, relation, probe, deltas)
			)
			appendAll(
				requests,
				compiled.flatMap((p) => p.requests)
			)
			return delta === undefined || !isNonEmpty(compiled)
				? []
				: [
						{
							rule,
							order: identifierOf(rule.named),
							reads: [delta],
							body: mapNonEmpty(probeStatements(compiled), (statement) =>
								whenFound(statement, [raise])
							)
						}
					]
		}
		return [...sideBlock("added"), ...sideBlock("removed")]
	}
	/**
	 * The judge's block of a whole rule: its violation over the units the transaction wrote (WholeRule `judged`), read
	 * once whatever tables the transaction wrote of it, raising where it holds a row. Its region reads the delta of each
	 * side its occurrences read of each holder of its unit, the sides its touches name (analysis/theory/query.ts
	 * wholeTouches, unit.ts regionOf).
	 */
	const unitBlock = (rule: RuleTrigger, unit: WholeRule): Judged => {
		const label = `rule ${rule.law.named.display} over the units a transaction wrote`
		const deltas = (name: string, side: DeltaSide): DeltaRelation | undefined => {
			const t = tableOf(name)
			return t === undefined ? undefined : sessionDelta(t, side)
		}
		const lowered = judgedStatement(
			b,
			catalog,
			rule,
			unit.judged,
			(query) => b.columns(unit.definitionOf(query)),
			label,
			rule.law.loc,
			deltas,
			"perUnit"
		)
		appendAll(requests, lowered.requests)
		const holder = defined(
			tableOf(headNonEmpty(unit.unit.holders).relation),
			"a unit-scoped rule's holder, a table it reads"
		)
		const [first, ...rest] = rule.tables.flatMap((rt) =>
			defined(
				tableOf(rt.relation.name),
				`the judged table ${rt.relation.name}, a table its rule reads`
			).sides.flatMap((s) => (touchedOn(rt.touches, s.side) === undefined ? [] : [s.delta]))
		)
		return {
			rule,
			order: identifierOf(rule.named),
			reads: [
				defined(first, `a delta of a side ${rule.law.named.display} reads, which its touches name`),
				...rest
			],
			body: [whenFound(lowered.statement, [raiseOf(b, rule, holder.relation)])]
		}
	}
	/**
	 * A Delta node of a rule's check over every row (`everyRowCheck`), as the transaction that writes every row into an
	 * installation that holds none leaves it: the added side of a table the rule reads, every row of its relation's own
	 * table, each field of its heading in its column; the removed side, nothing.
	 */
	const everyRow =
		(rule: RuleTrigger) =>
		(name: string, side: DeltaSide): DeltaRelation | undefined => {
			const rt = rule.tables.find((t) => t.relation.name === name)
			if (rt === undefined || side === "met") {
				return undefined
			}
			const table = b.names.relation(name)
			return side === "removed"
				? { kind: "empty" }
				: {
						kind: "table",
						table: objectName(table.schema, table.name),
						columns: rt.relation.heading.map((f) => ({ field: f.name, column: f.column }))
					}
		}
	/**
	 * The check of `rule` over every row, the one the migration that adds the rule, or changes it or a definition it
	 * reads, runs once (deploy/snapshot/violation.ts lawChecks): the judge's own statements over the transaction that
	 * writes every row into an installation that holds none (`everyRow`), a probed rule's the probes of the facts its
	 * breaking side's arms add (analysis/theory/query.ts everyRowProbes), a whole rule's its violation query itself, every
	 * unit being written (WholeRule `everyRow`), each lowered as the judge lowers its statements (`judgedStatement`): one
	 * chain of lookups from the rows it starts at, every lookup one the judge's statements request an index for, so no
	 * estimate PostgreSQL makes, with statistics or none, turns the check into a join of derived relations it plans apart
	 * and joins by their estimates, a nested loop over one's rows for each of another's. The statements are one query,
	 * their rows UNION ALL.
	 */
	const everyRowCheck = (rule: RuleTrigger): OperandSelect => {
		const r = rule.rule
		const label = `rule ${rule.law.named.display} over every row`
		const lowered = (query: InferredQuery, sharing: Exclude<ImportSharing, "perRead">): Compiled =>
			judgedStatement(
				b,
				catalog,
				rule,
				query,
				b.columns,
				label,
				rule.law.loc,
				everyRow(rule),
				sharing
			)
		const compiled: NonEmptyReadonlyArray<Compiled> =
			r.kind === "whole"
				? [lowered(r.everyRow, "perStatement")]
				: mapNonEmpty(
						everyRowProbes(
							r,
							(name) => rule.tables.some((t) => t.relation.name === name),
							rule.law.loc
						),
						(probe) => lowered(probe, "perUnit")
					)
		appendAll(
			requests,
			compiled.flatMap((c) => c.requests)
		)
		const [first, second, ...more] = probeStatements(compiled)
		return second === undefined ? first : operandSelect(operandUnionAll([first, second, ...more]))
	}
	const checks = new Map(b.model.rules.map((rule) => [rule.law.id, everyRowCheck(rule)] as const))
	/** The judge's blocks that hold `rule`, by the one strategy its kind states. */
	const judgedBy = (rule: RuleTrigger): ReadonlyArray<Judged> => {
		const r = rule.rule
		switch (r.kind) {
			case "contained":
			case "key":
			case "check":
				return rule.tables.flatMap((rt) => probedBlocks(rule, r, rt))
			case "whole":
				return [unitBlock(rule, r)]
		}
	}
	const judged = b.model.rules
		.flatMap(judgedBy)
		.toSorted((x, y) => compareStrings(x.order, y.order))
	/** Each judged table's side by its delta's name: the side a part nets, where it is a side of news. */
	const sideOf = new Map(
		tables.flatMap((t) => t.sides.map((s) => [s.delta.name, { t, s }] as const))
	)
	const deltas = tables.flatMap((t) => t.sides.map((s) => s.delta.name)).toSorted(compareStrings)
	const reasons: ReadonlyArray<PhysicalReason> = [
		enforcement(`the rules over queries of schema ${b.owned.name}`),
		...b.model.rules.map((rule) => ({ kind: "law" as const, law: rule.law.id }))
	]
	const tablesOf = (rules: ReadonlyArray<RuleTrigger>) =>
		[...new Set(rules.flatMap((rule) => rule.law.reads))].flatMap((name) =>
			b.model.relations.has(name) ? [b.table(name)] : []
		)
	const parts = partsOf(judged).map((part) => {
		const relation = defined(
			sideOf.get(headNonEmpty(part.deltas).name),
			"a part's first delta, a judged table's side"
		).t.relation.name
		const named = identity.ruleJudgePart(
			relation,
			sentinelIdent,
			mapNonEmpty(part.deltas, (d) => d.ident)
		)
		const fn = objectName(b.schema, b.name(named))
		const ddl: readonly [PlFunction, Revoke] = [
			{
				kind: "createFunction",
				language: "plpgsql",
				name: fn,
				params: [{ name: writtenColumn, type: namesType }],
				returns: "void",
				volatility: "VOLATILE",
				parallel: "UNSAFE",
				security: "DEFINER",
				body: partBody(part, (name) =>
					defined(sideOf.get(name), "a part's delta, a judged table's side")
				)
			},
			revokeOf(fn, [namesType])
		]
		const rules = [...new Set(part.blocks.map((j) => j.rule))]
		const node = b.add(
			{
				kind: "lawFunction",
				ident: b.qualified("function", named),
				ddl,
				reasons: rules.map((rule) => ({ kind: "law" as const, law: rule.law.id })),
				phase: "validate"
			},
			tablesOf(rules)
		)
		return { part, fn, node }
	})
	/**
	 * The judge's run: the transaction's written set read from the sentinel's row (`marked`), the row deleted, so a later
	 * statement arms the judge again and marks its deltas into a new set, and each part run where the transaction wrote
	 * one of its deltas, with the set. It reads no catalog and no delta the transaction did not write: a session holds a
	 * delta of every relation any of its transactions wrote, none of whose rows outlives its COMMIT. None where the
	 * installation holds no delta, nor any rule over a query.
	 */
	const consumed: PlStatement = {
		kind: "modify",
		statement: {
			kind: "delete",
			with: undefined,
			table: sessionTable(sentinel),
			alias: "r1",
			using: [],
			where: undefined,
			returning: []
		}
	}
	const judging: ReadonlyArray<PlStatement> = !isNonEmpty(deltas)
		? [consumed]
		: [
				{
					kind: "assign",
					target: writtenColumn,
					value: {
						kind: "subquery",
						query: simpleSelect(
							[{ expr: col("r1", writtenColumn), alias: undefined }],
							[{ kind: "table", table: sessionTable(sentinel), alias: "r1" }],
							undefined
						)
					}
				},
				consumed,
				...parts.map(({ part, fn }): PlStatement => ({
					kind: "if",
					branches: [
						{
							condition: {
								kind: "binary",
								op: "&&",
								left: written,
								right: namesOf(mapNonEmpty(part.deltas, (d) => d.name)),
								schema: undefined
							},
							body: [
								{
									kind: "perform",
									query: {
										body: core(
											[{ expr: qualifiedCall(fn.schema, fn.name, [written]), alias: undefined }],
											[],
											undefined
										),
										orderBy: [],
										limit: undefined,
										offset: undefined
									}
								}
							]
						}
					],
					else: []
				}))
			]
	const judgeDdl: readonly [PlFunction, Revoke] = [
		{
			kind: "createFunction",
			language: "plpgsql",
			name: judge,
			params: [],
			returns: "trigger",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			body: {
				declare: isNonEmpty(deltas) ? [{ name: writtenColumn, type: namesType }] : [],
				body: appendNonEmpty(judging, { kind: "return", value: { kind: "plSpecial", name: "NEW" } })
			}
		},
		revokeOf(judge, [])
	]
	const judgeNode = b.add(
		{
			kind: "ruleJudge",
			ident: b.qualified("function", identity.ruleJudge()),
			ddl: judgeDdl,
			reasons,
			phase: "validate"
		},
		[...tablesOf(b.model.rules), ...parts.map((p) => p.node)]
	)
	const events = new Set<TransitionEvent>()
	for (const t of tables) {
		addCapture(b, t, judge, sentinel, judgeNode, events)
	}
	for (const event of events) {
		b.name(identity.captureTrigger(event))
	}
	return { requests, checks }
}

/** REVOKE EXECUTE ON FUNCTION <fn>(<args>) FROM PUBLIC. */
const revokeOf = (fn: ObjectName, args: ReadonlyArray<TypeRef>): Revoke => ({
	kind: "revoke",
	privileges: ["EXECUTE"],
	on: { kind: "FUNCTION", names: [{ ...fn, args }] },
	from: [{ kind: "PUBLIC" }]
})

/**
 * A table's capture (`addRules`): its function, which checks the sentinel, writes the statement's rows into the delta of
 * each side its event reads and arms the sentinel, and its transition triggers, one per event, each recorded in
 * `events`.
 */
const addCapture = (
	b: InstallBuilder,
	t: JudgedTable,
	judge: ObjectName,
	sentinel: string,
	judgeNode: Node<"validate">,
	events: Set<TransitionEvent>
): void => {
	const relation = t.relation
	const named = identity.ruleCapture(relation.name)
	const fn = objectName(b.schema, b.name(named))
	const side = (s: ProbeSide): JudgedSide | undefined => t.sides.find((x) => x.side === s)
	const news = side("added")
	const olds = side("removed")
	/**
	 * The sentinel stood up, then the writes, each of which marks the deltas it writes in the standing row (`marked`),
	 * then the row written where none stands, naming `deltas` that hold a row (`arming`): last, so the judge it fires
	 * reads this capture's rows.
	 */
	const armed = (
		deltas: NonEmptyReadonlyArray<SessionDelta>,
		writes: ReadonlyArray<PlStatement>
	): ReadonlyArray<PlStatement> => [
		armedSentinel(sentinel, judge),
		...writes,
		arming(sentinel, deltas)
	]
	const into = (
		s: JudgedSide,
		rows: TransitionTable,
		other: TransitionTable | undefined
	): ReadonlyArray<PlStatement> => [
		ensured(s.delta),
		captured(relation, s, rows, other),
		marked(sentinel, s.delta)
	]
	const updatedSides = [news, olds].flatMap((s): ReadonlyArray<JudgedSide> =>
		s === undefined || s.read.length === 0 ? [] : [s]
	)
	const updated = [news, olds].flatMap((s): ReadonlyArray<PlStatement> =>
		s === undefined || s.read.length === 0
			? []
			: s.side === "added"
				? [
						ensured(s.delta),
						captured(relation, s, transitionTables.news, transitionTables.olds),
						captured(relation, s, transitionTables.olds, transitionTables.news),
						marked(sentinel, s.delta)
					]
				: into(s, transitionTables.olds, transitionTables.news)
	)
	const removedFromNews: ReadonlyArray<PlStatement> =
		news === undefined
			? []
			: [
					{
						kind: "if",
						branches: [
							{
								condition: sessionTableStands(news.delta.name),
								body: [
									{
										kind: "if",
										branches: [
											{
												condition: not(sessionTableOurs(news.delta.name, [], [])),
												body: [foreign(news.delta.name)]
											}
										],
										else: []
									},
									captured(relation, news, transitionTables.olds, undefined)
								]
							}
						],
						else: []
					}
				]
	/**
	 * `body` where the statement wrote a row, its transition table `rows` holding one: a statement that wrote none
	 * captures nothing, stands up no delta and arms no judge, so a part of a write whose input held no fact, or whose
	 * every row met a stored one, costs its capture one read of an empty transition table.
	 */
	const whereRowed = (
		rows: TransitionTable,
		body: ReadonlyArray<PlStatement>
	): ReadonlyArray<PlStatement> => [
		{
			kind: "if",
			branches: [
				{
					condition: exists(
						simpleSelect([], [{ kind: "transition", table: rows, alias: "r4" }], undefined)
					),
					body
				}
			],
			else: []
		}
	]
	const branches = [
		...(news === undefined
			? []
			: [
					{
						event: "insert" as const,
						body: whereRowed(
							transitionTables.news,
							armed([news.delta], into(news, transitionTables.news, undefined))
						)
					}
				]),
		...(isNonEmpty(updatedSides)
			? [
					{
						event: "update" as const,
						body: whereRowed(
							transitionTables.news,
							armed(
								mapNonEmpty(updatedSides, (updatedSide) => updatedSide.delta),
								updated
							)
						)
					}
				]
			: []),
		...(olds === undefined
			? news === undefined
				? []
				: [{ event: "delete" as const, body: whereRowed(transitionTables.olds, removedFromNews) }]
			: [
					{
						event: "delete" as const,
						body: whereRowed(
							transitionTables.olds,
							armed(
								[olds.delta],
								[...into(olds, transitionTables.olds, undefined), ...removedFromNews]
							)
						)
					}
				])
	]
	const [b0, ...bs] = branches
	if (b0 === undefined) {
		return
	}
	const reasons = t.rules.map(({ rule }) => ({ kind: "law" as const, law: rule.law.id }))
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
			body: {
				declare: [],
				body: [
					{
						kind: "if",
						branches: mapNonEmpty([b0, ...bs], (x) => ({
							condition: eq(
								{ kind: "plSpecial", name: "TG_OP" },
								lit.text(x.event.toUpperCase(), types.text)
							),
							body: x.body
						})),
						else: []
					},
					{ kind: "return", value: { kind: "plSpecial", name: "NEW" } }
				]
			}
		},
		revokeOf(fn, [])
	]
	const fnNode = b.add(
		{ kind: "lawFunction", ident: b.qualified("function", named), ddl, reasons, phase: "validate" },
		[judgeNode, b.table(relation.name)]
	)
	for (const { event } of branches) {
		events.add(event)
		const trigger: CreateTransitionTrigger = {
			kind: "createTransitionTrigger",
			name: identifierOf(identity.captureTrigger(event)),
			table: b.names.relation(relation.name),
			event,
			function: fn
		}
		b.add(
			{
				kind: "lawTrigger",
				ident: {
					kind: "trigger",
					schema: b.names.levelOf(relation.name),
					relation: b.names.relationNamed(relation.name),
					name: identity.captureTrigger(event)
				},
				ddl: [trigger],
				reasons,
				phase: "validate"
			},
			[fnNode, b.table(relation.name)]
		)
	}
}
