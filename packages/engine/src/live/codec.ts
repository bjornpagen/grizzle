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
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { canonicalEquals, type Path } from "#compiler/core/canonical.ts"
import { type TransientTag, transientTags } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import type { ParamPlace } from "#compiler/core/identity.ts"
import { frozenRecordOf, isIterable, isList, isPlainRecord } from "#compiler/core/record.ts"
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
import type { Input, NoFacts, WindowInput } from "#compiler/live/program.ts"
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
	WireLevel,
	WireOptions,
	WireRecord,
	WireWitness
} from "#compiler/live/shape.ts"
import {
	decodeScalar,
	encodeGiven,
	encodeScalar,
	parseScalar,
	trustedArray,
	trustedMember,
	trustedRecord,
	trustedString,
	type WireJson,
	type WireScalar
} from "#compiler/live/wire.ts"
import type { BrokenLaws, Witness } from "#compiler/types/changeset/changeset.ts"

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
	return frozenRecordOf(
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

type Read<A> = Result.Result<A, WireFault>

const refused = (kind: WireFault["kind"], at: Path): Read<never> => Result.err({ kind, at })

/** A caller's anchor as a walk builds it, a keyed one's key as its door builds a key, a positioned one's position. */
type WalkedAnchor<K> =
	| { readonly kind: "start" | "end" }
	| { readonly kind: "after" | "before"; readonly key: K }
	| { readonly kind: "at"; readonly position: number }

/** A caller's input as a walk builds it (`walkInput`): a call's parameters and facts, or a page's parameters, no facts
 * and window. */
type WalkedInput<P, F, K, N> =
	| { readonly params: P; readonly facts: F }
	| {
			readonly params: P
			readonly facts: N
			readonly window: { readonly anchor: WalkedAnchor<K>; readonly size: number }
	  }

/**
 * How a walk of a caller's input in the program's input shape (`walkInput`) reads the caller's values and builds what
 * it delivers: the server's exact parse of the JSON a call's body holds (`jsonDoor`) and the client's encode of the
 * caller's own values as that JSON (`hostDoor`) walk the one shape, refusing a value at one path with one fault, each
 * reading its values and building its result its own way.
 *
 * - `record`: a record holding exactly the members `names`, each read once: refused `json` where it is no plain record
 *   and `members` where it holds others or lacks one;
 * - `fact`: a fact of `level`, its heading the one whose fields it holds exactly beside the level's count fields, and its
 *   members read once: refused `json` where it is no plain record and `members` where it holds no heading's;
 * - `kind`: an anchor's member `kind`, refused `json` where it is no plain record;
 * - `list`: a list's elements, refused `json` where it is none; `rows`: a relation parameter's facts, a list's or, where
 *   the caller's own values are read, any iterable's;
 * - `column`: a value of a scalar or head literals' column;
 * - `built`, `params`, `facts`, `key`: a fact, the parameters, the facts by op and relation and a key, built from their
 *   parts, and `noFacts` a page's facts, none.
 */
interface InputDoor<V, P, F, K, N> {
	readonly record: (
		value: unknown,
		names: ReadonlyArray<string>,
		at: Path
	) => Read<Readonly<Record<string, unknown>>>
	readonly fact: (
		value: unknown,
		level: WireLevel<WireScalar>,
		at: Path
	) => Read<{
		readonly heading: WireHeading<WireScalar>
		readonly members: Readonly<Record<string, unknown>>
	}>
	readonly kind: (value: unknown, at: Path) => Read<unknown>
	readonly list: (value: unknown, at: Path) => Read<ReadonlyArray<unknown>>
	readonly rows: (value: unknown, at: Path) => Read<ReadonlyArray<unknown>>
	readonly column: (field: WireColumn<WireScalar>, value: unknown, at: Path) => Read<V>
	readonly built: (entries: ReadonlyArray<readonly [string, V | ReadonlyArray<V>]>) => V
	readonly params: (entries: ReadonlyArray<readonly [string, V | ReadonlyArray<V>]>) => P
	readonly facts: (
		entries: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, ReadonlyArray<V>]>]>
	) => F
	readonly key: (values: ReadonlyArray<V>) => K
	readonly noFacts: N
}

