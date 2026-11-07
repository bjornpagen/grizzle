import { Array as Arr, Effect, Record as Rec, Result, Stream } from "effect"
import { readHost } from "#adapter/engine.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import type { HostParams } from "#adapter/reader/execution.ts"
import {
	hasProperties,
	isList,
	type ParamDecl,
	type ParamMap,
	type ParamValue
} from "#compiler/plan/common.ts"
import { encodeFailure, factPlace, slotPlace } from "#compiler/plan/read.ts"

/**
 * A read's parameter values as the statements' encoders take them.
 *
 * A relation parameter accepts an array of facts or a Stream of facts, and travels as its arrays (relations.ts): a
 * Stream is collected on the host before any statement runs, whole, and the statement's own encoder then deduplicates
 * the collected facts exactly as it does an array's; a Stream that fails is a read that could not encode its input, an
 * EncodingFailure naming the parameter (stage encode), as a write's is. A Stream parameter has no error or requirement
 * channel of its own (ParamsOf types it Stream.Stream<Fact>); a failure that arrives anyway is still the read's
 * encoding failure, never a defect.
 * Scalar parameters and arrays pass through unchanged.
 *
 * The parameters reach the runtime from the typed Db boundary (types/db Db, QueryReader and Compiled),
 * whose every params argument is ParamArg<P> for the program's own ParamsOf map P. ParamArg states that each value is
 * a ParamValue (types/core), so the runtime takes the parameters as a ParamMap by construction, the argument itself
 * checked to be a record (readParams), since a JavaScript caller may pass any value; and a value that is a
 * Stream is a Stream with no requirement channel: ParamsOf types a relation parameter
 * ReadonlyArray<Fact<H>> | Stream.Stream<Fact<H>>. Stream.isStream only tells the Stream member of
 * ParamValue from the others; no check claims the channels. A failure the Stream raises anyway is the read's encoding
 * failure.
 *
 * The parameters argument refused as a whole (no record, or one whose reading throws): an EncodingFailure naming no
 * slot, as a write's names it.
 */
export const unreadableArguments = (): ReadFailure =>
	new ReadFailure({ reason: encodeFailure("factShape", factPlace) })

/** Parameter values by name, each a data property's value off the caller's map. */
type ParamValues = Readonly<Record<string, ParamValue>>

/**
 * The values of the parameters `names` off a JavaScript caller's map of a program's parameters, read once at the
 * boundary (core/host.ts hostRead): each a data property's value, or what its getter returns called once, and nothing
 * else of the map, so every later read is of the copy. An argument that is no record (undefined, null, any other
 * primitive, a function or an array, none of which ParamArg admits) is `fault`, whether or not the program declares a
 * parameter; so is a map whose reading throws (a refusing proxy), and a map with a key that names none of the
 * program's parameters, which ParamArg refuses too: a parameter the caller meant and misspelled fails closed instead of
 * binding nothing. Each value stays opaque here, to be read at its own boundary: a scalar by its codec's admitter, a
 * relation's facts by the relation normalizer, a Stream by relationStreams.
 */
export const readParams = <F>(
	names: ReadonlyArray<string>,
	params: ParamMap,
	fault: F
): Result.Result<ParamValues, F> =>
	readHost(fault, () => {
		if (typeof params !== "object" || !hasProperties(params) || isList(params)) {
			return Result.fail(fault)
		}
		if (Arr.some(Rec.keys<string, ParamValue>(params), (key) => !names.includes(key))) {
			return Result.fail(fault)
		}
		return Result.succeed(valuesAt(names, params))
	})

/**
 * A key's values off a JavaScript caller's record, read once at the boundary as readParams reads a map: the values at
 * the key's `fields` and nothing else of it, so a whole fact of the key's relation names its key. An argument that is
 * no record, or whose reading throws, is `fault`.
 */
export const readKeyValues = <F>(
	fields: ReadonlyArray<string>,
	values: ParamMap,
	fault: F
): Result.Result<ParamValues, F> =>
	readHost(fault, () =>
		typeof values !== "object" || !hasProperties(values) || isList(values)
			? Result.fail(fault)
			: Result.succeed(valuesAt(fields, values))
	)

/** The values of a record at `names`, each a data property's value or what its getter returns, absent ones left out. */
const valuesAt = (names: ReadonlyArray<string>, record: ParamMap): ParamValues => {
	const values: Record<string, ParamValue> = {}
	for (const name of names) {
		const value = record[name]
		if (value !== undefined) {
			values[name] = value
		}
	}
	return values
}

/** A declared relation parameter whose value is a Stream, with its Stream. */
interface RelationStream {
	readonly decl: ParamDecl
	readonly stream: Stream.Stream<unknown, unknown>
}

/**
 * The declared relation parameters whose value is a Stream, each with its Stream, recognized by Stream.isStream at the
 * boundary (hostRead): a value whose reading throws is `fault`. Its facts are checked by the statement's encoder once
 * collected, and a failure that arrives anyway is mapped to the read's encoding failure.
 */
export const relationStreams = <F>(
	declared: ReadonlyArray<ParamDecl>,
	params: ParamValues,
	fault: F
): Result.Result<ReadonlyArray<RelationStream>, F> =>
	readHost(fault, () =>
		Result.succeed(
			Arr.flatMap(declared, (decl) => {
				const value = params[decl.name]
				return decl.kind === "relation" && value !== undefined && Stream.isStream(value)
					? [{ decl, stream: value }]
					: []
			})
		)
	)

/** Collects the Stream relation parameter `decl`, whole; a Stream that fails encodes nothing of the parameter. */
const collect = (
	decl: ParamDecl,
	stream: Stream.Stream<unknown, unknown>
): Effect.Effect<ReadonlyArray<unknown>, ReadFailure> =>
	Stream.runCollect(
		Stream.mapError(
			stream,
			() => new ReadFailure({ reason: encodeFailure("factShape", slotPlace(decl.name)) })
		)
	)

/** The read's parameters, read once (readParams), with every Stream relation parameter collected. */
export const hostParams = (
	declared: ReadonlyArray<ParamDecl>,
	params: ParamMap
): Effect.Effect<HostParams, ReadFailure> =>
	Effect.suspend(() => {
		const unreadable = unreadableArguments()
		const given = readParams(
			Arr.map(declared, (decl) => decl.name),
			params,
			unreadable
		)
		if (Result.isFailure(given)) {
			return Effect.fail(given.failure)
		}
		const found = relationStreams(declared, given.success, unreadable)
		if (Result.isFailure(found)) {
			return Effect.fail(found.failure)
		}
		const streams = found.success
		if (streams.length === 0) {
			return Effect.succeed(given.success)
		}
		return Effect.map(
			Effect.forEach(streams, ({ decl, stream }) =>
				Effect.map(collect(decl, stream), (facts) => [decl.name, facts] as const)
			),
			(collected) => ({ ...given.success, ...Rec.fromEntries(collected) })
		)
	})
