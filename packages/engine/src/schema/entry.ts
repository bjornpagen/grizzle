import { compareText } from "#compiler/core/canonical.ts"
import type { WritabilityReason } from "#compiler/core/causes.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type BindingsDesc,
	type ContextDesc,
	candidateKeyFields,
	type ExprDesc,
	type FieldDesc,
	type LiteralDesc,
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
 * candidate key, the identity an UPDATE matches by and never sets. `claimFixed`: outside every key, its head variable
 * bound by a field of a positive context match of the rule (`owner: Session.sub`), so every fact of a Db's world holds
 * the claim's value there and no UPDATE sets it; a field bound to the claim only through a join is not. `free`: any
 * other, which an UPDATE in place may set.
 */
export type HeadStanding = "free" | "claimFixed" | "keyed"

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
 *   fix several fields of T to one context field;
 * - every other match, negation and predicate only filters.
 *
 * T's primary key is then in the head or fixed, since every field of T is one or the other. Anything else listed in
 * `write` is refused, with the reason named (WritabilityRefused). A filter may read a serial field of T: an addition
 * into E is checked against the filter before it writes (write/entry/precheck.ts), so its facts carry every serial
 * field the filter reads (write/frontend/entry.ts entryRelation), and an addition whose serial value grizzle would
 * generate there is refused as any fact missing a field is.
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
	readonly entry: string
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
	for (let level: SchemaDesc | undefined = schema; level !== undefined; level = level.extends) {
		for (const relation of level.relations) {
			if (!out.has(relation.name)) {
				out.set(relation.name, relation)
			}
		}
	}
	return out
}

/**
 * The fields of a relation's keys: its primary key and every candidate key a statement of any level declares on it, a
 * key over its whole relation's fields (ir/desc.ts candidateKeyFields).
 */
const keyFieldsOf = (schema: SchemaDesc, relation: OrdinaryDesc): ReadonlySet<string> => {
	const out = new Set<string>(relation.primaryKey)
	for (let level: SchemaDesc | undefined = schema; level !== undefined; level = level.extends) {
		const declared = level.statements.flatMap((s) =>
			s.kind === "key" && s.side.relation === relation.name
				? (candidateKeyFields(s.side) ?? [])
				: []
		)
		for (const field of declared) {
			out.add(field)
		}
	}
	return out
}

/** The variables an expression reads. */
const exprVars = (e: ExprDesc, into: Set<string>): void => {
	switch (e.kind) {
		case "var":
			into.add(e.var)
			return
		case "field":
		case "value":
		case "parent":
		case "param":
		case "literal":
			return
		case "compute":
			for (const a of e.args) {
				exprVars(a, into)
			}
			return
		case "cast":
		case "base":
		case "not":
		case "in":
			exprVars(e.arg, into)
			return
		case "cond":
			exprVars(e.pred, into)
			exprVars(e.onTrue, into)
			exprVars(e.onFalse, into)
			return
		case "when":
			exprVars(e.subject, into)
			exprVars(e.proved, into)
			exprVars(e.otherwise, into)
			return
		case "compare":
		case "allen":
			exprVars(e.left, into)
			exprVars(e.right, into)
			return
		case "between":
			exprVars(e.arg, into)
			exprVars(e.low, into)
			exprVars(e.high, into)
			return
		case "and":
		case "or":
		case "closedAt":
		case "closedRow":
			for (const a of e.args) {
				exprVars(a, into)
			}
			return
		case "pointIn":
			exprVars(e.point, into)
			exprVars(e.span, into)
			return
		case "absent":
			sourceVars(e.source, into)
			bindingVars(e.bindings, into)
			return
	}
}

const bindingVars = (bindings: BindingsDesc, into: Set<string>): void => {
	for (const e of Object.values(bindings)) {
		exprVars(e, into)
	}
}

/** The variables of the enclosing rule a source reads: an import's bind map; every other source reads none itself. */
const sourceVars = (source: SourceDesc, into: Set<string>): void => {
	if (source.kind === "query") {
		for (const b of Object.values(source.bind)) {
			if (b.kind !== "relationParam") {
				exprVars(b, into)
			}
		}
	}
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
		case "param":
		case "paramOf":
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
 * The writable entry of `entry`, a query entry over the base `base` listed in its role's `write`, or why it is none.
 */
export const writableEntry = (
	base: SchemaDesc,
	entry: EntryDefinition
): Result.Result<WritableEntry<string, string>, WritabilityRefused> => {
	const name = entry.name
	const stage = unnamed(entry.query.stage)
	if (stage.kind !== "rules" || stage.arms.length !== 1) {
		return refused(name, { kind: "notOneArm" })
	}
	const [arm] = stage.arms

	/** The head: each field a bare variable, no variable named twice. */
	const headVars = new Map<string, string>()
	for (const [field, term] of Object.entries(arm.head).toSorted(([a], [b]) => compareText(a, b))) {
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
		for (const [field, e] of Object.entries(m.bindings).toSorted(([a], [b]) => compareText(a, b))) {
			if (e.kind === "var" && !contextBound.has(e.var)) {
				contextBound.set(e.var, { context, field })
			}
		}
	}

	/**
	 * Every field of T: written by a head variable, which binds no other field of T, or fixed; one context field may
	 * fix several.
	 */
	const fields = Object.keys(target.fields).toSorted(compareText)
	const fixed: Array<FixedField<string>> = []
	const fieldOfVar = new Map<string, string>()
	for (const field of fields) {
		const binding = occurrence.bindings[field]
		if (binding === undefined) {
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
			return refused(name, { kind: "fieldNotFixed", field })
		}
		fixed.push({ field, value: { kind: "context", ...context } })
	}
	/**
	 * Each head variable is bound to a declared field (suppliers), so it writes one; in the entry's field order, each
	 * keyed when its field is in a key of T, else claim-fixed when a context match binds its variable.
	 */
	const keyed = keyFieldsOf(base, target)
	const head = new Map<string, HeadField<string>>()
	for (const [x, headField] of [...headVars].toSorted(([, a], [, b]) => compareText(a, b))) {
		const field = fieldOfVar.get(x)
		if (field === undefined) {
			return refused(name, { kind: "noSupplyingOccurrence", candidates: 0 })
		}
		head.set(headField, {
			field,
			kind: keyed.has(field) ? "keyed" : contextBound.has(x) ? "claimFixed" : "free"
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
