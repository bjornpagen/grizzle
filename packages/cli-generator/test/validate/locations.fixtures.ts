/**
 * What the property of locations.test.ts reads: validator error units at locations drawn over a small pointer tree,
 * each spelled as the validator reports it (a plain fragment, a percent-encoded one, a property name's `#*`) or with a
 * fault, and a model of design 3.2's grouping, written over the locations' tokens apart from the module's pointer text.
 */

import { aimed, type Aimed, array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { type ErrorUnit, groupErrors } from "#validate/locations.ts"

/** How a sound location is spelled: its pointer as it is, percent-encoded, or after a property name's `#*`. */
type Spelling = "plain" | "percent-encoded" | "property name"

/** A fault in a location's text, each of which the module refuses. */
type LocationFault = "no hash" | "a broken percent escape" | "a fragment that is no pointer"

type Sound = Readonly<{ kind: "sound"; tokens: ReadonlyArray<string>; spelling: Spelling }>

type Faulted = Readonly<{ kind: "faulted"; tokens: ReadonlyArray<string>; fault: LocationFault }>

/** A location as drawn: a sound one by its raw tokens and spelling, or one at its tokens with a fault. */
type Location = Sound | Faulted

/** The locations of one validator run's error units, in the order it reports them. */
export type GroupCase = Readonly<{ locations: ReadonlyArray<Location> }>

/** A token's RFC 6901 escape: `~` as `~0`, then `/` as `~1`. */
const escaped = (token: string): string =>
	Str.replaceAll("/", "~1")(Str.replaceAll("~", "~0")(token))

const pointerText = (tokens: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(tokens, (token) => `/${escaped(token)}`),
		""
	)

const encodedText = (tokens: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(tokens, (token) => `/${encodeURIComponent(escaped(token))}`),
		""
	)

/** A sound location's `instanceLocation`, as the validator reports it. */
const soundText = (location: Sound): string => {
	switch (location.spelling) {
		case "plain":
			return `#${pointerText(location.tokens)}`
		case "percent-encoded":
			return `#${encodedText(location.tokens)}`
		case "property name":
			return `#*${pointerText(location.tokens)}`
	}
}

/** A faulted location's `instanceLocation`: no `#`, a percent escape cut short, or a `~2` no pointer holds. */
const faultedText = (location: Faulted): string => {
	switch (location.fault) {
		case "no hash":
			return pointerText(location.tokens)
		case "a broken percent escape":
			return `#${pointerText(location.tokens)}/%E0%A4%A`
		case "a fragment that is no pointer":
			return `#${pointerText(location.tokens)}/a~2`
	}
}

const textOf = (location: Location): string =>
	location.kind === "sound" ? soundText(location) : faultedText(location)

/** The first faulted location in report order. */
const firstFault = (c: GroupCase): Option.Option<Faulted> =>
	Arr.findFirst(c.locations, (location) =>
		location.kind === "faulted" ? Option.some(location) : Option.none()
	)

const soundOf = (c: GroupCase): ReadonlyArray<Sound> =>
	Arr.flatMap(c.locations, (location) => (location.kind === "sound" ? [location] : []))

const keywordOf = (index: number): string => `k${index}`

/** The error units of a case, each keyword naming its place in the report. */
export const unitsOf = (c: GroupCase): ReadonlyArray<ErrorUnit> =>
	Arr.map(c.locations, (location, index) => ({
		absoluteKeywordLocation: `https://example.com/s#/${keywordOf(index)}`,
		instanceLocation: textOf(location),
		keyword: keywordOf(index)
	}))

/** One group as the property compares it: its pointer's text and its units' keywords. */
type GroupView = Readonly<{
	pointer: string
	deepest: ReadonlyArray<string>
	context: ReadonlyArray<string>
}>

/** What grouping answers: the groups in order, or the location it refused. */
export type Grouping =
	| Readonly<{ kind: "grouped"; groups: ReadonlyArray<GroupView> }>
	| Readonly<{ kind: "refused"; location: string }>

export const groupingOf = (c: GroupCase): Effect.Effect<Grouping> =>
	groupErrors(unitsOf(c)).pipe(
		Effect.map((groups): Grouping => ({
			kind: "grouped",
			groups: Arr.map(groups, (group) => ({
				pointer: group.pointer,
				deepest: Arr.map(group.deepest, (unit) => unit.keyword),
				context: Arr.map(group.context, (unit) => unit.keyword)
			}))
		})),
		Effect.catchTag("InvalidInstanceLocation", (invalid) =>
			Effect.succeed<Grouping>({ kind: "refused", location: invalid.location })
		)
	)

type Placed = Readonly<{ tokens: ReadonlyArray<string>; keyword: string }>

/** Whether `pointer`'s tokens extend `ancestor`'s. */
const within = (ancestor: ReadonlyArray<string>, pointer: ReadonlyArray<string>): boolean =>
	pointer.length >= ancestor.length &&
	Arr.every(ancestor, (token, index) => Option.contains(Arr.get(pointer, index), token))

const same = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
	left.length === right.length && within(left, right)

const placedOf = (c: GroupCase): ReadonlyArray<Placed> =>
	Arr.flatMap(c.locations, (location, index) =>
		location.kind === "sound" ? [{ tokens: location.tokens, keyword: keywordOf(index) }] : []
	)

const isDeepestIn =
	(placed: ReadonlyArray<Placed>) =>
	(unit: Placed): boolean =>
		!Arr.some(
			placed,
			(other) => !same(unit.tokens, other.tokens) && within(unit.tokens, other.tokens)
		)

/** The deepest locations, each once, in the order of their pointers' texts. */
const leavesOf = (placed: ReadonlyArray<Placed>): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.sort(
		Arr.dedupeWith(
			Arr.map(Arr.filter(placed, isDeepestIn(placed)), (unit) => unit.tokens),
			same
		),
		Order.mapInput(Order.String, pointerText)
	)

const ownerOf = (
	leaves: ReadonlyArray<ReadonlyArray<string>>,
	unit: Placed
): Option.Option<ReadonlyArray<string>> =>
	Arr.findFirst(leaves, (leaf) => within(unit.tokens, leaf))

/**
 * The model of design 3.2's grouping: the first faulted location in report order is refused; otherwise a location with
 * no other location below it is a leaf, the leaves in the order of their pointers' texts, each holding the units at it
 * in report order, and every other unit is context of the first leaf below it, in report order.
 */
export const expectedGroupingOf = (c: GroupCase): Grouping =>
	Option.match(firstFault(c), {
		onSome: (faulted): Grouping => ({ kind: "refused", location: faultedText(faulted) }),
		onNone: (): Grouping => {
			const placed = placedOf(c)
			const leaves = leavesOf(placed)
			const deepest = isDeepestIn(placed)
			return {
				kind: "grouped",
				groups: Arr.map(leaves, (leaf) => ({
					pointer: pointerText(leaf),
					deepest: Arr.map(
						Arr.filter(placed, (unit) => same(unit.tokens, leaf)),
						(unit) => unit.keyword
					),
					context: Arr.map(
						Arr.filter(
							placed,
							(unit) =>
								!deepest(unit) && Option.exists(ownerOf(leaves, unit), (owner) => same(owner, leaf))
						),
						(unit) => unit.keyword
					)
				}))
			}
		}
	})

export type GroupFeature =
	| "a deepest pointer reported twice"
	| "a context owned by the first of its leaves"
	| "the root as context"
	| "leaves out of report order"
	| "a leaf with no context"
	| "a location percent-encoded"
	| "a property name's location"
	| "an escaped token"
	| `${LocationFault} refused`

/** Tokens whose percent-encoding differs from their text. */
const ENCODED: Arr.NonEmptyReadonlyArray<string> = ["a b", "é"]

/** Tokens a pointer escapes. */
const ESCAPED: Arr.NonEmptyReadonlyArray<string> = ["x/y", "m~n"]

export const groupFeaturesOf = (c: GroupCase): ReadonlyArray<GroupFeature> => {
	const when = (holds: boolean, feature: GroupFeature): ReadonlyArray<GroupFeature> =>
		holds ? [feature] : []
	const placed = placedOf(c)
	const leaves = leavesOf(placed)
	const deepest = isDeepestIn(placed)
	const contexts = Arr.filter(placed, (unit) => !deepest(unit))
	const grouping = expectedGroupingOf(c)
	const groups = grouping.kind === "grouped" ? grouping.groups : []
	const reported = Arr.dedupeWith(
		Arr.map(Arr.filter(placed, deepest), (unit) => unit.tokens),
		same
	)
	const sound = soundOf(c)
	return [
		...Option.match(firstFault(c), {
			onNone: () => [],
			onSome: (faulted) => [`${faulted.fault} refused` as const]
		}),
		...when(
			Arr.some(groups, (group) => group.deepest.length > 1),
			"a deepest pointer reported twice"
		),
		...when(
			Arr.some(
				contexts,
				(unit) => Arr.filter(leaves, (leaf) => within(unit.tokens, leaf)).length > 1
			),
			"a context owned by the first of its leaves"
		),
		...when(
			Arr.some(contexts, (unit) => Arr.isReadonlyArrayEmpty(unit.tokens)),
			"the root as context"
		),
		...when(
			!Arr.every(reported, (tokens, index) =>
				Option.exists(Arr.get(leaves, index), (leaf) => same(leaf, tokens))
			),
			"leaves out of report order"
		),
		...when(
			Arr.some(groups, (group) => Arr.isReadonlyArrayEmpty(group.context)),
			"a leaf with no context"
		),
		...when(
			Arr.some(
				sound,
				(location) =>
					location.spelling === "percent-encoded" &&
					Arr.some(location.tokens, (token) => Arr.contains(ENCODED, token))
			),
			"a location percent-encoded"
		),
		...when(
			Arr.some(sound, (location) => location.spelling === "property name"),
			"a property name's location"
		),
		...when(
			Arr.some(sound, (location) =>
				Arr.some(location.tokens, (token) => Arr.contains(ESCAPED, token))
			),
			"an escaped token"
		)
	]
}

const tokenGen: Gen<string> = weighted([
	[6, element(["a", "b"])],
	[1, element([...ENCODED, ...ESCAPED])]
])

const spellingGen: Gen<Spelling> = element<Spelling>(["plain", "percent-encoded", "property name"])

const sound =
	(tokens: Gen<ReadonlyArray<string>>, spelling: Gen<Spelling>): Gen<Sound> =>
	(s) => ({ kind: "sound", tokens: s.draw(tokens), spelling: s.draw(spelling) })

const anyTokens: Gen<ReadonlyArray<string>> = array(tokenGen, { min: 0, max: 3 })

const soundLocations: Gen<ReadonlyArray<Location>> = array(sound(anyTokens, spellingGen), {
	min: 0,
	max: 6
})

/** `locations` with `inserted` at a drawn place among them. */
const insertedAt =
	(
		locations: Gen<ReadonlyArray<Location>>,
		inserted: ReadonlyArray<Location>
	): Gen<ReadonlyArray<Location>> =>
	(s) => {
		const drawn = s.draw(locations)
		const at = s.draw(int(0, drawn.length))
		return [...Arr.take(drawn, at), ...inserted, ...Arr.drop(drawn, at)]
	}

const faultedAt =
	(fault: LocationFault): Gen<GroupCase> =>
	(s) => ({
		locations: s.draw(
			insertedAt(soundLocations, [{ kind: "faulted", tokens: s.draw(anyTokens), fault }])
		)
	})

const anyFault: Gen<LocationFault> = element<LocationFault>([
	"no hash",
	"a broken percent escape",
	"a fragment that is no pointer"
])

const anyCase: Gen<GroupCase> = weighted([
	[4, (s) => ({ locations: s.draw(soundLocations) })],
	[1, (s) => s.draw(faultedAt(s.draw(anyFault)))]
])

const located = (tokens: ReadonlyArray<string>): Gen<Location> => sound(() => tokens, spellingGen)

/** Locations at fixed tokens, each spelled as drawn, in this order. */
const atTokens =
	(tokens: ReadonlyArray<ReadonlyArray<string>>): Gen<ReadonlyArray<Location>> =>
	(s) =>
		Arr.map(tokens, (each) => s.draw(located(each)))

/** Cases aimed at each way locations group, each spelling and each fault. */
export const groupSpace: Aimed<GroupCase, GroupFeature> = aimed(anyCase, [
	[
		"a deepest pointer reported twice",
		(s) => ({
			locations: s.draw(
				insertedAt(
					soundLocations,
					s.draw(
						atTokens([
							["b", "b", "b", "b"],
							["b", "b", "b", "b"]
						])
					)
				)
			)
		})
	],
	[
		"a context owned by the first of its leaves",
		(s) => ({ locations: s.draw(atTokens([["a", "b"], ["a"], ["a", "a"]])) })
	],
	[
		"the root as context",
		(s) => ({ locations: s.draw(insertedAt(atTokens([["a"]]), s.draw(atTokens([[]])))) })
	],
	["leaves out of report order", (s) => ({ locations: s.draw(atTokens([["b"], ["a"]])) })],
	["a leaf with no context", (s) => ({ locations: s.draw(atTokens([["a", "b"]])) })],
	[
		"a location percent-encoded",
		(s) => ({
			locations: s.draw(
				insertedAt(soundLocations, [
					s.draw(
						sound(
							(inner) => [inner.draw(element(ENCODED))],
							() => "percent-encoded"
						)
					)
				])
			)
		})
	],
	[
		"a property name's location",
		(s) => ({
			locations: s.draw(
				insertedAt(soundLocations, [s.draw(sound(anyTokens, () => "property name"))])
			)
		})
	],
	[
		"an escaped token",
		(s) => ({
			locations: s.draw(
				insertedAt(soundLocations, [
					s.draw(sound((inner) => [inner.draw(element(ESCAPED))], spellingGen))
				])
			)
		})
	],
	["no hash refused", faultedAt("no hash")],
	["a broken percent escape refused", faultedAt("a broken percent escape")],
	["a fragment that is no pointer refused", faultedAt("a fragment that is no pointer")]
])
