/**
 * The codecs of a served program's wire shape (live/shape.ts MemberWire): the server's encode of its rows, keys,
 * outcomes and errors and its exact parse of a caller's input, and the client's trusting decode of the server's frames
 * and its encode of an input, each an interpreter of the one shape over the one scalar table (live/wire.ts).
 *
 * The server reads its own values (a decoded row, an outcome, a CallError) as unknown, since a row is a record no type
 * ties to its heading at run time: a value of another shape there is a defect, and throws. The client reads the
 * server's frames trusting them, as grizzle reads its own rows, through the frames' JSON alone.
 *
 * Runtime-free and browser-safe, as live/wire.ts is.
 */
import type { Path } from "#compiler/core/canonical.ts"
import { type TransientTag, transientTags } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { isList, isPlainRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted } from "#compiler/core/trusted.ts"
import {
	type CallError,
	type CallErrorKind,
	callError,
	callErrors,
	type Slot,
	type SlotValues
} from "#compiler/live/events.ts"
import { type KeyFields, RowKey } from "#compiler/live/key.ts"
import type { Anchor, Empty, Input, Window, WindowInput } from "#compiler/live/program.ts"
import type {
	MemberWire,
	WireFacts,
	WireFault,
	WireField,
	WireHeading,
	WireInput,
	WireOptions,
	WireParam,
	WireRecord,
	WireWitness
} from "#compiler/live/shape.ts"
import {
	decodeScalar,
	encodeScalar,
	parseScalar,
	sameJson,
	trustedArray,
	trustedMember,
	trustedRecord,
	trustedString,
	type WireJson,
	type WireScalar
} from "#compiler/live/wire.ts"
import type { Refused, Witness } from "#compiler/types/changeset/changeset.ts"

/** The text of a wire value: the one door to JSON.stringify for the wire's JSON, which holds null. */
export const wireText = (json: WireJson): string => JSON.stringify(json)

/** An own member of a value the server holds, which its shape says it has: a defect where it has none. */
const ownMember = (value: unknown, name: string): unknown => {
	if (typeof value !== "object" || value === null || !Object.hasOwn(value, name)) {
		throw defect(`a wire value holding its member ${name}`)
	}
	return Reflect.getOwnPropertyDescriptor(value, name)?.value
}

/** Whether a value holds exactly the members `names`, each its own. */
const holdsExactly = (value: object, names: ReadonlyArray<string>): boolean => {
	const own = Object.keys(value)
	return own.length === names.length && names.every((name) => Object.hasOwn(value, name))
}

/** The heading of `record` whose names a value holds exactly: the one heading for one, a union's by its keys. */
const headingOf = <L>(record: WireRecord<L>, value: object): WireHeading<L> | undefined => {
	const [first, ...rest] = record
	if (rest.length === 0) {
		return first
	}
	return record.find((heading) =>
		holdsExactly(
			value,
			heading.map((named) => named.name)
		)
	)
}

/** A frozen null-prototype record of `entries`, as grizzle's decoders build every record they deliver. */
const deliveredRecord = (
	entries: ReadonlyArray<readonly [string, unknown]>
): Readonly<Record<string, unknown>> => {
	const out: Record<string, unknown> = { __proto__: null }
	for (const [name, value] of entries) {
		out[name] = value
	}
	return Object.freeze(out)
}

/** The JSON of a field's value the server holds. */
const encodeField = (
	field: WireField<WireScalar>,
	value: unknown,
	options: WireOptions
): WireJson => {
	switch (field.kind) {
		case "scalar":
		case "constant":
			return encodeScalar(field.scalar, value)
		case "attachment":
			switch (field.delivery) {
				case "array":
					if (!isList(value)) {
						throw defect("an array attachment's children")
					}
					return value.map((child) => encodeRecord(field.child, child, options))
				case "option":
					return encodeOption(field.child, value, options)
				case "one":
					return encodeRecord(field.child, value, options)
			}
		case "arm":
		case "some":
		case "none":
			return encodeOption(field.child, value, options)
	}
}

