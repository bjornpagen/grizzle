import { compareStrings } from "#compiler/core/order.ts"
import {
	type BindMapDesc,
	type BindTermDesc,
	type CallArgDesc,
	type ContextDesc,
	type ExprDesc,
	exprChildren,
	type FieldDesc,
	headTerms,
	type Inferred,
	type InferredExpr,
	type InferredHead,
	type InferredQuery,
	type InferredRule,
	type InferredSource,
	type InferredStage,
	type Located,
	mapExpr,
	type QueryDesc,
	type QueryStageDesc,
	type RuleDesc,
	nestedFields,
	type SourceDesc
} from "#compiler/ir/desc.ts"

/** A contract's field descriptor. */
type ContractFieldDesc = Extract<FieldDesc, { readonly kind: "contract" }>

interface QueryUses {
	/** The stored, closed, derived and world relations the query reads, by name. */
	readonly relations: ReadonlySet<string>
	/** The relations whose changes its delta sources read, by name: a read-back's, inside a ChangeSet. */
	readonly deltas: ReadonlySet<string>
	/** The parameters it needs, by name, its delta sources and its row: what a parameterless definition cannot have. */
	readonly inputs: ReadonlySet<string>
	/** The contexts it matches, by name, each as its first match carries it. */
	readonly contexts: ReadonlyMap<string, ContextDesc>
	/** The contracts it types a value by, each as written, at any depth of a type: each cast's target and each typed
	 * literal's type (a retype, which the engine writes, declares nothing). */
	readonly contracts: ReadonlyArray<ContractFieldDesc>
}

class Collector {
	readonly relations = new Set<string>()
	readonly deltas = new Set<string>()
	readonly inputs = new Set<string>()
	readonly contexts = new Map<string, ContextDesc>()
	readonly contracts: Array<ContractFieldDesc> = []

	query(q: InferredQuery): void {
		this.stage(q.stage)
	}

	stage(s: InferredStage): void {
		switch (s.kind) {
			case "rules":
				for (const arm of s.arms) {
					this.rule(arm)
				}
				return
			case "recursive":
				for (const arm of s.recursive.base) {
					this.rule(arm)
				}
				for (const arm of s.recursive.rec) {
					this.rule(arm)
				}
				return
			case "union":
				this.stage(s.input)
				for (const arm of s.arms) {
					this.rule(arm)
				}
				return
			case "attach":
				this.stage(s.input)
				this.query(s.attach.child)
				return
			case "named":
			case "order":
			case "approx":
				this.stage(s.input)
				return
			case "take":
				this.stage(s.input)
				if (s.take.kind === "param") {
					this.inputs.add(`parameter ${s.take.name}`)
				}
				return
		}
	}

	rule(r: InferredRule): void {
		for (const m of r.matches) {
			this.source(m.source)
			for (const e of Object.values(m.bindings)) {
				this.expr(e)
			}
		}
		for (const w of r.where) {
			this.expr(w)
		}
		for (const h of Object.values(r.head)) {
			this.head(h)
		}
		for (const i of r.interiors) {
			for (const arm of i.arms) {
				this.rule(arm)
			}
		}
		for (const a of r.attach) {
			this.query(a.child)
		}
	}

