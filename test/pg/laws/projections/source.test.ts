/**
 * Selected sources as partial projections: a selected side's foreign key from its STORED generated columns, and a key
 * over the same side, refused by PostgreSQL's own constraints, 23503 and 23505; generated schemas through grizzle and
 * through a direct SQL writer.
 *
 * For the direct writer, an UPDATE that moves a node into its selection or moves a selected node's parent is refused at
 * COMMIT, the self-referencing foreign key being on a cycle, only when the parent it then needs is missing, and an
 * UPDATE of a key commits only when nothing selected refers to it, which drawn transactions reach a few times a run.
 * All three are planted for a mutable schema whose node is selected when live: an unselected node whose parent is
 * missing made live, a live node's parent moved to a missing node, and an unselected node moved to another id, which
 * its own null generated column does not refer to. A selected key's refusal at its statement is planted in each
 * population, on the rota keyed over its approved shifts: a second approved shift of a sheet's week.
 */

import type { Kept } from "@grizzle/testing/explore"
import { Array as Arr, Option } from "effect"
import {
	employees,
	projectedSource,
	shifts,
	sourceShapes,
	weeks
} from "#test/pg/laws/projections/families.ts"
import { type Mode, variantsOf } from "#test/support/laws/boxes.ts"
import { type DirectCase, type DirectFeature, plantedUpdate } from "#test/support/laws/direct.ts"
import { directSuite, type Planted } from "#test/support/laws/suites/direct.ts"
import { casesPerTest, familySuite, noKeptCases } from "#test/support/laws/suites/family.ts"
import { type FamilyCase, type FamilyFeature, plantedInsert } from "#test/support/laws/support.ts"

/**
 * From the empty state, one stratum that deletes two desks, inserts one and puts a badge, on the mutable schema whose
 * unissued badges need their desk: the badge's put follows the desk's insertion and precedes its deletion by the
 * immediate key from the badges it selects into the desks, and a desk's facts meet nowhere, so its deletion may follow
 * its insertion (a30d00af) and the stratum is ordered by its keys, its outcome its add-wins state's. It was refused as
 * UnorderableStratum before that rule, a counterexample of the mutation tester's oracle, which died on the refusal
 * when the host modelled no stratum's order.
 */
const unorderableStratum: Kept<FamilyCase, FamilyFeature> = {
	note: "a desk deleted and inserted beside a badge's put, in one stratum",
	sketch: {
		variant: 0,
		steps: [
			[
				{
					arm: "write",
					relation: 63680,
					kind: "put",
					first: {
						mode: "drawn",
						values: [54771, 12600, 42985, 65535, 3494, 51650],
						index: 9049,
						link: 15014
					},
					rest: []
				},
				{
					arm: "write",
					relation: 44337,
					kind: "delete",
					first: {
						mode: "drawn",
						values: [14198, 5482, 1484, 16792, 58884, 27309],
						index: 65010,
						link: 40597
					},
					rest: [
						{
							mode: "sibling",
							values: [65481, 53447, 62720, 48144, 3489, 30084],
							index: 56529,
							link: 61208
						}
					]
				},
				{
					arm: "write",
					relation: 41331,
					kind: "insert",
					first: {
						mode: "drawn",
						values: [6188, 2790, 46267, 0, 20424, 47932],
						index: 42806,
						link: 3688
					},
					rest: []
				}
			]
		]
	},
	draws: "",
	reaches: ["op put", "op delete", "op insert"]
}

familySuite(projectedSource, casesPerTest, "the family", {
	immutable: [],
	mutable: [unorderableStratum]
})
familySuite(
	sourceShapes,
	casesPerTest,
	"every schema's refusals by every law but a key",
	noKeptCases
)

const domains = sourceShapes.domains

/** A second approved shift of a sheet's week that holds one, on the population's rota keyed over approved shifts. */
const secondShift = (mode: Mode): Kept<DirectCase, DirectFeature> => {
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
		draws: "",
		reaches: ["refused at a statement by a key"]
	}
}

const [p, variant] = Option.getOrThrowWith(
	Arr.findFirstWithIndex(
		variantsOf(sourceShapes, "mutable"),
		(shape) => shape.kind === "tree" && shape.live
	),
	() => new Error("no mutable schema whose node is selected when live")
)
const host = sourceShapes.host(p)
const node = (parent: number, live: boolean) =>
	plantedInsert(host, domains, "Node", { id: 1, parent, live })

const planted: Planted = {
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
			draws: "",
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
			draws: "",
			reaches: ["statement move of a referring fact", "refused at COMMIT"]
		},
		{
			note: "an unselected node, its own parent, moved to another id",
			sketch: {
				variant,
				initial: [[node(1, false)]],
				transactions: [{ members: [], updates: [plantedUpdate(host, domains, "Node", { id: 2 })] }]
			},
			draws: "",
			reaches: ["statement update key", "committed"]
		}
	]
}

directSuite(sourceShapes, casesPerTest, planted)
