import { Array as Arr, Option, Order } from "effect"
import {
	analyzePhysical,
	type PhysicalAnalysis,
	type PhysicalEnv,
	unplaced
} from "#compiler/analysis/physical/analyze.ts"
import type { PhysicalProps, Realization } from "#compiler/analysis/physical/props.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { Heading, KeySet, NodeOf, RelDag, RelNode } from "#compiler/ir/rel.ts"
import { defined } from "#test/support/assert.ts"
import type { Ir } from "#test/support/fixtures/ir/build.ts"
import { Identities, type Interned } from "#test/support/kernel/identity.ts"
import {
	noBindings,
	type ReferenceInput,
	type RelationValue
} from "#test/support/oracle/reference/evaluate.ts"
import { RecordingReference } from "#test/support/oracle/reference/evaluations.ts"
import { type Row, rowIdentity } from "#test/support/oracle/reference/values.ts"

/**
 * Shared helpers for the physical analysis tests: running the analysis, and a fragment evaluator that computes the rows
 * each fragment's SQL physically delivers under a realization, so every claim the analysis makes can be checked against
 * the rows themselves.
 *
 * The fragment evaluator is the brute-force reference evaluator (test/support/oracle/reference) with its set boundary
 * moved: Reference deduplicates every node, as the conservative lowering does; FragmentReference deduplicates only what
 * the physical form deduplicates. A relation parameter is deduplicated on entry, a Group delivers one row per group and
 * a Recursive its UNION's distinct states, INTERSECT and EXCEPT keep their set forms, and a node realized `distinct` (a
 * set UNION or a placed DISTINCT) is deduplicated; every other node keeps the rows its plain SQL would produce, repeats
 * included, so a projection that drops keys, a join with fanout and a UNION ALL repeat. A fold reads every row its
 * input's fragment delivers, as both lowerings fold it: a repeat that reaches a fold changes its answer, and the
 * program's result then differs from the reference's, whatever the analysis claimed.
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
	return p.uniqueness.kind !== "none" ? { kind: "none" } : { kind: "on", heading: [...p.columns] }
}

/**
 * Every minimal key the properties prove, narrowest first, each in heading order. The analysis lists no keys, so a test
 * that reads them enumerates them here from the dependency table's proof (fds.ts Dependencies proof), which is
 * monotone: a superset of a key identifies a row too.
 *
 * The enumeration never visits the heading's subsets, which a wide node has too many of: it is Berge's joint generation
 * of a monotone function's minimal true sets. Given the minimal keys found so far, every set that holds none of them
 * misses one column of each, so it lies inside the complement of a minimal transversal of the found keys (a smallest
 * set meeting every one). A key not yet found is such a set, so it lies inside some transversal's complement, which is
 * therefore a key; and a complement that is a key holds a minimal key not yet found, the one shrinking it reaches
 * (dropping each column the rest is still a key without). So the keys are complete exactly when no transversal's
 * complement is a key. The cost is the keys times the transversals, never the subsets.
 */
