import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Rec from "effect/Record"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { readHost } from "#adapter/engine.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { CallInputRefused } from "#adapter/errors/failures.ts"
import type { HostParams } from "#adapter/reader/execution.ts"
import type { CallerParamDecl, EncodingFailure } from "#compiler/plan/common.ts"
import {
	encodeFailure,
	factPlace,
	hasProperties,
	isList,
	slotPlace
} from "#compiler/plan/runtime.ts"

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
 * The parameters reach the runtime as a call's input holds them (db/input.ts), any value a caller passes: the map is
 * read once at the call's boundary, by the program's declared names (readParams), and each value stays opaque until its
 * own boundary reads it, a scalar by its codec's admitter, a relation's facts by the relation normalizer, a Stream by
 * relationStreams. Stream.isStream only tells a Stream from the other values; a failure the Stream raises is the
 * read's encoding failure.
 */

/** Parameter values by name, each a data property's value off the caller's map, opaque until its codec reads it. */
export type ParamValues = Readonly<Record<string, unknown>>

/** Params that are no record of the program's parameters, or whose reading throws (CallInputRefused `params`). */
const unreadParams = new CallInputRefused({ fault: "params" })

/**
 * The values of the parameters `names` of the program `program`, as its workload serves it, off a JavaScript caller's
 * map of them, read once at the call's boundary (core/host.ts hostRead): each a data property's value, or what its
 * getter returns called once, and nothing else of the map, so every later read is of the copy. An argument that is no
 * record (undefined, null, any other primitive, a function or an array, none of which ParamArg admits), or a map whose
 * reading throws (a refusing proxy), is refused as the input's `params`, whether or not the program declares a
 * parameter; a key of the map that names none of the program's parameters, which ParamArg refuses too, is refused as
 * itself (UndeclaredParameter): a parameter the caller meant and misspelled, or one another program takes, fails closed
 * instead of binding nothing. Each value stays opaque here, to be read at its own boundary: a scalar by its codec's
 * admitter, a relation's facts by the relation normalizer, a Stream by relationStreams.
 */
export const readParams = (
	program: string,
	names: ReadonlyArray<string>,
	params: unknown
): Result.Result<ParamValues, CallInputRefused> =>
	readHost(unreadParams, () => {
		if (typeof params !== "object" || !hasProperties(params) || isList(params)) {
			return Result.fail(unreadParams)
		}
		const undeclared = Arr.findFirst(Rec.keys(params), (key) => !names.includes(key))
		return undeclared._tag === "Some"
			? Result.fail(new CallInputRefused({ fault: { program, parameter: undeclared.value } }))
			: Result.succeed(valuesAt(names, params))
	})

/**
 * A key's values off a JavaScript caller's record, read once at the boundary as readParams reads a map: the values at
 * the key's `fields` and nothing else of it, so a whole fact of the key's relation names its key. An argument that is
 * no record, or whose reading throws, is refused as the input's `params`.
 */
export const readKeyValues = (
	fields: ReadonlyArray<string>,
	values: unknown
): Result.Result<ParamValues, CallInputRefused> =>
	readHost(unreadParams, () =>
		typeof values !== "object" || !hasProperties(values) || isList(values)
			? Result.fail(unreadParams)
			: Result.succeed(valuesAt(fields, values))
	)

/** The values of a record at `names`, each a data property's value or what its getter returns, absent ones left out. */
const valuesAt = (
	names: ReadonlyArray<string>,
	record: Readonly<Record<string, unknown>>
): ParamValues => {
	const values: Record<string, unknown> = {}
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
	readonly decl: CallerParamDecl
	readonly stream: Stream.Stream<unknown, unknown>
}

/**
 * The one site of the fact that a Stream a call's parameters hold has no requirement: the typed handle types a
 * relation parameter's Stream with none (live/program.ts InputOf, types/core ParamArg), and Stream.isStream reads the
 * rest, a Stream, which no runtime check can read the requirement channel of.
 */
const isParamStream = (value: unknown): value is Stream.Stream<unknown, unknown> =>
	Stream.isStream(value)

/** A parameter's value whose reading throws (relationStreams): an EncodingFailure naming no slot. */
const unreadValue = encodeFailure("factShape", factPlace)

/**
 * The declared relation parameters whose value is a Stream, each with its Stream, recognized at the boundary
 * (isParamStream, hostRead): a value whose reading throws is refused as factShape naming no slot. Its facts are checked
 * by the statement's encoder once collected, and a failure that arrives anyway is mapped to the read's encoding failure.
 */
export const relationStreams = (
	declared: ReadonlyArray<CallerParamDecl>,
	params: ParamValues
): Result.Result<ReadonlyArray<RelationStream>, EncodingFailure> =>
	readHost(unreadValue, () =>
		Result.succeed(
			Arr.flatMap(declared, (decl) => {
				const value = params[decl.name]
				return decl.kind === "relation" && value !== undefined && isParamStream(value)
					? [{ decl, stream: value }]
					: []
			})
		)
	)

/** Collects the Stream relation parameter `decl`, whole; a Stream that fails encodes nothing of the parameter. */
const collect = (
	decl: CallerParamDecl,
	stream: Stream.Stream<unknown, unknown>
): Effect.Effect<ReadonlyArray<unknown>, ReadFailure> =>
	Stream.runCollect(
		Stream.mapError(
			stream,
			() => new ReadFailure({ reason: encodeFailure("factShape", slotPlace(decl.name)) })
		)
	)

/**
 * The parameters of the read `program`, as its workload serves it, read once (readParams), with every Stream relation
 * parameter collected.
 */
export const hostParams = (
	program: string,
	declared: ReadonlyArray<CallerParamDecl>,
	params: unknown
): Effect.Effect<HostParams, ReadFailure> =>
	Effect.suspend(() => {
		const given = readParams(
			program,
			Arr.map(declared, (decl) => decl.name),
			params
		)
		if (Result.isFailure(given)) {
			return Effect.fail(new ReadFailure({ reason: given.failure }))
		}
		const found = relationStreams(declared, given.success)
		if (Result.isFailure(found)) {
			return Effect.fail(new ReadFailure({ reason: found.failure }))
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
