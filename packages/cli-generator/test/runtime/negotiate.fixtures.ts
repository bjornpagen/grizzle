/**
 * What the property of negotiate.test.ts reads: an operation's declared media and an operator's choices as drawn,
 * and a precedence model of media negotiation (RFC 9110 12.5.1's specificity: an exact type over its `type/*` range
 * over `*` over `*`) that the runtime's choice, Accept value and response dispatch are held to.
 */

import { aimed, array, element, type Gen, option } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import type { MediaDeclaration } from "#runtime-src/runtime/negotiate.ts"
import { essenceOf, holding, isJsonMedia } from "#test/runtime/serialize.fixtures.ts"

/** Declared media keys: JSON and a `+json` type, concrete types, ranges of both kinds, and one with case and a parameter. */
const KEYS: Arr.NonEmptyReadonlyArray<string> = [
	"application/json",
	"image/png",
	"application/xml",
	"application/vnd.api+json",
	"image/*",
	"*/*",
	"text/csv",
	"Text/Plain; charset=utf-8"
]

/** An operator's value: declared and undeclared concrete types, one inside a range, a range, a secret, malformed text. */
const CHOSEN: Arr.NonEmptyReadonlyArray<string> = [
	"application/json",
	"image/png",
	"image/webp",
	"Image/PNG",
	" text/csv ",
	"text/plain",
	"text/secret-value",
	"image/*",
	"image/png; q=1",
	"image",
	""
]

/** A negotiation as drawn: the operation's request keys and response keys, and the operator's three choices. */
export type NegotiationCase = Readonly<{
	request: ReadonlyArray<string>
	responses: Readonly<Record<string, ReadonlyArray<string>>>
	contentType: Option.Option<string>
	accept: Option.Option<string>
	actual: Option.Option<string>
}>

/** A negotiation as drawn. */
const negotiationDrawn: Gen<NegotiationCase> = (source) => ({
	request: array(element(KEYS), { min: 0, max: 3 })(source),
	responses: Rec.fromEntries(
		Arr.map(
			Arr.dedupe(array(element(["200", "201", "default", "404"]), { min: 0, max: 2 })(source)),
			(status) => [status, array(element(KEYS), { min: 0, max: 2 })(source)] as const
		)
	),
	contentType: option(element(CHOSEN))(source),
	accept: option(element(CHOSEN))(source),
	actual: option(element([...CHOSEN, "application/json; charset=utf-8", "Application/JSON"]))(
		source
	)
})

/**
 * A negotiation aimed at what plain draws reach rarely: several request keys, with JSON not first (the second of two
 * among them) or with none; a range key the operator names a type inside, and an exact key beside its range; responses
 * repeating a key.
 */
export const negotiationSpace = aimed<NegotiationCase, NegotiationFeature>(negotiationDrawn, [
	[
		"JSON key chosen by default",
		(source) => ({
			...negotiationDrawn(source),
			request: [
				"image/png",
				element(["application/json", "application/vnd.api+json"])(source),
				"application/json"
			],
			contentType: Option.none()
		})
	],
	[
		"JSON second of two keys chosen by default",
		(source) => ({
			...negotiationDrawn(source),
			request: [
				element(["image/png", "text/csv"])(source),
				element(["application/json", "application/vnd.api+json"])(source)
			],
			contentType: Option.none()
		})
	],
	[
		"first key by default",
		(source) => ({
			...negotiationDrawn(source),
			request: [
				element(["image/png", "application/xml"])(source),
				"text/csv",
				element(["image/*", "application/xml"])(source)
			],
			contentType: Option.none()
		})
	],
	[
		"exact key over its range",
		(source) => ({
			...negotiationDrawn(source),
			request: [element(["image/*", "*/*"])(source), "image/png"],
			contentType: Option.some(element(["image/png", "Image/PNG"])(source))
		})
	],
	[
		"Accept lists every key once",
		(source) => ({
			...negotiationDrawn(source),
			responses: {
				"200": ["application/xml", "text/csv"],
				default: [element(["text/csv", "application/xml"])(source)]
			},
			accept: Option.none()
		})
	],
	[
		"Accept narrowed to JSON",
		(source) => ({
			...negotiationDrawn(source),
			responses: {
				"200": [
					element(["image/png", "text/csv"])(source),
					element(["application/json", "application/vnd.api+json"])(source)
				]
			},
			accept: Option.none()
		})
	],
	[
		"dispatched exactly",
		(source) => {
			const key = element(["application/json", "image/png", "text/csv"])(source)
			return {
				...negotiationDrawn(source),
				responses: { "200": ["*/*", "image/*", key] },
				actual: Option.some(key)
			}
		}
	],
	[
		"range key with a type inside it",
		(source) => ({
			...negotiationDrawn(source),
			request: ["application/json", element(["image/*", "*/*"])(source)],
			contentType: Option.some(element(["image/png", "image/webp"])(source))
		})
	]
])