/** The JSON of an Option of a child record: null for None, the child's record for Some. */
const encodeOption = (
	child: WireRecord<WireScalar>,
	value: unknown,
	options: WireOptions
): WireJson => {
	if (!options.is(value)) {
		throw defect("an Option of a child record")
	}
	return options.match(value, {
		onNone: (): WireJson => null,
		onSome: (record) => encodeRecord(child, record, options)
	})
}

/** The JSON of a record the server delivers: an object of its heading's fields, each encoded. */
export const encodeRecord = (
	record: WireRecord<WireScalar>,
	row: unknown,
	options: WireOptions
): WireJson => {
	if (typeof row !== "object" || row === null) {
		throw defect("a delivered record")
	}
	const heading = headingOf(record, row)
	if (heading === undefined) {
		throw defect("a delivered record of one of its record's headings")
	}
	const out: Record<string, WireJson> = {}
	for (const named of heading) {
		out[named.name] = encodeField(named.field, ownMember(row, named.name), options)
	}
	return out
}

/** A field's value from the server's own JSON. */
const decodeField = (
	field: WireField<WireScalar>,
	json: WireJson,
	options: WireOptions
): unknown => {
	switch (field.kind) {
		case "scalar":
		case "constant":
			return decodeScalar(field.scalar, json)
		case "attachment":
			switch (field.delivery) {
				case "array":
					return Object.freeze(
						trustedArray(json).map((child) => decodeRecord(field.child, child, options))
					)
				case "option":
					return decodeOption(field.child, json, options)
				case "one":
					return decodeRecord(field.child, json, options)
			}
		case "arm":
			return decodeOption(field.child, json, options)
		case "some":
			return options.some(decodeRecord(field.child, json, options))
		case "none":
			return options.none
	}
}

/** An Option of a child record from the server's own JSON: None for null, Some of the child's record otherwise. */
const decodeOption = (
	child: WireRecord<WireScalar>,
	json: WireJson,
	options: WireOptions
): unknown => (json === null ? options.none : options.some(decodeRecord(child, json, options)))

/** A record from the server's own JSON, as grizzle's decoders deliver one: frozen, of a null prototype. */
export const decodeRecord = (
	record: WireRecord<WireScalar>,
	json: WireJson,
	options: WireOptions
): Readonly<Record<string, unknown>> => {
	const object = trustedRecord(json)
	const heading = headingOf(record, object)
	if (heading === undefined) {
		throw defect("a wire record of one of its record's headings")
	}
	return deliveredRecord(
		heading.map((named) => [
			named.name,
			decodeField(named.field, trustedMember(object, named.name), options)
		])
	)
}

/** The JSON of a key: its columns' values in key order. */
export const encodeKey = (key: ReadonlyArray<WireField<WireScalar>>, value: RowKey): WireJson => {
	if (value.length !== key.length) {
		throw defect("a key of its stream's key columns")
	}
	return key.map((field, at) => {
		if (field.kind !== "scalar" && field.kind !== "constant") {
			throw defect("a key column of a scalar")
		}
		return encodeScalar(field.scalar, value[at])
	})
}

/** A key from the server's own JSON: its columns' values in key order. */
export const decodeKey = (key: ReadonlyArray<WireField<WireScalar>>, json: WireJson): RowKey =>
	RowKey(
		trustedArray(json).map((item, at) => {
			const field = key[at]
			if (field === undefined || (field.kind !== "scalar" && field.kind !== "constant")) {
				throw defect("a key column of a scalar")
			}
			return decodeScalar(field.scalar, item)
		})
	)

/**
 * A caller's parsed input, the in-process input itself (live/program.ts Input, WindowInput): a call's parameters and
 * facts, or a page's parameters, no facts and window, so a served handle takes it as it is.
 */
export type ParsedInput =
	| Input<
			Readonly<Record<string, unknown>>,
			Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>
	  >
	| WindowInput<Readonly<Record<string, unknown>>>

/** The facts of a page's input: none. */
const noFacts: Empty = Object.freeze({})

type Parsed<A> = Result.Result<A, WireFault>

const refused = (kind: WireFault["kind"], at: Path): Parsed<never> => Result.err({ kind, at })

