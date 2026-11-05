import { Array as Arr, Option, Order } from "effect"
import type { MultiplicityReason } from "#compiler/analysis/certificates/reasons.ts"
import {
	analyzePhysical,
	type PhysicalAnalysis,
	type PhysicalEnv,
	unplaced
} from "#compiler/analysis/physical/analyze.ts"
import { isUnique, plainLosses } from "#compiler/analysis/physical/props.ts"
import type { PhysicalProps, Realization } from "#compiler/analysis/physical/props.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { Heading, KeySet, RelDag, RelNode } from "#compiler/ir/rel.ts"
import { defined } from "#test/support/assert.ts"
import type { Ir } from "#test/support/fixtures/ir/build.ts"
import {
	type Bindings,
	noBindings,
	type ReferenceInput,
	type Relation
} from "#test/support/oracle/reference/evaluate.ts"
import { RecordingReference } from "#test/support/oracle/reference/evaluations.ts"
import { type Row, rowKey } from "#test/support/oracle/reference/values.ts"

/**
 * Shared helpers for the physical analysis tests: running the analysis, and a bag evaluator that computes what each
 * fragment's SQL physically delivers under a realization, so every claim the analysis makes can be checked against
 * the rows themselves.
 *
 * The bag evaluator is the brute-force reference evaluator (test/support/oracle/reference) with its set
 * boundary moved: Reference deduplicates every node, as the conservative lowering does; BagReference deduplicates only
 * what the physical form deduplicates. A relation parameter is deduplicated on entry, a Group delivers
 * one row per group and a Recursive its UNION's distinct states (both are computed so by Reference itself), and a node
 * realized `distinct` (a set UNION, INTERSECT, EXCEPT, or a placed DISTINCT) is deduplicated; every other node keeps
 * the repeats its plain SQL would produce, so a projection that drops keys, a join with fanout and a UNION ALL repeat.
 */
export const physical = (dag: RelDag, env: PhysicalEnv): PhysicalAnalysis =>
	analyzePhysical(dag, env)

/**
 * The environment a hand-built DAG is analyzed in: the snapshot context, and its schema's own catalog, every key named
 * as ownership installs it.
 */
export const snapshotOver = (m: Ir): PhysicalEnv => ({
	context: "snapshot",
	catalog: m.model.fixture.catalog,
	realization: unplaced,
	roots: "result"
})

export const propsOf = (a: PhysicalAnalysis, node: RelNode): PhysicalProps => a.of(node).props

/** Whether duplicate elimination is still owed on a node's rows: nothing, or on an exact heading. */
type Owed = { readonly kind: "none" } | { readonly kind: "on"; readonly heading: KeySet }

/**
 * What `node` still owes of duplicate elimination, as the analysis states it: the heading of the first outstanding
 * obligation on its rows, nothing when its properties prove it unique, and otherwise every column.
 */
export const owedOf = (a: PhysicalAnalysis, node: RelNode): Owed => {
	const outstanding = Arr.findFirst(a.obligations, (o) => !o.discharged && o.edge.input === node)
	if (Option.isSome(outstanding)) {
		return { kind: "on", heading: [...outstanding.value.heading] }
	}
	const p = propsOf(a, node)
	return isUnique(p) ? { kind: "none" } : { kind: "on", heading: [...p.columns] }
}

/**
 * Every minimal key the properties prove, by brute force over the heading's subsets, narrowest first: a subset is a key
 * when the dependency table identifies a row by it (fds.ts Dependencies proof), and minimal when no proper subset is
 * one, so a subset holding a key found narrower is never asked. The analysis lists no keys, so a test that reads them
 * enumerates them here, each in heading order.
 */
export const provedKeys = (p: PhysicalProps): ReadonlyArray<KeySet> => {
	const subsets = Arr.reduce(p.columns, Arr.of<KeySet>([]), (prior, c) =>
		Arr.appendAll(
			prior,
			Arr.map(prior, (s): KeySet => [...s, c])
		)
	)
	const keys: Array<KeySet> = []
	for (const s of Arr.sort(
		subsets,
		Order.mapInput(Order.Number, (k: KeySet) => k.length)
	)) {
		if (
			!Arr.some(keys, (k) => Arr.every(k, (c) => s.includes(c))) &&
			p.dependencies.proof(s) !== undefined
		) {
			keys.push(s)
		}
	}
	return keys
}

export const keyColumns = (
	a: PhysicalAnalysis,
	node: RelNode
): ReadonlyArray<ReadonlyArray<string>> => provedKeys(propsOf(a, node))

export const lossReasons = (
	a: PhysicalAnalysis,
	node: RelNode
): ReadonlyArray<MultiplicityReason> => Arr.map(plainLosses(propsOf(a, node)), (l) => l.reason)

/** The bag evaluator; its evaluations record every relation computed, a correlated node's once per outer tuple. */
export class BagReference extends RecordingReference {
	readonly #realization: (node: RelNode) => Realization

	protected constructor(
		dag: RelDag,
		input: ReferenceInput,
		realization: (node: RelNode) => Realization
	) {
		super(dag, input)
		this.#realization = realization
	}

