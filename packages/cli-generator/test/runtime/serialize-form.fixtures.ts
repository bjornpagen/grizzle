/**
 * What the property of serialize-form.test.ts reads: form bodies and form query strings as drawn, and a reference of
 * `application/x-www-form-urlencoded` writing built on the WHATWG URL Standard's own serializer (Node's
 * URLSearchParams), with the design's Encoding Object rules, pair collisions and refused fields over it.
 */

import {
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	map,
	option,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Option, Predicate, Record as Rec, Result, String as Str } from "effect"
import { JsonNull, JsonNumber, jsonNull } from "#runtime-src/runtime/input.ts"
import type { FormEncoding, Json } from "#runtime-src/runtime/serialize.ts"
import {
	breaksHeader,
	holding,
	holdsLone,
	isJsonList,
	isScalar,
	itemText,
	jsonHoldsLone,
	jsonModel,
	jsonScalar,
	objectWith,
	type SentPair,
	type PairCodec,
	pairsText,
	type QueryStyle,
	type Read,
	refused,
	type Styled,
	styledModel,
	text
} from "#test/runtime/serialize.fixtures.ts"
import { formPairs } from "#test/support/form.ts"

/** The form media type, as declared. */
const FORM = "application/x-www-form-urlencoded"

/** A JSON object, as a form's value is. */
type JsonObject = { readonly [property: string]: Json }

/**
 * Names a form's properties and members are drawn from: plain, one a refused field, names that extend it by a dot and
 * by brackets, one with characters the serializer encodes, and one with half a surrogate pair. Members share them, so
 * an exploded member can be named like a declared property.
 */
const NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"b",
	"tag",
	"z",
	"metadata",
	"metadata.kind",
	"metadata[a]",
	"opts",
	"a b&c",
	"x\uD800"
]

/** One form name, mostly a plain one. */
const formName: Gen<string> = weighted([
	[3, element(["a", "b", "tag", "z"])],
	[1, element(NAMES)]
])

/** A JSON value a form property holds: scalars, lists and objects of them, and values nested deeper. */
const formValue: Gen<Json> = (source) => {
	const level = (depth: number): Gen<Json> =>
		depth === 0
			? jsonScalar
			: weighted<Json>([
					[3, jsonScalar],
					[1, array(level(depth - 1), { min: 0, max: 3 })],
					[1, objectWith(formName, level(depth - 1))]
				])
	return level(2)(source)
}

/** An Encoding Object as drawn: no RFC 6570 field at all, or some of them, the bracket and scalar switches beside. */
const encodingSpace: Gen<FormEncoding> = weighted<FormEncoding>([
	[3, constant({})],
	[
		3,
		(source) => {
			const style = option(
				element<QueryStyle>(["form", "spaceDelimited", "pipeDelimited", "deepObject"])
			)(source)
			const explode = option(boolean)(source)
			const allowReserved = option(boolean)(source)
			const brackets = option(boolean)(source)
			const scalars = option(boolean)(source)
			return {
				...Option.match(style, { onNone: () => ({}), onSome: (drawn) => ({ style: drawn }) }),
				...Option.match(explode, { onNone: () => ({}), onSome: (drawn) => ({ explode: drawn }) }),
				...Option.match(allowReserved, {
					onNone: () => ({}),
					onSome: (drawn) => ({ allowReserved: drawn })
				}),
				...Option.match(brackets, { onNone: () => ({}), onSome: (drawn) => ({ brackets: drawn }) }),
				...Option.match(scalars, { onNone: () => ({}), onSome: (drawn) => ({ scalars: drawn }) })
			}
		}
	]
])

/** How a form travels: as a request body, or as a form-urlencoded querystring parameter. */
export type Through = "body" | "querystring"

/** A form as drawn: how it travels, its media type, declared properties, value, refused fields and presence rule. */
export type FormCase = Readonly<{
	through: Through
	mediaType: string
	properties: ReadonlyArray<readonly [string, FormEncoding]>
	value: Option.Option<Json>
	refused: Option.Option<Readonly<Record<string, ReadonlyArray<string>>>>
	required: boolean
}>

