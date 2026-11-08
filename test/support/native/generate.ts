import {
	boolean,
	element,
	type Gen,
	int,
	nondecreasing,
	shuffled,
	subset,
	weighted
} from "@grizzle/testing/gen"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { CompareOp } from "#compiler/ir/desc.ts"
import { nonEmpty } from "#test/support/assert.ts"
import type { FamilyRow, Stored } from "#test/support/families/theorem.ts"
import {
	type Law,
	lawsOf,
	MIRROR,
	type Phi,
	phiFields,
	phiHolds,
	type Row,
	RULE_KINDS,
	spanLawsOf,
	type SpanRule,
	type SpanRuleKind,
	type Value,
	type Rule,
	type RuleKind,
	type State
} from "#test/support/native/schemas.ts"

/**
 * The states and schemas the native-model suite draws. A box enumerates every state of a rule's small space; an
 * exploration draws schemas of several rules and selections from the whole predicate language, and builds each state
 * by construction toward its laws, every way of breaking one a named, weighted variant a swarm turns on and off.
 */

/** The value a box gives a field it does not vary. */
const FIXED: Readonly<Record<string, Row>> = {
	Owner: { id: 0, rank: 0, live: true, slots: 0 },
	Item: { id: 0, owner: 0, code: 0, live: true, at: 0 },
	Profile: { owner: 0 },
	Seat: { owner: 0 },
	Visit: { id: 0, owner: 0, during: { start: 0, end: 2 }, live: true },
	Shift: { id: 0, owner: 0, during: { start: 0, end: 2 }, live: true }
}

/**
 * The spans a box draws: two adjacent halves, which overlap nothing but meet, and the whole they cover together, which
 * overlaps both.
 */
const SPANS: NonEmptyReadonlyArray<Value> = [
	{ start: 0, end: 2 },
	{ start: 2, end: 4 },
	{ start: 0, end: 4 }
]

/** The values a box gives each field it varies. */
const VALUES: Readonly<Record<string, Readonly<Record<string, NonEmptyReadonlyArray<Value>>>>> = {
	Owner: { id: [0, 1], rank: [0, 1], live: [true, false], slots: [0, 1] },
	Item: { owner: [0, 1], code: [0, 1], live: [true, false], at: [0, 1, 2] },
	Profile: { owner: [0, 1] },
	Seat: { owner: [0, 1] },
	Visit: { owner: [0, 1], during: SPANS, live: [true, false] },
	Shift: { owner: [0, 1], during: SPANS, live: [true, false] }
}

/** The natural fields' box reaches below zero, where the contract refuses and pred is undefined. */
const NATURAL_VALUES: Readonly<
	Record<string, Readonly<Record<string, NonEmptyReadonlyArray<Value>>>>
> = { Owner: { slots: [-1, 0] }, Item: { at: [-1, 0, 1] } }

/** How many rows a box holds of each relation: at most two owners and three of every other relation. */
const ROWS: Readonly<Record<string, number>> = {
	Owner: 2,
	Item: 3,
	Profile: 2,
	Seat: 2,
	Visit: 2,
	Shift: 2
}

/** The relations whose ids a box gives its rows by their positions: every one keyed by an id it does not vary. */
const POSITIONAL: ReadonlySet<string> = new Set(["Item", "Visit", "Shift"])

/** A relation's box: the fields it varies with their values, and how many rows it holds. */
interface RelationBox {
	readonly relation: string
	readonly varies: ReadonlyArray<readonly [field: string, values: NonEmptyReadonlyArray<Value>]>
	readonly rows: number
}

/** The fields a rule's sides and checks read, by relation. */
const readsOf = (laws: ReadonlyArray<Law>): ReadonlyMap<string, ReadonlySet<string>> => {
	const reads = new Map<string, Set<string>>()
	const add = (relation: string, fields: ReadonlyArray<string>) => {
		const of = reads.get(relation) ?? new Set<string>()
		for (const field of fields) {
			of.add(field)
		}
		reads.set(relation, of)
	}
	for (const law of laws) {
		switch (law.kind) {
			case "key":
			case "contained":
			case "mirrors":
				for (const side of law.kind === "key" ? [law.side] : [law.left, law.right]) {
					add(side.relation, [
						...Arr.map(side.terms, (t) => t.field),
						...Option.match(side.where, { onNone: () => [], onSome: phiFields })
					])
				}
				break
			case "check":
				add(law.relation, phiFields(law.phi))
				break
		}
	}
	return reads
}

