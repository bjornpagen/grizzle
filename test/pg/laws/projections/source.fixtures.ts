/** What the properties of source.test.ts read: the cases it plants for its direct suite. */
import { Array as Arr, Option } from "effect"
import { employees, shifts, sourceShapes, weeks } from "#test/pg/laws/projections/families.ts"
import { type Mode, variantsOf } from "#test/support/laws/boxes.ts"
import { plantedUpdate } from "#test/support/laws/direct.ts"
import type { Planted, DirectPlant } from "#test/support/laws/suites/direct.ts"
import { plantedInsert } from "#test/support/laws/support.ts"

const domains = sourceShapes.domains

/** A second approved shift of a sheet's week that holds one, on the population's rota keyed over approved shifts. */
const secondShift = (mode: Mode): DirectPlant => {
	const [p, variant] = Option.getOrThrowWith(
		Arr.findFirstWithIndex(
			variantsOf(sourceShapes, mode),
			(shape) => shape.kind === "rota" && shape.keyed && shape.status === "approved"
		),
		() => new Error(`no ${mode} rota keyed over its approved shifts`)
	)
	const host = sourceShapes.host(p)
	const [employee] = employees
	const [week] = weeks
	const [first, second] = shifts
	const shift = (id: string) =>
		plantedInsert(host, domains, "Shift", { id, employee, week, status: "approved" })
	return {
		note: "a second approved shift of a sheet's week",
		sketch: {
			variant,
			initial: [
				[plantedInsert(host, domains, "Sheet", { employee, week, ceiling: 1 }), shift(first)]
			],
			transactions: [{ members: [shift(second)], updates: [] }]
		},
		reaches: ["refused at a statement by a key"]
	}
}

const [p, variant] = Object.freeze(
	Option.getOrThrowWith(
		Arr.findFirstWithIndex(
			variantsOf(sourceShapes, "mutable"),
			(shape) => shape.kind === "tree" && shape.live
		),
		() => new Error("no mutable schema whose node is selected when live")
	)
)
const host = sourceShapes.host(p)
const node = (parent: number, live: boolean) =>
	plantedInsert(host, domains, "Node", { id: 1, parent, live })

export const planted: Planted = {
	immutable: [secondShift("immutable")],
	mutable: [
		secondShift("mutable"),
		{
			note: "an unselected node whose parent is missing made live",
			sketch: {
				variant,
				initial: [[node(2, false)]],
				transactions: [
					{ members: [], updates: [plantedUpdate(host, domains, "Node", { live: true })] }
				]
			},
			reaches: ["statement selection of a referring fact", "refused at COMMIT"]
		},
		{
			note: "a live node, its own parent, moved to a missing parent",
			sketch: {
				variant,
				initial: [[node(1, true)]],
				transactions: [
					{ members: [], updates: [plantedUpdate(host, domains, "Node", { parent: 3 })] }
				]
			},
			reaches: ["statement move of a referring fact", "refused at COMMIT"]
		},
		{
			note: "an unselected node, its own parent, moved to another id",
			sketch: {
				variant,
				initial: [[node(1, false)]],
				transactions: [{ members: [], updates: [plantedUpdate(host, domains, "Node", { id: 2 })] }]
			},
			reaches: ["statement update key", "committed"]
		}
	]
}