/** A form's value: an object over drawn names, absent now and then, and now and then no object at all. */
const valueSpace: Gen<Option.Option<Json>> = weighted<Option.Option<Json>>([
	[8, map(objectWith(formName, formValue), Option.some)],
	[1, constant(Option.none())],
	[
		1,
		map(
			weighted<Json>([
				[1, array(text, { min: 0, max: 2 })],
				[1, text]
			]),
			Option.some
		)
	]
])

/**
 * A form as drawn: its declared properties are some of the value's names and some it lacks, in an order of their own,
 * none with half a surrogate pair (the generator refuses a document holding one: src/validate/surrogates.ts), where
 * an operator's own names may hold one.
 */
const formDrawn: Gen<FormCase> = (source) => {
	const value = valueSpace(source)
	const named = Option.match(value, {
		onNone: () => [],
		onSome: (held) => (Predicate.isObject(held) && !isJsonList(held) ? Rec.keys(held) : [])
	})
	const declared = Arr.filter(
		Arr.dedupe([
			...Arr.filter(named, () => boolean(source)),
			...array(formName, { min: 0, max: 2 })(source)
		]),
		(name) => !holdsLone(name)
	)
	const through = weighted<Through>([
		[4, constant("body")],
		[1, constant("querystring")]
	])(source)
	return {
		through,
		mediaType: weighted([
			[6, constant(FORM)],
			[1, constant("Application/X-WWW-Form-Urlencoded;charset=utf-8")],
			[
				through === "body" ? 1 : 6,
				constant(through === "body" ? "application/x-www-form-urlencoded\r\nX: y" : FORM)
			]
		])(source),
		properties: Arr.map(Arr.reverse(declared), (name) => [name, encodingSpace(source)] as const),
		value,
		refused: weighted<Option.Option<Readonly<Record<string, ReadonlyArray<string>>>>>([
			[3, constant(Option.none())],
			[2, constant(Option.some({ [FORM]: ["metadata"] }))],
			[1, constant(Option.some({ "multipart/form-data": ["a"] }))]
		])(source),
		required: boolean(source)
	}
}

/** The WHATWG `application/x-www-form-urlencoded` serializer of one name or value: URLSearchParams' own. */
const www = (piece: string): string => Str.slice(1)(new URLSearchParams([["", piece]]).toString())

/** What a form value may write raw under `allowReserved`: reserved less `&`, `=`, `+` and `#`, which stay encoded. */
const FORM_RESERVED = ":/?[]@!$'()*,;"

const tripletToken = regex("^%[0-9A-Fa-f]{2}$", "u")

const encoderTokens = regex("%[0-9A-Fa-f]{2}|[\\s\\S]", "gu")

/** The WHATWG serializer, but a percent triplet and each of the form's reserved set written raw. */
const wwwPassing = (piece: string): string =>
	Arr.join(
		Arr.map(
			Arr.map(Arr.fromIterable(Str.matchAll(encoderTokens)(piece)), ([token]) => token),
			(token) =>
				tripletToken.test(token) || (token !== " " && Str.includes(token)(FORM_RESERVED))
					? token
					: www(token)
		),
		""
	)

/** A form body's codec: names by the WHATWG serializer, values too or with the reserved set passing. */
const formCodec = (allowReserved: boolean): PairCodec => ({
	name: www,
	value: allowReserved ? wwwPassing : www,
	joiner: { form: ",", deepObject: ",", spaceDelimited: "+", pipeDelimited: "%7C" }
})

/** Whether an Encoding Object sets any RFC 6570 field, which takes the property off its default content type. */
const hasStyle = (encoding: FormEncoding): boolean =>
	encoding.style !== undefined ||
	encoding.explode !== undefined ||
	encoding.allowReserved !== undefined

/** No pair at all. */
const nothing: Styled = { pairs: [], members: false }

/**
 * A property under its Encoding Object's RFC 6570 fields (design 6.3): the query's rules with the form's codec, a
 * missing style form, a missing explode true exactly for form.
 */
