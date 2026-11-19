import { navigateMember } from "#compiler/analysis/theory/navigate.ts"
import {
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
import { appendAll } from "#compiler/core/array.ts"
import { canonicalTextOf, Refusal, sameText } from "#compiler/core/canonical.ts"
import { unsupported } from "#compiler/core/errors.ts"
import { type Identity, identifierOf, identity } from "#compiler/core/identity.ts"
import { defined } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { weightOf } from "#compiler/core/zset.ts"
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
import { extractLookups } from "#compiler/physical/access/extract.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { unaliased } from "#compiler/physical/derived/definition.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import { imagedText } from "#compiler/schema/representability.ts"
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
	Select,
	TransitionEvent,
	TransitionTable,
	TypeRef
} from "#compiler/sql/ast.ts"
import { transitionTables } from "#compiler/sql/ast.ts"
import {
	and,
	call,
	cast,
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
	or,
	provedSelect,
	qualifiedCall,
	simpleSelect,
	targetAs,
	types,
	whenFound,
	windowOf
} from "#compiler/sql/build.ts"
import { type ImagedColumns, imagedColumns } from "#compiler/sql/image.ts"
import { printTableName } from "#compiler/sql/print.ts"

/** A compiled probe: the statement whose rows break the rule, its outputs unaliased, and its index requests. */
interface Compiled {
	readonly statement: OperandSelect
	readonly requests: ReadonlyArray<IndexRequest>
}

/**
 * The statements a guarded block of the judge runs, each once, in the order its first probe compiled: a set under
 * canonical equality (core/canonical.ts sameText), so a probe that compiles to a statement the block holds adds
 * nothing, and the block keeps the statement first compiled. Two occurrences of the touched relation that hold nothing
 * of its row apart (two arms of a derived relation that read it alike) are two probes of one statement, which a COMMIT
 * would otherwise run twice. A block holds a few probes, so asking each held statement is a short walk where a text of
 * every probe would encode each whole. A probe's index requests are its statement's chain's, so two probes of one
 * statement request the same indexes.
 */
