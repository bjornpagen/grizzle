import type {
	ContextDesc,
	ExprDesc,
	HeadTermDesc,
	QueryDesc,
	QueryStageDesc,
	RuleDesc,
	SourceDesc
} from "#compiler/ir/desc.ts"

interface QueryUses {
	/** The stored, closed, derived and world relations the query reads, by name. */
	readonly relations: ReadonlySet<string>
	/** The parameters it needs, by name, its delta sources and its row: what a parameterless definition cannot have. */
	readonly inputs: ReadonlySet<string>
	/** The contexts it matches, by name, each as its first match carries it. */
	readonly contexts: ReadonlyMap<string, ContextDesc>
}

class Collector {
	readonly relations = new Set<string>()
	readonly inputs = new Set<string>()
	readonly contexts = new Map<string, ContextDesc>()

	query(q: QueryDesc): void {
		this.stage(q.stage)
	}

	stage(s: QueryStageDesc): void {
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

	rule(r: RuleDesc): void {
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

	source(s: SourceDesc): void {
		switch (s.kind) {
			case "relation":
				this.relations.add(s.name)
				return
			case "query": {
				/**
				 * An import's bound parameters are the binding's, not the importer's: only what the binding
				 * expressions use, and any input the binding leaves open (every one, for the empty binding), is an input
				 * of the importer.
				 */
				const inner = new Collector()
				inner.query(s.query)
				for (const r of inner.relations) {
					this.relations.add(r)
				}
				for (const [name, c] of inner.contexts) {
					if (!this.contexts.has(name)) {
						this.contexts.set(name, c)
					}
				}
				const bound = new Set(Object.keys(s.bind))
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
				for (const e of Object.values(s.bind)) {
					this.expr(e)
				}
				return
			}
			case "param":
				this.inputs.add(`relation parameter ${s.name}`)
				return
			case "paramOf":
				this.inputs.add(`relation parameter ${s.name}`)
				this.relations.add(s.relation)
				return
			case "delta":
				this.inputs.add(`delta.${s.side}(${s.relation})`)
				return
			case "row":
				this.inputs.add("row")
				return
			case "context":
				if (!this.contexts.has(s.context.name)) {
					this.contexts.set(s.context.name, s.context)
				}
				return
			case "interior":
			case "self":
				return
		}
	}

	head(h: HeadTermDesc): void {
		switch (h.kind) {
			case "aggregate":
				if (h.fn !== "count") {
					this.expr(h.arg)
				}
				return
			case "producer":
				for (const a of h.args) {
					this.expr(a)
				}
				return
			case "absent":
			case "allen":
			case "and":
			case "base":
			case "between":
			case "cast":
			case "compare":
			case "compute":
			case "cond":
			case "field":
			case "in":
			case "literal":
			case "not":
			case "or":
			case "param":
			case "parent":
			case "pointIn":
			case "value":
			case "var":
				this.expr(h)
		}
	}

	expr(e: ExprDesc): void {
		switch (e.kind) {
			case "param":
				this.inputs.add(`parameter ${e.name}`)
				return
			case "var":
			case "field":
			case "value":
			case "parent":
			case "literal":
				return
			case "compute":
				for (const a of e.args) {
					this.expr(a)
				}
				return
			case "cast":
			case "base":
			case "not":
			case "in":
				this.expr(e.arg)
				return
			case "cond":
				this.expr(e.pred)
				this.expr(e.onTrue)
				this.expr(e.onFalse)
				return
			case "compare":
				this.expr(e.left)
				this.expr(e.right)
				return
			case "between":
				this.expr(e.arg)
				this.expr(e.low)
				this.expr(e.high)
				return
			case "and":
			case "or":
				for (const a of e.args) {
					this.expr(a)
				}
				return
			case "allen":
				this.expr(e.left)
				this.expr(e.right)
				return
			case "pointIn":
				this.expr(e.point)
				this.expr(e.span)
				return
			case "absent":
				this.source(e.source)
				for (const b of Object.values(e.bindings)) {
					this.expr(b)
				}
				return
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
	return { relations: c.relations, inputs: c.inputs, contexts: c.contexts }
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
	source.kind === "query" ? stageApproximates(source.query.stage) : false

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