/** A caller's record holding exactly the members `names`, at `at`. */
const exactRecord = (
	json: unknown,
	names: ReadonlyArray<string>,
	at: Path
): Parsed<Readonly<Record<string, unknown>>> => {
	if (!isPlainRecord(json)) {
		return refused("json", at)
	}
	return holdsExactly(json, names) ? Result.ok(json) : refused("members", at)
}

/** Each of `items` parsed by `parse`, the first refusal kept. */
const parseEach = <A, B>(
	items: ReadonlyArray<A>,
	parse: (item: A, index: number) => Parsed<B>
): Parsed<ReadonlyArray<B>> => {
	const out: Array<B> = []
	for (const [index, item] of items.entries()) {
		const parsed = parse(item, index)
		if (!parsed.ok) {
			return parsed
		}
		out.push(parsed.value)
	}
	return Result.ok(Object.freeze(out))
}

/** A caller's scalar at `at`, parsed exactly. */
const parseScalarAt = (scalar: WireScalar, json: unknown, at: Path): Parsed<unknown> =>
	Result.mapError(parseScalar(scalar, json), (kind) => ({ kind, at }))

/** A caller's value of a scalar or head literals' field: a head literal's, its spelling one of the literals'. */
const parseColumn = (field: WireField<WireScalar>, json: unknown, at: Path): Parsed<unknown> => {
	switch (field.kind) {
		case "scalar":
			return parseScalarAt(field.scalar, json, at)
		case "constant":
			return Result.flatMap(parseScalarAt(field.scalar, json, at), (value) =>
				field.values.some((literal) => sameJson(literal, encodeScalar(field.scalar, value)))
					? Result.ok(value)
					: refused("range", at)
			)
		case "attachment":
		case "arm":
		case "some":
		case "none":
			throw defect("an input field of a scalar")
	}
}

/** A caller's record of one of `record`'s headings, at `at`: its heading by its keys, each field parsed. */
const parseRecord = (
	record: WireRecord<WireScalar>,
	json: unknown,
	at: Path
): Parsed<Readonly<Record<string, unknown>>> => {
	if (!isPlainRecord(json)) {
		return refused("json", at)
	}
	const heading = headingOf(record, json)
	if (
		heading === undefined ||
		!holdsExactly(
			json,
			heading.map((named) => named.name)
		)
	) {
		return refused("members", at)
	}
	return Result.map(
		parseEach(heading, (named) =>
			Result.map(
				parseColumn(named.field, json[named.name], [...at, named.name]),
				(value): readonly [string, unknown] => [named.name, value]
			)
		),
		(entries) => Object.freeze(Object.fromEntries(entries))
	)
}

/** A caller's parameters: exactly the program's, each parsed, a relation's as an array of its facts. */
const parseParams = (
	params: ReadonlyArray<WireParam<WireScalar>>,
	json: unknown,
	at: Path
): Parsed<Readonly<Record<string, unknown>>> =>
	Result.flatMap(
		exactRecord(
			json,
			params.map((p) => p.name),
			at
		),
		(given) =>
			Result.map(
				parseEach(params, (p) => {
					const here = [...at, p.name]
					const value = given[p.name]
					const parsed: Parsed<unknown> =
						p.param.kind === "scalar"
							? parseScalarAt(p.param.scalar, value, here)
							: parseFactArray([p.param.heading], value, here)
					return Result.map(parsed, (v): readonly [string, unknown] => [p.name, v])
				}),
				(entries) => Object.freeze(Object.fromEntries(entries))
			)
	)

/** A caller's array of facts of `record`, at `at`. */
const parseFactArray = (
	record: WireRecord<WireScalar>,
	json: unknown,
	at: Path
): Parsed<ReadonlyArray<unknown>> =>
	isList(json)
		? parseEach(json, (fact, index) => parseRecord(record, fact, [...at, index]))
		: refused("json", at)

/**
 * A caller's fact of the level at `index` among `levels`, at `at`: one of its headings' fields, each parsed, and under
 * each family's count field an array of the member level's facts, each parsed alike.
 */
