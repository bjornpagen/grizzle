import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { WritabilityReason } from "#compiler/core/causes.ts"
import { EntryName } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import {
	type BindingsDesc,
	type ContextDesc,
	candidateKeyFields,
	bindTerms,
	type ExprDesc,
	exprChildren,
	type FieldDesc,
	type LiteralDesc,
	levelChain,
	type MatchDesc,
	type QueryDesc,
	type QueryStageDesc,
	type RelationDesc,
	type RuleDesc,
	type SchemaDesc,
	type SourceDesc
} from "#compiler/ir/desc.ts"
import { queryUses } from "#compiler/schema/walk.ts"

/** A query entry as the analysis reads it: its name in the role and its definition over the base. */
export interface EntryDefinition {
	readonly name: string
	readonly query: QueryDesc
}

/** What fills a fixed field of T: its literal, or the field of the context fact the definition fixes it to. */
export type FixedValue =
	| { readonly kind: "literal"; readonly value: LiteralDesc }
	| { readonly kind: "context"; readonly context: ContextDesc; readonly field: string }

/** A field of T outside the head, as `F` refers to it, and its fill. */
export interface FixedField<F> {
	readonly field: F
	readonly value: FixedValue
}

/**
 * How an UPDATE in place of T's row stands toward a head field. `keyed`: a field of a key of T, its primary key or a
 * candidate key, the identity an UPDATE matches by and never sets. `family`: outside every key, a field T's family
 * draws, an owner's count or end, which grizzle writes on the host and no fact of the entry states, so no UPDATE through
 * the entry sets it. `claimFixed`: outside every key, its head variable bound by a field of a positive context match of
 * the rule (`owner: Session.sub`), so every fact of a Db's world holds the claim's value there and no UPDATE sets it; a
 * field bound to the claim only through a join is not. `free`: any other, which an UPDATE in place may set.
 */
export type HeadStanding = "free" | "family" | "claimFixed" | "keyed"

/** A head field of a writable entry: the field of T it writes, as `F` refers to it, and its standing. */
interface HeadField<F> {
	readonly field: F
	readonly kind: HeadStanding
}

/**
 * The filter of an entry over T's row, `fixed ∧ w`: none, when every row of T is in the entry; or `query`, non-empty
 * for a row exactly when the row is in the entry. Its row source (ir/desc.ts RowSourceDesc) carries `fields`, the
 * fields of T it reads, as `F` refers to them, in T's canonical field order; a filter that reads none matches no row
 * source at all, since joining the unit row is the identity. `readsOther` holds when it reads a stored relation, an
 * ordinary or derived one: a role holds no privilege on it and sees it through its own policies, so the filter runs as
 * the owner, in the role's filter function.
 */
export type EntryFilter<F> =
	| { readonly kind: "none" }
	| {
			readonly kind: "query"
			readonly query: QueryDesc
			readonly fields: ReadonlyArray<F>
			readonly readsOther: boolean
	  }

/**
 * The writable-entry analysis: which query entries of a role a ChangeSet can write, and how.
 *
 * A query entry E listed in a role's `write` is a query over the role's base. It is writable exactly when:
 *
 * - its definition is a rules stage of exactly one arm, under any names `.named()` gives it;
 * - exactly one occurrence of an ordinary relation T supplies every head field, and each head term is a bare variable
 *   that occurrence binds to a field of its own;
 * - every field of T outside the head is fixed: bound to a literal, or to a variable a context match binds, which may
 *   fix several fields of T to one context field; but a field T's family draws, an owner's count or end (`family`),
 *   which grizzle writes and no fact states, so it is in the head or nowhere, and in no key of T, whose fields a write
 *   names (`keyHoldsFamily`);
 * - every other match, negation and predicate only filters, and reads no field T's family draws: the owner's
 *   membership would then move with member writes that no write through the entry states, and the policy's WITH CHECK
 *   could not judge an owner at its insert, before its family's count is written (`filterReadsFamily`).
 *
 * T's primary key is then in the head or fixed, since every field of T in a key is one or the other. Anything else listed in
 * `write` is refused, with the reason named (WritabilityRefused).
 *
 * A writable entry is read three ways. A write into E is DML on T: the head fields map to T's fields, and the fixed
 * fields are filled from their literals and claim reads. Its filter, `fixed ∧ w`, is the definition with T's occurrence
 * re-pointed at the row over T's read fields, one fact the membership's caller names, under the same bindings, and its
 * head emptied: non-empty for a row of T exactly when that row is in E. A literal-fixed field stays a literal binding
 * of the row, a context-fixed field a variable the context match shares, and a head variable no other term reads leaves
 * the row, so the row carries exactly the fields the filter reads. The policy of the role on T, its filter
 * function, and each write statement's precheck render that one query (write/entry/render.ts). Each head field carries
 * its standing (HeadField): the role holds column UPDATE on T's free head fields alone (physical/ddl/roles.ts).
 *
 * T is `Target` and each of its fields `F`: ownership's analysis names them (`writableEntry`), and a role's checked
 * schema holds the base's handles for them (analysis/schema.ts CheckedEntry), which every write and the installation read.
 */
