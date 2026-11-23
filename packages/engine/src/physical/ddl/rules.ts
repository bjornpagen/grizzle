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
import { navigateQuery, Navigation, type RegionExtent } from "#compiler/analysis/theory/navigate.ts"
import {
	everyRowProbe,
	type FieldsOf,
	type LawSide,
	type ProbedRule,
	type KeysOf,
	type ProbeSide,
	probe,
	probeGuard,
	type QueryRule,
	type RuleLaw,
	touchedOn,
	type WholeRule
} from "#compiler/analysis/theory/query.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { canonicalTextOf, Refusal, unwrap } from "#compiler/core/canonical.ts"
import { unsupported } from "#compiler/core/errors.ts"
import { type Identity, identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
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
import type { IndexRequest, PhysicalReason } from "#compiler/ir/products.ts"
import type { DeltaSide, RelNode } from "#compiler/ir/rel.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { LawModel, RuleTable, RuleTrigger } from "#compiler/laws/model/model.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import type { DeltaRelation } from "#compiler/lower/conservative/types.ts"
import { lowerOptimized, optimizedInput } from "#compiler/lower/optimize/pipeline.ts"
import { extractJudgedReads, type JudgedReads } from "#compiler/physical/access/extract.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import {
	addReaders,
	captured,
	deltaRelation,
	emptied,
	deltaTable,
	foreignOf,
	headed,
	holding,
	type JudgedSide,
	netted,
	revokeOf,
	type SessionDelta,
	sessionDeltaOf,
	sessionTable
} from "#compiler/physical/ddl/deltas.ts"
import type { JudgeStandUp } from "#compiler/physical/ddl/roles.ts"
import { unaliased } from "#compiler/physical/derived/definition.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type {
	ColumnDefinition,
	CreateTransitionTrigger,
	Cte,
	Expr,
	FromSource,
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
	cast,
	col,
	core,
	eq,
	exists,
	lit,
	ne,
	not,
	notExists,
	objectName,
	or,
	provedCore,
	provedSelect,
	qualifiedCall,
	select,
	setOperation,
	simpleSelect,
	types,
	whenFound
} from "#compiler/sql/build.ts"
import { assignments, ungenerated } from "#compiler/sql/generation.ts"
import { printTableName, sessionTablesStanding, stoodApart } from "#compiler/sql/print.ts"
import { type StoredColumns, storedColumns } from "#compiler/sql/stored.ts"

