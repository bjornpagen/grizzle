import { lastNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { canonicalTextOf, sameContent } from "#compiler/core/canonical.ts"
import type { CrossOwnerRead } from "#compiler/core/errors.ts"
import {
	type BindingsDesc,
	type BindMapDesc,
	type ChangeSetDesc,
	type ExprDesc,
	exprChildren,
	type MatchDesc,
	type ProgramDesc,
	type QueryDesc,
	type QueryStageDesc,
	type RowsDesc,
	type RuleDesc,
	type SchemaDesc,
	type SourceDesc,
	unclocked
} from "#compiler/ir/desc.ts"
import {
	keyFixed,
	keysOf,
	type Owner,
	type PinChain,
	pinForms,
	type Scope
} from "#compiler/schema/scope.ts"

/**
 * Condition three of scoped entries: a program over a role's base runs on a role holding relations scoped
 * (schema/scope.ts) only where it means, over the owner's rows, what it means over every row, kept to the owner's: row
 * by row. A program over the role itself is written over the owner's rows and is never judged here.
 *
 * Over the owner's rows, every scoped relation the program reads holds only the rows its scope admits. A match of a
 * rule, a positive one, then derives a row only from rows of the owner's: the program's rows over the slice are exactly
 * those it derives over every row from the owner's alone, the slice's meaning of a positive query. Every other read
 * decides by rows it may not see: a negation decides by an absence, an aggregate by every row of its group, a take by
 * every row it orders. Such a read means the same over the slice only where every row it decides by is the owner's, or
 * none is, which this module proves by pins.
 *
 * A pin is a statement that a row is the owner's, by a chain and terms (schema/scope.ts PinForm): the owner holding a
 * value, or a scoped relation's row at a key being the owner's. Each scoped row a rule matches positively is the
 * owner's over the slice, so it establishes every pin its scope's forms read off its terms, and the pin of each of its
 * relation's keys it binds whole. A negated match of a scoped relation is admitted where its own pin, its scope's
 * last form at its terms, is one the rule establishes: every row it could see then holds the owner's row's pin, so it is
 * the owner's, and the absence is the same over the slice. An imported query is read for the pins every row of it holds
 * and those every row needs, each over its head fields, its parameters and literals, mapped to the importer's terms by
 * the match's bindings and the import's bind map; a negated import is admitted where every pin a row of it needs is
 * established. An aggregate's rule is admitted where every pin each of its rows needs is fixed within a group: each term
 * a group field's variable, a parameter, a literal or a variable a context fixes. A take, an approximate search and a
 * declared function's rows argument are admitted where every pin their rows need is fixed for the whole evaluation, so
 * every row of them is the owner's or none is. Anything else is refused as OutsideRole crossOwner, naming the scoped
 * relation and the read.
 */

/** A term a pin reads: a variable of the rule, a parameter of the query, a literal, or a head field of the query. */
type Term =
	| { readonly kind: "var"; readonly id: string }
	| { readonly kind: "param"; readonly name: string }
	| { readonly kind: "literal"; readonly text: string }
	| { readonly kind: "head"; readonly field: string }

const termKey = (t: Term): string => {
	switch (t.kind) {
		case "var":
			return `v ${t.id}`
		case "param":
			return `p ${t.name}`
		case "literal":
			return `l ${t.text}`
		case "head":
			return `h ${t.field}`
	}
}

/** A pin: a chain, by the key that identifies it (Chains), and its terms. */
interface Pin {
	readonly chain: string
	readonly terms: ReadonlyArray<Term>
}

const pinKey = (p: Pin): string => JSON.stringify([p.chain, p.terms.map(termKey)])

/**
 * What a row of a rule or a query needs to be the owner's: the pin a scoped relation's row it matched holds, or none
 * the reader can state (`opaque`), its terms outside what the reader names. Each names the scoped relation.
 */
type Need =
	| { readonly kind: "pin"; readonly relation: string; readonly pin: Pin }
	| { readonly kind: "opaque"; readonly relation: string }

/** What a query's rows hold and need, over its head fields, parameters and literals (Term). */
interface Rows {
	readonly holds: ReadonlyArray<Pin>
	readonly needs: ReadonlyArray<Need>
}

/** A refusal: the scoped relation a read decides by across owners, and the read. */
export interface CrossOwner {
	readonly relation: string
	readonly read: CrossOwnerRead
}

/**
 * The chains of one role's scopes, each by a key: an owner by its query and field, a scope by its definition, each
 * compared by content, so two scopes of one definition, made apart, are one chain.
 */
class Chains {
	readonly #owners: Array<Owner> = []
	readonly #scopes: Array<Scope> = []

	key(chain: PinChain): string {
		switch (chain.kind) {
			case "owner": {
				const at = this.#owners.findIndex(
					(o) => o.field === chain.owner.field && sameContent(o.query, chain.owner.query)
				)
				const index = at === -1 ? this.#owners.push(chain.owner) - 1 : at
				return `owner ${index}`
			}
			case "key": {
				const at = this.#scopes.findIndex((s) => sameContent(s.definition, chain.scope.definition))
				const index = at === -1 ? this.#scopes.push(chain.scope) - 1 : at
				return `key ${index} ${JSON.stringify(chain.key)}`
			}
		}
	}
}

