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
import { noClock } from "#compiler/ir/clock.ts"
import { servedQuery } from "#compiler/ir/derived.ts"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import type { LawIndexKey, LawIndexRequest, TheoryTable } from "#compiler/ir/law.ts"
import type { AccessIndexRequest, IndexRequest, PhysicalReason } from "#compiler/ir/products.ts"
import type { DeltaSide } from "#compiler/ir/rel.ts"
import type { Unit } from "#compiler/ir/unit.ts"
import { evidenceCatalog, noViewEvidence } from "#compiler/laws/model/catalog.ts"
import type { LawModel, RuleTable, RuleTrigger } from "#compiler/laws/model/model.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import type { DeltaRelation } from "#compiler/lower/conservative/types.ts"
import { lowerComposed, optimizedInput } from "#compiler/lower/optimize/pipeline.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import {
	captured,
	type Delta,
	deltaArrayType,
	deltaOf,
	deltaRelation,
	deltaRowType,
	deltaRowTypeCreate,
	type DeltaSelection,
	DeltaSelections,
	deltaVariable,
	headed,
	holdsRows,
	type JudgedSide,
	netted,
	revokeOf,
	rowsArray,
	selectionsMade
} from "#compiler/physical/ddl/deltas.ts"
import { unaliased } from "#compiler/physical/derived/definition.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import type {
	CreateTransitionTrigger,
	Delete,
	Expr,
	ObjectName,
	OperandSelect,
	PlBlock,
	PlDeclaration,
	PlFunction,
	PlStatement,
	Revoke,
	Select,
	TransitionEvent,
	TransitionTable
} from "#compiler/sql/ast.ts"
import {
	judgeLogColumns,
	type NameKey,
	nameKey,
	selectColumns,
	transitionTables
} from "#compiler/sql/ast.ts"
import {
	and,
	call,
	col,
	core,
	derived,
	distinctCore,
	eq,
	gt,
	lit,
	notExists,
	objectName,
	or,
	provedCore,
	provedSelect,
	qualifiedCall,
	select,
	simpleSelect,
	types,
	whenExists,
	whenFound
} from "#compiler/sql/build.ts"
import { assignments, ungenerated } from "#compiler/sql/generation.ts"
import { freshNames, NameSupply, namedQuery } from "#compiler/sql/naming.ts"
import { identityHooks, Transform } from "#compiler/sql/transform.ts"
import { type BorrowArm, borrowQuery } from "#compiler/write/borrow/statement.ts"

/**
 * A compiled judged query: its statement, its outputs unaliased, and the names of the columns it delivers in their
 * order. What it reads by index its routine's bound plan states (sql/bind.ts bindRoutine), which the installation asks
 * for (`routineRequests`).
 */