const concreteType = regex("^([!#$%&'+.^_`|~0-9a-z-]+)/([!#$%&'+.^_`|~0-9a-z-]+)$", "u")

/** An operator's value as a concrete type: trimmed and lower-cased, a token, a slash, a token, nothing else. */
const concreteOf = (value: string): Option.Option<readonly [type: string, major: string]> => {
	const named = Str.toLowerCase(Str.trim(value))
	return Option.map(
		Option.fromNullishOr(concreteType.exec(named)),
		([, major = ""]) => [named, major] as const
	)
}

/** Whether a key is a range: its essence ends in `/*`. */
const isRange = (key: string): boolean => Str.endsWith("/*")(essenceOf(key))

/** How specifically a declared key matches a concrete type: exactly 2, by its type's range 1, by `*` over `*` 0; none otherwise. */
const specificity = (
	key: string,
	[type, major]: readonly [string, string]
): Option.Option<number> => {
	const essence = essenceOf(key)
	if (essence === type) {
		return Option.some(2)
	}
	if (essence === `${major}/*`) {
		return Option.some(1)
	}
	return essence === "*/*" ? Option.some(0) : Option.none()
}

/** The most specific declared key for a concrete type, the first among equals. */
const mostSpecific = (
	declared: ReadonlyArray<string>,
	concrete: readonly [string, string]
): Option.Option<string> =>
	Arr.reduce(declared, Option.none<readonly [string, number]>(), (best, key) =>
		Option.match(specificity(key, concrete), {
			onNone: () => best,
			onSome: (score) =>
				Option.exists(best, ([, held]) => held >= score) ? best : Option.some([key, score] as const)
		})
	).pipe(Option.map(([key]) => key))

/** A negotiation's result: the value, or a refusal naming its flag. */
export type Negotiated<A> =
	| Readonly<{ kind: "chosen"; value: A }>
	| Readonly<{ kind: "refused"; flag: string }>

/**
 * The request media (design 4.5): no request key is refused; with no `--content-type` one key is used as declared,
 * several default to the first JSON one, else the first, and a range key cannot be the default; a named type is the
 * most specific declared key over it, sent as named under a range key, refused when no key covers it or it is not
 * one concrete type.
 */
export const requestMediaModel = (
	media: NegotiationCase
): Negotiated<Readonly<{ contentType: string; key: string }>> => {
	const refused = { kind: "refused", flag: "--content-type" } as const
	return Option.match(Arr.head(media.request), {
		onNone: () => refused,
		onSome: (first) =>
			Option.match(media.contentType, {
				onNone: () => {
					const key =
						media.request.length === 1
							? first
							: Option.getOrElse(Arr.findFirst(media.request, isJsonMedia), () => first)
					return isRange(key) ? refused : { kind: "chosen", value: { contentType: key, key } }
				},
				onSome: (value) =>
					Option.match(
						Option.flatMap(concreteOf(value), (concrete) =>
							Option.map(mostSpecific(media.request, concrete), (key) => ({
								contentType: isRange(key) ? concrete[0] : key,
								key
							}))
						),
						{ onNone: () => refused, onSome: (chosen) => ({ kind: "chosen", value: chosen }) }
					)
			})
	})
}

/** The response keys of every response, once each in document order. */
const responseKeys = (media: NegotiationCase): ReadonlyArray<string> =>
	Arr.dedupe(Arr.flatten(Rec.values(media.responses)))

/**
 * The Accept value (design 4.5): with no `--accept`, every declared response key once each, narrowed to the JSON ones
 * where JSON and other keys both appear, none when no response declares content; a named type is sent as named when a
 * declared key covers it, refused otherwise.
 */
export const acceptModel = (media: NegotiationCase): Negotiated<Option.Option<string>> => {
	const declared = responseKeys(media)
	return Option.match(media.accept, {
		onNone: () => {
			const json = Arr.filter(declared, isJsonMedia)
			const listed = json.length > 0 && json.length < declared.length ? json : declared
			return {
				kind: "chosen",
				value: Arr.isReadonlyArrayNonEmpty(listed)
					? Option.some(Arr.join(listed, ", "))
					: Option.none()
			}
		},
		onSome: (value) =>
			Option.match(
				Option.filter(concreteOf(value), (concrete) =>
					Option.isSome(mostSpecific(declared, concrete))
				),
				{
					onNone: () => ({ kind: "refused", flag: "--accept" }),
					onSome: ([type]) => ({ kind: "chosen", value: Option.some(type) })
				}
			)
	})
}

/** The declared key a response's Content-Type dispatches to: the most specific over its essence, none without one or with no key over it. */
export const dispatchModel = (media: NegotiationCase): Option.Option<string> =>
	Option.flatMap(
		Option.flatMap(media.actual, (actual) => concreteOf(essenceOf(actual))),
		(concrete) => mostSpecific(responseKeys(media), concrete)
	)

