import { Array as Arr } from "effect"
import {
	analyzePhysical,
	type Obligation,
	type PhysicalAnalysis,
	unplaced
} from "#compiler/analysis/physical/analyze.ts"
import type { Realization } from "#compiler/analysis/physical/props.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { unbounded } from "#compiler/ir/cardinality.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import type { RelDag, RelNode, ValidDag } from "#compiler/ir/rel.ts"
import { LowerContext, type NodeDispatch } from "#compiler/lower/conservative/context.ts"
import { Delivery } from "#compiler/lower/conservative/deliver.ts"
import { dispatchNode } from "#compiler/lower/conservative/dispatch.ts"
import type {
	ConservativeOptions,
	ConservativeProgram
} from "#compiler/lower/conservative/types.ts"
import { aggregateLowerer } from "#compiler/lower/shapes/aggregate/index.ts"
import { withBoundary, withoutBoundary } from "#compiler/lower/shapes/index.ts"
import { inputSetLowerer } from "#compiler/lower/shapes/relparam/index.ts"
import { type ShapeFacts, shapeFactsFromPlan } from "#compiler/lower/shapes/share/physical.ts"
import { takeLowerer } from "#compiler/lower/shapes/take/index.ts"
import { unionLowerer } from "#compiler/lower/shapes/union/index.ts"
import { defined } from "#test/support/assert.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { fixtureCodes } from "#test/unit/ir/fixture.ts"
import { ledgerCatalog } from "#test/unit/lower/rewrite/support.ts"

/**
 * Shared helpers for the shape tests: a lowering context whose dispatch routes Take, Group, Union and InputSet to
 * the shape lowerers and every other kind to the conservative plug-ins, physical facts from a real physical analysis over a
 * placement that realizes `distinct` wherever an obligation is outstanding (what dedup placement decides), each fold's form
 * the compiler's own decision over that analysis (dedup/place.ts foldOf), and the delivery of a
 * whole program through the conservative scheduler, so each shape is exercised inside complete statements that pass
 * the structural audit.
 *
 * The dispatch honours the realization: a conservative plug-in's own set boundary, the SELECT DISTINCT of its
 * outermost query, is dropped for a node the placement realized `plain`, so a shape's input carries exactly the repeats
 * the physical analysis says it may. Every shape then has to discharge its own obligations, and an
 * unsound elision in a shape shows up as a repeated or overcounted row on PostgreSQL rather than being absorbed by a
 * DISTINCT the optimized lowering would not emit.
 */

/**
 * Duplicate-elimination placement in a simple sound form: realize `distinct` at the earliest input, in topological
 * order, of an outstanding obligation, or at the parent of an attachment, whose rows are its parent's, and analyze
 * again, until none is outstanding. One placement at a time, so a DISTINCT that discharges a later obligation too is
 * not repeated there.
 *
 * Under `shapes`, an obligation whose consumer is a shape that discharges its own input (a Take's bound, an
 * attachment's child, a heterogeneous union's delivered heading groups, share/physical.ts) is
 * left outstanding: its input stays realized plain and carries its repeats into the shape, which must then deduplicate
 * by itself unless the facts prove it need not.
 */
type Discharge = "placement" | "shapes"

const dischargedByShape = (edge: Obligation["edge"]): boolean => {
	if (edge.consumer.kind === "result") {
		return edge.input.kind === "Union" && edge.input.groups.length > 1
	}
	if (edge.consumer.role === "parent") {
		return false
	}
	const node = edge.consumer.node
	return node.kind === "Take" || node.kind === "Attach"
}

/**
 * The placement of a DAG over the ledger fixture, every shape test's schema, in a snapshot read under the ledger's own
 * catalog.
 */
const placed = (dag: RelDag, discharge: Discharge): PhysicalAnalysis => {
	const realization = new Map<NodeId, Realization>()
	const env = {
		context: "snapshot",
		catalog: ledgerCatalog,
		realization: unplaced,
		roots: "result"
	} as const
	let analysis = analyzePhysical(dag, env)
	const rowsOf = (node: RelNode): RelNode => (node.kind === "Attach" ? rowsOf(node.parent) : node)
	for (let i = 0; i < 64; i++) {
		const outstanding = Arr.filter(
			analysis.obligations,
			(o) => !o.discharged && !(discharge === "shapes" && dischargedByShape(o.edge))
		)
		if (outstanding.length === 0) {
			return analysis
		}
		const position = new Map(Arr.map(analysis.order, (node, index) => [node, index]))
		const inputs = Arr.map(outstanding, (o) => rowsOf(o.edge.input))
		const at = (node: RelNode) => defined(position.get(node), `the position of ${node.id}`)
		inputs.sort((a, b) => at(a) - at(b))
		const earliest = inputs[0]
		if (earliest === undefined) {
			throw new Error("an outstanding obligation has an input")
		}
		realization.set(earliest.id, "distinct")
		analysis = analyzePhysical(dag, { ...env, realization: (id) => realization.get(id) })
	}
	throw new Error("placement did not converge")
}

