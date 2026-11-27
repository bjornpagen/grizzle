import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	concatNonEmpty,
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { lockName } from "#compiler/analysis/isolation/borrows.ts"
import { definedAt, type QueryColumns } from "#compiler/analysis/theory/columns.ts"
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
	clockOrders,
	proofsOf,
	type QueryRule,
	type RuleLaw,
	touchedOn,
	type WholeRule
} from "#compiler/analysis/theory/query.ts"
import type { StoredUpkeep, UnitForm } from "#compiler/analysis/theory/unit.ts"
import type { CheckedLoss, DeltaForm } from "#compiler/analysis/theory/upkeep.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { canonicalTextOf, Refusal, unwrap } from "#compiler/core/canonical.ts"
import type { Borrow, BorrowLock, KeySite } from "#compiler/core/certificate.ts"
import { unsupported } from "#compiler/core/errors.ts"
import { type Identity, identifierOf, identity, type UpkeepPart } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareNumbers, compareStrings } from "#compiler/core/order.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { noClock } from "#compiler/ir/clock.ts"
import { servedQuery } from "#compiler/ir/derived.ts"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import {
	defaultOpclass,
	type LawIndexKey,
	type LawIndexRequest,
	type LawLookup,
	type NativeColumn,
	type TheoryTable
} from "#compiler/ir/law.ts"
import type { IndexRequest, PhysicalReason } from "#compiler/ir/products.ts"
import type { DeltaSide, RelNode } from "#compiler/ir/rel.ts"
import type { Unit } from "#compiler/ir/unit.ts"
import { evidenceCatalog, noViewEvidence } from "#compiler/laws/model/catalog.ts"
import type { LawModel, RuleTable, RuleTrigger } from "#compiler/laws/model/model.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import { fencedRead } from "#compiler/lower/conservative/step/index.ts"
import type { DeltaRelation } from "#compiler/lower/conservative/types.ts"
import { lowerComposed, optimizedInput } from "#compiler/lower/optimize/pipeline.ts"
import {
	extractJudgedReads,
	type JudgedReads,
	keyOrdersOf,
	noWorlds
} from "#compiler/physical/access/extract.ts"
import { type SeekTargets, tableSeeks } from "#compiler/physical/access/seeks.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import {
	addReaders,
	captured,
	DeltaReads,
	deltaIndex,
	deltaRelation,
	emptied,
	deltaTable,
	foreignOf,
	headed,
	holding,
	readersCalled,
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
	Expr,
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
import { selectColumns, transitionTables } from "#compiler/sql/ast.ts"
import {
	and,
	col,
	core,
	derived,
	distinctCore,
	eq,
	exists,
	lit,
	not,
	notExists,
	objectName,
	provedCore,
	provedSelect,
	qualifiedCall,
	select,
	setOperation,
	setQueryOf,
	simpleSelect,
	types,
	whenExists,
	whenFound
} from "#compiler/sql/build.ts"
import { assignments, ungenerated } from "#compiler/sql/generation.ts"
import { freshNames, NameSupply, namedQuery } from "#compiler/sql/naming.ts"
import { printObjectName, sessionTablesStanding, stoodApart } from "#compiler/sql/print.ts"
import { type SeekProgram, seekProgram } from "#compiler/sql/seeks.ts"
import { type StoredColumns, storedColumns } from "#compiler/sql/stored.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"
import { type BorrowArm, borrowQuery } from "#compiler/write/borrow/statement.ts"

/**
 * A compiled judged query: its statement, its outputs unaliased, the names of the columns it delivers in their order,
 * and its index requests.
 */
interface Compiled {
	readonly statement: OperandSelect
	readonly heading: ReadonlyArray<string>
	readonly requests: ReadonlyArray<IndexRequest>
}

/** The n of a generated relation name r<n>, none for any other name. */
const generatedNumber = (name: string): number | undefined => {
	const digits = name.startsWith("r") ? name.slice(1) : ""
	const n = Number(digits)
	return digits !== "" && Number.isSafeInteger(n) && String(n) === digits ? n : undefined
}

/** The greatest n of a generated relation name r<n> `statement` defines, a CTE's or an alias's, 0 where it names none. */
export const lastNumbered = (statement: OperandSelect): number => {
	let last = 0
	const note = (name: string | undefined): void => {
		const n = name === undefined ? undefined : generatedNumber(name)
		if (n !== undefined) {
			last = Math.max(last, n)
		}
	}
	new Transform({
		...identityHooks,
		fromSource: (source) => {
			note("alias" in source ? source.alias : undefined)
			if (source.kind === "cte") {
				note(source.name)
			}
			return source
		},
		select: (query) => {
			for (const cte of query.with?.ctes ?? []) {
				note(cte.name)
			}
			return query
		}
	}).select(statement)
	return last
}

/**
 * `statement` with every generated relation name r<n> it defines or reads, an alias, a CTE and a column's qualifier,
 * shifted to r<n + by>: a judged query embedded in a statement of the judge's own, which names its relations from r1
 * as every lowered statement does, so that no name is defined twice in the statement that holds it.
 */
const shifted = (statement: OperandSelect, by: number): OperandSelect => {
	if (by === 0) {
		return statement
	}
	const moved = (name: string): string => {
		const n = generatedNumber(name)
		return n === undefined ? name : `r${n + by}`
	}
	return new Transform({
		...identityHooks,
		expr: (e) =>
			e.kind === "column" && e.table !== undefined ? { ...e, table: moved(e.table) } : e,
		fromSource: (source) => {
			const named = source.kind === "cte" ? { ...source, name: moved(source.name) } : source
			return "alias" in named && named.alias !== undefined
				? { ...named, alias: moved(named.alias) }
				: named
		},
		select: (query) =>
			query.with === undefined
				? query
				: {
						...query,
						with: {
							...query.with,
							ctes: mapNonEmpty(query.with.ctes, (cte) => ({ ...cte, name: moved(cte.name) }))
						}
					}
	}).select(statement)
}

/** Why a block of `rule` stands: its law. */
const lawReasonOf = (rule: RuleTrigger): NonEmptyReadonlyArray<PhysicalReason> => [
	{ kind: "law", law: rule.law.id }
]

/** `reasons`, each once, in their first order. */
const distinctReasons = (reasons: ReadonlyArray<PhysicalReason>): ReadonlyArray<PhysicalReason> => [
	...new Map(reasons.map((r) => [canonicalTextOf(r), r] as const)).values()
]

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
const columnsOf = (relation: TheoryTable, fields: ReadonlyArray<string>): ReadonlyArray<string> =>
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
	relation: TheoryTable,
	query: InferredQuery,
	deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined,
	reads: DeltaReads
): Compiled =>
	judgedStatement(
		b,
		catalog,
		(root) => requestsOf(b, ruleRequester(rule), root),
		query,
		b.columns,
		`rule ${rule.law.named.display} on ${relation.name}`,
		relation.loc,
		deltas,
		reads,
		"units"
	)

/**
 * A query the judge reads, a probe over its region or a unit-scoped rule's violation over its units: navigated wherever
 * it joins (analysis/theory/navigate.ts navigateQuery), so each relation a join of it reads, a derived relation's
 * definition included and a negated one's too, is a step read by the columns its region, its unit or the steps before
 * it bound, never a join PostgreSQL may plan as a product it filters afterwards, each import its unfolding multiplies
 * read whole (`perStatement`); then checked as a region read (check/checker.ts QueryRead `region`) and lowered by the
 * optimized pipeline under the transaction's evidence, each Delta node read from the relation `deltas` names
 * (RegionLowering), to one main statement of no parameter, its outputs unaliased, each of its reads of a session's
 * delta a read of the delta's table, which `judgedStatement` and an upkeep's statements read through readers (deltas.ts
 * headed). It is lowered composed, never printed apart (lower/optimize/pipeline.ts lowerComposed): its
 * reads of a delta name it by a CTE no statement holds, so the statement that reads it through its readers is its one
 * print; with the index requests of `rule` its checked DAG's access
 * paths are (`requestsOf`). It reads each suffix test of a text its requests' indexes hold the suffix key of as the
 * key's range (sql/suffix.ts seekingSuffixes), and of no other. Navigation reads the
 * heading of each union it splits in `columns`: the installation's (InstallBuilder `columns`), at the definition a
 * walked copy of it was walked from where the query is a whole rule's violation over its units (WholeRule
 * `definitionOf`).
 */
const loweredJudged = (
	b: InstallBuilder,
	catalog: ReturnType<typeof evidenceCatalog>,
	requestsAt: (root: RelNode) => ReadonlyArray<IndexRequest>,
	query: InferredQuery,
	columns: QueryColumns,
	label: string,
	loc: SourceLoc,
	deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined,
	extent: RegionExtent
): Compiled => {
	/** The judge's query as the lowering reads it, its derived relations read as a COMMIT's statements read them
	 * (analysis/schema.ts CheckedSchema definitionRows, ir/derived.ts servedQuery): an upkeep runs after the upkeep of
	 * each stored relation it reads (`stratumOf`) and a rule's after every upkeep, so each stored relation's table is
	 * current where it is read, and each stored relation, named or a definition's import, stands in the query by its name,
	 * never its definition (analysis/theory/query.ts LiveReading `stored`). */
	const checked = servedQuery(
		unwrap(
			checkQuery(
				b.checked,
				navigateQuery(
					query,
					loc,
					columns,
					{ kind: "perStatement", extent },
					new Navigation(b.model.theory.regionFacts)
				),
				{ read: "region", label, clock: noClock, session: new CheckSession(b.checked.patterns) }
			)
		),
		b.checked.definitionRows()
	)
	const requests = requestsAt(checked.dag.roots[0])
	const program = unwrap(
		Result.flatMap(optimizedInput(checked, queryEvidence), (annotated) =>
			lowerComposed(annotated, {
				names: { ...b.names, suffixed: suffixedBy(b, requests) },
				subject: { kind: "ruleRegion", deltas },
				context: "transaction",
				catalog
			})
		)
	)
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
	return {
		statement: { ...statement, body: unaliased(statement.body) },
		heading: main.heading.map((c) => c.name),
		requests
	}
}

/**
 * A query the judge reads (`loweredJudged`), each of its reads of a session's delta read through the reader of the
 * selection it reads the delta under, which `reads` records (deltas.ts headed).
 */
const judgedStatement = (
	b: InstallBuilder,
	catalog: ReturnType<typeof evidenceCatalog>,
	requestsAt: (root: RelNode) => ReadonlyArray<IndexRequest>,
	query: InferredQuery,
	columns: QueryColumns,
	label: string,
	loc: SourceLoc,
	deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined,
	reads: DeltaReads,
	extent: RegionExtent
): Compiled => {
	const lowered = loweredJudged(b, catalog, requestsAt, query, columns, label, loc, deltas, extent)
	return { ...lowered, statement: headed(lowered.statement, reads) }
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
	by: Requester,
	root: RelNode
): ReadonlyArray<IndexRequest> => {
	const reads = extractJudgedReads([root], {
		pageable: [],
		keyOrders: keyOrdersOf(b.model.theory.relations),
		worlds: noWorlds
	})
	return [...lookupRequestsOf(b, by, reads), ...seekRequestsOf(b, by, reads)]
}

/**
 * Who asks a judged read's indexes (`requestsOf`): its justification, a rule's law or a stored relation's enforcement;
 * the unit its reads stand in, a whole rule's or a stored relation's upkeep's, whose key leads each request's first
 * block (`unitLead`), none for a probed rule; the relations it reads by reference, outside its unit, a stored
 * relation's (ir/unit.ts StoredUnit `references`), each read at the keys its unit's rows name; and how a refusal names
 * it.
 */
interface Requester {
	readonly justification: LawIndexRequest["justification"]
	readonly unit: Unit | undefined
	readonly references: ReadonlyArray<string>
	readonly display: string
}

/** A rule's requests' requester (`Requester`): its law, and its unit where it is whole. */
const ruleRequester = (rule: RuleTrigger): Requester => ({
	justification: { kind: "law", law: rule.law.id },
	unit: rule.rule.kind === "whole" ? rule.rule.unit : undefined,
	references: [],
	display: `the whole rule ${rule.law.named.display}`
})

/**
 * The requests of a judged query's suffix seeks (physical/access/extract.ts SuffixSeek): a B-tree whose first block is
 * the columns the seek's probe fixes by equality, where it fixes any, and whose last key is the suffix key of the text
 * it seeks (ir/law.ts SuffixColumn), which its range reads (sql/suffix.ts).
 */
const seekRequestsOf = (
	b: InstallBuilder,
	by: Requester,
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
				justification: by.justification
			}
		]
	})