const parseLevelFact = (
	levels: WireFacts<WireScalar>["levels"],
	index: number,
	json: unknown,
	at: Path
): Parsed<Readonly<Record<string, unknown>>> => {
	const level = levels[index]
	if (level === undefined) {
		throw defect("a fact's level among its levels")
	}
	if (!isPlainRecord(json)) {
		return refused("json", at)
	}
	const counts = level.families.map((family) => family.count)
	const heading = level.headings.find((h) =>
		holdsExactly(json, [...h.map((named) => named.name), ...counts])
	)
	if (heading === undefined) {
		return refused("members", at)
	}
	return Result.flatMap(
		parseEach(heading, (named) =>
			Result.map(
				parseColumn(named.field, json[named.name], [...at, named.name]),
				(value): readonly [string, unknown] => [named.name, value]
			)
		),
		(own) =>
			Result.map(
				parseEach(level.families, (family) => {
					const members = json[family.count]
					const here = [...at, family.count]
					return isList(members)
						? Result.map(
								parseEach(members, (member, position) =>
									parseLevelFact(levels, family.level, member, [...here, position])
								),
								(parsed): readonly [string, unknown] => [family.count, parsed]
							)
						: refused("json", here)
				}),
				(nested) => Object.freeze(Object.fromEntries([...own, ...nested]))
			)
	)
}

/** A caller's facts: under each op of the ChangeSet's array members, under each of its relations, an array of facts. */
const parseFacts = (
	facts: ReadonlyArray<WireFacts<WireScalar>>,
	json: unknown,
	at: Path
): Parsed<Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>> => {
	const ops = [...new Set(facts.map((member) => member.op))]
	return Result.flatMap(exactRecord(json, ops, at), (given) =>
		Result.map(
			parseEach(ops, (op) => {
				const members = facts.filter((member) => member.op === op)
				const here = [...at, op]
				return Result.flatMap(
					exactRecord(
						given[op],
						members.map((member) => member.relation),
						here
					),
					(byRelation) =>
						Result.map(
							parseEach(members, (member) => {
								const array = byRelation[member.relation]
								const there = [...here, member.relation]
								return isList(array)
									? Result.map(
											parseEach(array, (fact, position) =>
												parseLevelFact(member.levels, 0, fact, [...there, position])
											),
											(parsed): readonly [string, ReadonlyArray<unknown>] => [
												member.relation,
												parsed
											]
										)
									: refused("json", there)
							}),
							(entries): readonly [string, Readonly<Record<string, ReadonlyArray<unknown>>>] => [
								op,
								Object.freeze(Object.fromEntries(entries))
							]
						)
				)
			}),
			(entries) => Object.freeze(Object.fromEntries(entries))
		)
	)
}

/** A caller's key of a page's anchor: its columns' values in key order, each parsed. */
const parseKey = (
	key: ReadonlyArray<WireField<WireScalar>>,
	json: unknown,
	at: Path
): Parsed<RowKey> => {
	if (!isList(json)) {
		return refused("json", at)
	}
	if (json.length !== key.length) {
		return refused("members", at)
	}
	return Result.map(
		parseEach(key, (field, index) => parseColumn(field, json[index], [...at, index])),
		RowKey
	)
}

/** A caller's anchor: tagged by its kind, a keyed one's key parsed. */
const parseAnchor = (
	key: ReadonlyArray<WireField<WireScalar>>,
	json: unknown,
	at: Path
): Parsed<Anchor> => {
	if (!isPlainRecord(json)) {
		return refused("json", at)
	}
	const kind = json["kind"]
	switch (kind) {
		case "start":
		case "end":
			return Result.map(exactRecord(json, ["kind"], at), (): Anchor => ({ kind }))
		case "after":
		case "before":
			return Result.flatMap(exactRecord(json, ["kind", "key"], at), (given) =>
				Result.map(parseKey(key, given["key"], [...at, "key"]), (parsed): Anchor => ({
					kind,
					key: parsed
				}))
			)
		default:
			return refused("members", [...at, "kind"])
	}
}