/**
 * A rule's box: each relation its laws read, varying exactly the fields they read (an Owner its id besides), every
 * other field fixed; the natural-fields rule varies each natural field below zero, and mirrors over Item's ids lets a
 * Profile name any of the three.
 */
const boxOf = (r: Rule): ReadonlyArray<RelationBox> => {
	const reads =
		r.rule === "natural fields"
			? new Map([
					["Owner", new Set(["slots"])],
					["Item", new Set(["at"])]
				])
			: readsOf(lawsOf(r))
	const selectedIds = r.rule === "mirrors over a selected side"
	return Arr.map([...reads], ([relation, fields]): RelationBox => {
		const domain =
			r.rule === "natural fields" ? (NATURAL_VALUES[relation] ?? {}) : (VALUES[relation] ?? {})
		const varied = relation === "Owner" ? new Set([...fields, "id"]) : fields
		return {
			relation,
			varies: Arr.flatMap([...varied], (field) => {
				const values = selectedIds && relation === "Profile" ? [0, 1, 2] : domain[field]
				return values === undefined || (field === "id" && POSITIONAL.has(relation))
					? []
					: [[field, nonEmpty([...values])] as const]
			}),
			rows: selectedIds && relation === "Profile" ? 3 : (ROWS[relation] ?? 0)
		}
	})
}

/** Every row a box's relation may hold, each varied field at each of its values, every other at its fixed value. */
const universeOf = (box: RelationBox): ReadonlyArray<Row> =>
	Arr.reduce(box.varies, [FIXED[box.relation] ?? {}], (rows, [field, values]) =>
		Arr.flatMap(rows, (row) => Arr.map(values, (v): Row => ({ ...row, [field]: v })))
	)

/**
 * A box's rows of one relation. A positional relation's ids are its rows' positions, so its states are the multisets of
 * its varied fields, and its last row may repeat the first's id, the primary key's breach; every other relation's
 * states are the sets of its universe's rows, an Owner's primary key breached by two rows of one id.
 */
const boxRowsGen = (box: RelationBox): Gen<ReadonlyArray<Row>> => {
	const universe = universeOf(box)
	if (!POSITIONAL.has(box.relation)) {
		return subset(universe, { min: 0, max: box.rows })
	}
	return (source) => {
		const at = source.draw(nondecreasing(0, universe.length - 1, { min: 0, max: box.rows }))
		const repeated = at.length >= 2 && source.draw(boolean)
		return Arr.map(at, (u, i): Row => ({
			...universe[u],
			id: repeated && i === at.length - 1 ? 0 : i
		}))
	}
}

const boxStateGen =
	(boxes: ReadonlyArray<RelationBox>): Gen<State> =>
	(source) =>
		Rec.fromEntries(Arr.map(boxes, (box) => [box.relation, source.draw(boxRowsGen(box))]))

const live: Phi = { kind: "is", field: "live", value: true }
const coded: Phi = { kind: "compare", op: "gt", field: "code", value: 0 }
const ranked: Phi = { kind: "compare", op: "gt", field: "rank", value: 0 }
const uncoded: Phi = { kind: "compare", op: "eq", field: "code", value: 0 }
/** An owner whose rank is its own id: a target selection that fixes rank to the target's term id. */
const rankedById: Phi = { kind: "fields", op: "eq", left: "id", right: "rank" }

/**
 * Each rule with the selections the box draws it with: a boolean field, comparisons, connectives, BETWEEN and IN, a
 * target fixed beyond its terms to a value, to its own id, or to both.
 */