const styledProperty = (name: string, value: Json, encoding: FormEncoding): Read<Styled> => {
	const style = encoding.style ?? "form"
	const allowReserved = encoding.allowReserved ?? false
	return Result.map(
		styledModel(
			{
				style,
				explode: encoding.explode ?? style === "form",
				allowReserved,
				brackets: encoding.brackets === true,
				scalars: encoding.scalars === true
			},
			name,
			value,
			formCodec(allowReserved)
		),
		Option.getOrElse(() => nothing)
	)
}

/** Whether a JSON value is a scalar. */
const isJsonScalar = (value: Json): boolean =>
	value instanceof JsonNumber || value instanceof JsonNull || !Predicate.isObjectOrArray(value)

/**
 * A property under its default content type (design 6.3): a null sends nothing, half a surrogate pair anywhere is
 * refused, a list repeats the name per item, a scalar is its text (a null item refused) and an object or a list item
 * that is a list its compact JSON (refused when a number has no JSON text).
 */
const contentProperty = (name: string, value: Json): Read<Styled> => {
	if (value instanceof JsonNull) {
		return Result.succeed(nothing)
	}
	if (jsonHoldsLone(value)) {
		return refused
	}
	const items = isJsonList(value) ? value : [value]
	return Result.map(
		Result.all(
			Arr.map(items, (item) =>
				isJsonScalar(item) && isScalar(item)
					? itemText(item)
					: Option.match(jsonModel(item), {
							onNone: (): Read<string> => refused,
							onSome: Result.succeed
						})
			)
		),
		(texts): Styled => ({
			pairs: Arr.map(texts, (written): SentPair => [www(name), www(written)]),
			members: false
		})
	)
}

/** Whether a value is a JSON object. */
const isJsonObject = (value: Json): value is JsonObject =>
	Predicate.isObject(value) &&
	!isJsonList(value) &&
	!(value instanceof JsonNumber) &&
	!(value instanceof JsonNull)

/**
 * A form's text (design 4.5, 6.3), or its refusal: each declared property in declared order, then each undeclared name
 * in the value's order under the default content type; a name with half a surrogate pair is refused; a pair name sent
 * by two properties, and a member-named pair named like any declared property, is refused (SM-9).
 */
const urlEncodeModel = (
	value: JsonObject,
	properties: ReadonlyArray<readonly [string, FormEncoding]>
): Read<string> => {
	const declared = Arr.map(properties, ([name]) => name)
	const undeclared = Arr.map(
		Arr.filter(Rec.keys(value), (name) => !Arr.contains(declared, name)),
		(name) => [name, {}] as const
	)
	const sent = Arr.flatMap([...properties, ...undeclared], ([name, encoding]) =>
		Option.match(Rec.get(value, name), {
			onNone: () => [],
			onSome: (held) => [
				Result.map(
					holdsLone(name)
						? refused
						: hasStyle(encoding)
							? styledProperty(name, held, encoding)
							: contentProperty(name, held),
					(styled) => [name, styled] as const
				)
			]
		})
	)
	return Result.flatMap(Result.all(sent), (properties_) => {
		const pairs = Arr.flatMap(properties_, ([name, styled]) =>
			Arr.map(styled.pairs, (pair) => [name, styled.members, pair] as const)
		)
		const declaredNames = Arr.map(declared, www)
		const sendersOf = (pairName: string) =>
			Arr.dedupe(Arr.flatMap(pairs, ([name, , [sent_]]) => (sent_ === pairName ? [name] : [])))
		const collides = Arr.some(
			pairs,
			([, members, [pairName]]) =>
				sendersOf(pairName).length > 1 || (members && Arr.contains(declaredNames, pairName))
		)
		return collides ? refused : Result.succeed(pairsText(Arr.map(pairs, ([, , pair]) => pair)))
	})
}

/** Whether a decoded pair name carries a refused field: the field itself, or a bracketed or dotted name under it. */
const carries = (field: string, pairName: string): boolean =>
	pairName === field ||
	Str.startsWith(`${field}[`)(pairName) ||
	Str.startsWith(`${field}.`)(pairName)