/**
 * The requests of a judged query's lookups (`requestsOf`) that bind no equality alone: a join's key, a range, a prefix
 * search, a take's or a page's seek, a span predicate, each of which its statement orders or spans by and no seek
 * program states; none of an approximate retrieval's, a text search's or a network containment's, which a judge reads
 * through its equalities' keys and filters. A lookup by equalities alone is the program's to ask (`programRequests`),
 * from the statement as the judge runs it, never from the query it was lowered from. A stored derived relation's
 * table, which every statement of the judge reads by its name, asks as a table does (physical/indexes/engine.ts
 * planIndexes), here and in its program.
 */
const lookupRequestsOf = (
	b: InstallBuilder,
	by: Requester,
	reads: JudgedReads
): ReadonlyArray<IndexRequest> =>
	reads.lookups.flatMap(({ path, binds }): ReadonlyArray<IndexRequest> => {
		const known = b.model.theory.relations[path.relation]
		const target = known?.kind === "relation" || known?.kind === "stored" ? known : undefined
		if (
			target === undefined ||
			path.method === "hnsw" ||
			path.method === "gin" ||
			path.use === "network containment" ||
			path.use === "equality lookup" ||
			path.use === "key lookup" ||
			path.use === "write target"
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
		return !isNonEmpty(keys)
			? []
			: [
					{
						relation: target.name,
						...unitLead(by, target, keys, binds),
						method: path.method,
						role: "lawMaintenance",
						use: "rule probe",
						justification: by.justification
					}
				]
	})

/**
 * The blocks of a judged read's request over `relation` by `keys`, and what each lookup of it reads (ir/law.ts
 * LawIndexRequest), `binds` the columns each lookup through its path fixes by equality (physical/access/paths.ts
 * Lookup): one block of its keys for a probed rule's, which reads rows; for a whole rule's or a unit's upkeep's, first
 * the fields `relation` holds its unit's key in (ir/unit.ts Unit holders) that the read binds, the longest run of them
 * from the first in the unit key's order, then the rest, so an index the request asks for never reads past the unit and
 * none another column leads serves it, and a lookup that binds every one of those fields reads one unit. A read that
 * binds no field of its unit, or of a relation outside it, is one block: every seek a judge prints is asked, the one
 * index the missed-index check holds it to (physical/access/seeks.ts). A relation the requester reads by reference
 * stands in no unit of its: its read is a probe's, one block of its keys, at the key its unit's row names.
 */
const unitLead = (
	by: Requester,
	target: TheoryTable,
	keys: NonEmptyReadonlyArray<LawIndexKey>,
	binds: ReadonlyArray<ReadonlyArray<string>>
): Pick<LawIndexRequest, "blocks" | "reads"> => {
	const relation = target.name
	const holder = by.references.includes(relation)
		? undefined
		: by.unit?.holders.find((h) => h.relation === relation)
	if (holder === undefined) {
		return { blocks: [keys], reads: { kind: "rows" } }
	}
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
		: { blocks: [keys], reads: { kind: "rows" } }
}

/**
 * The requests of the seeks a block's statements make (`Asked`), read off its function as it runs them (sql/seeks.ts
 * seekProgram) at the installation's tables before any index is planned, `targets` (physical/access/seeks.ts
 * keyTableIndexes): one for each seek of a stored table binding a column of many values, its keys the columns it binds
 * that a B-tree holds, a field by its handle and a law column by its identifier, led as its requester leads
 * (`unitLead`), and then, a block of its own, the column it reads a range of past them where it reads one (sql/seeks.ts
 * Seek `range`): one seek, one request, so the range is an index qual of the one index the seek reads, never a filter
 * beside an index of its equalities alone (a sitting's snapshots at (child, stage) after a session's beginning, at). A
 * seek's items of one row are the same before the plan and after, since the engine creates no unique index, so the
 * seeks asked are exactly the seeks the missed-index check judges the installed function by.
 */
const programRequests = (
	b: InstallBuilder,
	targets: SeekTargets,
	by: Requester,
	program: SeekProgram
): ReadonlyArray<IndexRequest> =>
	tableSeeks(program, targets).flatMap(({ table, bound, range }): ReadonlyArray<IndexRequest> => {
		const target = b.model.theory.relations[table.relation]
		if (target === undefined || target.kind === "closed") {
			return []
		}
		const columns = [...bound].filter((c) => table.holds.get(c) !== "none").toSorted(compareStrings)
		if (!columns.some((c) => table.holds.get(c) === "many")) {
			return []
		}
		const keys = columns.flatMap((c): ReadonlyArray<LawIndexKey> => {
			const column = defined(table.columns.get(c), `the column ${c} of ${table.relation}`)
			if (column.kind === "law") {
				return [{ column, dir: "asc", opclass: defaultOpclass }]
			}
			const field = defined(
				target.fields.find((f) => f.name === column.field),
				`the field ${column.field} of ${table.relation}`
			)
			return [{ column: { kind: "field", field }, dir: "asc", opclass: defaultOpclass }]
		})
		if (!isNonEmpty(keys)) {
			return []
		}
		const led = unitLead(by, target, keys, [
			keys.flatMap((k) => (k.column.kind === "field" ? [k.column.field.name] : []))
		])
		const ranged = range === undefined ? undefined : table.columns.get(range)
		const ranges: ReadonlyArray<LawIndexKey> =
			ranged === undefined || table.holds.get(range ?? "") === "none"
				? []
				: ranged.kind === "law"
					? [{ column: ranged, dir: "asc", opclass: defaultOpclass }]
					: target.fields.flatMap((f) =>
							f.name === ranged.field
								? [{ column: { kind: "field", field: f }, dir: "asc", opclass: defaultOpclass }]
								: []
						)
		return [
			{
				relation: target.name,
				...led,
				blocks: isNonEmpty(ranges) ? [...led.blocks, ranges] : led.blocks,
				method: "btree",
				role: "lawMaintenance",
				use: "rule probe",
				justification: by.justification
			}
		]
	})

/**
 * A block of the judge's statements that holds one rule's side or one stored relation's upkeep, ordered among the
 * judge's blocks by its rule's trigger or its relation, and its calls, each a function its part calls where a delta its
 * statements read holds a row (`JudgedCall`). A probe's region is the one delta of its table's side, a whole rule's
 * region every delta of its unit's holders on each side its occurrences read (analysis/theory/unit.ts regionOf), those
 * of each side its rule's writes can break on each table they read (RuleTable touches). Over deltas that hold no row
 * a call's region is empty and every statement of it finds none, so the judge runs it only where one of them holds a
 * row (`addRules`). A block stands in one part (`partsOf`), its calls in their order.
 */
interface Judged {
	/** Why it stands: its rule's law, or its stored relation's enforcement. */
	readonly reasons: NonEmptyReadonlyArray<PhysicalReason>
	/** The relations its statements read, by name, which its functions are created after. */
	readonly relations: ReadonlyArray<string>
	readonly order: string
	/** The deltas its writes capture into: an upkeep's, its stored relation's table's where a rule reads it, whose
	 * captures run inside the judge; a rule's block writes nothing. */
	readonly writes: ReadonlyArray<SessionDelta>
	/**
	 * Its functions in the order they run: a rule's side's one; a unit form's one, or a delta form's removal of the facts
	 * a write withdraws, then its insert of those it gains (`upkeepBlock`), which must follow the removal: a fact the
	 * write changed at one key of the stored relation is one removed and another inserted there.
	 */
	readonly calls: NonEmptyReadonlyArray<JudgedCall>
}

/**
 * A function of a block of the judge (`Judged`), identity.ruleJudgeBlock or identity.storedUpkeep: its statements with
 * the requester whose index requests their seeks are (`Asked`), and the deltas they read, where one of which holds a
 * row its part calls it (`partBody`).
 */
interface JudgedCall extends Asked {
	readonly named: Identity<"ruleJudgeBlock" | "storedUpkeep">
	readonly reads: NonEmptyReadonlyArray<SessionDelta>
}

/**
 * The block of a function of the judge, its variables and its statements, and who asks the indexes its seeks read
 * through (Requester): the function's program of them, as it runs them (sql/seeks.ts seekProgram), gives the requests,
 * one for each seek of a stored table, so every seek the judge prints is asked and nothing else is (`programRequests`).
 */
interface Asked {
	readonly by: Requester
	readonly body: PlBlock
}

/** The deltas a block's calls read (`Judged`), each once, in the order of their names. */
const readsOf = (j: Judged): NonEmptyReadonlyArray<SessionDelta> => {
	const [first, ...rest] = [
		...new Map(j.calls.flatMap((c) => c.reads.map((d) => [d.name, d] as const))).values()
	].toSorted((x, y) => compareStrings(x.name, y.name))
	return [defined(first, "a block's call reading a delta"), ...rest]
}

/**
 * A table the judge holds: its relation, the rules over queries that read it in trigger-name order, the stored relations
 * whose upkeep reads it, and its sides.
 */
interface JudgedTable {
	readonly relation: TheoryTable
	readonly rules: ReadonlyArray<{ readonly rule: RuleTrigger; readonly table: RuleTable }>
	readonly upkeeps: ReadonlyArray<StoredUpkeep>
	readonly sides: NonEmptyReadonlyArray<JudgedSide>
}

/**
 * The object that creates the table of `relation`: an ordinary relation's, or a stored derived relation's, which its
 * extension installed before the judge (physical/install/compile.ts).
 */
export const tableNode = (
	b: InstallBuilder,
	relation: TheoryTable
): Node<"setup" | "structure"> => {
	if (relation.kind === "relation") {
		return b.table(relation.name)
	}
	const stored = b.storedTable(relation.name)
	if (stored === undefined) {
		defect(`the table of the stored relation ${relation.name}, installed before the judge`)
	}
	return stored
}

/** A session table of the judge a site stands up or requires (`standing`): its name and the statements that make it. */
interface Stood {
	readonly name: string
	readonly create: NonEmptyReadonlyArray<PlStatement>
}

/** The name of a site's variable that holds which of its session tables stand (`standing`). */
const stoodName = "__stood"

/**
 * The sentinel as a site stands it up (`standing`): made with its trigger, which runs `judge`, by the one branch of a
 * stand-up that makes it, so the two commit together or not at all: the sentinel standing as the definer's own temporary
 * table proves its trigger stands, and a site reads it from its pg_class row alone, as it reads a delta. Nothing drops
 * the trigger while the sentinel stands: only its table's owner may, the judge's definer, which runs no statement but
 * grizzle's functions' and none of them drops one; no migration drops the judge (deploy/diff/diff.ts Dropped), which a
 * migration replaces in place, keeping the function the trigger runs; and the one drop of it, an uninstall's DROP SCHEMA
 * ... CASCADE, ends every session holding a temporary object of the installation's roles in the same transaction before
 * it commits (adapter/migrate/uninstall.ts, sql/ast.ts EndHolders). A site that also read the sentinel's trigger in
 * pg_trigger read it in every call, under a generic plan a sequential scan of the database's every trigger (edullm
 * PERF-COMMIT: 3,221 rows, about 1.6 ms a capture, 36 plans and 4.7 ms of a cold answer call). A stand-up that made the
 * sentinel and no trigger would arm nothing: every write it stood up would commit unjudged, which the laws' searches
 * refuse (test/pg/laws/rule-immediate.test.ts kills).
 */
const sentinelStood = (sentinel: string, judge: ObjectName): Stood => ({
	name: sentinel,
	create: [
		{
			kind: "createSessionTable",
			name: sentinel,
			columns: sentinelTable,
			storage: "toasted"
		},
		{ kind: "createSessionTrigger", name: sentinel, table: sentinel, function: judge }
	]
})

/** A delta as a site stands it up (`standing`). */
const deltaStood = (delta: SessionDelta): Stood => ({
	name: delta.name,
	create: [deltaTable(delta)]
})

/**
 * Each B-tree of `delta` its readers seek through (deltas.ts DeltaReads indexesOf), as a stand-up stands it up after
 * the delta (`standing`): made where the session holds none, beside the table the stand-up makes or one that stood
 * without it, so a session that stood the delta up under an installation whose readers sought through no index reads
 * through the new one from its next stand-up. A capture requires none: a reader that finds no index reads its rows
 * all the same.
 */
const indexesStood = (delta: SessionDelta, reads: DeltaReads): ReadonlyArray<Stood> =>
	reads.indexesOf(delta.name).map((index) => ({
		name: index.name,
		create: [deltaIndex(delta, index)]
	}))

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
				`write it through a served program of grizzle, whose session stands the tables up first, or call ${printObjectName(absent.standUp)}() before the write`,
				types.text
			)
		}
	]
})