const BOX_RULES: NonEmptyReadonlyArray<Rule> = [
	{ rule: "a key over fields" },
	...Arr.map(
		[
			live,
			coded,
			{ kind: "and", left: live, right: coded },
			{ kind: "or", left: live, right: uncoded },
			{ kind: "not", arg: { kind: "compare", op: "eq", field: "code", value: 1 } }
		] satisfies ReadonlyArray<Phi>,
		(phi): Rule => ({ rule: "a key over a selected side", phi })
	),
	{ rule: "a key over a pred term" },
	...Arr.map(
		[
			live,
			{ kind: "compare", op: "ge", field: "at", value: 2 },
			{ kind: "in", field: "at", values: [0, 2] }
		] satisfies ReadonlyArray<Phi>,
		(phi): Rule => ({ rule: "a key over a selected pred term", phi })
	),
	{ rule: "a containment" },
	{ rule: "a containment into a superkey" },
	...Arr.map(
		[
			live,
			coded,
			{ kind: "fields", op: "lt", left: "code", right: "owner" }
		] satisfies ReadonlyArray<Phi>,
		(phi): Rule => ({ rule: "a containment from a selected side", phi })
	),
	...Arr.map(
		[
			live,
			ranked,
			{ kind: "or", left: live, right: ranked },
			{ kind: "and", left: { kind: "compare", op: "eq", field: "rank", value: 1 }, right: live },
			{ kind: "and", left: live, right: ranked },
			{ kind: "compare", op: "eq", field: "id", value: 1 },
			{ kind: "compare", op: "eq", field: "rank", value: 0 },
			{ kind: "compare", op: "eq", field: "rank", value: 1 },
			rankedById
		] satisfies ReadonlyArray<Phi>,
		(psi): Rule => ({ rule: "a containment into a selected side", psi })
	),
	...Arr.map(
		[
			live,
			ranked,
			{ kind: "and", left: live, right: rankedById },
			{ kind: "and", left: { kind: "is", field: "live", value: false }, right: rankedById }
		] satisfies ReadonlyArray<Phi>,
		(psi): Rule => ({
			rule: "a containment between selected sides",
			phi: live,
			psi
		})
	),
	{ rule: "a closure under pred" },
	...Arr.map(
		[live, { kind: "between", field: "at", low: 0, high: 1 }] satisfies ReadonlyArray<Phi>,
		(phi): Rule => ({ rule: "a closure under pred over a selected side", phi })
	),
	{ rule: "a cycle" },
	{ rule: "mirrors over whole relations" },
	...Arr.map([live, coded] satisfies ReadonlyArray<Phi>, (phi): Rule => ({
		rule: "mirrors over a selected side",
		phi
	})),
	...Arr.map(
		[
			coded,
			{ kind: "or", left: live, right: uncoded },
			{ kind: "between", field: "at", low: 0, high: 1 }
		] satisfies ReadonlyArray<Phi>,
		(phi): Rule => ({ rule: "a row check", phi })
	),
	{ rule: "natural fields" }
]

/** A box case: one rule, with its selections, and one state of its box. */
export interface BoxCase {
	readonly rule: Rule
	readonly state: State
}

export const boxGen: Gen<BoxCase> = (source) => {
	const rule = source.draw(element(BOX_RULES))
	return { rule, state: source.draw(boxStateGen(boxOf(rule))) }
}

/** A span box case: one span rule, with its selection, and one state of its box. */
export interface SpanBoxCase {
	readonly rule: SpanRule
	readonly state: State
}

/** Each span rule with its selection, a boolean field. */
const SPAN_BOX_RULES: NonEmptyReadonlyArray<SpanRule> = [
	{ rule: "a span key" },
	{ rule: "a span key over a selected side", phi: live },
	{ rule: "a coverage" },
	{ rule: "a coverage from a selected side", phi: live },
	{ rule: "a coverage into a selected side", phi: live }
]

/** The span box of `laws`: each relation they read, varying exactly the fields they read over the box's values. */
const spanBoxesOf = (laws: ReadonlyArray<Law>): ReadonlyArray<RelationBox> =>
	Arr.map([...readsOf(laws)], ([relation, fields]): RelationBox => ({
		relation,
		varies: Arr.flatMap([...fields], (field) => {
			const values = VALUES[relation]?.[field]
			return values === undefined ? [] : [[field, values] as const]
		}),
		rows: ROWS[relation] ?? 0
	}))

/**
 * Every state of a span rule's box: at most two rows of Visit and of Shift, each varying the fields its laws read,
 * owner over two values and the span over two adjacent halves and their whole.
 */
export const spanBoxGen: Gen<SpanBoxCase> = (source) => {
	const rule = source.draw(element(SPAN_BOX_RULES))
	return { rule, state: source.draw(boxStateGen(spanBoxesOf(spanLawsOf(rule)))) }
}

/** The comparisons a selection draws, the simplest first. */
const OPS: NonEmptyReadonlyArray<CompareOp> = ["eq", "ne", "lt", "le", "gt", "ge"]