/**
 * A form's text with its refused fields guarded (design 4.5 Refused body fields, 8.5): a refused field among the
 * value's own names is refused even when it sends nothing; then every pair name the text carries, decoded as a server
 * decodes it, is refused when it carries a refused field, but a declared property's own name that is not refused.
 */
const guardedModel = (value: JsonObject, form: FormCase): Read<string> => {
	const names = Option.getOrElse(
		Option.flatMap(form.refused, (byMedia) => Rec.get(byMedia, form.mediaType)),
		(): ReadonlyArray<string> => []
	)
	if (Arr.some(Rec.keys(value), (key) => Arr.contains(names, key))) {
		return refused
	}
	return Result.flatMap(urlEncodeModel(value, form.properties), (written) => {
		const own = Arr.filter(
			Arr.map(form.properties, ([name]) => name),
			(name) => !Arr.contains(names, name)
		)
		const leaks = Arr.some(
			formPairs(new TextEncoder().encode(written)),
			([pairName]) =>
				!Arr.contains(own, pairName) && Arr.some(names, (name) => carries(name, pairName))
		)
		return leaks ? refused : Result.succeed(written)
	})
}

/** What a form sends: its text, or nothing (a body's none is no body at all, a querystring's no pair). */
export type FormSent = Option.Option<string>

/**
 * A form's outcome. A body (design 4.5 body presence): refused under a media type no header carries; absent, empty
 * text when required and no body otherwise; present, its guarded text, refused unless an object. A form querystring
 * (STY-42, STY-43): absent, refused when required and nothing otherwise; present, its text, refused unless an object.
 */
export const formModel = (form: FormCase): Read<FormSent> => {
	if (form.through === "body" && (form.mediaType === "" || breaksHeader(form.mediaType))) {
		return refused
	}
	return Option.match(form.value, {
		onNone: (): Read<FormSent> =>
			form.through === "body"
				? Result.succeed(form.required ? Option.some("") : Option.none())
				: form.required
					? refused
					: Result.succeed(Option.none()),
		onSome: (held): Read<FormSent> =>
			isJsonObject(held)
				? Result.map(
						form.through === "body"
							? guardedModel(held, form)
							: urlEncodeModel(held, form.properties),
						Option.some
					)
				: refused
	})
}

/** The situations a form reaches. */
export type FormFeature =
	| "space written as plus"
	| "name encoded"
	| "default content scalar"
	| "default content object as JSON"
	| "default content list repeats its name"
	| "default content list item as JSON"
	| "digit text kept"
	| "null property omitted"
	| "styled list joined"
	| "styled object exploded"
	| "delimited style"
	| "deepObject members"
	| "bracket convention"
	| "scalar under deepObject"
	| "reserved character passed"
	| "declared order kept"
	| "undeclared name follows"
	| "nested styled value refused"
	| "number with no JSON text refused"
	| "lone surrogate refused"
	| "member named like a declared property refused"
	| "pair name from two properties refused"
	| "refused field named refused"
	| "refused field named though it sends nothing refused"
	| "refused field carried by a pair refused"
	| "refused field carried by a bracketed pair refused"
	| "refused field of another media sent"
	| "absent body"
	| "empty body text"
	| "value not an object refused"
	| "form querystring sent"

/** Every property a form sends, by name, with its value and encoding: declared first, then undeclared. */
const propertiesOf = (form: FormCase): ReadonlyArray<readonly [string, Json, FormEncoding]> =>
	Option.match(form.value, {
		onNone: (): ReadonlyArray<readonly [string, Json, FormEncoding]> => [],
		onSome: (held): ReadonlyArray<readonly [string, Json, FormEncoding]> => {
			if (!isJsonObject(held)) {
				return []
			}
			const declared = Arr.map(form.properties, ([name]) => name)
			const undeclared = Arr.map(
				Arr.filter(Rec.keys(held), (name) => !Arr.contains(declared, name)),
				(name): readonly [string, FormEncoding] => [name, {}]
			)
			return Arr.flatMap([...form.properties, ...undeclared], ([name, encoding]) =>
				Option.match(Rec.get(held, name), {
					onNone: (): ReadonlyArray<readonly [string, Json, FormEncoding]> => [],
					onSome: (value) => [[name, value, encoding] as const]
				})
			)
		}
	})

