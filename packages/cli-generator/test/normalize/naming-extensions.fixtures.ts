/** What the property of naming-extensions.test.ts reads: its naming sketches and the naming design 4.4 states. */

import {
	array,
	boolean,
	constant,
	type Gen,
	oneOf,
	option,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { pointerOrder } from "#model/diagnostic.ts"
import type { Json } from "#model/pointer.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { documentAt, lineGen, normalizedAt } from "#test/support/normalizing.ts"

/** A group as written: a dotted string of segments, an array of strings, or a value of another shape. */
type GroupValue =
	| Readonly<{ kind: "dotted"; segments: Arr.NonEmptyReadonlyArray<string> }>
	| Readonly<{ kind: "array"; elements: ReadonlyArray<string> }>
	| Readonly<{ kind: "other"; value: Json }>

/** A method as written: a name, the empty string, or a value of another shape. */
type MethodValue =
	| Readonly<{ kind: "name"; name: string }>
	| Readonly<{ kind: "other"; value: Json }>

/** One source's keys as written: a group and a method, each present or not. */
type HintSketch = Readonly<{ group: Option.Option<GroupValue>; method: Option.Option<MethodValue> }>

/** An `x-forge-aliases` element: no object, or an object with its own hints and `operationId`. */
type AliasSketch =
	| Readonly<{ kind: "notObject" }>
	| Readonly<{
			kind: "object"
			forge: HintSketch
			fern: HintSketch
			operationId: Option.Option<MethodValue>
			nested: boolean
	  }>

/** An operation's naming extensions: its Forge and Fern hints, its aliases, and its own operationId. */
type NamingSketch = Readonly<{
	line: SpecLine
	forge: HintSketch
	fern: HintSketch
	aliases: Option.Option<
		| Readonly<{ kind: "notArray" }>
		| Readonly<{ kind: "array"; elements: ReadonlyArray<AliasSketch> }>
	>
	operationId: boolean
}>

/** What a case reaches. */
export type NamingFeature =
	| "dotted group"
	| "array group"
	| "group of another shape"
	| "group with an empty segment"
	| "method alone"
	| "group alone"
	| "fern and forge together"
	| "method of another shape"
	| "usable alias by its own keys"
	| "alias by its operationId alone"
	| "unnamed alias"
	| "alias that is no object"
	| "aliases that are no array"
	| "no usable alias"
	| "nested aliases ignored"
	| "operationId never inherited"
	| "malformed value inside an alias"
	| "no naming"

const segment: Gen<string> = weighted([
	[
		4,
		oneOf([constant("accounts"), constant("members"), constant("zones"), constant("hyperdrive")])
	],
	[1, constant("")]
])

const group: Gen<GroupValue> = weighted([
	[
		3,
		(source): GroupValue => ({
			kind: "dotted",
			segments: [segment(source), ...array(segment, { min: 0, max: 2 })(source)]
		})
	],
	[
		2,
		(source): GroupValue => ({
			kind: "array",
			elements: array(
				weighted([
					[4, oneOf([constant("accounts"), constant("members.v2")])],
					[1, constant("")]
				]),
				{ min: 0, max: 2 }
			)(source)
		})
	],
	[
		1,
		oneOf([
			constant<GroupValue>({ kind: "other", value: 7 }),
			constant<GroupValue>({ kind: "other", value: { name: "accounts" } }),
			constant<GroupValue>({ kind: "other", value: null }),
			constant<GroupValue>({ kind: "other", value: ["accounts", 1] })
		])
	]
])

const method: Gen<MethodValue> = weighted([
	[
		4,
		oneOf([
			constant<MethodValue>({ kind: "name", name: "list" }),
			constant<MethodValue>({ kind: "name", name: "getHeartbeat" })
		])
	],
	[
		1,
		oneOf([
			constant<MethodValue>({ kind: "other", value: "" }),
			constant<MethodValue>({ kind: "other", value: 3 }),
			constant<MethodValue>({ kind: "other", value: ["list"] }),
			constant<MethodValue>({ kind: "other", value: null })
		])
	]
])

const hint: Gen<HintSketch> = (source) => ({
	group: weighted<Option.Option<GroupValue>>([
		[1, constant(Option.none())],
		[1, (inner) => Option.some(group(inner))]
	])(source),
	method: weighted<Option.Option<MethodValue>>([
		[1, constant(Option.none())],
		[1, (inner) => Option.some(method(inner))]
	])(source)
})

const alias: Gen<AliasSketch> = weighted([
	[1, constant<AliasSketch>({ kind: "notObject" })],
	[
		5,
		(source): AliasSketch => ({
			kind: "object",
			forge: hint(source),
			fern: hint(source),
			operationId: weighted<Option.Option<MethodValue>>([
				[2, constant(Option.none())],
				[1, (inner) => Option.some(method(inner))]
			])(source),
			nested: boolean(source) && boolean(source)
		})
	]
])

/** An operation's naming extensions, each key drawn present or absent, usable or malformed. */
export const namingSpace: Gen<NamingSketch> = (source) => ({
	line: lineGen(source),
	forge: hint(source),
	fern: hint(source),
	aliases: option(
		weighted<
			| Readonly<{ kind: "notArray" }>
			| Readonly<{ kind: "array"; elements: ReadonlyArray<AliasSketch> }>
		>([
			[1, constant({ kind: "notArray" })],
			[5, (inner) => ({ kind: "array", elements: array(alias, { min: 0, max: 3 })(inner) })]
		])
	)(source),
	operationId: boolean(source)
})

const keys = {
	forge: { group: "x-forge-group-name", method: "x-forge-method-name" },
	fern: { group: "x-fern-sdk-group-name", method: "x-fern-sdk-method-name" }
} as const

/** A group's JSON. */
const groupJson = (value: GroupValue): Json => {
	switch (value.kind) {
		case "dotted":
			return Arr.join(value.segments, ".")
		case "array":
			return value.elements
		case "other":
			return value.value
	}
}

/** A method's JSON. */
const methodJson = (value: MethodValue): Json => (value.kind === "name" ? value.name : value.value)

/** The members one source's hint writes. */
const hintJson = (
	source: keyof typeof keys,
	value: HintSketch
): Readonly<Record<string, Json>> => ({
	...Option.match(value.group, {
		onNone: () => ({}),
		onSome: (each) => ({ [keys[source].group]: groupJson(each) })
	}),
	...Option.match(value.method, {
		onNone: () => ({}),
		onSome: (each) => ({ [keys[source].method]: methodJson(each) })
	})
})

const aliasJson = (value: AliasSketch): Json =>
	value.kind === "notObject"
		? 5
		: {
				...hintJson("forge", value.forge),
				...hintJson("fern", value.fern),
				...Option.match(value.operationId, {
					onNone: () => ({}),
					onSome: (each) => ({ operationId: methodJson(each) })
				}),
				...(value.nested ? { "x-forge-aliases": "not read" } : {})
			}

/** The operation's pointer. */
const operationPointer = "/paths/~1a/get"

/** The document holding the one operation and its naming extensions. */
const documentOf = (sketch: NamingSketch): Json =>
	documentAt(sketch.line, {
		paths: {
			"/a": {
				get: {
					responses: { "200": { description: "ok" } },
					...(sketch.operationId ? { operationId: "parentId" } : {}),
					...hintJson("forge", sketch.forge),
					...hintJson("fern", sketch.fern),
					...Option.match(sketch.aliases, {
						onNone: () => ({}),
						onSome: (value) => ({
							"x-forge-aliases":
								value.kind === "notArray"
									? { "x-forge-method-name": "m" }
									: Arr.map(value.elements, aliasJson)
						})
					})
				}
			}
		}
	})

/** A naming notice: its code and pointer. */
type Notice = readonly [code: string, pointer: string]

/** A value read, with the notices reading it raised. */
type Read<A> = Readonly<{ notices: ReadonlyArray<Notice>; value: Option.Option<A> }>

/** A group's segments, when the value is a usable group: a dotted string split at `.`, or an array kept whole. */
const segmentsOf = (value: GroupValue): Option.Option<Arr.NonEmptyReadonlyArray<string>> => {
	const segments =
		value.kind === "dotted" ? value.segments : value.kind === "array" ? value.elements : []
	return value.kind !== "other" &&
		Arr.isReadonlyArrayNonEmpty(segments) &&
		Arr.every(segments, (each) => each !== "")
		? Option.some(segments)
		: Option.none()
}

/** A method's name, when the value is a non-empty string. */
const nameOf = (value: MethodValue): Option.Option<string> =>
	value.kind === "name" ? Option.some(value.name) : Option.none()

/** A hint as the model reads it. */
type HintModel = Readonly<{
	group: Option.Option<ReadonlyArray<string>>
	method: Option.Option<string>
	pointer: string
}>

/** One source's hint at `pointer`: absent when neither key is usable; each unusable key noticed at itself. */
const hintOf = (value: HintSketch, source: keyof typeof keys, pointer: string): Read<HintModel> => {
	const groupRead = Option.map(value.group, segmentsOf)
	const methodRead = Option.map(value.method, nameOf)
	const notices: ReadonlyArray<Notice> = [
		...(Option.exists(groupRead, Option.isNone)
			? [["EXT-01/naming-invalid", `${pointer}/${keys[source].group}`] as const]
			: []),
		...(Option.exists(methodRead, Option.isNone)
			? [["EXT-01/naming-invalid", `${pointer}/${keys[source].method}`] as const]
			: [])
	]
	const groupValue = Option.flatten(groupRead)
	const methodValue = Option.flatten(methodRead)
	return {
		notices,
		value:
			Option.isNone(groupValue) && Option.isNone(methodValue)
				? Option.none()
				: Option.some({ group: groupValue, method: methodValue, pointer })
	}
}

/** An alias as the model reads it. */
type AliasModel = Readonly<{
	fern: Option.Option<HintModel>
	forge: Option.Option<HintModel>
	index: number
	operationId: Option.Option<string>
}>

/** One alias at its index: usable when its own hints give a group and a method, or when it has its own operationId. */
const aliasOf = (value: AliasSketch, index: number): Read<AliasModel> => {
	const pointer = `${operationPointer}/x-forge-aliases/${index}`
	if (value.kind === "notObject") {
		return { notices: [["EXT-01/naming-invalid", pointer]], value: Option.none() }
	}
	const forge = hintOf(value.forge, "forge", pointer)
	const fern = hintOf(value.fern, "fern", pointer)
	const hints = [...Option.toArray(forge.value), ...Option.toArray(fern.value)]
	const named =
		Arr.some(hints, (each) => Option.isSome(each.group)) &&
		Arr.some(hints, (each) => Option.isSome(each.method))
	const operationId = Option.flatMap(value.operationId, nameOf)
	const notices: ReadonlyArray<Notice> = [
		...forge.notices,
		...fern.notices,
		...(Option.isSome(value.operationId) && Option.isNone(operationId)
			? [["EXT-01/naming-invalid", `${pointer}/operationId`] as const]
			: [])
	]
	if (!named && Option.isNone(operationId)) {
		return { notices: [...notices, ["EXT-01/alias-unnamed", pointer]], value: Option.none() }
	}
	return {
		notices,
		value: Option.some({ fern: fern.value, forge: forge.value, index, operationId })
	}
}

/** The operation's naming as design 4.4 states it, and its notices in document order. */
type NamingModel = Readonly<{
	naming: Option.Option<
		Readonly<{
			aliases: Option.Option<ReadonlyArray<AliasModel>>
			fern: Option.Option<HintModel>
			forge: Option.Option<HintModel>
		}>
	>
	notices: ReadonlyArray<Notice>
}>

/** The operation's naming and notices, as design 4.4 states them. */
export const expectedOf = (sketch: NamingSketch): NamingModel => {
	const forge = hintOf(sketch.forge, "forge", operationPointer)
	const fern = hintOf(sketch.fern, "fern", operationPointer)
	const aliases: Read<ReadonlyArray<AliasModel>> = Option.match(sketch.aliases, {
		onNone: () => ({ notices: [], value: Option.none() }),
		onSome: (value) => {
			const read = value.kind === "array" ? Arr.map(value.elements, aliasOf) : []
			const usable = Arr.getSomes(Arr.map(read, (one) => one.value))
			const notices = Arr.flatMap(read, (one) => one.notices)
			return Arr.isReadonlyArrayNonEmpty(usable)
				? { notices, value: Option.some(usable) }
				: {
						notices: [["EXT-01/naming-invalid", `${operationPointer}/x-forge-aliases`], ...notices],
						value: Option.none()
					}
		}
	})
	return {
		naming:
			Option.isNone(forge.value) && Option.isNone(fern.value) && Option.isNone(aliases.value)
				? Option.none()
				: Option.some({ aliases: aliases.value, fern: fern.value, forge: forge.value }),
		notices: Arr.sort(
			[...forge.notices, ...fern.notices, ...aliases.notices],
			Order.combine(
				Order.mapInput(pointerOrder, ([, pointer]: Notice) => pointer),
				Order.mapInput(Order.String, ([code]: Notice) => code)
			)
		)
	}
}

/** A hint as the operation entity holds it. */
type HintEntity = Readonly<{ group?: ReadonlyArray<string>; method?: string; pointer: string }>

const hintModel = (value: HintEntity | undefined): Option.Option<HintModel> =>
	Option.map(Option.fromUndefinedOr(value), (each) => ({
		group: Option.fromUndefinedOr(each.group),
		method: Option.fromUndefinedOr(each.method),
		pointer: each.pointer
	}))

/** The operation's naming and EXT-01 notices as normalize gives them. */
export const actualOf = (sketch: NamingSketch) =>
	Effect.gen(function* () {
		const { api, diagnostics } = yield* normalizedAt(sketch.line, documentOf(sketch), {})
		const operation = Arr.head(api.operations)
		const model: NamingModel = {
			naming: Option.flatMap(operation, (found) =>
				Option.map(Option.fromUndefinedOr(found.naming), (naming) => ({
					aliases: Option.map(Option.fromUndefinedOr(naming.aliases), (list) =>
						Arr.map(list, (each) => ({
							fern: hintModel(each.fern),
							forge: hintModel(each.forge),
							index: each.index,
							operationId: Option.fromUndefinedOr(each.operationId)
						}))
					),
					fern: hintModel(naming.fern),
					forge: hintModel(naming.forge)
				}))
			),
			notices: Arr.map(
				Arr.filter(diagnostics, (each) => each.row === "EXT-01"),
				(each): Notice => [each.code, String(each.pointer)]
			)
		}
		return model
	})

/** The features a sketch and its model reach. */
export const namingFeatures = (
	sketch: NamingSketch,
	model: NamingModel
): ReadonlyArray<NamingFeature> => {
	const groups = Arr.getSomes([sketch.forge.group, sketch.fern.group])
	const methods = Arr.getSomes([sketch.forge.method, sketch.fern.method])
	const elements = Option.match(sketch.aliases, {
		onNone: () => [],
		onSome: (value) => (value.kind === "array" ? value.elements : [])
	})
	const objects = Arr.filter(elements, (each) => each.kind === "object")
	const codes = Arr.map(model.notices, ([code, pointer]) => `${code} ${pointer}`)
	const naming = Option.getOrUndefined(model.naming)
	const usable = Option.getOrElse(
		Option.flatMap(model.naming, (value) => value.aliases),
		() => []
	)
	const facts: ReadonlyArray<readonly [boolean, NamingFeature]> = [
		[
			Arr.some(
				groups,
				(each) =>
					each.kind === "dotted" && each.segments.length > 1 && Option.isSome(segmentsOf(each))
			),
			"dotted group"
		],
		[
			Arr.some(groups, (each) => each.kind === "array" && Option.isSome(segmentsOf(each))),
			"array group"
		],
		[Arr.some(groups, (each) => each.kind === "other"), "group of another shape"],
		[
			Arr.some(groups, (each) => each.kind !== "other" && Option.isNone(segmentsOf(each))),
			"group with an empty segment"
		],
		[
			Option.exists(Option.fromUndefinedOr(naming), (value) =>
				Option.exists(
					value.forge,
					(each) => Option.isNone(each.group) && Option.isSome(each.method)
				)
			),
			"method alone"
		],
		[
			Option.exists(Option.fromUndefinedOr(naming), (value) =>
				Option.exists(value.fern, (each) => Option.isSome(each.group) && Option.isNone(each.method))
			),
			"group alone"
		],
		[
			Option.exists(
				Option.fromUndefinedOr(naming),
				(value) => Option.isSome(value.fern) && Option.isSome(value.forge)
			),
			"fern and forge together"
		],
		[Arr.some(methods, (each) => each.kind === "other"), "method of another shape"],
		[Arr.some(usable, (each) => Option.isNone(each.operationId)), "usable alias by its own keys"],
		[
			Arr.some(
				usable,
				(each) =>
					Option.isSome(each.operationId) && Option.isNone(each.forge) && Option.isNone(each.fern)
			),
			"alias by its operationId alone"
		],
		[Arr.some(codes, (each) => Str.startsWith("EXT-01/alias-unnamed")(each)), "unnamed alias"],
		[Arr.some(elements, (each) => each.kind === "notObject"), "alias that is no object"],
		[
			Option.exists(sketch.aliases, (value) => value.kind === "notArray"),
			"aliases that are no array"
		],
		[Option.isSome(sketch.aliases) && !Arr.isReadonlyArrayNonEmpty(usable), "no usable alias"],
		[Arr.some(objects, (each) => each.nested), "nested aliases ignored"],
		[sketch.operationId && Arr.isReadonlyArrayNonEmpty(objects), "operationId never inherited"],
		[
			Arr.some(
				codes,
				(each) =>
					Str.includes("/x-forge-aliases/")(each) && Str.startsWith("EXT-01/naming-invalid")(each)
			),
			"malformed value inside an alias"
		],
		[Option.isNone(model.naming), "no naming"]
	]
	return Arr.map(
		Arr.filter(facts, ([holds]) => holds),
		([, feature]) => feature
	)
}