	/** The bag reference of a case under a realization: its DAG's closed bags settled. */
	static bag(
		dag: RelDag,
		input: ReferenceInput,
		realization: (node: RelNode) => Realization
	): BagReference {
		return new BagReference(dag, input, realization).settle()
	}

	override deduplicates(node: RelNode): boolean {
		return (
			node.kind === "InputSet" ||
			node.kind === "Group" ||
			node.kind === "Recursive" ||
			this.#realization(node) === "distinct"
		)
	}

	/**
	 * An intersection or difference realized plainly is the internal ALL form: INTERSECT ALL keeps
	 * min(l, r) copies of a row and EXCEPT ALL max(l - r, 0), counted over the inputs' delivered rows.
	 *
	 * Each left copy is matched against one right copy, in turn.
	 */
	override rows(node: RelNode, scope: Bindings): ReadonlyArray<Row> {
		if (
			(node.kind !== "Intersect" && node.kind !== "Difference") ||
			this.#realization(node) !== "plain"
		) {
			return super.rows(node, scope)
		}
		const left = this.eval(node.left, scope)
		const right = this.eval(node.right, scope)
		const counts = new Map<string, number>()
		for (const row of right.rows) {
			const k = rowKey(
				projectTo(
					right.heading,
					Arr.map(left.heading, (h) => h.name),
					row
				).row,
				left.heading
			)
			counts.set(k, (counts.get(k) ?? 0) + 1)
		}
		const out: Array<Row> = []
		for (const row of left.rows) {
			const k = rowKey(row, left.heading)
			const r = counts.get(k) ?? 0
			if (node.kind === "Intersect" ? r > 0 : r === 0) {
				out.push(row)
			}
			if (r > 0) {
				counts.set(k, r - 1)
			}
		}
		return out
	}
}

const projectTo = (
	heading: Heading,
	columns: ReadonlyArray<string>,
	row: Row
): { heading: Heading; row: Row } => {
	const idx = Arr.map(columns, (c) =>
		Option.getOrThrowWith(
			Arr.findFirstIndex(heading, (h) => h.name === c),
			() => new Error("a column the case's own heading holds")
		)
	)
	return {
		heading: Arr.map(idx, (i) => defined(heading[i], `column ${i} of the heading`)),
		row: Arr.map(idx, (i) => defined(row[i], `value ${i} of the row`))
	}
}

/** Whether `rows` hold at most one row per value of `columns`. */
export const uniqueOn = (
	heading: Heading,
	rows: ReadonlyArray<Row>,
	columns: ReadonlyArray<string>
): boolean => {
	const seen = new Set<string>()
	for (const row of rows) {
		const p = projectTo(heading, columns, row)
		const k = rowKey(p.row, p.heading)
		if (seen.has(k)) {
			return false
		}
		seen.add(k)
	}
	return true
}

export interface Violation {
	readonly node: NodeId
	readonly claim: string
}

/**
 * Every claim the analysis makes about a node, checked against every relation its physical form delivered: each
 * physical key holds, the maximum cardinality holds, a node with no outstanding elimination is unique, and a
 * discharged obligation's input has one row per value of its heading. Every closed node is evaluated, and with it every
 * correlated node beneath, once per outer tuple; a correlated node's claims are relative to the outer values, so each
 * holds in every one of its relations.
 */
export const soundness = (
	analysis: PhysicalAnalysis,
	bag: BagReference
): ReadonlyArray<Violation> => {
	for (const node of analysis.order) {
		if (bag.closed(node)) {
			bag.eval(node, noBindings)
		}
	}
	/** What one relation of a node breaks of the node's claims. */
	const brokenIn = (node: RelNode, rel: Relation): ReadonlyArray<Violation> => {
		const id = node.id
		const p = propsOf(analysis, node)
		const owed = owedOf(analysis, node)
		return [
			...Arr.map(
				Arr.filter(provedKeys(p), (k) => !uniqueOn(rel.heading, rel.rows, k)),
				(k): Violation => ({ node: id, claim: `key (${Arr.join(k, ", ")})` })
			),
			...(p.maxCard.kind === "atMost" && BigInt(rel.rows.length) > p.maxCard.rows
				? [{ node: id, claim: `at most ${p.maxCard.rows} rows` }]
				: []),
			...(owed.kind === "none" && !uniqueOn(rel.heading, rel.rows, p.columns)
				? [{ node: id, claim: "nothing owed" }]
				: [])
		]
	}
	const claims = Arr.flatMap(analysis.order, (node) =>
		Arr.flatMap(bag.evaluations.of(node), (rel) => brokenIn(node, rel))
	)
	const dischargedObligations = Arr.filter(analysis.obligations, (o) => o.discharged)
	const discharged = Arr.flatMap(dischargedObligations, (o) =>
		Arr.map(
			Arr.filter(
				bag.evaluations.of(o.edge.input),
				(rel) => !uniqueOn(rel.heading, rel.rows, o.heading)
			),
			(): Violation => ({
				node: o.edge.input.id,
				claim: `discharged obligation on (${Arr.join(o.heading, ", ")})`
			})
		)
	)
	return [...claims, ...discharged]
}