/** What a selection over one relation may read: its integer and natural fields, its booleans, and its int pairs. */
interface Readable {
	readonly numbers: NonEmptyReadonlyArray<string>
	readonly booleans: NonEmptyReadonlyArray<string>
	readonly pairs: NonEmptyReadonlyArray<readonly [string, string]>
}

const ITEM: Readable = {
	numbers: ["code", "at", "owner", "id"],
	booleans: ["live"],
	pairs: [
		["code", "owner"],
		["id", "owner"],
		["id", "code"]
	]
}

const OWNER: Readable = {
	numbers: ["rank", "slots", "id"],
	booleans: ["live"],
	pairs: [["id", "rank"]]
}

/**
 * The literals a selection compares a field with: the values the states draw, and one past each end, never below zero
 * for a natural field, whose contract a literal compared with it must satisfy.
 */
const literalOf = (field: string): Gen<number> => (NATURALS.has(field) ? int(0, 3) : int(-1, 3))

/** The literals an IN list draws from, by the same rule. */
const listOf = (field: string): ReadonlyArray<number> =>
	NATURALS.has(field) ? [0, 1, 2] : [-1, 0, 1, 2]

/** The natural fields a selection may read. */
const NATURALS: ReadonlySet<string> = new Set(["at", "slots"])

const atomGen =
	(r: Readable): Gen<Phi> =>
	(source) =>
		source.draw(
			weighted<Phi>([
				[
					4,
					(s) => {
						const field = s.draw(element(r.numbers))
						return {
							kind: "compare",
							op: s.draw(element(OPS)),
							field,
							value: s.draw(literalOf(field))
						}
					}
				],
				[
					1,
					(s) => {
						const field = s.draw(element(r.numbers))
						return {
							kind: "literalFirst",
							op: s.draw(element(OPS)),
							value: s.draw(literalOf(field)),
							field
						}
					}
				],
				[3, (s) => ({ kind: "is", field: s.draw(element(r.booleans)), value: s.draw(boolean) })],
				[
					2,
					(s) => {
						const [left, right] = s.draw(element(r.pairs))
						return { kind: "fields", op: s.draw(element(OPS)), left, right }
					}
				],
				[
					1,
					(s) => {
						const field = s.draw(element(r.numbers))
						return {
							kind: "between",
							field,
							low: s.draw(literalOf(field)),
							high: s.draw(literalOf(field))
						}
					}
				],
				[
					1,
					(s) => {
						const field = s.draw(element(r.numbers))
						return {
							kind: "in",
							field,
							values: nonEmpty([...s.draw(shuffled(listOf(field), { min: 1, max: 2 }))])
						}
					}
				]
			])
		)

/** A selection over one relation's fields, its connectives at most `depth` deep. */
const phiGen = (r: Readable, depth: number): Gen<Phi> => {
	const atom = atomGen(r)
	if (depth === 0) {
		return atom
	}
	const inner = phiGen(r, depth - 1)
	return weighted<Phi>([
		[4, atom],
		[2, (s) => ({ kind: "and", left: s.draw(inner), right: s.draw(inner) })],
		[2, (s) => ({ kind: "or", left: s.draw(inner), right: s.draw(inner) })],
		[1, (s) => ({ kind: "not", arg: s.draw(inner) })]
	])
}

/** How deep a drawn selection's connectives nest. */
const PHI_DEPTH = 2

const itemPhi = phiGen(ITEM, PHI_DEPTH)
const ownerPhi = phiGen(OWNER, PHI_DEPTH)

/** A rule of a kind, its selections drawn over the whole predicate language. */
const ruleGen =
	(kind: RuleKind): Gen<Rule> =>
	(source) => {
		switch (kind) {
			case "a key over a selected side":
			case "a key over a selected pred term":
			case "a containment from a selected side":
			case "a closure under pred over a selected side":
			case "mirrors over a selected side":
			case "a row check":
				return { rule: kind, phi: source.draw(itemPhi) }
			case "a containment into a selected side":
				return { rule: kind, psi: source.draw(ownerPhi) }
			case "a containment between selected sides":
				return { rule: kind, phi: source.draw(itemPhi), psi: source.draw(ownerPhi) }
			case "a key over fields":
			case "a key over a pred term":
			case "a containment":
			case "a containment into a superkey":
			case "a closure under pred":
			case "a cycle":
			case "mirrors over whole relations":
			case "natural fields":
				return { rule: kind }
		}
	}

/** How many rules a drawn schema combines. */
const RULES: Readonly<{ min: number; max: number }> = { min: 1, max: 3 }

