import { array, constant, element, type Gen, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Option, pipe, Record } from "effect"
import { type HostLaw, lawRelations, projection, violations } from "#test/support/laws/model.ts"
import { pool } from "#test/support/worlds/generate/domain.ts"
import type {
	BaseSpec,
	HostFact,
	HostSchema,
	HostState,
	RelationSpec
} from "#test/support/worlds/model/types.ts"

/** The most facts a relation draws: few, so a state stays small enough to read whole in a failure report. */
const factsPerRelation = 4

/** A relation's facts: each field its pool's value at a drawn index, so draws shrink toward the pools' first values. */
const factGen =
	(relation: RelationSpec): Gen<HostFact> =>
	(source) =>
		Record.fromEntries(
			Arr.map(relation.fields, (f) => [f.name, source.draw(element(pool(f.domain)))] as const)
		)

/** One fact per primary key, the first drawn kept. */
const keyed = (relation: RelationSpec, facts: ReadonlyArray<HostFact>): ReadonlyArray<HostFact> => {
	const seen = new Set<string>()
	return Arr.filter(facts, (f) => {
		const key = projection(f, relation.key)
		if (seen.has(key)) {
			return false
		}
		seen.add(key)
		return true
	})
}

/** How far a state is from lawful: each violated law, and each fact its witness names. */
const badness = (host: HostSchema, state: HostState): number =>
	Arr.reduce(violations(host, state), 0, (sum, v) => sum + 1 + v.violators.length)

/** A state without one fact, by relation and position. */
const without = (state: HostState, relation: string, index: number): HostState =>
	new Map(
		Arr.map([...state], ([name, facts]) => [
			name,
			name === relation ? Arr.remove(facts, index) : facts
		])
	)

/**
 * One step of the repair: the state without the fact whose removal leaves it least far from lawful, among the facts of
 * the relations the violated laws read, the latest drawn on a tie.
 */
const repairStep = (host: HostSchema, state: HostState, ids: ReadonlySet<string>): HostState => {
	const read = [
		...new Set(
			Arr.flatMap(
				Arr.filter(host.laws, (l: HostLaw) => ids.has(l.law)),
				(l: HostLaw) => lawRelations(l)
			)
		)
	]
	const candidates = Arr.flatMap(read, (relation) =>
		Arr.reverse(
			Arr.map([...(state.get(relation) ?? []).keys()], (i) => without(state, relation, i))
		)
	)
	const scored = Arr.map(candidates, (next) => ({ next, badness: badness(host, next) }))
	return pipe(
		Arr.reduce(
			scored,
			Option.none<{ readonly next: HostState; readonly badness: number }>(),
			(best, c) => (Option.isSome(best) && best.value.badness <= c.badness ? best : Option.some(c))
		),
		Option.map((best) => best.next),
		Option.getOrThrowWith(
			() => new Error(`the violated laws ${Arr.join([...ids], ", ")} read no fact to remove`)
		)
	)
}

/**
 * The lawful state a drawn one repairs to under the host law model: while any law is violated, the fact whose removal
 * leaves the state least far from lawful goes, among the facts of the relations the violated laws read, the latest
 * drawn on a tie. Every law holds of the empty state, so the repair ends, and a lawful state is returned unchanged.
 */
export const lawfulOf = (host: HostSchema, drawn: HostState): HostState => {
	let state = drawn
	for (;;) {
		const violated = violations(host, state)
		if (violated.length === 0) {
			return state
		}
		state = repairStep(host, state, new Set(Arr.map(violated, (v) => v.law)))
	}
}

/**
 * Fields of one relation that take their values from another relation's facts: a containment's source fields, each the
 * value of its target field. The target is drawn first where the references allow, so a world reading one relation
 * through another meets facts on both sides instead of the repair's leftovers.
 */
interface Reference {
	readonly fields: Arr.NonEmptyReadonlyArray<string>
	readonly target: string
	readonly targetFields: Arr.NonEmptyReadonlyArray<string>
}

