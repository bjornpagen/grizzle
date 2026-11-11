import { CompileError } from "#compiler/core/errors.ts"
import { captureLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isPlainRecord } from "#compiler/core/record.ts"
import type { RuleDesc, VarDesc } from "#compiler/ir/desc.ts"
import type {
	BuilderScope,
	OpenBindings,
	OpenExpr,
	OpenHead,
	OpenMatch,
	OpenRule,
	VarRef,
	VarScope
} from "#compiler/ir/open.ts"

import {
	attachedDecoders,
	attachmentName,
	checkDelivery,
	parentVars,
	runAttach
} from "#compiler/query/build/attach.ts"

import { type Heading, heading, withAttachment } from "#compiler/query/build/heading.ts"
import { hostArguments } from "#compiler/query/build/host.ts"
import {
	isCallback,
	newRuleContext,
	noOrigin,
	type RuleContext,
	recordVariables,
	requireLevel,
	type SchemaInfo,
	sharedVariable,
	withRule
} from "#compiler/query/build/scope.ts"

import {
	described,
	headingOf,
	nonePending,
	type QueryCarriers,
	refusedRows,
	registerSource,
	relationParam,
	type SourceInfo,
	sourceInfo
} from "#compiler/query/build/state.ts"
import * as T from "#compiler/query/build/terms.ts"
import { spellRule } from "#compiler/query/build/walk.ts"
import { type PredicateValue, predicateValue, type Typing } from "#compiler/scalar/compute/term.ts"
import { malformed, builderRefusal, requireName } from "#compiler/schema/protocol.ts"
import { headRecord, record } from "#compiler/schema/record.ts"
import type { Carriers } from "#compiler/types/core/phantom.ts"
import type { Evidence } from "#compiler/types/evidence/evidence.ts"
import type { Decoders, Finished } from "#compiler/types/query/query.ts"
import type { NoFacts, RelationHeading, Rule } from "#compiler/types/query/rule.ts"
import type { HeadTerms, ResultOf } from "#compiler/types/query/terms.ts"

/**
 * A finished rule: its RuleDesc, heading and carriers, the rule callback it belongs to, and the attachment children
 * whose parent variables its clauses spell (finishRule).
 */
interface FinishedState<C extends Carriers = Carriers> {
	readonly ctx: RuleContext
	readonly rule: RuleDesc
	readonly heading: Heading
	readonly carriers: QueryCarriers<C>
	readonly pending: ReadonlySet<BuilderScope>
}

const finisheds = new WeakMap<object, FinishedState>()

const finishedState = (value: unknown): FinishedState | undefined =>
	(typeof value === "object" || typeof value === "function") && value !== null
		? finisheds.get(value)
		: undefined

/** A rule callback's run: the rule it finished, and the Finished it returned, of the type its callback gives it. */
export interface RuleRun<F> {
	readonly state: FinishedState
	readonly finished: F
}

/**
 * The rule builder a query arm receives.
 *
 * A rule callback runs once, at construction, and records a RuleDesc. `r` is an immutable value: match and
 * where return a new rule with the clause appended, and find seals the rule into a Finished. The callback must return
 * the Finished of a rule it was given; anything else is refused, because a rule a callback dropped on the floor would
 * silently lose clauses.
 *
 * - `match(source, bindings)` records one occurrence of a source: a stored, closed or derived relation, a query (never
 *   an Ordered), a bound import, a relation parameter, an interior stage of this rule, or, in a recursive arm, self.
 *   A binding is a term (a variable, a parent variable, a typed constant, a Compute term), a parameter use, or a
 *   JavaScript value of the bound field's base. Only fields of the source's heading may be bound; binding a variable is
 *   what binds it, and merely minting it with v does not.
 * - `where(...predicates)` adds filters; `find(head)` names the answer columns. A head term is a term (a parameter or
 *   a typed constant among them), an aggregate, a producer, or a JavaScript value, which find holds as its head literal
 *   (schema/record.ts headRecord); unaggregated head terms group an aggregate head, and an aggregate folds the rule's
 *   distinct full bindings.
 * - `interior(rule)` describes a local stage of this rule and returns it as a source of this rule.
 * - `param(name, descriptor)` is a scalar parameter, a term of the descriptor's type; `relation(name, heading)` and
 *   `relation(name, Relation)` are relation-valued parameters.
 * - The comparisons, inSet, and, or, not, allen, pointIn, the producers and the aggregates are terms.ts's.
 *
 * At find the rule's references are spelled (scope.ts): its variables `<scope>.<field>`, one scope of each name, and
 * listed with their origins in RuleDesc.vars in order of first use; its interior stages "i0", "i1", ... in creation
 * order; its parent variables by their bare columns.
 *
 * Runs a rule callback over a fresh rule of schema S and returns the rule it finished. A recursive arm's callback is
 * run as one over the rule alone, beside its definition's self, the token of the definition whose self it may match.
 */
