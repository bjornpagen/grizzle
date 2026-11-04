import { type Effect, type Result, Schema } from "effect"
import type { ProbeDatabase, ProbeInput, ProbeResult } from "#bench/cold/probe.ts"

const Mode = Schema.Literals(["compile", "database"])
const Measures = Schema.Record(Schema.String, Schema.Finite)

/** A uuid's text: the type Uuid, five hyphenated groups, checked to be a uuid. */
const UuidText = Schema.TemplateLiteral([
	Schema.String,
	"-",
	Schema.String,
	"-",
	Schema.String,
	"-",
	Schema.String,
	"-",
	Schema.String
]).check(Schema.isUUID())

const ProbeDatabaseSchema: Schema.Codec<ProbeDatabase> = Schema.Struct({
	host: Schema.String,
	port: Schema.Finite,
	database: Schema.String,
	schema: Schema.String,
	password: Schema.String,
	caFile: Schema.String,
	snapshot: Schema.String,
	account: UuidText
})

const ProbeInputSchema: Schema.Codec<ProbeInput> = Schema.Union([
	Schema.Struct({ mode: Schema.Literal("compile"), warmRepeats: Schema.Finite }),
	Schema.Struct({
		mode: Schema.Literal("database"),
		warmRepeats: Schema.Finite,
		database: ProbeDatabaseSchema
	})
])

const ProbeResultSchema: Schema.Codec<ProbeResult> = Schema.Struct({
	mode: Mode,
	phases: Measures,
	queries: Schema.Record(Schema.String, Measures),
	memory: Schema.Struct({ rssBytes: Schema.Finite, heapUsedBytes: Schema.Finite })
})

const inputJson = Schema.fromJsonString(ProbeInputSchema)
const resultJson = Schema.fromJsonString(ProbeResultSchema)

/**
 * The documented forms of what crosses the probe's process boundary: its input on stdin and its result line on stdout
 * (bench/cold/probe.ts). Each is JSON text from another process, admitted by a decode. probe.ts loads this module only
 * after the package entry, so its own load is never part of a measured phase; its side decodes and encodes to a
 * Result.
 */
export const decodeProbeInput = (text: string): Result.Result<ProbeInput, Schema.SchemaError> =>
	Schema.decodeResult(inputJson)(text)

export const encodeProbeResult = (result: ProbeResult): Result.Result<string, Schema.SchemaError> =>
	Schema.encodeResult(resultJson)(result)

export const encodeProbeInput = (input: ProbeInput): Effect.Effect<string, Schema.SchemaError> =>
	Schema.encodeEffect(inputJson)(input)

export const decodeProbeResult = (text: string): Effect.Effect<ProbeResult, Schema.SchemaError> =>
	Schema.decodeEffect(resultJson)(text)