/** A schema of one to three rules of distinct kinds, the kinds a swarm weights per case. */
const rulesGen: Gen<ReadonlyArray<Rule>> = (source) => {
	const on = source.draw(swarm(RULE_KINDS))
	const count = source.draw(int(RULES.min, RULES.max))
	const kinds = new Set<RuleKind>()
	for (let i = 0; i < count; i++) {
		kinds.add(source.draw(swarmChoice(on, RULE_KINDS)))
	}
	return Arr.map([...kinds], (kind) => source.draw(ruleGen(kind)))
}

/** The ways an explored state breaks a law, each a named variant its swarm turns on, at its weight, or off. */
export const VARIANTS = [
	"a repeated key",
	"an orphan reference",
	"an unmatched mirror",
	"a negative natural",
	"an index out of order"
] as const

export type Variant = (typeof VARIANTS)[number]

/** An explored state, and the variants its swarm drew. */
export interface Explored {
	readonly rules: ReadonlyArray<Rule>
	readonly variants: Swarm<Variant>
	/** The variants that broke the construction somewhere in the state. */
	readonly applied: ReadonlyArray<Variant>
	readonly state: State
}

/** An id no drawn row holds: what an orphan reference or an unmatched mirror names. */
const STRAY = 9

/** The most rows an explored state holds of each relation. */
const OWNERS = 3
const ITEMS = 4

/** The targets a schema's references into Owner select, which a well-referenced Item's owner satisfies. */
const ownerSelections = (rules: ReadonlyArray<Rule>): ReadonlyArray<Phi> =>
	Arr.flatMap(rules, (r) =>
		r.rule === "a containment into a selected side" ||
		r.rule === "a containment between selected sides"
			? [r.psi]
			: []
	)

/** The Item selections a mirrors over Item's ids reads. */
const mirroredItems = (rules: ReadonlyArray<Rule>): ReadonlyArray<Phi> =>
	Arr.flatMap(rules, (r) => (r.rule === "mirrors over a selected side" ? [r.phi] : []))

/**
 * A state built toward a schema's laws: Owners of distinct ids; Items each referencing an Owner, one its targets select
 * when it has one, copying its rank as its code (the superkey's pair), and indexed in its Owner's order (the closure);
 * Profiles naming the ids a mirrors pairs them with, and Seats naming the Profiles. Each variant the swarm turns on
 * breaks that construction where it is drawn: a key repeated, a reference to a stray id, a stray Profile or Seat, a
 * natural below zero, and an index drawn out of its order.
 */
const exploredOver =
	(rules: ReadonlyArray<Rule>): Gen<Explored> =>
	(source) => {
		const variants = source.draw(swarm(VARIANTS))
		const applied = new Set<Variant>()
		const breaks = (variant: Variant) => {
			const broken = source.draw(keep(variants, variant))
			if (broken) {
				applied.add(variant)
			}
			return broken
		}
		const natural = () => (breaks("a negative natural") ? -1 : source.draw(int(0, 2)))
		const ownerIds = source.draw(shuffled([0, 1, 2, 3], { min: 0, max: OWNERS }))
		const owners = Arr.map(ownerIds, (id, i): Row => ({
			id: i > 0 && breaks("a repeated key") ? (ownerIds[0] ?? id) : id,
			rank: source.draw(int(-1, 2)),
			live: source.draw(boolean),
			slots: natural()
		}))
		const targets = ownerSelections(rules)
		const items: Array<Row> = []
		const count = source.draw(int(0, ITEMS))
		for (let i = 0; i < count; i++) {
			const selected = Arr.filter(owners, (o) => Arr.every(targets, (psi) => phiHolds(psi, o)))
			const pool = selected.length > 0 && source.draw(boolean) ? selected : owners
			const target =
				pool.length > 0 && !breaks("an orphan reference")
					? Option.some(source.draw(element(nonEmpty(pool))))
					: Option.none<Row>()
			const owner = Option.match(target, { onNone: () => STRAY, onSome: (o) => Number(o["id"]) })
			const rank = Option.flatMap(target, (o) => Option.fromNullishOr(o["rank"]))
			const indexed = Arr.filter(items, (it) => it["owner"] === owner).length
			items.push({
				id: i > 0 && breaks("a repeated key") ? 0 : i,
				owner,
				code:
					Option.isSome(rank) && source.draw(boolean)
						? Number(rank.value)
						: source.draw(int(-1, 2)),
				live: source.draw(boolean),
				at: breaks("a negative natural")
					? -1
					: breaks("an index out of order")
						? source.draw(int(0, 3))
						: indexed
			})
		}
		const mirrored = mirroredItems(rules)
		const named = Arr.dedupe([
			...(source.draw(boolean) ? Arr.map(owners, (o) => Number(o["id"])) : []),
			...Arr.flatMap(items, (it) =>
				Arr.every(mirrored, (phi) => phiHolds(phi, it)) && mirrored.length > 0
					? [Number(it["id"])]
					: []
			)
		])
		const profiles = [
			...source.draw(subset(named, { min: Math.max(0, named.length - 1), max: named.length })),
			...(breaks("an unmatched mirror") ? [STRAY] : [])
		]
		const seats = [
			...source.draw(
				subset(profiles, { min: Math.max(0, profiles.length - 1), max: profiles.length })
			),
			...(breaks("an unmatched mirror") ? [STRAY - 1] : [])
		]
		return {
			rules,
			variants,
			applied: [...applied],
			state: {
				Owner: owners,
				Item: items,
				Profile: Arr.map(Arr.dedupe(profiles), (owner): Row => ({ owner })),
				Seat: Arr.map(Arr.dedupe(seats), (owner): Row => ({ owner }))
			}
		}
	}