export const runRule = <S, F>(
	schema: SchemaInfo,
	callback: (r: Rule<S>) => F,
	label: string,
	selfToken: object | undefined
): RuleRun<F> => {
	if (!isCallback(callback)) {
		throw malformed(label, "a rule callback, (r) => r.match(...).find({ ... })")
	}
	const ctx = newRuleContext(schema, selfToken)
	const loc = captureLoc(label, [])
	const r = ruleValue<S, unknown, "no match", NoFacts, never>(ctx, [], [], loc)
	const finished = withRule(ctx, () => callback(r))
	const state = finishedState(finished)
	if (state === undefined || state.ctx !== ctx) {
		throw malformed(
			label,
			"a callback that returns the Finished of the rule it received: return r.match(...).find({ ... })"
		)
	}
	return { state, finished }
}

/** Whether a head term carries the column its cells are read with: every term the builder typed does. */
const carriesColumn = (term: unknown): boolean => hasProperties(term) && "column" in term

const requireActive = (ctx: RuleContext, label: string): void => {
	if (!ctx.active) {
		throw malformed(label, "a rule builder used inside the callback that received it")
	}
}

const checkScope = (info: SourceInfo, ctx: RuleContext, label: string): void => {
	switch (info.scope.kind) {
		case "anywhere":
			return
		case "interior":
			if (info.scope.ctx !== ctx) {
				throw malformed(label, "an interior stage matched in the rule that describes it")
			}
			return
		case "self":
			if (ctx.selfToken !== info.scope.token) {
				throw malformed(label, "self matched in a recursive arm of its own definition")
			}
			return
		case "written":
			requireLevel(info.scope.over, ctx.schema.over, label)
			return
	}
}

/**
 * The bindings of a match or negation: fields of the source's scalar heading, each bound to a term, a parameter or a
 * JavaScript value of the field's base.
 */
const bindingsDesc = (bindings: unknown, source: Heading, label: string): OpenBindings => {
	if (!isPlainRecord(bindings)) {
		throw malformed(
			label,
			"bindings: a record from the source's fields to terms, parameters or literals"
		)
	}
	const out: Record<string, OpenExpr> = {}
	for (const [field, value] of Object.entries(bindings)) {
		if (source.attached.has(field)) {
			throw malformed(
				label,
				`a scalar field; ${JSON.stringify(field)} is an attachment, a nested set: match the child query to read it`
			)
		}
		const typing = source.fields.get(field)
		if (typing === undefined) {
			throw builderRefusal(label, "not a field of the arms the bindings select")
		}
		if (value === undefined) {
			throw malformed(
				label,
				`a binding for ${field}: a term, a parameter or a literal; leave a field unbound by omitting it`
			)
		}
		out[field] = T.fieldBinding(value, typing, `${label} ${field}`)
	}
	return out
}

/**
 * The spelling find performs (scope.ts), refusing capture and a second scope of one name: each variable by its scope's
 * name and field, an interior stage by its id and a parent variable by its bare column, with the attachment children
 * whose parent variables the rule spells.
 */
