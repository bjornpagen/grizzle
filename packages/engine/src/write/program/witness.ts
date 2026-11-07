import type { CheckedEntry, RoleWorld } from "#compiler/analysis/schema.ts"
import { contractLaw } from "#compiler/analysis/theory/description.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { appendAll } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ColumnIdent, ConstraintName, LawId, RelationIdent } from "#compiler/core/ids.ts"
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
import { baseOf, contractOf, type ScalarType, spanOf, textOf } from "#compiler/ir/scalar.ts"
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
 * - every: a table CHECK's refusal of a fact the ChangeSet states: every law of its table's law-stating CHECKs the
 *   fact breaks, in the theory's order of laws (its primary keys', then its statements' in canonical order), whichever
 *   of them PostgreSQL tried first;
 * - first: a table CHECK's refusal where no stated fact breaks it: the laws of the CHECK PostgreSQL tried first, which
 *   it orders by the CHECKs' installed names, an order no version keeps;
 * - object: any other refusal: the laws its one object discharges, which the classifier names.
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
 * The facts one slot group of the ChangeSet states that a statement adds or puts into `relation`, its written relation:
 * each enumerated insert's and put's normal facts, a query entry's as facts of its target, each with its witness, the
 * key it was stated at in the words it was stated in.
 */
const groupFacts = (
	frontend: WriteFrontend,
	normalized: Normalized,
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
	return out
}

/**
 * The facts the ChangeSet states for `relation` at `stratum` that a write adds or puts: every slot group's of it
 * (groupFacts), and each nested row the stratum inserts into it, each with its witness.
 */
const writtenFacts = (
	frontend: WriteFrontend,
	normalized: Normalized,
	stratum: number,
	relation: RelationInfo
): ReadonlyArray<StatedFact> => {
	const out: Array<StatedFact> = []
	for (const group of frontend.slots) {
		if (group.stratum === stratum && group.relation.name === relation.name) {
			appendAll(out, groupFacts(frontend, normalized, group, relation))
		}
	}
	for (const row of normalized.nested.get(stratum)?.get(relation.name)?.values() ?? []) {
		const fact: Record<string, unknown> = {}
		for (const [column, value] of row.values) {
			if (column.startsWith("field:")) {
				fact[column.slice("field:".length)] = value
			}
		}
		const key = statedKey(relation, fact, frontend.codes)
		out.push({ fact, witness: key === undefined ? unreported : keyWitness(relation.name, key) })
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
	normalized: Normalized,
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
					: writtenFacts(frontend, normalized, at.stratum, relation).map(
							(stated) => [relation, stated] as const
						)
			})
		case "precheck":
			return precheckGroups(frontend, at).flatMap((group) => {
				const relation = writtenNamed(group.relation.name)
				return relation === undefined
					? []
					: groupFacts(frontend, normalized, group, relation).map(
							(stated) => [relation, stated] as const
						)
			})
		case "unstated":
			return []
	}
}

/** What an expression is over one fact, as PostgreSQL computes it by its three-valued logic (scalar/compute/evaluate.ts
 * sqlNull): a value, NULL, or unknown to the host. */
type Evaluated =
	| { readonly kind: "value"; readonly value: CarrierValue }
	| { readonly kind: "null" }
	| { readonly kind: "unknown" }

/** The judge of one installation's facts on the host. */
interface Judge {
	readonly evaluate: (relation: TableRelation, expr: ScalarExpr, fact: HostFact) => Evaluated
	readonly member: (value: unknown, type: ScalarType) => boolean | undefined
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
	const evaluate = (relation: TableRelation, expr: ScalarExpr, fact: HostFact): Evaluated => {
		/** A field's value: the fact's own, or a generated field's as PostgreSQL generates it from the fact, NULL included. */
		const valueOf = (field: string): SqlValue | undefined => {
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
			return generated.kind === "value"
				? generated.value
				: generated.kind === "null"
					? sqlNull
					: undefined
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
		member: (value, type) => {
			const carried = evalValue(carrierSpecOf(type, codes), value)
			return carried === undefined ? undefined : valueMember(carried, type, patterns)
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

/** A span's endpoints as the host holds them, each an endpoint value. */
const endpointsOf = (value: unknown): ReadonlyArray<unknown> =>
	typeof value === "object" && value !== null && "start" in value && "end" in value
		? [value.start, value.end]
		: []

/** The verdict of the first of `verdicts` that decides: a break, else a hold, else unjudged. */
/**
 * What the NOT NULL of each of a fact's generated fields makes of its row: PostgreSQL checks every NOT NULL of a row
 * before any CHECK of it, so a row whose generated field's expression is NULL at the fact is refused there, and no
 * CHECK of its table judges it; "unknown" where the host cannot evaluate one of them.
 */
const generatedNotNulls = (
	judge: Judge,
	relation: RelationInfo,
	fact: HostFact
): "hold" | "refuse" | "unknown" => {
	const values = relation.fields.flatMap((field) =>
		field.writing.kind === "generated" ? [judge.evaluate(relation, field.writing.expr, fact)] : []
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
 * description, and its verdict on one fact of its table.
 */
interface LawCheck {
	readonly name: ConstraintName
	readonly laws: NonEmptyReadonlyArray<ConstraintLawOf>
	readonly verdict: (fact: HostFact) => Verdict
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
					verdict: (fact) => checked(judge.evaluate(native.relation, native.predicate, fact))
				}
			]
		case "ClosedCheck":
			return [
				{
					name,
					laws,
					verdict: (fact) => closedContainment(judge, native, fact, frontend.codes)
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
		return native?.namespace === "constraint"
			? checkOf(frontend, judge, c.name, c.laws, native.object)
			: []
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
							verdict: (fact) =>
								firstBreak(
									endpointsOf(fact[field.name]).map((endpoint) =>
										breaksLevel(judge, endpoint, level)
									)
								)
						}
					]
		})
	})
	return [...model, ...endpoints]
}

