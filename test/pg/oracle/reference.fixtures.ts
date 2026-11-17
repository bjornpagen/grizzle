import { element, type Steered, steered } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import type { DeliveredPart } from "#compiler/lower/shapes/index.ts"
import { type AttachedTree, mapTree, type StatementTree } from "#compiler/runtime/lower/tree.ts"
import { labeledStatements, type StructuralDifference } from "#test/support/oracle/compare.ts"
import { defaultGenConfig, type QueryCase } from "#test/support/oracle/gen/case.ts"
import { float4 } from "#test/support/oracle/gen/domain.ts"
import { defaultQueryConfig, queryGenerators } from "#test/support/oracle/gen/query.ts"
import { rootedCaseGen } from "#test/support/oracle/mutants/cases.ts"
import { reference, type SentProgram } from "#test/support/oracle/runner.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"

/** A fault a lowering may make in a program's structure, each planted in the conservative program. */
export type StructureFault =
	| "an attachment dropped"
	| "an attachment renamed"
	| "a column's type narrowed"

const structureFaults: readonly [StructureFault, ...ReadonlyArray<StructureFault>] = [
	"an attachment dropped",
	"an attachment renamed",
	"a column's type narrowed"
]

/** What a planted lowering delivers: the conservative program with one fault planted, or unchanged. */
export type PlantFeature = StructureFault | "no fault"

/** Every plant feature: no fault, then each fault. */
export const plantFeatures: readonly [PlantFeature, ...ReadonlyArray<PlantFeature>] = [
	"no fault",
	...structureFaults
]

/** The roots the structure cases draw: an attachment, each with its nested chain, over a generated body. */
const attachedRoot = queryGenerators({
	...defaultQueryConfig,
	roots: { plain: 0, attach: 1, hetero: 0 }
}).root

/** The name the planted lowering takes, the left side of every comparison. */
export const planted = "planted"

/** The program with the attached tree labelled `target` replaced by `replace` of it: none drops it. */
const editAttached = (
	program: SentProgram,
	target: string,
	replace: (tree: AttachedTree<DeliveredPart>) => ReadonlyArray<AttachedTree<DeliveredPart>>
): SentProgram => {
	const labels = Arr.map(labeledStatements(program.roots), (l) => l.label)
	let at = 0
	const attached = (
		tree: AttachedTree<DeliveredPart>
	): ReadonlyArray<AttachedTree<DeliveredPart>> => {
		const label = Arr.getUnsafe(labels, at++)
		const edited: AttachedTree<DeliveredPart> = {
			...tree,
			attachments: Arr.flatMap(tree.attachments, attached)
		}
		return label === target ? replace(edited) : [edited]
	}
	return {
		...program,
		roots: Arr.map(program.roots, (tree): StatementTree<DeliveredPart> => {
			at++
			return { ...tree, attachments: Arr.flatMap(tree.attachments, attached) }
		})
	}
}

/** A plant: the program the planted lowering delivers, and the structural differences the comparison must report. */
interface Plant {
	readonly program: SentProgram
	readonly expected: ReadonlyArray<StructuralDifference>
}

/** A plant and what it plants. */
export type Offered = readonly [PlantFeature, Plant]

/**
 * The plant of `fault` in `program`, its target picked by `pick` among those the program offers: an attachment for a
 * drop or a rename, a double precision column of a delivered heading for a narrowing; none where the program offers no
 * target.
 */
const plantIn = (
	program: SentProgram,
	fault: StructureFault,
	pick: number
): Option.Option<Plant> => {
	const labeled = labeledStatements(program.roots)
	const subtree = (label: string): ReadonlyArray<string> =>
		Arr.filter(
			Arr.map(labeled, (l) => l.label),
			(l) => l === label || Str.startsWith(`${label}/`)(l)
		)
	const attachments = Arr.filter(labeled, (l) => l.attach !== undefined)
	switch (fault) {
		case "an attachment dropped":
		case "an attachment renamed": {
			if (!Arr.isReadonlyArrayNonEmpty(attachments)) {
				return Option.none()
			}
			const target = Arr.getUnsafe(attachments, pickIndex(pick, attachments.length))
			const lost = Arr.map(subtree(target.label), (label): StructuralDifference => ({
				kind: "missing",
				side: planted,
				label
			}))
			if (fault === "an attachment dropped") {
				return Option.some({
					program: editAttached(program, target.label, () => []),
					expected: lost
				})
			}
			const renamedLabel = `${target.label}_renamed`
			if (Arr.some(labeled, (l) => l.label === renamedLabel)) {
				return Option.none()
			}
			return Option.some({
				program: editAttached(program, target.label, (tree) => [
					{ ...tree, attach: { ...tree.attach, name: `${tree.attach.name}_renamed` } }
				]),
				expected: [
					...lost,
					...Arr.map(subtree(target.label), (label): StructuralDifference => ({
						kind: "missing",
						side: reference.name,
						label: `${renamedLabel}${Str.slice(target.label.length)(label)}`
					}))
				]
			})
		}
		case "a column's type narrowed": {
			const columns = Arr.flatMap(labeled, (l, position) =>
				Arr.flatMap(l.statement.heading, (column: HeadingColumn) =>
					column.type.carrier === "float8" ? [{ position, label: l.label, column }] : []
				)
			)
			if (!Arr.isReadonlyArrayNonEmpty(columns)) {
				return Option.none()
			}
			const target = Arr.getUnsafe(columns, pickIndex(pick, columns.length))
			const narrowed = Arr.getUnsafe(labeled, target.position).statement
			return Option.some({
				program: {
					...program,
					roots: mapTree(program.roots, (s) =>
						s === narrowed
							? {
									...s,
									heading: Arr.map(s.heading, (h): HeadingColumn =>
										h === target.column ? { ...h, type: float4 } : h
									)
								}
							: s
					)
				},
				expected: [
					{
						kind: "type",
						label: target.label,
						column: target.column.name,
						left: float4,
						right: target.column.type
					}
				]
			})
		}
	}
}

/**
 * The plant of `fault` in `program`, `pick` choosing its target: the program unchanged, whose comparison reports no
 * difference, where the fault is none or the program offers it no target.
 */
export const plantOf = (program: SentProgram, fault: PlantFeature, pick: number): Offered => {
	const unchanged: Offered = ["no fault", { program, expected: [] }]
	return fault === "no fault"
		? unchanged
		: Option.match(plantIn(program, fault, pick), {
				onNone: () => unchanged,
				onSome: (plant) => [fault, plant]
			})
}

/** A structure case: a generated case, the fault its planted lowering plants, and the pick of the fault's target. */
interface StructureSketch {
	readonly case: QueryCase
	readonly pick: number
	readonly fault: PlantFeature
}

/**
 * The structure cases: a generated case with an attaching root, its target's pick, and the fault it plants, drawn among
 * the faults still pending where the case's turn is steered and some is, among every fault otherwise.
 */
export const structureSpace: Steered<StructureSketch, PlantFeature> = steered((steering) => {
	const pending = Arr.filter(plantFeatures, (fault) => Option.exists(steering, (p) => p.has(fault)))
	const faults = Arr.isReadonlyArrayNonEmpty(pending) ? pending : plantFeatures
	return (source) => ({
		case: source.draw(rootedCaseGen(attachedRoot, defaultGenConfig)),
		pick: source.draw(pickGen),
		fault: source.draw(element(faults))
	})
})