const finishRule = (
	raw: OpenRule,
	ctx: RuleContext,
	label: string
): { readonly rule: RuleDesc; readonly pending: ReadonlySet<BuilderScope> } => {
	const canonical = new Map<VarRef, string>()
	const scopes = new Map<string, VarScope>()
	const vars: Array<VarDesc> = []
	const pending = new Set<BuilderScope>()
	const rule = spellRule(raw, {
		var: (ref) => {
			const known = canonical.get(ref)
			if (known !== undefined) {
				return known
			}
			const spelling = `${ref.scope.name}.${ref.field}`
			if (!ref.build.active) {
				throw malformed(label, "variables minted by v")
			}
			if (ref.owner !== "adopted" && ref.owner !== ctx && ref.owner.active) {
				throw malformed(
					label,
					`a variable of this rule: ${spelling} belongs to an enclosing rule, and reaches an inner stage only through Q.bind or an attachment's parent variables`
				)
			}
			if (sharedVariable(ctx, ref)) {
				throw malformed(
					label,
					`a variable of this rule: ${spelling} is also used by an enclosing or nested rule, where it would be a different variable; it reaches an inner stage only through Q.bind or an attachment's parent variables`
				)
			}
			const prior = scopes.get(ref.scope.name)
			if (prior !== undefined && prior !== ref.scope) {
				throw CompileError.make({
					_tag: "DuplicateIdentity",
					at: ref.scope.loc,
					duplicate: { kind: "scope", name: ref.scope.name, earlier: prior.loc }
				})
			}
			scopes.set(ref.scope.name, ref.scope)
			canonical.set(ref, spelling)
			vars.push({ id: spelling, origin: ref.origin, loc: ref.loc })
			return spelling
		},
		interior: (ref) => {
			if (ref.owner !== ctx) {
				throw malformed(label, "an interior stage matched in the rule that describes it")
			}
			return ref.id
		},
		parent: (ref) => {
			if (!ref.scope.active) {
				throw malformed(label, "a parent variable inside the attachment child that received it")
			}
			pending.add(ref.scope)
			return ref.column
		}
	})
	recordVariables(ctx, canonical.keys())
	return { rule: { ...rule, vars }, pending }
}

/**
 * What a JavaScript caller sees of a Finished: a view of the typed value (types/query Finished), never a second
 * builder, every member taking what such a caller may pass.
 */
export interface FinishedValue extends Built, Decoders<unknown, unknown> {
	attach(name: unknown, child: unknown, delivery: unknown): FinishedValue
}

/**
 * A Finished over a state and its decoders, implementing Finished<Head, Ev, P, S, IHead, Hc, Cx>: its heading of
 * carriers is its head, or its arm's after an attachment, and the empty heading for a described arm (state.ts
 * headingOf). The contexts it reads, Cx, are a phantom.
 */
const finishedValue = <Head, Ev extends Evidence, P, S, IHead, Hc extends Carriers, Cx>(
	state: FinishedState<Hc>,
	decoders: Decoders<Head, IHead>
): Finished<Head, Ev, P, S, IHead, Hc, Cx> => {
	const carriers = headingOf(state.carriers)
	const value: Finished<Head, Ev, P, S, IHead, Hc, Cx> = {
		...builtMark,
		heading: carriers,
		rows: decoders.rows,
		immediate: decoders.immediate,
		/**
		 * An arm may attach before it joins a union; the arm keeps its own attached heading. Its parent variables are
		 * minted over the arm's carriers, and its decoders built from the stated delivery (attach.ts attachedDecoders).
		 */
		attach: (name, child, delivery) => {
			const label = `Finished.attach(${typeof name === "string" ? name : "?"})`
			hostArguments(label, [name, child, delivery])
			const n = attachmentName(name, state.heading, label)
			if (!isCallback(child)) {
				throw malformed(
					label,
					"an attachment child, (parent) => query(S).rule(...), a query over the parent's variables"
				)
			}
			checkDelivery(delivery, state.heading, label)
			const attached = runAttach(
				n,
				(scope) => child(parentVars(scope, state.heading, carriers)),
				label,
				state.ctx.schema.over
			)
			return finishedValue(
				{
					ctx: state.ctx,
					rule: { ...state.rule, attach: [...state.rule.attach, attached.desc] },
					heading: withAttachment(state.heading, n),
					carriers: state.carriers,
					pending: state.pending
				},
				attachedDecoders(decoders, name, attached.child, delivery)
			)
		}
	}
	finisheds.set(value, state)
	return Object.freeze(value)
}

/**
 * Whether r.relation's heading is a relation, whose heading of descriptors it takes, rather than a heading of
 * descriptors itself: a heading's values are descriptors, never the string "relation".
 */
const isRelationHeading = <C>(
	given: RelationHeading<C>
): given is { readonly kind: "relation"; readonly heading: C } => {
	/** A heading of descriptors is whatever the caller passed, so its kind is read as an unknown value. */
	const value: unknown = given
	return hasProperties(value) && value["kind"] === "relation"
}

/**
 * What a JavaScript caller sees of a rule: a view of the typed value (types/query Rule), never a second builder, every
 * member taking what such a caller may pass.
 */