export interface WritableEntry<Target, F> {
	/** The entry's name in its role. */
	readonly entry: EntryName
	/** T, the ordinary relation of the base every write into the entry targets. */
	readonly target: Target
	/** Each head field of the entry, the field of T it writes and its standing, in the entry's canonical field order. */
	readonly head: ReadonlyMap<string, HeadField<F>>
	/** Every field of T outside the head with its fill, in T's canonical field order. */
	readonly fixed: ReadonlyArray<FixedField<F>>
	readonly filter: EntryFilter<F>
}

export interface WritabilityRefused {
	readonly entry: string
	readonly reason: WritabilityReason
}

const refused = (
	entry: string,
	reason: WritabilityReason
): Result.Result<never, WritabilityRefused> => Result.err({ entry, reason })

/** The rules stage under any names `.named()` gives a definition. */
const unnamed = (stage: QueryStageDesc): QueryStageDesc =>
	stage.kind === "named" ? unnamed(stage.input) : stage

/** The relations of a schema through every level it extends, by name. */
const relationsOf = (schema: SchemaDesc): ReadonlyMap<string, RelationDesc> => {
	const out = new Map<string, RelationDesc>()
	for (const level of levelChain(schema).toReversed()) {
		for (const relation of level.relations) {
			out.getOrInsert(relation.name, relation)
		}
	}
	return out
}

/**
 * A relation's keys, each its fields: its primary key and every candidate key a statement of any level declares on it,
 * a key over its whole relation's fields (ir/desc.ts candidateKeyFields).
 */
const keysOfRelation = (
	schema: SchemaDesc,
	relation: OrdinaryDesc
): ReadonlyArray<ReadonlyArray<string>> => [
	relation.primaryKey,
	...levelChain(schema).flatMap((level) =>
		level.statements.flatMap((s) => {
			const fields =
				s.kind === "key" && s.side.relation === relation.name
					? candidateKeyFields(s.side)
					: undefined
			return fields === undefined ? [] : [fields]
		})
	)
]

/** The variables an expression reads in its own scope (ir/desc.ts exprChildren). */
const exprVars = (e: ExprDesc, into: Set<string>): void => {
	if (e.kind === "var") {
		into.add(e.var)
	}
	for (const c of exprChildren(e)) {
		exprVars(c.term, into)
	}
}

const bindingVars = (bindings: BindingsDesc, into: Set<string>): void => {
	for (const e of Object.values(bindings)) {
		exprVars(e, into)
	}
}

/** The variables of the enclosing rule a source reads: an import's bind map; every other source reads none itself. */
const sourceVars = (source: SourceDesc, into: Set<string>): void => {
	for (const [, b] of bindTerms(source)) {
		exprVars(b, into)
	}
}

/** Whether T's family draws a field of T: an owner's count or end, which grizzle writes on the host. */
const family = (target: OrdinaryDesc, field: string): boolean => {
	const writing = target.fields[field]?.writing.kind
	return writing === "drawn" || writing === "accumulated"
}

/** The variables a rule reads outside its head: its matches, its predicates and its interiors' arms. */
const ruleVars = (
	rule: Pick<RuleDesc, "matches" | "where" | "interiors">,
	into: Set<string>
): void => {
	for (const m of rule.matches) {
		sourceVars(m.source, into)
		bindingVars(m.bindings, into)
	}
	for (const w of rule.where) {
		exprVars(w, into)
	}
	for (const i of rule.interiors) {
		for (const arm of i.arms) {
			ruleVars(arm, into)
			for (const h of Object.values(arm.head)) {
				if (h.kind !== "aggregate" && h.kind !== "producer") {
					exprVars(h, into)
				}
			}
		}
	}
}

/** The context a match reads, when its source is a context. */
const contextOf = (source: SourceDesc): ContextDesc | undefined => {
	switch (source.kind) {
		case "relation":
		case "query":
		case "step":
		case "param":
		case "paramOf":
		case "call":
		case "callField":
		case "split":
		case "series":
		case "interior":
		case "self":
		case "delta":
		case "row":
			return undefined
		case "context":
			return source.context
	}
}

