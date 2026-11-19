import { array, boolean, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import {
	joinedOf,
	linksOf,
	rowsPerSpreadValue,
	type Second,
	secondsOf,
	type LinkWitness,
	type WorldCase,
	type WorldServingFeature
} from "#test/pg/physical/world-serving.ts"
import { knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import { installGen } from "#test/support/worlds/generate/install.ts"
import { docsBases } from "#test/support/worlds/model/bases/docs.ts"
import type { BaseSpec } from "#test/support/worlds/model/types.ts"

/** What a witness's link reads: an ordinary relation, a derived one, an ordinary one from a relation a declared key
 * reads, whose probe is the key's key probe, or any source joined to another that a second field of T links into
 * (world-serving.ts Second, `joined`). */
type Arm = "ordinary" | "derived" | "declared key" | "joined"

/**
 * The relations a declared key reads, each once: each holds a key besides its primary key, which an insert through it
 * probes (fin.md §6, "at most one").
 */
const atMostOne = (base: BaseSpec): ReadonlyArray<string> =>
	Arr.dedupe(Arr.flatMap(base.laws, (law) => (law.kind === "key" ? [law.relation] : [])))

/** A link of an arm: from a target, into a source, by a pair of their fields. */
interface ArmLink {
	readonly target: string
	readonly source: string
	readonly link: { readonly from: string; readonly to: string }
}

/**
 * The links an arm draws from in a base, and the seconds each admits: a joined arm's link its joined seconds alone
 * (joinedOf), any other's its second bindings (secondsOf) or none.
 */
const armLinks = (
	base: BaseSpec,
	arm: Arm
): ReadonlyArray<ArmLink & { readonly seconds: (negated: boolean) => ReadonlyArray<Second> }> => {
	const relations = Arr.map(base.relations, (r) => r.name)
	const derived = Arr.map(base.derived, (d) => d.name)
	const between = (targets: ReadonlyArray<string>, sources: ReadonlyArray<string>) =>
		Arr.flatMap(targets, (target) =>
			Arr.map(linksOf(base, target, sources), (l): ArmLink => ({ target, ...l }))
		)
	const drawn = (links: ReadonlyArray<ArmLink>) =>
		Arr.map(links, (l) => ({
			...l,
			seconds: (negated: boolean): ReadonlyArray<Second> => [
				{ kind: "none" },
				...secondsOf(base, l.target, l.source, l.link, negated)
			]
		}))
	switch (arm) {
		case "ordinary":
			return drawn(between(relations, relations))
		case "derived":
			return drawn(between(relations, derived))
		case "declared key":
			return drawn(between(atMostOne(base), relations))
		case "joined": {
			const sources = [...relations, ...derived]
			return Arr.flatMap(between(relations, sources), (l) => {
				const joined = joinedOf(base, l.target, sources, l.source, l.link)
				return joined.length > 0 ? [{ ...l, seconds: () => joined }] : []
			})
		}
	}
}

const arms: Arr.NonEmptyReadonlyArray<Arm> = ["ordinary", "derived", "declared key", "joined"]

/** The arms a base admits: those with a link to draw. */
const armsOf = (base: BaseSpec): ReadonlyArray<Arm> =>
	Arr.filter(arms, (arm) => armLinks(base, arm).length > 0)

/** A witness of `arm` over `base`: a link of the arm, matched or negated, and a second the link admits under it. */
const witnessGen =
	(base: BaseSpec, arm: Arm): Gen<LinkWitness> =>
	(source) => {
		const chosen = source.draw(
			element(knownNonEmpty(armLinks(base, arm), `the ${arm} links of ${base.name}`))
		)
		const negated = source.draw(boolean)
		const second: Second = source.draw(
			element(knownNonEmpty(chosen.seconds(negated), `the seconds of a ${arm} link`))
		)
		return { target: chosen.target, source: chosen.source, link: chosen.link, second, negated }
	}

/**
 * A case: its first witness's arm, then a documents base that admits it, the witness, perhaps a second of any arm the
 * base admits, and the roles the worlds model draws over the base.
 */
const worldGen: Gen<WorldCase> = (source) => {
	const arm = source.draw(element(arms))
	const base = source.draw(
		element(
			knownNonEmpty(
				Arr.filter(docsBases, (b) => armsOf(b).includes(arm)),
				`the documents bases admitting a ${arm} witness`
			)
		)
	)
	const first = source.draw(witnessGen(base, arm))
	const admitted = knownNonEmpty(armsOf(base), `the arms of ${base.name}`)
	const more = source.draw(
		array((inner) => inner.draw(witnessGen(base, inner.draw(element(admitted)))), {
			min: 0,
			max: 1
		})
	)
	return { install: source.draw(installGen(base)), witnesses: [first, ...more] }
}

/** A case: its world, and how many facts each relation of its base holds. */
interface PopulationCase {
	readonly world: WorldCase
	readonly rows: number
}

/**
 * The most facts a relation holds in a case, derived: the least population at which every spread field of the load
 * holds two values (world-serving.ts rowsPerSpreadValue), so a probe that binds one spread field and rechecks another
 * removes rows the judge reads. A larger population shows the judge nothing more: sequential and bitmap scans are
 * disabled, so a scan's structure is the same at any size, and a scan's buffers past its bound are no property here.
 */
const mostRows = 2 * rowsPerSpreadValue

/**
 * A case's population: half the cases at mostRows, where a recheck shows, and half at any size up to it, down to one
 * fact a relation. The weights are a search budget, never a claim: the size that shows a recheck is one point of the
 * range, which a uniform draw would reach once in mostRows cases.
 */
const rowsGen: Gen<number> = weighted([
	[1, constant(mostRows)],
	[1, int(1, mostRows)]
])

export const caseGen: Gen<PopulationCase> = (source) => ({
	world: source.draw(worldGen),
	rows: source.draw(rowsGen)
})

/** The situations every run reaches (see the header). */
export const requiredSituations: Arr.NonEmptyReadonlyArray<WorldServingFeature> = [
	"a filter function's probe that finds its fact",
	"a filter function's probe that finds none",
	"a filter function's probe of a derived relation",
	"a filter function's probe bound by its argument and a claim",
	"a filter function's probe bound by its argument and a joined source",
	"a key probe that reads its key's fact",
	"a key probe that finds no fact at its key",
	"a declared key's probe that reads its key's fact",
	"a declared key's probe that finds no fact at its key",
	"a policy row calling the filter function",
	"a read through a narrowed entry's view calling the filter function",
	"a precheck calling the filter function"
]