/**
 * A caller's input walked through `door` in the program's input shape (live/shape.ts WireInput): `{ params, facts }`, or
 * a page's `{ params, facts: {}, window }`, every record holding exactly its members; each parameter a scalar's value or
 * a relation's facts; the facts under each op of the ChangeSet's array members and under each of its relations, each a
 * fact of its levels' first, and under each family's count field its members' facts, each of the member level, to any
 * depth; a window its anchor and its size, a positive safe integer, a keyed anchor's key its key columns' values in key
 * order, a positioned anchor's position a safe integer of at least 0. A refusal names its fault and its path.
 */
const walkInput = <V, P, F, K, N>(
	door: InputDoor<V, P, F, K, N>,
	input: WireInput<WireScalar>,
	value: unknown
): Read<WalkedInput<P, F, K, N>> => {
	const column = (field: WireField<WireScalar>, given: unknown, at: Path): Read<V> => {
		if (field.kind !== "scalar" && field.kind !== "constant") {
			throw defect("an input field of a scalar")
		}
		return door.column(field, given, at)
	}
	const factsOf = (
		elements: Read<ReadonlyArray<unknown>>,
		levels: WireFacts<WireScalar>["levels"],
		index: number,
		at: Path
	): Read<ReadonlyArray<V>> =>
		Result.flatMap(elements, (given) =>
			Result.each(given, (one, position) => fact(levels, index, one, [...at, position]))
		)
	const fact = (
		levels: WireFacts<WireScalar>["levels"],
		index: number,
		given: unknown,
		at: Path
	): Read<V> => {
		const level = levels[index]
		if (level === undefined) {
			throw defect("a fact's level among its levels")
		}
		return Result.flatMap(door.fact(given, level, at), ({ heading, members }) =>
			Result.flatMap(
				Result.each(heading, (named) =>
					Result.map(
						column(named.field, members[named.name], [...at, named.name]),
						(read): readonly [string, V] => [named.name, read]
					)
				),
				(own) =>
					Result.map(
						Result.each(level.families, (family) => {
							const here = [...at, family.count]
							return Result.map(
								factsOf(door.list(members[family.count], here), levels, family.level, here),
								(read): readonly [string, ReadonlyArray<V>] => [family.count, read]
							)
						}),
						(nested) => door.built([...own, ...nested])
					)
			)
		)
	}
	const params = (given: unknown, at: Path): Read<P> =>
		Result.flatMap(
			door.record(
				given,
				input.params.map((p) => p.name),
				at
			),
			(byName) =>
				Result.map(
					Result.each(input.params, (p): Read<readonly [string, V | ReadonlyArray<V>]> => {
						const here = [...at, p.name]
						const param = p.param
						return param.kind === "scalar"
							? Result.map(
									door.column(param, byName[p.name], here),
									(read): readonly [string, V] => [p.name, read]
								)
							: Result.map(
									factsOf(
										door.rows(byName[p.name], here),
										[{ headings: [param.heading], families: [] }],
										0,
										here
									),
									(read): readonly [string, ReadonlyArray<V>] => [p.name, read]
								)
					}),
					door.params
				)
		)
	const facts = (
		members: ReadonlyArray<WireFacts<WireScalar>>,
		given: unknown,
		at: Path
	): Read<F> => {
		const ops = [...new Set(members.map((member) => member.op))]
		return Result.flatMap(door.record(given, ops, at), (byOp) =>
			Result.map(
				Result.each(ops, (op) => {
					const ofOp = members.filter((member) => member.op === op)
					const here = [...at, op]
					return Result.flatMap(
						door.record(
							byOp[op],
							ofOp.map((member) => member.relation),
							here
						),
						(byRelation) =>
							Result.map(
								Result.each(ofOp, (member) => {
									const there = [...here, member.relation]
									return Result.map(
										factsOf(door.list(byRelation[member.relation], there), member.levels, 0, there),
										(read): readonly [string, ReadonlyArray<V>] => [member.relation, read]
									)
								}),
								(
									entries
								): readonly [string, ReadonlyArray<readonly [string, ReadonlyArray<V>]>] => [
									op,
									entries
								]
							)
					)
				}),
				door.facts
			)
		)
	}
	const key = (columns: ReadonlyArray<WireColumn<WireScalar>>, given: unknown, at: Path): Read<K> =>
		Result.flatMap(door.list(given, at), (values) =>
			values.length === columns.length
				? Result.map(
						Result.each(columns, (c, index) => door.column(c, values[index], [...at, index])),
						door.key
					)
				: refused("members", at)
		)
	const anchor = (
		columns: ReadonlyArray<WireColumn<WireScalar>>,
		given: unknown,
		at: Path
	): Read<WalkedAnchor<K>> =>
		Result.flatMap(door.kind(given, at), (kind): Read<WalkedAnchor<K>> => {
			switch (kind) {
				case "start":
				case "end":
					return Result.map(door.record(given, ["kind"], at), () => ({ kind }))
				case "after":
				case "before":
					return Result.flatMap(door.record(given, ["kind", "key"], at), (record) =>
						Result.map(key(columns, record["key"], [...at, "key"]), (read) => ({
							kind,
							key: read
						}))
					)
				case "at":
					return Result.flatMap(door.record(given, ["kind", "position"], at), (record) => {
						const position = record["position"]
						if (typeof position !== "number") {
							return refused("json", [...at, "position"])
						}
						return Number.isSafeInteger(position) && position >= 0
							? Result.ok({ kind, position })
							: refused("range", [...at, "position"])
					})
				default:
					return refused("members", [...at, "kind"])
			}
		})
	const window = (
		columns: ReadonlyArray<WireColumn<WireScalar>>,
		given: unknown,
		at: Path
	): Read<{ readonly anchor: WalkedAnchor<K>; readonly size: number }> =>
		Result.flatMap(door.record(given, ["anchor", "size"], at), (record) =>
			Result.flatMap(anchor(columns, record["anchor"], [...at, "anchor"]), (read) => {
				const size = record["size"]
				if (typeof size !== "number") {
					return refused("json", [...at, "size"])
				}
				return Number.isSafeInteger(size) && size >= 1
					? Result.ok({ anchor: read, size })
					: refused("range", [...at, "size"])
			})
		)
	if (input.kind === "call") {
		return Result.flatMap(door.record(value, ["params", "facts"], []), (body) =>
			Result.flatMap(params(body["params"], ["params"]), (p) =>
				Result.map(facts(input.facts, body["facts"], ["facts"]), (f): WalkedInput<P, F, K, N> => ({
					params: p,
					facts: f
				}))
			)
		)
	}
	return Result.flatMap(door.record(value, ["params", "facts", "window"], []), (body) =>
		Result.flatMap(params(body["params"], ["params"]), (p) =>
			Result.flatMap(door.record(body["facts"], [], ["facts"]), () =>
				Result.map(window(input.key, body["window"], ["window"]), (w): WalkedInput<P, F, K, N> => ({
					params: p,
					facts: door.noFacts,
					window: w
				}))
			)
		)
	)
}

