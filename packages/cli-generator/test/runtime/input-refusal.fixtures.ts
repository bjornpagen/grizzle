/** What input-refusal.test.ts's property reads: the body's reader, the planted faults, and the stdin the body check claims. */

import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { aimed, type Aimed, constant, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Effect,
	JsonPointer,
	Layer,
	Option,
	Sink,
	Stdio,
	Stream,
	String as Str
} from "effect"
import type { Json } from "#model/pointer.ts"
import * as Input from "#runtime-src/runtime/input.ts"
import * as Read from "#runtime-src/runtime/read.ts"

/** A member name holding both characters a JSON pointer escapes. */
const odd = "a/b~c"

/**
 * The body's reader, as the domain module writes one: one closed object with a member of every JSON type, a closed
 * nested object and an array of strings.
 */
const body: Read.Reader<unknown> = Read.object(
	(members) => ({
		text: Read.member(members, "text", Read.string),
		count: Read.member(members, "count", Read.number),
		flag: Read.member(members, "flag", Read.boolean),
		none: Read.member(members, "none", Read.nullValue),
		list: Read.member(members, "list", Read.array(Read.string)),
		nested: Read.member(
			members,
			"nested",
			Read.object((nested) => ({ [odd]: Read.member(nested, odd, Read.string) }), false)
		)
	}),
	false
)

/** A place a fault is planted at: a member of the top object, the nested object's member, or the list's first item. */
type Place = "text" | "count" | "flag" | "none" | "list" | "nested" | "nested member" | "list item"

type JsonType = "a string" | "a number" | "a boolean" | "null" | "an array" | "an object"

const places: Arr.NonEmptyReadonlyArray<Place> = [
	"text",
	"count",
	"flag",
	"none",
	"list",
	"nested",
	"nested member",
	"list item"
]

/** Each place's path in the body, and the JSON type the schema expects there. */
const placed: Readonly<Record<Place, Readonly<{ path: ReadonlyArray<string>; type: JsonType }>>> = {
	text: { path: ["text"], type: "a string" },
	count: { path: ["count"], type: "a number" },
	flag: { path: ["flag"], type: "a boolean" },
	none: { path: ["none"], type: "null" },
	list: { path: ["list"], type: "an array" },
	nested: { path: ["nested"], type: "an object" },
	"nested member": { path: ["nested", odd], type: "a string" },
	"list item": { path: ["list", "0"], type: "a string" }
}

/** A value of each JSON type, its spelling a planted one no message may quote. */
const valueOf: Readonly<Record<JsonType, Json>> = {
	"a string": "planted-secret",
	"a number": 7_654_321,
	"a boolean": true,
	null: null,
	"an array": ["planted-secret"],
	"an object": { planted: "planted-secret" }
}

const types: Arr.NonEmptyReadonlyArray<JsonType> = [
	"a string",
	"a number",
	"a boolean",
	"null",
	"an array",
	"an object"
]

/**
 * One fault: a required member left out, a value of another JSON type than the place's, or a member no property of
 * the closed object at `within` declares.
 */
type Fault =
	| Readonly<{ kind: "missing"; place: Place }>
	| Readonly<{ kind: "type"; place: Place; given: JsonType }>
	| Readonly<{ kind: "extra"; within: "top" | "nested" }>

/** The member name an extra fault plants, and its value, which no message may quote. */
const extraName = "planted"

/** A fault at `place`: a member left out where `missing` and the place is a member, else a value of another type. */
const faultAt =
	(place: Place, missing: boolean): Gen<Fault> =>
	(source) => {
		if (missing && place !== "list item") {
			return { kind: "missing", place }
		}
		const others = Arr.filter(types, (type) => type !== placed[place].type)
		return {
			kind: "type",
			place,
			given: source.draw(element(Arr.isReadonlyArrayNonEmpty(others) ? others : types))
		}
	}

/** An extra member, in the top object or the nested one. */
const extraGen: Gen<Fault> = (source) => ({
	kind: "extra",
	within: source.draw(element(["top", "nested"] as const))
})

/**
 * Any fault: an extra member one time in four, there being two objects for it against eight places for the others,
 * else a drawn place left out or of another type.
 */
const faultGen: Gen<Fault> = (source) =>
	source.draw(
		weighted<"extra" | "place">([
			[1, constant("extra")],
			[3, constant("place")]
		])
	) === "extra"
		? source.draw(extraGen)
		: source.draw(faultAt(source.draw(element(places)), source.draw(element([true, false]))))

export type RefusalFeature =
	| "a member left out"
	| "a value of another type"
	| "a member no property declares"
	| "a nested place"
	| "an escaped name"

export const FEATURES: Arr.NonEmptyReadonlyArray<RefusalFeature> = [
	"a member left out",
	"a value of another type",
	"a member no property declares",
	"a nested place",
	"an escaped name"
]

