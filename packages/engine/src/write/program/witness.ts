import type { CheckedEntry, RoleWorld } from "#compiler/analysis/schema.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ColumnIdent, ConstraintName, RelationIdent } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Split } from "#compiler/ir/cells.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import {
	type ExprTable,
	predicateTable,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import type { LawField, NativeOf, RelationInfo, TableRelation } from "#compiler/ir/law.ts"
import { baseOf, contractOf, type ScalarType, spanOf, textOf } from "#compiler/ir/scalar.ts"
import type { DomainUse } from "#compiler/laws/model/model.ts"
import {
	compareValues,
	type EvalLeaves,
	evaluateTable,
	literalValue,
	type RegexMember,
	valueMember
} from "#compiler/scalar/compute/evaluate.ts"
import { type CarrierValue, irLiteral } from "#compiler/scalar/compute/literal.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { regexMember } from "#compiler/scalar/regex/nfa.ts"
import { admitted, type Carrier, type CarrierHost } from "#compiler/scalar/values/identity.ts"
import type { KeyHost, Law, Witness } from "#compiler/types/changeset/changeset.ts"
import { type ClosedRows, closedLeaf, evalValue, literalHost } from "#compiler/write/family/fold.ts"
import { inputSlots, type SlotGroup, type WriteFrontend } from "#compiler/write/frontend/compile.ts"
import { entryKey } from "#compiler/write/frontend/entry.ts"
import type { Normalized } from "#compiler/write/normalize/normalize.ts"
import { keyWitness } from "#compiler/write/program/outcome.ts"

/** A fact as the host states it: each field it carries, by name, its codec's admitted host value. */
type HostFact = { readonly [field: string]: unknown }

/**
 * What refused a statement, as PostgreSQL reported it on an object of the installation: a table constraint by its
 * owner and name, a domain's CHECK by the columns of the written tables it types, or a generated column's NOT NULL.
 */
export type Refuser =
	| { readonly kind: "constraint"; readonly owner: RelationIdent; readonly name: ConstraintName }
	| {
			readonly kind: "domain"
			readonly laws: NonEmptyReadonlyArray<Law>
			readonly uses: ReadonlyArray<DomainUse>
	  }
	| { readonly kind: "generated"; readonly table: RelationIdent; readonly column: ColumnIdent }

/** Where a refused statement stands: its stratum and the stored relations it writes, by declared name. */
export interface StatementAt {
	readonly stratum: number
	readonly relations: ReadonlyArray<string>
}

/** One fact a statement states, as the host judges it: its relation's fields, and its witness in its caller's words. */
interface StatedFact {
	readonly fact: HostFact
	readonly witness: Witness
}

/** How the host judges one stated fact against what refused its statement. */
type Verdict = "breaks" | "holds" | "unjudged"

/** The unreported witness: no fact the ChangeSet states is one the host finds breaking the law. */
const unreported: Witness = Object.freeze({ kind: "unreported" })

/** Whether an admitted value is a set's. */
const isSet = (value: CarrierHost[Carrier]): value is ReadonlySet<string> => value instanceof Set

/** A key field's admitted value as a key value, or undefined for a set's, which no key holds. */
const keyHost = (value: CarrierHost[Carrier]): KeyHost | undefined =>
	isSet(value) ? undefined : value

/**
 * The key a fact of `relation` states, its first declared key whose every field it carries, the primary key first;
 * undefined where it carries none whole, as a generated addition omits the serial fields its identity draws.
 */