/** The references of a base's laws: every unselected containment. */
const referencesOf = (base: BaseSpec): ReadonlyArray<readonly [string, Reference]> =>
	Arr.flatMap(base.laws, (law): ReadonlyArray<readonly [string, Reference]> => {
		switch (law.kind) {
			case "contained":
				return Record.isEmptyRecord(law.source.where) && Record.isEmptyRecord(law.target.where)
					? [
							[
								law.source.relation,
								{
									fields: law.source.fields,
									target: law.target.relation,
									targetFields: law.target.fields
								}
							]
						]
					: []
			case "key":
			case "spanKey":
			case "check":
			case "covered":
			case "alternatives":
				return []
		}
	})

/** The base's ordinary relations, each after the relations its references read where no cycle forbids it. */
const drawOrder = (
	base: BaseSpec,
	references: ReadonlyArray<readonly [string, Reference]>
): ReadonlyArray<RelationSpec> => {
	const placed = new Set<string>()
	const order: Array<RelationSpec> = []
	const visit = (relation: RelationSpec, path: ReadonlySet<string>): void => {
		if (placed.has(relation.name) || path.has(relation.name)) {
			return
		}
		const inner = new Set([...path, relation.name])
		for (const [source, reference] of references) {
			const target = Option.getOrUndefined(
				Arr.findFirst(base.relations, (r) => r.name === reference.target)
			)
			if (source === relation.name && target !== undefined) {
				visit(target, inner)
			}
		}
		placed.add(relation.name)
		order.push(relation)
	}
	for (const relation of base.relations) {
		visit(relation, new Set())
	}
	return order
}

/** Whether a drawn fact follows a reference of its relation: seven times in eight. */
const follows: Gen<boolean> = weighted([
	[7, constant(true)],
	[1, constant(false)]
])

/**
 * A relation's fact: from the domain pools, each of its references followed seven times in eight to a fact drawn among
 * the target's facts drawn so far, or its own values kept.
 */
const draftGen =
	(
		relation: RelationSpec,
		references: ReadonlyArray<Reference>,
		facts: ReadonlyMap<string, ReadonlyArray<HostFact>>
	): Gen<HostFact> =>
	(source) =>
		Arr.reduce(references, source.draw(factGen(relation)), (fact: HostFact, reference) => {
			const following = source.draw(follows)
			const [first, ...rest] = facts.get(reference.target) ?? []
			if (!following || first === undefined) {
				return fact
			}
			const target = source.draw(element([first, ...rest]))
			const taken = Record.fromEntries(
				Arr.flatMap(reference.fields, (field, j) => {
					const at = reference.targetFields[j]
					const value = at === undefined ? undefined : target[at]
					return value === undefined ? [] : [[field, value] as const]
				})
			)
			return { ...fact, ...taken }
		})

/**
 * The lawful realities of a base: each ordinary relation the host schema holds draws up to a few facts from the domain
 * pools (few subjects, few organizations, small integers, uuids as distinct tokens, serials as distinct values with
 * gaps), seven times in eight taking each referenced field set from a fact of the relation it references (a
 * containment's target, drawn first where no cycle forbids it, with a fact at least), one fact per primary key, and
 * the whole repaired to lawful by the host law model. A
 * relation of the host schema the base does not hold as an ordinary relation (a derived one) has no stored facts.
 */
export const realityGen = (base: BaseSpec, host: HostSchema): Gen<HostState> => {
	const references = referencesOf(base)
	const order = drawOrder(base, references)
	const referencing = (relation: string): ReadonlyArray<Reference> =>
		Arr.flatMap(references, ([source, reference]) => (source === relation ? [reference] : []))
	return (source) => {
		const facts = new Map<string, ReadonlyArray<HostFact>>()
		for (const relation of order) {
			const referenced = Arr.some(references, ([, reference]) => reference.target === relation.name)
			const drafted = source.draw(
				array(draftGen(relation, referencing(relation.name), facts), {
					min: referenced ? 1 : 0,
					max: factsPerRelation
				})
			)
			facts.set(relation.name, keyed(relation, drafted))
		}
		return lawfulOf(
			host,
			new Map(Arr.map(host.relations, (h) => [h.name, facts.get(h.name) ?? []] as const))
		)
	}
}