/** A caller's window: its anchor and its size, a positive safe integer. */
const parseWindow = (
	key: ReadonlyArray<WireField<WireScalar>>,
	json: unknown,
	at: Path
): Parsed<Window> =>
	Result.flatMap(exactRecord(json, ["anchor", "size"], at), (given) =>
		Result.flatMap(parseAnchor(key, given["anchor"], [...at, "anchor"]), (anchor) => {
			const size = given["size"]
			if (typeof size !== "number") {
				return refused("json", [...at, "size"])
			}
			return Number.isSafeInteger(size) && size >= 1
				? Result.ok({ anchor, size })
				: refused("range", [...at, "size"])
		})
	)

/**
 * A caller's input, parsed exactly (live/wire.ts parse): `{ params, facts }`, or a page's `{ params, facts: {}, window }`,
 * every record holding exactly its members. A refusal names its fault and its path in the body.
 */
export const parseInput = (input: WireInput<WireScalar>, json: unknown): Parsed<ParsedInput> => {
	if (input.kind === "call") {
		return Result.flatMap(exactRecord(json, ["params", "facts"], []), (body) =>
			Result.flatMap(parseParams(input.params, body["params"], ["params"]), (params) =>
				Result.map(parseFacts(input.facts, body["facts"], ["facts"]), (facts): ParsedInput => ({
					params,
					facts
				}))
			)
		)
	}
	return Result.flatMap(exactRecord(json, ["params", "facts", "window"], []), (body) =>
		Result.flatMap(parseParams(input.params, body["params"], ["params"]), (params) =>
			Result.flatMap(exactRecord(body["facts"], [], ["facts"]), () =>
				Result.map(parseWindow(input.key, body["window"], ["window"]), (window): ParsedInput => ({
					params,
					facts: noFacts,
					window
				}))
			)
		)
	)
}

/** The JSON of a record of scalar fields a caller gives, of one of `headings`, with its families' members. */
const encodeLevelFact = (
	levels: WireFacts<WireScalar>["levels"],
	index: number,
	fact: unknown
): WireJson => {
	const level = levels[index]
	if (level === undefined) {
		throw defect("a fact's level among its levels")
	}
	if (typeof fact !== "object" || fact === null) {
		throw defect("a fact to encode")
	}
	const counts = level.families.map((family) => family.count)
	const heading = level.headings.find((h) =>
		holdsExactly(fact, [...h.map((named) => named.name), ...counts])
	)
	if (heading === undefined) {
		throw defect("a fact of one of its level's headings")
	}
	const out: Record<string, WireJson> = {}
	for (const named of heading) {
		const field = named.field
		if (field.kind !== "scalar" && field.kind !== "constant") {
			throw defect("a fact's field of a scalar")
		}
		out[named.name] = encodeScalar(field.scalar, ownMember(fact, named.name))
	}
	for (const family of level.families) {
		out[family.count] = factsJson(ownMember(fact, family.count), (member) =>
			encodeLevelFact(levels, family.level, member)
		)
	}
	return out
}

/** The JSON of an iterable of facts, each by `encode`. */
const factsJson = (facts: unknown, encode: (fact: unknown) => WireJson): WireJson => {
	if (typeof facts !== "object" || facts === null || !(Symbol.iterator in facts)) {
		throw defect("facts to encode")
	}
	return Array.from(trusted<Iterable<unknown>>(facts), encode)
}

/** The JSON of a caller's parameters. */
const encodeParams = (params: ReadonlyArray<WireParam<WireScalar>>, given: unknown): WireJson => {
	const out: Record<string, WireJson> = {}
	for (const p of params) {
		const value = ownMember(given, p.name)
		const param = p.param
		out[p.name] =
			param.kind === "scalar"
				? encodeScalar(param.scalar, value)
				: factsJson(value, (fact) =>
						encodeLevelFact([{ headings: [param.heading], families: [] }], 0, fact)
					)
	}
	return out
}

