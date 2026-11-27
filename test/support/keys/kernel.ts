import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Option } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ExprId, NodeId, OccurrenceId } from "#compiler/core/ids.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type NodeScope, nodeScopes, nodesByLabel } from "#compiler/ir/dag.ts"
import {
	type EvidenceContext,
	type Premise,
	samePremise,
	strongest
} from "#compiler/ir/evidence.ts"
import { nativeEqualityKey, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { Fold } from "#compiler/ir/fold.ts"
import { comparedValue } from "#compiler/ir/injective.ts"
import {
	type Dependency,
	hiddenAttribute,
	type Implication,
	isHidden,
	type KeyProof,
	type Rule,
	type Separation
} from "#compiler/ir/keys.ts"
import {
	callNumbering,
	type KeySet,
	type NodeOf,
	type RelDag,
	type RelNode
} from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"

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

/**
 * The value of a fixed column of a node, as the kernel reads it off a derivation: what equality compares, or opaque. An
 * outer value is a column the node reads from outside it (ir/dag.ts nodeScopes), one value per evaluation of the node;
 * a column the node binds, an occurrence source's in a region, a take's input's, a semi-join's left input's for its
 * right side, holds one value per row and is none of the node's values (KeyKernel #outer). An attachment's correlation
 * is the one other outer value: relative to its attachment, a child reads the parent's correlated column per parent row.
 */
type Value =
	| { readonly kind: "literal"; readonly key: string }
	| { readonly kind: "param"; readonly param: string }
	| { readonly kind: "outer"; readonly node: NodeId; readonly column: string }
	| { readonly kind: "opaque" }

const sameValue = (a: Value, b: Value): boolean =>
	(a.kind === "literal" && b.kind === "literal" && a.key === b.key) ||
	(a.kind === "param" && b.kind === "param" && a.param === b.param) ||
	(a.kind === "outer" && b.kind === "outer" && a.node === b.node && a.column === b.column)

/**
 * The faults of the parts a proof rests on, each checked at the node it is held at before the parts that rest on it. A
 * part names no node (ir/keys.ts Implication): it is relative to the node holding it, and a part a rule or a basis
 * rests on is held at the node the rule reads it from (KeyKernel #located).
 */
interface Checked {
	readonly proof: (p: KeyProof, at: RelNode) => ReadonlyArray<string>
	readonly implication: (i: Implication, at: RelNode) => ReadonlyArray<string>
}

/** A part of a proof, a sub-proof or a derivation, at the node it is held at. */
interface Located {
	readonly part: KeyProof | Implication
	readonly at: RelNode
}

/** Each arm of a union, in the order its rules name them. */
const armsOf = (n: NodeOf<"Union">): ReadonlyArray<RelNode> => Arr.flatMap(n.groups, (g) => g.arms)

/** The parts held at `at`, each paired with it. */
const at = (n: RelNode, parts: ReadonlyArray<KeyProof | Implication>): ReadonlyArray<Located> =>
	Arr.map(parts, (part) => ({ part, at: n }))

/** Each part paired with the node of the same place in `nodes`, none past their end. */
const zipped = (
	parts: ReadonlyArray<KeyProof | Implication>,
	nodes: ReadonlyArray<RelNode>
): ReadonlyArray<Located> =>
	Arr.flatMap(parts, (part, i) => {
		const n = nodes[i]
		return n === undefined ? [] : [{ part, at: n }]
	})

/**
 * The kernel over one DAG. A proof names no node: it is checked at the node holding it (check), and each part it rests
 * on at the node its rule reads it from, an input, an arm or an occurrence's source (#beneath). An attachment's
 * correlation names its attachment by label, which the kernel reads through the DAG's labels, gathered by one walk when
 * it is made. A witness names a conjunct by label, which the kernel finds among the conjuncts of the filter the witness
 * stands at.
 */
export class KeyKernel {
	readonly #nodes: ReadonlyMap<NodeId, RelNode>
	readonly #scopes: Fold<RelNode, NodeScope>
	readonly #env: KernelEnv

	constructor(dag: RelDag, env: KernelEnv) {
		this.#nodes = nodesByLabel(dag)
		this.#scopes = nodeScopes()
		this.#env = env
	}

	#node(id: NodeId): RelNode | undefined {
		return this.#nodes.get(id)
	}

	#heading(n: RelNode): ReadonlyArray<string> {
		return Arr.map(n.heading, (c) => c.name)
	}

	/** Each node's hidden attributes, read once: the kernel's own traversal state. */
	readonly #hiddenOf = new Map<RelNode, ReadonlyArray<string>>()

	/** A node's attributes: its heading, then its hidden attributes. */
	#attributes(n: RelNode): ReadonlyArray<string> {
		return [...this.#heading(n), ...this.#hidden(n)]
	}

	/**
	 * The attributes of a node's rows it does not deliver, read off the DAG alone (ir/keys.ts hiddenAttribute): a kept
	 * input's, the right side's of an intersection under its label, a projection's, a group's and a produce's input
	 * attributes it does not deliver, and a region's source attributes no variable of its heading is bound to, under
	 * the occurrence. A source and a union have none.
	 */
	#hidden(n: RelNode): ReadonlyArray<string> {
		const held = this.#hiddenOf.get(n)
		if (held !== undefined) {
			return held
		}
		const hide = (input: RelNode, delivered: (a: string) => boolean) =>
			Arr.flatMap(this.#attributes(input), (a) =>
				delivered(a) ? [] : [isHidden(a) ? a : hiddenAttribute(input.id, a)]
			)
		const out = ((): ReadonlyArray<string> => {
			switch (n.kind) {
				case "Call":
				case "Base":
				case "Closed":
				case "Context":
				case "Delta":
				case "InputSet":
				case "Recursive":
				case "SelfRef":
				case "Union":
					return []
				case "ProjectSet": {
					const copied = new Set(
						Arr.flatMap(n.out, (o) => {
							const c = this.#columnOf(o.expr, n.input.id)
							return c === undefined ? [] : [c]
						})
					)
					return hide(n.input, (a) => copied.has(a))
				}
				case "Group":
				case "OrderedSetAggregate":
					return hide(n.input, (a) => n.keys.includes(a))
				case "Produce":
					return hide(n.input, (a) => n.carried.includes(a))
				case "MatchRegion": {
					const heading = new Set(this.#heading(n))
					return Arr.flatMap(n.occurrences, (o) =>
						Arr.flatMap(this.#attributes(o.source), (a) =>
							Arr.some(o.bindings, (b) => b.column === a && heading.has(b.var.name))
								? []
								: [hiddenAttribute(o.id, a)]
						)
					)
				}
				case "Intersect":
					return [
						...this.#hidden(n.left),
						...Arr.map(this.#hidden(n.right), (h) => hiddenAttribute(n.right.id, h))
					]
				case "Filter":
				case "Take":
				case "Step":
				case "OrderedResult":
				case "Window":
					return this.#hidden(n.input)
				case "SemiJoin":
				case "AntiJoin":
				case "Difference":
					return this.#hidden(n.left)
				case "ApproximateNearest":
					return this.#hidden(n.source)
				case "Attach":
					return this.#hidden(n.parent)
				case "Forbid":
					return this.#hidden(n.violation)
			}
		})()
		this.#hiddenOf.set(n, out)
		return out
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
	/**
	 * The value a projection's output `o` holds where it is known only by its name: a parameter, a column of a node
	 * outside the projection's input; none for a literal, a copy or a computation.
	 */
	#namedValue(n: NodeOf<"ProjectSet">, o: string): string | undefined {
		const e = Option.getOrUndefined(Arr.findFirst(n.out, (p) => p.name === o))?.expr
		if (e?.kind === "param") {
			return `param\u0000${e.param}`
		}
		return e?.kind === "column" && e.column.node !== n.input.id
			? `outer\u0000${e.column.node}\u0000${e.column.name}`
			: undefined
	}

	#columnOf(e: ScalarExpr, node: NodeId): string | undefined {
		const value = comparedValue(e)
		return value.kind === "column" && value.column.node === node ? value.column.name : undefined
	}

	#reads(e: ScalarExpr, nodes: ReadonlySet<NodeId>): boolean {
		return Arr.some(e.deps.nodes, (n) => nodes.has(n))
	}

	/** The value expression `e`, evaluated at node `n`, has there: a literal, a parameter, an outer column of `n`, or opaque. */
	#classify(n: RelNode, e: ScalarExpr): Value {
		switch (e.kind) {
			case "literal":
				return { kind: "literal", key: nativeEqualityKey(e.value) }
			case "param":
				return { kind: "param", param: e.param }
			case "column":
				return this.#outer(n, e.column.node, e.column.name)
			case "variant":
			case "value":
			case "op":
			case "cast":
			case "domainCast":
			case "cond":
			case "closedAt":
			case "closedRow":
			case "call":
			case "closedHas":
				return { kind: "opaque" }
		}
	}

	/**
	 * Column `column` of node `node` as a value of node `n`: an outer value where `n` reads it from outside, so it holds
	 * one value per evaluation of `n`; opaque where `n` binds it, so it holds one per row of `n` (Value).
	 */
	#outer(n: RelNode, node: NodeId, column: string): Value {
		return this.#scopes.of(n).outer.get(node)?.has(column) === true
			? { kind: "outer", node, column }
			: { kind: "opaque" }
	}

	/**
	 * The value `i`, a derivation at an input of node `n`, fixes the input's column `column` to, as a value of `n`: what
	 * the input names it by, a column the input reads from outside read again at `n`, which may bind it (#outer).
	 */
	#carried(n: RelNode, i: Implication, held: RelNode | undefined, column: string): Value {
		const value = held === undefined ? undefined : this.#value(i, held, column)
		if (value === undefined) {
			return { kind: "opaque" }
		}
		return value.kind === "outer" ? this.#outer(n, value.node, value.column) : value
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
	 * Checks a proof `held` at a node, its node's meta holding it; the faults found, none for a valid one. Every part it
	 * rests on, a sub-proof or a derivation, is checked once at each node it is held at, before the parts that rest on
	 * it, however many of them share it.
	 */
	check(proof: KeyProof, held: RelNode): ReadonlyArray<string> {
		const faults = new Map<KeyProof | Implication, Map<RelNode, ReadonlyArray<string>>>()
		const read = (part: KeyProof | Implication, n: RelNode): ReadonlyArray<string> =>
			defined(faults.get(part)?.get(n), "a part checked before the parts resting on it")
		const checked: Checked = { proof: read, implication: read }
		/** One object per part and node, so the walk meets a part at a node once. */
		const located = new Map<KeyProof | Implication, Map<RelNode, Located>>()
		const intern = (l: Located): Located => {
			const byNode = located.get(l.part) ?? new Map<RelNode, Located>()
			located.set(l.part, byNode)
			const known = byNode.get(l.at)
			if (known !== undefined) {
				return known
			}
			byNode.set(l.at, l)
			return l
		}
		for (const l of postorder<Located>([intern({ part: proof, at: held })], (x) =>
			Arr.map(this.#beneath(x), intern)
		)) {
			const byNode = faults.get(l.part) ?? new Map<RelNode, ReadonlyArray<string>>()
			faults.set(l.part, byNode)
			byNode.set(
				l.at,
				"steps" in l.part
					? this.#implication(l.part, l.at, checked)
					: this.#proof(l.part, l.at, checked)
			)
		}
		return read(proof, held)
	}

	/**
	 * The parts a part held at a node rests on, each at the node it is held at: a derivation's steps' rules' parts, each at
	 * the input, the arm or the occurrence's source the rule reads it from; a proof's basis's (its derivation and members
	 * at its node, a union's arm proofs at their arms, a within key's inner key at the node and at each input whose rows
	 * it keeps, one of which holds it).
	 */
	#beneath(l: Located): ReadonlyArray<Located> {
		const n = l.at
		const part = l.part
		if ("steps" in part) {
			return Arr.flatMap(part.steps, (s) => this.#ruleParts(n, s.rule))
		}
		const members = at(n, [
			...Arr.map(part.members, (m) => m.determines),
			...Arr.flatMap(part.factors, (f) => Arr.map(f.alternatives, (a) => a.determines))
		])
		switch (part.basis.kind) {
			case "rows":
				return [...at(n, [part.basis.implication]), ...members]
			case "union": {
				const arms = n.kind === "Union" ? armsOf(n) : []
				return [
					...zipped(part.basis.arms, arms),
					...this.#separationParts(arms, part.basis.separations),
					...members
				]
			}
			case "within": {
				const inner = part.basis.inner
				return [
					...at(n, [part.basis.implication, inner]),
					...Arr.map(this.#keptInputs(n), (k) => ({ part: inner, at: k.input })),
					...members
				]
			}
		}
	}

	/** Each separation's two derivations, at the arms it tells apart. */
	#separationParts(
		arms: ReadonlyArray<RelNode>,
		separations: ReadonlyArray<Separation>
	): ReadonlyArray<Located> {
		return Arr.flatMap(separations, (s) => [
			...zipped(
				[s.fixed[0]],
				Arr.filter([arms[s.arms[0]]], (a) => a !== undefined)
			),
			...zipped(
				[s.fixed[1]],
				Arr.filter([arms[s.arms[1]]], (a) => a !== undefined)
			)
		])
	}

	/** The node a carried rule's input derivation is held at: the kept input, an intersection's right side, a group's input. */
	#carriedAt(n: RelNode, rule: "kept" | "intersected" | "grouped"): RelNode | undefined {
		switch (rule) {
			case "kept":
				return this.#keptInputs(n)[0]?.input
			case "intersected":
				return n.kind === "Intersect" ? n.right : undefined
			case "grouped":
				return n.kind === "Group" || n.kind === "OrderedSetAggregate" ? n.input : undefined
		}
	}

	/** The occurrence of a region a rule names. */
	#occurrence(
		n: RelNode,
		occurrence: OccurrenceId
	): NodeOf<"MatchRegion">["occurrences"][number] | undefined {
		return n.kind === "MatchRegion"
			? Option.getOrUndefined(Arr.findFirst(n.occurrences, (x) => x.id === occurrence))
			: undefined
	}

	/** The proofs and derivations a rule's side condition at node `n` rests on, each at the node it is held at. */
	#ruleParts(n: RelNode, rule: Rule): ReadonlyArray<Located> {
		const arms = n.kind === "Union" ? armsOf(n) : []
		const one = (part: KeyProof | Implication, held: RelNode | undefined): ReadonlyArray<Located> =>
			held === undefined ? [] : [{ part, at: held }]
		switch (rule.rule) {
			case "equal":
				return rule.witness.kind === "arms"
					? zipped(rule.witness.arms, arms)
					: rule.witness.kind === "lateralFixed"
						? one(rule.witness.fixed, this.#occurrence(n, rule.witness.occurrence)?.source)
						: []
			case "match":
				return one(rule.source, this.#occurrence(n, rule.occurrence)?.source)
			case "projection":
				return one(rule.input, n.kind === "ProjectSet" ? n.input : undefined)
			case "grouped":
			case "kept":
			case "intersected":
				return one(rule.input, this.#carriedAt(n, rule.rule))
			case "paired":
				return one(rule.input, n.kind === "SemiJoin" ? n.right : undefined)
			case "produced":
				return one(rule.input, n.kind === "Produce" ? n.input : undefined)
			case "agreed":
				return zipped(rule.arms, arms)
			case "unionKey":
				return one(rule.proof, n)
			case "separated":
				return [...zipped(rule.arms, arms), ...this.#separationParts(arms, rule.separations)]
			case "declared":
			case "viewAlternative":
			case "fixed":
			case "correlated":
			case "generated":
			case "group":
			case "atMostOne":
			case "distinct":
			case "ranked":
			case "numbered":
				return []
		}
	}

	#proof(p: KeyProof, n: RelNode, checked: Checked): ReadonlyArray<string> {
		const at = `${n.id} [${Arr.join(p.key, ", ")}]`
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
				appendAll(faults, checked.implication(i, n))
				if (!sameSet(i.from, p.key)) {
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
				const arms = armsOf(n)
				if (arms.length !== p.basis.arms.length) {
					faults.push(`${at}: one arm proof per arm`)
				}
				for (const [i, arm] of p.basis.arms.entries()) {
					const armNode = arms[i]
					if (armNode === undefined || !sameSet(arm.key, p.key)) {
						faults.push(`${at}: arm ${i} proves another key or no arm's`)
						continue
					}
					appendAll(faults, checked.proof(arm, armNode))
				}
				appendAll(
					faults,
					Arr.map(this.#apart(arms, p.basis.separations, p.key, checked), (f) => `${at}: ${f}`)
				)
				break
			}
			case "within": {
				const { implication: i, inner } = p.basis
				appendAll(faults, checked.implication(i, n))
				if (!sameSet(i.from, p.key)) {
					faults.push(`${at}: its derivation starts elsewhere than the key`)
				}
				if (!within(inner.key, this.#derived(i))) {
					faults.push(`${at}: its derivation does not reach the inner key`)
				}
				const holders = [n, ...Arr.map(this.#keptInputs(n), (k) => k.input)]
				if (!Arr.some(holders, (h) => checked.proof(inner, h).length === 0)) {
					faults.push(
						`${at}: an inner key proved at neither the node nor an input whose rows it keeps: ${Arr.join(checked.proof(inner, n), "; ")}`
					)
				}
				break
			}
		}
		const factored = Arr.flatMap(p.factors, (f) => f.key)
		if (factored.length !== new Set(factored).size || !sameSet(factored, p.key)) {
			faults.push(`${at}: factors whose keys do not partition the key`)
		}
		for (const f of p.factors) {
			for (const a of f.alternatives) {
				const stands = `${at}: alternative [${Arr.join(a.columns, ", ")}] for [${Arr.join(f.key, ", ")}]`
				appendAll(faults, checked.implication(a.determines, n))
				if (!within(a.columns, heading)) {
					faults.push(`${stands}: not heading columns`)
				}
				const given = Arr.filter(a.determines.from, (c) => !a.columns.includes(c))
				if (
					!within(a.columns, a.determines.from) ||
					!within(
						given,
						Arr.filter(p.key, (c) => !f.key.includes(c))
					) ||
					!within(f.key, this.#derived(a.determines))
				) {
					faults.push(
						`${stands}: its derivation does not derive the factor's key from it and other factors' key columns`
					)
				}
			}
		}
		const standable = new Set([
			...p.key,
			...Arr.flatMap(p.factors, (f) => Arr.flatMap(f.alternatives, (a) => a.columns))
		])
		for (const m of p.members) {
			const stands = `${at}: member ${m.column} for ${m.of}`
			appendAll(faults, checked.implication(m.determines, n))
			if (!standable.has(m.of) || p.key.includes(m.column) || !heading.includes(m.column)) {
				faults.push(
					`${stands}: not a heading column outside the key standing for a column of the key or an alternative`
				)
			}
			if (!sameSet(m.determines.from, [m.column]) || !this.#derived(m.determines).has(m.of)) {
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
		/** The name each input attribute has at the node. */
		readonly name: (attribute: string) => string
	}> {
		const same = (a: string) => a
		const all = (input: RelNode, discriminating: boolean) => [
			{ input, columns: this.#heading(input), discriminating, name: same }
		]
		switch (n.kind) {
			case "Filter":
			case "Take":
			case "Step":
			case "OrderedResult":
				return all(n.input, true)
			case "Window":
				return all(n.input, true)
			case "SemiJoin":
			case "AntiJoin":
			case "Difference":
				return all(n.left, true)
			case "Intersect": {
				const right = n.right
				return [
					...all(n.left, true),
					{
						input: right,
						columns: this.#heading(right),
						discriminating: false,
						name: (a: string) => (isHidden(a) ? hiddenAttribute(right.id, a) : a)
					}
				]
			}
			case "ApproximateNearest":
				return all(n.source, true)
			case "Attach":
				return all(n.parent, true)
			case "Forbid":
				return all(n.violation, true)
			case "Produce": {
				const input = n.input
				const carried = n.carried
				return [
					{
						input,
						columns: carried,
						discriminating: false,
						name: (a: string) =>
							carried.includes(a) || isHidden(a) ? a : hiddenAttribute(input.id, a)
					}
				]
			}
			case "Call":
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

	#implication(i: Implication, n: RelNode, checked: Checked): ReadonlyArray<string> {
		const attributes = this.#attributes(n)
		const faults: Array<string> = []
		if (!within(i.from, attributes)) {
			faults.push(`${n.id}: a derivation from attributes the node does not have`)
		}
		const reached = new Set(i.from)
		for (const step of i.steps) {
			const at = `${n.id} ${step.rule.rule} [${Arr.join(step.from, ", ")}] -> [${Arr.join(step.to, ", ")}]`
			if (!within(step.from, reached)) {
				faults.push(`${at}: a step before its determinants are known`)
			}
			if (!within(step.to, attributes)) {
				faults.push(`${at}: a step determining attributes the node does not have`)
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
			case "viewAlternative": {
				const alternatives =
					n.kind === "Base" && n.relationKind !== "relation" && this.#env.keyedViews
						? Arr.flatMap(n.view, (k) => k.alternatives)
						: []
				return Arr.some(
					alternatives,
					(a) =>
						((sameSet([...a.columns, ...a.given], d.from) && sameSet(a.of, d.to)) ||
							(sameSet([...a.of, ...a.given], d.from) && sameSet(a.columns, d.to))) &&
						a.context === r.context &&
						a.premises.length === r.premises.length &&
						Arr.every(a.premises, (q, i) => {
							const x = r.premises[i]
							return x !== undefined && samePremise(q, x)
						})
				)
					? []
					: ["no alternative of a key of the view"]
			}
			case "fixed":
				return d.from.length === 0 && d.to.length === 1
					? this.#fixed(n, d.to[0] ?? "", r.witness)
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
			case "generated":
				return this.#generated(n, d)
			case "projection":
				return this.#projection(n, d, r.input, checked)
			case "group":
				return (n.kind === "Group" || n.kind === "OrderedSetAggregate") &&
					sameSet(d.from, n.keys) &&
					within(d.to, heading)
					? []
					: ["not the group key determining the group"]
			case "grouped": {
				if (n.kind !== "Group" && n.kind !== "OrderedSetAggregate") {
					return ["a group's dependency outside a group"]
				}
				const input = n.input
				const keys = n.keys
				const name = (a: string) =>
					keys.includes(a) || isHidden(a) ? a : hiddenAttribute(input.id, a)
				const attributes = [...keys, ...this.#hidden(n)]
				return within(d.from, attributes) &&
					within(d.to, attributes) &&
					within(Arr.map(r.input.from, name), d.from) &&
					within(d.to, Arr.map([...this.#derived(r.input)], name))
					? [...checked.implication(r.input, input)]
					: ["not an input dependency among the group key and what it determines"]
			}
			case "kept":
			case "intersected": {
				const kept =
					r.rule === "kept"
						? this.#keptInputs(n)[0]
						: n.kind === "Intersect"
							? this.#keptInputs(n)[1]
							: undefined
				return kept !== undefined &&
					within(Arr.map(r.input.from, kept.name), d.from) &&
					within(d.to, Arr.map([...this.#derived(r.input)], kept.name)) &&
					within(d.to, this.#attributes(n))
					? [...checked.implication(r.input, kept.input)]
					: ["not a dependency of an input whose rows the node keeps"]
			}
			case "paired": {
				if (n.kind !== "SemiJoin") {
					return ["a paired dependency outside a semi-join"]
				}
				const derived = this.#derived(r.input)
				return Arr.every(r.input.from, (x) =>
					Arr.some(n.on, (p) => p.right === x && d.from.includes(p.left))
				) && Arr.every(d.to, (l) => Arr.some(n.on, (p) => p.left === l && derived.has(p.right)))
					? [...checked.implication(r.input, n.right)]
					: [
							"not a dependency of the right side among the semi-join's pairs, at their left columns"
						]
			}
			case "atMostOne":
				return d.from.length === 0 && within(heading, d.to) && this.#atMostOne(n, r.witness)
					? []
					: ["no witness of at most one row"]
			case "distinct": {
				if (n.kind !== "Closed" || !Arr.isReadonlyArrayNonEmpty(d.from)) {
					return ["distinct columns outside a closed relation"]
				}
				const at = Arr.map(d.from, (c) => Arr.findFirstIndex(n.heading, (h) => h.name === c))
				if (!Arr.every(at, Option.isSome)) {
					return ["a distinct column outside the heading"]
				}
				const tuples = Arr.map(n.rows, (row) =>
					Arr.map(at, (i) => {
						const literal = Option.isSome(i) ? row[i.value] : undefined
						return literal === undefined ? "" : nativeEqualityKey(literal)
					})
				)
				const texts = Arr.map(tuples, (t) => jsonText(t))
				return new Set(texts).size === texts.length && within(heading, d.to)
					? []
					: ["columns whose value tuples repeat"]
			}
			case "produced": {
				if (n.kind !== "Produce" || !within(r.input.key, n.carried)) {
					return ["not a carried key of the produce's input"]
				}
				const from = n.producer === "spanIntersection" ? r.input.key : [...r.input.key, n.out]
				return sameSet(d.from, from)
					? [...checked.proof(r.input, n.input)]
					: ["not the carried key and its span"]
			}
			case "numbered":
				return n.kind === "Window" &&
					n.fn === "rowNumber" &&
					sameSet(d.from, [...n.partition, n.out]) &&
					within(heading, d.to)
					? []
					: ["not a row number with its partition determining the row"]
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
				const arms = armsOf(n)
				if (arms.length !== r.arms.length) {
					return ["one derivation per arm"]
				}
				const values = Arr.map(r.arms, (a, i) => {
					const arm = arms[i]
					return arm !== undefined && a.from.length === 0 ? this.#value(a, arm, column) : undefined
				})
				const [first] = values
				const agree =
					first !== undefined &&
					first.kind !== "opaque" &&
					Arr.every(values, (v) => v !== undefined && sameValue(v, first))
				return agree
					? Arr.flatMap(r.arms, (a, i) => {
							const arm = arms[i]
							return arm === undefined ? [`arm ${i}: no such arm`] : checked.implication(a, arm)
						})
					: ["arms that fix the column to different values"]
			}
			case "unionKey":
				return n.kind === "Union" &&
					r.proof.basis.kind === "union" &&
					sameSet(d.from, r.proof.key) &&
					within(d.to, heading)
					? [...checked.proof(r.proof, n)]
					: ["not a union key determining the union's row"]
			case "separated": {
				if (n.kind !== "Union") {
					return ["what every arm derives, outside a union"]
				}
				const arms = armsOf(n)
				if (arms.length !== r.arms.length) {
					return ["one derivation per arm"]
				}
				return [
					...Arr.flatMap(r.arms, (a, i) => {
						const arm = arms[i]
						return arm !== undefined && sameSet(a.from, d.from) && within(d.to, this.#derived(a))
							? checked.implication(a, arm)
							: [`arm ${i}'s derivation does not derive it from its determinants`]
					}),
					...(within(d.from, heading) && within(d.to, heading)
						? []
						: ["not columns of the union's heading"]),
					...this.#apart(arms, r.separations, d.from, checked)
				]
			}
		}
	}

	/**
	 * The faults of `separations` telling every two of `arms` apart on a column of `columns`: each fixing it, by its own
	 * derivation from nothing, to a literal, the two different.
	 */
	#apart(
		arms: ReadonlyArray<RelNode>,
		separations: ReadonlyArray<Separation>,
		columns: ReadonlyArray<string>,
		checked: Checked
	): ReadonlyArray<string> {
		const faults: Array<string> = []
		for (let i = 0; i < arms.length; i++) {
			for (let j = i + 1; j < arms.length; j++) {
				const s = Option.getOrUndefined(
					Arr.findFirst(separations, (x) => x.arms[0] === i && x.arms[1] === j)
				)
				if (s === undefined || !columns.includes(s.column)) {
					faults.push(`arms ${i} and ${j} told apart on no column of its own`)
					continue
				}
				const [fi, fj] = s.fixed
				const ai = arms[i]
				const aj = arms[j]
				if (ai === undefined || aj === undefined) {
					faults.push(`arms ${i} and ${j}: no such arms`)
					continue
				}
				appendAll(faults, [...checked.implication(fi, ai), ...checked.implication(fj, aj)])
				const vi = fi.from.length === 0 ? this.#value(fi, ai, s.column) : undefined
				const vj = fj.from.length === 0 ? this.#value(fj, aj, s.column) : undefined
				if (vi?.kind !== "literal" || vj?.kind !== "literal" || vi.key === vj.key) {
					faults.push(`arms ${i} and ${j} not told apart by differing literals on ${s.column}`)
				}
			}
		}
		return faults
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

	/**
	 * A generated field's dependency: at a Base over a stored relation, one of the generated fields stamped on it, from
	 * exactly the fields its generation reads (ir/keys.ts GeneratedRead).
	 */
	#generated(n: RelNode, d: Dependency): ReadonlyArray<string> {
		const stamped = n.kind === "Base" && n.relationKind === "relation" ? n.generated : []
		return Arr.some(stamped, (g) => sameSet(g.reads, d.from) && sameSet([g.field], d.to))
			? []
			: ["not a generated field of the relation from what its generation reads"]
	}

	#fixed(
		n: RelNode,
		column: string,
		w: Extract<Rule, { readonly rule: "fixed" }>["witness"]
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
				if (o === undefined || fixed.from.length > 0) {
					return ["no derivation from nothing at the occurrence's source"]
				}
				const bound = Arr.map(
					Arr.filter(o.bindings, (x) => x.column === w.column),
					(x) => x.var.name
				)
				const value = this.#value(fixed, o.source, w.column)
				const other =
					value?.kind === "outer" ? this.#varFor(n, value.node, value.column) : undefined
				const holds =
					other !== undefined &&
					((bound.includes(a) && other === b) || (bound.includes(b) && other === a))
				return holds
					? [...checked.implication(fixed, o.source)]
					: ["no variable bound to a source column fixed to the other variable's region column"]
			}
			case "arms": {
				if (n.kind !== "Union") {
					return ["columns equal in every arm, outside a union"]
				}
				const arms = armsOf(n)
				if (arms.length !== w.arms.length) {
					return ["one derivation per arm"]
				}
				return Arr.flatMap(w.arms, (arm, i) => {
					const held = arms[i]
					return held === undefined
						? [`arm ${i}: no such arm`]
						: [...checked.implication(arm, held), ...this.#equalChain(arm, held, a, b)]
				})
			}
		}
	}

	/**
	 * The faults of `i` as a derivation that `b` equals `a` in every row of its node, by equalities alone: from `a`, one
	 * column to the next, each step an equal dependency, two outputs of a projection copying one input column or columns
	 * its input derivation makes equal, a kept input's columns its derivation makes equal, or two key columns of a group
	 * its input derivation makes equal, every group's key values one input row's, ending at `b`. That one
	 * column determines another is no equality: two arms of a union may each determine b from a, differently.
	 */
	#equalChain(i: Implication, n: RelNode, a: string, b: string): ReadonlyArray<string> {
		if (!sameSet(i.from, [a])) {
			return [`${n.id}: an equality from other than ${a}`]
		}
		let at = a
		for (const step of i.steps) {
			const [from] = step.from
			const [to] = step.to
			if (step.from.length !== 1 || step.to.length !== 1 || from !== at || to === undefined) {
				return [`${n.id}: an equality step from other than ${at} alone to one column`]
			}
			const faults = this.#equalChainStep(n, step.rule, from, to)
			if (faults.length > 0) {
				return faults
			}
			at = to
		}
		return at === b ? [] : [`${n.id}: an equality reaching ${at}, not ${b}`]
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
					const vx = this.#namedValue(n, x)
					return vx !== undefined && vx === this.#namedValue(n, y)
						? []
						: [
								"an equality through an output copying no input column and holding no parameter or outer column the other holds"
							]
				}
				return cx === cy ? [] : this.#equalChain(r.input, n.input, cx, cy)
			}
			case "kept":
			case "intersected": {
				const held = this.#carriedAt(n, r.rule)
				return held === undefined
					? [`a ${r.rule} step at a node that keeps no such input's rows`]
					: this.#equalChain(r.input, held, x, y)
			}
			case "grouped":
				return (n.kind === "Group" || n.kind === "OrderedSetAggregate") &&
					n.keys.includes(x) &&
					n.keys.includes(y)
					? this.#equalChain(r.input, n.input, x, y)
					: ["an equality through a group's columns outside its key"]
			case "declared":
			case "viewAlternative":
			case "fixed":
			case "correlated":
			case "match":
			case "generated":
			case "group":
			case "atMostOne":
			case "distinct":
			case "produced":
			case "ranked":
			case "numbered":
			case "paired":
			case "agreed":
			case "unionKey":
			case "separated":
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
		if (o === undefined) {
			return ["no such occurrence over the derivation's source"]
		}
		const faults: Array<string> = [...checked.implication(source, o.source)]
		const from = new Set(d.from)
		for (const c of source.from) {
			const bound =
				Arr.some(o.bindings, (b) => b.column === c && from.has(b.var.name)) ||
				from.has(hiddenAttribute(o.id, c))
			const constant = Option.getOrUndefined(Arr.findFirst(o.constants, (k) => k.column === c))
			const reads = constant === undefined ? undefined : this.#regionVars(n, constant.expr)
			if (!bound && (reads === undefined || !within(reads, from))) {
				faults.push(
					`source attribute ${c} neither bound to a determinant, hidden among them, nor fixed by a constant reading only them`
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
		const hidden = new Set(
			Arr.flatMap([...reached], (c) => {
				const h = hiddenAttribute(o.id, c)
				return this.#hidden(n).includes(h) ? [h] : []
			})
		)
		for (const v of d.to) {
			if (
				!hidden.has(v) &&
				!Arr.some(o.bindings, (b) => b.var.name === v && reached.has(b.column))
			) {
				faults.push(`${v} neither bound to nor hiding an attribute the source derivation reaches`)
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
		if (n.kind !== "ProjectSet") {
			return ["a projection over another node"]
		}
		const copyOf = (o: string): string | undefined => {
			const out = Option.getOrUndefined(Arr.findFirst(n.out, (x) => x.name === o))
			return out === undefined ? undefined : this.#columnOf(out.expr, n.input.id)
		}
		const copied = new Set(
			Arr.flatMap(n.out, (o) => {
				const c = this.#columnOf(o.expr, n.input.id)
				return c === undefined ? [] : [c]
			})
		)
		/** Each hidden attribute here, with the input attribute it is. */
		const hiddenFrom = new Map(
			Arr.flatMap(this.#attributes(n.input), (a) =>
				copied.has(a) ? [] : [[isHidden(a) ? a : hiddenAttribute(n.input.id, a), a] as const]
			)
		)
		const copies = Arr.flatMap(d.from, (o) => {
			const c = copyOf(o) ?? hiddenFrom.get(o)
			return c === undefined ? [] : [c]
		})
		const faults: Array<string> = [...checked.implication(input, n.input)]
		if (!within(input.from, copies)) {
			faults.push("an input derivation from attributes no determinant copies or hides")
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
			const hides = hiddenFrom.get(o)
			if (hides !== undefined) {
				if (!reached.has(hides)) {
					faults.push(`hidden ${o} of an attribute the input derivation does not reach`)
				}
				continue
			}
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
			case "partialSplit":
				return n.kind === "Call" && callNumbering(n.function).kind === "one"
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
	 * value it holds, and the first is the one the analysis reached it by. Each is a value of `i`'s node (Value): a step
	 * that carries an input's column reads the input's value again at the node, where a column the node binds is opaque,
	 * as the analysis names none by it.
	 */
	#value(i: Implication, n: RelNode, column: string): Value | undefined {
		return this.#derived(i).has(column) ? this.#valueAmong(i, n, i.steps, column) : undefined
	}

	/**
	 * The value `column` holds by the first of `steps`, a prefix of `i`'s (held at `n`), that names one; opaque where none
	 * does.
	 */
	#valueAmong(i: Implication, n: RelNode, steps: ReadonlyArray<Dependency>, column: string): Value {
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
				return c === undefined ? { kind: "opaque" } : this.#classify(n, c.expr)
			}
			case "equal": {
				const [from] = step.from
				return from === undefined ? { kind: "opaque" } : this.#valueAmong(i, n, before, from)
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
					? this.#classify(n, constant.expr)
					: this.#carried(n, r.source, o.source, b.column)
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
						? this.#classify(n, out.expr)
						: this.#carried(n, r.input, n.input, copied)
			}
			case "kept":
			case "intersected":
			case "grouped":
				return this.#carried(n, r.input, this.#carriedAt(n, r.rule), column)
			case "paired": {
				const derived = this.#derived(r.input)
				const pair =
					n.kind === "SemiJoin"
						? Option.getOrUndefined(
								Arr.findFirst(n.on, (p) => p.left === column && derived.has(p.right))
							)
						: undefined
				return n.kind !== "SemiJoin" || pair === undefined
					? { kind: "opaque" }
					: this.#carried(n, r.input, n.right, pair.right)
			}
			case "agreed": {
				const [first] = r.arms
				return this.#carried(n, first, n.kind === "Union" ? armsOf(n)[0] : undefined, column)
			}
			case "declared":
			case "viewAlternative":
			case "generated":
			case "group":
			case "atMostOne":
			case "distinct":
			case "produced":
			case "ranked":
			case "numbered":
			case "unionKey":
			case "separated":
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
				return other === undefined ? { kind: "opaque" } : this.#classify(n, other)
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
				return c === undefined ? { kind: "opaque" } : this.#classify(n, c.expr)
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
					case "viewAlternative":
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
						break
					case "match":
						fromImplication(r.source)
						break
					case "projection":
					case "grouped":
					case "kept":
					case "intersected":
					case "paired":
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
					case "separated":
						Arr.forEach(r.arms, fromImplication)
						for (const s of r.separations) {
							Arr.forEach(s.fixed, fromImplication)
						}
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
					case "generated":
					case "group":
					case "ranked":
					case "numbered":
						break
				}
			}
		}
		Arr.forEach(p.members, (m) => fromImplication(m.determines))
		Arr.forEach(p.factors, (f) => Arr.forEach(f.alternatives, (a) => fromImplication(a.determines)))
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
