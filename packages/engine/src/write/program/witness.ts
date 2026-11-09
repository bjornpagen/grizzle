import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { appendAll } from "#compiler/core/array.ts"
import type {
	ColumnIdent,
	ConstraintName,
	LawId,
	ParamId,
	RelationIdent
} from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import {
	concatNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"
import type { Split } from "#compiler/ir/cells.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ExprTable, TypedLiteral } from "#compiler/ir/expr.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { ConstraintLawOf, DomainUse } from "#compiler/laws/model/model.ts"
import {
	compareValues,
	type EvalLeaves,
	evaluateTable,
	literalValue,
	type SqlValue,
	sqlNull,
	valueMember
} from "#compiler/scalar/compute/evaluate.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { ProgramPatterns } from "#compiler/scalar/regex/patterns.ts"
import { isAdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import { admitted, type Carrier, type CarrierHost } from "#compiler/scalar/values/identity.ts"
import type { KeyHost, Law, Witness } from "#compiler/types/changeset/changeset.ts"
import {
	type ColumnKey,
	closedLeaf,
	type Evaluation,
	evalValue,
	fieldKey,
	literalHost
} from "#compiler/write/family/fold.ts"
import {
	type GroupData,
	type InputData,
	inputSlotsOf,
	type SlotData
} from "#compiler/write/normalize/normalize.ts"
import { keyWitness } from "#compiler/write/program/outcome.ts"

/** A fact as the host states it: each field it carries, by name, its codec's admitted host value. */
type HostFact = { readonly [field: string]: unknown }

/**
 * A column of a stated row beyond the fields the ChangeSet states, as the host holds it: `filled`, the value the write
 * fills it at, as its stratum's plan draws it (a count or an end it recounts, a stored value its read found, a member's
 * index, copy or hidden accumulator), a nesting's walk fills it, or an owner its stratum inserts holds with its family
 * empty, one the reads found no stored row of or, in an `ifFresh` row, one they did not look up; or `unfilled`, a value
 * the host does not hold: a count or an end a stored owner keeps, which no read found, a query entry's row, a row whose
 * key PostgreSQL draws, or any column before the plan.
 */
export type FilledColumn =
	| { readonly kind: "filled"; readonly value: unknown }
	| { readonly kind: "unfilled" }

/**
 * A row a refused statement writes that the ChangeSet states, as the host judges it (write/program/bind.ts): the
 * fields the ChangeSet states, by name, its key and its caller's and serial fields, or a query entry's head, never a
 * count, an end or a copy; and every other column of its relation, a drawn or an accumulated field by its field key, a
 * law column by its own, as the write fills it. Its kind is what the host knows of the row the write leaves at its key:
 * - known: the row is as `filled` gives it, a column the host does not hold unfilled;
 * - ifFresh: an owner its action's INSERT inserts, which proposes only owners no stored row holds the key of
 *   (insert/statement.ts Proposal `unstored`), whose key no read of the write looked up: the INSERT writes it as
 *   `filled` gives it where no stored row holds its key, and nothing of it where one does, an exact repeat or the key
 *   law's refusal.
 */
export interface JudgedRow {
	readonly kind: "known" | "ifFresh"
	readonly stated: HostFact
	readonly filled: (column: ColumnKey) => FilledColumn
}

/**
 * One application's stated rows as its write fills them (write/program/bind.ts BoundWrite): the facts of one member
 * slot of a slot group's enumerated input, and a stratum's nested rows of a relation.
 */
export interface StatedRows {
	readonly slot: (group: GroupData, input: InputData, slot: SlotData) => ReadonlyArray<JudgedRow>
	readonly nested: (stratum: StratumAt, relation: string) => ReadonlyArray<JudgedRow>
}

/** A field of a written relation as the witness reads it: its name, its installed column, its type, and how it is
 * written, a generated field with its generation expression's table. */
export interface WitnessField {
	readonly name: string
	readonly column: ColumnIdent
	readonly type: ScalarType
	readonly writing:
		| { readonly kind: "caller" | "drawn" | "serial" | "accumulated" }
		| { readonly kind: "generated"; readonly expr: ExprTable }
}

/**
 * How a CHECK of a table that states laws judges a row: its row predicate (`CHECK ((p) IS TRUE)`); its containment into
 * a closed relation, its guard's conjuncts, its pairs, each a field of the row with the field of the closed side it
 * meets, unless one reads a law column, which the host leaves unjudged, and the side's key and payload fields and rows;
 * or a span field's endpoint at a contract's level.
 */
export type CheckTest =
	| { readonly kind: "row"; readonly predicate: ExprTable }
	| {
			readonly kind: "closed"
			readonly guard: ReadonlyArray<ExprTable>
			readonly pairs:
				| {
						readonly kind: "fields"
						readonly pairs: NonEmptyReadonlyArray<{
							readonly source: HeadingColumn
							readonly target: HeadingColumn
						}>
				  }
				| { readonly kind: "law" }
			readonly side: {
				readonly key: NonEmptyReadonlyArray<string>
				readonly payload: ReadonlyArray<string>
				readonly rows: ReadonlyArray<Split<TypedLiteral>>
			}
	  }
	| { readonly kind: "endpoint"; readonly field: string; readonly level: ScalarType }

/** A CHECK of a table that states laws, as data: its installed name, the laws it states, and how it judges a row. */
export interface LawCheckData {
	readonly name: ConstraintName
	readonly laws: NonEmptyReadonlyArray<ConstraintLawOf>
	readonly test: CheckTest
}

/**
 * A relation the ChangeSet writes, as the witness judges its rows: its name and installed table, its fields, its declared
 * keys by their fields' names, the primary key first, the law columns its families draw on it by key with their types,
 * and every CHECK of its table that states laws, the law model's and its spans' endpoint CHECKs.
 */
export interface WitnessTable {
	readonly name: string
	readonly ident: RelationIdent
	readonly fields: ReadonlyArray<WitnessField>
	readonly keys: ReadonlyArray<NonEmptyReadonlyArray<string>>
	readonly lawColumns: ReadonlyMap<ColumnKey, ScalarType>
	readonly checks: ReadonlyArray<LawCheckData>
}

/** A query entry a slot group writes through, as the witness reads it: its name, each head field with the target field
 * it writes, and each literal-fixed target field with its literal. */
export interface WitnessEntry {
	readonly entry: string
	readonly head: ReadonlyArray<{ readonly head: string; readonly field: string }>
	readonly fixed: ReadonlyArray<{
		readonly field: string
		readonly type: ScalarType
		readonly literal: TypedLiteral
	}>
}

/** An action of a stratum as the witness reads it: the relation it writes, and its source, described or a member slot. */
export interface WitnessAction {
	readonly relation: string
	readonly source:
		| { readonly kind: "described" }
		| { readonly kind: "slot"; readonly slot: ParamId }
}

/**
 * What the host judges a refused statement's stated rows by, decided when the write compiled
 * (write/program/decide.ts): each written relation, each stratum's actions in order, each query entry a slot group
 * writes through by its name, each law a CHECK states by its place in the theory's order of laws, and what the judge's
 * evaluator reads.
 */
export interface WitnessData {
	readonly tables: ReadonlyArray<WitnessTable>
	readonly actions: ReadonlyArray<ReadonlyArray<WitnessAction>>
	readonly entries: ReadonlyMap<string, WitnessEntry>
	readonly lawOrder: ReadonlyMap<LawId, number>
	readonly evaluation: Evaluation
}

/** A stated row's field as the host holds it: a field the ChangeSet states, or one its write fills; none for a
 * generated field, a field PostgreSQL draws, or a column the host does not hold. */
const hostField = (row: JudgedRow, field: Pick<WitnessField, "name" | "writing">): unknown => {
	switch (field.writing.kind) {
		case "caller":
		case "serial":
			return row.stated[field.name]
		case "drawn":
		case "accumulated": {
			const column = row.filled(fieldKey(field.name))
			return column.kind === "filled" ? column.value : undefined
		}
		case "generated":
			return undefined
	}
}

/**
 * What refused a statement, as PostgreSQL reported it on an object of the installation: a table constraint by its
 * owner and name; a domain's CHECK by the columns it types in the tables the statement writes, each with the law its
 * field states of it (DomainUse), none where the statement writes none of them, since PostgreSQL names the domain and
 * never the column; or a generated column's NOT NULL.
 */
export type Refuser =
	| { readonly kind: "constraint"; readonly owner: RelationIdent; readonly name: ConstraintName }
	| { readonly kind: "domain"; readonly uses: ReadonlyArray<DomainUse> }
	| { readonly kind: "generated"; readonly table: RelationIdent; readonly column: ColumnIdent }

/**
 * What a refused statement states, as the host reads it: the statement of a stratum's actions (ir.strata[stratum]
 * .actions), a write step's one or a single statement's parts', which writes exactly the facts their sources state, an
 * enumerated or streamed member's, which the host holds, or a described one's, which it does not; another write of
 * stored relations, by declared name, at its stratum, a family's statement or the fill of an action's member's carrier,
 * which casts the facts the action writes into the relation's types (artifact.ts CarrierCasts), stating every fact the
 * ChangeSet adds or puts into them there; a query entry's precheck, which casts the entry's own stated facts into its
 * target's types before any statement writes them; or a statement that states no fact the ChangeSet states: another
 * carrier's, an ANALYZE, a serial advance, a read-back, a family's stored-suffix read or the COMMIT.
 */
export type StatementAt =
	| {
			readonly kind: "actions"
			readonly stratum: StratumAt
			readonly actions: ReadonlyArray<number>
	  }
	| {
			readonly kind: "write"
			readonly stratum: StratumAt
			readonly relations: ReadonlyArray<string>
	  }
	| { readonly kind: "precheck"; readonly stratum: StratumAt; readonly entry: string }
	| { readonly kind: "unstated" }

/**
 * Which laws a refusal names, as the host decides them (README "Errors and outcomes"):
 * - every: a table CHECK's refusal of a row the ChangeSet states, every one of whose table's law-stating CHECKs the host
 *   judges: every law of them the row breaks, in the theory's order of laws (its primary keys', then its statements' in
 *   canonical order), whichever of them PostgreSQL tried first; or a domain's refusal of a row the ChangeSet states,
 *   every one of whose columns the domain types the host judges: the law of each of them whose value it refuses;
 * - first: a table CHECK's refusal where no stated row breaks it, or where the row that breaks it has a law CHECK the
 *   host leaves unjudged, which the row may break too: the laws of the CHECK PostgreSQL tried first, which it orders
 *   by the CHECKs' installed names, an order no version keeps;
 * - object: any other refusal, a domain's where no stated row breaks it or the row that breaks it has a column the
 *   host leaves unjudged: the laws its one object discharges that the statement can break, which the classifier names,
 *   decided where there is one and `some` where there are several.
 */
export type RefusedLaws =
	| { readonly kind: "every"; readonly laws: NonEmptyReadonlyArray<Law> }
	| { readonly kind: "first" }
	| { readonly kind: "object" }

const refusedFirst: RefusedLaws = Object.freeze({ kind: "first" })
const refusedByObject: RefusedLaws = Object.freeze({ kind: "object" })

/**
 * What the host makes of a refused statement: the witness of a fact it states that breaks what refused it, or
 * `unreported`, and which laws the refusal names (RefusedLaws); see hostJudgement.
 */
export interface HostJudgement {
	readonly witness: Witness
	readonly laws: RefusedLaws
}

/** One row a statement states, as the host judges it: its written relation, its row as the write fills it, and its
 * witness in its caller's words. */
interface StatedFact {
	readonly relation: WitnessTable
	readonly row: JudgedRow
	readonly witness: Witness
}

/**
 * The facts a refused statement states, in the order the host judges them, and which of the rows it writes they are:
 * `every` one, an `ifFresh` one written only where no stored row holds its key, as the statement of a stratum's
 * enumerated and streamed actions writes exactly their facts; or `some`, beside rows the ChangeSet does not state, a
 * described action's, a family's re-placed members, counts and refills, which the host does not hold.
 */
interface StatementFacts {
	readonly rows: "every" | "some"
	readonly facts: ReadonlyArray<StatedFact>
}

/** How the host judges one stated fact against what refused its statement. */
type Verdict = "breaks" | "holds" | "unjudged"

/** The unreported witness: no fact the ChangeSet states is one the host finds breaking the law. */
const unreported: Witness = Object.freeze({ kind: "unreported" })

/** Whether an admitted value is a set's. */
const isSet = (value: CarrierHost[Carrier]): value is ReadonlySet<string> => value instanceof Set

/** A key field's admitted value as a key value, or undefined for a set's or bytes', which no key holds. */
const keyHost = (value: CarrierHost[Carrier]): KeyHost | undefined =>
	isSet(value) || isAdmittedBytes(value) ? undefined : value

/**
 * What the witness reads, prepared once from its data under the installation's codes (`WitnessData`): its judge, its
 * written relations by name, its slot groups, and each member slot with its group and input.
 */
export interface Witnessing {
	readonly data: WitnessData
	readonly codes: Codebook
	readonly judge: Judge
	readonly tables: ReadonlyMap<string, WitnessTable>
	readonly groups: ReadonlyArray<GroupData>
	readonly slots: ReadonlyMap<
		ParamId,
		{ readonly group: GroupData; readonly input: InputData; readonly slot: SlotData }
	>
}

/** A written relation's field by its name, which its data holds. */
const fieldOf = (relation: WitnessTable, name: string): WitnessField =>
	defined(
		relation.fields.find((f) => f.name === name),
		`the field ${relation.name}.${name}`
	)

/**
 * The key a fact of `relation` states, its first declared key whose every field it carries, the primary key first;
 * undefined where it carries none whole, as a generated addition omits the serial fields its identity draws.
 */
const statedKey = (
	relation: WitnessTable,
	row: JudgedRow,
	codes: Codebook
): Readonly<Record<string, KeyHost>> | undefined => {
	for (const key of relation.keys) {
		const values: Record<string, KeyHost> = {}
		let whole = true
		for (const name of key) {
			const f = fieldOf(relation, name)
			const raw = hostField(row, f)
			const value =
				raw === undefined ? undefined : keyHost(admitted(carrierSpecOf(f.type, codes), raw))
			if (value === undefined) {
				whole = false
				break
			}
			values[f.name] = value
		}
		if (whole) {
			return values
		}
	}
	return undefined
}

/** A query entry's fact as a fact of its target: each head field under the target field it writes, a literal-fixed
 * field at its literal; a context-fixed field, whose value the claims hold, left out. */
const targetFact = (entry: WitnessEntry, fact: HostFact, codes: Codebook): HostFact => {
	const out: Record<string, unknown> = {}
	for (const { head, field } of entry.head) {
		if (Object.hasOwn(fact, head)) {
			out[field] = fact[head]
		}
	}
	for (const fixed of entry.fixed) {
		out[fixed.field] = literalHost(carrierSpecOf(fixed.type, codes), fixed.literal)
	}
	return out
}

/** A target's key values in a query entry's words: each head field's, by the target field it writes
 * (write/frontend/entry.ts entryKey). */
const entryKey = <V>(
	entry: WitnessEntry,
	values: Readonly<Record<string, V>>
): Readonly<Record<string, V>> => {
	const out: Record<string, V> = {}
	for (const { head, field } of entry.head) {
		const value = values[field]
		if (value !== undefined) {
			out[head] = value
		}
	}
	return Object.freeze(out)
}

/** The entry a slot group writes through, by the name its facts are stated under, when it is no relation's own. */
const entryOf = (w: Witnessing, group: GroupData): WitnessEntry | undefined =>
	group.facts.name === group.relation ? undefined : w.data.entries.get(group.facts.name)

/** A written relation by its name, which the witness's data holds. */
const tableOf = (w: Witnessing, name: string): WitnessTable =>
	defined(w.tables.get(name), `the written relation ${name}`)

/**
 * The facts one member slot of a slot group's input states that its statement adds or puts into `relation`, its
 * written relation: its normal facts, a query entry's as facts of its target, each with its witness, the key it was
 * stated at in the words it was stated in.
 */
const slotFacts = (
	w: Witnessing,
	stated: StatedRows,
	group: GroupData,
	input: InputData,
	slot: SlotData,
	relation: WitnessTable
): ReadonlyArray<StatedFact> => {
	const codes = w.codes
	const entry = entryOf(w, group)
	return stated.slot(group, input, slot).map((written): StatedFact => {
		const row: JudgedRow =
			entry === undefined
				? written
				: {
						kind: written.kind,
						stated: targetFact(entry, written.stated, codes),
						filled: written.filled
					}
		const key = statedKey(relation, row, codes)
		return {
			relation,
			row,
			witness:
				key === undefined
					? unreported
					: entry === undefined
						? keyWitness(relation.name, key)
						: keyWitness(entry.entry, entryKey(entry, key))
		}
	})
}

/** The facts one slot group of the ChangeSet states for `relation` (slotFacts): each insert's and put's, none of a
 * deletion's, which writes no row a CHECK judges. */
const groupFacts = (
	w: Witnessing,
	stated: StatedRows,
	group: GroupData,
	relation: WitnessTable
): ReadonlyArray<StatedFact> =>
	group.inputs.flatMap((input) =>
		input.kind === "single" && input.act.op === "delete"
			? []
			: inputSlotsOf(input).flatMap((slot) => slotFacts(w, stated, group, input, slot, relation))
	)

/**
 * The facts the ChangeSet states for `relation` at `stratum` that a write adds or puts: every slot group's of it
 * (groupFacts), and each nested row the stratum inserts into it, each with its witness.
 */
const writtenFacts = (
	w: Witnessing,
	stated: StatedRows,
	stratum: StratumAt,
	relation: WitnessTable
): ReadonlyArray<StatedFact> => {
	const out: Array<StatedFact> = []
	for (const group of w.groups) {
		if (group.stratum === stratum && group.relation === relation.name) {
			appendAll(out, groupFacts(w, stated, group, relation))
		}
	}
	for (const row of stated.nested(stratum, relation.name)) {
		const key = statedKey(relation, row, w.codes)
		out.push({
			relation,
			row,
			witness: key === undefined ? unreported : keyWitness(relation.name, key)
		})
	}
	return out
}

/** The facts the ChangeSet states for each of `relations` at `stratum` (writtenFacts), relation by relation. */
const relationsFacts = (
	w: Witnessing,
	stated: StatedRows,
	stratum: StratumAt,
	relations: ReadonlyArray<string>
): ReadonlyArray<StatedFact> =>
	relations.flatMap((name) => {
		const relation = w.tables.get(name)
		return relation === undefined ? [] : writtenFacts(w, stated, stratum, relation)
	})

/** The actions of `stratum` a statement writes, by their indices among the stratum's. */
const actionsAt = (
	w: Witnessing,
	at: Extract<StatementAt, { readonly kind: "actions" }>
): ReadonlyArray<WitnessAction> =>
	at.actions.map((index) =>
		defined(
			w.data.actions[at.stratum]?.[index],
			`action ${index} of stratum ${at.stratum}, whose statement was refused`
		)
	)

/**
 * The facts the member slot an enumerated or streamed action of `stratum` reads states (slotFacts): none of a
 * deletion's, which writes no row a CHECK judges.
 */
const actionSlotFacts = (
	w: Witnessing,
	stated: StatedRows,
	stratum: StratumAt,
	slot: ParamId
): ReadonlyArray<StatedFact> => {
	const at = w.slots.get(slot)
	if (at === undefined || at.group.stratum !== stratum) {
		throw defect(`the slot group of the member slot ${slot} an action of stratum ${stratum} reads`)
	}
	return at.input.kind === "single" && at.input.act.op === "delete"
		? []
		: slotFacts(w, stated, at.group, at.input, at.slot, tableOf(w, at.group.relation))
}

/**
 * The facts the statement of a stratum's actions states (StatementFacts): `every` row it writes, each action's member
 * slot's facts, where each reads an enumerated or a streamed member; where one reads a described member, whose rows
 * only PostgreSQL computes, `some`, the facts the ChangeSet states for their relations at the stratum.
 */
const actionsFacts = (
	w: Witnessing,
	stated: StatedRows,
	at: Extract<StatementAt, { readonly kind: "actions" }>
): StatementFacts => {
	const actions = actionsAt(w, at)
	const slots: Array<ParamId> = []
	for (const action of actions) {
		switch (action.source.kind) {
			case "described":
				return {
					rows: "some",
					facts: relationsFacts(
						w,
						stated,
						at.stratum,
						actions.map((a) => a.relation)
					)
				}
			case "slot":
				slots.push(action.source.slot)
		}
	}
	return {
		rows: "every",
		facts: slots.flatMap((slot) => actionSlotFacts(w, stated, at.stratum, slot))
	}
}

/** The slot groups of a query entry's precheck: the entry's own at its stratum. */
const precheckGroups = (
	w: Witnessing,
	at: Extract<StatementAt, { readonly kind: "precheck" }>
): ReadonlyArray<GroupData> =>
	w.groups.filter((group) => group.stratum === at.stratum && group.facts.name === at.entry)

/**
 * The stored relations a refused statement writes or casts its facts into, by declared name: its actions', a write's
 * own, a query entry's precheck's target, whose types the precheck casts the entry's facts into, and none of a
 * statement that states no fact.
 */
export const statementRelations = (w: Witnessing, at: StatementAt): ReadonlyArray<string> => {
	switch (at.kind) {
		case "actions":
			return [...new Set(actionsAt(w, at).map((action) => action.relation))]
		case "write":
			return at.relations
		case "precheck":
			return [...new Set(precheckGroups(w, at).map((group) => group.relation))]
		case "unstated":
			return []
	}
}

/**
 * The facts a refused statement states, in the order the host judges them (StatementFacts): its actions'
 * (actionsFacts); a write's, relation by relation in its order (writtenFacts); a query entry's precheck's, the entry's
 * own slot groups' at its stratum (groupFacts).
 */
const statedFacts = (w: Witnessing, stated: StatedRows, at: StatementAt): StatementFacts => {
	switch (at.kind) {
		case "actions":
			return actionsFacts(w, stated, at)
		case "write":
			return { rows: "some", facts: relationsFacts(w, stated, at.stratum, at.relations) }
		case "precheck":
			return {
				rows: "some",
				facts: precheckGroups(w, at).flatMap((group) =>
					groupFacts(w, stated, group, tableOf(w, group.relation))
				)
			}
		case "unstated":
			return { rows: "some", facts: [] }
	}
}

/** What an expression is over one row, as PostgreSQL computes it by its three-valued logic (scalar/compute/evaluate.ts
 * sqlNull): a value, NULL, or unknown to the host. */
type Evaluated =
	| { readonly kind: "value"; readonly value: CarrierValue }
	| { readonly kind: "null" }
	| { readonly kind: "unknown" }

/**
 * The judge of one installation's stated rows on the host: an expression's value over a row, a host value as the
 * evaluator holds it at a type, and whether a value is a member of a type.
 */
interface Judge {
	readonly evaluate: (relation: WitnessTable, expr: ExprTable, row: JudgedRow) => Evaluated
	readonly carried: (value: unknown, type: ScalarType) => CarrierValue | undefined
	readonly member: (value: CarrierValue, type: ScalarType) => boolean | undefined
}

/** The judge of a write's stated rows by what its witness data's evaluation reads, every pattern parsed here once. */
const judgeOf = (evaluation: Evaluation, codes: Codebook): Judge => {
	const patterns = ProgramPatterns.of(evaluation.patterns)
	const closed = closedLeaf(evaluation.closed)
	const evaluate = (relation: WitnessTable, expr: ExprTable, row: JudgedRow): Evaluated => {
		/**
		 * A column's value: a field the row states or its write fills, a generated field's as PostgreSQL generates it
		 * from the row, NULL included, or a law column its write fills; none where the host does not hold it.
		 */
		const valueOf = (name: string): SqlValue | undefined => {
			const declared = relation.fields.find((f) => f.name === name)
			if (declared === undefined) {
				const key: ColumnKey = `law:${name}`
				const type = relation.lawColumns.get(key)
				const column = row.filled(key)
				return type === undefined || column.kind === "unfilled"
					? undefined
					: evalValue(carrierSpecOf(type, codes), column.value)
			}
			if (declared.writing.kind === "generated") {
				const generated = evaluate(relation, declared.writing.expr, row)
				return generated.kind === "value"
					? generated.value
					: generated.kind === "null"
						? sqlNull
						: undefined
			}
			const value = hostField(row, declared)
			return value === undefined ? undefined : evalValue(carrierSpecOf(declared.type, codes), value)
		}
		const leaves: EvalLeaves = { value: undefined, column: (ref) => valueOf(ref.name), closed }
		const value = evaluateTable(expr.exprs, expr.root, leaves, patterns)
		return !value.ok
			? { kind: "unknown" }
			: value.value === sqlNull
				? { kind: "null" }
				: { kind: "value", value: value.value }
	}
	return {
		evaluate,
		carried: (value, type) => evalValue(carrierSpecOf(type, codes), value),
		member: (value, type) => valueMember(value, type, patterns)
	}
}

/**
 * The witness of a write, prepared once from its data and its slot groups under the installation's codes
 * (`Witnessing`): where the write compiles, and where a served login loads it.
 */
export const prepareWitness = (
	data: WitnessData,
	groups: ReadonlyArray<GroupData>,
	codes: Codebook
): Witnessing => {
	const slots = new Map<
		ParamId,
		{ readonly group: GroupData; readonly input: InputData; readonly slot: SlotData }
	>()
	for (const group of groups) {
		for (const input of group.inputs) {
			for (const slot of inputSlotsOf(input)) {
				slots.set(slot.slot, { group, input, slot })
			}
		}
	}
	return Object.freeze({
		data,
		codes,
		judge: judgeOf(data.evaluation, codes),
		tables: new Map(data.tables.map((t) => [t.name, t] as const)),
		groups,
		slots
	})
}

/**
 * A stated row's field as a domain's CHECK reads it: the host's value of a field the ChangeSet states or its write
 * fills, and a generated field's value as PostgreSQL generates it from the row, NULL included, which every domain
 * admits; none where the host does not hold or cannot evaluate it.
 */
const domainValue = (
	judge: Judge,
	relation: WitnessTable,
	row: JudgedRow,
	field: WitnessField
): Evaluated => {
	if (field.writing.kind === "generated") {
		return judge.evaluate(relation, field.writing.expr, row)
	}
	const host = hostField(row, field)
	const carried = host === undefined ? undefined : judge.carried(host, field.type)
	return carried === undefined ? { kind: "unknown" } : { kind: "value", value: carried }
}

/** A row CHECK's verdict, as `CHECK ((p) IS TRUE)` judges it: FALSE and NULL break it. */
const checked = (e: Evaluated): Verdict => {
	switch (e.kind) {
		case "value":
			return e.value === false ? "breaks" : e.value === true ? "holds" : "unjudged"
		case "null":
			return "breaks"
		case "unknown":
			return "unjudged"
	}
}

/**
 * Whether a value breaks one level of its type, the level `at`, as that level's domain or endpoint CHECK judges it: it
 * is a value of every level below `at` and not of `at`. A value outside a lower level is that level's refusal.
 */
const breaksLevel = (judge: Judge, value: CarrierValue, at: ScalarType): Verdict => {
	const below = contractOf(at)?.base
	const inner = below === undefined ? true : judge.member(value, below)
	const whole = judge.member(value, at)
	if (inner === undefined || whole === undefined || !inner) {
		return "unjudged"
	}
	return whole ? "holds" : "breaks"
}

/** The levels of a type, outermost first: the type, then each contract's base. */
const levels = (t: ScalarType): ReadonlyArray<ScalarType> => {
	const base = contractOf(t)?.base
	return base === undefined ? [t] : [t, ...levels(base)]
}

/** A containment into a closed relation, as its CHECK judges a row: held when its guard holds and no row of the
 * target's side meets the row at every pair. */
const closedContainment = (
	judge: Judge,
	relation: WitnessTable,
	test: Extract<CheckTest, { readonly kind: "closed" }>,
	row: JudgedRow,
	codes: Codebook
): Verdict => {
	for (const g of test.guard) {
		const guard = checked(judge.evaluate(relation, g, row))
		if (guard !== "holds") {
			return guard === "breaks" ? "holds" : "unjudged"
		}
	}
	if (test.pairs.kind === "law") {
		return "unjudged"
	}
	const sources: Array<{ readonly value: CarrierValue; readonly target: HeadingColumn }> = []
	for (const pair of test.pairs.pairs) {
		const raw = hostField(row, fieldOf(relation, pair.source.name))
		const value =
			raw === undefined ? undefined : evalValue(carrierSpecOf(pair.source.type, codes), raw)
		if (value === undefined) {
			return "unjudged"
		}
		sources.push({ value, target: pair.target })
	}
	const cellAt = (name: string, cells: Split<TypedLiteral>): TypedLiteral | undefined => {
		const k = test.side.key.indexOf(name)
		return k >= 0 ? cells.key[k] : cells.payload[test.side.payload.indexOf(name)]
	}
	for (const cells of test.side.rows) {
		const meets = sources.every(({ value, target }) => {
			const cell = cellAt(target.name, cells)
			return cell !== undefined && compareValues(value, literalValue(cell), target.type) === 0
		})
		if (meets) {
			return "holds"
		}
	}
	return "breaks"
}

/** A span's endpoints as the host holds them, each an endpoint value. */
const endpointsOf = (value: unknown): ReadonlyArray<unknown> =>
	typeof value === "object" && value !== null && "start" in value && "end" in value
		? [value.start, value.end]
		: []

/** The verdict of the first of `verdicts` that decides: a break, else a hold, else unjudged. */
/**
 * What the NOT NULL of each of a row's generated fields makes of it: PostgreSQL checks every NOT NULL of a row before
 * any CHECK of it, so a row whose generated field's expression is NULL is refused there, and no CHECK of its table
 * judges it; "unknown" where the host cannot evaluate one of them.
 */
const generatedNotNulls = (
	judge: Judge,
	relation: WitnessTable,
	row: JudgedRow
): "hold" | "refuse" | "unknown" => {
	const values = relation.fields.flatMap((field) =>
		field.writing.kind === "generated" ? [judge.evaluate(relation, field.writing.expr, row)] : []
	)
	return values.some((v) => v.kind === "null")
		? "refuse"
		: values.some((v) => v.kind === "unknown")
			? "unknown"
			: "hold"
}

const firstBreak = (verdicts: ReadonlyArray<Verdict>): Verdict =>
	verdicts.includes("breaks")
		? "breaks"
		: verdicts.length > 0 && verdicts.every((v) => v === "holds")
			? "holds"
			: "unjudged"

/**
 * A CHECK of a table that states laws, as the host judges it: its installed name, the laws it states, each with its
 * description, and its verdict on one stated row of its table.
 */
interface LawCheck {
	readonly name: ConstraintName
	readonly laws: NonEmptyReadonlyArray<ConstraintLawOf>
	readonly verdict: (row: JudgedRow) => Verdict
}

/**
 * Every CHECK of `relation`'s table that states laws, as the host judges it (`LawCheckData`): its row CHECKs, its
 * containments into closed relations, and its spans' endpoint CHECKs of a contract. Its span shape, width and date range
 * CHECKs state none: the codec refuses what they would before any SQL.
 */
const lawChecks = (
	judge: Judge,
	relation: WitnessTable,
	codes: Codebook
): ReadonlyArray<LawCheck> =>
	relation.checks.map((check): LawCheck => {
		const test = check.test
		switch (test.kind) {
			case "row":
				return {
					name: check.name,
					laws: check.laws,
					verdict: (row) => checked(judge.evaluate(relation, test.predicate, row))
				}
			case "closed":
				return {
					name: check.name,
					laws: check.laws,
					verdict: (row) => closedContainment(judge, relation, test, row, codes)
				}
			case "endpoint": {
				const field = fieldOf(relation, test.field)
				return {
					name: check.name,
					laws: check.laws,
					verdict: (row) =>
						firstBreak(
							endpointsOf(hostField(row, field)).map((endpoint) => {
								const carried = judge.carried(endpoint, test.level)
								return carried === undefined ? "unjudged" : breaksLevel(judge, carried, test.level)
							})
						)
				}
			}
		}
	})

/**
 * A law CHECK's verdict on a stated row, as PostgreSQL meets it: a row whose generated field's NOT NULL refuses it
 * never reaches its CHECKs (generatedNotNulls).
 */
const checkVerdict = (
	judge: Judge,
	relation: WitnessTable,
	check: LawCheck,
	row: JudgedRow
): Verdict => {
	const notNulls = generatedNotNulls(judge, relation, row)
	return notNulls === "hold" ? check.verdict(row) : notNulls === "refuse" ? "holds" : "unjudged"
}

/**
 * The laws a refused row names, `refusing` the CHECK PostgreSQL reported among its table's law CHECKs `checks`:
 * `every` law of those CHECKs the row breaks, each once, in the theory's order of laws, so neither the order PostgreSQL
 * tries CHECKs in nor their installed names decide it, where the host judges every one of them; `first`, the CHECK
 * PostgreSQL reported, where it leaves one unjudged, which the row may break too.
 */
const refusedLaws = (
	w: Witnessing,
	judge: Judge,
	relation: WitnessTable,
	refusing: LawCheck,
	checks: ReadonlyArray<LawCheck>,
	row: JudgedRow
): RefusedLaws => {
	const judged = checks.map((check) => ({
		check,
		verdict: checkVerdict(judge, relation, check, row)
	}))
	return judged.some((j) => j.verdict === "unjudged")
		? refusedFirst
		: {
				kind: "every",
				laws: brokenLaws(
					w,
					refusing,
					judged.flatMap((j) => (j.verdict === "breaks" ? [j.check] : []))
				)
			}
}

/** The laws of `broken`, a row's broken law CHECKs, and of `refusing`, each once, in the theory's order of laws. */
const brokenLaws = (
	w: Witnessing,
	refusing: LawCheck,
	broken: ReadonlyArray<LawCheck>
): NonEmptyReadonlyArray<Law> => {
	const order = (law: LawId): number =>
		defined(w.data.lawOrder.get(law), `the place of law ${law} in the theory's order`)
	const [head, ...rest] = concatNonEmpty(
		broken.flatMap((c) => c.laws),
		refusing.laws
	)
	const once: NonEmptyReadonlyArray<ConstraintLawOf> = [
		head,
		...rest.filter((l, i) => l.law !== head.law && rest.findIndex((m) => m.law === l.law) === i)
	]
	return mapNonEmpty(
		sortNonEmpty(once, (a, b) => order(a.law) - order(b.law)),
		(l) => l.described
	)
}

/**
 * Whether one level of a type is the one a domain's law states of a column it types: a contract's level its contract's
 * law, and the column's structural text level, which no contract wraps, its field's pattern law. No other law is a
 * type level's.
 */
const levelStates = (level: ScalarType, law: Law): boolean => {
	switch (law.kind) {
		case "contract":
			return contractOf(level)?.name === law.contract
		case "pattern":
			return contractOf(level) === undefined
		case "primaryKey":
		case "key":
		case "check":
		case "contained":
		case "coverage":
		case "family":
		case "tree":
		case "fold":
		case "generated":
		case "above":
			return false
	}
}

/** How the host judges one stated row against what refused its statement: it breaks it, and the refusal names the laws
 * `laws` says; it holds it, so it is not the row refused; or the host leaves it unjudged. */
type RowJudgement =
	| { readonly kind: "breaks"; readonly laws: RefusedLaws }
	| { readonly kind: "holds" }
	| { readonly kind: "unjudged" }

const holds: RowJudgement = Object.freeze({ kind: "holds" })
const unjudged: RowJudgement = Object.freeze({ kind: "unjudged" })

/** A verdict's judgement of a row it does not break: holding, or unjudged. */
const unbroken = (verdict: Exclude<Verdict, "breaks">): RowJudgement =>
	verdict === "holds" ? holds : unjudged

/**
 * How the host judges each stated row against one refuser (`row`), and the laws the refusal names where no stated row
 * breaks it (`none`).
 */
interface RefuserJudge {
	readonly row: (relation: WitnessTable, row: JudgedRow) => RowJudgement
	readonly none: RefusedLaws
}

/**
 * How the host judges a stated row of `relation` against a refusing domain, `uses` the columns it types in the tables
 * the statement writes: each of the row's columns among them at the level of its type its law states (levelStates), a
 * generated field at the value PostgreSQL generates into its domain from the row (domainValue). The row breaks the
 * domain where one of them breaks. Where the host judges every one of them, the refusal names `every` law of those
 * that break, each once, in the domain's order of its uses; where it leaves one unjudged, which the row may break too,
 * the laws of the one object, which the classifier names.
 */
const domainRow = (
	judge: Judge,
	relation: WitnessTable,
	uses: ReadonlyArray<DomainUse>,
	row: JudgedRow
): RowJudgement => {
	const typed = new Map(
		uses.flatMap((use, order) =>
			use.table === relation.ident ? [[use.column, { use, order }] as const] : []
		)
	)
	const judged = relation.fields.flatMap((field) => {
		const at = typed.get(field.column)
		if (at === undefined) {
			return []
		}
		return levels(field.type).flatMap((level) => {
			if (!levelStates(level, at.use.law.described)) {
				return []
			}
			const value = domainValue(judge, relation, row, field)
			const verdict: Verdict =
				value.kind === "value"
					? breaksLevel(judge, value.value, level)
					: value.kind === "null"
						? "holds"
						: "unjudged"
			return [{ ...at, verdict }]
		})
	})
	const broken = judged
		.filter((j) => j.verdict === "breaks")
		.toSorted((a, b) => a.order - b.order)
		.map((j) => j.use.law)
	const [head, ...rest] = broken
	if (head === undefined) {
		return judged.some((j) => j.verdict === "unjudged") ? unjudged : holds
	}
	if (judged.some((j) => j.verdict === "unjudged")) {
		return { kind: "breaks", laws: refusedByObject }
	}
	const once: NonEmptyReadonlyArray<ConstraintLawOf> = [
		head,
		...rest.filter((l, i) => l.law !== head.law && rest.findIndex((m) => m.law === l.law) === i)
	]
	return { kind: "breaks", laws: { kind: "every", laws: mapNonEmpty(once, (l) => l.described) } }
}

/** How the host judges stated rows against `refuser` (RefuserJudge). */
const refuserJudge = (w: Witnessing, refuser: Refuser): RefuserJudge => {
	const judge = w.judge
	switch (refuser.kind) {
		case "generated":
			return {
				row: (relation, row) => {
					const field = relation.fields.find((f) => f.column === refuser.column)
					if (relation.ident !== refuser.table || field?.writing.kind !== "generated") {
						return holds
					}
					switch (judge.evaluate(relation, field.writing.expr, row).kind) {
						case "null":
							return { kind: "breaks", laws: refusedByObject }
						case "value":
							return holds
						case "unknown":
							return unjudged
					}
				},
				none: refusedByObject
			}
		case "domain":
			return {
				row: (relation, row) => domainRow(judge, relation, refuser.uses, row),
				none: refusedByObject
			}
		case "constraint": {
			const table = w.data.tables.find((r) => r.ident === refuser.owner)
			const checks = table === undefined ? [] : lawChecks(judge, table, w.codes)
			const refusing = checks.find((c) => c.name === refuser.name)
			if (refusing === undefined) {
				return { row: () => unjudged, none: refusedByObject }
			}
			return {
				row: (relation, row) => {
					if (relation.ident !== refuser.owner) {
						return holds
					}
					const verdict = checkVerdict(judge, relation, refusing, row)
					return verdict === "breaks"
						? {
								kind: "breaks",
								laws: refusedLaws(w, judge, relation, refusing, checks, row)
							}
						: unbroken(verdict)
				},
				none: refusedFirst
			}
		}
	}
}

/**
 * Witnessing a native refusal on the host.
 *
 * PostgreSQL states the row a CHECK, a domain's CHECK or a generated column's NOT NULL refused only in its message's
 * prose, which grizzle never reads. The host holds what the refused statement wrote wherever the ChangeSet states it:
 * an enumerated insert's or put's facts, a query entry's as facts of its target, and a nesting's rows, each as its
 * write fills it (`StatedRows`): its counts, ends, indexes and copies at the values its stratum's plan draws, never at
 * the starts its slot carries, and a value the host does not hold unfilled. So it judges each of them, by the one host
 * evaluation of a check's expression (scalar/compute/evaluate.ts) over the row's fields, the generated fields
 * PostgreSQL computes from them and the law columns its write fills, against what PostgreSQL reported:
 *
 * - a row CHECK, `CHECK ((p) IS TRUE)`: a fact at which p is FALSE, or NULL by SQL's three-valued logic, a closed read
 *   at a key its relation holds no row at left unknown; never a fact a generated field's NOT NULL refuses, which
 *   PostgreSQL checks before any CHECK of its row (generatedNotNulls);
 * - a containment into a closed relation, a table CHECK: a fact its guard is true of, never one it leaves unknown, that
 *   no row of the target's side meets at every pair;
 * - a span's endpoint CHECK of a contract: a fact whose span has an endpoint inside every level below the contract
 *   and outside the contract;
 * - a domain's CHECK, a contract's or a pattern's: a fact one of whose columns the domain types in the statement's
 *   tables holds a value inside every level below its law's and outside its law's own, a generated field the value
 *   PostgreSQL generates into its domain from the row (domainRow);
 * - a generated column's NOT NULL: a fact at which its generation expression is NULL, by a closed read at a key its
 *   relation holds no row at.
 *
 * The host never decides whether a write is refused: PostgreSQL has refused it. The host only names a row that breaks
 * what refused it, its witness the key it was stated at, in the words it was stated in (a query entry's, through
 * `entryKey`), and the laws it breaks where it judges every law CHECK of its table (`refusedLaws`) or every column of
 * its the domain types (`domainRow`):
 *
 * - the first `known` row the statement states that breaks it (statedFacts: its actions' in their order, a write's in
 *   its relations' order, a query entry's precheck's in its own), whose row is as the write fills it;
 * - else an `ifFresh` row, an owner no read looked up, which its INSERT writes only where no stored row holds its key,
 *   only where the statement writes `every` row the host judges and the host finds that row the one not holding it:
 *   PostgreSQL refused a row the statement wrote, so the INSERT wrote it, no stored row held its key, and it is as the
 *   host fills it. Where several such rows may be the one refused, as a stored owner inserted again beside a new one,
 *   the host names none of them.
 *
 * Where the host finds none (a row only PostgreSQL computes, a query's, a row whose law reads a value the host does not
 * hold or cannot evaluate, one stated with no whole key, as a generated addition's identity is drawn, or one of several
 * owners no read looked up), the witness is `unreported`.
 */
export const hostJudgement = (
	w: Witnessing,
	stated: StatedRows,
	at: StatementAt,
	refuser: Refuser
): HostJudgement => {
	const judging = refuserJudge(w, refuser)
	const { rows, facts } = statedFacts(w, stated, at)
	const judged = facts.map((fact) => ({ fact, judged: judging.row(fact.relation, fact.row) }))
	for (const { fact, judged: j } of judged) {
		if (fact.row.kind === "known" && j.kind === "breaks") {
			return { witness: fact.witness, laws: j.laws }
		}
	}
	const [only, ...others] = judged.filter((j) => j.judged.kind !== "holds")
	return rows === "every" && only?.judged.kind === "breaks" && !isNonEmpty(others)
		? { witness: only.fact.witness, laws: only.judged.laws }
		: { witness: unreported, laws: judging.none }
}
