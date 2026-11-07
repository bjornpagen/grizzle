import type { CheckedEntry, RoleWorld } from "#compiler/analysis/schema.ts"
import { contractLaw } from "#compiler/analysis/theory/description.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { appendAll } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ColumnIdent, ConstraintName, LawId, RelationIdent } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import {
	concatNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"
import type { Split } from "#compiler/ir/cells.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { predicateTable, type ScalarExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { LawField, NativeOf, RelationInfo, TableRelation } from "#compiler/ir/law.ts"
import { baseOf, contractOf, type ScalarType, spanOf } from "#compiler/ir/scalar.ts"
import type {
	ConstraintLawOf,
	ConstraintNativeKind,
	DomainUse
} from "#compiler/laws/model/model.ts"
import {
	compareValues,
	type EvalLeaves,
	evaluateTable,
	literalValue,
	type SqlValue,
	sqlNull,
	valueMember
} from "#compiler/scalar/compute/evaluate.ts"
import { type CarrierValue, irLiteral } from "#compiler/scalar/compute/literal.ts"
import { isBytes } from "#compiler/scalar/values/bytes.ts"
import { admitted, type Carrier, type CarrierHost } from "#compiler/scalar/values/identity.ts"
import type { KeyHost, Law, Witness } from "#compiler/types/changeset/changeset.ts"
import {
	type ClosedRows,
	type ColumnKey,
	closedLeaf,
	evalValue,
	fieldKey,
	literalHost
} from "#compiler/write/family/fold.ts"
import { rowLayout } from "#compiler/write/family/statements.ts"
import {
	type EnumeratedInput,
	inputSlots,
	type MemberSlot,
	type SlotGroup,
	type WriteFrontend
} from "#compiler/write/frontend/compile.ts"
import { entryKey } from "#compiler/write/frontend/entry.ts"
import { keyWitness } from "#compiler/write/program/outcome.ts"

/** A fact as the host states it: each field it carries, by name, its codec's admitted host value. */
type HostFact = { readonly [field: string]: unknown }

/**
 * A column of a stated row beyond the fields the ChangeSet states, as the host holds it: `filled`, the value the write
 * fills it at, as its stratum's plan draws it (a count or an end it recounts, a stored value its read found, a member's
 * index, copy or hidden accumulator), a nesting's walk fills it, or an owner its stratum inserts holds with its family
 * empty; or `unfilled`, a value the host does not hold: a count or an end a put of an owner keeps from the stored row
 * no read found, a query entry's row, a row whose key PostgreSQL draws, or any column before the plan.
 */
export type FilledColumn =
	| { readonly kind: "filled"; readonly value: unknown }
	| { readonly kind: "unfilled" }

/**
 * A row a refused statement writes that the ChangeSet states, as the host judges it (write/program/bind.ts): the
 * fields the ChangeSet states, by name, its key and its caller's and serial fields, or a query entry's head, never a
 * count, an end or a copy; and every other column of its relation, a drawn or an accumulated field by its field key, a
 * law column by its own, as the write fills it.
 */
export interface JudgedRow {
	readonly stated: HostFact
	readonly filled: (column: ColumnKey) => FilledColumn
}

/**
 * One application's stated rows as its write fills them (write/program/bind.ts BoundWrite): the facts of one member
 * slot of a slot group's enumerated input, and a stratum's nested rows of a relation.
 */
export interface StatedRows {
	readonly slot: (
		group: SlotGroup,
		input: EnumeratedInput,
		slot: MemberSlot
	) => ReadonlyArray<JudgedRow>
	readonly nested: (stratum: number, relation: RelationInfo) => ReadonlyArray<JudgedRow>
}

/** A stated row's field as the host holds it: a field the ChangeSet states, or one its write fills; none for a
 * generated field, a field PostgreSQL draws, or a column the host does not hold. */