/** A compiled probe: the statement whose rows break the rule, its outputs unaliased, and its index requests. */
interface Compiled {
	readonly statement: OperandSelect
	readonly requests: ReadonlyArray<IndexRequest>
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
 * The fields of each stored relation's primary key the model holds, by its name (analysis/theory/query.ts KeysOf), which
 * chooses the relation a probe's guard reads (probeGuard); none for a relation it holds no key of, a closed one.
 */
const primaryKeysOf =
	(model: LawModel): KeysOf =>
	(name) =>
		model.relations.get(name)?.relation.primaryFields.map((f) => f.name)

/** Each stored relation's field the model holds, by its relation's name and its own (analysis/theory/query.ts FieldsOf). */
const modelFieldsOf =
	(model: LawModel): FieldsOf =>
	(relation, field) =>
		model.relations.get(relation)?.relation.fields.find((f) => f.name === field)

/**
 * A block's probe (analysis/theory/query.ts probe), the rule's meeting part over every row the transaction's write of
 * `relation` on one side may break the rule at, navigated, checked and lowered as every query the judge reads is
 * (`judgedStatement`), with the index requests of the chains that run.
 *
 * Navigation makes each row of the probe one chain of steps from its region, each a lookup of one relation by the columns the steps
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
	query: InferredQuery,
	deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined,
	heads: ReadonlyMap<string, Cte>
): Compiled =>
	judgedStatement(
		b,
		catalog,
		rule,
		query,
		b.columns,
		`rule ${rule.law.named.display} on ${relation.name}`,
		relation.loc,
		deltas,
		heads,
		"units"
	)

/**
 * A query the judge reads, a probe over its region or a unit-scoped rule's violation over its units: navigated wherever
 * it joins (analysis/theory/navigate.ts navigateQuery), so each relation a join of it reads, a derived relation's
 * definition included and a negated one's too, is a step read by the columns its region, its unit or the steps before
 * it bound, never a join PostgreSQL may plan as a product it filters afterwards, each import its unfolding multiplies
 * read whole (`perStatement`); then checked as a region read (check/checker.ts QueryRead `region`) and lowered by the
 * optimized pipeline under the transaction's evidence, each Delta node read from the relation `deltas` names
 * (RegionLowering), to one main statement of no parameter, its outputs unaliased, the CTE `heads` holds of each
 * session's delta it reads leading its WITH (`headed`); with the index requests of `rule` its checked DAG's access
 * paths are (`requestsOf`). It reads each suffix test of a text its requests' indexes hold the suffix key of as the
 * key's range (sql/suffix.ts seekingSuffixes), and of no other. Navigation reads the
 * heading of each union it splits in `columns`: the installation's (InstallBuilder `columns`), at the definition a
 * walked copy of it was walked from where the query is a whole rule's violation over its units (WholeRule
 * `definitionOf`).
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
	heads: ReadonlyMap<string, Cte>,
	extent: RegionExtent
): Compiled => {
	const checked = unwrap(
		checkQuery(
			b.checked,
			navigateQuery(
				query,
				loc,
				columns,
				{ kind: "perStatement", extent },
				new Navigation(b.model.theory.regionFacts)
			),
			{ read: "region", label, clock: noClock, session: new CheckSession() }
		)
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
	return { statement: headed({ ...statement, body: unaliased(statement.body) }, heads), requests }
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
): ReadonlyArray<IndexRequest> => {
	const reads = extractJudgedReads([root], { pageable: [] })
	return [...lookupRequestsOf(b, rule, reads), ...seekRequestsOf(b, rule, reads)]
}

/**
 * The requests of a judged query's suffix seeks (physical/access/extract.ts SuffixSeek): a B-tree whose first block is
 * the columns the seek's probe fixes by equality, where it fixes any, and whose last key is the suffix key of the text
 * it seeks (ir/law.ts SuffixColumn), which its range reads (sql/suffix.ts).
 */
const seekRequestsOf = (
	b: InstallBuilder,
	rule: RuleTrigger,
	reads: JudgedReads
): ReadonlyArray<IndexRequest> =>
	reads.seeks.flatMap((seek): ReadonlyArray<IndexRequest> => {
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

/**
 * The requests of a judged query's lookups (`requestsOf`): none of an approximate retrieval's, a text search's or a
 * network containment's, which a judge reads through its equalities' keys and filters.
 */
const lookupRequestsOf = (
	b: InstallBuilder,
	rule: RuleTrigger,
	reads: JudgedReads
): ReadonlyArray<IndexRequest> =>
	reads.lookups.flatMap(({ path, binds }): ReadonlyArray<IndexRequest> => {
		const target = b.model.relations.get(path.relation)?.relation
		if (
			target === undefined ||
			path.method === "hnsw" ||
			path.method === "gin" ||
			path.use === "network containment" ||
			path.derived
		) {
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
	})

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
	/** The block's function (identity.ruleJudgeBlock), which runs `body` and which its part calls. */
	readonly named: Identity<"ruleJudgeBlock">
	readonly reads: NonEmptyReadonlyArray<SessionDelta>
	readonly body: NonEmptyReadonlyArray<PlStatement>
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

/**
 * A session table of the judge a site stands up or requires (`standing`): its name, the statements that make it, and
 * what more its pg_class row under `alias` holds where it is the judge's own, beside its owner.
 */
interface Stood {
	readonly name: string
	readonly create: NonEmptyReadonlyArray<PlStatement>
	readonly owned: (alias: string) => ReadonlyArray<Expr>
}

/** The name of a site's variable that holds which of its session tables stand (`standing`). */
const stoodName = "__stood"

/**
 * The sentinel as a site stands it up (`standing`): made with its trigger, which runs `judge`.
 */
const sentinelStood = (sentinel: string, judge: ObjectName): Stood => ({
	name: sentinel,
	create: [
		{
			kind: "createSessionTable",
			name: sentinel,
			columns: sentinelTable,
			notNull: false,
			primaryKey: undefined,
			storage: "toasted"
		},
		{ kind: "createSessionTrigger", name: sentinel, table: sentinel, function: judge }
	],
	owned: (alias) => [
		exists(
			simpleSelect(
				[],
				[catalogTable("pg_trigger", "r3")],
				and([
					eq(col("r3", "tgrelid"), col(alias, "oid")),
					eq(
						col("r3", "tgfoid"),
						call("to_regprocedure", [lit.text(`${printTableName(judge)}()`, types.text)])
					)
				])
			)
		)
	]
})

/** A delta as a site stands it up (`standing`). */
const deltaStood = (delta: SessionDelta): Stood => ({
	name: delta.name,
	create: [deltaTable(delta)],
	owned: () => []
})

/**
 * What a site does with a table of its `standing` the session holds none of: a table's stand-up makes it (`made`,
 * addStandUps); a capture refuses its statement (`required`), the session not having stood up the judge's tables a
 * write of `relation` needs, naming the relation and `standUp`, the function that makes them (`unstood`).
 */
type Absent =
	| { readonly kind: "made" }
	| {
			readonly kind: "required"
			readonly relation: { readonly schema: string; readonly name: string }
			readonly standUp: ObjectName
	  }

/**
 * The refusal of a write of `relation` in a session that has not stood up the judge's tables it needs (`Absent`
 * `required`): grizzle's own 55Z03 (core/sqlstate.ts grizzleUnstood), naming the table, its hint the stand-up a served
 * write's session calls before its first call of the write. A capture makes no table: one made inside a write's
 * transaction is a catalog change its session reads at its next transaction, which makes every plan over it again.
 */
const unstood = (absent: Extract<Absent, { readonly kind: "required" }>): PlStatement => ({
	kind: "raise",
	message: "a write of a table the rule judge holds in a session that has not stood up its tables",
	using: [
		{ option: "ERRCODE", value: lit.text(sqlstates.grizzleUnstood, types.text) },
		{ option: "SCHEMA", value: lit.text(absent.relation.schema, types.text) },
		{ option: "TABLE", value: lit.text(absent.relation.name, types.text) },
		{
			option: "HINT",
			value: lit.text(
				`write it through a served program of grizzle, whose session stands the tables up first, or call ${printTableName(absent.standUp)}() before the write`,
				types.text
			)
		}
	]
})

/**
 * Each of a site's session tables `tables` read by one statement over the catalog for them all (sql/print.ts
 * sessionTablesStanding), so a site plans one read of pg_catalog.pg_class however many tables it reads, once in a
 * session. A table that stands but is not the definer's own temporary table, or a sentinel whose trigger runs no judge
 * of this installation (a sentinel left without its trigger, by a DROP ... CASCADE of the judge, would arm nothing), is
 * refused (deltas.ts foreignOf): a login that made one first could empty it before COMMIT. A table the session holds
 * none of is made where the site is a stand-up, and refuses the statement where it is a capture (`Absent`).
 *
 *   __stood := <which of the tables stand, each the definer's own or marked apart (sessionTablesStanding)>
 *   IF __stood && '{!<table>,...}' THEN <refused> END IF
 *   IF NOT __stood @> '{<table>}' THEN <made> END IF ...           (a stand-up)
 *   IF NOT __stood @> '{<table>,...}' THEN <unstood> END IF        (a capture)
 */
const standing = (
	stood: NonEmptyReadonlyArray<Stood>,
	absent: Absent
): NonEmptyReadonlyArray<PlStatement> => {
	const [first, ...more] = stood
	const tables: NonEmptyReadonlyArray<Stood> = [
		first,
		...more.filter(
			(t, at) => t.name !== first.name && more.findIndex((u) => u.name === t.name) === at
		)
	]
	const names = mapNonEmpty(tables, (t) => t.name)
	const set: Expr = { kind: "plVar", name: stoodName }
	const apart = mapNonEmpty(names, (n) => `${stoodApart}${n}`)
	/** Each table's own condition, where it is the row's table. */
	const owned = (alias: string): ReadonlyArray<Expr> =>
		tables.flatMap((t) => {
			const [o, ...os] = t.owned(alias)
			return o === undefined
				? []
				: [
						or([
							ne(cast(col(alias, "relname"), types.text), lit.text(t.name, types.text)),
							and([o, ...os])
						])
					]
		})
	const firstApart: Expr = {
		kind: "case",
		operand: undefined,
		whens: mapNonEmpty(names, (n) => ({
			when: contains(set, [`${stoodApart}${n}`]),
			result: lit.text(n, types.text)
		})),
		else: lit.text(headNonEmpty(names), types.text)
	}
	const absentOnes: ReadonlyArray<PlStatement> =
		absent.kind === "made"
			? tables.map((t): PlStatement => ({
					kind: "if",
					branches: [{ condition: not(contains(set, [t.name])), body: t.create }],
					else: []
				}))
			: [
					{
						kind: "if",
						branches: [{ condition: not(contains(set, names)), body: [unstood(absent)] }],
						else: []
					}
				]
	return [
		{ kind: "assign", target: stoodName, value: sessionTablesStanding(names, owned) },
		{
			kind: "if",
			branches: [
				{
					condition: {
						kind: "binary",
						op: "&&",
						left: set,
						right: namesOf(apart),
						schema: undefined
					},
					body: [foreignOf(firstApart)]
				}
			],
			else: []
		},
		...absentOnes
	]
}

/** That the text[] `set` holds every one of `names`. */
const contains = (set: Expr, names: NonEmptyReadonlyArray<string>): Expr => ({
	kind: "binary",
	op: "@>",
	left: set,
	right: namesOf(names),
	schema: undefined
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
const arming = (
	sentinel: string,
	deltas: NonEmptyReadonlyArray<SessionDelta>
): readonly [PlStatement, PlStatement] => {
	const [first, second, ...rest] = mapNonEmpty(deltas, (d, at) =>
		provedCore(
			"oneRow",
			[{ expr: lit.text(d.name, types.text), alias: undefined }],
			[],
			holding(d.name, `r${at + 2}`)
		)
	)
	return [
		{
			kind: "assign",
			target: armedName,
			value: {
				kind: "array",
				query: select(
					second === undefined ? first : setOperation("UNION", [first, second, ...rest])
				)
			}
		},
		{
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
						[{ expr: { kind: "plVar", name: armedName }, alias: undefined }],
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
	]
}

/**
 * The name of a capture's variable that holds the written set its sentinel row is armed with (`arming`), read by the
 * arming INSERT in place of the deltas, so the judge that INSERT fires, inside it after SET CONSTRAINTS ALL IMMEDIATE,
 * finds no delta held open by a statement still running and may empty each one it read (`emptied`).
 */
const armedName = "__armed"

/**
 * Marks `delta` in the transaction's written set, the sentinel row's (`writtenColumn`), where the delta holds a row:
 * every row a delta holds is the transaction's, since the judge empties each delta it reads (`emptied`)
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
		const sides = (["added", "removed"] as const).flatMap((side): ReadonlyArray<JudgedSide> => {
			const read = held.flatMap(({ table: t }) => {
				const f = touchedOn(t.touches, side)
				return f === undefined ? [] : [f]
			})
			return read.length === 0
				? []
				: [
						{
							side,
							delta: sessionDeltaOf(b, relation, side),
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
 * The deltas the judge's blocks read beside each delta, by its name: for a delta, every other delta a block that reads
 * it reads, in name order, none where every block that reads it reads it alone. A whole rule's region reads the delta of
 * each side it reads of each holder of its unit, and a transaction that wrote one of them need not have written the
 * others: the stand-up of a table makes its deltas and the deltas read beside them (addStandUps), and the capture of a
 * statement requires them, so a block a delta's row runs finds every delta it reads (`partBody`).
 */
const besidesOf = (
	judged: ReadonlyArray<Judged>
): ReadonlyMap<string, ReadonlyArray<SessionDelta>> => {
	const out = new Map<string, Array<SessionDelta>>()
	for (const j of judged) {
		for (const d of j.reads) {
			const held = out.get(d.name) ?? []
			for (const e of j.reads) {
				if (e !== d && !held.includes(e)) {
					held.push(e)
				}
			}
			out.set(d.name, held)
		}
	}
	return new Map(
		[...out].map(
			([name, held]) => [name, held.toSorted((x, y) => compareStrings(x.name, y.name))] as const
		)
	)
}

/**
 * A part's body, run where the transaction wrote a row into one of its deltas, `written` the names of those it wrote
 * (`marked`):
 *
 * - the names of its written deltas that hold a row once netted, into `rowedName`: each side of news netted first
 *   (`netted`), so it holds delta.added, and read again, since the images it held may all cancel; a side of olds holds
 *   the rows it was marked for. A delta the transaction did not write is never read: a session's deltas of every
 *   relation an earlier transaction wrote hold no row of this one;
 * - each delta a block reads beside the one that ran it stands: the stand-up of each table a write writes makes the
 *   deltas the judge reads beside its own (`besidesOf`, addStandUps), and the capture that wrote the delta that ran the
 *   block required them (addCapture);
 * - each block, where a delta it reads holds a row: over deltas that hold none its region is empty, and every statement
 *   of it finds no row. A block is a function of its own (`blockOf`, identity.ruleJudgeBlock), the part's statement a
 *   call of it: PostgreSQL compiles a PL/pgSQL function's whole text at its first call in a session and plans each
 *   statement at its first run, so a session compiles a block's statement only where its transaction runs it. A part
 *   that held its blocks' statements compiled every one at its session's first COMMIT that ran the part: the ledger's
 *   learner part, 76 statements and 2.68 MB, 47 ms before a save ran the 5 statements over what it wrote.
 */
const partBody = (
	part: JudgePart,
	sideOf: (name: string) => { readonly t: JudgedTable; readonly s: JudgedSide },
	blockOf: (block: Judged) => ObjectName
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
	return {
		declare: [{ name: rowedName, type: namesType }],
		body: [
			{ kind: "assign", target: rowedName, value: lit.text("{}", namesType) },
			headNonEmpty(flags),
			...flags.slice(1),
			...part.blocks.map((j): PlStatement => ({
				kind: "if",
				branches: [{ condition: anyRowed(j.reads), body: [performed(blockOf(j), [])] }],
				else: []
			})),
			...part.deltas.map(emptiedWhereWritten)
		]
	}
}

/** PERFORM <fn>(<args>): a call of a function of the judge, the value it returns discarded. */
const performed = (fn: ObjectName, args: ReadonlyArray<Expr>): PlStatement => ({
	kind: "perform",
	query: {
		body: core(
			[{ expr: qualifiedCall(fn.schema, fn.name, args), alias: undefined }],
			[],
			undefined
		),
		orderBy: [],
		limit: undefined,
		offset: undefined
	}
})

/**
 * `delta` emptied once its part has read it (deltas.ts emptied), where the transaction's written set names it, which a
 * capture that wrote a row there marked (`marked`), so the delta stands.
 *
 *   IF __written @> '{<delta>}' THEN <the delta emptied (sessionTableEmptied)> END IF
 */
const emptiedWhereWritten = (delta: SessionDelta): PlStatement => ({
	kind: "if",
	branches: [{ condition: wrote(delta.name), body: [emptied(delta)] }],
	else: []
})

/**
 * Rules over queries in the installation, held by the set judge: each table a rule over a query reads captures the rows
 * each statement writes of it, and one judge runs every rule's probes once over them, at COMMIT, on the state the
 * transaction leaves. A rule one of whose sides reads a derived relation is judged over the rows the transaction wrote:
 *
 * - of a table the rule's breaking side reads (a containment's source, a key's or a check's relation), the rows an
 *   INSERT or an UPDATE of a column it reads leaves and that stand at COMMIT, whose probes of the added side
 *   (analysis/theory/query.ts probe) read the side's facts each row derives from its image in the delta, never from the
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
 *   A statement that wrote no row captures nothing: its function reads its transition table first, and requires no
 *   delta and arms no judge where it is empty. Otherwise it writes the rows the statement wrote into the session's delta
 *   of each side (`captured`), every column of
 *   the relation's heading, typed by its base type, an UPDATE's only where it changed the row's image, its key or a
 *   column the side reads: into the side of olds, delta.removed, the rows as the statement found them; into the side of
 *   news, the transaction's net write, each image the statement put counted 1 and each it removed counted -1. Each delta
 *   is a table of pg_temp, made by the stand-up of each table whose writes need it (`addStandUps`), which a session
 *   calls once before its first write of the table, ON COMMIT PRESERVE ROWS, so it lives as long as the session, and
 *   holds one transaction's rows; a capture requires it and makes none, so no write's transaction makes a relation: the judge empties each delta it reads, once its part
 *   has read them (`emptied`), and a rolled-back write's go with it. No COMMIT truncates a delta or the sentinel:
 *   PostgreSQL truncates every ON COMMIT DELETE ROWS table of a session at each COMMIT of a transaction that touched a
 *   temporary relation (tablecmds.c PreCommit_on_commit_actions), whether it wrote the table or not, each truncation an
 *   ACCESS EXCLUSIVE lock, a rebuild of its indexes and its TOAST table's, and invalidations every backend reads, so a
 *   session that held a delta of each of 18 sides paid 18 truncations at every judged COMMIT. Its columns name no domain: a session's table typed by one
 *   would block DROP DOMAIN and ALTER DOMAIN ... ADD CONSTRAINT in every other session while it lives.
 * - Arming: a capture that writes the rows a statement put, or those it found into the side of olds, writes them, marks
 *   each delta it wrote in the sentinel's row where it stands (`marked`), and last inserts the one row of the session's
 *   sentinel where none stands, a table of pg_temp every stand-up makes with its trigger, naming the deltas it wrote
 *   (`arming`). Its
 *   DEFERRABLE INITIALLY DEFERRED constraint trigger runs the judge, so the judge runs once, at COMMIT, or at SET
 *   CONSTRAINTS ALL IMMEDIATE and after each statement from then on, there at the end of the capture's insert of the
 *   row, after its rows. A sentinel that holds its row arms nothing more. The row holds the transaction's written set,
 *   the names of the deltas its captures wrote a row into. A DELETE that only cancels images of news arms and marks nothing: it can break no rule, and the images
 *   it cancels were put by a statement that armed the judge and marked their delta.
 * - The judge: it reads the written set and deletes the sentinel's row, so a later statement arms it again into a new
 *   set. Its rules stand in parts (`partsOf`), each a function of its own (identity.ruleJudgePart): the classes of the
 *   rules' blocks under reading a delta in common, so a part's rules read only its deltas, and the judge runs a part
 *   only where the transaction wrote one of them; each block a function of its own too (identity.ruleJudgeBlock), which
 *   its part calls where a delta it reads holds a row, so a session compiles the statement of a block its transactions
 *   run alone. A transaction reads, judges and compiles only the parts of the relations it wrote: a learner's write never reads a content package's rules, nor requires their deltas, nor
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
 *   is empty, so a transaction runs exactly the rules over the relations it wrote. Each part empties each delta the
 *   written set names once its rules have read them (`emptied`), its statements reading every delta through its reader
 *   (`readers`), so their plans outlive a truncation, so a judge that runs again after SET
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
 *   sentinel first, own it and empty it before COMMIT. Every stand-up checks the tables it makes, and every capture the
 *   sentinel and the deltas it writes and reads, each site in one read of the catalog (`standing`): each must be the
 *   definer's own temporary table, the sentinel's trigger the judge, or the statement is refused,
 *   insufficient_privilege naming the table (deltas.ts foreignOf); a capture that finds one missing refuses the
 *   statement as grizzle's own 55Z03 (`unstood`). The judge reads only the
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
	/** Each judged table's stand-up, by its relation's name (`addStandUps`). */
	readonly standUps: ReadonlyMap<string, JudgeStandUp>
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
	/** The CTE of each session's delta, by its name, that a judged statement reading it holds (`headed`). */
	const heads = new Map(
		tables.flatMap((t) => t.sides.map((s) => [s.delta.name, s.delta.head] as const))
	)
	/** The session's delta of `t`'s side `side` as a Delta node reads it (deltas.ts deltaRelation); none of the facts a
	 * write met. */
	const sessionDelta = (t: JudgedTable, side: DeltaSide): DeltaRelation | undefined => {
		const delta = side === "met" ? undefined : deltaOf(t, side)
		return delta === undefined ? undefined : deltaRelation(t.relation, delta)
	}
	const keysOf = primaryKeysOf(b.model)
	const fieldsOf = modelFieldsOf(b.model)
	/**
	 * The judge's blocks of a probed rule over one table it reads: one per side of the table its touches name, each
	 * probe of it (analysis/theory/query.ts probe), read over that side's delta, inside its guard where it has one
	 * (probeGuard): the guard runs first, and the probe, which PL/pgSQL plans when it first runs it, only where the guard
	 * finds a row, a write whose units hold no row of the relation every row of the probe reads planning and running
	 * none of it (edullm's first publish of a package: the learner-side rules over the content, 31.5 of the catalog
	 * part's 43.2 MB and 21 s of its 30 s planning, PUBLISH's census).
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
			const query = probe(
				probed,
				relation.name,
				side,
				b.model.theory.regionFacts.containments,
				rule.law.loc
			)
			if (query === undefined) {
				return []
			}
			const compiled = compileProbe(b, catalog, rule, relation, query, deltas, heads)
			appendAll(requests, compiled.requests)
			const judged = whenFound(compiled.statement, [raise])
			const guard = probeGuard(probed, relation.name, side, keysOf, fieldsOf, rule.law.loc)
			const guarded =
				guard === undefined
					? undefined
					: compileProbe(b, catalog, rule, relation, guard, deltas, heads)
			if (guarded !== undefined) {
				appendAll(requests, guarded.requests)
			}
			return delta === undefined
				? []
				: [
						{
							rule,
							order: identifierOf(rule.named),
							named: identity.ruleJudgeBlock(rule.named, rule.law.named, {
								kind: "probe",
								relation: relation.name,
								side
							}),
							reads: [delta],
							body: [guarded === undefined ? judged : whenFound(guarded.statement, [judged])]
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
			heads,
			"units"
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
			named: identity.ruleJudgeBlock(rule.named, rule.law.named, { kind: "units" }),
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
	 * breaking side's arms add (analysis/theory/query.ts everyRowProbe), a whole rule's its violation query itself, every
	 * unit being written (WholeRule `everyRow`), each lowered as the judge lowers its statements (`judgedStatement`): one
	 * chain of lookups from the rows it starts at, every lookup one the judge's statements request an index for, so no
	 * estimate PostgreSQL makes, with statistics or none, turns the check into a join of derived relations it plans apart
	 * and joins by their estimates, a nested loop over one's rows for each of another's. The statements are one query,
	 * their rows UNION ALL.
	 */
	const everyRowCheck = (rule: RuleTrigger): OperandSelect => {
		const r = rule.rule
		const label = `rule ${rule.law.named.display} over every row`
		const lowered = (query: InferredQuery): Compiled =>
			judgedStatement(
				b,
				catalog,
				rule,
				query,
				b.columns,
				label,
				rule.law.loc,
				everyRow(rule),
				new Map(),
				"every"
			)
		const compiled = lowered(
			r.kind === "whole"
				? r.everyRow
				: everyRowProbe(
						r,
						(name) => rule.tables.some((t) => t.relation.name === name),
						rule.law.loc
					)
		)
		appendAll(requests, compiled.requests)
		return compiled.statement
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
	const readers = addReaders(
		b,
		tables.flatMap((t) => t.sides.map((s) => ({ relation: t.relation, delta: s.delta }))),
		reasons
	)
	/**
	 * Each block's function (`partBody`, identity.ruleJudgeBlock): no argument, the block's statement its body, SECURITY
	 * DEFINER under the closed search path as every function of the judge, its EXECUTE revoked from PUBLIC, so only the
	 * judge's definer, which its part runs as, calls it. It reads its rule's tables and its deltas through their readers.
	 */
	const blockNode = (j: Judged): { readonly fn: ObjectName; readonly node: Node<"validate"> } => {
		const fn = objectName(b.schema, b.name(j.named))
		const ddl: readonly [PlFunction, Revoke] = [
			{
				kind: "createFunction",
				language: "plpgsql",
				name: fn,
				params: [],
				returns: "void",
				volatility: "VOLATILE",
				parallel: "UNSAFE",
				security: "DEFINER",
				body: { declare: [], body: j.body }
			},
			revokeOf(fn, [])
		]
		const node = b.add(
			{
				kind: "lawFunction",
				ident: b.qualified("function", j.named),
				ddl,
				reasons: [{ kind: "law" as const, law: j.rule.law.id }],
				phase: "validate"
			},
			[
				...tablesOf([j.rule]),
				...j.reads.map((d) =>
					defined(readers.get(d.name), "a block's delta, a delta of a judged table")
				)
			]
		)
		return { fn, node }
	}
	const parts = partsOf(judged).map((part) => {
		const relation = defined(
			sideOf.get(headNonEmpty(part.deltas).name),
			"a part's first delta, a judged table's side"
		).t.relation.name
		const blocks = new Map(part.blocks.map((j) => [j, blockNode(j)] as const))
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
				body: partBody(
					part,
					(name) => defined(sideOf.get(name), "a part's delta, a judged table's side"),
					(j) => defined(blocks.get(j), "a block of the part").fn
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
			[
				...tablesOf(rules),
				...part.deltas.map((d) =>
					defined(readers.get(d.name), "a part's delta, a delta of a judged table")
				),
				...[...blocks.values()].map((block) => block.node)
			]
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
							body: [performed(fn, [written])]
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
	const besides = besidesOf(judged)
	const standUps = addStandUps(b, tables, besides, judge, sentinel, judgeNode)
	const events = new Set<TransitionEvent>()
	for (const t of tables) {
		addCapture(
			b,
			t,
			judge,
			sentinel,
			judgeNode,
			events,
			besides,
			defined(standUps.get(t.relation.name), "a judged table's stand-up").name
		)
	}
	for (const event of events) {
		b.name(identity.captureTrigger(event))
	}
	return { requests, checks, standUps }
}

/**
 * The stand-up of each judged table (identity.ruleStandUp), by its relation's name: a function of no argument, SECURITY
 * DEFINER under the closed search path as every function of the judge, its EXECUTE revoked from PUBLIC and granted to
 * each role that writes the table (physical/ddl/roles.ts addWorlds), which makes, as the judge's definer, the session's
 * sentinel with its trigger, the table's deltas and the deltas the judge reads beside them (`besidesOf`), each where the
 * session holds none, and refuses a table of their names some other role made (`standing`). A session calls it once,
 * before its first write of the table: a served write's session in its stand-up (runtime/write/flight.ts StandUp), a
 * migration's Structure before its data steps (deploy/diff/diff.ts checkedAtOnce). So no capture or part makes a table
 * inside a write's transaction, a catalog change its session reads at its next transaction, which made every plan over
 * the tables again: metis's assign planned its second call's 70 statements in functions again for it.
 *
 *   __stood := <which of the tables stand (sessionTablesStanding)>; <a foreign one refused>
 *   IF NOT __stood @> '{<sentinel>}' THEN CREATE TEMPORARY TABLE pg_temp.<sentinel> ...; CREATE CONSTRAINT TRIGGER ... END IF
 *   IF NOT __stood @> '{<delta>}' THEN CREATE TEMPORARY TABLE pg_temp.<delta> ... END IF ...
 */
const addStandUps = (
	b: InstallBuilder,
	tables: ReadonlyArray<JudgedTable>,
	besides: ReadonlyMap<string, ReadonlyArray<SessionDelta>>,
	judge: ObjectName,
	sentinel: string,
	judgeNode: Node<"validate">
): ReadonlyMap<string, JudgeStandUp> =>
	new Map(
		tables.map((t) => {
			const named = identity.ruleStandUp(t.relation.name)
			const fn = objectName(b.schema, b.name(named))
			const own = mapNonEmpty(t.sides, (s) => s.delta)
			const ddl: readonly [PlFunction, Revoke] = [
				{
					kind: "createFunction",
					language: "plpgsql",
					name: fn,
					params: [],
					returns: "void",
					volatility: "VOLATILE",
					parallel: "UNSAFE",
					security: "DEFINER",
					body: {
						declare: [{ name: stoodName, type: namesType }],
						body: standing(
							[
								sentinelStood(sentinel, judge),
								...own.map(deltaStood),
								...own.flatMap((d) => besides.get(d.name) ?? []).map(deltaStood)
							],
							{ kind: "made" }
						)
					}
				},
				revokeOf(fn, [])
			]
			const node = b.add(
				{
					kind: "lawFunction",
					ident: b.qualified("function", named),
					ddl,
					reasons: t.rules.map(({ rule }) => ({ kind: "law" as const, law: rule.law.id })),
					phase: "validate"
				},
				[judgeNode, b.table(t.relation.name)]
			)
			return [t.relation.name, { node, name: { ...fn, args: [] } }] as const
		})
	)

/**
 * A table's capture (`addRules`): its function, which requires the session's sentinel and the deltas its event writes
 * and reads (`standing`, `required`), writes the statement's rows into the delta of each side its event reads and arms
 * the sentinel, and its transition triggers, one per event, each recorded in `events`. A statement in a session that
 * has not stood the table up (`standUp`, addStandUps) is refused, never stands anything up itself.
 */
const addCapture = (
	b: InstallBuilder,
	t: JudgedTable,
	judge: ObjectName,
	sentinel: string,
	judgeNode: Node<"validate">,
	events: Set<TransitionEvent>,
	besides: ReadonlyMap<string, ReadonlyArray<SessionDelta>>,
	standUp: ObjectName
): void => {
	const relation = t.relation
	const named = identity.ruleCapture(relation.name)
	const fn = objectName(b.schema, b.name(named))
	const side = (s: ProbeSide): JudgedSide | undefined => t.sides.find((x) => x.side === s)
	const news = side("added")
	const olds = side("removed")
	const required: Absent = {
		kind: "required",
		relation: b.names.relation(relation.name),
		standUp
	}
	/**
	 * The sentinel, `deltas`, the deltas the writes write, the deltas the judge reads beside them and the tables `read`
	 * the writes only read, required in one read of the catalog (`standing`), then the writes, each of which marks the
	 * deltas it writes in the standing row (`marked`), then the row written where none stands, naming `deltas` that hold
	 * a row (`arming`): last, so the judge it fires reads this capture's rows.
	 */
	const armed = (
		deltas: NonEmptyReadonlyArray<SessionDelta>,
		read: ReadonlyArray<Stood>,
		writes: ReadonlyArray<PlStatement>
	): ReadonlyArray<PlStatement> => [
		...standing(
			[
				sentinelStood(sentinel, judge),
				...deltas.map(deltaStood),
				...deltas.flatMap((d) => besides.get(d.name) ?? []).map(deltaStood),
				...read
			],
			required
		),
		...writes,
		...arming(sentinel, deltas)
	]
	const into = (
		s: JudgedSide,
		rows: TransitionTable,
		other: TransitionTable | undefined
	): ReadonlyArray<PlStatement> => [captured(relation, s, rows, other), marked(sentinel, s.delta)]
	const updatedSides = [news, olds].flatMap((s): ReadonlyArray<JudgedSide> =>
		s === undefined || s.read.length === 0 ? [] : [s]
	)
	const updated = [news, olds].flatMap((s): ReadonlyArray<PlStatement> =>
		s === undefined || s.read.length === 0
			? []
			: s.side === "added"
				? [
						captured(relation, s, transitionTables.news, transitionTables.olds),
						captured(relation, s, transitionTables.olds, transitionTables.news),
						marked(sentinel, s.delta)
					]
				: into(s, transitionTables.olds, transitionTables.news)
	)
	/** The rows a DELETE removed counted out of the side of news, which the site requires (`newsRead`): a removal is
	 * counted only once the delta holds a row (deltas.ts captured), so a transaction that wrote no image of the relation
	 * cancels none. */
	const removedFromNews: ReadonlyArray<PlStatement> =
		news === undefined ? [] : [captured(relation, news, transitionTables.olds, undefined)]
	/** The side of news as a DELETE's site reads it (`removedFromNews`). */
	const newsRead: ReadonlyArray<Stood> = news === undefined ? [] : [deltaStood(news.delta)]
	/**
	 * `body` where the statement wrote a row, its transition table `rows` holding one: a statement that wrote none
	 * captures nothing, requires no delta and arms no judge, so a part of a write whose input held no fact, or whose
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
							armed([news.delta], [], into(news, transitionTables.news, undefined))
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
								[],
								updated
							)
						)
					}
				]
			: []),
		...(olds === undefined
			? news === undefined
				? []
				: [
						{
							event: "delete" as const,
							body: whereRowed(transitionTables.olds, [
								...standing([deltaStood(news.delta)], required),
								...removedFromNews
							])
						}
					]
			: [
					{
						event: "delete" as const,
						body: whereRowed(
							transitionTables.olds,
							armed([olds.delta], newsRead, [
								...into(olds, transitionTables.olds, undefined),
								...removedFromNews
							])
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
				declare: [
					{ name: armedName, type: namesType },
					{ name: stoodName, type: namesType }
				],
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