/** A caller's record holding exactly the members `names`. */
const jsonRecord = (
	json: unknown,
	names: ReadonlyArray<string>,
	at: Path
): Read<Readonly<Record<string, unknown>>> => {
	if (!isPlainRecord(json)) {
		return refused("json", at)
	}
	return holdsExactly(json, names) ? Result.ok(json) : refused("members", at)
}

/** A caller's list. */
const jsonList = (json: unknown, at: Path): Read<ReadonlyArray<unknown>> =>
	isList(json) ? Result.ok(json) : refused("json", at)

/** A frozen record of `entries`, as a caller's parsed input delivers each. */
const frozenRecord = <A>(
	entries: ReadonlyArray<readonly [string, A]>
): Readonly<Record<string, A>> => Object.freeze(Object.fromEntries(entries))

/**
 * The server's door to a caller's JSON (`walkInput`): its records and lists as they are, each value of a scalar parsed
 * exactly (live/wire.ts parseScalar), a head literal's spelling one of the literals', and every record it builds frozen.
 */
const jsonDoor: InputDoor<
	unknown,
	Readonly<Record<string, unknown>>,
	Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>,
	RowKey,
	NoFacts
> = {
	record: jsonRecord,
	fact: (json, level, at) => {
		if (!isPlainRecord(json)) {
			return refused("json", at)
		}
		const counts = level.families.map((family) => family.count)
		const heading = level.headings.find((h) =>
			holdsExactly(json, [...h.map((named) => named.name), ...counts])
		)
		return heading === undefined ? refused("members", at) : Result.ok({ heading, members: json })
	},
	kind: (json, at) => (isPlainRecord(json) ? Result.ok(json["kind"]) : refused("json", at)),
	list: jsonList,
	rows: jsonList,
	column: (field, json, at) => {
		const parsed = Result.mapError(parseScalar(field.scalar, json), (kind) => ({ kind, at }))
		return field.kind === "scalar"
			? parsed
			: Result.flatMap(parsed, (value) =>
					field.values.some((literal) =>
						canonicalEquals(literal, encodeScalar(field.scalar, value))
					)
						? Result.ok(value)
						: refused("range", at)
				)
	},
	built: frozenRecord,
	params: frozenRecord,
	facts: (entries) =>
		frozenRecord(entries.map(([op, byRelation]) => [op, frozenRecord(byRelation)] as const)),
	key: RowKey,
	noFacts
}