/** A schema of drawn rules, and a state built toward its laws (exploredOver). */
export const exploredGen: Gen<Explored> = (source) =>
	source.draw(exploredOver(source.draw(rulesGen)))

/**
 * A selection restated without changing what it means: each comparison written the other way round under its mirror
 * operator, a literal first where it stood second and second where it stood first; each IN list reversed, its first
 * value repeated; and each conjunction's and disjunction's operands swapped.
 */
const restated = (phi: Phi): Phi => {
	switch (phi.kind) {
		case "compare":
			return { kind: "literalFirst", op: MIRROR[phi.op], value: phi.value, field: phi.field }
		case "literalFirst":
			return { kind: "compare", op: MIRROR[phi.op], field: phi.field, value: phi.value }
		case "fields":
			return { kind: "fields", op: MIRROR[phi.op], left: phi.right, right: phi.left }
		case "in":
			return {
				kind: "in",
				field: phi.field,
				values: Arr.append(Arr.reverse(phi.values), Arr.headNonEmpty(phi.values))
			}
		case "is":
		case "between":
			return phi
		case "and":
		case "or":
			return { kind: phi.kind, left: restated(phi.right), right: restated(phi.left) }
		case "not":
			return { kind: "not", arg: restated(phi.arg) }
	}
}

/** A rule with each of its selections restated (`restated`). */
const restatedRule = (r: Rule): Rule => {
	switch (r.rule) {
		case "a key over a selected side":
		case "a key over a selected pred term":
		case "a containment from a selected side":
		case "a closure under pred over a selected side":
		case "mirrors over a selected side":
		case "a row check":
			return { rule: r.rule, phi: restated(r.phi) }
		case "a containment into a selected side":
			return { rule: r.rule, psi: restated(r.psi) }
		case "a containment between selected sides":
			return { rule: r.rule, phi: restated(r.phi), psi: restated(r.psi) }
		case "a key over fields":
		case "a key over a pred term":
		case "a containment":
		case "a containment into a superkey":
		case "a closure under pred":
		case "a cycle":
		case "mirrors over whole relations":
		case "natural fields":
			return r
	}
}

/** A span rule with its selection restated (`restated`). */
const restatedSpanRule = (r: SpanRule): SpanRule => {
	switch (r.rule) {
		case "a span key over a selected side":
		case "a coverage from a selected side":
		case "a coverage into a selected side":
			return { rule: r.rule, phi: restated(r.phi) }
		case "a span key":
		case "a coverage":
			return r
	}
}

/** The rules over the four relations whose laws read a selected side of one relation, each a kind a pair is of. */
const ITEM_PAIRS = [
	"a key over a selected side",
	"a key over a selected pred term",
	"a containment from a selected side",
	"a containment into a selected side",
	"a containment between selected sides",
	"a closure under pred over a selected side",
	"mirrors over a selected side"
] as const satisfies NonEmptyReadonlyArray<RuleKind>

/** The span rules whose laws read a selected side of one relation. */
const SPAN_PAIRS = [
	"a span key over a selected side",
	"a coverage from a selected side",
	"a coverage into a selected side"
] as const satisfies NonEmptyReadonlyArray<SpanRuleKind>