interface Compiled {
	readonly statement: OperandSelect
	readonly heading: ReadonlyArray<string>
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
 * (`judgedStatement`).
 *
 * Navigation makes each row of the probe one chain of steps from its region, each a lookup of one relation by the columns the steps
 * before it bound, so no estimate PostgreSQL makes, with statistics or none, turns it into a join of every relation the
 * probe reads, and planning it costs a plan of each step. Its routine's plan binds each step's read by the columns it is
 * bound at (sql/bind.ts), so the indexes requested are exactly those the probe's reads use, and the read of the region
 * asks none, its rows the delta's array.
 */
const compileProbe = (
	b: InstallBuilder,
	catalog: ReturnType<typeof evidenceCatalog>,
	rule: RuleTrigger,
	relation: TheoryTable,
	query: InferredQuery,
	deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined,
	selections: DeltaSelections
): Compiled =>
	judgedStatement(
		b,
		catalog,
		query,
		b.columns,
		`rule ${rule.law.named.display} on ${relation.name}`,
		relation.loc,
		deltas,
		selections,
		"units"
	)

/**
 * A query the judge reads, a probe over its region or a unit-scoped rule's violation over its units: navigated wherever
 * it joins (analysis/theory/navigate.ts navigateQuery), so each relation a join of it reads, a derived relation's
 * definition included and a negated one's too, is a step read by the columns its region, its unit or the steps before
 * it bound, never a join PostgreSQL may plan as a product it filters afterwards, each import its unfolding multiplies
 * read whole (`perStatement`); then checked as a region read (check/checker.ts QueryRead `region`) and lowered by the
 * optimized pipeline under the transaction's evidence, each Delta node read from the relation `deltas` names
 * (RegionLowering), to one main statement of no parameter, its outputs unaliased, each of its reads of a delta a read
 * of the delta's CTE, which `judgedStatement` and an upkeep's statements read from the arrays of their selections
 * (deltas.ts headed). It is lowered composed, never printed apart (lower/optimize/pipeline.ts lowerComposed): its
 * reads of a delta name it by a CTE no statement holds, so the statement that reads it from its arrays is its one
 * print. It reads each suffix test of a stored text as the text's suffix key's range (sql/suffix.ts seekingSuffixes,
 * InstallBuilder `texts`), which its routine's binding reads as a range of that key where the suffix is fixed beside
 * the row (sql/bind.ts), and a B-tree on the key serves. Navigation reads the
 * heading of each union it splits in `columns`: the installation's (InstallBuilder `columns`), at the definition a
 * walked copy of it was walked from where the query is a whole rule's violation over its units (WholeRule
 * `definitionOf`).
 */
const loweredJudged = (
	b: InstallBuilder,
	catalog: ReturnType<typeof evidenceCatalog>,
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
	const program = unwrap(
		Result.flatMap(optimizedInput(checked, queryEvidence), (annotated) =>
			lowerComposed(annotated, {
				names: { ...b.names, suffixed: b.texts },
				subject: { kind: "ruleRegion", deltas },
				context: "transaction",
				catalog
			})
		)
	)
	const parts = program.parts
	if (parts.kind !== "one" || parts.delivered.role.kind !== "main") {
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
		heading: main.heading.map((c) => c.name)
	}
}

/**
 * A query the judge reads (`loweredJudged`), each of its reads of a delta read from the array of the selection it reads
 * the delta under, which `selections` records (deltas.ts headed).
 */
const judgedStatement = (
	b: InstallBuilder,
	catalog: ReturnType<typeof evidenceCatalog>,
	query: InferredQuery,
	columns: QueryColumns,
	label: string,
	loc: SourceLoc,
	deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined,
	selections: DeltaSelections,
	extent: RegionExtent
): Compiled => {
	const lowered = loweredJudged(b, catalog, query, columns, label, loc, deltas, extent)
	return { ...lowered, statement: headed(lowered.statement, selections) }
}

/**
 * Who asks a judged read's indexes (`routineRequests`): its justification, a rule's law or a stored relation's enforcement;
 * the unit its reads stand in, a whole rule's or a stored relation's upkeep's, whose key leads each request's first
 * block (`unitLead`), none for a probed rule; the relations it reads by reference, outside its unit, a stored
 * relation's (ir/unit.ts StoredUnit `references`), each read at the keys its unit's rows name; and how a refusal names
 * it.
 */
export interface Requester {
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
 * The blocks of a judged read's request over `relation` by `keys` (ir/law.ts LawIndexRequest): one block of its keys for
 * a probed rule's, which reads rows; for a whole rule's or a unit's upkeep's, first
 * the fields `relation` holds its unit's key in (ir/unit.ts Unit holders) that the read binds, the longest run of them
 * from the first in the unit key's order, then the rest, so an index the request asks for never reads past the unit and
 * none another column leads serves it, and a lookup that binds every one of those fields reads one unit. A read that
 * binds no field of its unit, or of a relation outside it, is one block: every read a judge's plan binds is asked, the
 * one index its advice reads it through (sql/advice.ts). A relation the requester reads by reference
 * stands in no unit of its: its read is a probe's, one block of its keys, at the key its unit's row names.
 */
const unitLead = (
	by: Requester,
	target: TheoryTable,
	keys: NonEmptyReadonlyArray<LawIndexKey>
): LawIndexRequest["blocks"] => {
	const relation = target.name
	const holder = by.references.includes(relation)
		? undefined
		: by.unit?.holders.find((h) => h.relation === relation)
	if (holder === undefined) {
		return [keys]
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
	return isNonEmpty(bound) ? (isNonEmpty(rest) ? [bound, rest] : [bound]) : [keys]
}

/**
 * The requests of a routine's plan (sql/plan.ts planRequests) as its requester asks them (`Requester`): each a law's
 * maintenance request by its read's method, its keys the fields and law columns the plan's read binds, or a text
 * field's suffix key it ranges (ir/law.ts SuffixColumn), led as its requester leads
 * (`unitLead`), so every read the routine makes is asked and nothing else is. A read of a closed relation, which no
 * index serves, asks none.
 * The plan is the routine's bound statements' (sql/bind.ts), the one derivation of what each of its reads binds
 * (physical/install/compile.ts).
 */
export const routineRequests = (
	b: InstallBuilder,
	by: Requester,
	requests: ReadonlyArray<AccessIndexRequest>
): ReadonlyArray<IndexRequest> =>
	requests.flatMap((request): ReadonlyArray<IndexRequest> => {
		const target = b.model.theory.relations[request.relation]
		if (target === undefined || target.kind === "closed") {
			return []
		}
		const keys = request.keys.flatMap((k): ReadonlyArray<LawIndexKey> => {
			if (typeof k.expr !== "string" && "law" in k.expr) {
				return [{ column: { kind: "law", column: k.expr.law }, dir: k.dir, opclass: k.opclass }]
			}
			const name = typeof k.expr === "string" ? k.expr : k.expr.suffix
			const field = target.fields.find((f) => f.name === name)
			if (field === undefined) {
				return []
			}
			const column = { kind: "field", field } as const
			return [
				{
					column: typeof k.expr === "string" ? column : { kind: "suffix", of: column },
					dir: k.dir,
					opclass: k.opclass
				}
			]
		})
		if (!isNonEmpty(keys)) {
			return []
		}
		return [
			{
				relation: target.name,
				blocks: unitLead(by, target, keys),
				method: request.method,
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
	readonly writes: ReadonlyArray<Delta>
	/**
	 * Its functions in the order they run: a rule's side's one; a unit form's one, or a delta form's removal of the facts
	 * a write withdraws, then its insert of those it gains (`upkeepBlock`), which must follow the removal: a fact the
	 * write changed at one key of the stored relation is one removed and another inserted there.
	 */
	readonly calls: NonEmptyReadonlyArray<JudgedCall>
}

/**
 * A function of a block of the judge (`Judged`), identity.ruleJudgeBlock or identity.storedUpkeep: its statements with
 * the requester whose index requests their seeks are (`Asked`), the deltas they read, and the selections of them it
 * takes, one argument each, in their order (deltas.ts DeltaSelections readBy), where one of which holds
 * a row its part calls it (`partBody`).
 */
interface JudgedCall extends Asked {
	readonly named: Identity<"ruleJudgeBlock" | "storedUpkeep">
	readonly reads: NonEmptyReadonlyArray<Delta>
	readonly params: NonEmptyReadonlyArray<DeltaSelection>
}

/**
 * The block of a function of the judge, its variables and its statements, and who asks the indexes its reads go
 * through (Requester): the function's bound plan (sql/bind.ts bindRoutine) gives the requests, one for each bound read
 * of a stored table, so every read the judge's plan makes is asked and nothing else is (`routineRequests`).
 */
interface Asked {
	readonly by: Requester
	readonly body: PlBlock
}

/** The deltas a block's calls read (`Judged`), each once, in their order (deltas.ts Delta `order`). */
const readsOf = (j: Judged): NonEmptyReadonlyArray<Delta> => {
	const [first, ...rest] = [
		...new Map(j.calls.flatMap((c) => c.reads.map((d) => [d.name, d] as const))).values()
	].toSorted((x, y) => compareStrings(x.order, y.order))
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

/** A rule's RAISE, naming the rule's table by literals. */
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
							delta: deltaOf(b, relation, side),
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
 * One borrow of the judge's (core/certificate.ts Borrow `judge`): a unit, exclusively, at the key of each row the
 * transaction wrote to one holder of a stored relation under it (KeySite `delta`), and the holder's fields that hold the
 * unit's key, in its heading's order (schema/own.ts UnitMember).
 */
interface JudgeBorrow extends Borrow {
	readonly lock: Extract<BorrowLock, { readonly kind: "unit" }>
	readonly keys: readonly [Extract<KeySite, { readonly kind: "delta" }>]
	readonly fields: NonEmptyReadonlyArray<string>
}

/** That one of `variables`, arrays of the judge, holds a row (deltas.ts holdsRows). */
const anyHolds = (variables: NonEmptyReadonlyArray<string>): Expr => {
	const [first, ...rest] = mapNonEmpty(variables, (name) => holdsRows({ kind: "plVar", name }))
	return rest.length === 0 ? first : or([first, ...rest])
}

/**
 * A part of the judge (`partsOf`): its pass, `upkeep`, the stored relations' upkeep blocks of one stratum (phase A), or
 * `rules`, the rules' blocks (phase B); its deltas, by name; and its blocks, in the judge's order. Two strata's parts may
 * read the same deltas, a stored relation over a holder beside one over that relation and the same holder, so an upkeep
 * part is named by its stratum too (identity.ruleJudgePart).
 */
interface JudgePart {
	readonly pass: { readonly kind: "upkeep"; readonly stratum: number } | { readonly kind: "rules" }
	readonly deltas: NonEmptyReadonlyArray<Delta>
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
	const byRoot = new Map<string, { readonly deltas: Set<Delta>; readonly blocks: Array<Judged> }>()
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
		const [d0, ...ds] = [...part.deltas].toSorted((x, y) => compareStrings(x.order, y.order))
		const [b0, ...bs] = part.blocks
		return d0 === undefined || b0 === undefined
			? []
			: [{ pass, deltas: [d0, ...ds], blocks: [b0, ...bs] }]
	})
}

/**
 * A part's body, run where the transaction wrote a row into one of its deltas, each an argument of the part, its own
 * variable, the empty array where the transaction wrote none of its rows or netted them all away (deltas.ts netted):
 *
 * - each selection its blocks read of a delta that admits less than the whole delta, made once, from the delta's array,
 *   for every block that reads it (deltas.ts selectionsMade), each a variable of the part's;
 * - each block's calls in their order, each where a selection it takes holds a row, with those selections: over
 *   selections that hold none its region is empty, and every statement of it finds no row. A call is a function of its
 *   own (`functionOf`, identity.ruleJudgeBlock or identity.storedUpkeep), the part's statement a call of it: PostgreSQL
 *   compiles a PL/pgSQL function's whole text at its first call in a session and plans each statement at its first
 *   run, so a session compiles a call's statements only where its transaction runs them. A part that held its blocks'
 *   statements compiled every one at its session's first COMMIT that ran the part: the ledger's learner part, 76
 *   statements and 2.68 MB, 47 ms before a save ran the 5 statements over what it wrote. A block's calls are its own: a
 *   stored relation's upkeep held as one call of a delta form's removal and gain ran the removal's statements wherever
 *   the gain's ran, a document inserted alone running Documented's DELETE and INSERT at the units of Doc's and Part's
 *   empty sides of olds, planned and run over nothing, the DELETE's seek of Documented's table holding ACCESS SHARE to
 *   COMMIT (test/pg/laws/rule-dispatch).
 */
const partBody = (
	schema: string,
	part: JudgePart,
	functionOf: (call: JudgedCall) => ObjectName
): PlBlock => {
	const [first, ...rest] = part.blocks.flatMap((j) => j.calls)
	const calls: NonEmptyReadonlyArray<JudgedCall> = [defined(first, "a part's first call"), ...rest]
	const made = [
		...new Map(calls.flatMap((call) => call.params.map((p) => [p.variable, p] as const))).values()
	].toSorted((x, y) => compareStrings(x.order, y.order))
	const own = made.filter((selection) => isNonEmpty(selection.conditions))
	const making = selectionsMade(schema, own)
	return {
		declare: [
			...own.map((selection) => ({
				name: selection.variable,
				type: deltaArrayType(schema, selection.delta)
			})),
			...making.declare
		],
		body: concatNonEmpty(
			[...making.body],
			mapNonEmpty(calls, (call): PlStatement => ({
				kind: "if",
				branches: [
					{
						condition: anyHolds(mapNonEmpty(call.params, (p) => p.variable)),
						body: [
							performed(
								functionOf(call),
								call.params.map((p): Expr => ({ kind: "plVar", name: p.variable }))
							)
						]
					}
				],
				else: []
			}))
		)
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
 * Each side of news of `sides` netted where the transaction wrote a row into it (deltas.ts netted), in its delta's name
 * order: once a claim of the log has taken the sides' rows, before any statement reads them, so every rule and every
 * upkeep reads a side of news as the transaction leaves it, each image once, and an image it inserted and deleted again,
 * or put back where it found it, not at all.
 *
 *   IF cardinality(<delta>) > 0 THEN <delta> := <the delta netted> END IF
 */
const nettingsOf = (
	schema: string,
	sides: ReadonlyArray<{ readonly t: JudgedTable; readonly s: JudgedSide }>
): ReadonlyArray<PlStatement> =>
	sides
		.filter(({ s: side }) => side.side === "added")
		.toSorted((x, y) => compareStrings(x.s.delta.order, y.s.delta.order))
		.map(({ t, s: side }): PlStatement => ({
			kind: "if",
			branches: [
				{
					condition: anyHolds([side.delta.name]),
					body: [netted(schema, t.relation, side)]
				}
			],
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
 *   Its function builds, from the statement's transition tables, the array of the rows of each side the statement wrote
 *   (deltas.ts captured), every column of the relation's heading, typed by its base type, an UPDATE's only where it
 *   changed the row's image, its key or a column the side reads: into the side of olds, delta.removed, the rows as the
 *   statement found them; into the side of news, the transaction's change, each image the statement put counted 1 and
 *   each it removed -1. A statement that wrote none of them logs nothing. Otherwise it appends them to the transaction's
 *   log (`logged`): one INSERT of its own row into the delta log, linked to the transaction's newest row before it,
 *   whose tuple id the transaction's arm row holds, and the arm's head moved to it. No capture rewrites a row another
 *   wrote, so a capture costs the rows it logs, however many captures came before it in the transaction.
 * - The log (sql/ast.ts CreateJudgeLog): two UNLOGGED tables of the installation, made by its migration once, never by
 *   a session, so no connection writes the catalog to judge a write, whatever it writes: the arm, one row of each
 *   transaction that logged a row since its judge last ran, keyed by the transaction's 64-bit id; and the delta log, one
 *   row of each capture, linked to the one before it by tuple id. Every statement reads them by tuple id or by the
 *   arm's key through ON CONFLICT (`armRead`), so no read of them takes a predicate lock: PostgreSQL's SERIALIZABLE
 *   locks no tuple a transaction reads of its own writes (predicate.c PredicateLockTID) and no read under ON CONFLICT's
 *   dirty snapshot (SerializationNeededForRead), so no transaction's judge meets another's in SSI through the log, as a
 *   scan of it by the transaction's id did, its page locks meeting every later capture's insert: a writer that read a
 *   row a committed writer had changed, beside a judged writer that committed first, failed its own judged write 30
 *   times in 30 with 40001 under that scan, and never under these reads. Its rows are insert-only until the judge
 *   claims them, so a row's tuple id stands for the transaction, and only the judge deletes them. No grant reaches
 *   them: only the judge's definer, which runs every capture and the judge, reads or writes them, so no login empties a
 *   delta before COMMIT, as one could a table of its session's own temporary schema or a setting of its transaction.
 * - Arming: the arm's DEFERRABLE INITIALLY DEFERRED constraint trigger runs the judge, AFTER INSERT alone, so a
 *   transaction's first capture arms it, at its read of the arm's head, and no later one does: the judge runs once, at
 *   COMMIT, or at SET CONSTRAINTS ALL IMMEDIATE and after each statement from then on, at the end of the statement that
 *   armed it.
 * - The judge: it claims the transaction's log (`claimed`): the arm row's head, then each delta row from it back along
 *   their links, deleted, its sides' rows aggregated into one array of each delta, a variable of the judge's, empty where
 *   the transaction wrote none of its rows; each side of news netted (`nettingsOf`), so it holds delta.added. Its rules
 *   stand in parts (`partsOf`), each a function of its own (identity.ruleJudgePart) that takes the deltas it reads: the
 *   classes of the rules' blocks under reading a delta in common, so a part's rules read only its deltas, and the judge
 *   runs a part only where the transaction wrote one of them; each block a function of its own too
 *   (identity.ruleJudgeBlock), which takes the selections of the deltas its statements read and which its part calls
 *   where one of them holds a row, so a session compiles the statement of a block its transactions run alone. A
 *   transaction reads, judges and compiles only the parts of the relations it wrote: a learner's write never reads a
 *   content package's rules, nor compiles their PL/pgSQL, and no COMMIT reads a catalog. For each rule in trigger-name
 *   order, each table it reads and each side it reads there, where that side's delta holds a row, it runs each probe of
 *   the side over its region (`compileProbe`), the delta's rows, and a whole rule's violation over its units where any
 *   delta its region reads holds one (`partBody`), each read whole as a PERFORM and raised where it found a row
 *   (sql/build.ts whenFound, as a migration's check of the law is), never as IF EXISTS, which PostgreSQL plans for a
 *   first row a holding rule never returns: SQLSTATE 23503 for a containment, 23505 for a key and 23514 for a check,
 *   naming the rule's trigger name as its constraint and the rule's table, with no DETAIL, since the writer may not see
 *   the rows. Over deltas that hold no row a rule's region is empty, so a transaction runs exactly the rules over the
 *   relations it wrote. The upkeeps of phase A write their stored relations' tables, whose captures log their rows
 *   into the same transaction's log inside the judge, which claims them after each stratum, so the strata and rules
 *   above read them; it deletes the arm row once phase A is done, so a later statement arms it again. A judge that runs
 *   again after SET CONSTRAINTS ALL IMMEDIATE reads the rows the statements since its last run wrote: each statement's
 *   rows are judged once, on the state as it stood when they were, and a later statement that breaks a rule through
 *   them writes rows of its own the rule's other side reads, which that run judges.
 *
 * The side of news is the transaction's net write so that a probe of the facts a row adds never reads that row from its
 * table, where without statistics PostgreSQL prices a read at the key's index the same as one at an index of a strict
 * subset of the key's columns, a qti attribute's (name, package): one row each (selfuncs.c btcostestimate, the unique
 * key's one tuple against two default equalities' clamped to one), and the shorter tree wins, reading every row of the
 * subset at every row of the delta. Every function is SECURITY DEFINER under closedSearchPath, every name it reads
 * schema-qualified, EXECUTE revoked from PUBLIC.
 *
 * Every writer of a guarded table is SERIALIZABLE (isolation.ts), so PostgreSQL's SSI orders each probe's reads against
 * a concurrent write there. A READ COMMITTED role writes a table the rule reads only where certification proves the
 * rule monotone in its writes (analysis/isolation/certify.ts `laws`): its probes read at COMMIT, at a snapshot of their
 * own, and a write they miss can only withdraw a violation, never add one.
 *
 * The judge lives as long as the installation: every installation holds it, one name (identity.ruleJudge), its rules
 * none or many, its body empty where no table is judged (no log stands to read, `judging`), and a migration replaces it
 * in place and never drops it, since the arm's trigger names it and PostgreSQL refuses to drop a function a trigger
 * runs. A part, a block or a delta's row type whose deltas change is another object, the old one dropped. A migration
 * that adds an installation's first rule over a query or removes its last one changes the judge's body, its parts, the
 * captures and the log. Each function's bound plan states what each of its probes reads by index, which the
 * installation asks as law-maintenance requests of its rule (`requesters`, `routineRequests`), so a probe reads by index
 * and its cost follows the write.
 */
export const addRules = (
	b: InstallBuilder
): {
	/**
	 * Who asks the indexes each function of the judge reads through (`Requester`), by its name's key: the
	 * installation asks its plan's requests as it asks them (`routineRequests`), once it has bound the function
	 * (physical/install/compile.ts).
	 */
	readonly requesters: ReadonlyMap<NameKey, Requester>
	readonly checks: ReadonlyMap<LawId, OperandSelect>
} => {
	const catalog = evidenceCatalog({ laws: b.model, views: noViewEvidence })
	const tables = judgedTables(b)
	const judge = objectName(b.schema, b.name(identity.ruleJudge()))
	const sideDelta = (t: JudgedTable, side: ProbeSide): Delta | undefined =>
		t.sides.find((s) => s.side === side)?.delta
	const requesters = new Map<NameKey, Requester>()
	/** What the probes prove a sibling's cover by (analysis/theory/query.ts Proofs): the theory's containments and keys. */
	const proofs = proofsOf(
		b.model.theory.regionFacts,
		(relation) => b.model.theory.relations[relation],
		clockOrders(b.model.theory.instants)
	)
	const tableOf = (relation: string): JudgedTable | undefined =>
		tables.find((t) => t.relation.name === relation)
	/** The selections of the deltas the judged statements read, each an array of the rows it admits (`headed`). */
	const selections = new DeltaSelections(
		b,
		tables.flatMap((t) =>
			t.sides.map((s) => ({ relation: t.relation, side: s.side, delta: s.delta }))
		)
	)
	/** The delta of `t`'s side `side` as a Delta node reads it (deltas.ts deltaRelation); none of the facts a write met. */
	const sessionDelta = (t: JudgedTable, side: DeltaSide): DeltaRelation | undefined => {
		const delta = side === "met" ? undefined : sideDelta(t, side)
		return delta === undefined ? undefined : deltaRelation(t.relation, delta)
	}
	/**
	 * The call of a block's function over `asked`'s statements, its reads `reads`, its arguments the selections its
	 * statements read (deltas.ts DeltaSelections readBy), which name it (`named`). A statement of the judge that reads no
	 * delta reads the store whole, an internal defect.
	 */
	const callOf = (
		named: (
			selections: ReadonlyArray<Identity<"ruleDeltaSelection" | "ruleDelta">>
		) => Identity<"ruleJudgeBlock" | "storedUpkeep">,
		reads: NonEmptyReadonlyArray<Delta>,
		asked: Asked,
		what: string
	): JudgedCall => {
		const [first, ...rest] = selections.readBy(asked.body.body)
		if (first === undefined) {
			defect(`${what}, at least one statement over a delta`)
		}
		const params: NonEmptyReadonlyArray<DeltaSelection> = [first, ...rest]
		return {
			named: named(params.map((p) => p.ident)),
			reads,
			params,
			by: asked.by,
			body: asked.body
		}
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
			const delta = sideDelta(t, side)
			const query = probe(probed, relation.name, side, proofs, rule.law.loc)
			if (query === undefined) {
				return []
			}
			const compiled = compileProbe(b, catalog, rule, relation, query, deltas, selections)
			const judged = whenFound(compiled.statement, [raise])
			const guard = probeGuard(probed, relation.name, side, keysOf, fieldsOf, rule.law.loc)
			const guarded =
				guard === undefined
					? undefined
					: compileProbe(b, catalog, rule, relation, guard, deltas, selections)
			return delta === undefined
				? []
				: [
						{
							reasons: lawReasonOf(rule),
							relations: [...rule.law.reads],
							order: identifierOf(rule.named),
							writes: [],
							calls: [
								callOf(
									(params) =>
										identity.ruleJudgeBlock(
											rule.named,
											rule.law.named,
											{ kind: "probe", relation: relation.name, side },
											params
										),
									[delta],
									{
										by: ruleRequester(rule),
										body: {
											declare: [],
											body: [
												guarded === undefined ? judged : whenExists(guarded.statement, [judged])
											]
										}
									},
									`the block of rule ${rule.law.named.display} on ${relation.name}`
								)
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
			unit.judged,
			definedAt(b.columns, unit.definitionOf),
			label,
			rule.law.loc,
			deltas,
			selections,
			"units"
		)
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
				callOf(
					(params) =>
						identity.ruleJudgeBlock(rule.named, rule.law.named, { kind: "units" }, params),
					[
						defined(
							first,
							`a delta of a side ${rule.law.named.display} reads, which its touches name`
						),
						...rest
					],
					{
						by: ruleRequester(rule),
						body: {
							declare: [],
							body: [whenFound(lowered.statement, [raiseOf(b, rule, holder.relation)])]
						}
					},
					`the block of rule ${rule.law.named.display} over its units`
				)
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
	 *   S's rows at the units, each found by a probe of S's unit key at a unit (the binding's), that no row of the
	 *   definition there agrees with, deleted at their tuple ids (`removal`), then the definition's rows inserted:
	 *
	 *     DELETE FROM <S> AS r1 USING (SELECT DISTINCT r<k>.ctid FROM (<the written units' keys>) AS r2 (c1, …),
	 *         <S> AS r<k> WHERE r<k>.<u0> = r2.c1 AND … AND NOT EXISTS (SELECT FROM (<its definition there>) AS r<d>
	 *           WHERE r<k>.<f0> = r<d>.c1 AND …)) AS r<i> (c1)
	 *       WHERE r1.ctid = r<i>.c1
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
	 *   region its definition reads read one selection of each delta, and the INSERT reads the region once, in its
	 *   definition.
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
	 *     DELETE FROM <S> AS r1 USING (<S's row at each fact lost, by a probe of its key>) AS r<i> (c1)
	 *       WHERE r1.ctid = r<i>.c1
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
		 * The removal of S's rows at the tuple ids `tids` selects, its query read as every judged statement reads a delta
		 * (`headed`), each id once (`unitBody`, `checkedBody`), under `ids`: one DELETE of S at each id,
		 *
		 *   DELETE FROM <S> AS r1 USING (<tids>) AS <ids> (c1) WHERE r1.ctid = <ids>.c1
		 *
		 * whose target the binding reads at the tid its condition states, one heap fetch a row by a TID condition of its
		 * scan, nested in the ids' read (sql/bind.ts Binder `written`), as its advice holds it, so its plan is the ids'
		 * rows each fetched, whatever PostgreSQL estimates of how many there are: never a Hash Join over a Seq Scan of S,
		 * nor `r1.ctid = ANY (ARRAY(<tids>))` as a Seq Scan of S filtered by an array whose length it guesses, all 1,370
		 * rows of Forward's table read beside 1,370 packages at a founding write whose bound is 12
		 * (test/pg/lower-shapes/import-upkeep).
		 *
		 * What bounds it: the ids are those of S's rows at the write's units (or at the facts it withdraws), each found by
		 * a probe of S's key at a row of the delta (the binding's), so the DELETE fetches each such row and no other,
		 * however many S holds.
		 */
		const removal = (tids: Select, ids: string): PlBlock => ({
			declare: [],
			body: [
				{
					kind: "modify",
					statement: {
						kind: "delete",
						with: undefined,
						table,
						alias: "r1",
						using: [derived(namedQuery(headed(tids, selections), columnsAt(1)), ids, false)],
						where: eq(col("r1", "ctid"), col(ids, "c1")),
						returning: []
					}
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
			const units = loweredJudged(b, catalog, form.region, b.columns, label, u.loc, deltas, "units")
			const rows = loweredJudged(
				b,
				catalog,
				form.judged,
				definedAt(b.columns, form.definitionOf),
				label,
				u.loc,
				deltas,
				"units"
			)
			const heading = headingOf(rows)
			const unitNames = lastNumbered(units.statement)
			const rowNames = lastNumbered(rows.statement)
			/** The DELETE's names: S r1, the region's own past it, the region r<u+2>, the definition's past that, then
			 * its rows r<u+r+3>, S at a unit r<u+r+4>, the ids r<u+r+5>. */
			const regionAlias = `r${unitNames + 2}`
			const foundAlias = `r${unitNames + rowNames + 3}`
			const seekAlias = `r${unitNames + rowNames + 4}`
			const idsAlias = `r${unitNames + rowNames + 5}`
			/**
			 * The tuple ids of the stored rows at the units that no row of the definition there agrees with at every
			 * field, each once: S read at each written unit's values of its unit key, which the binding makes a probe of
			 * S's key per unit (sql/bind.ts Binder `probeEntry`, a read driven by the region's row), whatever PostgreSQL
			 * estimates of the units, the rows the write's units reach and no other.
			 */
			const stale = select(
				distinctCore(
					[{ expr: col(seekAlias, "ctid"), alias: undefined }],
					[
						derived(
							namedQuery(shifted(units.statement, 1), columnsAt(units.heading.length)),
							regionAlias,
							false
						),
						{ kind: "table", table, alias: seekAlias }
					],
					and([
						...mapNonEmpty(u.stored.fields, (field, j) =>
							eq(col(seekAlias, columnOf(field)), col(regionAlias, `c${j + 1}`))
						),
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
									mapNonEmpty(heading, (field, i) =>
										eq(col(seekAlias, columnOf(field)), col(foundAlias, `c${i + 1}`))
									)
								)
							)
						)
					])
				)
			)
			const removed = removal(stale, idsAlias)
			return {
				by: requester,
				body: {
					declare: removed.declare,
					body: [...removed.body, inserting(headed(rows.statement, selections), heading)]
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
		 * rule's row a fact of S's heading, S's row at each read by every field, which the binding makes a probe of S's
		 * key per fact (sql/bind.ts Binder `probeEntry`), and the rows deleted at their tuple ids (`removal`); its names,
		 * the facts r<l+2>, S r<l+3>, the ids r<l+4>:
		 *
		 *   DELETE FROM <S> AS r1 USING (SELECT DISTINCT r3.ctid FROM (<the facts lost>) AS r2 (c1, …), <S> AS r3
		 *       WHERE r3.<f1> = r2.c1 AND …) AS r4 (c1)
		 *     WHERE r1.ctid = r4.c1
		 *
		 * So S is read once per lost fact by its key, which leads the fields, whatever PostgreSQL estimates of the facts.
		 */
		const checkedBody = (form: CheckedLoss): Asked => {
			const lost = loweredJudged(b, catalog, form.query, b.columns, label, u.loc, deltas, "units")
			const fact = headingOf(lost)
			const names = lastNumbered(lost.statement)
			const lostAlias = `r${names + 2}`
			const rowAlias = `r${names + 3}`
			const idsAlias = `r${names + 4}`
			/** The tuple ids of S's rows at the facts lost, each once (two candidates of one fact find one row): S read at
			 * each fact by every field, which the binding makes a probe of S's key per fact (sql/bind.ts Binder
			 * `probeEntry`). */
			const rows = select(
				distinctCore(
					[{ expr: col(rowAlias, "ctid"), alias: undefined }],
					[
						derived(
							namedQuery(shifted(lost.statement, 1), columnsAt(fact.length)),
							lostAlias,
							false
						),
						{ kind: "table", table, alias: rowAlias }
					],
					and(
						mapNonEmpty(fact, (field, i) =>
							eq(col(rowAlias, columnOf(field)), col(lostAlias, `c${i + 1}`))
						)
					)
				)
			)
			return { by: deltaRequester, body: removal(rows, idsAlias) }
		}
		/**
		 * The call of the upkeep's `part` (identity.storedUpkeep) over `asked`'s statements, in their order, its reads the
		 * deltas of the selections they read (`callOf`): run where one of those holds a row, so a write that touches none
		 * of them runs, compiles and plans none of the part.
		 */
		const partCall = (part: UpkeepPart, asked: Asked): JudgedCall => {
			const what = `the ${part} part of the upkeep of stored relation ${u.relation}`
			const [first, ...rest] = [
				...new Map(
					selections.readBy(asked.body.body).map((s) => [s.delta.name, s.delta] as const)
				).values()
			]
			return callOf(
				(params) => identity.storedUpkeep(u.relation, part, params),
				[defined(first, `${what}, at least one statement over a delta`), ...rest],
				asked,
				what
			)
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
				form.gained,
				b.columns,
				label,
				u.loc,
				deltas,
				selections,
				"units"
			)
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
				query,
				b.columns,
				label,
				rule.law.loc,
				everyRow(rule),
				new DeltaSelections(b, []),
				"every"
			)
		const compiled = lowered(
			r.kind === "whole"
				? r.everyRow
				: everyRowProbe(r, (name) => readTable(rule, name) !== undefined, rule.law.loc)
		)
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
	 * holder its site names, that side's array the judge claimed, taken by the borrow function in the order of the locks'
	 * ids (write/borrow/statement.ts borrowQuery), its value read whole:
	 *
	 *   PERFORM r<n>.c<m> FROM (SELECT <schema>.__borrow(pg_catalog.array_agg(…), …)::text AS c<m>, … FROM (…
	 *     SELECT <the lock id of the unit at the row's key> AS c1, true AS c2 FROM unnest(<a holder's side>) AS r<k>
	 *     UNION ALL …) GROUP BY …) AS r<n>
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
	 * transaction's parts take the same units in the other order. A side the transaction wrote no row of is the empty
	 * array, which reads nothing. A lock kind's rank is its place among the
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
							where: undefined,
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
		const taken = headed(borrowQuery(b.schema, arms, rankOf, names), selections)
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
	const reasons: ReadonlyArray<PhysicalReason> = [
		enforcement(`the rules over queries of schema ${b.owned.name}`),
		...b.model.rules.map((rule) => ({ kind: "law" as const, law: rule.law.id }))
	]
	/** The tables of the stored relations among `names`, each once. */
	const tablesNamed = (names: ReadonlyArray<string>) =>
		[...new Set(names)].flatMap((name) => (b.model.relations.has(name) ? [b.table(name)] : []))
	const tablesOf = (rules: ReadonlyArray<RuleTrigger>) =>
		tablesNamed(rules.flatMap((rule) => [...rule.law.reads]))
	/**
	 * Each delta's row type (deltas.ts deltaRowType), by its delta's name: what every argument, variable and log column
	 * of the delta is an array of, its USAGE revoked from PUBLIC, so only the judge's definer names it.
	 */
	const rowTypes = new Map(
		tables.flatMap((t) =>
			t.sides.map((s) => {
				const create = deltaRowTypeCreate(b.schema, s.delta)
				const node = b.add(
					{
						kind: "rowType",
						ident: b.qualified("type", s.delta.ident),
						ddl: [
							create,
							{
								kind: "revoke",
								privileges: ["ALL"],
								on: { kind: "TYPE", names: [create.name] },
								from: [{ kind: "PUBLIC" }]
							}
						],
						reasons,
						phase: "setup"
					},
					[b.schemaNode]
				)
				return [s.delta.name, node] as const
			})
		)
	)
	/** The row types of `deltas`, each once. */
	const typesOf = (deltas: ReadonlyArray<Delta>): ReadonlyArray<Node<"setup">> =>
		[...new Set(deltas.map((d) => d.name))].map((name) =>
			defined(rowTypes.get(name), "a delta's row type")
		)
	/**
	 * Each call's function of block `j` (`partBody`, identity.ruleJudgeBlock or identity.storedUpkeep): its call's
	 * selections its arguments, each an array of its delta's rows, the call's statements its body, SECURITY DEFINER under
	 * the closed search path as every function of the judge, its EXECUTE revoked from PUBLIC, so only the judge's
	 * definer, which its part runs as, calls it.
	 */
	const callNode = (
		j: Judged,
		call: JudgedCall
	): { readonly fn: ObjectName; readonly node: Node<"validate"> } => {
		const fn = objectName(b.schema, b.name(call.named))
		const params = call.params.map((p) => ({
			name: p.variable,
			type: deltaArrayType(b.schema, p.delta)
		}))
		const running: PlFunction = {
			kind: "createFunction",
			advice: noAdvice,
			language: "plpgsql",
			name: fn,
			params,
			returns: "void",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			body: call.body
		}
		const ddl: readonly [PlFunction, Revoke] = [
			running,
			revokeOf(
				fn,
				params.map((p) => p.type)
			)
		]
		requesters.set(nameKey(fn), call.by)
		const node = b.add(
			{
				kind: "lawFunction",
				ident: b.qualified("function", call.named),
				ddl,
				reasons: j.reasons,
				phase: "validate"
			},
			[...tablesNamed(j.relations), ...typesOf(call.params.map((p) => p.delta))]
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
			mapNonEmpty(part.deltas, (d) => d.ident),
			part.pass
		)
		const fn = objectName(b.schema, b.name(named))
		const params = part.deltas.map((d) => ({ name: d.name, type: deltaArrayType(b.schema, d) }))
		const ddl: readonly [PlFunction, Revoke] = [
			{
				kind: "createFunction",
				advice: noAdvice,
				language: "plpgsql",
				name: fn,
				params,
				returns: "void",
				volatility: "VOLATILE",
				parallel: "UNSAFE",
				security: "DEFINER",
				body: partBody(
					b.schema,
					part,
					(call) => defined(calls.get(call), "a call of a block of the part").fn
				)
			},
			revokeOf(
				fn,
				params.map((p) => p.type)
			)
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
				...[...calls.values()].map((call) => call.node),
				...typesOf(part.deltas)
			]
		)
		return { part, fn, node }
	})
	const functionOf = new Map(parts.map(({ part, fn }) => [part, fn] as const))
	/** Each of `run` run where the transaction wrote one of its deltas, with its deltas. */
	const partsRun = (run: ReadonlyArray<JudgePart>): ReadonlyArray<PlStatement> =>
		run.map((part): PlStatement => ({
			kind: "if",
			branches: [
				{
					condition: anyHolds(mapNonEmpty(part.deltas, (d) => d.name)),
					body: [
						performed(
							defined(functionOf.get(part), "a part's function"),
							part.deltas.map(deltaVariable)
						)
					]
				}
			],
			else: []
		}))
	const installation = headNonEmpty(b.names.levels)
	/** Every side the judge holds, each with its table, in its delta's order (deltas.ts Delta `order`). */
	const sides = tables
		.flatMap((t) => t.sides.map((s) => ({ t, s })))
		.toSorted((x, y) => compareStrings(x.s.delta.order, y.s.delta.order))
	const [s0, ...ss] = sides
	/** The installation's log (`JudgeLog`), none where no table is judged. */
	const log: JudgeLog | undefined = ((): JudgeLog | undefined => {
		if (s0 === undefined) {
			return undefined
		}
		const deltasIdent = identity.ruleDeltas(installation, [
			s0.s.delta.ident,
			...ss.map(({ s: side }) => side.delta.ident)
		])
		return {
			arm: objectName(b.schema, b.name(identity.ruleArm(installation))),
			armKey: b.name(identity.ruleArmKey(installation)),
			deltasIdent,
			deltas: objectName(b.schema, b.name(deltasIdent)),
			sides: [s0.s, ...ss.map(({ s: side }) => side)]
		}
	})()
	/** The selections the judge's own statements read, each of less than its delta, which it makes itself. */
	const judgeMade = selections.readBy(judgeBorrow).filter((x) => isNonEmpty(x.conditions))
	const judgeMaking = selectionsMade(b.schema, judgeMade)
	/** The stored relations each stratum's upkeeps write, each with its sides the judge holds. */
	const keptIn = (stratum: number): ReadonlyArray<JudgedSide> =>
		sides.flatMap(({ t, s: side }) =>
			upkept.some((x) => x.stratum === stratum && x.block.order === t.relation.name) ? [side] : []
		)
	const sideOfSides = (kept: ReadonlyArray<JudgedSide>) =>
		kept.map((side) => defined(sideOf.get(side.delta.name), "a kept side's table"))
	/**
	 * The judge's run: none where no table is judged, so no capture arms it, the judge an empty container every
	 * installation holds that reads nothing and plans no query; else its claim of the transaction's log (`claimed`), each
	 * side's rows into its delta's variable and each side of news netted (`nettingsOf`); the judge's borrow
	 * (`judgeBorrow`), over the selections it makes itself; phase A, stratum by stratum (`stratumOf`), each upkeep part of
	 * the stratum run where the transaction wrote one of its deltas, whose writes of a stored relation's table log that
	 * table's rows where a rule or an upkeep a stratum up reads it, claimed after the stratum, each stored relation's side
	 * of news netted, so the next stratum's parts run where the stored relations below them changed; the arm's row deleted
	 * once phase A is done, so a later statement arms the judge again; and phase B, each rule part run likewise. It reads
	 * no catalog and no row of another transaction's.
	 */
	const judging: ReadonlyArray<PlStatement> =
		log === undefined
			? []
			: [
					...claimed(b.schema, log, log.sides, "first"),
					...nettingsOf(b.schema, sides),
					...judgeMaking.body,
					...judgeBorrow,
					...upkeptStrata.flatMap(({ stratum }, at): ReadonlyArray<PlStatement> => {
						const [k0, ...ks] = keptIn(stratum)
						return [
							...partsRun(defined(upkeepParts[at], "a stratum's upkeep parts")),
							...(k0 === undefined
								? []
								: [
										...claimed(b.schema, log, [k0, ...ks], "again"),
										...nettingsOf(b.schema, sideOfSides([k0, ...ks]))
									])
						]
					}),
					armDeleted(log),
					...partsRun(parts.flatMap(({ part }) => (part.pass.kind === "rules" ? [part] : [])))
				]
	const judgeDdl: readonly [PlFunction, Revoke] = [
		{
			kind: "createFunction",
			advice: noAdvice,
			language: "plpgsql",
			name: judge,
			params: [],
			returns: "trigger",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			body: {
				declare:
					log === undefined
						? []
						: [
								...log.sides.map((side) => ({
									name: side.delta.name,
									type: deltaArrayType(b.schema, side.delta)
								})),
								...judgeMade.map((x) => ({
									name: x.variable,
									type: deltaArrayType(b.schema, x.delta)
								})),
								...claimDeclarations,
								...judgeMaking.declare
							],
				body: appendNonEmpty(judging, { kind: "return", value: { kind: "plSpecial", name: "NEW" } })
			}
		},
		revokeOf(judge, [])
	]
	/**
	 * The judge, created before its log, whose arm's trigger names it: its body names the log's tables in PL/pgSQL text
	 * alone, which PostgreSQL resolves where it runs it, never where it creates it.
	 */
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
			...typesOf(sides.map(({ s: side }) => side.delta))
		]
	)
	if (log === undefined) {
		return { requesters, checks }
	}
	const logNodes = [
		b.add(
			{
				kind: "ruleLog",
				ident: b.qualified("table", identity.ruleArm(installation)),
				ddl: [
					{ kind: "createJudgeLog", table: log.arm, log: { kind: "arm", key: log.armKey } },
					tableRevoke(log.arm),
					{
						kind: "createConstraintTrigger",
						name: identifierOf(identity.ruleJudge()),
						table: log.arm,
						events: [{ kind: "insert" }],
						function: judge
					}
				],
				reasons,
				phase: "validate"
			},
			[judgeNode]
		),
		b.add(
			{
				kind: "ruleLog",
				ident: b.qualified("table", log.deltasIdent),
				ddl: [
					{
						kind: "createJudgeLog",
						table: log.deltas,
						log: {
							kind: "deltas",
							sides: mapNonEmpty(log.sides, (side) => ({
								column: side.delta.name,
								type: deltaRowType(b.schema, side.delta)
							}))
						}
					},
					tableRevoke(log.deltas)
				],
				reasons,
				phase: "validate"
			},
			typesOf(log.sides.map((side) => side.delta))
		)
	] as const
	const events = new Set<TransitionEvent>()
	for (const t of tables) {
		addCapture(b, t, log, [...logNodes, ...typesOf(t.sides.map((side) => side.delta))], events)
	}
	for (const event of events) {
		b.name(identity.captureTrigger(event))
	}
	return { requesters, checks }
}

/**
 * The installation's log of the rule judge (sql/ast.ts CreateJudgeLog, `addRules`): its arm and the arm's key, its delta
 * log by its identity and its name, and every side it holds, each a column of the delta log, in its delta's order
 * (deltas.ts Delta `order`).
 */
interface JudgeLog {
	readonly arm: ObjectName
	readonly armKey: string
	readonly deltasIdent: Identity<"ruleDeltas">
	readonly deltas: ObjectName
	readonly sides: NonEmptyReadonlyArray<JudgedSide>
}

/** REVOKE ALL ON TABLE <table> FROM PUBLIC: no role but the table's owner, the judge's definer, reads or writes it. */
const tableRevoke = (table: ObjectName): Revoke => ({
	kind: "revoke",
	privileges: ["ALL"],
	on: { kind: "TABLE", names: [table] },
	from: [{ kind: "PUBLIC" }]
})

/**
 * The judge's variables of its claim (`claimed`), none a column of the log's (sql/ast.ts judgeLogColumns) nor a delta's:
 * the tuple id of the transaction's arm row; the head the arm holds, its newest delta row's; the head the judge claimed
 * last, from which a later claim reads back no further; and the tuple ids a claim reads.
 */
const claimNames = { arm: "__arm", head: "__head", seen: "__seen", tids: "__tids" } as const

/** The declarations of the judge's claim's variables (`claimNames`). */
const claimDeclarations: ReadonlyArray<PlDeclaration> = [
	{ name: claimNames.arm, type: types.tid },
	{ name: claimNames.head, type: types.tid },
	{ name: claimNames.seen, type: types.tid },
	{
		name: claimNames.tids,
		type: { kind: "builtin", name: "tid", precision: undefined, scale: undefined, array: true }
	}
]

/** This transaction's 64-bit id, its top-level transaction's: the arm's key of its row. */
const thisTransaction: Expr = call("pg_current_xact_id", [])

/** A PL/pgSQL variable's value. */
const variable = (name: string): Expr => ({ kind: "plVar", name })

/**
 * The transaction's arm row read through ON CONFLICT DO SELECT, made where none stands:
 *
 *   INSERT INTO <arm> AS r1 (__xact) VALUES (pg_current_xact_id()) ON CONFLICT (__xact) DO SELECT
 *     RETURNING <returning> INTO <into>
 *
 * PostgreSQL reads the conflicting row under a dirty snapshot (execIndexing.c check_exclusion_or_unique_constraint)
 * and fetches it whatever snapshot (nodeModifyTable.c ExecOnConflictSelect, SnapshotAny), so the read takes no predicate
 * lock under SERIALIZABLE (predicate.c SerializationNeededForRead): no other transaction's write of the arm conflicts
 * with it. A transaction's first read of it is its INSERT, which arms the judge (`addRules`).
 */
const armRead = (
	log: JudgeLog,
	returning: NonEmptyReadonlyArray<Expr>,
	into: NonEmptyReadonlyArray<string>
): PlStatement => ({
	kind: "into",
	statement: {
		kind: "insert",
		with: undefined,
		table: log.arm,
		alias: "r1",
		onConflict: {
			kind: "columns",
			columns: [judgeLogColumns.xact],
			action: { kind: "doSelect", where: undefined }
		},
		returning: returning.map((expr) => ({ expr, alias: undefined })),
		columns: [judgeLogColumns.xact],
		source: { kind: "values", rows: [[thisTransaction]] }
	},
	into
})

/**
 * The judge's claim of the rows the transaction logged (`addRules`), of the sides `claiming`: the arm row's head read
 * (`armRead`), with its tuple id; the tuple ids of the delta rows logged since the head the judge claimed last, all of
 * them at its `first` claim, each read from the one after it by its link, by tuple id, back to that head; then those
 * rows deleted, each side's rows of them aggregated into its delta's variable, the empty array where none holds one of
 * its rows:
 *
 *   INSERT INTO <arm> AS r1 (__xact) VALUES (pg_current_xact_id()) ON CONFLICT (__xact) DO SELECT
 *     RETURNING r1.ctid, r1.__last INTO __arm, __head;
 *   __tids := ARRAY(WITH RECURSIVE r1 (c1) AS (SELECT __head WHERE <__head past __seen> UNION ALL
 *     SELECT r3.__prev FROM r1 AS r2, <deltas> AS r3 WHERE r3.ctid = r2.c1 AND <r3.__prev past __seen>)
 *     SELECT r4.c1 FROM r1 AS r4);
 *   WITH r1 AS (DELETE FROM <deltas> AS r2 USING unnest(__tids) AS r3 (c1) WHERE r2.ctid = r3.c1
 *     RETURNING r2.<side> AS c1, ...)
 *   SELECT (SELECT coalesce(array_agg(ROW(r5.<attribute>, ...)::<row type>), '{}') FROM r1 AS r4,
 *     unnest(r4.c<n>) AS r5), ...
 *     INTO <side>, ...;
 *   __seen := __head;
 *
 * Past the head claimed last means past none at the first claim, a tuple id where one stands, and another than that
 * head at a later one, which the rows the transaction logged since then lead back to. Every read of the log is by tuple
 * id, of the transaction's own rows, so none takes a predicate lock (predicate.c PredicateLockTID), and each costs a
 * heap fetch: a claim reads the rows it claims, however many other transactions' rows the log holds. A row's tuple id
 * stands for its transaction: its rows are insert-only until the judge claims them, and only the judge deletes them.
 */
const claimed = (
	schema: string,
	log: JudgeLog,
	claiming: NonEmptyReadonlyArray<JudgedSide>,
	at: "first" | "again"
): ReadonlyArray<PlStatement> => {
	const past = (tid: Expr): Expr =>
		at === "first"
			? linked(tid)
			: { kind: "binary", op: "<>", left: tid, right: variable(claimNames.seen), schema: undefined }
	const walk: Select = {
		kind: "select",
		with: {
			recursive: true,
			ctes: [
				{
					name: "r1",
					materialized: undefined,
					query: {
						kind: "select",
						with: undefined,
						body: {
							kind: "setOp",
							op: "UNION ALL",
							rows: "disjoint",
							arms: [
								provedCore(
									"oneRow",
									[{ expr: variable(claimNames.head), alias: "c1" }],
									[],
									past(variable(claimNames.head))
								),
								provedCore(
									"keyed",
									[{ expr: col("r3", judgeLogColumns.prev), alias: "c1" }],
									[
										{ kind: "cte", name: "r1", alias: "r2" },
										{ kind: "table", table: log.deltas, alias: "r3" }
									],
									and([
										eq(col("r3", "ctid"), col("r2", "c1")),
										past(col("r3", judgeLogColumns.prev))
									])
								)
							]
						},
						orderBy: [],
						limit: undefined,
						offset: undefined
					}
				}
			]
		},
		body: provedCore(
			"keyed",
			[{ expr: col("r4", "c1"), alias: undefined }],
			[{ kind: "cte", name: "r1", alias: "r4" }],
			undefined
		),
		orderBy: [],
		limit: undefined,
		offset: undefined
	}
	const deleted: Delete = {
		kind: "delete",
		with: undefined,
		table: log.deltas,
		alias: "r2",
		using: [
			{
				kind: "function",
				call: call("unnest", [variable(claimNames.tids)]),
				alias: "r3",
				columns: { kind: "named", names: ["c1"], ordinality: false },
				lateral: false
			}
		],
		where: eq(col("r2", "ctid"), col("r3", "c1")),
		returning: claiming.map((side, at) => ({
			expr: col("r2", side.delta.name),
			alias: `c${at + 1}`
		}))
	}
	const rowsOf = (side: JudgedSide, at: number): Expr =>
		rowsArray(
			schema,
			side.delta,
			"r5",
			[
				{ kind: "cte", name: "r1", alias: "r4" },
				{
					kind: "function",
					call: call("unnest", [col("r4", `c${at + 1}`)]),
					alias: "r5",
					columns: { kind: "named", names: [], ordinality: false },
					lateral: true
				}
			],
			undefined
		)
	return [
		armRead(
			log,
			[col("r1", "ctid"), col("r1", judgeLogColumns.last)],
			[claimNames.arm, claimNames.head]
		),
		{ kind: "assign", target: claimNames.tids, value: { kind: "array", query: walk } },
		{
			kind: "into",
			statement: {
				kind: "select",
				with: { recursive: false, ctes: [{ name: "r1", materialized: undefined, query: deleted }] },
				body: provedCore(
					"oneRow",
					claiming.map((side, at) => ({ expr: rowsOf(side, at), alias: undefined })),
					[],
					undefined
				),
				orderBy: [],
				limit: undefined,
				offset: undefined
			},
			into: mapNonEmpty(claiming, (side) => side.delta.name)
		},
		{ kind: "assign", target: claimNames.seen, value: variable(claimNames.head) }
	]
}

/** The transaction's arm row deleted at the tuple id its claim read it at (`claimed`), so a later write arms the judge
 * again: `DELETE FROM <arm> AS r1 WHERE r1.ctid = __arm`. */
const armDeleted = (log: JudgeLog): PlStatement => ({
	kind: "modify",
	statement: {
		kind: "delete",
		with: undefined,
		table: log.arm,
		alias: "r1",
		using: [],
		where: eq(col("r1", "ctid"), variable(claimNames.arm)),
		returning: []
	}
})

/**
 * That the tuple id `tid` names a delta row: a head or a link, NULL past the transaction's first row, which links to
 * none, and in the head of an arm row whose first capture has not linked its row yet: `num_nonnulls(<tid>) > 0`.
 */
const linked = (tid: Expr): Expr => gt(call("num_nonnulls", [tid]), lit.int(0, types.integer))

/**
 * A capture's variables (`addCapture`): each side's array, by its delta's name, the head it links its row to, and its
 * row's tuple id, neither a column of the log's (sql/ast.ts judgeLogColumns).
 */
const captureNames = { head: "__head", row: "__row" } as const

/**
 * The rows a capture logs, `logging`, each side's array a variable of the capture's named by its delta, appended to the
 * transaction's log (`addRules`), where one of them holds a row: the arm row's head read, made where none stands, which
 * arms the judge at the transaction's first capture (`armRead`); the capture's own row inserted into the delta log,
 * linked to that head; the arm's head moved to it:
 *
 *   IF cardinality(<side>) > 0 OR ... THEN
 *     INSERT INTO <arm> AS r1 (__xact) VALUES (pg_current_xact_id()) ON CONFLICT (__xact) DO SELECT
 *       RETURNING r1.__last INTO __head;
 *     INSERT INTO <deltas> AS r1 (__prev, <side>, ...) VALUES (__head, <side>, ...) RETURNING r1.ctid INTO __row;
 *     INSERT INTO <arm> AS r1 (__xact, __last) VALUES (pg_current_xact_id(), __row)
 *       ON CONFLICT (__xact) DO UPDATE SET __last = excluded.__last;
 *   END IF
 *
 * One plain INSERT of the capture's rows, never a rewrite of a row another capture wrote, so a transaction's captures
 * cost its rows, however many statements wrote them.
 */
const logged = (log: JudgeLog, logging: NonEmptyReadonlyArray<JudgedSide>): PlStatement => ({
	kind: "if",
	branches: [
		{
			condition: anyHolds(mapNonEmpty(logging, (side) => side.delta.name)),
			body: [
				armRead(log, [col("r1", judgeLogColumns.last)], [captureNames.head]),
				{
					kind: "into",
					statement: {
						kind: "insert",
						with: undefined,
						table: log.deltas,
						alias: "r1",
						onConflict: undefined,
						returning: [{ expr: col("r1", "ctid"), alias: undefined }],
						columns: [judgeLogColumns.prev, ...logging.map((side) => side.delta.name)],
						source: {
							kind: "values",
							rows: [
								[variable(captureNames.head), ...logging.map((side) => variable(side.delta.name))]
							]
						}
					},
					into: [captureNames.row]
				},
				{
					kind: "modify",
					statement: {
						kind: "insert",
						with: undefined,
						table: log.arm,
						alias: "r1",
						onConflict: {
							kind: "columns",
							columns: [judgeLogColumns.xact],
							action: {
								kind: "doUpdate",
								set: assignments(ungenerated, "r1", [
									{
										column: judgeLogColumns.last,
										value: { kind: "excluded", column: judgeLogColumns.last }
									}
								]),
								where: undefined
							}
						},
						returning: [],
						columns: [judgeLogColumns.xact, judgeLogColumns.last],
						source: { kind: "values", rows: [[thisTransaction, variable(captureNames.row)]] }
					}
				}
			]
		}
	],
	else: []
})

/**
 * A table's capture (`addRules`): its function, which builds the array of each side's rows the statement wrote that its
 * event reads (deltas.ts captured) and logs them (`logged`), and its transition triggers, one per event, each recorded in
 * `events`:
 *
 * - INSERT, where a side of news stands: the rows the statement put, each counted 1;
 * - UPDATE, of the sides that read a column: the side of news the rows whose image the statement changed, as it put
 *   them, each counted 1, and as it found them, each -1; the side of olds those it found;
 * - DELETE: the side of news the rows the statement removed, each counted -1; the side of olds those it found.
 *
 * A statement whose rows change no image a side reads logs nothing. The function returns NEW, which PostgreSQL ignores
 * of an AFTER statement trigger.
 */
const addCapture = (
	b: InstallBuilder,
	t: JudgedTable,
	log: JudgeLog,
	after: ReadonlyArray<Node<"setup" | "validate">>,
	events: Set<TransitionEvent>
): void => {
	const relation = t.relation
	const named = identity.ruleCapture(relation.name)
	const fn = objectName(b.schema, b.name(named))
	const side = (s: ProbeSide): JudgedSide | undefined => t.sides.find((x) => x.side === s)
	const news = side("added")
	const olds = side("removed")
	/** A transition table a side reads its rows off, and the other one of an UPDATE, whose images it holds none of. */
	type Read = readonly [TransitionTable, TransitionTable | undefined]
	/**
	 * `side`'s array of the rows `reads` read, each a `captured` read of a transition table, the second's appended to the
	 * first's.
	 */
	const into = (
		s: JudgedSide,
		reads: readonly [Read] | readonly [Read, Read]
	): ReadonlyArray<PlStatement> =>
		reads.map(([rows, other], at) =>
			captured(b.schema, relation, s, rows, other, at === 0 ? undefined : deltaVariable(s.delta))
		)
	/** The statements of an event: each of `writes` into its side's array, then the logging of those sides. */
	const branch = (
		writes: NonEmptyReadonlyArray<{
			readonly side: JudgedSide
			readonly values: readonly [Read] | readonly [Read, Read]
		}>
	): NonEmptyReadonlyArray<PlStatement> =>
		appendNonEmpty(
			writes.flatMap((w) => into(w.side, w.values)),
			logged(
				log,
				mapNonEmpty(writes, (w) => w.side)
			)
		)
	const updatedSides = [news, olds].flatMap((s): ReadonlyArray<JudgedSide> =>
		s === undefined || s.read.length === 0 ? [] : [s]
	)
	const [u0, ...us] = updatedSides
	const [d0, ...ds] = [news, olds].flatMap((s): ReadonlyArray<JudgedSide> =>
		s === undefined ? [] : [s]
	)
	const branches = [
		...(news === undefined
			? []
			: [
					{
						event: "insert" as const,
						body: branch([{ side: news, values: [[transitionTables.news, undefined]] }])
					}
				]),
		...(u0 === undefined
			? []
			: [
					{
						event: "update" as const,
						body: branch(
							mapNonEmpty([u0, ...us], (s) => ({
								side: s,
								values:
									s.side === "added"
										? ([
												[transitionTables.news, transitionTables.olds],
												[transitionTables.olds, transitionTables.news]
											] as const)
										: ([[transitionTables.olds, transitionTables.news]] as const)
							}))
						)
					}
				]),
		...(d0 === undefined
			? []
			: [
					{
						event: "delete" as const,
						body: branch(
							mapNonEmpty([d0, ...ds], (s) => ({
								side: s,
								values: [[transitionTables.olds, undefined]] as const
							}))
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
			advice: noAdvice,
			language: "plpgsql",
			name: fn,
			params: [],
			returns: "trigger",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			body: {
				declare: [
					...t.sides.map((s) => ({ name: s.delta.name, type: deltaArrayType(b.schema, s.delta) })),
					{ name: captureNames.head, type: types.tid },
					{ name: captureNames.row, type: types.tid }
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
		[tableNode(b, relation), ...after]
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