/** An ordinary relation of the base. */
type OrdinaryDesc = Extract<RelationDesc, { readonly kind: "relation" }>

/** An occurrence of an ordinary relation that binds every head variable to one of its declared fields. */
interface Supplier {
	readonly at: number
	readonly match: MatchDesc
	readonly target: OrdinaryDesc
}

/** Every occurrence of an ordinary relation that binds each head variable to a declared field of its own. */
const suppliers = (
	matches: ReadonlyArray<MatchDesc>,
	relations: ReadonlyMap<string, RelationDesc>,
	headVars: ReadonlySet<string>
): ReadonlyArray<Supplier> =>
	matches.flatMap((match, at): ReadonlyArray<Supplier> => {
		const source = match.source
		if (source.kind !== "relation") {
			return []
		}
		const target = relations.get(source.name)
		if (target?.kind !== "relation") {
			return []
		}
		const bound = new Set<string>()
		for (const [field, e] of Object.entries(match.bindings)) {
			if (e.kind === "var" && Object.hasOwn(target.fields, field)) {
				bound.add(e.var)
			}
		}
		return [...headVars].every((x) => bound.has(x)) ? [{ at, match, target }] : []
	})

/**
 * How a writable entry's writes meet its target's keys: `probed`, a query entry's, whose precheck probes every key of T
 * at its submitted values, so no key holds a field T's family draws (`keyHoldsFamily`); `scoped`, a scoped entry's
 * (schema/scope.ts), written as T whole, its families drawn as a whole entry's, whose precheck probes only the keys whose
 * fields do not decide whether a row is the owner's (`determines`, scope.ts), so only those hold no field T's family
 * draws.
 */
export type EntryKeys =
	| { readonly kind: "probed" }
	| { readonly kind: "scoped"; readonly determines: (fields: ReadonlyArray<string>) => boolean }

/**
 * The writable entry of `entry`, a query entry over the base `base` listed in its role's `write`, or why it is none;
 * its keys met as `keys` states (EntryKeys).
 */