/** The JSON of a client's input to a program, in the program's input shape (the inverse of parseInput). */
export const encodeInput = (input: WireInput<WireScalar>, value: unknown): WireJson => {
	const params = encodeParams(input.params, ownMember(value, "params"))
	if (input.kind === "window") {
		const window = ownMember(value, "window")
		const anchor = ownMember(window, "anchor")
		const kind = ownMember(anchor, "kind")
		if (kind !== "start" && kind !== "end" && kind !== "after" && kind !== "before") {
			throw defect("a window's anchor")
		}
		const anchorJson: WireJson =
			kind === "start" || kind === "end"
				? { kind }
				: { kind, key: encodeKey(input.key, RowKey(keyValues(ownMember(anchor, "key")))) }
		const size = ownMember(window, "size")
		if (typeof size !== "number") {
			throw defect("a window's size")
		}
		return { params, facts: {}, window: { anchor: anchorJson, size } }
	}
	const given = ownMember(value, "facts")
	const facts: Record<string, Record<string, WireJson>> = {}
	for (const member of input.facts) {
		const byRelation = facts[member.op] ?? {}
		byRelation[member.relation] = factsJson(
			ownMember(ownMember(given, member.op), member.relation),
			(fact) => encodeLevelFact(member.levels, 0, fact)
		)
		facts[member.op] = byRelation
	}
	return { params, facts }
}

/** A key's values a caller gives: an array of them in key order. */
const keyValues = (value: unknown): ReadonlyArray<unknown> => {
	if (!isList(value)) {
		throw defect("a key's values")
	}
	return value
}

/** Plain data (types/changeset Refused) as JSON: strings, finite numbers, booleans, arrays and plain records. */
const plainJson = (value: unknown): WireJson => {
	if (typeof value === "string" || typeof value === "boolean") {
		return value
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value
	}
	if (isList(value)) {
		return value.map(plainJson)
	}
	if (isPlainRecord(value)) {
		const out: Record<string, WireJson> = {}
		for (const [key, member] of Object.entries(value)) {
			out[key] = plainJson(member)
		}
		return out
	}
	throw defect("plain data of a refusal")
}

/** The witness relation a key witness names, among the role's. */
const witnessOf = (
	witness: ReadonlyArray<WireWitness<WireScalar>>,
	relation: unknown
): WireWitness<WireScalar> => {
	const found = witness.find((w) => w.relation === relation)
	if (found === undefined) {
		throw defect("a witness of one of its role's relations")
	}
	return found
}

/** A witness relation's field by its name. */
const witnessField = (w: WireWitness<WireScalar>, name: string): WireField<WireScalar> => {
	const named = w.fields.find((field) => field.name === name)
	if (named === undefined) {
		throw defect("a witness value of one of its relation's fields")
	}
	return named.field
}

/** The JSON of a refusal's witness: a key's values typed by its relation's fields, or none reported. */
const encodeWitness = (
	witness: ReadonlyArray<WireWitness<WireScalar>>,
	value: unknown,
	options: WireOptions
): WireJson => {
	const kind = ownMember(value, "kind")
	if (kind === "unreported") {
		return { kind }
	}
	const relation = ownMember(value, "relation")
	const w = witnessOf(witness, relation)
	const values = ownMember(value, "values")
	if (typeof values !== "object" || values === null || typeof relation !== "string") {
		throw defect("a key witness")
	}
	const out: Record<string, WireJson> = {}
	for (const name of Object.keys(values)) {
		out[name] = encodeField(witnessField(w, name), ownMember(values, name), options)
	}
	return { kind: "key", relation, values: out }
}

/** A refusal's witness from the server's own JSON. */
const decodeWitness = (
	witness: ReadonlyArray<WireWitness<WireScalar>>,
	json: WireJson,
	options: WireOptions
): Witness => {
	const record = trustedRecord(json)
	if (trustedMember(record, "kind") === "unreported") {
		return { kind: "unreported" }
	}
	const relation = trustedString(trustedMember(record, "relation"))
	const w = witnessOf(witness, relation)
	const values = trustedRecord(trustedMember(record, "values"))
	return {
		kind: "key",
		relation,
		values: Object.freeze(
			Object.fromEntries(
				Object.entries(values).map(([name, item]) => [
					name,
					trusted<
						Witness extends { readonly values: Readonly<Record<string, infer V>> } ? V : never
					>(decodeField(witnessField(w, name), item, options))
				])
			)
		)
	}
}