/**
 * A caller's input, parsed exactly (live/wire.ts parse, `walkInput` over `jsonDoor`): `{ params, facts }`, or a page's
 * `{ params, facts: {}, window }`, every record holding exactly its members. A refusal names its fault and its path in
 * the body.
 */
export const parseInput = (input: WireInput<WireScalar>, json: unknown): Read<ParsedInput> =>
	walkInput(jsonDoor, input, json)

/**
 * A read of a caller's value at `at`, its own code run once (core/host.ts hostRead): a getter or a proxy's trap that
 * throws refuses it `json`, as no value of the input's shape.
 */
const givenRead = <A>(at: Path, read: () => Read<A>): Read<A> =>
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
): Read<Readonly<Record<string, unknown>>> =>
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
 * The client's door to a caller's own values (`walkInput`), as its untyped door takes them: each record read once through
 * its own descriptors (`givenRecord`), each list read once, a relation parameter's facts from any iterable
 * (core/record.ts isIterable), the facts a member's call gives from a list alone (runtime/write/members.ts), each value
 * of a scalar its JSON (live/wire.ts encodeGiven), and every value whose reading throws refused `json`.
 */
const hostDoor: InputDoor<WireJson, WireJson, WireJson, WireJson, WireJson> = {
	record: givenRecord,
	fact: (value, level, at) => {
		const counts = level.families.map((family) => family.count)
		return Result.flatMap(
			givenRead(at, () => {
				if (!isPlainRecord(value)) {
					return refused("json", at)
				}
				const found = level.headings.find((h) =>
					holdsExactly(value, [...h.map((named) => named.name), ...counts])
				)
				return found === undefined ? refused("members", at) : Result.ok(found)
			}),
			(heading) =>
				Result.map(
					givenRecord(value, [...heading.map((named) => named.name), ...counts], at),
					(members) => ({ heading, members })
				)
		)
	},
	kind: (value, at) =>
		givenRead(at, () =>
			isPlainRecord(value)
				? Result.ok(Reflect.getOwnPropertyDescriptor(value, "kind")?.value)
				: refused("json", at)
		),
	list: (value, at) =>
		givenRead(at, () => (isList(value) ? Result.ok(Array.from(value)) : refused("json", at))),
	rows: (value, at) =>
		givenRead(at, () =>
			isList(value) || isIterable(value) ? Result.ok(Array.from(value)) : refused("json", at)
		),
	column: (field, value, at) =>
		Result.mapError(encodeGiven(field.scalar, value), (kind) => ({ kind, at })),
	built: (entries) => Object.fromEntries(entries),
	params: (entries) => Object.fromEntries(entries),
	facts: (entries) =>
		Object.fromEntries(
			entries.map(([op, byRelation]) => [op, Object.fromEntries(byRelation)] as const)
		),
	key: (values) => values,
	noFacts: {}
}