/** The situations a negotiation reaches. */
export type NegotiationFeature =
	| "one key used as declared"
	| "JSON key chosen by default"
	| "JSON second of two keys chosen by default"
	| "first key by default"
	| "type chosen among keys"
	| "range key with a type inside it"
	| "exact key over its range"
	| "range key as default refused"
	| "undeclared type refused"
	| "not one concrete type refused"
	| "no request media refused"
	| "Accept lists every key once"
	| "Accept narrowed to JSON"
	| "Accept names one type"
	| "Accept outside the keys refused"
	| "no Accept"
	| "dispatched exactly"
	| "dispatched by a type range"
	| "dispatched by any"
	| "dispatched past case and parameters"
	| "dispatched nowhere"

/** What a negotiation reaches. */
export const negotiationFeatures = (media: NegotiationCase): ReadonlyArray<NegotiationFeature> => {
	const chosen = requestMediaModel(media)
	const accepted = acceptModel(media)
	const keys = responseKeys(media)
	const dispatched = dispatchModel(media)
	const concrete = Option.flatMap(media.contentType, concreteOf)
	const actual = Option.flatMap(media.actual, (value) => concreteOf(essenceOf(value)))
	const scoreOf = (key: string) => Option.flatMap(actual, (pair) => specificity(key, pair))
	return holding<NegotiationFeature>([
		[
			"one key used as declared",
			chosen.kind === "chosen" && media.request.length === 1 && Option.isNone(media.contentType)
		],
		[
			"JSON key chosen by default",
			chosen.kind === "chosen" &&
				Option.isNone(media.contentType) &&
				media.request.length > 1 &&
				!Option.exists(Arr.head(media.request), isJsonMedia) &&
				isJsonMedia(chosen.value.key)
		],
		[
			"JSON second of two keys chosen by default",
			chosen.kind === "chosen" &&
				Option.isNone(media.contentType) &&
				media.request.length === 2 &&
				!Option.exists(Arr.head(media.request), isJsonMedia) &&
				isJsonMedia(chosen.value.key)
		],
		[
			"first key by default",
			chosen.kind === "chosen" &&
				Option.isNone(media.contentType) &&
				media.request.length > 1 &&
				!Arr.some(media.request, isJsonMedia)
		],
		[
			"type chosen among keys",
			chosen.kind === "chosen" &&
				Option.isSome(media.contentType) &&
				media.request.length > 1 &&
				!isRange(chosen.value.key)
		],
		["range key with a type inside it", chosen.kind === "chosen" && isRange(chosen.value.key)],
		[
			"exact key over its range",
			chosen.kind === "chosen" &&
				Option.isSome(media.contentType) &&
				!isRange(chosen.value.key) &&
				Arr.some(
					media.request,
					(key) =>
						isRange(key) &&
						Option.isSome(Option.flatMap(concrete, (pair) => specificity(key, pair)))
				)
		],
		[
			"range key as default refused",
			chosen.kind === "refused" && Option.isNone(media.contentType) && media.request.length > 0
		],
		["undeclared type refused", chosen.kind === "refused" && Option.isSome(concrete)],
		[
			"not one concrete type refused",
			chosen.kind === "refused" &&
				Option.isSome(media.contentType) &&
				Option.isNone(concrete) &&
				media.request.length > 0
		],
		["no request media refused", media.request.length === 0],
		[
			"Accept lists every key once",
			accepted.kind === "chosen" &&
				Option.isNone(media.accept) &&
				keys.length > 1 &&
				Arr.flatten(Rec.values(media.responses)).length > keys.length
		],
		[
			"Accept narrowed to JSON",
			accepted.kind === "chosen" &&
				Option.isNone(media.accept) &&
				Arr.some(keys, isJsonMedia) &&
				!Arr.every(keys, isJsonMedia)
		],
		["Accept names one type", accepted.kind === "chosen" && Option.isSome(media.accept)],
		["Accept outside the keys refused", accepted.kind === "refused"],
		["no Accept", accepted.kind === "chosen" && Option.isNone(accepted.value)],
		["dispatched exactly", Option.exists(dispatched, (key) => Option.contains(scoreOf(key), 2))],
		[
			"dispatched by a type range",
			Option.exists(dispatched, (key) => Option.contains(scoreOf(key), 1))
		],
		["dispatched by any", Option.exists(dispatched, (key) => Option.contains(scoreOf(key), 0))],
		[
			"dispatched past case and parameters",
			Option.isSome(dispatched) &&
				Option.exists(media.actual, (value) => essenceOf(value) !== value)
		],
		["dispatched nowhere", Option.isNone(dispatched) && Option.isSome(media.actual)]
	])
}

/** A media declaration as the runtime takes it. */
export const declarationOf = (media: NegotiationCase): MediaDeclaration => ({
	request: media.request,
	responses: media.responses
})

/** Whether a refusal's message repeats the operator's value. */
export const echoes = (message: string): boolean => Str.includes("secret")(message)