export const writableEntry = (
	base: SchemaDesc,
	entry: EntryDefinition,
	keys: EntryKeys
): Result.Result<WritableEntry<string, string>, WritabilityRefused> => {
	const name = EntryName(entry.name)
	const stage = unnamed(entry.query.stage)
	if (stage.kind !== "rules" || stage.arms.length !== 1) {
		return refused(name, { kind: "notOneArm" })
	}
	const [arm] = stage.arms

	/** The head: each field a bare variable, no variable named twice. */
	const headVars = new Map<string, string>()
	for (const [field, term] of Object.entries(arm.head).toSorted(([a], [b]) =>
		compareStrings(a, b)
	)) {
		if (term.kind !== "var") {
			return refused(name, { kind: "headNotBareVariable", field })
		}
		const seen = headVars.get(term.var)
		if (seen !== undefined) {
			return refused(name, { kind: "headFieldsShareAField", fields: [seen, field] })
		}
		headVars.set(term.var, field)
	}

	const relations = relationsOf(base)
	const candidates = suppliers(arm.matches, relations, new Set(headVars.keys()))
	const [supplying] = candidates
	if (supplying === undefined || candidates.length !== 1) {
		return refused(name, { kind: "noSupplyingOccurrence", candidates: candidates.length })
	}
	const { match: occurrence, target } = supplying
	const others = arm.matches.toSpliced(supplying.at, 1)

	/** A context match's variables: each variable a context field binds, with the first such field in match order. */
	const contextBound = new Map<string, { readonly context: ContextDesc; readonly field: string }>()
	for (const m of others) {
		const context = contextOf(m.source)
		if (context === undefined) {
			continue
		}
		for (const [field, e] of Object.entries(m.bindings).toSorted(([a], [b]) =>
			compareStrings(a, b)
		)) {
			if (e.kind === "var" && !contextBound.has(e.var)) {
				contextBound.set(e.var, { context, field })
			}
		}
	}

	/**
	 * A key's fields are the identity a write through the entry names and its precheck probes, so none is a field T's
	 * family draws, which no fact states.
	 */
	const declaredKeys = keysOfRelation(base, target)
	const keyed = new Set(declaredKeys.flat())
	const probedKeys =
		keys.kind === "probed" ? declaredKeys : declaredKeys.filter((k) => !keys.determines(k))
	const drawnKey = [...new Set(probedKeys.flat())]
		.toSorted(compareStrings)
		.find((field) => family(target, field))
	if (drawnKey !== undefined) {
		return refused(name, { kind: "keyHoldsFamily", field: drawnKey })
	}
	/** A key generation (ir/law.ts FieldWriting keyGenerated), a generated field of T's primary key, is grizzle's to
	 * write from its reads, so no fact through an entry states it. */
	const generatedKey = target.primaryKey.find(
		(field) => target.fields[field]?.writing.kind === "generated"
	)
	if (generatedKey !== undefined) {
		return refused(name, { kind: "keyHoldsGeneration", field: generatedKey })
	}
	/**
	 * Every field of T: written by a head variable, which binds no other field of T, or fixed; one context field may
	 * fix several. A field T's family draws is in the head or nowhere: the filter below refuses one it reads.
	 */
	const fields = Object.keys(target.fields).toSorted(compareStrings)
	const fixed: Array<FixedField<string>> = []
	const fieldOfVar = new Map<string, string>()
	for (const field of fields) {
		const binding = occurrence.bindings[field]
		if (binding === undefined) {
			if (family(target, field)) {
				continue
			}
			return refused(name, { kind: "fieldNotFixed", field })
		}
		if (binding.kind === "literal") {
			fixed.push({ field, value: { kind: "literal", value: binding.value } })
			continue
		}
		if (binding.kind !== "var") {
			return refused(name, { kind: "bindingNotVariableOrLiteral", field })
		}
		if (headVars.has(binding.var)) {
			const bound = fieldOfVar.get(binding.var)
			if (bound !== undefined) {
				return refused(name, { kind: "headFieldsShareAField", fields: [bound, field] })
			}
			fieldOfVar.set(binding.var, field)
			continue
		}
		const context = contextBound.get(binding.var)
		if (context === undefined) {
			if (family(target, field)) {
				continue
			}
			return refused(name, { kind: "fieldNotFixed", field })
		}
		fixed.push({ field, value: { kind: "context", ...context } })
	}
	/**
	 * Each head variable is bound to a declared field (suppliers), so it writes one; in the entry's field order, each
	 * keyed when its field is in a key of T, else family when T's family draws it, else claim-fixed when a context match
	 * binds its variable.
	 */
	const head = new Map<string, HeadField<string>>()
	for (const [x, headField] of [...headVars].toSorted(([, a], [, b]) => compareStrings(a, b))) {
		const field = fieldOfVar.get(x)
		if (field === undefined) {
			return refused(name, { kind: "noSupplyingOccurrence", candidates: 0 })
		}
		head.set(headField, {
			field,
			kind: keyed.has(field)
				? "keyed"
				: family(target, field)
					? "family"
					: contextBound.has(x)
						? "claimFixed"
						: "free"
		})
	}

	/** The filter: the occurrence over the row, keeping the bindings some other term reads. */
	const read = new Set<string>()
	ruleVars({ matches: others, where: arm.where, interiors: arm.interiors }, read)
	const kept: Record<string, ExprDesc> = {}
	const heading: Record<string, FieldDesc> = {}
	const filterFields: Array<string> = []
	for (const field of fields) {
		const binding = occurrence.bindings[field]
		const decl = target.fields[field]
		if (binding === undefined || decl === undefined) {
			continue
		}
		if (binding.kind === "var" && !read.has(binding.var)) {
			continue
		}
		if (family(target, field)) {
			return refused(name, { kind: "filterReadsFamily", field })
		}
		kept[field] = binding
		heading[field] = decl.type
		filterFields.push(field)
	}
	const filtersNothing = others.length === 0 && arm.where.length === 0 && arm.interiors.length === 0
	if (filterFields.length === 0 && filtersNothing) {
		return Result.ok({ entry: name, target: target.name, head, fixed, filter: { kind: "none" } })
	}
	const row: ReadonlyArray<MatchDesc> =
		filterFields.length === 0
			? []
			: [
					{
						loc: occurrence.loc,
						source: { kind: "row", heading },
						bindings: kept
					}
				]
	const matches = [...row, ...others]
	const live = new Set<string>()
	ruleVars({ matches, where: arm.where, interiors: arm.interiors }, live)
	const filterArm: RuleDesc = {
		...arm,
		vars: arm.vars.filter((v) => live.has(v.id)),
		matches,
		head: {}
	}
	const query: QueryDesc = { stage: { ...stage, arms: [filterArm] } }
	const readsOther = [...queryUses(query).relations].some(
		(r) => relations.get(r)?.kind !== "closed"
	)
	return Result.ok({
		entry: name,
		target: target.name,
		head,
		fixed,
		filter: { kind: "query", query, fields: filterFields, readsOther }
	})
}
