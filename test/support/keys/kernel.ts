import { Array as Arr, Option } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ExprId, NodeId, OccurrenceId } from "#compiler/core/ids.ts"
import { type NodeScope, nodeScopes, nodesByLabel, postorder } from "#compiler/ir/dag.ts"
import {
	type EvidenceContext,
	type Premise,
	samePremise,
	strongest
} from "#compiler/ir/evidence.ts"
import { nativeEqualityKey, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { Fold } from "#compiler/ir/fold.ts"
import { comparedValue } from "#compiler/ir/injective.ts"
import type { Dependency, Implication, KeyProof, Rule } from "#compiler/ir/keys.ts"
import type { KeySet, NodeOf, RelDag, RelNode } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { defined } from "#test/support/assert.ts"

/**
 * The key kernel: re-checks a key proof the compiler emits, independently of the search that found it.
 *
 * The logical analysis (logical/props.ts) searches for keys; this kernel only checks what a proof says. It reads every
 * rule's side condition off the DAG alone (the Base declares the key, the witness conjunct is an equality of the column
 * and a value reading no column of the Filter's input, the occurrence binds the source columns, the output copies the
 * input column, the arms' literals differ), checks that each derivation's steps chain (a step's determinants known
 * before it), that the basis covers the node's heading or the inner key, recursively through every sub-derivation,
 * and that the proof's premises and context are exactly its derivation's. A proof's members each derive the key column
 * they stand for from their own column, so the key with any of them in its column's place is a key too. It imports
 * nothing of the search: only the IR, the naming door that names a key's constraint, and the native operator table. An
 * empty list is a valid proof.
 */

/** What the kernel knows of the environment the proof was found in: whether a view's Base rests on the keys stamped on
 * it (logical/annotate.ts LogicalEnv keyedViews). */
export interface KernelEnv {
	readonly keyedViews: boolean
}

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (c) => b.includes(c))

const within = (a: ReadonlyArray<string>, b: Iterable<string>): boolean => {
	const set = new Set(b)
	return Arr.every(a, (c) => set.has(c))
}

/** The value of a fixed column, as the kernel reads it off a derivation: what equality compares, or opaque. */
type Value =
	| { readonly kind: "literal"; readonly key: string }
	| { readonly kind: "param"; readonly param: string }
	| { readonly kind: "outer"; readonly node: NodeId; readonly column: string }
	| { readonly kind: "opaque" }

const sameValue = (a: Value, b: Value): boolean =>
	(a.kind === "literal" && b.kind === "literal" && a.key === b.key) ||
	(a.kind === "param" && b.kind === "param" && a.param === b.param) ||
	(a.kind === "outer" && b.kind === "outer" && a.node === b.node && a.column === b.column)

/** The faults of the parts a proof rests on, each checked before the parts that rest on it. */
interface Checked {
	readonly proof: (p: KeyProof) => ReadonlyArray<string>
	readonly implication: (i: Implication) => ReadonlyArray<string>
}

/** The proofs and derivations a rule's side condition rests on. */
const ruleParts = (rule: Rule): ReadonlyArray<KeyProof | Implication> => {
	switch (rule.rule) {
		case "fixed":
			return rule.witness.kind === "semiJoinPair" ? [rule.witness.right] : []
		case "equal":
			return rule.witness.kind === "arms"
				? rule.witness.arms
				: rule.witness.kind === "lateralFixed"
					? [rule.witness.fixed]
					: []
		case "match":
			return [rule.source]
		case "projection":
		case "grouped":
		case "kept":
		case "produced":
			return [rule.input]
		case "agreed":
			return rule.arms
		case "unionKey":
			return [rule.proof]
		case "declared":
		case "correlated":
		case "group":
		case "atMostOne":
		case "distinct":
		case "ranked":
			return []
	}
}

/** The proofs and derivations a part of a proof rests on: its basis's, its members', and its steps' rules'. */
const partsBeneath = (part: KeyProof | Implication): ReadonlyArray<KeyProof | Implication> => {
	if ("steps" in part) {
		return Arr.flatMap(part.steps, (s) => ruleParts(s.rule))
	}
	const members = Arr.map(part.members, (m) => m.determines)
	switch (part.basis.kind) {
		case "rows":
			return [part.basis.implication, ...members]
		case "union":
			return [
				...part.basis.arms,
				...Arr.flatMap(part.basis.separations, (s) => s.fixed),
				...members
			]
		case "within":
			return [part.basis.implication, part.basis.inner, ...members]
	}
}

/**
 * The kernel over one DAG. A proof names nodes by label, so the kernel reads them through the DAG's labels, gathered by
 * one walk when it is made: its own traversal state, as a proof's check is. A witness names a conjunct by label, which
 * the kernel finds among the conjuncts of the filter the witness stands at.
 */
export class KeyKernel {
	readonly #nodes: ReadonlyMap<NodeId, RelNode>
	readonly #scopes: Fold<RelNode, NodeScope>
	readonly #env: KernelEnv

	constructor(dag: RelDag, env: KernelEnv) {
		this.#nodes = nodesByLabel(dag)
		this.#scopes = nodeScopes(dag)
		this.#env = env
	}