/** Every kind of rule a pair states twice over selections of one relation. */
export const PAIR_KINDS = [...ITEM_PAIRS, ...SPAN_PAIRS] as const

export type PairKind = (typeof PAIR_KINDS)[number]

/** How a pair's second rule is stated: drawn apart from the first, or the first restated (`restated`). */
type Stated = "apart" | "restated"

const STATED: NonEmptyReadonlyArray<Stated> = ["apart", "restated"]

/**
 * Two rules of one kind over selections of one relation, and a state of their schema: over the four relations, its
 * state built toward both rules' laws as an explored state is; over visits and shifts, a state of both rules' span box.
 */
export type Pair = {
	readonly kind: PairKind
	readonly stated: Stated
	readonly state: State
} & (
	| { readonly on: "items"; readonly first: Rule; readonly second: Rule }
	| { readonly on: "spans"; readonly first: SpanRule; readonly second: SpanRule }
)

/** The fields a selection over visits or shifts reads: each holds an id, an owner and whether it is live. */
const SPAN: Readable = { numbers: ["owner", "id"], booleans: ["live"], pairs: [["id", "owner"]] }

const spanPhi = phiGen(SPAN, PHI_DEPTH)

const itemPairGen: Gen<Pair> = (source) => {
	const kind = source.draw(element(ITEM_PAIRS))
	const stated = source.draw(element(STATED))
	const first = source.draw(ruleGen(kind))
	const second = stated === "apart" ? source.draw(ruleGen(kind)) : restatedRule(first)
	const { state } = source.draw(exploredOver([first, second]))
	return { kind, stated, state, on: "items", first, second }
}

const spanPairGen: Gen<Pair> = (source) => {
	const kind = source.draw(element(SPAN_PAIRS))
	const stated = source.draw(element(STATED))
	const first: SpanRule = { rule: kind, phi: source.draw(spanPhi) }
	const second: SpanRule =
		stated === "apart" ? { rule: kind, phi: source.draw(spanPhi) } : restatedSpanRule(first)
	const state = source.draw(boxStateGen(spanBoxesOf([...spanLawsOf(first), ...spanLawsOf(second)])))
	return { kind, stated, state, on: "spans", first, second }
}

/** A pair of either family, in proportion to their kinds. */
export const pairGen: Gen<Pair> = weighted<Pair>([
	[ITEM_PAIRS.length, itemPairGen],
	[SPAN_PAIRS.length, spanPairGen]
])

/** A fin box's owner: none, or one of a count. */
type FinOwner = { readonly kind: "absent" } | { readonly kind: "counted"; readonly count: number }

/** How many of an owner's first slots a fin box holds rows at. */
const FIN_SLOTS = 4

const FIN_OWNERS: NonEmptyReadonlyArray<FinOwner> = [
	{ kind: "absent" },
	...Arr.map(Arr.range(0, FIN_SLOTS - 1), (count): FinOwner => ({ kind: "counted", count }))
]

/** How many rows a fin box's slot holds: none, one or two. */
const FIN_HELD = [0, 1, 2] as const

/**
 * Every state of one owner's first four slots, each holding no row, one or two, under no owner or an owner of count
 * 0 to 3, the rows numbered in slot order and each copying the count (four past every slot, under no owner): the box
 * the family theorem's own suite exhausts.
 */
export const finBoxGen: Gen<Stored> = (source) => {
	const owner = source.draw(element(FIN_OWNERS))
	const held = Arr.map(Arr.range(0, FIN_SLOTS - 1), () => source.draw(element(FIN_HELD)))
	const copy = owner.kind === "absent" ? FIN_SLOTS : owner.count
	const rows: Array<FamilyRow> = []
	for (const [at, n] of held.entries()) {
		for (let row = 0; row < n; row++) {
			rows.push({ group: 0, at, copy, member: rows.length })
		}
	}
	return {
		owners: owner.kind === "absent" ? new Map<number, number>() : new Map([[0, owner.count]]),
		rows
	}
}

/** The size of the fin box: every owner, and every slot's three holdings. */
export const FIN_BOX_CASES = FIN_OWNERS.length * FIN_HELD.length ** FIN_SLOTS

/** The span box's size, counted by the library's own enumeration. */
export const SPAN_BOX_CASES = 19_181