/** What a form's case reaches. */
export const formFeatures = (form: FormCase): ReadonlyArray<FormFeature> => {
	const read = formModel(form)
	const sent = Result.isSuccess(read)
	const properties = propertiesOf(form)
	const styled = Arr.filter(properties, ([, , encoding]) => hasStyle(encoding))
	const plain = Arr.filter(properties, ([, , encoding]) => !hasStyle(encoding))
	const alone = (name: string, value: Json, encoding: FormEncoding): Read<Styled> =>
		hasStyle(encoding) ? styledProperty(name, value, encoding) : contentProperty(name, value)
	const each = Arr.map(
		properties,
		([name, value, encoding]) => [name, value, encoding, alone(name, value, encoding)] as const
	)
	const fine = Arr.every(each, ([, , , one]) => Result.isSuccess(one))
	const refusedNames = Option.getOrElse(
		Option.flatMap(form.refused, (byMedia) => Rec.get(byMedia, form.mediaType)),
		(): ReadonlyArray<string> => []
	)
	const unguarded = Option.match(form.value, {
		onNone: () => false,
		onSome: (held) => isJsonObject(held) && Result.isSuccess(urlEncodeModel(held, form.properties))
	})
	const style = (encoding: FormEncoding) => encoding.style ?? "form"
	const stringsIn = (value: Json): ReadonlyArray<string> =>
		Predicate.isString(value)
			? [value]
			: isJsonList(value)
				? Arr.flatMap(value, stringsIn)
				: isJsonObject(value)
					? Arr.flatMap(Rec.toEntries(value), ([key, member]) => [key, ...stringsIn(member)])
					: []
	const digits = (value: Json): boolean =>
		value instanceof JsonNumber ||
		(isJsonList(value)
			? Arr.some(value, digits)
			: isJsonObject(value) && Arr.some(Rec.values(value), digits))
	const declaredNames = Arr.map(form.properties, ([name]) => name)
	return holding<FormFeature>([
		[
			"space written as plus",
			sent && Arr.some(properties, ([, value]) => Arr.some(stringsIn(value), Str.includes(" ")))
		],
		["name encoded", sent && Arr.some(properties, ([name]) => www(name) !== name)],
		[
			"default content scalar",
			sent && Arr.some(plain, ([, value]) => isJsonScalar(value) && !(value instanceof JsonNull))
		],
		["default content object as JSON", sent && Arr.some(plain, ([, value]) => isJsonObject(value))],
		[
			"default content list repeats its name",
			sent && Arr.some(plain, ([, value]) => isJsonList(value) && value.length > 1)
		],
		[
			"default content list item as JSON",
			sent &&
				Arr.some(
					plain,
					([, value]) => isJsonList(value) && Arr.some(value, (item) => !isJsonScalar(item))
				)
		],
		["digit text kept", sent && Arr.some(properties, ([, value]) => digits(value))],
		[
			"null property omitted",
			sent && Arr.some(properties, ([, value]) => value instanceof JsonNull)
		],
		[
			"styled list joined",
			sent &&
				Arr.some(
					styled,
					([, value, encoding]) =>
						isJsonList(value) &&
						value.length > 1 &&
						style(encoding) === "form" &&
						encoding.explode === false
				)
		],
		[
			"styled object exploded",
			sent &&
				Arr.some(
					styled,
					([, value, encoding]) =>
						isJsonObject(value) && style(encoding) === "form" && encoding.explode !== false
				)
		],
		[
			"delimited style",
			sent &&
				Arr.some(
					styled,
					([, value, encoding]) =>
						(style(encoding) === "spaceDelimited" || style(encoding) === "pipeDelimited") &&
						isJsonList(value) &&
						value.length > 1
				)
		],
		[
			"deepObject members",
			sent &&
				Arr.some(
					styled,
					([, value, encoding]) =>
						style(encoding) === "deepObject" && isJsonObject(value) && Rec.keys(value).length > 0
				)
		],
		[
			"bracket convention",
			sent &&
				Arr.some(
					styled,
					([, value, encoding]) =>
						style(encoding) === "deepObject" &&
						encoding.brackets === true &&
						(isJsonList(value) ||
							(isJsonObject(value) &&
								Arr.some(Rec.values(value), (member) => !isJsonScalar(member))))
				)
		],
		[
			"scalar under deepObject",
			sent &&
				Arr.some(
					styled,
					([, value, encoding]) =>
						style(encoding) === "deepObject" &&
						encoding.scalars === true &&
						isJsonScalar(value) &&
						!(value instanceof JsonNull)
				)
		],
		[
			"reserved character passed",
			sent &&
				Arr.some(
					styled,
					([, value, encoding]) =>
						encoding.allowReserved === true &&
						Arr.some(stringsIn(value), (piece) =>
							Arr.some(Arr.fromIterable(FORM_RESERVED), (raw) => Str.includes(raw)(piece))
						)
				)
		],
		[
			"declared order kept",
			sent &&
				form.properties.length > 1 &&
				Arr.filter(properties, ([name]) => Arr.contains(declaredNames, name)).length > 1
		],
		[
			"undeclared name follows",
			sent &&
				Arr.some(properties, ([name]) => !Arr.contains(declaredNames, name)) &&
				Arr.some(properties, ([name]) => Arr.contains(declaredNames, name))
		],
		[
			"nested styled value refused",
			Arr.some(each, ([, , encoding, one]) => hasStyle(encoding) && Result.isFailure(one))
		],
		[
			"number with no JSON text refused",
			Arr.some(properties, ([, value]) => Option.isNone(jsonModel(value)))
		],
		[
			"lone surrogate refused",
			Arr.some(properties, ([name, value]) => holdsLone(name) || jsonHoldsLone(value))
		],
		[
			"member named like a declared property refused",
			fine &&
				!unguarded &&
				Arr.some(
					each,
					([name, , , one]) =>
						Result.isSuccess(one) &&
						one.success.members &&
						Arr.some(
							one.success.pairs,
							([pairName]) =>
								Arr.contains(Arr.map(declaredNames, www), pairName) &&
								!Arr.some(
									each,
									([other, , , theirs]) =>
										other !== name &&
										Result.isSuccess(theirs) &&
										Arr.some(theirs.success.pairs, ([sent_]) => sent_ === pairName)
								)
						)
				)
		],
		[
			"pair name from two properties refused",
			fine &&
				!unguarded &&
				!Arr.some(
					each,
					([, , , one]) =>
						Result.isSuccess(one) &&
						one.success.members &&
						Arr.some(one.success.pairs, ([pairName]) =>
							Arr.contains(Arr.map(declaredNames, www), pairName)
						)
				)
		],
		[
			"refused field named refused",
			form.through === "body" &&
				Option.exists(
					form.value,
					(held) =>
						isJsonObject(held) && Arr.some(Rec.keys(held), (key) => Arr.contains(refusedNames, key))
				)
		],
		[
			"refused field carried by a pair refused",
			form.through === "body" &&
				unguarded &&
				!sent &&
				Option.exists(
					form.value,
					(held) =>
						isJsonObject(held) &&
						!Arr.some(Rec.keys(held), (key) => Arr.contains(refusedNames, key))
				)
		],
		[
			"refused field carried by a bracketed pair refused",
			form.through === "body" &&
				unguarded &&
				!sent &&
				Option.exists(
					form.value,
					(held) =>
						isJsonObject(held) &&
						!Arr.some(Rec.keys(held), (key) => Arr.contains(refusedNames, key))
				) &&
				Arr.some(
					each,
					([, , , one]) =>
						Result.isSuccess(one) &&
						Arr.some(one.success.pairs, ([pairName]) =>
							Arr.some(refusedNames, (field) => Str.startsWith(www(`${field}[`))(pairName))
						)
				)
		],
		[
			"refused field named though it sends nothing refused",
			form.through === "body" &&
				Arr.some(
					each,
					([name, , , one]) =>
						Arr.contains(refusedNames, name) &&
						Result.isSuccess(one) &&
						one.success.pairs.length === 0
				)
		],
		[
			"refused field of another media sent",
			sent &&
				form.through === "body" &&
				Option.exists(form.refused, (byMedia) => Option.isNone(Rec.get(byMedia, form.mediaType)))
		],
		["absent body", sent && Option.isNone(form.value)],
		[
			"empty body text",
			Result.isSuccess(read) &&
				Option.exists(read.success, Str.isEmpty) &&
				Option.isSome(form.value)
		],
		["value not an object refused", Option.exists(form.value, (held) => !isJsonObject(held))],
		["form querystring sent", sent && form.through === "querystring" && Option.isSome(form.value)]
	])
}