export const provedKeys = (p: PhysicalProps): ReadonlyArray<KeySet> => {
	const heading = p.columns
	const isKey = (s: ReadonlyArray<string>): boolean => p.dependencies.proof(s) !== undefined
	if (!isKey(heading)) {
		return []
	}
	/** `s` shrunk to a minimal key inside it, in heading order: each column dropped that the rest is a key without. */
	const minimized = (s: ReadonlyArray<string>): KeySet =>
		Arr.reduce(s, s, (kept, column) => {
			const without = Arr.filter(kept, (c) => c !== column)
			return isKey(without) ? without : kept
		})
	const holds = (outer: ReadonlyArray<string>, inner: ReadonlyArray<string>): boolean =>
		Arr.every(inner, (c) => outer.includes(c))
	/** The minimal sets among `family`, each kept once. */
	const minimalAmong = (
		family: ReadonlyArray<ReadonlyArray<string>>
	): ReadonlyArray<ReadonlyArray<string>> =>
		Arr.filter(
			family,
			(t, i) =>
				!Arr.some(family, (u, j) => (j < i ? holds(t, u) : j > i && holds(t, u) && !holds(u, t)))
		)
	const keys: Array<KeySet> = []
	/** The minimal transversals of `keys`, extended by Berge's rule one key at a time: none of none is the empty set. */
	let transversals: ReadonlyArray<ReadonlyArray<string>> = [[]]
	for (;;) {
		const fresh = Arr.findFirst(transversals, (t) =>
			isKey(Arr.filter(heading, (c) => !t.includes(c)))
		)
		if (Option.isNone(fresh)) {
			break
		}
		const key = minimized(Arr.filter(heading, (c) => !fresh.value.includes(c)))
		keys.push(key)
		transversals = minimalAmong(
			Arr.flatMap(transversals, (t) =>
				Arr.some(key, (c) => t.includes(c)) ? [t] : Arr.map(key, (c) => [...t, c])
			)
		)
	}
	return Arr.sort(
		keys,
		Order.mapInput(Order.Number, (k: KeySet) => k.length)
	)
}

export const keyColumns = (
	a: PhysicalAnalysis,
	node: RelNode
): ReadonlyArray<ReadonlyArray<string>> => provedKeys(propsOf(a, node))

/**
 * The fragment evaluator: the rows each fragment's SQL delivers under a realization. Its evaluations record every
 * relation computed, a correlated node's once per outer tuple.
 */
export class FragmentReference extends RecordingReference {
	readonly #realization: (node: RelNode) => Realization

	protected constructor(
		dag: RelDag,
		input: ReferenceInput,
		realization: (node: RelNode) => Realization
	) {
		super(dag, input)
		this.#realization = realization
	}

	/** The fragment reference of a case under a realization: its DAG's closed fragments settled. */
	static delivered(
		dag: RelDag,
		input: ReferenceInput,
		realization: (node: RelNode) => Realization
	): FragmentReference {
		return new FragmentReference(dag, input, realization).settle()
	}

	override deduplicates(node: RelNode): boolean {
		return (
			node.kind === "InputSet" ||
			node.kind === "Group" ||
			node.kind === "Recursive" ||
			node.kind === "Intersect" ||
			node.kind === "Difference" ||
			this.#realization(node) === "distinct"
		)
	}

	/** Every row the fold's input fragment delivers contributes, as both lowerings fold it: none is deduplicated first. */
	override contributions(
		_node: NodeOf<"Group">,
		tuples: ReadonlyArray<Row>,
		_heading: Heading
	): ReadonlyArray<Row> {
		return tuples
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
	const identities = new Identities()
	const seen = new Set<Interned>()
	for (const row of rows) {
		const p = projectTo(heading, columns, row)
		const k = identities.of(rowIdentity(p.row, p.heading))
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
	delivered: FragmentReference
): ReadonlyArray<Violation> => {
	for (const node of analysis.order) {
		if (delivered.closed(node)) {
			delivered.eval(node, noBindings)
		}
	}
	/** What one relation of a node breaks of the node's claims. */
	const brokenIn = (node: RelNode, rel: RelationValue): ReadonlyArray<Violation> => {
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
				: []),
			...(p.uniqueness.kind === "plain" &&
			!uniqueOn(rel.heading, rel.rows, [...p.uniqueness.key.columns])
				? [
						{
							node: id,
							claim: `the uniqueness proof's key (${Arr.join(p.uniqueness.key.columns, ", ")})`
						}
					]
				: [])
		]
	}
	const claims = Arr.flatMap(analysis.order, (node) =>
		Arr.flatMap(delivered.evaluations.of(node), (rel) => brokenIn(node, rel))
	)
	const dischargedObligations = Arr.filter(analysis.obligations, (o) => o.discharged)
	const discharged = Arr.flatMap(dischargedObligations, (o) =>
		Arr.map(
			Arr.filter(
				delivered.evaluations.of(o.edge.input),
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