/**
 * A law CHECK's verdict on a fact, as PostgreSQL meets it: a row whose generated field's NOT NULL refuses it never
 * reaches its CHECKs (generatedNotNulls).
 */
const checkVerdict = (
	judge: Judge,
	relation: RelationInfo,
	check: LawCheck,
	fact: HostFact
): Verdict => {
	const notNulls = generatedNotNulls(judge, relation, fact)
	return notNulls === "hold" ? check.verdict(fact) : notNulls === "refuse" ? "holds" : "unjudged"
}

/**
 * The laws a fact breaks among its table's law CHECKs, `refusing` the one PostgreSQL reported among them: each once, in
 * the theory's order of laws, so neither the order PostgreSQL tries CHECKs in nor their installed names decide it.
 */
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
	judge: Judge,
	relation: RelationInfo,
	refuser: Refuser,
	checks: ReadonlyArray<LawCheck>,
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
			const check = checks.find((c) => c.name === refuser.name)
			return check === undefined ? "unjudged" : checkVerdict(judge, relation, check, fact)
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
 * - a row CHECK, `CHECK ((p) IS TRUE)`: a fact at which p is FALSE, or NULL by SQL's three-valued logic, a closed read
 *   at a key its relation holds no row at left unknown; never a fact a generated field's NOT NULL refuses, which
 *   PostgreSQL checks before any CHECK of its row (generatedNotNulls);
 * - a containment into a closed relation, a table CHECK: a fact its guard is true of, never one it leaves unknown, that
 *   no row of the target's side meets at every pair;
 * - a span's endpoint CHECK of a contract: a fact whose span has an endpoint inside every level below the contract
 *   and outside the contract;
 * - a domain's CHECK, a contract's or a pattern's: a fact whose field, among the columns the domain types in the
 *   statement's tables, holds a value inside every level below the law's and outside the law's own;
 * - a generated column's NOT NULL: a fact at which its generation expression is NULL, by a closed read at a key its
 *   relation holds no row at.
 *
 * The host never decides whether a write is refused: PostgreSQL has refused it. The host only names a fact that
 * breaks what refused it, the first the statement states (statedFacts: a write's in its relations' order, a query
 * entry's precheck's in its own), its witness the key it was stated at, in the words it was stated in (a query
 * entry's, through `entryKey`). Where the host finds none (a row only PostgreSQL computes, a query's or a family's
 * filled values, a fact whose law reads what the host cannot evaluate, or one stated with no whole key, as a generated
 * addition's identity is drawn), the witness is `unreported`.
 */
export const hostJudgement = (
	frontend: WriteFrontend,
	normalized: Normalized,
	at: StatementAt,
	refuser: Refuser
): HostJudgement => {
	const judge = judgeOf(frontend)
	const table =
		refuser.kind === "constraint"
			? frontend.written.find((r) => r.ident === refuser.owner)
			: undefined
	const checks = table === undefined ? [] : lawChecks(frontend, judge, table)
	const refusing =
		refuser.kind === "constraint" ? checks.find((c) => c.name === refuser.name) : undefined
	for (const [relation, stated] of statedFacts(frontend, normalized, at)) {
		if (verdictOf(judge, relation, refuser, checks, stated.fact) === "breaks") {
			return {
				witness: stated.witness,
				laws:
					refusing === undefined
						? refusedByObject
						: {
								kind: "every",
								laws: brokenLaws(
									frontend,
									refusing,
									checks.filter((c) => checkVerdict(judge, relation, c, stated.fact) === "breaks")
								)
							}
			}
		}
	}
	return { witness: unreported, laws: refusing === undefined ? refusedByObject : refusedFirst }
}