/**
 * Each of a site's session tables `tables` read by one statement over the catalog for them all (sql/print.ts
 * sessionTablesStanding), so a site plans one read of pg_catalog.pg_class however many tables it reads, once in a
 * session. A table that stands but is not the definer's own temporary table is refused (deltas.ts foreignOf): a login
 * that made one first could empty it before COMMIT; the definer's own sentinel stands with its trigger
 * (`sentinelStood`). A table the session holds none of is made where the site is a stand-up, and refuses the statement
 * where it is a capture (`Absent`).
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
		{ kind: "assign", target: stoodName, value: sessionTablesStanding(names) },
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
const raiseOf = (b: InstallBuilder, rule: RuleTrigger, relation: TheoryTable): PlStatement => {
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

/**
 * Each table a rule over a query or a stored relation's upkeep reads, with its rules in trigger-name order, its upkeeps
 * in name order, and the sides they read of it: a rule's the sides its touches name, an upkeep's both, at every column
 * its definition reads of it: a unit form's, since a row a holder gains or loses at a unit changes the stored rows
 * there, and a delta form's, its gained rules reading the rows a write adds and its removed side the rows a write
 * deletes of a mutable holder (analysis/theory/upkeep.ts). No upkeep reads a relation it reads by reference, closed,
 * whose removed rows only a data step has, whose bracket's re-check refills the stored relation (physical/ddl/recheck.ts),
 * so no capture writes them.
 */