/** A relation parameter's bound rows, in the namespace that reads it. */
type RelationParams = ReadonlyMap<string, RowsDesc>

/** The term an expression of a rule is, where it is a variable, a parameter or a literal; none for any other. */
const termOf = (e: ExprDesc | undefined): Term | undefined => {
	switch (e?.kind) {
		case "var":
			return { kind: "var", id: e.var }
		case "param":
			return { kind: "param", name: e.name }
		case "literal":
			return { kind: "literal", text: canonicalTextOf(e.value) }
		case undefined:
		case "field":
		case "parent":
		case "value":
		case "compute":
		case "cast":
		case "cond":
		case "when":
		case "guarded":
		case "compare":
		case "between":
		case "in":
		case "and":
		case "or":
		case "not":
		case "base":
		case "allen":
		case "pointIn":
		case "absent":
		case "exists":
		case "closedAt":
		case "closedRow":
		case "closedHas":
		case "call":
			return undefined
	}
}

/** The pins of a scope's forms read off `bindings` (schema/scope.ts pinForms), each where every column is a term. */
const formPins = (chains: Chains, scope: Scope, bindings: BindingsDesc): ReadonlyArray<Pin> =>
	pinForms(scope).flatMap((f) => {
		const terms = f.columns.map((c) => termOf(bindings[c]))
		const read = terms.flatMap((t) => (t === undefined ? [] : [t]))
		return read.length === terms.length ? [{ chain: chains.key(f.chain), terms: read }] : []
	})

/** The walk of one program over one role's base and its scopes, and the first crossing it met. */
class Slice {
	readonly #base: SchemaDesc
	readonly #scoped: ReadonlyMap<string, Scope>
	readonly #chains = new Chains()
	/** Each imported query's rows, by the query, where its bind map binds no relation parameter. */
	readonly #known = new WeakMap<QueryDesc, Rows>()
	/** The first read the walk met that decides across owners; none while it has met none. */
	crossing: CrossOwner | undefined = undefined

	constructor(base: SchemaDesc, scoped: ReadonlyMap<string, Scope>) {
		this.#base = base
		this.#scoped = scoped
	}