const hostField = (row: JudgedRow, field: LawField): unknown => {
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
 * What a refused statement states, as the host reads it: a write of stored relations, by declared name, at its stratum,
 * which states every fact the ChangeSet adds or puts into them there, an action's statement and the fill of its
 * member's carrier, which casts those facts into the relation's types (artifact.ts CarrierCasts); a query entry's
 * precheck, which casts the entry's own stated facts into its target's types before any statement writes them; or a
 * statement that states no fact the ChangeSet states: another carrier's, an ANALYZE, a serial advance, a read-back,
 * a family's stored-suffix read or the COMMIT.
 */
export type StatementAt =
	| { readonly kind: "write"; readonly stratum: number; readonly relations: ReadonlyArray<string> }
	| { readonly kind: "precheck"; readonly stratum: number; readonly entry: string }
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
 * What the host makes of a refused statement: the witness of the first fact it states that breaks what refused it, or
 * `unreported`, and which laws the refusal names (RefusedLaws).
 */
export interface HostJudgement {
	readonly witness: Witness
	readonly laws: RefusedLaws
}

/** One row a statement states, as the host judges it: its row as the write fills it, and its witness in its caller's
 * words. */
interface StatedFact {
	readonly row: JudgedRow
	readonly witness: Witness
}

/** How the host judges one stated fact against what refused its statement. */
type Verdict = "breaks" | "holds" | "unjudged"

/** The unreported witness: no fact the ChangeSet states is one the host finds breaking the law. */
const unreported: Witness = Object.freeze({ kind: "unreported" })

/** Whether an admitted value is a set's. */
const isSet = (value: CarrierHost[Carrier]): value is ReadonlySet<string> => value instanceof Set

/** A key field's admitted value as a key value, or undefined for a set's or bytes', which no key holds. */
const keyHost = (value: CarrierHost[Carrier]): KeyHost | undefined =>
	isSet(value) || isBytes(value) ? undefined : value

/**
 * The key a fact of `relation` states, its first declared key whose every field it carries, the primary key first;
 * undefined where it carries none whole, as a generated addition omits the serial fields its identity draws.
 */
const statedKey = (
	relation: RelationInfo,
	row: JudgedRow,
	codes: Codebook
): Readonly<Record<string, KeyHost>> | undefined => {
	for (const key of relation.keyNames) {
		const values: Record<string, KeyHost> = {}
		let whole = true
		for (const f of key.fields) {
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
const targetFact = (entry: CheckedEntry, fact: HostFact, codes: Codebook): HostFact => {
	const out: Record<string, unknown> = {}
	for (const [head, { field }] of entry.head) {
		if (Object.hasOwn(fact, head)) {
			out[field.name] = fact[head]
		}
	}
	for (const fixed of entry.fixed) {
		if (fixed.value.kind === "literal") {
			const carried = irLiteral(fixed.value.value, fixed.field.type)
			if (carried.ok) {
				out[fixed.field.name] = literalHost(
					carrierSpecOf(fixed.field.type, codes),
					carried.value.literal
				)
			}
		}
	}
	return out
}

/** The entry a slot group writes through, by the name its facts are stated under, when it is no relation's own. */
const entryOf = (frontend: WriteFrontend, group: SlotGroup): CheckedEntry | undefined => {
	if (group.facts.name === group.relation.name) {
		return undefined
	}
	const world: { readonly kind: "reality" } | RoleWorld = frontend.schema.world
	if (world.kind !== "role") {
		return undefined
	}
	const write = world.writes.get(group.facts.name)
	return write?.kind === "rows" ? write.writable : undefined
}

/**
 * The facts one slot group of the ChangeSet states that a statement adds or puts into `relation`, its written relation:
 * each enumerated insert's and put's normal facts, a query entry's as facts of its target, each with its witness, the
 * key it was stated at in the words it was stated in.
 */
const groupFacts = (
	frontend: WriteFrontend,
	stated: StatedRows,
	group: SlotGroup,
	relation: RelationInfo
): ReadonlyArray<StatedFact> => {
	const codes = frontend.codes
	const entry = entryOf(frontend, group)
	const out: Array<StatedFact> = []
	for (const input of group.inputs) {
		if (input.kind === "single" && input.act.op === "delete") {
			continue
		}
		for (const slot of inputSlots(input)) {
			for (const written of stated.slot(group, input, slot)) {
				const row =
					entry === undefined
						? written
						: { stated: targetFact(entry, written.stated, codes), filled: written.filled }
				const key = statedKey(relation, row, codes)
				out.push({
					row,
					witness:
						key === undefined
							? unreported
							: entry === undefined
								? keyWitness(relation.name, key)
								: keyWitness(entry.entry, entryKey(entry, key))
				})
			}
		}
	}
	return out
}

/**
 * The facts the ChangeSet states for `relation` at `stratum` that a write adds or puts: every slot group's of it
 * (groupFacts), and each nested row the stratum inserts into it, each with its witness.
 */
const writtenFacts = (
	frontend: WriteFrontend,
	stated: StatedRows,
	stratum: number,
	relation: RelationInfo
): ReadonlyArray<StatedFact> => {
	const out: Array<StatedFact> = []
	for (const group of frontend.slots) {
		if (group.stratum === stratum && group.relation.name === relation.name) {
			appendAll(out, groupFacts(frontend, stated, group, relation))
		}
	}
	for (const row of stated.nested(stratum, relation)) {
		const key = statedKey(relation, row, frontend.codes)
		out.push({ row, witness: key === undefined ? unreported : keyWitness(relation.name, key) })
	}
	return out
}

/** The slot groups of a query entry's precheck: the entry's own at its stratum. */
const precheckGroups = (
	frontend: WriteFrontend,
	at: Extract<StatementAt, { readonly kind: "precheck" }>
): ReadonlyArray<SlotGroup> =>
	frontend.slots.filter((group) => group.stratum === at.stratum && group.facts.name === at.entry)

/**
 * The stored relations a refused statement writes or casts its facts into, by declared name: a write's own, a query
 * entry's precheck's target, whose types the precheck casts the entry's facts into, and none of a statement that
 * states no fact.
 */
export const statementRelations = (
	frontend: WriteFrontend,
	at: StatementAt
): ReadonlyArray<string> => {
	switch (at.kind) {
		case "write":
			return at.relations
		case "precheck":
			return [...new Set(precheckGroups(frontend, at).map((group) => group.relation.name))]
		case "unstated":
			return []
	}
}

/**
 * The facts a refused statement states, each beside the written relation it is a fact of, in the order the host judges
 * them: a write's, relation by relation in its order (writtenFacts); a query entry's precheck's, the entry's own slot
 * groups' at its stratum (groupFacts).
 */
const statedFacts = (
	frontend: WriteFrontend,
	stated: StatedRows,
	at: StatementAt
): ReadonlyArray<readonly [RelationInfo, StatedFact]> => {
	const writtenNamed = (name: string): RelationInfo | undefined =>
		frontend.written.find((r) => r.name === name)
	switch (at.kind) {
		case "write":
			return at.relations.flatMap((name) => {
				const relation = writtenNamed(name)
				return relation === undefined
					? []
					: writtenFacts(frontend, stated, at.stratum, relation).map(
							(fact) => [relation, fact] as const
						)
			})
		case "precheck":
			return precheckGroups(frontend, at).flatMap((group) => {
				const relation = writtenNamed(group.relation.name)
				return relation === undefined
					? []
					: groupFacts(frontend, stated, group, relation).map((fact) => [relation, fact] as const)
			})
		case "unstated":
			return []
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
	readonly evaluate: (relation: TableRelation, expr: ScalarExpr, row: JudgedRow) => Evaluated
	readonly carried: (value: unknown, type: ScalarType) => CarrierValue | undefined
	readonly member: (value: CarrierValue, type: ScalarType) => boolean | undefined
}

/** The judge of a write's facts by its law model's compiled patterns (LawModel.patterns), parsing none per fact. */
const judgeOf = (frontend: WriteFrontend): Judge => {
	const codes = frontend.codes
	const patterns = frontend.laws.patterns
	const closed = closedLeaf(
		new Map(
			[...frontend.schema.closed].map(([name, c]): readonly [string, ClosedRows] => [
				name,
				{ heading: c.heading, key: c.relation.primaryFields.length, rows: c.rows }
			])
		)
	)
	/** Each member relation's law columns, by column key, with their types (write/family/statements.ts RowLayout). */
	const lawColumns = new Map<string, ReadonlyMap<ColumnKey, ScalarType>>(
		frontend.laws.families.map((f) => [
			f.member.name,
			new Map(
				rowLayout(f.member, frontend.laws.families).columns.flatMap((c) =>
					c.column.kind === "law" ? [[c.key, c.type] as const] : []
				)
			)
		])
	)
	const evaluate = (relation: TableRelation, expr: ScalarExpr, row: JudgedRow): Evaluated => {
		/**
		 * A column's value: a field the row states or its write fills, a generated field's as PostgreSQL generates it
		 * from the row, NULL included, or a law column its write fills; none where the host does not hold it.
		 */
		const valueOf = (name: string): SqlValue | undefined => {
			const declared = relation.fields.find((f) => f.name === name)
			if (declared === undefined) {
				const key: ColumnKey = `law:${name}`
				const type = lawColumns.get(relation.name)?.get(key)
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
		const table = predicateTable(expr)
		const leaves: EvalLeaves = { value: undefined, column: (ref) => valueOf(ref.name), closed }
		const value = evaluateTable(table.exprs, table.root, leaves, patterns)
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
 * A stated row's field as a domain's CHECK reads it: the host's value of a field the ChangeSet states or its write
 * fills, and a generated field's value as PostgreSQL generates it from the row, NULL included, which every domain
 * admits; none where the host does not hold or cannot evaluate it.
 */
const domainValue = (
	judge: Judge,
	relation: TableRelation,
	row: JudgedRow,
	field: LawField
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
	native: NativeOf<"ClosedCheck">,
	row: JudgedRow,
	codes: Codebook
): Verdict => {
	for (const g of native.guard) {
		const guard = checked(judge.evaluate(native.relation, g.predicate, row))
		if (guard !== "holds") {
			return guard === "breaks" ? "holds" : "unjudged"
		}
	}
	const sources: Array<{ readonly value: CarrierValue; readonly target: LawField }> = []
	for (const pair of native.pairs) {
		if (pair.source.kind !== "field") {
			return "unjudged"
		}
		const raw = hostField(row, pair.source.field)
		const value =
			raw === undefined ? undefined : evalValue(carrierSpecOf(pair.source.field.type, codes), raw)
		if (value === undefined) {
			return "unjudged"
		}
		sources.push({ value, target: pair.target })
	}
	const cellAt = (name: string, cells: Split<TypedLiteral>): TypedLiteral | undefined => {
		const k = native.side.key.indexOf(name)
		return k >= 0 ? cells.key[k] : cells.payload[native.side.payload.indexOf(name)]
	}
	for (const cells of native.side.rows.values()) {
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
	relation: RelationInfo,
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

/** The law CHECK a table constraint of the law model is, if it is a CHECK: a row CHECK or a containment into a closed
 * relation. */
const checkOf = (
	frontend: WriteFrontend,
	judge: Judge,
	name: ConstraintName,
	laws: NonEmptyReadonlyArray<ConstraintLawOf>,
	native: NativeOf<ConstraintNativeKind>
): ReadonlyArray<LawCheck> => {
	switch (native.kind) {
		case "TableCheck":
			return [
				{
					name,
					laws,
					verdict: (row) => checked(judge.evaluate(native.relation, native.predicate, row))
				}
			]
		case "ClosedCheck":
			return [
				{
					name,
					laws,
					verdict: (row) => closedContainment(judge, native, row, frontend.codes)
				}
			]
		case "PrimaryKey":
		case "Unique":
		case "WithoutOverlaps":
		case "ForeignKey":
		case "PeriodForeignKey":
			return []
	}
}

/**
 * Every CHECK of `relation`'s table that states laws: its row CHECKs and its containments into closed relations, the
 * law model's (frontend.laws.constraints), and its spans' endpoint CHECKs of a contract, which state the contract's
 * law. Its span shape, width and date range CHECKs state none: the codec refuses what they would before any SQL.
 */
const lawChecks = (
	frontend: WriteFrontend,
	judge: Judge,
	relation: RelationInfo
): ReadonlyArray<LawCheck> => {
	const model = frontend.laws.constraints.flatMap((c): ReadonlyArray<LawCheck> => {
		if (c.kind !== "constraint" || c.owner !== relation.ident) {
			return []
		}
		const native = frontend.laws.natives.find(
			(n) => n.namespace === "constraint" && n.owner === c.owner && identifierOf(n.named) === c.name
		)
		if (native?.namespace !== "constraint") {
			throw defect(`the native object of the constraint ${c.name}, which the law model names it by`)
		}
		return checkOf(frontend, judge, c.name, c.laws, native.object)
	})
	const endpoints = relation.fields.flatMap((field): ReadonlyArray<LawCheck> => {
		const span = spanOf(baseOf(field.type))
		if (span === undefined) {
			return []
		}
		return levels(span.endpoint).flatMap((level): ReadonlyArray<LawCheck> => {
			const contract = contractOf(level)
			const law =
				contract === undefined
					? undefined
					: frontend.laws.natives
							.flatMap((n) =>
								n.namespace === "domain" && n.object.name === contract.name ? n.object.lawIds : []
							)
							.at(0)
			return contract === undefined || law === undefined
				? []
				: [
						{
							name: identifierOf(
								identity.spanCheck(relation.name, field.name, {
									kind: "endpoint",
									contract: contract.name
								})
							),
							laws: [{ law, described: contractLaw(contract.name) }],
							verdict: (row) =>
								firstBreak(
									endpointsOf(hostField(row, field)).map((endpoint) => {
										const carried = judge.carried(endpoint, level)
										return carried === undefined ? "unjudged" : breaksLevel(judge, carried, level)
									})
								)
						}
					]
		})
	})
	return [...model, ...endpoints]
}

/**
 * A law CHECK's verdict on a stated row, as PostgreSQL meets it: a row whose generated field's NOT NULL refuses it
 * never reaches its CHECKs (generatedNotNulls).
 */
const checkVerdict = (
	judge: Judge,
	relation: RelationInfo,
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
	frontend: WriteFrontend,
	judge: Judge,
	relation: RelationInfo,
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
					frontend,
					refusing,
					judged.flatMap((j) => (j.verdict === "breaks" ? [j.check] : []))
				)
			}
}

/** The laws of `broken`, a row's broken law CHECKs, and of `refusing`, each once, in the theory's order of laws. */
const brokenLaws = (
	frontend: WriteFrontend,
	refusing: LawCheck,
	broken: ReadonlyArray<LawCheck>
): NonEmptyReadonlyArray<Law> => {
	const order = (law: LawId): number => frontend.laws.theory.laws.findIndex((l) => l.id === law)
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
			return false
	}
}

/** How the host judges one stated row against what refused its statement: it breaks it, and the refusal names the laws
 * `laws` says; or the host finds no break in it, the row holding or left unjudged. */
type RowJudgement =
	| { readonly kind: "breaks"; readonly laws: RefusedLaws }
	| { readonly kind: "clear" }

const clear: RowJudgement = Object.freeze({ kind: "clear" })

/**
 * How the host judges each stated row against one refuser (`row`), and the laws the refusal names where no stated row
 * breaks it (`none`).
 */
interface RefuserJudge {
	readonly row: (relation: RelationInfo, row: JudgedRow) => RowJudgement
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
	relation: RelationInfo,
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
		return clear
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
const refuserJudge = (frontend: WriteFrontend, judge: Judge, refuser: Refuser): RefuserJudge => {
	switch (refuser.kind) {
		case "generated":
			return {
				row: (relation, row) => {
					const field = relation.fields.find((f) => f.column === refuser.column)
					if (relation.ident !== refuser.table || field?.writing.kind !== "generated") {
						return clear
					}
					return judge.evaluate(relation, field.writing.expr, row).kind === "null"
						? { kind: "breaks", laws: refusedByObject }
						: clear
				},
				none: refusedByObject
			}
		case "domain":
			return {
				row: (relation, row) => domainRow(judge, relation, refuser.uses, row),
				none: refusedByObject
			}
		case "constraint": {
			const table = frontend.written.find((r) => r.ident === refuser.owner)
			const checks = table === undefined ? [] : lawChecks(frontend, judge, table)
			const refusing = checks.find((c) => c.name === refuser.name)
			if (refusing === undefined) {
				return { row: () => clear, none: refusedByObject }
			}
			return {
				row: (relation, row) =>
					relation.ident === refuser.owner &&
					checkVerdict(judge, relation, refusing, row) === "breaks"
						? {
								kind: "breaks",
								laws: refusedLaws(frontend, judge, relation, refusing, checks, row)
							}
						: clear,
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
 * what refused it, the first the statement states (statedFacts: a write's in its relations' order, a query entry's
 * precheck's in its own), its witness the key it was stated at, in the words it was stated in (a query entry's,
 * through `entryKey`), and the laws it breaks where it judges every law CHECK of its table (`refusedLaws`) or every
 * column of its the domain types (`domainRow`). Where the host finds none (a row only PostgreSQL computes, a query's,
 * a row whose law reads a value the host does not hold or cannot evaluate, or one stated with no whole key, as a
 * generated addition's identity is drawn), the witness is `unreported`.
 */
export const hostJudgement = (
	frontend: WriteFrontend,
	stated: StatedRows,
	at: StatementAt,
	refuser: Refuser
): HostJudgement => {
	const judging = refuserJudge(frontend, judgeOf(frontend), refuser)
	for (const [relation, fact] of statedFacts(frontend, stated, at)) {
		const judged = judging.row(relation, fact.row)
		if (judged.kind === "breaks") {
			return { witness: fact.witness, laws: judged.laws }
		}
	}
	return { witness: unreported, laws: judging.none }
}