/** The JSON of a write's outcome the server holds. */
const encodeOutcome = (wire: MemberWire, value: unknown, options: WireOptions): WireJson => {
	if (wire.shape !== "write") {
		throw defect("a read's answer holds no outcome")
	}
	const kind = ownMember(value, "kind")
	if (wire.outcome.kind === "refresh") {
		if (kind !== "refreshed") {
			throw defect("a refresh's outcome")
		}
		return { kind }
	}
	const reads = encodeRecord(wire.outcome.reads, ownMember(value, "reads"), options)
	if (kind === "unchanged") {
		return { kind, reads }
	}
	if (kind !== "accepted") {
		throw defect("a ChangeSet's outcome")
	}
	const counts = ownMember(value, "counts")
	if (!isList(counts)) {
		throw defect("a ChangeSet's counts")
	}
	return {
		kind,
		counts: counts.map((count) => ({
			relation: plainJson(ownMember(count, "relation")),
			added: countText(ownMember(count, "added")),
			deleted: countText(ownMember(count, "deleted")),
			put: countText(ownMember(count, "put"))
		})),
		reads
	}
}

/** A count's spelling: its bigint's decimal digits. */
const countText = (count: unknown): WireJson => {
	if (typeof count !== "bigint") {
		throw defect("a count of a ChangeSet's relation")
	}
	return count.toString()
}

/** A write's outcome from the server's own JSON. */
const decodeOutcome = (wire: MemberWire, json: WireJson, options: WireOptions): unknown => {
	if (wire.shape !== "write") {
		throw defect("a read's answer holds no outcome")
	}
	const record = trustedRecord(json)
	if (wire.outcome.kind === "refresh") {
		return Object.freeze({ kind: "refreshed" })
	}
	const reads = decodeRecord(wire.outcome.reads, trustedMember(record, "reads"), options)
	if (trustedMember(record, "kind") === "unchanged") {
		return Object.freeze({ kind: "unchanged", reads })
	}
	return Object.freeze({
		kind: "accepted",
		counts: Object.freeze(
			trustedArray(trustedMember(record, "counts")).map((item) => {
				const count = trustedRecord(item)
				return Object.freeze({
					relation: trustedString(trustedMember(count, "relation")),
					added: BigInt(trustedString(trustedMember(count, "added"))),
					deleted: BigInt(trustedString(trustedMember(count, "deleted"))),
					put: BigInt(trustedString(trustedMember(count, "put")))
				})
			})
		),
		reads
	})
}

/** A read's key columns and fields, which a write's answer never carries: a defect asked of one. */
const readOf = (wire: MemberWire): Extract<MemberWire, { readonly shape: "set" | "list" }> => {
	if (wire.shape === "write") {
		throw defect("a write's answer holds no row, key or key fields")
	}
	return wire
}

/** One slot's encoder (live/events.ts SlotValues). */
type SlotEncoders = { readonly [S in Slot]: (value: SlotValues<unknown, unknown>[S]) => WireJson }

/** One slot's decoder (live/events.ts SlotValues). */
type SlotDecoders = { readonly [S in Slot]: (json: WireJson) => SlotValues<unknown, unknown>[S] }

/** The JSON of a payload member of a CallError, by its slot: a text, a refusal's laws or its witness. */
const encodeErrorMember = (
	wire: MemberWire,
	slot: Slot,
	value: unknown,
	options: WireOptions
): WireJson => {
	switch (slot) {
		case "text":
			if (typeof value !== "string") {
				throw defect("a CallError's text")
			}
			return value
		case "refused":
			return plainJson(value)
		case "witness":
			return encodeWitness(wire.witness, value, options)
		case "transientReason":
			if (!isTransientTag(value)) {
				throw defect("a transient CallError's reason, one of transientTags")
			}
			return value
		case "fields":
		case "row":
		case "key":
		case "after":
		case "outcome":
		case "error":
			throw defect("a CallError's payload holds texts, laws, a witness and a reason alone")
	}
}

/** Whether a value is a transient refusal's tag (core/errors.ts transientTags). */
const isTransientTag = (value: unknown): value is TransientTag =>
	transientTags.some((tag) => tag === value)

