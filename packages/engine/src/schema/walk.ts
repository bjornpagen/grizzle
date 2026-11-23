import {
	type BindMapDesc,
	type ContextDesc,
	exprChildren,
	headTerms,
	type Inferred,
	type InferredExpr,
	type InferredHead,
	type InferredQuery,
	type InferredRule,
	type InferredSource,
	type InferredStage,
	type Located,
	type QueryDesc,
	type QueryStageDesc,
	type RuleDesc,
	type SourceDesc
} from "#compiler/ir/desc.ts"

interface QueryUses {
	/** The stored, closed, derived and world relations the query reads, by name. */
	readonly relations: ReadonlySet<string>
	/** The relations whose changes its delta sources read, by name: a read-back's, inside a ChangeSet. */
	readonly deltas: ReadonlySet<string>
	/** The parameters it needs, by name, its delta sources and its row: what a parameterless definition cannot have. */
	readonly inputs: ReadonlySet<string>
	/** The contexts it matches, by name, each as its first match carries it. */
	readonly contexts: ReadonlyMap<string, ContextDesc>
}

class Collector {
	readonly relations = new Set<string>()
	readonly deltas = new Set<string>()
	readonly inputs = new Set<string>()
	readonly contexts = new Map<string, ContextDesc>()

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
				this.expr(s.text)
				return
			case "series":
				this.expr(s.low)
				this.expr(s.high)
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
		for (const c of exprChildren(e)) {
			this.expr(c.term)
		}
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
	return { relations: c.relations, deltas: c.deltas, inputs: c.inputs, contexts: c.contexts }
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