const probeStatements = (compiled: ReadonlyArray<Compiled>): ReadonlyArray<OperandSelect> => {
	const held: Array<OperandSelect> = []
	for (const p of compiled) {
		if (!held.some((s) => sameText(s, p.statement))) {
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
 * navigated (analysis/theory/navigate.ts navigateMember) and checked and lowered as every query the judge reads is
 * (`judgedStatement`), with the index requests of the chain that runs.
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
		navigateMember(probe, relation.loc),
		`rule ${rule.law.named.display} on ${relation.name}`,
		relation.loc,
		deltas
	)

/**
 * A query the judge reads, a probe over its region or a unit-scoped rule's violation over its units: checked as a
 * region read (check/checker.ts QueryRead `region`) and lowered by the optimized pipeline under the transaction's
 * evidence, each Delta node read from the session's delta table `deltas` names (RegionLowering), to one main statement
 * of no parameter, its outputs unaliased; with the index requests of `rule` its checked DAG's access paths are
 * (`requestsOf`). It states the images' equality beside each equality of a text its requests' indexes hold by its image
 * (sql/image.ts) and of no other: its lookups are those requests', and a text it compares that none of them
 * holds is read through no image, so the judge of a schema whose indexes hold none is as it was.
 */
const judgedStatement = (
	b: InstallBuilder,
	catalog: ReturnType<typeof evidenceCatalog>,
	rule: RuleTrigger,
	query: InferredQuery,
	label: string,
	loc: SourceLoc,
	deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined
): Compiled => {
	const checked = checkQuery(b.checked, query, { read: "region", label })
	if (!checked.ok) {
		throw new Refusal(checked.error)
	}
	const requests = requestsOf(b, rule, checked.value.dag.roots[0])
	const lowered = Result.flatMap(optimizedInput(checked.value, queryEvidence), (annotated) =>
		lowerOptimized(annotated, {
			names: { ...b.names, imaged: imagedBy(b, requests) },
			subject: { kind: "ruleRegion", deltas },
			context: "transaction",
			catalog
		})
	)
	if (!lowered.ok) {
		throw new Refusal(lowered.error)
	}
	const program = lowered.value
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
 * The columns the indexes of law `requests` hold by their image: each field a B-tree request's key holds that is a text
 * of no byte bound (schema/representability.ts imagedText), every key of a law's request one its lookups bind by
 * equality (physical/indexes/engine.ts imagedKey), by its table and column.
 */
const imagedBy = (b: InstallBuilder, requests: ReadonlyArray<IndexRequest>): ImagedColumns =>
	imagedColumns(
		requests.flatMap((r) =>
			r.role === "lawMaintenance" && r.method === "btree"
				? r.blocks
						.flat()
						.flatMap((k) =>
							k.column.kind === "field" && imagedText(k.column.field.desc)
								? [{ table: b.names.relation(r.relation), column: k.column.field.column }]
								: []
						)
				: []
		)
	)

/**
 * The index requests of a judged query's access paths (physical/access/extract.ts), read from the root of its checked
 * DAG: law-maintenance requests of `rule`, so a judged read reads by index wherever the planner can. Each is one block
 * of its columns (ir/law.ts LawIndexRequest), but a whole rule's (`unitLead`), whose first block is its unit's key.
 */
const requestsOf = (
	b: InstallBuilder,
	rule: RuleTrigger,
	root: RelNode
): ReadonlyArray<IndexRequest> =>
	extractLookups([root], { pageable: [] }).flatMap(
		({ path, binds }): ReadonlyArray<IndexRequest> => {
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
							...unitLead(rule, target, keys, binds),
							method: path.method,
							role: "lawMaintenance",
							use: "rule probe",
							justification: { kind: "law", law: rule.law.id }
						}
					]
				: []
		}
	)

/**
 * The blocks of a judged read's request over `relation` by `keys`, and what each lookup of it reads (ir/law.ts
 * LawIndexRequest), `binds` the columns each lookup through its path fixes by equality (physical/access/paths.ts
 * Lookup): one block of its keys for a probed rule's, which reads rows; for a whole rule's, first the fields `relation`
 * holds its unit's key in (ir/unit.ts Unit holders) that the read's path binds, the longest run of them from the first in
 * the unit key's order, then the rest, so an index the request asks for never reads past the unit and none another
 * column leads serves it, and a lookup that binds every one of those fields reads one unit. Its judge reads the units a
 * transaction wrote, every holder leading with that key (analysis/theory/unit.ts), but a path need not bind them: a key
 * lookup by a declared key the unit does not lead reads one row by that key's own index, and a path binds no field of a
 * type it does not index, a vector's; such a read is one block of its keys too, and reads rows.
 */
const unitLead = (
	rule: RuleTrigger,
	target: RelationInfo,
	keys: NonEmptyReadonlyArray<LawIndexKey>,
	binds: ReadonlyArray<ReadonlyArray<string>>
): Pick<LawIndexRequest, "blocks" | "reads"> => {
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
				: { blocks: [keys], reads }
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

/** `name`'s relation in the session's own temporary schema, or NULL where it holds none. */
const regclassOf = (name: string): Expr =>
	call("to_regclass", [lit.text(printTableName(sessionTable(name)), types.text)])

/** That the session's temporary schema holds a relation named `name`. */
const standing = (name: string): Expr =>
	exists(simpleSelect([], [catalogTable("pg_class", "r1")], eq(col("r1", "oid"), regclassOf(name))))

/** That the session's table named `name`, which stands, holds a row, read under `alias`. */
const holding = (name: string, alias: string): Expr =>
	exists(simpleSelect([], [{ kind: "table", table: sessionTable(name), alias }], undefined))

/**
 * That the session's relation named `name` is a temporary table the function's definer owns, CURRENT_USER inside a
 * SECURITY DEFINER function, and stands where each of `more` holds of it.
 */
const ours = (name: string, from: ReadonlyArray<FromSource>, more: ReadonlyArray<Expr>): Expr =>
	exists(
		simpleSelect(
			[],
			[catalogTable("pg_class", "r2"), ...from],
			and([eq(col("r2", "oid"), regclassOf(name)), ...owned("r2"), ...more])
		)
	)

/** That the relation of pg_class under `alias` is a temporary table the function's definer owns (`ours`). */
const owned = (alias: string): NonEmptyReadonlyArray<Expr> => [
	eq(call("pg_get_userbyid", [col(alias, "relowner")]), { kind: "user", name: "CURRENT_USER" }),
	eq(col(alias, "relpersistence"), lit.text("t", types.text))
]

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
			condition: not(standing(delta.name)),
			body: [{ kind: "createSessionTable", name: delta.name, columns: delta.table }]
		},
		{ condition: not(ours(delta.name, [], [])), body: [foreign(delta.name)] }
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
			condition: not(standing(sentinel)),
			body: [
				{ kind: "createSessionTable", name: sentinel, columns: [] },
				{ kind: "createSessionTrigger", name: sentinel, table: sentinel, function: judge }
			]
		},
		{
			condition: not(
				ours(
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

/** INSERT INTO pg_temp.<sentinel> SELECT WHERE NOT EXISTS (SELECT FROM pg_temp.<sentinel>): its one row, once. */
const arming = (sentinel: string): PlStatement => ({
	kind: "modify",
	statement: {
		kind: "insert",
		with: undefined,
		table: sessionTable(sentinel),
		alias: undefined,
		overriding: undefined,
		onConflict: undefined,
		returning: [],
		columns: [],
		source: {
			kind: "query",
			query: provedSelect(
				"oneRow",
				[],
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
})

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
		overriding: undefined,
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
 * The name of the judge's variable, and of each part's parameter, that holds the names of the installation's deltas the
 * session holds, read once a run (`addRules`): the definer's own, since the judge refuses any other first.
 */
const heldName = "__held"

/** The name of the judge's variable that holds the name of a session table another role made under a delta's name. */
const foreignName = "__foreign"

/** text[]: the names of session tables. */
const namesType: TypeRef = {
	kind: "builtin",
	name: "text",
	precision: undefined,
	scale: undefined,
	array: true
}

/** The judge's, or a part's, `heldName`. */
const held: Expr = { kind: "plVar", name: heldName }

/** The text[] literal of `names`, each element quoted. */
const namesOf = (names: NonEmptyReadonlyArray<string>): Expr =>
	lit.text(
		`{${names.map((n) => `"${n.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`,
		namesType
	)

/** That the session holds the delta named `name`: `held` names it. */
const holds = (name: string): Expr => ({
	kind: "binary",
	op: "@>",
	left: held,
	right: namesOf([name]),
	schema: undefined
})

/**
 * The name of a part's variable that holds the names of its deltas that hold a row once netted (`partBody`): the
 * transaction's write, one set, so a part's PL/pgSQL names one variable however many deltas it holds, and PostgreSQL's
 * compile of it, which looks every word of its text up among its variables, costs no more than the text.
 */
const writtenName = "__written"

/** A part's `writtenName`. */
const writtenSet: Expr = { kind: "plVar", name: writtenName }

/** Whether any of `deltas` holds a row: the condition a block runs on, and a delta is stood up on. */
const anyWritten = (deltas: NonEmptyReadonlyArray<SessionDelta>): Expr => ({
	kind: "binary",
	op: "&&",
	left: writtenSet,
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
 * A part's body, run where the session holds one of its deltas, `held` the names of those it holds:
 *
 * - the names of its deltas that hold a row, into `writtenName`, each read once: none the session does not hold, and a
 *   side of news that holds one netted first (`netted`), so it holds delta.added;
 * - each delta a block reads beside the one that ran it, stood up where such a block runs: a whole rule's region reads
 *   the delta of each side it reads of each holder of its unit, and a transaction that wrote one of them need not have
 *   written the others, which the session then may not hold (no other role's table stands under its name: the judge
 *   refused one first). A delta every block that reads it runs on alone stands wherever one of them runs, its own row
 *   having run it;
 * - each block, where a delta it reads holds a row: over deltas that hold none its region is empty, and every statement
 *   of it finds no row.
 */
const partBody = (
	part: JudgePart,
	sideOf: (name: string) => { readonly t: JudgedTable; readonly s: JudgedSide }
): PlBlock => {
	const flags = mapNonEmpty(part.deltas, (delta): PlStatement => {
		const { t, s } = sideOf(delta.name)
		const rowed = holding(delta.name, "r1")
		const record: PlStatement = {
			kind: "assign",
			target: writtenName,
			value: {
				kind: "binary",
				op: "||",
				left: writtenSet,
				right: lit.text(delta.name, types.text),
				schema: undefined
			}
		}
		const kept: NonEmptyReadonlyArray<PlStatement> =
			s.side === "added"
				? [
						netted(t.relation, s),
						{ kind: "if", branches: [{ condition: rowed, body: [record] }], else: [] }
					]
				: [record]
		return {
			kind: "if",
			branches: [
				{
					condition: holds(delta.name),
					body: [{ kind: "if", branches: [{ condition: rowed, body: kept }], else: [] }]
				}
			],
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
						branches: [
							{
								condition: anyWritten(besides),
								body: [
									{
										kind: "if",
										branches: [
											{
												condition: not(holds(delta.name)),
												body: [
													{ kind: "createSessionTable", name: delta.name, columns: delta.table }
												]
											}
										],
										else: []
									}
								]
							}
						],
						else: []
					}
				]
			: []
	})
	return {
		declare: [{ name: writtenName, type: namesType }],
		body: [
			{ kind: "assign", target: writtenName, value: lit.text("{}", namesType) },
			headNonEmpty(flags),
			...flags.slice(1),
			...stoodUp,
			...part.blocks.map((j): PlStatement => ({
				kind: "if",
				branches: [{ condition: anyWritten(j.reads), body: j.body }],
				else: []
			}))
		]
	}
}

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
 *   Its function writes the rows the statement wrote into the session's delta of each side (`captured`), every column of
 *   the relation's heading, typed by its base type, an UPDATE's only where it changed the row's image, its key or a
 *   column the side reads: into the side of olds, delta.removed, the rows as the statement found them; into the side of
 *   news, the transaction's net write, each image the statement put counted 1 and each it removed counted -1. Each delta
 *   is a table of pg_temp, created at the session's first capture of that side, ON COMMIT DELETE ROWS, so it lives as
 *   long as the session and holds one transaction's rows. Its columns name no domain: a session's table typed by one
 *   would block DROP DOMAIN and ALTER DOMAIN ... ADD CONSTRAINT in every other session while it lives.
 * - Arming: a capture that writes the rows a statement put, or those it found into the side of olds, then inserts the
 *   one row of the session's sentinel, a table of pg_temp created with it, whose DEFERRABLE INITIALLY DEFERRED
 *   constraint trigger runs the judge, so the judge runs once, at COMMIT, or at SET CONSTRAINTS ALL IMMEDIATE and after
 *   each statement from then on. A sentinel that holds its row arms nothing more. A DELETE that only cancels images
 *   of news arms nothing: it can break no rule, and the images it cancels were put by a statement that armed the judge.
 * - The judge: it deletes the sentinel's row, so a later statement arms it again, refuses a delta the definer does not
 *   own, and reads once which of the installation's deltas the session holds, two reads of pg_class whatever the
 *   installation holds. Its rules stand in parts (`partsOf`), each a function of its own (identity.ruleJudgePart): the
 *   classes of the rules' blocks under reading a delta in common, so a part's rules read only its deltas, and the judge
 *   runs a part only where the session holds one of them. A session compiles, plans and runs only the parts of the
 *   relations it writes: a learner's write never reads a content package's rules, nor stands up their deltas, nor
 *   compiles their PL/pgSQL. A part reads once whether each of its deltas holds a row, netting each side of news that
 *   holds one to delta.added first (`netted`), the images the transaction leaves that it did not find; then, for each
 *   rule in trigger-name order, each table it reads and each side it reads there, where that side's delta holds a row,
 *   it runs each probe of the side over its region (`compileProbe`), the session's delta, and a whole rule's violation
 *   over its units where any delta its region reads holds one (`partBody`), each read whole as a PERFORM and raised
 *   where it found a row (sql/build.ts whenFound, as a migration's check of the law is), never as IF EXISTS, which
 *   PostgreSQL plans for a first row a holding rule never returns: SQLSTATE 23503 for a containment, 23505 for a key and
 *   23514 for a check, naming the rule's trigger name as its constraint and
 *   the rule's table, with no DETAIL, since the writer may not see the rows. Over deltas that hold no row a rule's region
 *   is empty, so a transaction runs exactly the rules over the relations it wrote. The deltas keep their rows until
 *   COMMIT deletes them: a probe that reads a row again after SET CONSTRAINTS ALL IMMEDIATE judges it on the state as it
 *   stands, which is sound.
 *
 * The side of news is the transaction's net write so that a probe of the facts a row adds never reads that row from its
 * table, where without statistics PostgreSQL prices a read at the key's index the same as one at an index of a strict
 * subset of the key's columns, a qti attribute's (name, package): one row each (selfuncs.c btcostestimate, the unique
 * key's one tuple against two default equalities' clamped to one), and the shorter tree wins, reading every row of the
 * subset at every row of the delta. A probe's lookup of any other table at its key remains PostgreSQL's choice, which
 * statistics make (README, Rules over queries).
 * - Tamper: pg_temp is one namespace per session, which every role of it writes, so a login could create a delta or the
 *   sentinel first, own it and empty it before COMMIT. Every capture checks the sentinel and the delta it writes, and
 *   the judge every delta of the installation the session holds: each must be the definer's own temporary table
 *   (`ours`), the sentinel's trigger the judge, or the statement is refused, insufficient_privilege naming the table
 *   (`foreign`). Every function is SECURITY
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
export const addRules = (b: InstallBuilder): ReadonlyArray<IndexRequest> => {
	const catalog = evidenceCatalog({ laws: b.model, views: [] })
	const tables = judgedTables(b)
	const judge = objectName(b.schema, b.name(identity.ruleJudge()))
	const sentinel = b.name(identity.ruleSentinel(headNonEmpty(b.names.levels)))
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
					kind: "session",
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
			const statements = probeStatements(compiled)
			return delta === undefined || !isNonEmpty(statements)
				? []
				: [
						{
							rule,
							order: identifierOf(rule.named),
							reads: [delta],
							body: mapNonEmpty(statements, (statement) => whenFound(statement, [raise]))
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
		const lowered = judgedStatement(b, catalog, rule, unit.judged, label, rule.law.loc, deltas)
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
			mapNonEmpty(part.deltas, (d) => d.ident)
		)
		const fn = objectName(b.schema, b.name(named))
		const ddl: readonly [PlFunction, Revoke] = [
			{
				kind: "createFunction",
				language: "plpgsql",
				name: fn,
				params: [{ name: heldName, type: namesType }],
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
	 * The session's own tables named as `names`, the installation's deltas, by name: those the definer owns, or those it
	 * does not (`ours`).
	 */
	const sessionDeltas = (names: NonEmptyReadonlyArray<string>, ownedByDefiner: boolean): Select =>
		provedSelect(
			"keyed",
			[targetAs(cast(col("r1", "relname"), types.text), "c1")],
			[catalogTable("pg_class", "r1")],
			and([
				eq(col("r1", "relnamespace"), call("pg_my_temp_schema", [])),
				{
					kind: "inList",
					expr: cast(col("r1", "relname"), types.text),
					list: mapNonEmpty(names, (name) => lit.text(name, types.text)),
					not: false
				},
				ownedByDefiner ? and(owned("r1")) : not(and(owned("r1")))
			])
		)
	/**
	 * The judge's reads of the session's deltas, once a run: a table another role made under a delta's name refused
	 * first, naming the least of them, then the names of the deltas the session holds into `held`, and each part run
	 * where the session holds one of its deltas. None where the installation holds no delta, nor any rule over a query.
	 */
	const [d0, ...ds] = deltas
	const judging: ReadonlyArray<PlStatement> =
		d0 === undefined
			? []
			: [
					{
						kind: "forQuery",
						variable: foreignName,
						query: {
							...sessionDeltas([d0, ...ds], false),
							orderBy: [{ expr: cast(col("r1", "relname"), types.text), direction: "ASC" }]
						},
						body: [foreignOf({ kind: "plVar", name: foreignName })]
					},
					{
						kind: "assign",
						target: heldName,
						value: { kind: "array", query: sessionDeltas([d0, ...ds], true) }
					},
					...parts.map(({ part, fn }): PlStatement => ({
						kind: "if",
						branches: [
							{
								condition: {
									kind: "binary",
									op: "&&",
									left: held,
									right: namesOf(mapNonEmpty(part.deltas, (d) => d.name)),
									schema: undefined
								},
								body: [
									{
										kind: "perform",
										query: {
											body: core(
												[{ expr: qualifiedCall(fn.schema, fn.name, [held]), alias: undefined }],
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
				declare:
					d0 === undefined
						? []
						: [
								{ name: foreignName, type: types.text },
								{ name: heldName, type: namesType }
							],
				body: appendNonEmpty(
					[
						{
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
						},
						...judging
					],
					{ kind: "return", value: { kind: "plSpecial", name: "NEW" } }
				)
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
	return requests
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
	const armed = (writes: ReadonlyArray<PlStatement>): ReadonlyArray<PlStatement> => [
		armedSentinel(sentinel, judge),
		...writes,
		arming(sentinel)
	]
	const into = (
		s: JudgedSide,
		rows: TransitionTable,
		other: TransitionTable | undefined
	): ReadonlyArray<PlStatement> => [ensured(s.delta), captured(relation, s, rows, other)]
	const updated = [news, olds].flatMap((s): ReadonlyArray<PlStatement> =>
		s === undefined || s.read.length === 0
			? []
			: s.side === "added"
				? [
						...into(s, transitionTables.news, transitionTables.olds),
						captured(relation, s, transitionTables.olds, transitionTables.news)
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
								condition: standing(news.delta.name),
								body: [
									{
										kind: "if",
										branches: [
											{
												condition: not(ours(news.delta.name, [], [])),
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
	const branches = [
		...(news === undefined
			? []
			: [
					{
						event: "insert" as const,
						body: armed(into(news, transitionTables.news, undefined))
					}
				]),
		...(updated.length === 0 ? [] : [{ event: "update" as const, body: armed(updated) }]),
		...(olds === undefined
			? news === undefined
				? []
				: [{ event: "delete" as const, body: removedFromNews }]
			: [
					{
						event: "delete" as const,
						body: armed([...into(olds, transitionTables.olds, undefined), ...removedFromNews])
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