/** The JSON of a CallError: its kind, its retry and its payload's members by their slots. */
const encodeError = (wire: MemberWire, error: CallError, options: WireOptions): WireJson => {
	const out: Record<string, WireJson> = { kind: error.kind, retry: error.retry }
	for (const [member, slot] of Object.entries(callErrors[error.kind].payload)) {
		out[member] = encodeErrorMember(wire, slot, ownMember(error, member), options)
	}
	return out
}

/**
 * Each slot's encoder for one member's events (live/events.ts SlotValues): the server's frames walk an event's payload
 * and encode each member by its slot's.
 */
export const slotEncoders = (wire: MemberWire, options: WireOptions): SlotEncoders => ({
	text: (value) => value,
	fields: (value) => [...value],
	row: (value) => encodeRecord(readOf(wire).record, value, options),
	key: (value) => encodeKey(readOf(wire).key, value),
	after: (value) => (value === null ? null : encodeKey(readOf(wire).key, value)),
	outcome: (value) => encodeOutcome(wire, value, options),
	error: (value) => encodeError(wire, value, options),
	refused: (value) => plainJson(value),
	witness: (value) => encodeWitness(wire.witness, value, options),
	transientReason: (value) => value
})

/** A CallError's message from the server's own JSON. */
const messageOf = (record: { readonly [member: string]: WireJson }): string =>
	trustedString(trustedMember(record, "message"))

/** Each CallError's decoder, by its kind: its payload's members, each by its slot. */
const errorDecoders = (
	wire: MemberWire,
	options: WireOptions
): {
	readonly [K in CallErrorKind]: (record: { readonly [member: string]: WireJson }) => CallError
} => ({
	route: (r) => callError("route", { message: messageOf(r) }),
	input: (r) => callError("input", { message: messageOf(r) }),
	tokenRefused: (r) => callError("tokenRefused", { message: messageOf(r) }),
	tokenExpired: (r) => callError("tokenExpired", { message: messageOf(r) }),
	refused: (r) =>
		callError("refused", {
			message: messageOf(r),
			refused: trusted<Refused>(trustedMember(r, "refused")),
			witness: decodeWitness(wire.witness, trustedMember(r, "witness"), options)
		}),
	outsideWorld: (r) =>
		callError("outsideWorld", {
			message: messageOf(r),
			relation: trustedString(trustedMember(r, "relation"))
		}),
	transient: (r) =>
		callError("transient", {
			message: messageOf(r),
			reason: trusted<TransientTag>(trustedString(trustedMember(r, "reason")))
		}),
	transport: (r) => callError("transport", { message: messageOf(r) }),
	unavailable: (r) => callError("unavailable", { message: messageOf(r) }),
	stale: (r) => callError("stale", { message: messageOf(r) }),
	commitUnknown: (r) => callError("commitUnknown", { message: messageOf(r) }),
	failed: (r) => callError("failed", { message: messageOf(r) })
})

/** Whether a text is a CallError's kind. */
const isCallErrorKind = (kind: string): kind is CallErrorKind => Object.hasOwn(callErrors, kind)

/** A CallError from the server's own JSON. */
const decodeError = (wire: MemberWire, json: WireJson, options: WireOptions): CallError => {
	const record = trustedRecord(json)
	const kind = trustedString(trustedMember(record, "kind"))
	if (!isCallErrorKind(kind)) {
		throw defect("a CallError's kind")
	}
	return errorDecoders(wire, options)[kind](record)
}

/**
 * Each slot's decoder for one member's events, the client's: each payload member of a frame from the server's own
 * JSON, trusted.
 */
export const slotDecoders = (wire: MemberWire, options: WireOptions): SlotDecoders => ({
	text: trustedString,
	fields: (json): KeyFields => trustedArray(json).map(trustedString),
	row: (json) => decodeRecord(readOf(wire).record, json, options),
	key: (json) => decodeKey(readOf(wire).key, json),
	after: (json) => (json === null ? null : decodeKey(readOf(wire).key, json)),
	outcome: (json) => decodeOutcome(wire, json, options),
	error: (json) => decodeError(wire, json, options),
	refused: (json) => trusted<Refused>(json),
	witness: (json) => decodeWitness(wire.witness, json, options),
	transientReason: (json) => trusted<TransientTag>(trustedString(json))
})