	/** Records a read deciding by rows of `relation` across owners, the first one met kept. */
	#cross(relation: string, read: CrossOwnerRead): void {
		this.crossing ??= { relation, read }
	}

	/**
	 * Records `read` across owners unless every pin `rows` need is fixed for the whole evaluation, each term a parameter
	 * or a literal: every row of it is then the owner's, or none is.
	 */
	#fixedThroughout(rows: Rows, read: CrossOwnerRead): void {
		for (const n of rows.needs) {
			if (
				n.kind === "opaque" ||
				!n.pin.terms.every((t) => t.kind === "param" || t.kind === "literal")
			) {
				this.#cross(n.relation, read)
			}
		}
	}

	/** The need of a match of the scoped relation `relation` of scope `scope`: its scope's last form at its terms. */
	#need(relation: string, scope: Scope, bindings: BindingsDesc): Need {
		const last = lastNonEmpty(pinForms(scope))
		const terms = last.columns.map((c) => termOf(bindings[c]))
		const read = terms.flatMap((t) => (t === undefined ? [] : [t]))
		return read.length === terms.length
			? { kind: "pin", relation, pin: { chain: this.#chains.key(last.chain), terms: read } }
			: { kind: "opaque", relation }
	}

	/** The pins a positive match of the scoped relation of scope `scope` establishes: its forms', and each key's of its
	 * relation it binds whole, its row at that key the owner's. */
	#holds(scope: Scope, relation: string, bindings: BindingsDesc): ReadonlyArray<Pin> {
		const keys = keysOf(this.#base, relation).flatMap((key): ReadonlyArray<Pin> => {
			const terms = key.map((k) => termOf(bindings[k]))
			const read = terms.flatMap((t) => (t === undefined ? [] : [t]))
			return read.length === terms.length
				? [{ chain: this.#chains.key({ kind: "key", scope, key }), terms: read }]
				: []
		})
		return [...formPins(this.#chains, scope, bindings), ...keys]
	}

	/** The rows of `query` under `params`, its relation parameters' bound rows. */
	query(query: QueryDesc, params: RelationParams): Rows {
		if (params.size === 0) {
			const known = this.#known.get(query)
			if (known !== undefined) {
				return known
			}
			const rows = this.#stage(query.stage, params)
			this.#known.set(query, rows)
			return rows
		}
		return this.#stage(query.stage, params)
	}

	#stage(stage: QueryStageDesc, params: RelationParams): Rows {
		switch (stage.kind) {
			case "rules":
				return combined(stage.arms.map((arm) => this.#rule(arm, params)))
			case "recursive":
				return combined(
					[...stage.recursive.base, ...stage.recursive.rec].map((arm) => this.#rule(arm, params))
				)
			case "union":
				return combined([
					this.#stage(stage.input, params),
					...stage.arms.map((arm) => this.#rule(arm, params))
				])
			case "attach":
				this.query(stage.attach.child, params)
				return this.#stage(stage.input, params)
			case "named":
			case "order":
				return this.#stage(stage.input, params)
			case "take":
			case "approx": {
				const rows = this.#stage(stage.input, params)
				this.#fixedThroughout(rows, "take")
				return rows
			}
		}
	}

	/** The rows of an import of `rowsQuery` under its reader's bind map `bind`, its relation parameters bound by it. */
	#importRows(rowsQuery: QueryDesc, bind: BindMapDesc, outer: RelationParams): Rows {
		const params = new Map<string, RowsDesc>()
		for (const [name, b] of Object.entries(bind)) {
			if (b.kind === "rows") {
				params.set(name, b)
			} else if (b.kind === "relationParam") {
				const bound = outer.get(b.name)
				if (bound !== undefined) {
					params.set(name, bound)
				}
			}
		}
		return this.query(rowsQuery, params)
	}

	/** An import's rows in its reader's terms: each head field through `bindings`, each parameter through `bind`. */
	#mapped(rows: Rows, bindings: BindingsDesc, bind: BindMapDesc): Rows {
		const term = (t: Term): Term | undefined => {
			switch (t.kind) {
				case "head":
					return termOf(bindings[t.field])
				case "param": {
					const b = bind[t.name]
					return b === undefined || b.kind === "rows" || b.kind === "relationParam"
						? undefined
						: termOf(b)
				}
				case "literal":
					return t
				case "var":
					return undefined
			}
		}
		const pin = (p: Pin): Pin | undefined => {
			const terms = p.terms.map(term)
			const read = terms.flatMap((t) => (t === undefined ? [] : [t]))
			return read.length === terms.length ? { chain: p.chain, terms: read } : undefined
		}
		return {
			holds: rows.holds.flatMap((p) => {
				const m = pin(p)
				return m === undefined ? [] : [m]
			}),
			needs: rows.needs.map((n): Need => {
				if (n.kind === "opaque") {
					return n
				}
				const m = pin(n.pin)
				return m === undefined ? { kind: "opaque", relation: n.relation } : { ...n, pin: m }
			})
		}
	}

	/**
	 * What a match's source reads as rows, in its rule's terms: a scoped relation's row, an import's rows, a relation
	 * parameter's bound rows or an interior's, read as an import; nothing for a source that reads no scoped relation.
	 */
	#source(
		rule: RuleDesc,
		source: SourceDesc,
		bindings: BindingsDesc,
		params: RelationParams
	): Rows | undefined {
		switch (source.kind) {
			case "relation": {
				const scope = this.#scoped.get(source.name)
				return scope === undefined
					? undefined
					: {
							holds: this.#holds(scope, source.name, bindings),
							needs: [this.#need(source.name, scope, bindings)]
						}
			}
			case "query":
			case "step":
				return this.#mapped(
					this.#importRows(source.query, source.bind, params),
					bindings,
					source.bind
				)
			case "param":
			case "paramOf": {
				const bound = params.get(source.name)
				return bound === undefined
					? undefined
					: this.#mapped(this.#importRows(bound.query, bound.bind, params), bindings, bound.bind)
			}
			case "interior": {
				const interior = rule.interiors.find((i) => i.id === source.id)
				return interior === undefined
					? undefined
					: this.#mapped(
							combined(interior.arms.map((arm) => this.#rule(arm, params))),
							bindings,
							{}
						)
			}
			case "call":
			case "callField":
				for (const a of Object.values(source.args)) {
					if (a.kind === "rows") {
						this.#fixedThroughout(this.#importRows(a.query, a.bind, params), "call")
					}
				}
				return undefined
			case "split":
			case "series":
			case "self":
			case "delta":
			case "context":
			case "row":
				return undefined
		}
	}

	/** A rule's rows: what its positive matches establish and need, checked against its other reads. */
	#rule(rule: RuleDesc, params: RelationParams): Rows {
		const established = new Map<string, Pin>()
		const needs: Array<Need> = []
		const positive = (m: MatchDesc): void => {
			const read = this.#source(rule, m.source, m.bindings, params)
			for (const p of read?.holds ?? []) {
				established.set(pinKey(p), p)
			}
			for (const n of read?.needs ?? []) {
				needs.push(n)
			}
		}
		for (const m of rule.matches) {
			positive(m)
		}
		/** The relational reads of the rule's filters and head that are no positive filter: a negation, or a test of
		 * existence under a negation or inside a term. */
		const decided: Array<{ readonly source: SourceDesc; readonly bindings: BindingsDesc }> = []
		const walk = (e: ExprDesc, positively: boolean): void => {
			if (e.kind === "exists" && positively) {
				positive({ loc: rule.loc, source: e.source, bindings: e.bindings })
			} else if (e.kind === "exists" || e.kind === "absent") {
				decided.push({ source: e.source, bindings: e.bindings })
			}
			const inner = e.kind === "and" || e.kind === "or" ? positively : false
			for (const c of exprChildren(e)) {
				walk(c.term, e.kind === "not" ? false : inner)
			}
		}
		for (const w of rule.where) {
			walk(w, true)
		}
		for (const h of Object.values(rule.head)) {
			if (h.kind === "aggregate" && h.fn !== "count") {
				walk(h.arg, false)
			} else if (h.kind === "producer") {
				for (const a of h.args) {
					walk(a, false)
				}
			} else if (h.kind !== "aggregate") {
				walk(h, false)
			}
		}
		for (const d of decided) {
			const read = this.#source(rule, d.source, d.bindings, params)
			for (const n of read?.needs ?? []) {
				if (n.kind === "opaque" || !established.has(pinKey(n.pin))) {
					this.#cross(n.relation, "negation")
				}
			}
		}
		const { fixed } = keyFixed(
			this.#base,
			rule.matches,
			(e) => e.kind === "param" || e.kind === "literal"
		)
		const grouped = Object.values(rule.head).some((h) => h.kind === "aggregate")
		if (grouped) {
			const group = new Set(fixed)
			for (const h of Object.values(rule.head)) {
				if (h.kind === "var") {
					group.add(h.var)
				}
			}
			for (const n of needs) {
				if (n.kind === "opaque" || !n.pin.terms.every((t) => t.kind !== "var" || group.has(t.id))) {
					this.#cross(n.relation, "aggregate")
				}
			}
		}
		/** A rule term as its query names it: a head field a bare variable delivers, a variable a context fixes as a
		 * parameter of none, a parameter or a literal as itself. */
		const heads = new Map<string, string>()
		for (const [field, h] of Object.entries(rule.head)) {
			if (h.kind === "var" && !heads.has(h.var)) {
				heads.set(h.var, field)
			}
		}
		const exported = (t: Term): Term | undefined => {
			if (t.kind !== "var") {
				return t
			}
			const field = heads.get(t.id)
			return field === undefined ? undefined : { kind: "head", field }
		}
		const exportPin = (p: Pin): Pin | undefined => {
			const terms = p.terms.map(exported)
			const read = terms.flatMap((t) => (t === undefined ? [] : [t]))
			return read.length === terms.length ? { chain: p.chain, terms: read } : undefined
		}
		return {
			holds: [...established.values()].flatMap((p) => {
				const e = exportPin(p)
				return e === undefined ? [] : [e]
			}),
			needs: needs.map((n): Need => {
				if (n.kind === "opaque") {
					return n
				}
				const e = exportPin(n.pin)
				return e === undefined ? { kind: "opaque", relation: n.relation } : { ...n, pin: e }
			})
		}
	}
}

/**
 * The rows of several arms or stages read as one: the pins every one of them holds, and every pin any of them needs, so
 * a reader that needs each row to be the owner's needs it of every arm.
 */
const combined = (parts: ReadonlyArray<Rows>): Rows => {
	const [first, ...rest] = parts
	if (first === undefined) {
		return { holds: [], needs: [] }
	}
	const holds = first.holds.filter((p) =>
		rest.every((r) => r.holds.some((q) => pinKey(q) === pinKey(p)))
	)
	return { holds, needs: parts.flatMap((r) => r.needs) }
}

/** The queries a ChangeSet reads: each member's query and computed fields, and each read-back. */
const changeSetQueries = (changeSet: ChangeSetDesc): ReadonlyArray<QueryDesc> => [
	...changeSet.strata.flatMap((s) =>
		s.members.flatMap((m) =>
			m.member.kind === "query" || m.member.kind === "computed" ? [m.member.query] : []
		)
	),
	...changeSet.reads.map((r) => r.query)
]

/** The queries a program reads: a read's own, live or answered, or a ChangeSet's (changeSetQueries). */
const programQueries = (program: ProgramDesc): ReadonlyArray<QueryDesc> => {
	const p = unclocked(program)
	switch (p.kind) {
		case "query":
		case "answered":
			return [p.query]
		case "changeSet":
			return changeSetQueries(p.changeSet)
	}
}

/**
 * Where a program over a role's base reads a relation the role holds scoped other than row by row (see the header):
 * the scoped relation and the read, or none where it reads each row by row. A role holding no relation scoped is read
 * as every row, and no program crosses there.
 */
export const sliceRefusal = (
	program: ProgramDesc,
	base: SchemaDesc,
	scoped: ReadonlyMap<string, Scope>
): CrossOwner | undefined => {
	if (scoped.size === 0) {
		return undefined
	}
	const slice = new Slice(base, scoped)
	for (const q of programQueries(program)) {
		slice.query(q, new Map())
	}
	return slice.crossing
}
