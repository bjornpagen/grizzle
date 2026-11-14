/**
 * The codecs of a served program's wire shape (live/shape.ts MemberWire) and its role's witness (RoleWitness): the
 * server's encode of its rows, keys, outcomes and errors and its exact parse of a caller's input, and the client's
 * trusting decode of the server's frames and its encode of an input, each an interpreter of the one shape over the one
 * scalar table (live/wire.ts).
 *
 * The server reads its own values (a decoded row, an outcome, a CallError) as unknown, since a row is a record no type
 * ties to its heading at run time: a value of another shape there is a defect, and throws. The client reads the
 * server's frames trusting them, as grizzle reads its own rows, through the frames' JSON alone.
 *
 * Runtime-free and browser-safe, as live/wire.ts is.
 */
import type { Path } from "#compiler/core/canonical.ts"
import { type TransientTag, transientTags } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { defect } from "#compiler/core/invariant.ts"
import { isIterable, isList, isPlainRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { Sqlstate } from "#compiler/core/sqlstate.ts"
import { trusted } from "#compiler/core/trusted.ts"
import {
	type CallError,
	type CallErrorKind,
	type CredentialReason,
	callError,
	callErrors,
	credentialReasons,
	type Slot,
	type SlotValues,
	type UnavailableCause,
	type UnavailableReason,
	unavailableCauses
} from "#compiler/live/events.ts"
import { type KeyFields, RowKey } from "#compiler/live/key.ts"
import type { Anchor, Input, NoFacts, Window, WindowInput } from "#compiler/live/program.ts"
import type {
	MemberWire,
	RoleWitness,
	WireColumn,
	WireFacts,
	WireFault,
	WireField,
	WireHeading,
	WireInput,
	WireKeyColumn,
	WireOptions,
	WireParam,
	WireRecord,
	WireWitness
} from "#compiler/live/shape.ts"
import {
	decodeScalar,
	encodeGiven,
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
	return options.fold(value, {
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

/**
 * The JSON of a key column's value the server holds: its scalar's; for a column some heading lacks, null where the
 * row's heading lacks it, its decoded row holding no such field (live/key.ts keyOf).
 */
const encodeKeyColumn = (column: WireKeyColumn<WireScalar>, value: unknown): WireJson =>
	column.kind === "lacked"
		? value === undefined
			? null
			: encodeScalar(column.column.scalar, value)
		: encodeScalar(column.scalar, value)

/** The JSON of a key: its columns' values in key order. */
export const encodeKey = (
	key: ReadonlyArray<WireKeyColumn<WireScalar>>,
	value: RowKey
): WireJson => {
	if (value.length !== key.length) {
		throw defect("a key of its stream's key columns")
	}
	return key.map((column, at) => encodeKeyColumn(column, value[at]))
}

/** A key column's value from the server's own JSON: no value for the null of a column some heading lacks. */
const decodeKeyColumn = (column: WireKeyColumn<WireScalar>, json: WireJson): unknown =>
	column.kind === "lacked"
		? json === null
			? undefined
			: decodeScalar(column.column.scalar, json)
		: decodeScalar(column.scalar, json)

/** A key from the server's own JSON: its columns' values in key order. */
export const decodeKey = (key: ReadonlyArray<WireKeyColumn<WireScalar>>, json: WireJson): RowKey =>
	RowKey(
		trustedArray(json).map((item, at) => {
			const column = key[at]
			if (column === undefined) {
				throw defect("a key of its stream's key columns")
			}
			return decodeKeyColumn(column, item)
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
const noFacts: NoFacts = Object.freeze({})

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
	key: ReadonlyArray<WireColumn<WireScalar>>,
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
		parseEach(key, (column, index) => parseColumn(column, json[index], [...at, index])),
		RowKey
	)
}

/** A caller's anchor: tagged by its kind, a keyed one's key parsed. */
const parseAnchor = (
	key: ReadonlyArray<WireColumn<WireScalar>>,
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
	key: ReadonlyArray<WireColumn<WireScalar>>,
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

type Encoded<A> = Result.Result<A, WireFault>

/**
 * A read of a caller's value at `at`, its own code run once (core/host.ts hostRead): a getter or a proxy's trap that
 * throws refuses it `json`, as no value of the input's shape.
 */
const givenRead = <A>(at: Path, read: () => Encoded<A>): Encoded<A> =>
	hostRead(() => ({ kind: "json", at }), read)

/**
 * A caller's plain record at `at` holding exactly the members `names`, each read once through its own descriptor, as
 * the in-process boundary reads one (adapter db/input.ts exactRecord): refused `json` where it is no plain record and
 * `members` where it holds others, lacks one or holds an accessor.
 */
const givenRecord = (
	value: unknown,
	names: ReadonlyArray<string>,
	at: Path
): Encoded<Readonly<Record<string, unknown>>> =>
	givenRead(at, () => {
		if (!isPlainRecord(value)) {
			return refused("json", at)
		}
		if (!holdsExactly(value, names)) {
			return refused("members", at)
		}
		const out: Record<string, unknown> = {}
		for (const name of names) {
			const descriptor = Reflect.getOwnPropertyDescriptor(value, name)
			if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
				return refused("members", at)
			}
			out[name] = descriptor.value
		}
		return Result.ok(out)
	})

/**
 * A caller's elements at `at`, read once: a list's, the facts a member's call gives (runtime/write/members.ts), or any
 * iterable's where `iterable`, a relation parameter's facts (core/record.ts isIterable); refused `json` otherwise.
 */
const givenElements = (
	value: unknown,
	iterable: boolean,
	at: Path
): Encoded<ReadonlyArray<unknown>> =>
	givenRead(at, () =>
		isList(value) || (iterable && isIterable(value))
			? Result.ok(Array.from(value))
			: refused("json", at)
	)

/** A caller's value of a scalar at `at` as JSON (live/wire.ts encodeGiven), refused at `at` where it is none. */
const givenScalar = (scalar: WireScalar, value: unknown, at: Path): Encoded<WireJson> =>
	Result.mapError(encodeGiven(scalar, value), (kind) => ({ kind, at }))

/** A caller's facts at `at`, each encoded by `encode` at its index. */
const givenFacts = (
	facts: unknown,
	iterable: boolean,
	at: Path,
	encode: (fact: unknown, at: Path) => Encoded<WireJson>
): Encoded<WireJson> =>
	Result.flatMap(givenElements(facts, iterable, at), (elements) =>
		parseEach(elements, (fact, index) => encode(fact, [...at, index]))
	)

/**
 * A caller's fact of the level at `index` among `levels`, at `at`, as JSON: one of the level's headings' fields, each a
 * scalar's value, and under each family's count field its members' facts, each a fact of the member level, to any depth.
 */
const encodeLevelFact = (
	levels: WireFacts<WireScalar>["levels"],
	index: number,
	fact: unknown,
	at: Path
): Encoded<WireJson> => {
	const level = levels[index]
	if (level === undefined) {
		throw defect("a fact's level among its levels")
	}
	const counts = level.families.map((family) => family.count)
	const heading = givenRead(at, () => {
		if (!isPlainRecord(fact)) {
			return refused("json", at)
		}
		const found = level.headings.find((h) =>
			holdsExactly(fact, [...h.map((named) => named.name), ...counts])
		)
		return found === undefined ? refused("members", at) : Result.ok(found)
	})
	return Result.flatMap(heading, (found) =>
		Result.flatMap(
			givenRecord(fact, [...found.map((named) => named.name), ...counts], at),
			(given) =>
				Result.flatMap(
					parseEach(found, (named) => {
						const field = named.field
						if (field.kind !== "scalar" && field.kind !== "constant") {
							throw defect("a fact's field of a scalar")
						}
						return Result.map(
							givenScalar(field.scalar, given[named.name], [...at, named.name]),
							(json): readonly [string, WireJson] => [named.name, json]
						)
					}),
					(own) =>
						Result.map(
							parseEach(level.families, (family) =>
								Result.map(
									givenFacts(
										given[family.count],
										false,
										[...at, family.count],
										(member, memberAt) => encodeLevelFact(levels, family.level, member, memberAt)
									),
									(json): readonly [string, WireJson] => [family.count, json]
								)
							),
							(nested): WireJson => Object.fromEntries([...own, ...nested])
						)
				)
		)
	)
}

/** A caller's parameters at `at` as JSON: exactly the program's, a scalar's value or a relation's facts each. */
const encodeParams = (
	params: ReadonlyArray<WireParam<WireScalar>>,
	value: unknown,
	at: Path
): Encoded<WireJson> =>
	Result.flatMap(
		givenRecord(
			value,
			params.map((p) => p.name),
			at
		),
		(given) =>
			Result.map(
				parseEach(params, (p) => {
					const here = [...at, p.name]
					const param = p.param
					const encoded =
						param.kind === "scalar"
							? givenScalar(param.scalar, given[p.name], here)
							: givenFacts(given[p.name], true, here, (fact, factAt) =>
									encodeLevelFact([{ headings: [param.heading], families: [] }], 0, fact, factAt)
								)
					return Result.map(encoded, (json): readonly [string, WireJson] => [p.name, json])
				}),
				(entries): WireJson => Object.fromEntries(entries)
			)
	)

/**
 * A caller's facts at `at` as JSON: under each op of the ChangeSet's array members, under each of its relations, a list
 * of facts, and nothing else.
 */
const encodeFacts = (
	facts: ReadonlyArray<WireFacts<WireScalar>>,
	value: unknown,
	at: Path
): Encoded<WireJson> => {
	const ops = [...new Set(facts.map((member) => member.op))]
	return Result.flatMap(givenRecord(value, ops, at), (byOp) =>
		Result.map(
			parseEach(ops, (op) => {
				const members = facts.filter((member) => member.op === op)
				const here = [...at, op]
				return Result.flatMap(
					givenRecord(
						byOp[op],
						members.map((member) => member.relation),
						here
					),
					(byRelation) =>
						Result.map(
							parseEach(members, (member) =>
								Result.map(
									givenFacts(
										byRelation[member.relation],
										false,
										[...here, member.relation],
										(fact, factAt) => encodeLevelFact(member.levels, 0, fact, factAt)
									),
									(json): readonly [string, WireJson] => [member.relation, json]
								)
							),
							(entries): readonly [string, WireJson] => [op, Object.fromEntries(entries)]
						)
				)
			}),
			(entries): WireJson => Object.fromEntries(entries)
		)
	)
}

/** A caller's key of a page's anchor at `at` as JSON: its columns' values in key order. */
const encodeAnchorKey = (
	key: ReadonlyArray<WireColumn<WireScalar>>,
	value: unknown,
	at: Path
): Encoded<WireJson> =>
	Result.flatMap(givenElements(value, false, at), (values) =>
		values.length === key.length
			? parseEach(key, (column, index) => givenScalar(column.scalar, values[index], [...at, index]))
			: refused("members", at)
	)

/** A caller's anchor at `at` as JSON: tagged by its kind, a keyed one's key encoded. */
const encodeAnchor = (
	key: ReadonlyArray<WireColumn<WireScalar>>,
	value: unknown,
	at: Path
): Encoded<WireJson> =>
	Result.flatMap(
		givenRead(at, () =>
			isPlainRecord(value)
				? Result.ok(Reflect.getOwnPropertyDescriptor(value, "kind")?.value)
				: refused("json", at)
		),
		(kind): Encoded<WireJson> => {
			switch (kind) {
				case "start":
				case "end":
					return Result.map(givenRecord(value, ["kind"], at), (): WireJson => ({ kind }))
				case "after":
				case "before":
					return Result.flatMap(givenRecord(value, ["kind", "key"], at), (given) =>
						Result.map(encodeAnchorKey(key, given["key"], [...at, "key"]), (json): WireJson => ({
							kind,
							key: json
						}))
					)
				default:
					return refused("members", [...at, "kind"])
			}
		}
	)

/** A caller's window at `at` as JSON: its anchor and its size, a positive safe integer. */
const encodeWindow = (
	key: ReadonlyArray<WireColumn<WireScalar>>,
	value: unknown,
	at: Path
): Encoded<WireJson> =>
	Result.flatMap(givenRecord(value, ["anchor", "size"], at), (given) =>
		Result.flatMap(encodeAnchor(key, given["anchor"], [...at, "anchor"]), (anchor) => {
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
 * A caller's input to a program as JSON, in the program's input shape: the inverse of parseInput, over the caller's
 * own values as the client's untyped door takes them. Every value of the input's shape encodes, and any other is
 * refused with its fault at its path (WireFault), as parseInput refuses JSON: a record that is no plain record or does
 * not hold exactly its members, no list where facts or a key stand, a value of another type than its scalar's host type
 * (live/wire.ts encodeGiven), a window's size that is no positive safe integer, or a value whose reading throws. A
 * value the caller gives is never asserted: only the server's own values are (encodeRecord, encodeKey).
 */
export const encodeInput = (input: WireInput<WireScalar>, value: unknown): Encoded<WireJson> => {
	if (input.kind === "call") {
		return Result.flatMap(givenRecord(value, ["params", "facts"], []), (body) =>
			Result.flatMap(encodeParams(input.params, body["params"], ["params"]), (params) =>
				Result.map(encodeFacts(input.facts, body["facts"], ["facts"]), (facts): WireJson => ({
					params,
					facts
				}))
			)
		)
	}
	return Result.flatMap(givenRecord(value, ["params", "facts", "window"], []), (body) =>
		Result.flatMap(encodeParams(input.params, body["params"], ["params"]), (params) =>
			Result.flatMap(givenRecord(body["facts"], [], ["facts"]), () =>
				Result.map(encodeWindow(input.key, body["window"], ["window"]), (window): WireJson => ({
					params,
					facts: {},
					window
				}))
			)
		)
	)
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
	witness: RoleWitness<WireScalar>,
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
	witness: RoleWitness<WireScalar>,
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
	witness: RoleWitness<WireScalar>,
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
const readOf = (wire: MemberWire): Exclude<MemberWire, { readonly shape: "write" }> => {
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
	witness: RoleWitness<WireScalar>,
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
			return encodeWitness(witness, value, options)
		case "transientReason":
			if (!isTransientTag(value)) {
				throw defect("a transient CallError's reason, one of transientTags")
			}
			return value
		case "credentialReason":
			if (!isCredentialReason(value)) {
				throw defect("a credentialRefused CallError's reason, one of credentialReasons")
			}
			return value
		case "unavailableReason":
			return encodeUnavailableReason(value)
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

/** Whether a value is a reason a connection was not authenticated (live/events.ts credentialReasons). */
const isCredentialReason = (value: unknown): value is CredentialReason =>
	credentialReasons.some((reason) => reason === value)

/** Whether a value is a named cause no session could be had for now (live/events.ts unavailableCauses). */
const isUnavailableCause = (value: unknown): value is UnavailableCause =>
	unavailableCauses.some((cause) => cause === value)

/**
 * The JSON of an unavailable CallError's reason (live/events.ts UnavailableReason): a named cause alone, or the
 * SQLSTATE or the socket's code no name classifies, each member exactly as the reason holds it.
 */
const encodeUnavailableReason = (value: unknown): WireJson => {
	if (isPlainRecord(value)) {
		const kind = value["kind"]
		if (isUnavailableCause(kind)) {
			return { kind }
		}
		const sqlstate = value["sqlstate"]
		if (
			kind === "otherSqlstate" &&
			typeof sqlstate === "string" &&
			Sqlstate.parse(sqlstate) !== undefined
		) {
			return { kind, sqlstate }
		}
		const code = value["code"]
		if (kind === "otherSocketCode" && typeof code === "string") {
			return { kind, code }
		}
	}
	throw defect(
		"an unavailable CallError's reason, a named cause or another SQLSTATE or socket code"
	)
}

/** An unavailable CallError's reason from the server's own JSON. */
const decodeUnavailableReason = (json: WireJson): UnavailableReason => {
	const record = trustedRecord(json)
	const kind = trustedString(trustedMember(record, "kind"))
	switch (kind) {
		case "otherSqlstate":
			return { kind, sqlstate: trusted<Sqlstate>(trustedString(trustedMember(record, "sqlstate"))) }
		case "otherSocketCode":
			return { kind, code: trustedString(trustedMember(record, "code")) }
		default:
			return { kind: trusted<UnavailableCause>(kind) }
	}
}

/** The JSON of a CallError: its kind, its retry and its payload's members by their slots. */
const encodeError = (
	witness: RoleWitness<WireScalar>,
	error: CallError,
	options: WireOptions
): WireJson => {
	const out: Record<string, WireJson> = { kind: error.kind, retry: error.retry }
	for (const [member, slot] of Object.entries(callErrors[error.kind].payload)) {
		out[member] = encodeErrorMember(witness, slot, ownMember(error, member), options)
	}
	return out
}

/**
 * Each slot's encoder for one member's events (live/events.ts SlotValues), the member of a role whose refusals name
 * `witness`: the server's frames walk an event's payload and encode each member by its slot's.
 */
export const slotEncoders = (
	wire: MemberWire,
	witness: RoleWitness<WireScalar>,
	options: WireOptions
): SlotEncoders => ({
	text: (value) => value,
	fields: (value) => [...value],
	row: (value) => encodeRecord(readOf(wire).record, value, options),
	key: (value) => encodeKey(readOf(wire).key, value),
	after: (value) => (value === null ? null : encodeKey(readOf(wire).key, value)),
	outcome: (value) => encodeOutcome(wire, value, options),
	error: (value) => encodeError(witness, value, options),
	refused: (value) => plainJson(value),
	witness: (value) => encodeWitness(witness, value, options),
	transientReason: (value) => value,
	credentialReason: (value) => value,
	unavailableReason: encodeUnavailableReason
})

/** A CallError's message from the server's own JSON. */
const messageOf = (record: { readonly [member: string]: WireJson }): string =>
	trustedString(trustedMember(record, "message"))

/** Each CallError's decoder, by its kind: its payload's members, each by its slot. */
const errorDecoders = (
	witness: RoleWitness<WireScalar>,
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
			witness: decodeWitness(witness, trustedMember(r, "witness"), options)
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
	credentialRefused: (r) =>
		callError("credentialRefused", {
			message: messageOf(r),
			reason: trusted<CredentialReason>(trustedString(trustedMember(r, "reason")))
		}),
	transport: (r) => callError("transport", { message: messageOf(r) }),
	unavailable: (r) =>
		callError("unavailable", {
			message: messageOf(r),
			reason: decodeUnavailableReason(trustedMember(r, "reason"))
		}),
	stale: (r) => callError("stale", { message: messageOf(r) }),
	commitUnknown: (r) => callError("commitUnknown", { message: messageOf(r) }),
	failed: (r) => callError("failed", { message: messageOf(r) })
})

/** Whether a text is a CallError's kind. */
const isCallErrorKind = (kind: string): kind is CallErrorKind => Object.hasOwn(callErrors, kind)

/** A CallError from the server's own JSON. */
const decodeError = (
	witness: RoleWitness<WireScalar>,
	json: WireJson,
	options: WireOptions
): CallError => {
	const record = trustedRecord(json)
	const kind = trustedString(trustedMember(record, "kind"))
	if (!isCallErrorKind(kind)) {
		throw defect("a CallError's kind")
	}
	return errorDecoders(witness, options)[kind](record)
}

/**
 * Each slot's decoder for one member's events, the member of a role whose refusals name `witness`, the client's: each
 * payload member of a frame from the server's own JSON, trusted.
 */
export const slotDecoders = (
	wire: MemberWire,
	witness: RoleWitness<WireScalar>,
	options: WireOptions
): SlotDecoders => ({
	text: trustedString,
	fields: (json): KeyFields => trustedArray(json).map(trustedString),
	row: (json) => decodeRecord(readOf(wire).record, json, options),
	key: (json) => decodeKey(readOf(wire).key, json),
	after: (json) => (json === null ? null : decodeKey(readOf(wire).key, json)),
	outcome: (json) => decodeOutcome(wire, json, options),
	error: (json) => decodeError(witness, json, options),
	refused: (json) => trusted<Refused>(json),
	witness: (json) => decodeWitness(witness, json, options),
	transientReason: (json) => trusted<TransientTag>(trustedString(json)),
	credentialReason: (json) => trusted<CredentialReason>(trustedString(json)),
	unavailableReason: decodeUnavailableReason
})