	/**
	 * A query read under a bind map, an import's or a call's rows argument's: what it reads is the importer's, but its
	 * bound parameters are the binding's, not the importer's: only what the binding expressions use, and any input the
	 * binding leaves open (every one, for the empty binding), is an input of the importer.
	 */
	#imported(query: InferredQuery, bind: BindMapDesc<Located, Inferred>): void {
		const inner = new Collector()
		inner.query(query)
		for (const r of inner.relations) {
			this.relations.add(r)
		}
		for (const r of inner.deltas) {
			this.deltas.add(r)
		}
		for (const [name, c] of inner.contexts) {
			this.contexts.getOrInsert(name, c)
		}
		for (const d of inner.contracts) {
			this.contracts.push(d)
		}
		const bound = new Set(Object.keys(bind))
		for (const input of inner.inputs) {
			const name = input.startsWith("parameter ")
				? input.slice("parameter ".length)
				: input.startsWith("relation parameter ")
					? input.slice("relation parameter ".length)
					: undefined
			if (name === undefined || !bound.has(name)) {
				this.inputs.add(input)
			}
		}
		for (const b of Object.values(bind)) {
			if (b.kind === "relationParam") {
				this.inputs.add(`relation parameter ${b.name}`)
			} else if (b.kind === "rows") {
				this.#imported(b.query, b.bind)
			} else {
				this.expr(b)
			}
		}
	}

	source(s: InferredSource): void {
		switch (s.kind) {
			case "relation":
				this.relations.add(s.name)
				return
			case "query":
			case "step":
				this.#imported(s.query, s.bind)
				return
			case "call":
			case "callField":
				for (const a of Object.values(s.args)) {
					if (a.kind === "rows") {
						this.#imported(a.query, a.bind)
					} else {
						this.expr(a)
					}
				}
				return
			case "split":
				for (const a of Object.values(s.args)) {
					this.expr(a)
				}
				return
			case "series":
				this.expr(s.low)
				this.expr(s.high)
				return
			case "arm":
				this.expr(s.value)
				return
			case "param":
				this.inputs.add(`relation parameter ${s.name}`)
				return
			case "paramOf":
				this.inputs.add(`relation parameter ${s.name}`)
				this.relations.add(s.relation)
				return
			case "delta":
				this.inputs.add(`delta.${s.side}(${s.relation})`)
				this.deltas.add(s.relation)
				return
			case "row":
				this.inputs.add("row")
				return
			case "context":
				this.contexts.getOrInsert(s.context.name, s.context)
				return
			case "interior":
			case "self":
				return
		}
	}

	head(h: InferredHead): void {
		for (const e of headTerms(h)) {
			this.expr(e)
		}
	}

	expr(e: InferredExpr): void {
		if (e.kind === "param") {
			this.inputs.add(`parameter ${e.name}`)
			return
		}
		if (e.kind === "absent" || e.kind === "exists") {
			this.source(e.source)
			for (const b of Object.values(e.bindings)) {
				this.expr(b)
			}
			return
		}
		if (e.kind === "closedAt" || e.kind === "closedRow" || e.kind === "closedHas") {
			this.relations.add(e.relation)
		}
		if (e.kind === "cast") {
			this.#typed(e.to)
		}
		if (e.kind === "literal" && e.type !== undefined) {
			this.#typed(e.type)
		}
		for (const c of exprChildren(e)) {
			this.expr(c.term)
		}
	}

	/** Each contract `type` names, at any depth. */
	#typed(type: FieldDesc): void {
		nestedFields(type, (d) => {
			if (d.kind === "contract") {
				this.contracts.push(d)
			}
		})
	}
}

/**
 * What a query description reads and what inputs it needs.
 *
 * A derived relation's definition reads only lower levels and reads no parameter and no context; a role's query entry
 * reads only its base and no parameter, and may read contexts. These are structural facts of a QueryDesc: the relations
 * its match sources and relational negations name, through imported queries, attachments, interior stages and
 * recursive arms; the contexts it matches; and every parameter it uses, scalar or relation-valued, including a take
 * bound to a parameter. A read-back's delta source is an input too: it exists only inside a ChangeSet.
 */
export const queryUses = (q: QueryDesc): QueryUses => {
	const c = new Collector()
	c.query(q)
	return {
		relations: c.relations,
		deltas: c.deltas,
		inputs: c.inputs,
		contexts: c.contexts,
		contracts: c.contracts
	}
}

/**
 * Whether a query stage, at any depth of its imports, attachments and interiors, approximates a nearest-neighbour
 * search.
 */
const stageApproximates = (stage: QueryStageDesc): boolean => {
	switch (stage.kind) {
		case "approx":
			return true
		case "rules":
			return stage.arms.some(ruleApproximates)
		case "recursive":
			return [...stage.recursive.base, ...stage.recursive.rec].some(ruleApproximates)
		case "union":
			return stageApproximates(stage.input) || stage.arms.some(ruleApproximates)
		case "attach":
			return stageApproximates(stage.input) || stageApproximates(stage.attach.child.stage)
		case "named":
		case "order":
		case "take":
			return stageApproximates(stage.input)
	}
}