/** A plain text of a letter or two. */
const plainText: Gen<string> = (source) =>
	`${element(["a", "b", "x"])(source)}${element(["", "y", " z"])(source)}`

/** A form body of one or two declared properties, the first under `encoding` holding `value`. */
const oneProperty =
	(encoding: FormEncoding, value: Gen<Json>, beside: ReadonlyArray<string>): Gen<FormCase> =>
	(source) => ({
		through: "body",
		mediaType: FORM,
		properties: [["tag", encoding], ...Arr.map(beside, (name) => [name, {}] as const)],
		value: Option.some({
			tag: value(source),
			...Rec.fromEntries(Arr.map(beside, (name) => [name, plainText(source)] as const))
		}),
		refused: Option.none(),
		required: true
	})

/**
 * A form, aimed at a non-exploded styled list, a bracketed deepObject value, and an exploded object one of whose
 * members is named like a declared property.
 */
export const formSpace = aimed<FormCase, FormFeature>(formDrawn, [
	[
		"styled list joined",
		(source) =>
			oneProperty(
				{ style: "form", explode: false, allowReserved: boolean(source) },
				array(plainText, { min: 2, max: 3 }),
				[]
			)(source)
	],
	[
		"bracket convention",
		(source) =>
			oneProperty(
				{ style: "deepObject", brackets: true },
				weighted<Json>([
					[1, array(plainText, { min: 1, max: 2 })],
					[
						1,
						(inner) => ({
							b: { c: plainText(inner) },
							d: [plainText(inner), { e: plainText(inner) }]
						})
					]
				]),
				[]
			)(source)
	],
	[
		"styled object exploded",
		(source) =>
			oneProperty(
				{
					style: weighted<QueryStyle>([
						[2, constant("form")],
						[1, constant("deepObject")]
					])(source),
					explode: true
				},
				(inner) => ({ R: plainText(inner), "G B": plainText(inner) }),
				[]
			)(source)
	],
	[
		"member named like a declared property refused",
		(source) => {
			const form = oneProperty(
				{ explode: true },
				(inner) => ({ [element(["a", "tag"])(inner)]: plainText(inner) }),
				[]
			)(source)
			return { ...form, properties: [...form.properties, ["a", {}]] }
		}
	],
	[
		"refused field carried by a bracketed pair refused",
		(source) => ({
			through: "body",
			mediaType: FORM,
			properties: [["a", {}]],
			value: Option.some({
				a: plainText(source),
				[element(["metadata[a]", "metadata[a][b]"])(source)]: plainText(source)
			}),
			refused: Option.some({ [FORM]: ["metadata"] }),
			required: false
		})
	],
	[
		"refused field named though it sends nothing refused",
		(source) => ({
			through: "body",
			mediaType: FORM,
			properties: [
				["a", {}],
				["metadata", {}]
			],
			value: Option.some({
				a: plainText(source),
				metadata: weighted<Json>([
					[1, constant(jsonNull)],
					[1, constant([])]
				])(source)
			}),
			refused: Option.some({ [FORM]: ["metadata"] }),
			required: false
		})
	]
])