const statedKey = (
	relation: RelationInfo,
	fact: HostFact,
	codes: Codebook
): Readonly<Record<string, KeyHost>> | undefined => {
	for (const key of relation.keyNames) {
		const values: Record<string, KeyHost> = {}
		let whole = true
		for (const f of key.fields) {
			const raw = fact[f.name]
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
 * The facts the ChangeSet states for `relation` at `stratum` that a statement adds or puts: each enumerated insert's
 * and put's normal facts, a query entry's as facts of its target, and each nested row the stratum inserts into it,
 * each with its witness, the key it was stated at in the words it was stated in.
 */
const statedFacts = (
	frontend: WriteFrontend,
	normalized: Normalized,
	stratum: number,
	relation: RelationInfo
): ReadonlyArray<StatedFact> => {
	const codes = frontend.codes
	const out: Array<StatedFact> = []
	for (const group of frontend.slots) {
		if (group.stratum !== stratum || group.relation.name !== relation.name) {
			continue
		}
		const entry = entryOf(frontend, group)
		for (const input of group.inputs) {
			if (input.kind === "single" && input.act.op === "delete") {
				continue
			}
			for (const slot of inputSlots(input)) {
				for (const stated of normalized.slots.get(slot.slot)?.facts ?? []) {
					const fact = entry === undefined ? stated : targetFact(entry, stated, codes)
					const key = statedKey(relation, fact, codes)
					out.push({
						fact,
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
	}
	for (const row of normalized.nested.get(stratum)?.get(relation.name)?.values() ?? []) {
		const fact: Record<string, unknown> = {}
		for (const [column, value] of row.values) {
			if (column.startsWith("field:")) {
				fact[column.slice("field:".length)] = value
			}
		}
		const key = statedKey(relation, fact, codes)
		out.push({ fact, witness: key === undefined ? unreported : keyWitness(relation.name, key) })
	}
	return out
}

/** Whether a NULL anywhere in `e` makes `e` NULL: no conditional, which takes its other branch at a NULL test, and no
 * AND or OR, which a FALSE or TRUE operand decides whatever the other is. */
const nullStrict = (e: ScalarExpr): boolean => {
	if (e.kind === "cond") {
		return false
	}
	if (e.kind === "op") {
		const fn = nativeOp(e.op)?.fn
		if (fn === "and" || fn === "or") {
			return false
		}
	}
	return e.args.every(nullStrict)
}

/** What an expression is over one fact, as PostgreSQL computes it: a value, NULL (a closed read at a key its relation
 * holds no row at, which nothing in the expression masks), or unknown to the host. */
type Evaluated =
	| { readonly kind: "value"; readonly value: CarrierValue }
	| { readonly kind: "null" }
	| { readonly kind: "unknown" }

/** The judge of one installation's facts on the host. */
interface Judge {
	readonly evaluate: (relation: TableRelation, expr: ScalarExpr, fact: HostFact) => Evaluated
	readonly member: (value: unknown, type: ScalarType) => boolean | undefined
}

/**
 * Whether some closed read C.at of `table` reads a key its relation holds no row at, its arguments evaluated over
 * `leaves`: the read is NULL there.
 */
const readsAbsent = (table: ExprTable, leaves: EvalLeaves, member: RegexMember): boolean =>
	Object.values(table.exprs).some((node) => {
		if (node.kind !== "closedAt") {
			return false
		}
		const args: Array<CarrierValue> = []
		for (const a of node.args) {
			const v = evaluateTable(table.exprs, a, leaves, member)
			if (!v.ok) {
				return false
			}
			args.push(v.value)
		}
		return leaves.closed(node.relation, node.field, args) === undefined
	})

const judgeOf = (frontend: WriteFrontend, member: RegexMember): Judge => {
	const codes = frontend.codes
	const closed = closedLeaf(
		new Map(
			[...frontend.schema.closed].map(([name, c]): readonly [string, ClosedRows] => [
				name,
				{ heading: c.heading, key: c.relation.primaryFields.length, rows: c.rows }
			])
		)
	)
	const evaluate = (relation: TableRelation, expr: ScalarExpr, fact: HostFact): Evaluated => {
		/** A field's value: the fact's own, or a generated field's as PostgreSQL generates it from the fact. */
		const valueOf = (field: string): CarrierValue | undefined => {
			const declared = relation.fields.find((f) => f.name === field)
			if (declared === undefined) {
				return undefined
			}
			if (Object.hasOwn(fact, field)) {
				return evalValue(carrierSpecOf(declared.type, codes), fact[field])
			}
			if (declared.writing.kind !== "generated") {
				return undefined
			}
			const generated = evaluate(relation, declared.writing.expr, fact)
			return generated.kind === "value" ? generated.value : undefined
		}
		const table = predicateTable(expr)
		const leaves: EvalLeaves = { value: undefined, column: (ref) => valueOf(ref.name), closed }
		const value = evaluateTable(table.exprs, table.root, leaves, member)
		if (value.ok) {
			return { kind: "value", value: value.value }
		}
		return nullStrict(expr) && readsAbsent(table, leaves, member)
			? { kind: "null" }
			: { kind: "unknown" }
	}
	return {
		evaluate,
		member: (value, type) => {
			const carried = evalValue(carrierSpecOf(type, codes), value)
			return carried === undefined ? undefined : valueMember(carried, type, member)
		}
	}
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
const breaksLevel = (judge: Judge, value: unknown, at: ScalarType): Verdict => {
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

/** A containment into a closed relation, as its CHECK judges a fact: held when its guard holds and no row of the
 * target's side meets the fact at every pair. */
const closedContainment = (
	judge: Judge,
	native: NativeOf<"ClosedCheck">,
	fact: HostFact,
	codes: Codebook
): Verdict => {
	for (const g of native.guard) {
		const guard = checked(judge.evaluate(native.relation, g.predicate, fact))
		if (guard !== "holds") {
			return guard === "breaks" ? "holds" : "unjudged"
		}
	}
	const sources: Array<{ readonly value: CarrierValue; readonly target: LawField }> = []
	for (const pair of native.pairs) {
		if (pair.source.kind !== "field") {
			return "unjudged"
		}
		const raw = fact[pair.source.field.name]
		const value =
			raw === undefined ? undefined : evalValue(carrierSpecOf(pair.source.field.type, codes), raw)
		if (value === undefined) {
			return "unjudged"
		}
		sources.push({ value, target: pair.target })
	}
	const cellAt = (name: string, row: Split<TypedLiteral>): TypedLiteral | undefined => {
		const k = native.side.key.indexOf(name)
		return k >= 0 ? row.key[k] : row.payload[native.side.payload.indexOf(name)]
	}
	for (const row of native.side.rows.values()) {
		const meets = sources.every(({ value, target }) => {
			const cell = cellAt(target.name, row)
			return cell !== undefined && compareValues(value, literalValue(cell), target.type) === 0
		})
		if (meets) {
			return "holds"
		}
	}
	return "breaks"
}

/** The span fields of `relation` whose endpoint CHECK of contract `contract` is the constraint `name`, each with the
 * level of its endpoint type that contract is. */
const endpointLevels = (
	relation: RelationInfo,
	name: ConstraintName
): ReadonlyArray<{ readonly field: LawField; readonly level: ScalarType }> =>
	relation.fields.flatMap((field) => {
		const span = spanOf(baseOf(field.type))
		if (span === undefined) {
			return []
		}
		return levels(span.endpoint).flatMap((level) => {
			const contract = contractOf(level)
			return contract !== undefined &&
				identifierOf(
					identity.spanCheck(relation.name, field.name, {
						kind: "endpoint",
						contract: contract.name
					})
				) === name
				? [{ field, level }]
				: []
		})
	})

/** A span's endpoints as the host holds them, each an endpoint value. */
const endpointsOf = (value: unknown): ReadonlyArray<unknown> =>
	typeof value === "object" && value !== null && "start" in value && "end" in value
		? [value.start, value.end]
		: []

/** The verdict of the first of `verdicts` that decides: a break, else a hold, else unjudged. */
const firstBreak = (verdicts: ReadonlyArray<Verdict>): Verdict =>
	verdicts.includes("breaks")
		? "breaks"
		: verdicts.length > 0 && verdicts.every((v) => v === "holds")
			? "holds"
			: "unjudged"

/** Whether one level of a type is what `law` states: a contract's level its contract law, a refined text level its
 * pattern law, compared by spelling. */
const levelStates = (level: ScalarType, law: Law): boolean => {
	const contract = contractOf(level)
	if (contract !== undefined) {
		return law.kind === "contract" && law.contract === contract.name
	}
	const regex = textOf(level)?.regex
	return (
		regex !== undefined &&
		regex !== "wildcard" &&
		law.kind === "pattern" &&
		law.source === regex.source &&
		law.flags === regex.flags
	)
}

/** How the host judges a fact of `relation` against `refuser`. */
const verdictOf = (
	frontend: WriteFrontend,
	judge: Judge,
	relation: RelationInfo,
	refuser: Refuser,
	fact: HostFact
): Verdict => {
	switch (refuser.kind) {
		case "generated": {
			const field = relation.fields.find((f) => f.column === refuser.column)
			if (relation.ident !== refuser.table || field?.writing.kind !== "generated") {
				return "unjudged"
			}
			const value = judge.evaluate(relation, field.writing.expr, fact)
			return value.kind === "null" ? "breaks" : value.kind === "value" ? "holds" : "unjudged"
		}
		case "domain": {
			const typed = new Set(
				refuser.uses.flatMap((use) => (use.table === relation.ident ? [use.column] : []))
			)
			return firstBreak(
				relation.fields.flatMap((field) => {
					if (refuser.uses.length > 0 && !typed.has(field.column)) {
						return []
					}
					return levels(field.type).flatMap((level): ReadonlyArray<Verdict> => {
						if (!refuser.laws.some((law) => levelStates(level, law))) {
							return []
						}
						const value = fact[field.name]
						return [value === undefined ? "unjudged" : breaksLevel(judge, value, level)]
					})
				})
			)
		}
		case "constraint": {
			if (relation.ident !== refuser.owner) {
				return "unjudged"
			}
			const native = frontend.laws.natives.find(
				(n) =>
					n.namespace === "constraint" &&
					n.owner === refuser.owner &&
					identifierOf(n.named) === refuser.name
			)
			if (native?.namespace === "constraint") {
				const object = native.object
				switch (object.kind) {
					case "TableCheck":
						return checked(judge.evaluate(object.relation, object.predicate, fact))
					case "ClosedCheck":
						return closedContainment(judge, object, fact, frontend.codes)
					case "PrimaryKey":
					case "Unique":
					case "WithoutOverlaps":
					case "ForeignKey":
					case "PeriodForeignKey":
						return "unjudged"
				}
			}
			return firstBreak(
				endpointLevels(relation, refuser.name).flatMap(({ field, level }) =>
					endpointsOf(fact[field.name]).map((endpoint) => breaksLevel(judge, endpoint, level))
				)
			)
		}
	}
}

/**
 * Witnessing a native refusal on the host.
 *
 * PostgreSQL states the row a CHECK, a domain's CHECK or a generated column's NOT NULL refused only in its message's
 * prose, which grizzle never reads. The host holds what the refused statement wrote wherever the ChangeSet states it:
 * an enumerated insert's or put's facts, a query entry's as facts of its target, and a nesting's rows. So it judges
 * each of them, by the one host evaluation of a check's expression (scalar/compute/evaluate.ts) over the fact's fields
 * and the generated fields PostgreSQL computes from them, against what PostgreSQL reported:
 *
 * - a row CHECK, `CHECK ((p) IS TRUE)`: a fact at which p is FALSE, or NULL by a closed read at a key its relation
 *   holds no row at that nothing in p masks;
 * - a containment into a closed relation, a table CHECK: a fact its guard holds of that no row of the target's side
 *   meets at every pair;
 * - a span's endpoint CHECK of a contract: a fact whose span has an endpoint inside every level below the contract
 *   and outside the contract;
 * - a domain's CHECK, a contract's or a pattern's: a fact whose field, among the columns the domain types in the
 *   statement's tables, holds a value inside every level below the law's and outside the law's own;
 * - a generated column's NOT NULL: a fact at which its generation expression is NULL, by such a closed read.
 *
 * The host never decides whether a write is refused: PostgreSQL has refused it. The host only names a fact that
 * breaks what refused it, the first in the statement's relations' order and each one's stated order, its witness the
 * key it was stated at, in the words it was stated in (a query entry's, through `entryKey`). Where the host finds none
 * (a row only PostgreSQL computes, a query's or a family's filled values, a fact whose law reads what the host cannot
 * evaluate, or one stated with no whole key, as a generated addition's identity is drawn), the witness is
 * `unreported`.
 */
export const hostWitness = (
	frontend: WriteFrontend,
	normalized: Normalized,
	at: StatementAt,
	refuser: Refuser
): Witness => {
	const judge = judgeOf(frontend, regexMember)
	for (const name of at.relations) {
		const relation = frontend.written.find((r) => r.name === name)
		if (relation === undefined) {
			continue
		}
		for (const stated of statedFacts(frontend, normalized, at.stratum, relation)) {
			if (verdictOf(frontend, judge, relation, refuser, stated.fact) === "breaks") {
				return stated.witness
			}
		}
	}
	return unreported
}