/**
 * A caller's input to a program as JSON, in the program's input shape (`walkInput` over `hostDoor`): the inverse of
 * parseInput, over the caller's own values as the client's untyped door takes them. Every value of the input's shape
 * encodes, and any other is refused with its fault at its path (WireFault), as parseInput refuses JSON: a record that is
 * no plain record or does not hold exactly its members, no list where facts or a key stand, a value of another type
 * than its scalar's host type (live/wire.ts encodeGiven), a window's size that is no positive safe integer, a window's
 * position that is no safe integer of at least 0, or a value whose reading throws. A value the caller gives is never
 * asserted: only the server's own values are (encodeRecord, encodeKey).
 */
export const encodeInput = (input: WireInput<WireScalar>, value: unknown): Read<WireJson> =>
	walkInput(hostDoor, input, value)

/** Plain data (types/changeset BrokenLaws) as JSON: strings, finite numbers, booleans, arrays and plain records. */
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
	if (kind === "unreported" || kind === "unreproduced") {
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
	const kind = trustedMember(record, "kind")
	if (kind === "unreported" || kind === "unreproduced") {
		return { kind }
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
		case "paramPlace":
			return encodeParamPlace(value)
		case "fields":
		case "row":
		case "key":
		case "after":
		case "outcome":
		case "error":
			throw defect("a CallError's payload holds texts, laws, a witness, a reason and a place alone")
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

/**
 * The JSON of a paramRejected CallError's place (core/identity.ts ParamPlace): a scalar parameter's name, or a relation
 * parameter's name and its field's, each member exactly as the place holds it.
 */
const encodeParamPlace = (value: unknown): WireJson => {
	if (isPlainRecord(value)) {
		const kind = value["kind"]
		const name = value["name"]
		const field = value["field"]
		if (kind === "scalar" && typeof name === "string") {
			return { kind, name }
		}
		if (kind === "field" && typeof name === "string" && typeof field === "string") {
			return { kind, name, field }
		}
	}
	throw defect(
		"a paramRejected CallError's place, a scalar parameter or a relation parameter's field"
	)
}

/** A paramRejected CallError's place from the server's own JSON. */
const decodeParamPlace = (json: WireJson): ParamPlace => {
	const record = trustedRecord(json)
	const name = trustedString(trustedMember(record, "name"))
	return trustedString(trustedMember(record, "kind")) === "field"
		? { kind: "field", name, field: trustedString(trustedMember(record, "field")) }
		: { kind: "scalar", name }
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
	unavailableReason: encodeUnavailableReason,
	paramPlace: encodeParamPlace
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
	paramRejected: (r) =>
		callError("paramRejected", {
			message: messageOf(r),
			param: decodeParamPlace(trustedMember(r, "param"))
		}),
	tokenRefused: (r) => callError("tokenRefused", { message: messageOf(r) }),
	tokenExpired: (r) => callError("tokenExpired", { message: messageOf(r) }),
	refused: (r) =>
		callError("refused", {
			message: messageOf(r),
			refused: trusted<BrokenLaws>(trustedMember(r, "refused")),
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
	refused: (json) => trusted<BrokenLaws>(json),
	witness: (json) => decodeWitness(witness, json, options),
	transientReason: (json) => trusted<TransientTag>(trustedString(json)),
	credentialReason: (json) => trusted<CredentialReason>(trustedString(json)),
	unavailableReason: decodeUnavailableReason,
	paramPlace: decodeParamPlace
})