const judgedTables = (b: InstallBuilder): ReadonlyArray<JudgedTable> => {
	const ordered = b.model.rules.toSorted((x, y) =>
		compareStrings(identifierOf(x.named), identifierOf(y.named))
	)
	interface Held {
		readonly relation: TheoryTable
		readonly rules: Array<{ readonly rule: RuleTrigger; readonly table: RuleTable }>
		readonly upkeeps: Array<StoredUpkeep>
		readonly read: { readonly added: Set<string>; readonly removed: Set<string> }
		/** The sides an upkeep's statements read of the relation (StoredUpkeep `sides`). */
		readonly upkept: Set<ProbeSide>
	}
	const byRelation = new Map<string, Held>()
	const heldOf = (relation: TheoryTable): Held =>
		byRelation.getOrInsertComputed(relation.name, () => ({
			relation,
			rules: [],
			upkeeps: [],
			read: { added: new Set(), removed: new Set() },
			upkept: new Set()
		}))
	for (const rule of ordered) {
		for (const t of rule.tables) {
			const held = heldOf(t.relation)
			held.rules.push({ rule, table: t })
			for (const side of ["added", "removed"] as const) {
				for (const f of touchedOn(t.touches, side) ?? []) {
					held.read[side].add(f)
				}
			}
		}
	}
	for (const upkeep of b.model.theory.upkeeps) {
		for (const s of upkeep.sides) {
			const relation = b.model.theory.relations[s.relation]
			if (relation?.kind !== "relation" && relation?.kind !== "stored") {
				defect(
					`${s.relation}, a table the upkeep of ${upkeep.relation} reads: an ordinary relation or a stored derived one`
				)
			}
			const held = heldOf(relation)
			if (!held.upkeeps.includes(upkeep)) {
				held.upkeeps.push(upkeep)
			}
			held.upkept.add(s.side)
			for (const f of s.columns) {
				held.read[s.side].add(f)
			}
		}
	}
	return [...byRelation.values()].flatMap((held): ReadonlyArray<JudgedTable> => {
		const relation = held.relation
		const sides = (["added", "removed"] as const).flatMap((side): ReadonlyArray<JudgedSide> => {
			const read = [...held.read[side]]
			const touched =
				held.upkept.has(side) ||
				held.rules.some(({ table }) => touchedOn(table.touches, side) !== undefined)
			return touched
				? [
						{
							side,
							delta: sessionDeltaOf(b, relation, side),
							read: [...new Set(columnsOf(relation, read))]
						}
					]
				: []
		})
		const [s0, ...ss] = sides
		return s0 === undefined
			? []
			: [
					{
						relation,
						rules: held.rules,
						upkeeps: held.upkeeps,
						sides: [s0, ...ss]
					}
				]
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

/**
 * One borrow of the judge's (core/certificate.ts Borrow `judge`): a unit, exclusively, at the key of each row the
 * transaction wrote to one holder of a stored relation under it (KeySite `delta`), and the holder's fields that hold the
 * unit's key, in its heading's order (schema/own.ts UnitMember).
 */
interface JudgeBorrow extends Borrow {
	readonly lock: Extract<BorrowLock, { readonly kind: "unit" }>
	readonly keys: readonly [Extract<KeySite, { readonly kind: "delta" }>]
	readonly fields: NonEmptyReadonlyArray<string>
}

/** The name of an upkeep's variable that holds the tuple id of the stored row its loop deletes (upkeepBlock `removal`). */
const staleName = "__stale"

/** Whether any of `deltas` holds a row once netted: the condition a block runs on, and a delta is stood up on. */
const anyRowed = (deltas: NonEmptyReadonlyArray<SessionDelta>): Expr => ({
	kind: "binary",
	op: "&&",
	left: rowedSet,
	right: namesOf(mapNonEmpty(deltas, (d) => d.name)),
	schema: undefined
})

/**
 * A part of the judge (`partsOf`): its pass, `upkeep`, the stored relations' upkeep blocks of one stratum (phase A), or
 * `rules`, the rules' blocks (phase B); its deltas, by name; and its blocks, in the judge's order. Two strata's parts may
 * read the same deltas, a stored relation over a holder beside one over that relation and the same holder, so an upkeep
 * part is named by its stratum too (identity.ruleJudgePart).
 */
interface JudgePart {
	readonly pass: { readonly kind: "upkeep"; readonly stratum: number } | { readonly kind: "rules" }
	readonly deltas: NonEmptyReadonlyArray<SessionDelta>
	readonly blocks: NonEmptyReadonlyArray<Judged>
}

/**
 * The judge's parts: the classes of its blocks under reading a delta in common, each with every delta its blocks read,
 * so no block of one part reads a delta of another, and a transaction that writes no delta of a part runs none of it. A
 * learner's relations and a content package's are parts apart, joined by no rule's region, so a session that writes a
 * learner's rows compiles and runs the learner's part alone. In the order of each part's first block.
 */
const partsOf = (
	judged: ReadonlyArray<Judged>,
	pass: JudgePart["pass"]
): ReadonlyArray<JudgePart> => {
	const parent = new Map<string, string>()
	const root = (name: string): string => {
		let at = name
		for (let up = parent.get(at); up !== undefined && up !== at; up = parent.get(at)) {
			at = up
		}
		return at
	}
	for (const j of judged) {
		const read = readsOf(j)
		for (const d of read) {
			if (!parent.has(d.name)) {
				parent.set(d.name, d.name)
			}
			parent.set(root(d.name), root(headNonEmpty(read).name))
		}
	}
	const byRoot = new Map<
		string,
		{ readonly deltas: Set<SessionDelta>; readonly blocks: Array<Judged> }
	>()
	for (const j of judged) {
		const read = readsOf(j)
		const at = root(headNonEmpty(read).name)
		const part = byRoot.get(at) ?? { deltas: new Set(), blocks: [] }
		for (const d of read) {
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
			: [{ pass, deltas: [d0, ...ds], blocks: [b0, ...bs] }]
	})
}

/**
 * The session tables one maker of the judge makes itself (`standingsOf`), a closure's maker or a table's stand-up: the
 * deltas it alone needs, `made`, and the shares it calls, each the deltas it needs that some other maker needs too. So
 * every delta's table, and each index its readers seek through, is made by one function of the installation.
 */
interface Making {
	readonly made: ReadonlyArray<SessionDelta>
	readonly shares: ReadonlyArray<Share>
}

/**
 * A share of the judge (`standingsOf`): the deltas two or more makers need, each the same ones, made by one function,
 * `ident`, which each of them calls: a delta beside a stored relation's that a table's block reads beside its own too,
 * or that two closures hold, or that two tables' blocks read beside theirs. It makes no marker: each maker that calls it
 * makes its own, last.
 */
interface Share {
	readonly ident: Identity<"ruleShare">
	readonly deltas: NonEmptyReadonlyArray<SessionDelta>
}

/**
 * A closure of the judge (`standingsOf`): the deltas a write that reaches a stored relation's reaches inside the judge,
 * made by one function, `ident`, its maker, which the stand-up of each table whose writes reach them calls, so the
 * installation states them once however many tables' writes reach them, and proven to stand by one marker, `marker`,
 * which the maker makes last. An upkeep writes its stored relation's table, whose captures write its deltas inside the
 * judge, which the rules over it and the upkeep of each stored relation over it read beside the deltas of what they
 * join, a stratum up: so its deltas are every delta of each block that reads or writes one of its stored relations'
 * deltas, in name order, and a write that reaches one of its stored relations reaches them all. Its maker makes those
 * it alone needs and calls the shares of the rest (`making`).
 */
interface Closure {
	readonly ident: Identity<"ruleClosure">
	readonly marker: Identity<"ruleStood">
	readonly deltas: NonEmptyReadonlyArray<SessionDelta>
	readonly making: Making
}

/**
 * What the stand-up of a judged table makes (`standingsOf`), every session table a write of it can lead the judge to
 * read or write: its loose deltas, its own and those a block reads beside them that no closure it reaches holds, which
 * it makes itself or by a share (`making`); the closures their blocks reach, whose makers it calls; and the marker of the
 * whole, which it makes last, the one table its capture requires beside the sentinel. A stored relation's tables are
 * its closure's, so its marker is its closure's, which the maker made: its writes are its upkeep's, inside the judge a
 * capture armed, whose stand-up called that maker.
 */
interface TableStanding {
	readonly making: Making
	readonly closures: ReadonlyArray<Closure>
	readonly marker: Identity<"ruleStood">
}

/** The installation's shares and closures, each in its maker's name order, and each judged table's standing, by its
 * relation. */
interface Standings {
	readonly shares: ReadonlyArray<Share>
	readonly closures: ReadonlyArray<Closure>
	readonly of: ReadonlyMap<string, TableStanding>
}

/**
 * The judge's session tables a write of each judged table needs, by the table's relation, decomposed into closures
 * (`Closure`) and shares (`Share`): every delta a block of the judge reads or writes beside one of the table's own
 * (Judged `reads`, `writes`), and, for each delta an upkeep writes among those, every delta beside that one in turn. A
 * whole rule's region reads the delta of each side it reads of each holder of its unit, and a transaction that wrote one
 * of them need not have written the others, so a block a delta's row runs finds every delta it reads and writes
 * (`partBody`), however many stored relations above the table the judge keeps from it.
 *
 * The deltas an upkeep writes (`kept`) are joined into one closure wherever a block holds two of them, and a closure
 * holds every delta of each block that holds one of its own: from a delta, the deltas beside it, and from each kept one
 * among those its whole closure, whose blocks reach no kept delta outside it. So a table's tables are its own and those
 * beside them (`reach`), with the closure of each kept one among them; its loose ones those no such closure holds. Every
 * delta is made by one function: a delta one maker alone needs, a closure's or a table's stand-up, by that maker; one
 * that more need, a delta no upkeep writes that two closures hold, or one closure and a table's block beside its own, or
 * two tables' blocks, by the share of the makers that need it, which each of them calls. Closures share no kept delta,
 * so a kept delta is its closure's alone. So the installation states each delta's table, and each index its readers seek
 * through, once, and each maker calls a share at most once: linear in the blocks, where each stand-up and each capture
 * restated the whole of its table's, which grew with the schema's square (qti-pie's pantry under D3: 54,883 tables made
 * across 340 stand-ups of 583 deltas, 53.7 MB, and every capture requiring each of them by name, every event apart,
 * Node's 499, 61.3 MB), and closures and stand-ups that each made a delta they both needed made 77 of the pantry's
 * deltas 324 times.
 */
const standingsOf = (
	b: InstallBuilder,
	judged: ReadonlyArray<Judged>,
	tables: ReadonlyArray<JudgedTable>
): Standings => {
	const installation = headNonEmpty(b.names.levels)
	const groups = judged.map((j) => [
		...new Map([...readsOf(j), ...j.writes].map((d) => [d.name, d] as const)).values()
	])
	const kept = new Set(judged.flatMap((j) => j.writes.map((d) => d.name)))
	const parent = new Map<string, string>()
	const root = (name: string): string => {
		let at = name
		for (let up = parent.get(at); up !== undefined && up !== at; up = parent.get(at)) {
			at = up
		}
		return at
	}
	for (const group of groups) {
		const [first, ...rest] = group.filter((d) => kept.has(d.name))
		if (first === undefined) {
			continue
		}
		for (const d of [first, ...rest]) {
			parent.set(root(d.name), root(first.name))
		}
	}
	const beside = new Map<string, Map<string, SessionDelta>>()
	const held = new Map<string, Map<string, SessionDelta>>()
	for (const group of groups) {
		for (const d of group) {
			const at = beside.getOrInsertComputed(d.name, () => new Map())
			for (const e of group) {
				at.set(e.name, e)
			}
		}
		for (const r of new Set(group.flatMap((d) => (kept.has(d.name) ? [root(d.name)] : [])))) {
			const at = held.getOrInsertComputed(r, () => new Map())
			for (const e of group) {
				at.set(e.name, e)
			}
		}
	}
	const relationOf = new Map(
		tables.flatMap((t) => t.sides.map((s) => [s.delta.name, t.relation.name] as const))
	)
	const byName = (x: SessionDelta, y: SessionDelta): number => compareStrings(x.name, y.name)
	const markers = new Map<string, Identity<"ruleStood">>()
	const markerOf = (deltas: NonEmptyReadonlyArray<SessionDelta>): Identity<"ruleStood"> => {
		const marker = identity.ruleStood(
			installation,
			mapNonEmpty(deltas, (d) => d.ident)
		)
		if (!markers.has(marker.identifier)) {
			markers.set(marker.identifier, marker)
			b.name(marker)
		}
		return defined(markers.get(marker.identifier), "a closure's marker")
	}
	const sets = new Map(
		[...held].map(([r, deltas]) => {
			const [first, ...rest] = [...deltas.values()].toSorted(byName)
			const stored = [...deltas.keys()]
				.flatMap((name) =>
					kept.has(name) ? [defined(relationOf.get(name), "a kept delta's relation")] : []
				)
				.toSorted(compareStrings)
			const all: NonEmptyReadonlyArray<SessionDelta> = [
				defined(first, "a closure's delta"),
				...rest
			]
			const marker = markerOf(all)
			const ident = identity.ruleClosure(defined(stored[0], "a closure's stored relation"), marker)
			return [r, { ident, marker, deltas: all }] as const
		})
	)
	const standings = tables.map((t) => {
		const reach = new Map<string, SessionDelta>()
		for (const { delta } of t.sides) {
			reach.set(delta.name, delta)
			for (const [name, e] of beside.get(delta.name) ?? []) {
				reach.set(name, e)
			}
		}
		const reached = [
			...new Set([...reach.keys()].flatMap((name) => (kept.has(name) ? [root(name)] : [])))
		]
			.map((r) => defined(sets.get(r), "a kept delta's closure"))
			.toSorted((x, y) => compareStrings(x.ident.identifier, y.ident.identifier))
		const covered = new Set(reached.flatMap((s) => s.deltas.map((d) => d.name)))
		const need = new Map(reach)
		for (const s of reached) {
			for (const d of s.deltas) {
				need.set(d.name, d)
			}
		}
		const [first, ...rest] = [...need.values()].toSorted(byName)
		return {
			t,
			loose: [...reach.values()].filter((d) => !covered.has(d.name)).toSorted(byName),
			reached,
			marker: markerOf([defined(first, "a judged table's delta"), ...rest])
		}
	})
	/** The makers that need each delta, by its name: each closure that holds it, and each table it is loose for. */
	const owners = new Map<string, Array<string>>()
	const deltaOf = new Map<string, SessionDelta>()
	const own = (owner: string, deltas: ReadonlyArray<SessionDelta>): void => {
		for (const d of deltas) {
			owners.getOrInsertComputed(d.name, () => []).push(owner)
			deltaOf.set(d.name, d)
		}
	}
	for (const set of sets.values()) {
		own(set.ident.identifier, set.deltas)
	}
	for (const s of standings) {
		own(`table ${s.t.relation.name}`, s.loose)
	}
	/** The deltas two or more makers need, by the makers that need them. */
	const sharedBy = new Map<
		string,
		{ readonly owners: ReadonlyArray<string>; readonly deltas: Array<SessionDelta> }
	>()
	for (const [name, by] of owners) {
		if (by.length > 1) {
			sharedBy
				.getOrInsertComputed(by.join("\n"), () => ({ owners: by, deltas: [] }))
				.deltas.push(defined(deltaOf.get(name), "a shared delta"))
		}
	}
	const shares = [...sharedBy.values()].map(({ owners: by, deltas }) => {
		const [first, ...rest] = deltas.toSorted(byName)
		const all: NonEmptyReadonlyArray<SessionDelta> = [defined(first, "a share's delta"), ...rest]
		const share: Share = {
			ident: identity.ruleShare(
				defined(relationOf.get(all[0].name), "a shared delta's relation"),
				mapNonEmpty(all, (d) => d.ident)
			),
			deltas: all
		}
		return { owners: by, share }
	})
	const makingOf = (owner: string, deltas: ReadonlyArray<SessionDelta>): Making => ({
		made: deltas.filter((d) => (owners.get(d.name) ?? []).length === 1),
		shares: shares
			.flatMap((s) => (s.owners.includes(owner) ? [s.share] : []))
			.toSorted((x, y) => compareStrings(x.ident.identifier, y.ident.identifier))
	})
	const closures = new Map(
		[...sets.values()].map((set) => {
			const closure: Closure = { ...set, making: makingOf(set.ident.identifier, set.deltas) }
			return [set.ident.identifier, closure] as const
		})
	)
	const of = new Map(
		standings.map((s) => {
			const table: TableStanding = {
				making: makingOf(`table ${s.t.relation.name}`, s.loose),
				closures: s.reached.map((set) =>
					defined(closures.get(set.ident.identifier), "a reached closure")
				),
				marker: s.marker
			}
			return [s.t.relation.name, table] as const
		})
	)
	const byIdent = <K extends "ruleClosure" | "ruleShare">(
		x: { readonly ident: Identity<K> },
		y: { readonly ident: Identity<K> }
	): number => compareStrings(x.ident.identifier, y.ident.identifier)
	return {
		shares: shares.map((s) => s.share).toSorted(byIdent),
		closures: [...closures.values()].toSorted(byIdent),
		of
	}
}

/**
 * A part's body, run where the transaction wrote a row into one of its deltas, `written` the names of those it wrote
 * (`marked`):
 *
 * - the names of its written deltas that hold a row once netted, into `rowedName`: each side of news, which the judge
 *   netted before phase A (`nettingsOf`), so it holds delta.added, read again, since the images it held may all cancel;
 *   a side of olds holds the rows it was marked for. A delta the transaction did not write is never read: a session's
 *   deltas of every relation an earlier transaction wrote hold no row of this one;
 * - each delta a block reads beside the one that ran it stands: the stand-up of each table a write writes makes every
 *   delta the judge reads beside its own and the marker of them all (`standingsOf`, addStandUps), and the capture that
 *   wrote the delta that ran the block required the marker (addCapture);
 * - each block's calls in their order, each where a delta it reads holds a row: over deltas that hold none its region is
 *   empty, and every statement of it finds no row. A call is a function of its own (`functionOf`, identity.ruleJudgeBlock
 *   or identity.storedUpkeep), the part's statement a call of it: PostgreSQL compiles a PL/pgSQL function's whole text
 *   at its first call in a session and plans each statement at its first run, so a session compiles a call's statements
 *   only where its transaction runs them. A part that held its blocks' statements compiled every one at its session's
 *   first COMMIT that ran the part: the ledger's learner part, 76 statements and 2.68 MB, 47 ms before a save ran the 5
 *   statements over what it wrote. A block's calls are its own: a stored relation's upkeep held as one call of a delta
 *   form's removal and gain ran the removal's statements wherever the gain's ran, a document inserted alone running
 *   Documented's DELETE and INSERT at the units of Doc's and Part's empty sides of olds, planned and run over nothing,
 *   the DELETE's seek of Documented's table holding ACCESS SHARE to COMMIT (test/pg/laws/rule-dispatch).
 */
const partBody = (
	part: JudgePart,
	sideOf: (name: string) => { readonly t: JudgedTable; readonly s: JudgedSide },
	functionOf: (call: JudgedCall) => ObjectName
): PlBlock => {
	const flags = mapNonEmpty(part.deltas, (delta): PlStatement => {
		const { s } = sideOf(delta.name)
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
			...part.blocks.flatMap((j) =>
				j.calls.map((call): PlStatement => ({
					kind: "if",
					branches: [{ condition: anyRowed(call.reads), body: [performed(functionOf(call), [])] }],
					else: []
				}))
			),
			...(part.pass.kind === "rules" ? part.deltas.map(emptiedWhereWritten) : [])
		]
	}
}

/** PERFORM <fn>(<args>): a call of a function of the judge, the value it returns discarded. */
const performed = (fn: ObjectName, args: ReadonlyArray<Expr>): PlStatement => ({
	kind: "perform",
	query: {
		body: core(
			[
				{
					expr: qualifiedCall(
						{ kind: "qualified", schema: fn.schema, name: fn.name, volatility: "VOLATILE" },
						args
					),
					alias: undefined
				}
			],
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
 * Each side of news of a table of `tables` a transaction writes that a rule or a delta form's gained rules read (`ruled`,
 * the deltas of the rules' parts and of those forms' holders), netted where the transaction wrote it (deltas.ts netted),
 * in its delta's name order: the judge's one netting of each, before phase A, so every rule and every upkeep reads it
 * netted and no part nets one, where each part netted each side of news it held, and a delta an upkeep part and a rule
 * part both held was netted twice in one run, the second pass deleting nothing. A gained rule reads a row's image
 * itself, never its table again, so an image the transaction inserted and deleted would gain a fact no row stands for.
 * A side only a unit form reads is never netted: it reads of it the units its rows name, and the images a netting
 * deletes, cancelled or repeated, name units its rows name already or units the write touched, at which the upkeep's
 * definition is read again to the same rows, so netting it is a pass nothing needs. A stored
 * relation's (`stored`) side of news is netted as its upkeep writes it: only the upkeep writes its table, once in a run,
 * its DELETE before its INSERT, so no removal is counted there (deltas.ts captured) and each image it puts stands once.
 *
 *   IF __written @> '{<delta>}' THEN <the delta netted> END IF
 */
const nettingsOf = (
	tables: ReadonlyArray<JudgedTable>,
	stored: ReadonlySet<string>,
	ruled: ReadonlySet<string>
): ReadonlyArray<PlStatement> =>
	tables
		.flatMap((t) =>
			stored.has(t.relation.name)
				? []
				: t.sides.flatMap((s) => (s.side === "added" && ruled.has(s.delta.name) ? [{ t, s }] : []))
		)
		.toSorted((x, y) => compareStrings(x.s.delta.name, y.s.delta.name))
		.map(({ t, s }): PlStatement => ({
			kind: "if",
			branches: [{ condition: wrote(s.delta.name), body: [netted(t.relation, s)] }],
			else: []
		}))

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
 *   holds one transaction's rows; a capture requires its table's marker of it and makes none, so no write's transaction makes a relation: the judge empties each delta it reads, once its part
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
 *   written set names once its rules have read them (`emptied`), its statements reading every delta through its
 *   readers (deltas.ts headed), so their plans outlive a truncation, so a judge that runs again after SET
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
 *   sentinel and its table's marker, which only the site that made every table the table's writes need makes, last
 *   (`TableStanding`), each site in one read of the catalog (`standing`): each must be the definer's own temporary
 *   table, the sentinel's trigger the judge, or the statement is refused, insufficient_privilege naming the table
 *   (deltas.ts foreignOf); a capture that finds one missing refuses the statement as grizzle's own 55Z03 (`unstood`).
 *   The judge reads only the deltas the written set names, each made by the stand-up whose marker the capture that
 *   marked it required, and the set itself the sentinel's row, which no other role may write. Every function is SECURITY
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
	b: InstallBuilder,
	targets: SeekTargets
): {
	readonly requests: ReadonlyArray<IndexRequest>
	readonly checks: ReadonlyMap<LawId, OperandSelect>
	/** Each judged table's stand-up, by its relation's name (`addStandUps`). */
	readonly standUps: ReadonlyMap<string, JudgeStandUp>
} => {
	const catalog = evidenceCatalog({ laws: b.model, views: noViewEvidence })
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
	/** What the probes prove a sibling's cover by (analysis/theory/query.ts Proofs): the theory's containments and keys. */
	const proofs = proofsOf(
		b.model.theory.regionFacts,
		(relation) => b.model.theory.relations[relation],
		clockOrders(b.model.theory.instants)
	)
	const tableOf = (relation: string): JudgedTable | undefined =>
		tables.find((t) => t.relation.name === relation)
	/** The reads of the session's deltas the judged statements make, each a reader of its selection (`headed`). */
	const reads = new DeltaReads(
		b,
		tables.flatMap((t) =>
			t.sides.map((s) => ({ relation: t.relation, side: s.side, delta: s.delta }))
		)
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
	 * (probeGuard): the guard runs first, an existence read to its first row (sql/build.ts whenExists), one seek of its
	 * relation at each of the delta's units however many of that relation's rows stand there, and the probe, which
	 * PL/pgSQL plans when it first runs it, only where the guard finds a row, a write whose units hold no row of the
	 * relation every row of the probe reads planning and running none of it (edullm's first publish of a package: the learner-side rules over the content, 31.5 of the catalog
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
			const query = probe(probed, relation.name, side, proofs, rule.law.loc)
			if (query === undefined) {
				return []
			}
			const compiled = compileProbe(b, catalog, rule, relation, query, deltas, reads)
			appendAll(requests, compiled.requests)
			const judged = whenFound(compiled.statement, [raise])
			const guard = probeGuard(probed, relation.name, side, keysOf, fieldsOf, rule.law.loc)
			const guarded =
				guard === undefined
					? undefined
					: compileProbe(b, catalog, rule, relation, guard, deltas, reads)
			if (guarded !== undefined) {
				appendAll(requests, guarded.requests)
			}
			return delta === undefined
				? []
				: [
						{
							reasons: lawReasonOf(rule),
							relations: [...rule.law.reads],
							order: identifierOf(rule.named),
							writes: [],
							calls: [
								{
									named: identity.ruleJudgeBlock(rule.named, rule.law.named, {
										kind: "probe",
										relation: relation.name,
										side
									}),
									reads: [delta],
									by: ruleRequester(rule),
									body: {
										declare: [],
										body: [guarded === undefined ? judged : whenExists(guarded.statement, [judged])]
									}
								}
							]
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
			(root) => requestsOf(b, ruleRequester(rule), root),
			unit.judged,
			definedAt(b.columns, unit.definitionOf),
			label,
			rule.law.loc,
			deltas,
			reads,
			"units"
		)
		appendAll(requests, lowered.requests)
		/**
		 * The table its refusal names: the first, in its unit's order, of the tables whose writes can change it, the
		 * holders its region reads a side of (RuleTrigger `tables`, WholeRule `sides`), each a table the constraint map
		 * names its law by. A closed holder its region reads only where it loses rows, which only a data step does, whose
		 * bracket's re-check judges the rule whole (physical/ddl/recheck.ts), is none of them, wherever it sorts among the
		 * holders (pantry's "Data SSML": RequiredSsmlProperty in the closed DataSsmlProperty, which sorts first).
		 */
		const holders = unit.unit.holders.map((h) => h.relation)
		const holder = headNonEmpty(
			sortNonEmpty(rule.tables, (x, y) =>
				compareNumbers(holders.indexOf(x.relation.name), holders.indexOf(y.relation.name))
			)
		)
		const [first, ...rest] = rule.tables.flatMap((rt) =>
			defined(
				tableOf(rt.relation.name),
				`the judged table ${rt.relation.name}, a table its rule reads`
			).sides.flatMap((s) => (touchedOn(rt.touches, s.side) === undefined ? [] : [s.delta]))
		)
		return {
			reasons: lawReasonOf(rule),
			relations: [...rule.law.reads],
			order: identifierOf(rule.named),
			writes: [],
			calls: [
				{
					named: identity.ruleJudgeBlock(rule.named, rule.law.named, { kind: "units" }),
					reads: [
						defined(
							first,
							`a delta of a side ${rule.law.named.display} reads, which its touches name`
						),
						...rest
					],
					by: ruleRequester(rule),
					body: {
						declare: [],
						body: [whenFound(lowered.statement, [raiseOf(b, rule, holder.relation)])]
					}
				}
			]
		}
	}
	/**
	 * The judge's block of a stored relation's upkeep, phase A of its part (analysis/theory/unit.ts StoredUpkeep), its
	 * statements its form's (analysis/theory/upkeep.ts), a unit form's in one call and a delta form's removal and gain in
	 * a call each, in that order (`partCall`, identity.storedUpkeep), each run where a delta its own statements read holds
	 * a row, under the judge's borrow of those units (`judgeBorrow`). Each inserts by S's primary key (`inserting`): a fact S already holds is a
	 * conflict on that key, one probe of its index, never an anti join PostgreSQL may plan as a hash of S whole.
	 *
	 * - A unit form's rows at the units the transaction wrote become its definition's rows there, by their set difference:
	 *   S's rows at the units, each found by a seek of S's unit key at a unit, that no row of the definition there agrees
	 *   with, each deleted by its tuple id (`removal`), then the definition's rows inserted:
	 *
	 *     FOR __stale IN SELECT DISTINCT r<s>.c1 FROM (<the written units' keys>) AS r2 (c1, …),
	 *         LATERAL (SELECT r<k>.ctid AS c1, r<k>.<f0> AS c2, … FROM <S> AS r<k> WHERE r<k>.<u0> = r2.c1 AND … OFFSET 0)
	 *           AS r<s>
	 *         WHERE NOT EXISTS (SELECT FROM (<its definition there>) AS r<d> WHERE r<s>.c2 = r<d>.c1 AND …)
	 *       LOOP DELETE FROM <S> AS r1 WHERE r1.ctid = __stale; END LOOP
	 *     INSERT INTO <S> (<columns>) SELECT r3.* FROM (<its definition there>) AS r3 ON CONFLICT (<S's key>) DO NOTHING
	 *
	 *   So S's rows that stay are never touched: its indexes keep them, and its deltas, where a rule reads it, hold only
	 *   the rows it truly gains and loses. Two statements, since a data-modifying CTE orders no DELETE before the INSERT
	 *   beside it, and a changed row at one key is one row removed and another inserted there. Its key leads with the
	 *   unit, so rows of different units never meet, and the two are exact for every write: after the DELETE, S's rows at
	 *   the units are some of the definition's there, so a row of the definition S's key finds is that row, the key being
	 *   one the definition proves. Its reads ask the indexes a whole rule's do (`requestsOf`), each led by the unit's key,
	 *   under the stored relation's enforcement: a chain's later steps look rows up by the columns the steps before them
	 *   bound, which no primary key range serves. The loop's query is headed whole (deltas.ts headed), so its region and the
	 *   region its definition reads share their readers' calls, and the INSERT reads the region once, in its definition.
	 * - A delta form first removes the facts the transaction withdraws, then inserts the facts it gains
	 *   (analysis/theory/query.ts gainedFacts), each read from the rows it wrote outward, a step of a lookup by the
	 *   columns the steps before it bound, its requests a probe's, led by no unit:
	 *
	 *     INSERT INTO <S> (<columns>) SELECT r.* FROM (<the facts gained>) AS r ON CONFLICT (<S's key>) DO NOTHING
	 *
	 *   A checked form removes the facts its lost rules find (analysis/theory/query.ts lostFacts), each a candidate the
	 *   write may withdraw checked at the fact against the definition as it stands, by its whole heading, which S's key
	 *   leads, one probe of its index:
	 *
	 *     FOR __stale IN <S's row at each fact lost, by a lookup of its own>
	 *       LOOP DELETE FROM <S> AS r1 WHERE r1.ctid = __stale; END LOOP
	 *
	 *   A monotone form re-derives, as a unit form does, the units the rows the transaction removed of a mutable holder
	 *   touch; over closed holders alone it reads no removed row, which only a data step has, whose bracket refills S
	 *   (physical/ddl/recheck.ts). Exact: after the removal S holds the facts of its definition at COMMIT that it held
	 *   before, and the insert adds every fact the definition gained, by S's key, the definition's.
	 *
	 * A stored relation that reads relations of sealed units by reference reads them at the keys its units' rows name,
	 * closed: a data step that removes or rewrites one of their rows is followed by its bracket's re-check, which makes S
	 * its definition's rows again (physical/ddl/recheck.ts), so no call reads a reference's removed rows.
	 */
	const upkeepBlock = (u: StoredUpkeep): Judged => {
		const label = `stored relation ${u.relation} over the rows a transaction wrote`
		const justification = {
			kind: "enforcement",
			of: `derived relation ${u.relation}`
		} as const satisfies Requester["justification"]
		const display = `the upkeep of stored relation ${u.relation}`
		const deltas = (name: string, side: DeltaSide): DeltaRelation | undefined => {
			const t = tableOf(name)
			return t === undefined ? undefined : sessionDelta(t, side)
		}
		const table = b.names.relation(u.relation)
		const columnOf = (field: string): string => b.names.column(u.relation, field)
		const kept = b.model.theory.relations[u.relation]
		if (kept?.kind !== "stored") {
			defect(`stored relation ${u.relation}, a stored derived relation of the theory's`)
		}
		/** The generated column a derived table of `n` columns names its i-th, c<i+1>. */
		const columnsAt = (n: number): ReadonlyArray<string> =>
			Array.from({ length: n }, (_, i) => `c${i + 1}`)
		/**
		 * The INSERT of `rows`, a query delivering S's fields `heading` in order, each row S's key does not already hold:
		 * every name `rows` defines its own, its rows r<n+1>.
		 */
		const inserting = (
			rows: OperandSelect,
			heading: NonEmptyReadonlyArray<string>
		): PlStatement => {
			const rowsAlias = `r${lastNumbered(rows) + 1}`
			return {
				kind: "modify",
				statement: {
					kind: "insert",
					with: undefined,
					table,
					alias: undefined,
					onConflict: {
						kind: "columns",
						columns: mapNonEmpty(kept.primaryKey, columnOf),
						action: { kind: "doNothing" }
					},
					returning: [],
					columns: heading.map(columnOf),
					source: {
						kind: "query",
						query: provedSelect(
							"keyed",
							heading.map((_, i) => ({ expr: col(rowsAlias, `c${i + 1}`), alias: undefined })),
							[derived(namedQuery(rows, columnsAt(heading.length)), rowsAlias, false)],
							undefined
						)
					}
				}
			}
		}
		/** The heading a lowered query of S's delivers, every field of S's, at least one. */
		const headingOf = (compiled: Compiled): NonEmptyReadonlyArray<string> => {
			const heading = compiled.heading
			if (!isNonEmpty(heading)) {
				defect(`stored relation ${u.relation}'s definition, which delivers at least one field`)
			}
			return heading
		}
		/**
		 * The removal of S's rows at the tuple ids `tids` selects, its query read as every judged statement reads a
		 * delta (`headed`), each id once (`unitBody`, `checkedBody`): a loop over the ids, deleting S's row at each by
		 * itself,
		 *
		 *   FOR __stale IN <tids> LOOP DELETE FROM <S> AS r1 WHERE r1.ctid = __stale; END LOOP
		 *
		 * Per row, since no one statement over the ids is planned by them. The DELETE at one id is a TID scan of that one
		 * row, its one random page, cheaper than a read of S whole of more than a page or two, which PostgreSQL plans once
		 * for the function and keeps, whatever it estimates of the ids; a DELETE of them all is planned by its estimate of
		 * how many there are: a self-join on ctid as a Hash Join over a Seq Scan of S, and `r1.ctid = ANY (ARRAY(<tids>))`
		 * as a Seq Scan of S filtered by the array, an InitPlan's whose length PostgreSQL cannot count before it runs and
		 * guesses (selfuncs.c estimate_array_length), each id priced as a random page past S's pages read in order: all
		 * 1,370 rows of Forward's table read beside 1,370 packages at a founding write whose bound is 12
		 * (test/pg/lower-shapes/import-upkeep).
		 *
		 * What bounds it: the ids are those of S's rows at the write's units (or at the facts it withdraws), each found by
		 * a seek of S's key fenced per row of the delta (fencedRead), so the loop runs a DELETE for each such row and
		 * each reads one, the rows the write's delta reaches and no other, however many S holds.
		 */
		const removal = (tids: Select): PlBlock => ({
			declare: [{ name: staleName, type: types.tid }],
			body: [
				{
					kind: "forQuery",
					variable: staleName,
					query: setQueryOf(headed(tids, reads), "the stale ids' query headed"),
					body: [
						{
							kind: "modify",
							statement: {
								kind: "delete",
								with: undefined,
								table,
								alias: "r1",
								using: [],
								where: eq(col("r1", "ctid"), { kind: "plVar", name: staleName }),
								returning: []
							}
						}
					]
				}
			]
		})
		const unitBody = (form: UnitForm): Asked => {
			const requester: Requester = {
				justification,
				unit: u.stored.unit,
				references: u.stored.references,
				display
			}
			const units = loweredJudged(
				b,
				catalog,
				(root) => requestsOf(b, requester, root),
				form.region,
				b.columns,
				label,
				u.loc,
				deltas,
				"units"
			)
			const rows = loweredJudged(
				b,
				catalog,
				(root) => requestsOf(b, requester, root),
				form.judged,
				definedAt(b.columns, form.definitionOf),
				label,
				u.loc,
				deltas,
				"units"
			)
			appendAll(requests, units.requests)
			appendAll(requests, rows.requests)
			const heading = headingOf(rows)
			const unitNames = lastNumbered(units.statement)
			const rowNames = lastNumbered(rows.statement)
			/** The DELETE's names: S r1, the region's own past it, the region r<u+2>, the definition's past that, then
			 * its rows r<u+r+3>, S's row at a unit r<u+r+4>, the seek r<u+r+5>. */
			const regionAlias = `r${unitNames + 2}`
			const foundAlias = `r${unitNames + rowNames + 3}`
			const seekAlias = `r${unitNames + rowNames + 4}`
			const atAlias = `r${unitNames + rowNames + 5}`
			/**
			 * The stored rows at each written unit, a seek of the table's unit key at the unit's values, fenced so it is
			 * read per unit whatever PostgreSQL estimates of the units (each delta's reader a function it prices at ten
			 * rows), its tuple id and its fields: the rows the write's units reach and no other.
			 */
			const seek = fencedRead(
				[
					{ expr: col(seekAlias, "ctid"), alias: "c1" },
					...heading.map((field, i) => ({
						expr: col(seekAlias, columnOf(field)),
						alias: `c${i + 2}`
					}))
				],
				{ kind: "table", table, alias: seekAlias },
				and(
					mapNonEmpty(u.stored.fields, (field, j) =>
						eq(col(seekAlias, columnOf(field)), col(regionAlias, `c${j + 1}`))
					)
				)
			)
			/** The tuple ids of the stored rows at the units that no row of the definition there agrees with at every
			 * field, each once. */
			const stale = select(
				distinctCore(
					[{ expr: col(atAlias, "c1"), alias: undefined }],
					[
						derived(
							namedQuery(shifted(units.statement, 1), columnsAt(units.heading.length)),
							regionAlias,
							false
						),
						derived(namedQuery(seek, columnsAt(heading.length + 1)), atAlias, true)
					],
					notExists(
						simpleSelect(
							[],
							[
								derived(
									namedQuery(shifted(rows.statement, unitNames + 2), columnsAt(heading.length)),
									foundAlias,
									false
								)
							],
							and(
								mapNonEmpty(heading, (_, i) =>
									eq(col(atAlias, `c${i + 2}`), col(foundAlias, `c${i + 1}`))
								)
							)
						)
					)
				)
			)
			const removed = removal(stale)
			return {
				by: requester,
				body: {
					declare: removed.declare,
					body: [...removed.body, inserting(headed(rows.statement, reads), heading)]
				}
			}
		}
		/** A delta form's requester: its reads are a probe's, led by no unit, each a lookup by the columns bound before it. */
		const deltaRequester: Requester = {
			justification,
			unit: undefined,
			references: u.stored.references,
			display
		}
		/**
		 * A checked form's removal of the facts a write withdraws (analysis/theory/upkeep.ts CheckedLoss), each lost
		 * rule's row a fact of S's heading, S's row at each found by a lookup of its own by every field, a step PostgreSQL
		 * reads LATERAL once per fact, read apart as every step is (lower/conservative/step fencedRead: OFFSET 0, never
		 * pulled up into a join it could plan as a hash of S whole), and the rows deleted by their tuple ids, each by a
		 * TID scan of its one row (`removal`); its names, the facts r<l+2>, S's row at one r<l+3>, the lookup r<l+4>:
		 *
		 *   FOR __stale IN SELECT DISTINCT r4.c1 FROM (<the facts lost>) AS r2 (c1, …),
		 *       LATERAL (SELECT r3.ctid AS c1 FROM <S> AS r3 WHERE r3.<f1> = r2.c1 AND … OFFSET 0) AS r4 (c1)
		 *     LOOP DELETE FROM <S> AS r1 WHERE r1.ctid = __stale; END LOOP
		 *
		 * So S is read once per lost fact by its key, which leads the fields, whatever PostgreSQL estimates of the facts.
		 */
		const checkedBody = (form: CheckedLoss): Asked => {
			const lost = loweredJudged(
				b,
				catalog,
				(root) => requestsOf(b, deltaRequester, root),
				form.query,
				b.columns,
				label,
				u.loc,
				deltas,
				"units"
			)
			appendAll(requests, lost.requests)
			const fact = headingOf(lost)
			const names = lastNumbered(lost.statement)
			const lostAlias = `r${names + 2}`
			const rowAlias = `r${names + 3}`
			const atAlias = `r${names + 4}`
			const rowAt = fencedRead(
				[{ expr: col(rowAlias, "ctid"), alias: "c1" }],
				{ kind: "table", table, alias: rowAlias },
				and(
					mapNonEmpty(fact, (field, i) =>
						eq(col(rowAlias, columnOf(field)), col(lostAlias, `c${i + 1}`))
					)
				)
			)
			/** The tuple ids of S's rows at the facts lost, each once: two candidates of one fact find one row. */
			const rows = select(
				distinctCore(
					[{ expr: col(atAlias, "c1"), alias: undefined }],
					[
						derived(
							namedQuery(shifted(lost.statement, 1), columnsAt(fact.length)),
							lostAlias,
							false
						),
						derived(rowAt, atAlias, true)
					],
					undefined
				)
			)
			return { by: deltaRequester, body: removal(rows) }
		}
		/**
		 * The call of the upkeep's `part` (identity.storedUpkeep) over `asked`'s statements, in their order, its reads the
		 * deltas they call the readers of (DeltaReads readBy): run where one of those holds a row, so a write that touches
		 * none of them runs, compiles and plans none of the part. A statement of the judge that reads no delta reads the
		 * store whole, an internal defect.
		 */
		const partCall = (part: UpkeepPart, asked: Asked): JudgedCall => {
			const [first, ...rest] = reads.readBy(asked.body.body)
			if (first === undefined) {
				defect(
					`the ${part} part of the upkeep of stored relation ${u.relation}, at least one statement over a delta`
				)
			}
			return {
				named: identity.storedUpkeep(u.relation, part),
				reads: [first, ...rest],
				by: asked.by,
				body: asked.body
			}
		}
		/**
		 * A delta form's calls, the gain's alone where its loss is closed (ClosedLoss): the facts a write withdraws, read from the sides it removed (and a negated holder's it
		 * added), then the facts it gains, read from the sides it added (and a negated holder's it removed), each run where
		 * its own sides hold a row. One call of both ran the removal's statements wherever the gain's ran (`partBody`).
		 * The gain follows the removal: a fact the write changed at one key of S is one removed and another inserted
		 * there, the insert a conflict on S's key while the removed fact stands.
		 */
		const deltaCalls = (form: DeltaForm): NonEmptyReadonlyArray<JudgedCall> => {
			const gained = judgedStatement(
				b,
				catalog,
				(root) => requestsOf(b, deltaRequester, root),
				form.gained,
				b.columns,
				label,
				u.loc,
				deltas,
				reads,
				"units"
			)
			appendAll(requests, gained.requests)
			/** The removal's call, before the gain's; none for a closed loss, whose rows no write removes (ClosedLoss). */
			const lost = ((loss): ReadonlyArray<JudgedCall> => {
				switch (loss.kind) {
					case "checked":
						return [partCall("lost", checkedBody(loss))]
					case "unit":
						return [partCall("lost", unitBody(loss))]
					case "closed":
						return []
				}
			})(form.lost)
			return appendNonEmpty(
				lost,
				partCall("gained", {
					by: deltaRequester,
					body: { declare: [], body: [inserting(gained.statement, headingOf(gained))] }
				})
			)
		}
		const calls = ((form): NonEmptyReadonlyArray<JudgedCall> => {
			switch (form.kind) {
				case "unit":
					return [partCall("units", unitBody(form))]
				case "delta":
					return deltaCalls(form)
			}
		})(u.form)
		return {
			reasons: [enforcement(`derived relation ${u.relation}`)],
			relations: [...new Set([...u.reads.map((r) => r.relation), ...u.stored.references])],
			order: u.relation,
			writes: tableOf(u.relation)?.sides.map((s) => s.delta) ?? [],
			calls
		}
	}
	/**
	 * The table of `name`, an ordinary or a stored derived relation `rule`'s law reads, none for any other: whether its
	 * writes break the rule or a sibling's cover spares them (RuleTrigger `tables`, `covered`), its rows are rows the
	 * check over every row reads, so the check is the same whatever the probes read.
	 */
	const readTable = (rule: RuleTrigger, name: string): TheoryTable | undefined => {
		const relation = b.model.theory.relations[name]
		return rule.law.reads.has(name) &&
			(relation?.kind === "relation" || relation?.kind === "stored")
			? relation
			: undefined
	}
	/**
	 * A Delta node of a rule's check over every row (`everyRowCheck`), as the transaction that writes every row into an
	 * installation that holds none leaves it: the added side of a table the rule reads, every row of its relation's own
	 * table, each field of its heading in its column; the removed side, nothing.
	 */
	const everyRow =
		(rule: RuleTrigger) =>
		(name: string, side: DeltaSide): DeltaRelation | undefined => {
			const relation = readTable(rule, name)
			if (relation === undefined || side === "met") {
				return undefined
			}
			const table = b.names.relation(name)
			return side === "removed"
				? { kind: "empty" }
				: {
						kind: "table",
						table: objectName(table.schema, table.name),
						columns: relation.heading.map((f) => ({ field: f.name, column: f.column }))
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
				(root) => requestsOf(b, ruleRequester(rule), root),
				query,
				b.columns,
				label,
				rule.law.loc,
				everyRow(rule),
				new DeltaReads(b, []),
				"every"
			)
		const compiled = lowered(
			r.kind === "whole"
				? r.everyRow
				: everyRowProbe(r, (name) => readTable(rule, name) !== undefined, rule.law.loc)
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
	/**
	 * Phase A's blocks, each stored relation's upkeep, each in its stratum: 0 where the upkeep reads no stored relation,
	 * else one past the stratum of each stored relation it reads, a holder or one it reads by reference (ir/unit.ts
	 * StoredUnit `references`), which the theory admits before it, a level below (analysis/theory/theory.ts `stored`), so
	 * its upkeep runs after theirs and reads their tables as this COMMIT leaves them, at the units their upkeeps' writes
	 * changed. A definition reads only the levels below its own, so no stratum waits on itself.
	 */
	const stratumOf = new Map<string, number>()
	const upkept = b.model.theory.upkeeps.map((u) => {
		const below = [...u.reads.map((r) => r.relation), ...u.stored.references].flatMap(
			(relation) => {
				const at = stratumOf.get(relation)
				return at === undefined ? [] : [at + 1]
			}
		)
		const stratum = below.reduce((most, at) => Math.max(most, at), 0)
		stratumOf.set(u.relation, stratum)
		return { stratum, block: upkeepBlock(u) }
	})
	/**
	 * The judge's borrows (core/certificate.ts Borrow `judge`): each unit a stored relation is kept under (ir/unit.ts
	 * StoredUnit `declared`), exclusively, at the key of every row the transaction wrote to a holder of it, an ordinary
	 * relation of that unit, on each side the judge captures of it (KeySite `delta`), each holder once however many
	 * stored relations it holds: a write of a holder no side of which is captured runs no upkeep. A stored relation
	 * another reads (`stratumOf`) changes only at the units its own holders' rows name, which the same unit's borrow
	 * holds, so no stored relation's side is a key site.
	 */
	const judgeBorrows = [
		...new Map(
			b.model.theory.upkeeps.flatMap((u) =>
				u.reads.flatMap((r) => {
					if (
						b.model.theory.relations[r.relation]?.kind === "stored" ||
						tableOf(r.relation) === undefined
					) {
						return []
					}
					const member = b.owned.unitOf.get(r.relation)
					if (member?.unit !== u.stored.declared.unit) {
						defect(
							`${r.relation}, a holder of stored relation ${u.relation}, sits in its unit ${u.stored.declared.unit}`
						)
					}
					return [[r.relation, member] as const]
				})
			)
		).values()
	]
		.toSorted((x, y) => compareStrings(x.relation, y.relation))
		.map((member): JudgeBorrow => ({
			lock: { kind: "unit", unit: member.unit },
			mode: "exclusive",
			at: "judge",
			keys: [{ kind: "delta", relation: member.relation }],
			fields: member.fields
		}))
	/**
	 * The judge's borrow statement, the first of phase A, after the sides of news are netted, where any stored relation
	 * has a captured holder: every lock of its borrows (`judgeBorrows`), each at the key of each row of each side of the
	 * holder its site names, that side read where the written set names it, taken by the borrow function in the order
	 * of the locks' ids (write/borrow/statement.ts borrowQuery), its value read whole:
	 *
	 *   PERFORM r<n>.c<m> FROM (SELECT <schema>.__borrow(pg_catalog.array_agg(…), …)::text AS c<m>, … FROM (…
	 *     SELECT <the lock id of the unit at the row's key> AS c1, true AS c2 FROM <a holder's side> AS r<k>
	 *       WHERE __written @> '{<the side's delta>}' UNION ALL …) GROUP BY …) AS r<n>
	 *
	 * So no upkeep reads a stored relation's definition at a unit, or writes its rows there, while another transaction
	 * that wrote the unit's holders is open: every writer's judge takes its units here before its upkeeps read anything,
	 * at any level and from any session (a served write, direct SQL, a migration's data step), and at READ COMMITTED
	 * each statement after this one reads at a snapshot taken once the transaction holds its units, after every earlier
	 * holder's commit. Two READ COMMITTED writers of one unit's holders, each keeping it at a snapshot that missed the
	 * other's rows, left the stored relation there the union of two partial definitions, a join's row lost, a negation's
	 * row kept and a count short (test/pg/isolation/upkeep).
	 *
	 * One statement, never one for each upkeep part: a transaction takes every lock of its judge at once, in id order, so
	 * no two judges wait on each other in a cycle, which parts of two units run in turn would close where another
	 * transaction's parts take the same units in the other order. A side the written set does not name reads nothing,
	 * its condition no column of its rows, a filter PostgreSQL evaluates once before it reads the side: a session stands
	 * up the sides its own writes need, so another holder's may not stand. A lock kind's rank is its place among the
	 * judge's kinds by name (analysis/isolation/borrows.ts lockName), the installation's lock order (core/certificate.ts
	 * LockOrder): no change member borrows in flight, so no edge constrains it, and the least by name is lockOrder's.
	 */
	const judgeBorrow = ((): ReadonlyArray<PlStatement> => {
		const names = new NameSupply(freshNames)
		const kinds = [...new Set(judgeBorrows.map((j) => lockName(j.lock)))].toSorted(compareStrings)
		const rankOf = (lock: BorrowLock): Expr => lit.int(kinds.indexOf(lockName(lock)), types.integer)
		const arms = judgeBorrows.flatMap((j) => {
			const { lock } = j
			return j.keys.flatMap((site): ReadonlyArray<BorrowArm> => {
				const t = defined(tableOf(site.relation), `the judged table of holder ${site.relation}`)
				/** A field of the holder in its delta: the column of its place in the heading (deltas.ts deltaRelation). */
				const placed = (field: string) => {
					const at = t.relation.heading.findIndex((f) => f.name === field)
					return {
						column: `c${at + 1}`,
						type: defined(t.relation.heading[at], `the unit field ${field} of ${site.relation}`)
							.type
					}
				}
				return t.sides.map((s): BorrowArm => {
					const alias = names.relation({ kind: "internal", purpose: "a holder's written rows" })
					return {
						kind: "unit",
						unit: lock.unit,
						exclusive: true,
						keys: {
							from: [{ kind: "cte", name: s.delta.name, alias }],
							where: wrote(s.delta.name),
							fields: mapNonEmpty(j.fields, (field) => {
								const { column, type } = placed(field)
								return { expr: col(alias, column), type }
							})
						}
					}
				})
			})
		})
		if (!isNonEmpty(arms)) {
			return []
		}
		const taken = headed(borrowQuery(b.schema, arms, rankOf, names), reads)
		const columns = selectColumns(taken)
		const [borrowed] = columns
		const alias = names.relation({ kind: "internal", purpose: "the judge's borrow" })
		return [
			{
				kind: "perform",
				query: {
					body: core(
						[{ expr: col(alias, defined(borrowed, "the borrow's column")), alias: undefined }],
						[derived(namedQuery(taken, columns), alias, false)],
						undefined
					),
					orderBy: [],
					limit: undefined,
					offset: undefined
				}
			}
		]
	})()
	/** Phase A's blocks stratum by stratum, and phase B's, every rule's blocks in trigger-name order, each stratum and
	 * the rules in parts of their own (`partsOf`), so every upkeep reads each stored relation below it, and every rule each
	 * stored relation, as the transaction leaves it: a stored relation read by reference among them, whose upkeep at a
	 * founding write the upkeeps above it read the rows of. */
	const upkeptStrata = [...Map.groupBy(upkept, (x) => x.stratum)]
		.toSorted(([x], [y]) => compareNumbers(x, y))
		.map(([stratum, blocks]) => ({ stratum, blocks: blocks.map((x) => x.block) }))
	const ruled = b.model.rules.flatMap(judgedBy).toSorted((x, y) => compareStrings(x.order, y.order))
	/** Each judged table's side by its delta's name: the side a part records the delta's rows of. */
	const sideOf = new Map(
		tables.flatMap((t) => t.sides.map((s) => [s.delta.name, { t, s }] as const))
	)
	const deltas = tables.flatMap((t) => t.sides.map((s) => s.delta.name)).toSorted(compareStrings)
	const reasons: ReadonlyArray<PhysicalReason> = [
		enforcement(`the rules over queries of schema ${b.owned.name}`),
		...b.model.rules.map((rule) => ({ kind: "law" as const, law: rule.law.id }))
	]
	/** The tables of the stored relations among `names`, each once. */
	const tablesNamed = (names: ReadonlyArray<string>) =>
		[...new Set(names)].flatMap((name) => (b.model.relations.has(name) ? [b.table(name)] : []))
	const tablesOf = (rules: ReadonlyArray<RuleTrigger>) =>
		tablesNamed(rules.flatMap((rule) => [...rule.law.reads]))
	const readers = addReaders(b, reads, reasons)
	/**
	 * Each call's function of block `j` (`partBody`, identity.ruleJudgeBlock or identity.storedUpkeep): no argument, the
	 * call's statements its body, SECURITY DEFINER under the closed search path as every function of the judge, its
	 * EXECUTE revoked from PUBLIC, so only the judge's definer, which its part runs as, calls it. It reads its block's
	 * tables and its deltas through their readers.
	 */
	const callNode = (
		j: Judged,
		call: JudgedCall
	): { readonly fn: ObjectName; readonly node: Node<"validate"> } => {
		const fn = objectName(b.schema, b.name(call.named))
		const running: PlFunction = {
			kind: "createFunction",
			advice: undefined,
			language: "plpgsql",
			name: fn,
			params: [],
			returns: "void",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			body: call.body
		}
		const ddl: readonly [PlFunction, Revoke] = [running, revokeOf(fn, [])]
		appendAll(requests, programRequests(b, targets, call.by, seekProgram([running])))
		const node = b.add(
			{
				kind: "lawFunction",
				ident: b.qualified("function", call.named),
				ddl,
				reasons: j.reasons,
				phase: "validate"
			},
			[
				...tablesNamed(j.relations),
				...[...readersCalled(call.body.body)].flatMap((name) => {
					const reader = readers.get(name)
					return reader === undefined ? [] : [reader]
				})
			]
		)
		return { fn, node }
	}
	const upkeepParts = upkeptStrata.map(({ stratum, blocks }) =>
		partsOf(blocks, { kind: "upkeep", stratum })
	)
	const parts = [...upkeepParts.flat(), ...partsOf(ruled, { kind: "rules" })].map((part) => {
		const relation = defined(
			sideOf.get(headNonEmpty(part.deltas).name),
			"a part's first delta, a judged table's side"
		).t.relation.name
		const calls = new Map(
			part.blocks.flatMap((j) => j.calls.map((call) => [call, callNode(j, call)] as const))
		)
		const named = identity.ruleJudgePart(
			relation,
			sentinelIdent,
			mapNonEmpty(part.deltas, (d) => d.ident),
			part.pass
		)
		const fn = objectName(b.schema, b.name(named))
		const ddl: readonly [PlFunction, Revoke] = [
			{
				kind: "createFunction",
				advice: undefined,
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
					(call) => defined(calls.get(call), "a call of a block of the part").fn
				)
			},
			revokeOf(fn, [namesType])
		]
		const node = b.add(
			{
				kind: "lawFunction",
				ident: b.qualified("function", named),
				ddl,
				reasons: distinctReasons(part.blocks.flatMap((j) => j.reasons)),
				phase: "validate"
			},
			[
				...tablesNamed(part.blocks.flatMap((j) => j.relations)),
				...[...calls.values()].map((call) => call.node)
			]
		)
		return { part, fn, node }
	})
	/**
	 * The judge's run, in two passes: the transaction's written set read from the sentinel's row (`marked`), and each
	 * side of news it wrote that a rule reads netted, once (`nettingsOf`); phase A,
	 * stratum by stratum (`stratumOf`), each upkeep part of the stratum run where the transaction wrote one of its deltas,
	 * with the set, whose writes of a stored relation's table fire that table's captures where a rule or an upkeep a
	 * stratum up reads it, which mark the standing row, and the set read again after each stratum, the deltas its upkeeps
	 * wrote in it, so the next stratum's parts run where the stored relations below them changed; the row deleted only
	 * after phase A, so a later statement arms the judge again and marks its deltas into a new set; phase B, each rule
	 * part run likewise, each emptying its deltas; and last each delta only phase A read, emptied. It reads no catalog and
	 * no delta the transaction did not write: a session holds a delta of every relation any of its transactions wrote,
	 * none of whose rows outlives its COMMIT. None where the installation holds no delta, nor any rule over a query.
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
	const readWritten: PlStatement = {
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
	}
	const functionOf = new Map(parts.map(({ part, fn }) => [part, fn] as const))
	/** Each of `run` run where the transaction wrote one of its deltas. */
	const partsRun = (run: ReadonlyArray<JudgePart>): ReadonlyArray<PlStatement> =>
		run.map((part): PlStatement => ({
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
					body: [performed(defined(functionOf.get(part), "a part's function"), [written])]
				}
			],
			else: []
		}))
	const upkeep = upkeepParts.flatMap((stratum) => [...partsRun(stratum), readWritten])
	/** The deltas phase A reads that no rule part reads, which no part empties. */
	const ruledDeltas = new Set(
		parts.flatMap(({ part }) => (part.pass.kind === "rules" ? part.deltas.map((d) => d.name) : []))
	)
	/**
	 * The sides of news the judge nets before phase A (`nettingsOf`): each a rule reads, and each a delta form's gained
	 * rules read (analysis/theory/upkeep.ts), which read the images themselves as the transaction leaves them, so an
	 * image it inserted and deleted again, or wrote twice, is read as the one row that stands, or none.
	 */
	const nettedDeltas = new Set([
		...ruledDeltas,
		...b.model.theory.upkeeps.flatMap((u) =>
			u.form.kind === "delta"
				? u.reads.flatMap(
						(r) =>
							tableOf(r.relation)?.sides.flatMap((s) =>
								s.side === "added" ? [s.delta.name] : []
							) ?? []
					)
				: []
		)
	])
	/** The stored relations, whose tables their upkeeps alone write. */
	const storedNames = new Set(b.model.theory.upkeeps.map((u) => u.relation))
	const upkeptOnly = [
		...new Map(
			parts.flatMap(({ part }) =>
				part.pass.kind === "upkeep"
					? part.deltas.filter((d) => !ruledDeltas.has(d.name)).map((d) => [d.name, d] as const)
					: []
			)
		).values()
	].toSorted((x, y) => compareStrings(x.name, y.name))
	const judging: ReadonlyArray<PlStatement> = !isNonEmpty(deltas)
		? [consumed]
		: [
				readWritten,
				...nettingsOf(tables, storedNames, nettedDeltas),
				...judgeBorrow,
				...upkeep,
				consumed,
				...partsRun(parts.flatMap(({ part }) => (part.pass.kind === "rules" ? [part] : []))),
				...upkeptOnly.map(emptiedWhereWritten)
			]
	const judgeDdl: readonly [PlFunction, Revoke] = [
		{
			kind: "createFunction",
			advice: undefined,
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
		[
			...tablesOf(b.model.rules),
			...parts.map((p) => p.node),
			...(isNonEmpty(judgeBorrow) ? [b.borrow] : []),
			...[...readersCalled(judgeBorrow)].flatMap((name) => {
				const reader = readers.get(name)
				return reader === undefined ? [] : [reader]
			})
		]
	)
	const standings = standingsOf(b, [...upkept.map((x) => x.block), ...ruled], tables)
	const standUps = addStandUps(b, tables, standings, judge, sentinel, judgeNode, reads)
	const events = new Set<TransitionEvent>()
	for (const t of tables) {
		addCapture(
			b,
			t,
			judge,
			sentinel,
			judgeNode,
			events,
			defined(standings.of.get(t.relation.name), "a judged table's standing").marker,
			defined(standUps.get(t.relation.name), "a judged table's stand-up").name
		)
	}
	for (const event of events) {
		b.name(identity.captureTrigger(event))
	}
	return { requests, checks, standUps }
}

/** A session's marker of a set of the judge's tables (identity.ruleStood: a closure's, `Closure`, or a table's,
 * `TableStanding`), as a site makes or requires it (`standing`): a table of no column, which stores no row. */
const markerStood = (marker: Identity<"ruleStood">): Stood => ({
	name: identifierOf(marker),
	create: [
		{ kind: "createSessionTable", name: identifierOf(marker), columns: [], storage: "inline" }
	]
})

/** The function of the judge that makes, as its definer, the session tables `body` makes: of no argument, SECURITY
 * DEFINER under the closed search path, its EXECUTE revoked from PUBLIC. */
const makerOf = (
	fn: ObjectName,
	body: NonEmptyReadonlyArray<PlStatement>
): readonly [PlFunction, Revoke] => [
	{
		kind: "createFunction",
		advice: undefined,
		language: "plpgsql",
		name: fn,
		params: [],
		returns: "void",
		volatility: "VOLATILE",
		parallel: "UNSAFE",
		security: "DEFINER",
		body: { declare: [{ name: stoodName, type: namesType }], body }
	},
	revokeOf(fn, [])
]

/**
 * What a maker of the judge's session tables makes (`Making`): `first`, then the deltas it alone needs and their indexes,
 * each where the session holds none, refusing a table of their names some other role made (`standing`); then each share
 * it calls and each of `calls`; then `marker`, last.
 */
const makingBody = (
	making: Making,
	first: ReadonlyArray<Stood>,
	shareMakers: ReadonlyMap<string, { readonly fn: ObjectName }>,
	calls: ReadonlyArray<ObjectName>,
	marker: Identity<"ruleStood">,
	reads: DeltaReads
): NonEmptyReadonlyArray<PlStatement> => {
	const stood = [
		...first,
		...making.made.map(deltaStood),
		...making.made.flatMap((d) => indexesStood(d, reads))
	]
	return concatNonEmpty(
		[
			...(isNonEmpty(stood) ? standing(stood, { kind: "made" }) : []),
			...making.shares.map((share) =>
				performed(defined(shareMakers.get(share.ident.identifier), "a share's maker").fn, [])
			),
			...calls.map((fn) => performed(fn, []))
		],
		standing([markerStood(marker)], { kind: "made" })
	)
}

/**
 * The stand-up of each judged table (identity.ruleStandUp), by its relation's name: a function of no argument, SECURITY
 * DEFINER under the closed search path as every function of the judge, its EXECUTE revoked from PUBLIC and granted to
 * each role that writes the table (physical/ddl/roles.ts addWorlds), which makes, as the judge's definer, every session
 * table a write of the table needs (`TableStanding`): the session's sentinel with its trigger and the table's loose
 * deltas it alone needs, each where the session holds none, refusing a table of their names some other role made
 * (`standing`); then each share of the loose deltas other makers need too, by its maker (identity.ruleShare), and each
 * closure its blocks reach, by its maker (identity.ruleClosure), which makes the closure's deltas, by itself and by its
 * shares, and its marker alike; then the table's marker. A session calls it once, before its first write of the table: a
 * served write's session in its stand-up (runtime/write/flight.ts StandUp), a migration's Structure before its data
 * steps (deploy/diff/diff.ts checkedAtOnce). So no capture or part makes a table inside a write's transaction, a catalog
 * change its session reads at its next transaction, which made every plan over the tables again: metis's assign planned
 * its second call's 70 statements in functions again for it.
 *
 *   __stood := <which of the tables stand (sessionTablesStanding)>; <a foreign one refused>
 *   IF NOT __stood @> '{<sentinel>}' THEN CREATE TEMPORARY TABLE pg_temp.<sentinel> ...; CREATE CONSTRAINT TRIGGER ... END IF
 *   IF NOT __stood @> '{<delta>}' THEN CREATE TEMPORARY TABLE pg_temp.<delta> ... END IF ...
 *   IF NOT __stood @> '{<index>}' THEN CREATE INDEX <index> ON pg_temp.<delta> (<column>) END IF ...
 *   PERFORM <the maker of each share>() ...
 *   PERFORM <the maker of each closure>() ...
 *   __stood := <whether the marker stands>; <a foreign one refused>
 *   IF NOT __stood @> '{<marker>}' THEN CREATE TEMPORARY TABLE pg_temp.<marker> () END IF
 *
 * A closure's maker is the same function of the closure's deltas, its marker last, and a share's of the share's deltas
 * alone; neither makes the sentinel: only a table's stand-up calls a closure's maker, and only a stand-up or a closure's
 * maker a share's, as the definer, granted to no role.
 */
const addStandUps = (
	b: InstallBuilder,
	tables: ReadonlyArray<JudgedTable>,
	standings: Standings,
	judge: ObjectName,
	sentinel: string,
	judgeNode: Node<"validate">,
	reads: DeltaReads
): ReadonlyMap<string, JudgeStandUp> => {
	/** The tables whose deltas stand among `deltas`, and the reasons of the rules and upkeeps that read them. */
	const heldBy = (deltas: ReadonlyArray<SessionDelta>) => {
		const names = new Set(deltas.map((d) => d.name))
		const held = tables.filter((t) => t.sides.some((s) => names.has(s.delta.name)))
		return {
			nodes: held.map((t) => tableNode(b, t.relation)),
			reasons: distinctReasons(
				held.flatMap((t) => [
					...t.rules.map(({ rule }) => ({ kind: "law" as const, law: rule.law.id })),
					...t.upkeeps.map((u) => enforcement(`derived relation ${u.relation}`))
				])
			)
		}
	}
	const shareMakers = new Map(
		standings.shares.map((share) => {
			const fn = objectName(b.schema, b.name(share.ident))
			const held = heldBy(share.deltas)
			const node = b.add(
				{
					kind: "lawFunction",
					ident: b.qualified("function", share.ident),
					ddl: makerOf(
						fn,
						standing(
							[
								...mapNonEmpty(share.deltas, deltaStood),
								...share.deltas.flatMap((d) => indexesStood(d, reads))
							],
							{ kind: "made" }
						)
					),
					reasons: held.reasons,
					phase: "validate"
				},
				[judgeNode, ...held.nodes]
			)
			return [share.ident.identifier, { fn, node }] as const
		})
	)
	const sharedNodes = (making: Making): ReadonlyArray<Node<"validate">> =>
		making.shares.map(
			(share) => defined(shareMakers.get(share.ident.identifier), "a share's maker").node
		)
	const closureMakers = new Map(
		standings.closures.map((closure) => {
			const fn = objectName(b.schema, b.name(closure.ident))
			const held = heldBy(closure.deltas)
			const node = b.add(
				{
					kind: "lawFunction",
					ident: b.qualified("function", closure.ident),
					ddl: makerOf(fn, makingBody(closure.making, [], shareMakers, [], closure.marker, reads)),
					reasons: held.reasons,
					phase: "validate"
				},
				[judgeNode, ...held.nodes, ...sharedNodes(closure.making)]
			)
			return [closure.ident.identifier, { fn, node }] as const
		})
	)
	return new Map(
		tables.map((t) => {
			const named = identity.ruleStandUp(t.relation.name)
			const fn = objectName(b.schema, b.name(named))
			const own = defined(standings.of.get(t.relation.name), "a judged table's standing")
			const called = own.closures.map((closure) =>
				defined(closureMakers.get(closure.ident.identifier), "a closure's maker")
			)
			const node = b.add(
				{
					kind: "lawFunction",
					ident: b.qualified("function", named),
					ddl: makerOf(
						fn,
						makingBody(
							own.making,
							[sentinelStood(sentinel, judge)],
							shareMakers,
							called.map((c) => c.fn),
							own.marker,
							reads
						)
					),
					reasons: t.rules.map(({ rule }) => ({ kind: "law" as const, law: rule.law.id })),
					phase: "validate"
				},
				[
					judgeNode,
					tableNode(b, t.relation),
					...sharedNodes(own.making),
					...called.map((c) => c.node)
				]
			)
			return [t.relation.name, { node, name: { ...fn, args: [] } }] as const
		})
	)
}

/**
 * A table's capture (`addRules`): its function, which requires the session's sentinel and the table's marker (`standing`,
 * `required`, TableStanding), writes the statement's rows into the delta of each side its event reads and arms the
 * sentinel, and its transition triggers, one per event, each recorded in `events`. A statement in a session that has
 * not stood the table up (`standUp`, addStandUps) is refused, never stands anything up itself.
 *
 * The marker stands as the definer's own only where the one site that makes the table's tables made them all, each the
 * definer's own, and refused one some other role made: no role but a table's owner, the definer, drops, alters or
 * renames it, the session's temporary schema being the bootstrap superuser's (namespace.c InitTempTableNamespace), and
 * DISCARD TEMP drops every one of them at once, the marker with them. So the capture requires two tables, whatever
 * its table's writes reach, where it required each of them by name, every event apart: qti-pie's Node's capture named
 * 499 deltas, 574 KB of its 588. The one statement it refuses that it did not is a write of a table in a session that
 * has not run the table's own stand-up, where other stand-ups made all its tables: refused as unstood (55Z03), as is a
 * write where some other role made one of them, which the stand-up refuses as foreign (42501). No session grizzle runs
 * writes such a table: a served write stands up every judged table it writes (write/program/stand-up.ts), a migration's
 * Structure calls every stand-up before its data steps (deploy/diff/diff.ts standUps), and the judge's upkeeps write
 * only stored relations, whose marker is their closure's, made by the stand-up of each table whose blocks reach it.
 */
const addCapture = (
	b: InstallBuilder,
	t: JudgedTable,
	judge: ObjectName,
	sentinel: string,
	judgeNode: Node<"validate">,
	events: Set<TransitionEvent>,
	marker: Identity<"ruleStood">,
	standUp: ObjectName
): void => {
	const relation = t.relation
	const named = identity.ruleCapture(relation.name)
	const fn = objectName(b.schema, b.name(named))
	const side = (s: ProbeSide): JudgedSide | undefined => t.sides.find((x) => x.side === s)
	const news = side("added")
	const olds = side("removed")
	/** The sentinel and the table's marker, required in one read of the catalog (`standing`). */
	const required = standing([sentinelStood(sentinel, judge), markerStood(marker)], {
		kind: "required",
		relation: b.names.relation(relation.name),
		standUp
	})
	/**
	 * The tables required (`required`), then the writes, each of which marks the deltas it writes in the standing row
	 * (`marked`), then the row written where none stands, naming `deltas` that hold a row (`arming`): last, so the judge
	 * it fires reads this capture's rows.
	 */
	const armed = (
		deltas: NonEmptyReadonlyArray<SessionDelta>,
		writes: ReadonlyArray<PlStatement>
	): ReadonlyArray<PlStatement> => [...required, ...writes, ...arming(sentinel, deltas)]
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
	/** The rows a DELETE removed counted out of the side of news: a removal is counted only once the delta holds a row
	 * (deltas.ts captured), so a transaction that wrote no image of the relation cancels none. */
	const removedFromNews: ReadonlyArray<PlStatement> =
		news === undefined ? [] : [captured(relation, news, transitionTables.olds, undefined)]
	/**
	 * `body` where the statement wrote a row, its transition table `rows` holding one: a statement that wrote none
	 * captures nothing, requires no table and arms no judge, so a part of a write whose input held no fact, or whose
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
				: [
						{
							event: "delete" as const,
							body: whereRowed(transitionTables.olds, [...required, ...removedFromNews])
						}
					]
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
	const reasons: ReadonlyArray<PhysicalReason> = [
		...t.rules.map(({ rule }) => ({ kind: "law" as const, law: rule.law.id })),
		...t.upkeeps.map((u) => enforcement(`derived relation ${u.relation}`))
	]
	const ddl: readonly [PlFunction, Revoke] = [
		{
			kind: "createFunction",
			advice: undefined,
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
		[judgeNode, tableNode(b, relation)]
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
			[fnNode, tableNode(b, relation)]
		)
	}
}