	#node(id: NodeId): RelNode | undefined {
		return this.#nodes.get(id)
	}

	#heading(n: RelNode): ReadonlyArray<string> {
		return Arr.map(n.heading, (c) => c.name)
	}

	/** The conjuncts of a predicate: the operands of its top-level `and`s. */
	#conjuncts(e: ScalarExpr): ReadonlyArray<ScalarExpr> {
		return e.kind === "op" && nativeOp(e.op)?.fn === "and"
			? Arr.flatMap(e.args, (a) => this.#conjuncts(a))
			: [e]
	}

	/** The conjunct of a filter's predicate a witness names, or undefined when `n` is no filter or has none so named. */
	#conjunct(n: RelNode, id: ExprId): ScalarExpr | undefined {
		return n.kind === "Filter"
			? Option.getOrUndefined(Arr.findFirst(this.#conjuncts(n.pred), (c) => c.id === id))
			: undefined
	}

	#equality(e: ScalarExpr): readonly [ScalarExpr, ScalarExpr] | undefined {
		if (e.kind !== "op" || nativeOp(e.op)?.fn !== "eq") {
			return undefined
		}
		const [x, y, ...more] = e.args
		return x !== undefined && y !== undefined && more.length === 0 ? [x, y] : undefined
	}

	/**
	 * The column of `node` an expression is, as an equality compares it: the column itself, or an injective cast of it
	 * (ir/injective.ts comparedValue), which holds two values apart exactly when the column does.
	 */
	#columnOf(e: ScalarExpr, node: NodeId): string | undefined {
		const value = comparedValue(e)
		return value.kind === "column" && value.column.node === node ? value.column.name : undefined
	}

	#reads(e: ScalarExpr, nodes: ReadonlySet<NodeId>): boolean {
		return Arr.some(e.deps.nodes, (n) => nodes.has(n))
	}

	#classify(e: ScalarExpr): Value {
		switch (e.kind) {
			case "literal":
				return { kind: "literal", key: nativeEqualityKey(e.value) }
			case "param":
				return { kind: "param", param: e.param }
			case "column":
				return { kind: "outer", node: e.column.node, column: e.column.name }
			case "value":
			case "op":
			case "cast":
			case "domainCast":
			case "cond":
			case "closedAt":
			case "closedRow":
			case "closedHas":
				return { kind: "opaque" }
		}
	}

	/** The variables of a region its expression's local column references name, or undefined when one names none. */
	#regionVars(region: NodeOf<"MatchRegion">, root: ScalarExpr): ReadonlyArray<string> | undefined {
		const locals = new Set<NodeId>([region.id, ...Arr.map(region.occurrences, (o) => o.source.id)])
		const out = new Set<string>()
		const stack = [root]
		const seen = new Set<ScalarExpr>()
		for (let e = stack.pop(); e !== undefined; e = stack.pop()) {
			if (seen.has(e)) {
				continue
			}
			seen.add(e)
			if (e.kind === "column" && locals.has(e.column.node)) {
				const v = this.#varFor(region, e.column.node, e.column.name)
				if (v === undefined) {
					return undefined
				}
				out.add(v)
			}
			appendAll(stack, e.args)
		}
		return [...out]
	}

	/** The variable equal to a column of a region's own node: the heading's, or the one occurrence binding the column. */
	#varFor(region: NodeOf<"MatchRegion">, node: NodeId, column: string): string | undefined {
		if (node === region.id) {
			return Arr.some(region.heading, (c) => c.name === column) ? column : undefined
		}
		const over = Arr.filter(region.occurrences, (o) => o.source.id === node)
		const [only] = over
		if (only === undefined || over.length > 1) {
			return undefined
		}
		const b = Option.getOrUndefined(Arr.findFirst(only.bindings, (x) => x.column === column))
		return b === undefined ? undefined : b.var.name
	}

	/**
	 * Checks a proof; the faults found, none for a valid one. Every part it rests on, a sub-proof or a derivation, is
	 * checked once, before the parts that rest on it, however many of them share it.
	 */
	check(proof: KeyProof): ReadonlyArray<string> {
		const proofs = new Map<KeyProof, ReadonlyArray<string>>()
		const implications = new Map<Implication, ReadonlyArray<string>>()
		const checked: Checked = {
			proof: (p) => defined(proofs.get(p), "a proof checked before the parts resting on it"),
			implication: (i) =>
				defined(implications.get(i), "a derivation checked before the parts resting on it")
		}
		for (const part of postorder<KeyProof | Implication>([proof], partsBeneath)) {
			if ("steps" in part) {
				implications.set(part, this.#implication(part, checked))
			} else {
				proofs.set(part, this.#proof(part, checked))
			}
		}
		return checked.proof(proof)
	}

	#proof(p: KeyProof, checked: Checked): ReadonlyArray<string> {
		const n = this.#node(p.node)
		if (n === undefined) {
			return [`proof of [${Arr.join(p.key, ", ")}] at ${p.node}, no node of the DAG`]
		}
		const at = `${p.node} [${Arr.join(p.key, ", ")}]`
		const faults: Array<string> = []
		const heading = this.#heading(n)
		if (!within(p.key, heading)) {
			faults.push(`${at}: a key column outside the heading`)
		}
		switch (p.basis.kind) {
			case "rows": {
				const i = p.basis.implication
				if (this.#severalGroups(n)) {
					faults.push(`${at}: a rows basis on a node of several heading groups`)
				}
				appendAll(faults, checked.implication(i))
				if (i.node !== p.node || !sameSet(i.from, p.key)) {
					faults.push(`${at}: its derivation starts elsewhere than the key`)
				}
				if (!within(heading, this.#derived(i))) {
					faults.push(`${at}: its derivation does not reach the heading`)
				}
				break
			}
			case "union": {
				if (n.kind !== "Union") {
					faults.push(`${at}: a union basis on a ${n.kind}`)
					break
				}
				const arms = Arr.flatMap(n.groups, (g) => g.arms)
				if (arms.length !== p.basis.arms.length) {
					faults.push(`${at}: one arm proof per arm`)
				}
				for (const [i, arm] of p.basis.arms.entries()) {
					if (arm.node !== arms[i]?.id || !sameSet(arm.key, p.key)) {
						faults.push(`${at}: arm ${i} proves another key or node`)
					}
					appendAll(faults, checked.proof(arm))
				}
				for (let i = 0; i < arms.length; i++) {
					for (let j = i + 1; j < arms.length; j++) {
						const s = Option.getOrUndefined(
							Arr.findFirst(p.basis.separations, (x) => x.arms[0] === i && x.arms[1] === j)
						)
						if (s === undefined || !p.key.includes(s.column)) {
							faults.push(`${at}: arms ${i} and ${j} told apart on no key column`)
							continue
						}
						const [fi, fj] = s.fixed
						appendAll(faults, [...checked.implication(fi), ...checked.implication(fj)])
						const vi =
							fi.node === arms[i]?.id && fi.from.length === 0
								? this.#value(fi, s.column)
								: undefined
						const vj =
							fj.node === arms[j]?.id && fj.from.length === 0
								? this.#value(fj, s.column)
								: undefined
						if (vi?.kind !== "literal" || vj?.kind !== "literal" || vi.key === vj.key) {
							faults.push(
								`${at}: arms ${i} and ${j} not told apart by differing literals on ${s.column}`
							)
						}
					}
				}
				break
			}
			case "within": {
				const { implication: i, inner } = p.basis
				appendAll(faults, [...checked.implication(i), ...checked.proof(inner)])
				if (i.node !== p.node || !sameSet(i.from, p.key)) {
					faults.push(`${at}: its derivation starts elsewhere than the key`)
				}
				if (!within(inner.key, this.#derived(i))) {
					faults.push(`${at}: its derivation does not reach the inner key`)
				}
				if (
					inner.node !== p.node &&
					!Arr.some(this.#keptInputs(n), (k) => k.input.id === inner.node)
				) {
					faults.push(`${at}: an inner key of neither the node nor an input whose rows it keeps`)
				}
				break
			}
		}
		for (const m of p.members) {
			const stands = `${at}: member ${m.column} for ${m.of}`
			appendAll(faults, checked.implication(m.determines))
			if (!p.key.includes(m.of) || p.key.includes(m.column) || !heading.includes(m.column)) {
				faults.push(`${stands}: not a heading column outside the key standing for a key column`)
			}
			if (
				m.determines.node !== p.node ||
				!sameSet(m.determines.from, [m.column]) ||
				!this.#derived(m.determines).has(m.of)
			) {
				faults.push(`${stands}: its derivation does not derive the key column from it`)
			}
		}
		const { premises, contexts } = this.#grounds(p)
		if (
			p.premises.length !== premises.length ||
			!Arr.every(premises, (q) => Arr.some(p.premises, (r) => samePremise(q, r)))
		) {
			faults.push(`${at}: its premises are not its derivation's`)
		}
		if (p.context !== strongest(contexts)) {
			faults.push(`${at}: its context is not its derivation's`)
		}
		return faults
	}

	/** Whether a node's rows are of several heading groups: a union of several, and every node keeping their rows. */
	#severalGroups(n: RelNode): boolean {
		if (n.kind === "Union") {
			return (
				n.groups.length > 1 ||
				Arr.some(n.groups, (g) => Arr.some(g.arms, (a) => this.#severalGroups(a)))
			)
		}
		const kept = Option.getOrUndefined(Arr.findFirst(this.#keptInputs(n), (k) => k.discriminating))
		return kept !== undefined && this.#severalGroups(kept.input)
	}

	/**
	 * The inputs whose rows a node keeps, so their dependencies among its columns hold: with the columns kept, and whether
	 * the node's rows are of that input's heading groups.
	 */
	#keptInputs(n: RelNode): ReadonlyArray<{
		readonly input: RelNode
		readonly columns: ReadonlyArray<string>
		readonly discriminating: boolean
	}> {
		const all = (input: RelNode, discriminating: boolean) => [
			{ input, columns: this.#heading(input), discriminating }
		]
		switch (n.kind) {
			case "Filter":
			case "Take":
			case "OrderedResult":
				return all(n.input, true)
			case "Window":
				return all(n.input, true)
			case "SemiJoin":
			case "AntiJoin":
			case "Difference":
				return all(n.left, true)
			case "Intersect":
				return [...all(n.left, true), ...all(n.right, false)]
			case "ApproximateNearest":
				return all(n.source, true)
			case "Attach":
				return all(n.parent, true)
			case "Forbid":
				return all(n.violation, true)
			case "Produce":
				return [{ input: n.input, columns: n.carried, discriminating: false }]
			case "Base":
			case "Closed":
			case "Context":
			case "Delta":
			case "Group":
			case "InputSet":
			case "MatchRegion":
			case "OrderedSetAggregate":
			case "ProjectSet":
			case "Recursive":
			case "SelfRef":
			case "Union":
				return []
		}
	}

	/** The columns an implication determines. */
	#derived(i: Implication): ReadonlySet<string> {
		return new Set([...i.from, ...Arr.flatMap(i.steps, (s) => s.to)])
	}

	#implication(i: Implication, checked: Checked): ReadonlyArray<string> {
		const n = this.#node(i.node)
		if (n === undefined) {
			return [`a derivation at ${i.node}, no node of the DAG`]
		}
		const heading = this.#heading(n)
		const faults: Array<string> = []
		if (!within(i.from, heading)) {
			faults.push(`${i.node}: a derivation from columns outside the heading`)
		}
		const reached = new Set(i.from)
		for (const step of i.steps) {
			const at = `${i.node} ${step.rule.rule} [${Arr.join(step.from, ", ")}] -> [${Arr.join(step.to, ", ")}]`
			if (!within(step.from, reached)) {
				faults.push(`${at}: a step before its determinants are known`)
			}
			if (!within(step.to, heading)) {
				faults.push(`${at}: a step determining columns outside the heading`)
			}
			appendAll(
				faults,
				Arr.map(this.#rule(n, step, checked), (f) => `${at}: ${f}`)
			)
			for (const c of step.to) {
				reached.add(c)
			}
		}
		return faults
	}

	/** The faults of one dependency's rule at node `n`. */
	#rule(n: RelNode, d: Dependency, checked: Checked): ReadonlyArray<string> {
		const r = d.rule
		const heading = this.#heading(n)
		switch (r.rule) {
			case "declared":
				return this.#declared(n, d, r)
			case "fixed":
				return d.from.length === 0 && d.to.length === 1
					? this.#fixed(n, d.to[0] ?? "", r.witness, checked)
					: ["a fixed column is one column from nothing"]
			case "equal": {
				const [a] = d.from
				const [b] = d.to
				return a !== undefined && b !== undefined && d.from.length === 1 && d.to.length === 1
					? this.#equal(n, a, b, r.witness, checked)
					: ["equal columns: one column from one column"]
			}
			case "correlated": {
				if (n.kind !== "MatchRegion") {
					return ["a correlated variable outside a region"]
				}
				const c = n.correlated[r.index]
				if (c === undefined || !sameSet(d.to, [c.var.name])) {
					return ["no such correlated variable"]
				}
				const reads = this.#regionVars(n, c.expr)
				return reads !== undefined && sameSet(reads, d.from)
					? []
					: ["not the variables its expression reads"]
			}
			case "match":
				return this.#match(n, d, r.occurrence, r.source, checked)
			case "projection":
				return this.#projection(n, d, r.input, checked)
			case "group":
				return (n.kind === "Group" || n.kind === "OrderedSetAggregate") &&
					sameSet(d.from, n.keys) &&
					within(d.to, heading)
					? []
					: ["not the group key determining the group"]
			case "grouped":
				return (n.kind === "Group" || n.kind === "OrderedSetAggregate") &&
					r.input.node === n.input.id &&
					within(d.from, n.keys) &&
					within(d.to, n.keys) &&
					within(r.input.from, d.from) &&
					within(d.to, this.#derived(r.input))
					? [...checked.implication(r.input)]
					: ["not an input dependency among the group key"]
			case "kept": {
				const kept = Option.getOrUndefined(
					Arr.findFirst(this.#keptInputs(n), (k) => k.input.id === r.input.node)
				)
				return kept !== undefined &&
					within(r.input.from, d.from) &&
					within(d.to, this.#derived(r.input)) &&
					within(d.to, kept.columns)
					? [...checked.implication(r.input)]
					: ["not a dependency of an input whose rows the node keeps"]
			}
			case "atMostOne":
				return d.from.length === 0 && within(heading, d.to) && this.#atMostOne(n, r.witness)
					? []
					: ["no witness of at most one row"]
			case "distinct": {
				const [c] = d.from
				if (n.kind !== "Closed" || c === undefined || d.from.length !== 1) {
					return ["a distinct column outside a closed relation"]
				}
				const at = Arr.findFirstIndex(n.heading, (h) => h.name === c)
				if (Option.isNone(at)) {
					return ["a distinct column outside the heading"]
				}
				const values = Arr.map(n.rows, (row) => {
					const literal = row[at.value]
					return literal === undefined ? "" : nativeEqualityKey(literal)
				})
				return new Set(values).size === values.length && within(heading, d.to)
					? []
					: ["a column whose values repeat"]
			}
			case "produced": {
				if (
					n.kind !== "Produce" ||
					r.input.node !== n.input.id ||
					!within(r.input.key, n.carried)
				) {
					return ["not a carried key of the produce's input"]
				}
				const from = n.producer === "spanIntersection" ? r.input.key : [...r.input.key, n.out]
				return sameSet(d.from, from)
					? [...checked.proof(r.input)]
					: ["not the carried key and its span"]
			}
			case "ranked": {
				if (n.kind !== "Window") {
					return ["a window value outside a window"]
				}
				return sameSet(d.from, this.#heading(n.input)) && sameSet(d.to, [n.out])
					? []
					: ["not the input row determining the window's value"]
			}
			case "agreed": {
				if (n.kind !== "Union" || d.from.length > 0 || d.to.length !== 1) {
					return ["a column every arm fixes, outside a union"]
				}
				const column = d.to[0] ?? ""
				const arms = Arr.flatMap(n.groups, (g) => g.arms)
				if (arms.length !== r.arms.length) {
					return ["one derivation per arm"]
				}
				const values = Arr.map(r.arms, (a, i) =>
					a.node === arms[i]?.id && a.from.length === 0 ? this.#value(a, column) : undefined
				)
				const [first] = values
				const agree =
					first !== undefined &&
					first.kind !== "opaque" &&
					Arr.every(values, (v) => v !== undefined && sameValue(v, first))
				return agree
					? Arr.flatMap(r.arms, (a) => checked.implication(a))
					: ["arms that fix the column to different values"]
			}
			case "unionKey":
				return n.kind === "Union" &&
					r.proof.node === n.id &&
					r.proof.basis.kind === "union" &&
					sameSet(d.from, r.proof.key) &&
					within(d.to, heading)
					? [...checked.proof(r.proof)]
					: ["not a union key determining the union's row"]
		}
	}

	#declared(
		n: RelNode,
		d: Dependency,
		r: Extract<Rule, { readonly rule: "declared" }>
	): ReadonlyArray<string> {
		const heading = this.#heading(n)
		if (!within(heading, d.to)) {
			return ["a declared key determining less than the row"]
		}
		const premise = (relation: string, fields: KeySet, primary: boolean): Premise =>
			primary
				? {
						kind: "constraint",
						constraint: identifierOf(identity.primaryKey(relation)),
						constraintKind: "primaryKey"
					}
				: {
						kind: "constraint",
						constraint: identifierOf(identity.key(relation, fields)),
						constraintKind: "unique"
					}
		const premisesAre = (
			expected: ReadonlyArray<Premise>,
			context: EvidenceContext
		): ReadonlyArray<string> =>
			r.context === context &&
			r.premises.length === expected.length &&
			Arr.every(expected, (p, i) => {
				const q = r.premises[i]
				return q !== undefined && samePremise(p, q)
			})
				? []
				: ["premises other than the key's"]
		if (n.kind === "Base" && n.relationKind === "relation") {
			const keys = [n.primaryKey, ...n.keys]
			const at = Arr.findFirstIndex(keys, (k) => sameSet(k, d.from))
			const key = Option.isNone(at) ? undefined : keys[at.value]
			return key === undefined || Option.isNone(at)
				? ["not a declared key of the relation"]
				: premisesAre([premise(n.relation, key, at.value === 0)], "immediate")
		}
		if (n.kind === "Base") {
			const view = Option.getOrUndefined(
				Arr.findFirst(this.#env.keyedViews ? n.view : [], (k) => sameSet(k.fields, d.from))
			)
			return view === undefined
				? ["not a key of the view"]
				: premisesAre(view.premises, view.context)
		}
		if (n.kind === "Delta") {
			const keys = n.keys
			const at = Arr.findFirstIndex(keys, (k) => sameSet(k, d.from))
			const key = Option.isNone(at) ? undefined : keys[at.value]
			return key === undefined || Option.isNone(at)
				? ["not a key of the delta's relation"]
				: premisesAre([premise(n.relation, key, at.value === 0)], "immediate")
		}
		return [`a declared key on a ${n.kind}`]
	}

	#fixed(
		n: RelNode,
		column: string,
		w: Extract<Rule, { readonly rule: "fixed" }>["witness"],
		checked: Checked
	): ReadonlyArray<string> {
		switch (w.kind) {
			case "conjunct": {
				const conjunct = this.#conjunct(n, w.expr)
				if (n.kind !== "Filter" || conjunct === undefined) {
					return ["no conjunct of the filter"]
				}
				const sides = this.#equality(conjunct)
				const input = new Set([n.input.id])
				const holds =
					sides !== undefined &&
					((this.#columnOf(sides[0], n.input.id) === column && !this.#reads(sides[1], input)) ||
						(this.#columnOf(sides[1], n.input.id) === column && !this.#reads(sides[0], input)))
				return holds ? [] : ["no equality of the column with a value fixed per evaluation"]
			}
			case "closedValue": {
				if (n.kind !== "Closed" || n.rows.length === 0) {
					return ["no closed relation with facts"]
				}
				const at = Arr.findFirstIndex(n.heading, (h) => h.name === column)
				if (Option.isNone(at)) {
					return ["a fixed column outside the heading"]
				}
				const i = at.value
				const values = new Set(
					Arr.map(n.rows, (row) => {
						const literal = row[i]
						return literal === undefined ? "" : nativeEqualityKey(literal)
					})
				)
				return values.size === 1 ? [] : ["a column of several values"]
			}
			case "takeCorrelation": {
				const c = n.kind === "Take" ? n.correlation[w.index] : undefined
				return n.kind === "Take" &&
					c?.column === column &&
					!this.#reads(c.expr, new Set([n.input.id]))
					? []
					: ["no take correlation fixing the column"]
			}
			case "semiJoinPair": {
				const pair = n.kind === "SemiJoin" ? n.on[w.index] : undefined
				return n.kind === "SemiJoin" &&
					pair?.left === column &&
					w.right.node === n.right.id &&
					w.right.from.length === 0 &&
					this.#derived(w.right).has(pair.right)
					? [...checked.implication(w.right)]
					: ["no semi-join pair with a fixed right column"]
			}
			case "attachCorrelation": {
				const attach = this.#node(w.attach)
				const pair = attach?.kind === "Attach" ? attach.correlation[w.index] : undefined
				return attach?.kind === "Attach" && attach.child.id === n.id && pair?.child === column
					? []
					: ["no attachment correlation of the child column"]
			}
		}
	}

	#equal(
		n: RelNode,
		a: string,
		b: string,
		w: Extract<Rule, { readonly rule: "equal" }>["witness"],
		checked: Checked
	): ReadonlyArray<string> {
		switch (w.kind) {
			case "conjunct": {
				const conjunct = this.#conjunct(n, w.expr)
				if (n.kind !== "Filter" || conjunct === undefined) {
					return ["no conjunct of the filter"]
				}
				const sides = this.#equality(conjunct)
				const cols = sides === undefined ? [] : Arr.map(sides, (s) => this.#columnOf(s, n.input.id))
				return sameSet(
					[a, b],
					Arr.flatMap(cols, (c) => (c === undefined ? [] : [c]))
				)
					? []
					: ["no equality of the two columns"]
			}
			case "regionEquality": {
				const e = n.kind === "MatchRegion" ? n.equalities[w.index] : undefined
				return n.kind === "MatchRegion" && e !== undefined && sameSet([a, b], [e.a.name, e.b.name])
					? []
					: ["no equality of the two variables"]
			}
			case "sharedColumn": {
				const o =
					n.kind === "MatchRegion"
						? Option.getOrUndefined(Arr.findFirst(n.occurrences, (x) => x.id === w.occurrence))
						: undefined
				const vars =
					n.kind === "MatchRegion" && o !== undefined
						? Arr.map(
								Arr.filter(o.bindings, (x) => x.column === w.column),
								(x) => x.var.name
							)
						: []
				return vars.includes(a) && vars.includes(b) ? [] : ["no column bound to both variables"]
			}
			case "viewMember": {
				const members =
					n.kind === "Base" && n.relationKind !== "relation"
						? Arr.flatMap(this.#env.keyedViews ? n.view : [], (k) => k.members)
						: []
				return Arr.some(members, (m) => sameSet([m.of, m.column], [a, b]))
					? []
					: ["no key column of the view and a member of its class"]
			}
			case "correlatedCopy": {
				if (n.kind !== "MatchRegion") {
					return ["a correlated copy outside a region"]
				}
				const c = n.correlated[w.index]
				const e = c?.expr
				const copied =
					e?.kind === "column" ? this.#varFor(n, e.column.node, e.column.name) : undefined
				return c?.var.name === a && copied === b ? [] : ["no correlated variable copying the other"]
			}
			case "closedColumns": {
				if (n.kind !== "Closed") {
					return ["closed columns outside a closed relation"]
				}
				const at = (c: string) => Arr.findFirstIndex(n.heading, (h) => h.name === c)
				const ia = at(a)
				const ib = at(b)
				if (Option.isNone(ia) || Option.isNone(ib)) {
					return ["a closed column outside the heading"]
				}
				const ta = defined(n.heading[ia.value], "a heading column").type
				const tb = defined(n.heading[ib.value], "a heading column").type
				const same = Arr.every(n.rows, (row) => {
					const x = row[ia.value]
					const y = row[ib.value]
					return x !== undefined && y !== undefined && nativeEqualityKey(x) === nativeEqualityKey(y)
				})
				return sameScalarType(ta, tb) && same
					? []
					: ["two closed columns some fact holds different values in, or of different types"]
			}
			case "lateralFixed": {
				if (n.kind !== "MatchRegion") {
					return ["a lateral source's fixed column outside a region"]
				}
				const o = Option.getOrUndefined(Arr.findFirst(n.occurrences, (x) => x.id === w.occurrence))
				const fixed = w.fixed
				if (o === undefined || fixed.node !== o.source.id || fixed.from.length > 0) {
					return ["no derivation from nothing at the occurrence's source"]
				}
				const bound = Arr.map(
					Arr.filter(o.bindings, (x) => x.column === w.column),
					(x) => x.var.name
				)
				const value = this.#value(fixed, w.column)
				const other =
					value?.kind === "outer" ? this.#varFor(n, value.node, value.column) : undefined
				const holds =
					other !== undefined &&
					((bound.includes(a) && other === b) || (bound.includes(b) && other === a))
				return holds
					? [...checked.implication(fixed)]
					: ["no variable bound to a source column fixed to the other variable's region column"]
			}
			case "arms": {
				if (n.kind !== "Union") {
					return ["columns equal in every arm, outside a union"]
				}
				const arms = Arr.flatMap(n.groups, (g) => g.arms)
				if (arms.length !== w.arms.length) {
					return ["one derivation per arm"]
				}
				return Arr.flatMap(w.arms, (arm, i) =>
					arm.node === arms[i]?.id
						? [...checked.implication(arm), ...this.#equalChain(arm, a, b)]
						: [`arm ${i}: a derivation at another node`]
				)
			}
		}
	}

	/**
	 * The faults of `i` as a derivation that `b` equals `a` in every row of its node, by equalities alone: from `a`, one
	 * column to the next, each step an equal dependency, two outputs of a projection copying one input column or columns
	 * its input derivation makes equal, or a kept input's columns its derivation makes equal, ending at `b`. That one
	 * column determines another is no equality: two arms of a union may each determine b from a, differently.
	 */
	#equalChain(i: Implication, a: string, b: string): ReadonlyArray<string> {
		const n = this.#node(i.node)
		if (n === undefined) {
			return [`an equality at ${i.node}, no node of the DAG`]
		}
		if (!sameSet(i.from, [a])) {
			return [`${i.node}: an equality from other than ${a}`]
		}
		let at = a
		for (const step of i.steps) {
			const [from] = step.from
			const [to] = step.to
			if (step.from.length !== 1 || step.to.length !== 1 || from !== at || to === undefined) {
				return [`${i.node}: an equality step from other than ${at} alone to one column`]
			}
			const faults = this.#equalChainStep(n, step.rule, from, to)
			if (faults.length > 0) {
				return faults
			}
			at = to
		}
		return at === b ? [] : [`${i.node}: an equality reaching ${at}, not ${b}`]
	}

	/** The faults of one step of an equality at node `n`, from `x` to `y`, beside its rule's own. */
	#equalChainStep(n: RelNode, r: Rule, x: string, y: string): ReadonlyArray<string> {
		switch (r.rule) {
			case "equal":
				return []
			case "projection": {
				if (n.kind !== "ProjectSet") {
					return ["a projection step outside a projection"]
				}
				const copyOf = (o: string): string | undefined => {
					const out = Option.getOrUndefined(Arr.findFirst(n.out, (p) => p.name === o))
					return out === undefined ? undefined : this.#columnOf(out.expr, n.input.id)
				}
				const cx = copyOf(x)
				const cy = copyOf(y)
				if (cx === undefined || cy === undefined) {
					return ["an equality through an output copying no input column"]
				}
				return cx === cy ? [] : this.#equalChain(r.input, cx, cy)
			}
			case "kept":
				return this.#equalChain(r.input, x, y)
			case "declared":
			case "fixed":
			case "correlated":
			case "match":
			case "group":
			case "grouped":
			case "atMostOne":
			case "distinct":
			case "produced":
			case "ranked":
			case "agreed":
			case "unionKey":
				return [`a ${r.rule} step, which is no equality`]
		}
	}

	#match(
		n: RelNode,
		d: Dependency,
		occurrence: OccurrenceId,
		source: Implication,
		checked: Checked
	): ReadonlyArray<string> {
		if (n.kind !== "MatchRegion") {
			return ["a match outside a region"]
		}
		const o = Option.getOrUndefined(Arr.findFirst(n.occurrences, (x) => x.id === occurrence))
		if (o === undefined || source.node !== o.source.id) {
			return ["no such occurrence over the derivation's source"]
		}
		const faults: Array<string> = [...checked.implication(source)]
		const from = new Set(d.from)
		for (const c of source.from) {
			const bound = Arr.some(o.bindings, (b) => b.column === c && from.has(b.var.name))
			const constant = Option.getOrUndefined(Arr.findFirst(o.constants, (k) => k.column === c))
			const reads = constant === undefined ? undefined : this.#regionVars(n, constant.expr)
			if (!bound && (reads === undefined || !within(reads, from))) {
				faults.push(
					`source column ${c} neither bound to a determinant nor fixed by a constant reading only them`
				)
			}
		}
		const locals = new Set<NodeId>([n.id, ...Arr.map(n.occurrences, (x) => x.source.id)])
		for (const [node, columns] of this.#scopes.of(o.source).outer) {
			if (!locals.has(node)) {
				continue
			}
			for (const column of columns) {
				const v = this.#varFor(n, node, column)
				if (v === undefined || !from.has(v)) {
					faults.push(`a lateral source reading ${column} of ${node}, which no determinant is`)
				}
			}
		}
		const reached = this.#derived(source)
		for (const v of d.to) {
			if (!Arr.some(o.bindings, (b) => b.var.name === v && reached.has(b.column))) {
				faults.push(`variable ${v} bound to no column the source derivation reaches`)
			}
		}
		return faults
	}

	#projection(
		n: RelNode,
		d: Dependency,
		input: Implication,
		checked: Checked
	): ReadonlyArray<string> {
		if (n.kind !== "ProjectSet" || input.node !== n.input.id) {
			return ["a projection over another node"]
		}
		const copyOf = (o: string): string | undefined => {
			const out = Option.getOrUndefined(Arr.findFirst(n.out, (x) => x.name === o))
			return out === undefined ? undefined : this.#columnOf(out.expr, n.input.id)
		}
		const copies = Arr.flatMap(d.from, (o) => {
			const c = copyOf(o)
			return c === undefined ? [] : [c]
		})
		const faults: Array<string> = [...checked.implication(input)]
		if (!within(input.from, copies)) {
			faults.push("an input derivation from columns no determinant copies")
		}
		const reached = this.#derived(input)
		const readsIn = (root: ScalarExpr): ReadonlyArray<string> => {
			const out = new Set<string>()
			const stack = [root]
			for (let e = stack.pop(); e !== undefined; e = stack.pop()) {
				if (e.kind === "column" && e.column.node === n.input.id) {
					out.add(e.column.name)
				}
				appendAll(stack, e.args)
			}
			return [...out]
		}
		for (const o of d.to) {
			const out = Option.getOrUndefined(Arr.findFirst(n.out, (x) => x.name === o))
			if (out === undefined) {
				faults.push(`no output ${o}`)
				continue
			}
			const copied = copyOf(o)
			const needs = copied === undefined ? readsIn(out.expr) : [copied]
			if (!within(needs, reached)) {
				faults.push(`output ${o} reads columns the input derivation does not reach`)
			}
		}
		return faults
	}

	#atMostOne(n: RelNode, w: Extract<Rule, { readonly rule: "atMostOne" }>["witness"]): boolean {
		switch (w.kind) {
			case "context":
				return n.kind === "Context"
			case "row":
				return n.kind === "InputSet" && n.input.kind === "row"
			case "singleFact":
				return n.kind === "Closed" && n.rows.length <= 1
			case "takeOne":
				return n.kind === "Take" && n.bound.kind === "literal" && n.bound.k === 1n
			case "nearestOne":
				return n.kind === "ApproximateNearest" && n.take === 1n
			case "falseConjunct": {
				const e = this.#conjunct(n, w.expr)
				return e?.kind === "literal" && e.value.kind === "bool" && !e.value.value
			}
		}
	}

	/**
	 * The value a column fixed by `i` (a derivation from nothing) holds: the value the first of its steps that names one
	 * fixes it to, opaque where none does. A step holds for every row, so any step naming the column's value names the
	 * value it holds, and the first is the one the analysis reached it by.
	 */
	#value(i: Implication, column: string): Value | undefined {
		return this.#derived(i).has(column) ? this.#valueAmong(i, i.steps, column) : undefined
	}

	/** The value `column` holds by the first of `steps`, a prefix of `i`'s, that names one; opaque where none does. */
	#valueAmong(i: Implication, steps: ReadonlyArray<Dependency>, column: string): Value {
		const n = this.#node(i.node)
		if (n === undefined) {
			return { kind: "opaque" }
		}
		for (const [at, step] of steps.entries()) {
			if (!step.to.includes(column)) {
				continue
			}
			const value = this.#stepValue(i, n, steps.slice(0, at), step, column)
			if (value.kind !== "opaque") {
				return value
			}
		}
		return { kind: "opaque" }
	}

	/** The value `step` of `i`, after the steps `before`, fixes `column` of node `n` to. */
	#stepValue(
		i: Implication,
		n: RelNode,
		before: ReadonlyArray<Dependency>,
		step: Dependency,
		column: string
	): Value {
		const r = step.rule
		switch (r.rule) {
			case "fixed":
				return this.#witnessValue(n, r.witness, column)
			case "correlated": {
				const c = n.kind === "MatchRegion" ? n.correlated[r.index] : undefined
				return c === undefined ? { kind: "opaque" } : this.#classify(c.expr)
			}
			case "equal": {
				const [from] = step.from
				return from === undefined ? { kind: "opaque" } : this.#valueAmong(i, before, from)
			}
			case "match": {
				if (n.kind !== "MatchRegion") {
					return { kind: "opaque" }
				}
				const o = Option.getOrUndefined(Arr.findFirst(n.occurrences, (x) => x.id === r.occurrence))
				const b =
					o === undefined
						? undefined
						: Option.getOrUndefined(Arr.findFirst(o.bindings, (x) => x.var.name === column))
				if (o === undefined || b === undefined) {
					return { kind: "opaque" }
				}
				const constant = Option.getOrUndefined(
					Arr.findFirst(o.constants, (k) => k.column === b.column)
				)
				return constant !== undefined
					? this.#classify(constant.expr)
					: (this.#value(r.source, b.column) ?? { kind: "opaque" })
			}
			case "projection": {
				if (n.kind !== "ProjectSet") {
					return { kind: "opaque" }
				}
				const out = Option.getOrUndefined(Arr.findFirst(n.out, (x) => x.name === column))
				const copied = out === undefined ? undefined : this.#columnOf(out.expr, n.input.id)
				return out === undefined
					? { kind: "opaque" }
					: copied === undefined
						? this.#classify(out.expr)
						: (this.#value(r.input, copied) ?? { kind: "opaque" })
			}
			case "kept":
			case "grouped":
				return this.#value(r.input, column) ?? { kind: "opaque" }
			case "agreed": {
				const [first] = r.arms
				return this.#value(first, column) ?? { kind: "opaque" }
			}
			case "declared":
			case "group":
			case "atMostOne":
			case "distinct":
			case "produced":
			case "ranked":
			case "unionKey":
				return { kind: "opaque" }
		}
	}

	/** The value a witness fixes `column` of node `n` to. */
	#witnessValue(
		n: RelNode,
		w: Extract<Rule, { readonly rule: "fixed" }>["witness"],
		column: string
	): Value {
		switch (w.kind) {
			case "conjunct": {
				const conjunct = this.#conjunct(n, w.expr)
				const sides = conjunct === undefined ? undefined : this.#equality(conjunct)
				const input = n.kind === "Filter" ? n.input.id : n.id
				const other =
					sides === undefined
						? undefined
						: Option.getOrUndefined(
								Arr.findFirst(sides, (s) => this.#columnOf(s, input) !== column)
							)
				return other === undefined ? { kind: "opaque" } : this.#classify(other)
			}
			case "closedValue": {
				if (n.kind !== "Closed") {
					return { kind: "opaque" }
				}
				const at = Arr.findFirstIndex(n.heading, (h) => h.name === column)
				const literal = Option.isNone(at) ? undefined : n.rows[0]?.[at.value]
				return literal === undefined
					? { kind: "opaque" }
					: { kind: "literal", key: nativeEqualityKey(literal) }
			}
			case "takeCorrelation": {
				const c = n.kind === "Take" ? n.correlation[w.index] : undefined
				return c === undefined ? { kind: "opaque" } : this.#classify(c.expr)
			}
			case "semiJoinPair": {
				const pair = n.kind === "SemiJoin" ? n.on[w.index] : undefined
				return pair === undefined
					? { kind: "opaque" }
					: (this.#value(w.right, pair.right) ?? { kind: "opaque" })
			}
			case "attachCorrelation": {
				const attach = this.#node(w.attach)
				const pair = attach?.kind === "Attach" ? attach.correlation[w.index] : undefined
				return attach?.kind === "Attach" && pair !== undefined
					? { kind: "outer", node: attach.parent.id, column: pair.parent }
					: { kind: "opaque" }
			}
		}
	}

	/** The premises and contexts a proof's derivation rests on. */
	#grounds(p: KeyProof): {
		readonly premises: ReadonlyArray<Premise>
		readonly contexts: ReadonlyArray<EvidenceContext>
	} {
		const premises: Array<Premise> = []
		const contexts: Array<EvidenceContext> = []
		const seen = new Set<object>()
		const addPremise = (q: Premise) => {
			if (!Arr.some(premises, (x) => samePremise(x, q))) {
				premises.push(q)
			}
		}
		const fromProof = (k: KeyProof) => {
			Arr.forEach(k.premises, addPremise)
			contexts.push(k.context)
		}
		const fromImplication = (i: Implication): void => {
			if (seen.has(i)) {
				return
			}
			seen.add(i)
			for (const s of i.steps) {
				const r = s.rule
				switch (r.rule) {
					case "declared":
						Arr.forEach(r.premises, addPremise)
						contexts.push(r.context)
						break
					case "distinct":
						contexts.push("queryLocal")
						break
					case "atMostOne":
						if (
							r.witness.kind === "context" ||
							r.witness.kind === "row" ||
							r.witness.kind === "singleFact"
						) {
							contexts.push("queryLocal")
						}
						break
					case "fixed":
						if (r.witness.kind === "closedValue") {
							contexts.push("queryLocal")
						}
						if (r.witness.kind === "semiJoinPair") {
							fromImplication(r.witness.right)
						}
						break
					case "match":
						fromImplication(r.source)
						break
					case "projection":
					case "grouped":
					case "kept":
						fromImplication(r.input)
						break
					case "produced":
						fromProof(r.input)
						break
					case "agreed":
						Arr.forEach(r.arms, fromImplication)
						break
					case "unionKey":
						fromProof(r.proof)
						break
					case "equal":
						if (r.witness.kind === "arms") {
							Arr.forEach(r.witness.arms, fromImplication)
						}
						if (r.witness.kind === "lateralFixed") {
							fromImplication(r.witness.fixed)
						}
						if (r.witness.kind === "closedColumns") {
							contexts.push("queryLocal")
						}
						break
					case "correlated":
					case "group":
					case "ranked":
						break
				}
			}
		}
		Arr.forEach(p.members, (m) => fromImplication(m.determines))
		switch (p.basis.kind) {
			case "rows":
				fromImplication(p.basis.implication)
				break
			case "union":
				Arr.forEach(p.basis.arms, fromProof)
				for (const s of p.basis.separations) {
					fromImplication(s.fixed[0])
					fromImplication(s.fixed[1])
				}
				break
			case "within":
				fromImplication(p.basis.implication)
				fromProof(p.basis.inner)
				break
		}
		return { premises, contexts }
	}
}