export interface RuleValue {
	readonly match: (source: unknown, bindings: unknown) => RuleValue
	readonly where: (...predicates: ReadonlyArray<unknown>) => RuleValue
	readonly find: (head: unknown) => FinishedValue
	readonly interior: (callback: unknown) => Built
	readonly param: (name: unknown, type: unknown, ...extra: ReadonlyArray<unknown>) => Built
	readonly relation: (name: unknown, heading: unknown, ...extra: ReadonlyArray<unknown>) => Built
	readonly eq: (a: unknown, b: unknown) => PredicateValue
	readonly ne: (a: unknown, b: unknown) => PredicateValue
	readonly lt: (a: unknown, b: unknown) => PredicateValue
	readonly le: (a: unknown, b: unknown) => PredicateValue
	readonly gt: (a: unknown, b: unknown) => PredicateValue
	readonly ge: (a: unknown, b: unknown) => PredicateValue
	readonly between: (a: unknown, low: unknown, high: unknown) => PredicateValue
	readonly inSet: (a: unknown, values: unknown) => PredicateValue
	readonly and: (...predicates: ReadonlyArray<unknown>) => PredicateValue
	readonly or: (...predicates: ReadonlyArray<unknown>) => PredicateValue
	readonly not: (source: unknown, bindings: unknown) => PredicateValue
	readonly allen: (left: unknown, mask: unknown, right: unknown) => PredicateValue
	readonly pointIn: (point: unknown, span: unknown) => PredicateValue
	readonly intersection: (left: unknown, right: unknown) => Built
	readonly difference: (left: unknown, right: unknown) => Built
	readonly pack: (spans: unknown) => Built
	readonly count: (...extra: ReadonlyArray<unknown>) => Built
	readonly sum: (term: unknown) => Built
	readonly mean: (term: unknown) => Built
	readonly min: (term: unknown) => Built
	readonly max: (term: unknown) => Built
}

/** A member's result once its arguments are read at the boundary (host.ts). */
const guarded = <A>(label: string, args: ReadonlyArray<unknown>, member: () => A): A => {
	hostArguments(label, args)
	return member()
}

/**
 * A rule over a state, implementing Rule<S, Params, Sole, Facts, Cx>: each method under its contextual
 * signature, so the terms, aggregates and producers it builds carry the columns and SQL types their types give them.
 */