const ruleApproximates = (rule: RuleDesc): boolean =>
	rule.matches.some((m) => sourceApproximates(m.source)) ||
	rule.interiors.some((i) => i.arms.some(ruleApproximates)) ||
	rule.attach.some((a) => stageApproximates(a.child.stage))

const sourceApproximates = (source: SourceDesc): boolean =>
	source.kind === "query" || source.kind === "step" ? stageApproximates(source.query.stage) : false

/** Whether a query's own heading carries an attachment: an attach stage on its stage chain, or an arm that attaches. */
const stageAttaches = (stage: QueryStageDesc): boolean => {
	switch (stage.kind) {
		case "attach":
			return true
		case "rules":
			return stage.arms.some((a) => a.attach.length > 0)
		case "recursive":
			return false
		case "union":
			return stageAttaches(stage.input) || stage.arms.some((a) => a.attach.length > 0)
		case "named":
		case "order":
		case "take":
		case "approx":
			return stageAttaches(stage.input)
	}
}

/** Whether a query searches approximately anywhere: a role's query entry does not. */
export const approximates = (q: QueryDesc): boolean => stageApproximates(q.stage)

/** Whether a query's delivered heading carries an attachment: a role's query entry, a flat view, does not. */
export const attachesHeading = (q: QueryDesc): boolean => stageAttaches(q.stage)

/** The relations `query` reads by name at any depth, through every query it imports, in name order. */
export const readsOf = (query: QueryDesc): ReadonlyArray<string> =>
	[...queryUses(query).relations].toSorted(compareStrings)

/**
 * The queries `query` imports under an empty bind map, at any depth, each Description object once, every query one
 * imports before it: each such import of a match or a negation, in every stage, interior stage and attachment of it and
 * of every query it imports, and each query a bind map or a call binds rows to under an empty bind map of its own. Such
 * an import reads no parameter of its reader and no outer value, so its rows are a relation of the schema's alone, a
 * canonical relation's (the header); an import under a bind map reads its reader's values and is walked for the closed
 * imports inside it.
 */
export const closedImportsOf = (query: QueryDesc): ReadonlyArray<QueryDesc> => {
	const out: Array<QueryDesc> = []
	const seen = new Set<QueryDesc>()
	const imported = (q: QueryDesc, closed: boolean): void => {
		if (seen.has(q)) {
			return
		}
		seen.add(q)
		walk(q)
		if (closed) {
			out.push(q)
		}
	}
	const bound = (term: BindTermDesc | CallArgDesc): void => {
		if (term.kind === "rows") {
			imported(term.query, Object.keys(term.bind).length === 0)
		}
	}
	const source = (s: SourceDesc): SourceDesc => {
		switch (s.kind) {
			case "query":
			case "step":
				imported(s.query, s.kind === "query" && Object.keys(s.bind).length === 0)
				Object.values(s.bind).forEach(bound)
				return s
			case "call":
			case "callField":
				Object.values(s.args).forEach(bound)
				return s
			case "relation":
			case "split":
			case "series":
			case "param":
			case "paramOf":
			case "interior":
			case "self":
			case "delta":
			case "context":
			case "row":
			case "arm":
				return s
		}
	}
	const exprSources = (e: ExprDesc): void => {
		mapExpr(e, {
			leaf: (x) => x,
			term: (x) => {
				exprSources(x)
				return x
			},
			source
		})
	}
	const rule = (r: RuleDesc): void => {
		for (const m of r.matches) {
			source(m.source)
		}
		r.where.forEach(exprSources)
		for (const i of r.interiors) {
			i.arms.forEach(rule)
		}
		for (const a of r.attach) {
			walk(a.child)
		}
	}
	const stage = (st: QueryStageDesc): void => {
		switch (st.kind) {
			case "rules":
				st.arms.forEach(rule)
				return
			case "union":
				stage(st.input)
				st.arms.forEach(rule)
				return
			case "recursive":
				st.recursive.base.forEach(rule)
				st.recursive.rec.forEach(rule)
				return
			case "attach":
				stage(st.input)
				walk(st.attach.child)
				return
			case "named":
			case "order":
			case "take":
			case "approx":
				stage(st.input)
		}
	}
	const walk = (q: QueryDesc): void => {
		stage(q.stage)
	}
	walk(query)
	return out
}