export interface Shaped {
	readonly facts: ShapeFacts
	readonly certificates: Array<Certificate>
	readonly analysis: PhysicalAnalysis
}

/** The facts of that placement. */
export const shapedFacts = (
	dag: RelDag,
	overrides: Partial<ShapeFacts>,
	discharge: Discharge
): Shaped => {
	const certificates: Array<Certificate> = []
	const analysis = placed(dag, discharge)
	const facts = {
		...shapeFactsFromPlan(
			{ analysis },
			{
				derivedDefinition: false,
				certify: (c) => {
					certificates.push(c)
				}
			}
		),
		...overrides
	}
	return { facts, certificates, analysis }
}

/**
 * The baseline facts: nothing is unique, every boundary is realized `distinct`, and no
 * certificate is kept. Shapes driven by them deduplicate at every set boundary, like the conservative lowering.
 */
export const conservativeShapeFacts = (overrides: Partial<ShapeFacts>): ShapeFacts => ({
	context: "snapshot",
	realization: () => "distinct",
	unique: () => false,
	keyedBy: () => false,
	maxCard: () => unbounded,
	childUniquePerParent: () => false,
	derivedDefinition: false,
	certify: () => {},
	...overrides
})

/**
 * The conservative plug-ins that lower a node as its input's query: an attachment as its parent, an ordered result as
 * its input, a law as its violation query (conservative/attach, ordered-result, forbid).
 */
const passThrough: ReadonlySet<RelNode["kind"]> = new Set(["Attach", "OrderedResult", "Forbid"])

/** A pass-through plug-in returns its input's query, whose boundary is the input's own to keep or drop. */
const shapeDispatch = (facts: ShapeFacts): NodeDispatch => {
	const take = takeLowerer(facts)
	const group = aggregateLowerer(facts)
	const union = unionLowerer(facts)
	const input = inputSetLowerer(facts)
	return (node: RelNode, cx, env) => {
		switch (node.kind) {
			case "Take":
				return take(node, cx, env)
			case "Group":
				return group(node, cx, env)
			case "Union":
				return union(node, cx, env)
			case "InputSet":
				return input(node, cx, env)
			case "AntiJoin":
			case "ApproximateNearest":
			case "Attach":
			case "Base":
			case "Closed":
			case "Context":
			case "Delta":
			case "Difference":
			case "Filter":
			case "Forbid":
			case "Intersect":
			case "MatchRegion":
			case "OrderedResult":
			case "OrderedSetAggregate":
			case "Produce":
			case "ProjectSet":
			case "Recursive":
			case "SelfRef":
			case "SemiJoin":
			case "Window": {
				const query = dispatchNode(node, cx, env)
				if (passThrough.has(node.kind) && facts.realization(node) === "plain") {
					return query
				}
				return facts.realization(node) === "plain"
					? withoutBoundary(query, "certified")
					: withBoundary(cx, node, query)
			}
		}
	}
}

/** What production passes to lower a query that declares no take bound parameter: no parameters. */
export const testOptions = (schema: string): ConservativeOptions => ({
	names: productionNames(schema, { kind: "declared" }, localVectorSchema, fixtureCodes),
	params: [],
	subject: { kind: "query" }
})

export const context = (
	dag: ValidDag,
	facts: ShapeFacts,
	options: ConservativeOptions
): LowerContext => new LowerContext(dag, options, shapeDispatch(facts))

/** A whole program delivered by the conservative scheduler over the shape dispatch. */
export const shapedProgram = (
	query: { readonly dag: ValidDag; readonly root: RelNode },
	facts: ShapeFacts,
	options: ConservativeOptions
): ConservativeProgram => {
	const cx = new LowerContext(query.dag, options, shapeDispatch(facts))
	return new Delivery(cx).program(query.root)
}
