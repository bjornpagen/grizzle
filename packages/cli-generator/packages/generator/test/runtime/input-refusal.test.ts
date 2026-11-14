/**
 * A body the schema refuses is refused naming where it fails and what the schema expects there, worded by the JSON
 * Schema keyword it breaks, and never quoting the body's own value: `--body: the request body does not match its schema
 * at <RFC 6901 pointer>: <expectation>`.
 *
 * The schema is one object of every JSON type, a nested object whose one member's name holds both characters a pointer
 * escapes, and an array. A property draws a valid body, then plants exactly one fault at a drawn place: a required
 * member left out, or a value of another JSON type, aimed while a feature is pending at one that is (Case.steering).
 * The oracle is the plant: the message names the planted place's pointer, and `(required)` for a member left out or
 * the JSON type the schema expects there, and quotes no planted value.
 *
 * Plants, each applied to src/runtime-src/runtime/input.ts, seen to fail this suite and reverted: whereRefused naming
 * the path's tokens unescaped; the leaf hook's MissingKey worded without `(required)`.
 */
import { type Case as SearchCase, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	JsonPointer,
	Layer,
	Option,
	Schema,
	Sink,
	Stdio,
	Stream,
	String as Str
} from "effect"
import * as Input from "#runtime-src/runtime/input.ts"

/** A member name holding both characters a JSON pointer escapes. */
const odd = "a/b~c"

/** The schema: one object with a member of every JSON type, a nested object and an array of strings. */
const Body = Schema.Struct({
	text: Schema.String,
	count: Schema.Finite,
	flag: Schema.Boolean,
	none: Schema.Null,
	list: Schema.Array(Schema.String),
	nested: Schema.Struct({ [odd]: Schema.String })
})

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
const valueOf: Readonly<Record<JsonType, Schema.Json>> = {
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

/** One fault: a required member left out, or a value of another JSON type than the place's. */
type Fault =
	| Readonly<{ kind: "missing"; place: Place }>
	| Readonly<{ kind: "type"; place: Place; given: JsonType }>

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

/** Any fault: a drawn place, left out or of another type. */
const faultGen: Gen<Fault> = (source) =>
	source.draw(faultAt(source.draw(element(places)), source.draw(element([true, false]))))

type RefusalFeature =
	| "a member left out"
	| "a value of another type"
	| "a nested place"
	| "an escaped name"

const FEATURES: Arr.NonEmptyReadonlyArray<RefusalFeature> = [
	"a member left out",
	"a value of another type",
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

/** The fault a case draws: while features are pending, one aimed at one of those (Case.steering); otherwise any. */
const aimed = (k: SearchCase<RefusalFeature>): Gen<Fault> =>
	Option.match(
		Option.flatMap(k.steering, (pending) =>
			Arr.match(
				Arr.filter(FEATURES, (feature) => pending.names(feature)),
				{ onEmpty: () => Option.none(), onNonEmpty: Option.some }
			)
		),
		{
			onNone: () => faultGen,
			onSome: (pending) => (source) => source.draw(faultFor(source.draw(element(pending))))
		}
	)

/** What `place` holds in a body: the planted value, `valid`, or nothing where the fault leaves it out. */
const holding = (fault: Fault, place: Place, valid: Schema.Json): Option.Option<Schema.Json> => {
	if (fault.place !== place) {
		return Option.some(valid)
	}
	return fault.kind === "missing" ? Option.none() : Option.some(valueOf[fault.given])
}

/** An object of the members `entries` holds, each left out where it holds nothing. */
const objectOf = (
	entries: ReadonlyArray<readonly [string, Option.Option<Schema.Json>]>
): Schema.JsonObject => {
	const object: Record<string, Schema.Json> = {}
	for (const [name, value] of entries) {
		if (Option.isSome(value)) {
			object[name] = value.value
		}
	}
	return object
}

/** A valid body, its list holding `items` strings, with `fault` planted. */
const bodyOf = (fault: Fault, items: number): Schema.Json =>
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
		["nested", holding(fault, "nested", objectOf([[odd, holding(fault, "nested member", "n")]]))]
	])

const stdin = Layer.succeed(
	Stdio.Stdio,
	Stdio.make({
		args: Effect.succeed([]),
		stderr: () => Sink.drain,
		stdin: Stream.empty,
		stdout: () => Sink.drain
	})
)

layer(Layer.mergeAll(NodeFileSystem.layer, stdin, Input.stdinClaimLayer))(
	"a refused body",
	(it) => {
		it.effect("names where it fails and the keyword it breaks, and none of its values", (ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "body refusal",
						oracle: {
							kind: "specification",
							name: "the planted fault's RFC 6901 pointer and the keyword it breaks, and no planted value in the message"
						},
						draw: drawn(int(1, 3)),
						literal: Formatter.format,
						coverage: required<RefusalFeature>(FEATURES, { cases: 40, sense: notesOnly }),
						kept: [],
						runs: 40,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 10,
						caseHang: Duration.seconds(30)
					},
					(items, notes) =>
						Effect.gen(function* () {
							const fault = notes.draw(aimed(notes))
							const { path, type } = placed[fault.place]
							notes.note(fault.kind === "missing" ? "a member left out" : "a value of another type")
							if (path.length > 1) {
								notes.note("a nested place")
							}
							if (Arr.contains(path, odd)) {
								notes.note("an escaped name")
							}
							const refused = yield* Effect.flip(
								Input.structuredBody({
									body: Option.some(jsonTextOf(bodyOf(fault, items))),
									bodyFile: Option.none(),
									fields: {},
									required: true,
									schema: Body,
									constants: {}
								})
							)
							const pointer = `/${Arr.join(Arr.map(path, JsonPointer.escapeToken), "/")}`
							const expectation =
								fault.kind === "missing"
									? "a required member is missing (required)"
									: `expected ${type}`
							deepStrictEqual(
								{
									message: refused.message,
									quotesAValue:
										Str.includes("planted-secret")(refused.message) ||
										Str.includes("7654321")(refused.message)
								},
								{
									message: `--body: the request body does not match its schema at ${pointer}: ${expectation}`,
									quotesAValue: false
								}
							)
						})
				)
			)
		)
	}
)