const ruleValue = <S, Params, Sole, Facts, Cx>(
	ctx: RuleContext,
	matches: ReadonlyArray<OpenMatch>,
	where: ReadonlyArray<OpenExpr>,
	loc: SourceLoc
): Rule<S, Params, Sole, Facts, Cx> => {
	const value: Rule<S, Params, Sole, Facts, Cx> = {
		match: (source, bindings) => {
			hostArguments("r.match", [source, bindings])
			requireActive(ctx, "r.match")
			const info = sourceInfo(source, "r.match", ctx.schema.env)
			const label = `r.match(${info.label})`
			checkScope(info, ctx, label)
			const match: OpenMatch = {
				source: info.desc,
				bindings: bindingsDesc(bindings, info.heading, label),
				loc: captureLoc(label, [])
			}
			return ruleValue(ctx, [...matches, match], where, loc)
		},
		where: (...predicates) => {
			hostArguments("r.where", predicates)
			requireActive(ctx, "r.where")
			const added = predicates.map((p, i) => T.predicateOperand(p, `r.where predicate ${i + 1}`))
			return ruleValue(ctx, matches, [...where, ...added], loc)
		},
		find: (head) => {
			hostArguments("r.find", [head])
			requireActive(ctx, "r.find")
			if (!isPlainRecord(head)) {
				throw malformed("r.find", "a head: a record from answer column names to head terms")
			}
			for (const name of Object.keys(head)) {
				requireName(name, "r.find", "an answer column name")
			}
			const entries = headRecord(head, (given, name) => T.literalTerm(given, `r.find ${name}`))
			const terms: Record<string, OpenHead> = {}
			const fields: Array<readonly [string, Typing]> = []
			for (const [name, term] of Object.entries<unknown>(entries)) {
				const answer = T.headTerm(term, `r.find ${name}`)
				terms[name] = answer.desc
				fields.push([name, answer.typing])
			}
			const raw: OpenRule = {
				vars: [],
				matches,
				where,
				head: terms,
				interiors: [...ctx.interiors],
				attach: [],
				loc
			}
			/**
			 * The head's records, under either reading (schema/record.ts record): every head term the builder typed
			 * carries its column, and the head as find holds it is the arm's carriers. A term it could not type, of a
			 * source rebuilt from its Description alone, has none: the arm is described, and delivers no records
			 * (refusedRows).
			 */
			const typed = Object.values<unknown>(entries).every(carriesColumn)
			const carriers: QueryCarriers<HeadTerms<typeof head>> = typed
				? { kind: "typed", carriers: entries }
				: described
			const rows = typed ? record(entries) : refusedRows<ResultOf<HeadTerms<typeof head>>>()
			const finished = finishRule(raw, ctx, "r.find")
			return finishedValue(
				{
					ctx,
					rule: finished.rule,
					heading: heading(fields, []),
					carriers,
					pending: finished.pending
				},
				{ rows, immediate: rows }
			)
		},
		interior: (rule) => {
			hostArguments("r.interior", [rule])
			requireActive(ctx, "r.interior")
			const stage = runRule(ctx.schema, rule, "r.interior", undefined)
			nonePending(stage.state.pending, "r.interior")
			const id = `i${ctx.interiors.length}`
			ctx.interiors.push({ id, arms: [stage.state.rule] })
			const carriers = stage.finished.heading
			return registerSource(Object.freeze({ ...builtMark, heading: carriers }), {
				desc: { kind: "interior", id: { owner: ctx, id } },
				heading: stage.state.heading,
				carriers,
				origin: noOrigin,
				scope: { kind: "interior", ctx },
				label: `interior ${id}`
			})
		},
		param: (name, type, ...extra: ReadonlyArray<unknown>) => {
			hostArguments("r.param", [name, type, ...extra])
			const n = requireName(name, "r.param", "a parameter name")
			if (extra.length > 0) {
				throw malformed("r.param", "r.param(name, descriptor): two arguments")
			}
			return T.paramTerm(n, type, `r.param(${n})`)
		},
		relation: (name, given, ...extra: ReadonlyArray<unknown>) => {
			hostArguments("r.relation", [name, given, ...extra])
			const n = requireName(name, "r.relation", "a parameter name")
			if (extra.length > 0) {
				throw malformed("r.relation", "r.relation(name, heading): two arguments")
			}
			const carriers = isRelationHeading(given) ? given.heading : given
			return relationParam(n, given, carriers, ctx.schema.env, `r.relation(${n})`)
		},
		eq: (a, b) => guarded("r.eq", [a, b], () => T.compare("eq")(a, b)),
		ne: (a, b) => guarded("r.ne", [a, b], () => T.compare("ne")(a, b)),
		lt: (a, b) => guarded("r.lt", [a, b], () => T.compare("lt")(a, b)),
		le: (a, b) => guarded("r.le", [a, b], () => T.compare("le")(a, b)),
		gt: (a, b) => guarded("r.gt", [a, b], () => T.compare("gt")(a, b)),
		ge: (a, b) => guarded("r.ge", [a, b], () => T.compare("ge")(a, b)),
		between: (a, low, high) => guarded("r.between", [a, low, high], () => T.between(a, low, high)),
		inSet: (a, values) => guarded("r.inSet", [a, values], () => T.inSet(a, values)),
		and: (...predicates) => guarded("r.and", predicates, () => T.and(predicates)),
		or: (...predicates) => guarded("r.or", predicates, () => T.or(predicates)),
		/** Relational negation only: no fact of the source matches the bindings. */
		not: (source, bindings) => {
			hostArguments("r.not", [source, bindings])
			if (T.isTerm(source) || (hasProperties(source) && "predicate" in source)) {
				throw malformed(
					"r.not",
					"a relation and bindings: r.not is relational negation; a scalar negation is the negated comparison or Compute.not"
				)
			}
			requireActive(ctx, "r.not")
			const info = sourceInfo(source, "r.not", ctx.schema.env)
			const label = `r.not(${info.label})`
			checkScope(info, ctx, label)
			return predicateValue({
				kind: "absent",
				source: info.desc,
				bindings: bindingsDesc(bindings, info.heading, label)
			})
		},
		allen: (left, mask, right) =>
			guarded("r.allen", [left, mask, right], () => T.allen(left, mask, right)),
		pointIn: (point, span) => guarded("r.pointIn", [point, span], () => T.pointIn(point, span)),
		intersection: (left, right) =>
			guarded("r.intersection", [left, right], () => T.intersection(left, right)),
		difference: (left, right) =>
			guarded("r.difference", [left, right], () => T.difference(left, right)),
		pack: (spans) => guarded("r.pack", [spans], () => T.pack(spans)),
		count: (...extra: ReadonlyArray<unknown>) => guarded("r.count", extra, () => T.count(extra)),
		sum: (term) => guarded("r.sum", [term], () => T.sum(term)),
		mean: (term) => guarded("r.mean", [term], () => T.mean(term)),
		min: (term) => guarded("r.min", [term], () => T.min(term)),
		max: (term) => guarded("r.max", [term], () => T.max(term))
	}
	return Object.freeze(value)
}