/** A fault made to reach `feature`, every other choice drawn. */
const faultFor =
	(feature: RefusalFeature): Gen<Fault> =>
	(source) => {
		switch (feature) {
			case "a member left out":
				return source.draw(faultAt(source.draw(element(places)), true))
			case "a value of another type":
				return source.draw(faultAt(source.draw(element(places)), false))
			case "a member no property declares":
				return source.draw(extraGen)
			case "a nested place":
				return source.draw(
					faultAt(
						source.draw(element(["nested member", "list item"] as const)),
						source.draw(element([true, false]))
					)
				)
			case "an escaped name":
				return source.draw(faultAt("nested member", source.draw(element([true, false]))))
		}
	}

/** What `place` holds in a body: the planted value, `valid`, or nothing where the fault leaves it out. */
const holding = (fault: Fault, place: Place, valid: Json): Option.Option<Json> => {
	switch (fault.kind) {
		case "extra":
			return Option.some(valid)
		case "missing":
			return fault.place === place ? Option.none() : Option.some(valid)
		case "type":
			return Option.some(fault.place === place ? valueOf[fault.given] : valid)
	}
}

/** The extra member an object holds where the fault plants one `within` it, else none. */
const extra = (
	fault: Fault,
	within: "top" | "nested"
): ReadonlyArray<readonly [string, Option.Option<Json>]> =>
	fault.kind === "extra" && fault.within === within
		? [[extraName, Option.some("planted-secret")]]
		: []

/** An object of the members `entries` holds, each left out where it holds nothing. */
const objectOf = (
	entries: ReadonlyArray<readonly [string, Option.Option<Json>]>
): Readonly<Record<string, Json>> => {
	const object: Record<string, Json> = {}
	for (const [name, value] of entries) {
		if (Option.isSome(value)) {
			object[name] = value.value
		}
	}
	return object
}

/** A valid body, its list holding `items` strings, with `fault` planted. */
const bodyOf = (fault: Fault, items: number): Json =>
	objectOf([
		["text", holding(fault, "text", "t")],
		["count", holding(fault, "count", 1)],
		["flag", holding(fault, "flag", false)],
		["none", holding(fault, "none", null)],
		[
			"list",
			holding(fault, "list", [
				...Option.toArray(holding(fault, "list item", "x")),
				...Array.from({ length: items - 1 }, () => "x")
			])
		],
		[
			"nested",
			holding(
				fault,
				"nested",
				objectOf([[odd, holding(fault, "nested member", "n")], ...extra(fault, "nested")])
			)
		],
		...extra(fault, "top")
	])

/** An empty stdin, so the body check's claim on stdin is the case's own: one built for each case. */
const stdin = Layer.succeed(
	Stdio.Stdio,
	Stdio.make({
		args: Effect.succeed([]),
		stderr: () => Sink.drain,
		stdin: Stream.empty,
		stdout: () => Sink.drain
	})
)

/** Faults, aimed at each pending feature by a fault built to reach it. */
export const faults: Aimed<Fault, RefusalFeature> = aimed(
	faultGen,
	Arr.map(FEATURES, (feature) => [feature, faultFor(feature)] as const)
)

/** The refusal the body check gives a body holding `fault`, with `items` list items, on the case's own stdin. */
export const refusalOf = (fault: Fault, items: number) =>
	Effect.scoped(
		Effect.flatMap(Layer.build(Layer.mergeAll(stdin, Input.stdinClaimLayer)), (context) =>
			Effect.flip(
				Input.structuredBody({
					body: Option.some(jsonText(bodyOf(fault, items))),
					bodyFile: Option.none(),
					fields: {},
					required: true,
					schema: body,
					constants: {}
				})
			).pipe(Effect.provideContext(context))
		)
	)

/** Where a planted fault is, and what the message must say is expected there. */
export const plantedAt = (fault: Fault) => {
	const { path, expectation } =
		fault.kind === "extra"
			? {
					path: fault.within === "top" ? [extraName] : ["nested", extraName],
					expectation: "a member the schema does not admit (additionalProperties)"
				}
			: {
					path: placed[fault.place].path,
					expectation:
						fault.kind === "missing"
							? "a required member is missing (required)"
							: `expected ${placed[fault.place].type}`
				}
	return { path, expectation, pointer: `/${Arr.join(Arr.map(path, JsonPointer.escapeToken), "/")}` }
}

/** The features a fault reaches. */
export const faultFeatures = (
	fault: Fault,
	path: ReadonlyArray<string>
): ReadonlyArray<RefusalFeature> => [
	fault.kind === "extra"
		? "a member no property declares"
		: fault.kind === "missing"
			? "a member left out"
			: "a value of another type",
	...(path.length > 1 ? (["a nested place"] as const) : []),
	...(Arr.contains(path, odd) ? (["an escaped name"] as const) : [])
]

/** Whether a message quotes a value the plant put in the body. */
export const quotesAValue = (message: string): boolean =>
	Str.includes("planted-secret")(message) || Str.includes("7654321")(message)
