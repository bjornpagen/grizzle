#!/usr/bin/env -S node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Console,
	Data,
	DateTime,
	Effect,
	FileSystem,
	Layer,
	pipe,
	String as Str
} from "effect"
import { repoRoot, type RunIdentity, runIdentity, sourceIdentity } from "#bench/cold/identity.ts"
import { elapsed, type Summary, summarize } from "#bench/cold/stats.ts"
import { assembledIn } from "#compiler/codec/delivery.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { bytesChunkLength } from "#compiler/core/limits.ts"
import { jsonDocument, trusted } from "#compiler/core/trusted.ts"
import type { OutputRows } from "#compiler/core/wire.ts"
import { deliveredRows, deliveryOfColumns, textColumn } from "#compiler/lower/delivery.ts"
import { col, provedCore, table, targetAs } from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import { InitializedCluster } from "#test/support/cluster.ts"
import { sweep } from "#test/support/substrate/shared.ts"
import { dropRole, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The bytes delivery benchmark, `pnpm bench bytes`: one bytes value read back through its delivery
 * (lower/delivery.ts deliveredRows, codec/delivery.ts assembledIn) under each candidate chunk length, the evidence
 * core/limits.ts bytesChunkLength cites. In a database of its own, one row of a 256 MiB value is stored, once of
 * random bytes, which PostgreSQL stores uncompressed out of line, and once of a repeating text, which it compresses;
 * then for each chunk length the delivered read of the table is sent `runs` times through the owner's session and its
 * answer assembled into the value, timed by performance.now around both, the first run cold, and the value checked
 * equal to the one stored. The record, with its full identity, goes to bench/results/bytes/bytes-<time>.json, one file
 * a run, and a table is printed. The machine is a virtual one, its timings noisy: the record is information, and the
 * exit status reports only whether the run completed with every value read back whole.
 */
const runs = 3

/** The value's length: 256 MiB, past the bound a value whose hex text is one string was held to. */
const valueLength = 256 * 1024 * 1024

type Content = "random" | "repeating"

/**
 * The chunk lengths measured for each content, by factors of four: 64 KiB to 64 MiB for random bytes, and from 1 MiB
 * for the repeating text, whose compressed value PostgreSQL decompresses from its start up to every chunk's end, so a
 * read costs the square of the chunks: one read at 64 KiB, 4,096 chunks, ran past six minutes.
 */
const chunkLengths: Readonly<Record<Content, Arr.NonEmptyReadonlyArray<number>>> = {
	random: [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024],
	repeating: [1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024]
}

/** A value of `content`: xorshift bytes, or the bytes of one repeating sentence. */
const valueOf = (content: Content): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(valueLength)
	if (content === "repeating") {
		const sentence = new TextEncoder().encode("a bytes value read back in chunks of its delivery; ")
		for (let i = 0; i < out.length; i += 1) {
			out[i] = sentence[i % sentence.length] ?? 0
		}
		return out
	}
	let x = 0x2545_f491
	for (let i = 0; i < out.length; i += 1) {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		out[i] = x & 0xff
	}
	return out
}

/** One content's reads at one chunk length: each run's milliseconds, the first cold, and the result rows each took. */
interface BytesCase {
	readonly content: Content
	readonly chunkLength: number
	readonly resultRows: number
	readonly samplesMs: Arr.NonEmptyReadonlyArray<number>
	readonly summary: Summary
	readonly rssMiB: number
}

interface BytesRecord {
	readonly identity: RunIdentity
	readonly valueLength: number
	readonly inForce: number
	readonly cases: ReadonlyArray<BytesCase>
}

/** A value read back other than stored: the run is no evidence. */
class ValueMisread extends Data.TaggedError("ValueMisread")<{ readonly reason: string }> {}

/** A cell the session hands back as no text: grizzle's delivered SQL casts every cell to text. */
const textCells = (rows: ReadonlyArray<ReadonlyArray<unknown>>): OutputRows =>
	trusted<OutputRows>(rows)

const sameBytes = (x: Uint8Array, y: Uint8Array): boolean =>
	x.length === y.length && x.every((byte, at) => byte === y[at])

/** The delivered read of the one row's id and value, under `chunkLength`, as its SQL text. */
const readOf = (schema: string, name: string, chunkLength: number): string => {
	const supply = new NameSupply({ relationStart: 0, columnStart: 1 })
	const r = supply.relation({ kind: "internal", purpose: "bench row" })
	const read = deliveredRows(
		{
			kind: "select",
			with: undefined,
			body: provedCore(
				"keyed",
				[targetAs(col(r, "id"), "id"), targetAs(col(r, "body"), "body")],
				[table(schema, name, r)],
				undefined
			),
			orderBy: [],
			limit: undefined,
			offset: undefined
		},
		[textColumn, { kind: "bytes" }],
		[],
		supply,
		chunkLength
	)
	return emitText(read, supply.map()).text
}

const columns = deliveryOfColumns([textColumn, { kind: "bytes" }])

const scope =
	"one read of one stored 256 MiB bytes value through its delivered SQL (lower/delivery.ts) on the owner's session of the bench's own database, and its assembly into the value (codec/delivery.ts assembledIn), timed together by performance.now; the write and the check of the value read back are outside it; rss is the process's after the run"

const row = (c: BytesCase): string =>
	Arr.join(
		[
			`  ${pipe(c.content, Str.padEnd(10))}`,
			`chunk ${pipe(String(c.chunkLength), Str.padStart(9))}`,
			`rows ${pipe(String(c.resultRows), Str.padStart(5))}`,
			`first ${pipe(c.samplesMs[0].toFixed(0), Str.padStart(7))} ms`,
			`p50 ${pipe(c.summary.p50.toFixed(0), Str.padStart(7))} ms`,
			`max ${pipe(c.summary.max.toFixed(0), Str.padStart(7))} ms`,
			`rss ${pipe(String(c.rssMiB), Str.padStart(6))} MiB`
		],
		"  "
	)

const recordFile = (outDir: string, at: DateTime.Utc): string =>
	`${outDir}/bytes-${Str.replaceAll(":", "")(Str.slice(0, 19)(DateTime.formatIso(at)))}.json`

const bench = Effect.gen(function* () {
	const s = yield* Substrate
	const owner = yield* s.session(ownerSession())
	yield* owner.values(
		"CREATE TABLE public.bench_bytes (id integer PRIMARY KEY, body bytea NOT NULL)",
		[]
	)
	const sql = (chunkLength: number) => readOf("public", "bench_bytes", chunkLength)
	const cases: Array<BytesCase> = []
	for (const content of ["random", "repeating"] as const) {
		const value = valueOf(content)
		yield* owner.values("TRUNCATE public.bench_bytes", [])
		yield* owner.values("INSERT INTO public.bench_bytes VALUES (1, $1::bytea)", [value])
		for (const chunkLength of chunkLengths[content]) {
			const text = sql(chunkLength)
			const samples: Array<number> = []
			let resultRows = 0
			for (let run = 0; run < runs; run += 1) {
				const start = performance.now()
				const values = yield* owner.values(text, [])
				const answer = textCells(values)
				const rows = assembledIn(columns, answer, chunkLength)
				samples.push(elapsed(start))
				resultRows = answer.length
				const read = rows[0]?.[1]
				if (!(read instanceof Uint8Array) || !sameBytes(read, value)) {
					return yield* new ValueMisread({
						reason: `the ${content} value read back otherwise at chunk length ${chunkLength}`
					})
				}
			}
			const [first, ...rest] = samples
			if (first === undefined) {
				return yield* Effect.die(new Error("a case of no run"))
			}
			const samplesMs: Arr.NonEmptyReadonlyArray<number> = [first, ...rest]
			const one: BytesCase = {
				content,
				chunkLength,
				resultRows,
				samplesMs,
				summary: summarize(samplesMs),
				rssMiB: Math.round(process.memoryUsage().rss / (1024 * 1024))
			}
			yield* Console.info(row(one))
			cases.push(one)
		}
	}
	return cases
})

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const source = yield* sourceIdentity
	const startedAt = yield* DateTime.now
	const cases = yield* Effect.scoped(
		Effect.flatMap(Layer.build(Substrate.isolatedLayer), (context) =>
			Effect.provideContext(bench, context)
		)
	).pipe(Effect.ensuring(Effect.orDie(sweep(dropRole))))
	const identity = yield* runIdentity({
		benchmark: "bytes",
		phases: ["deliveredRead"],
		scope,
		options: { runs, valueLength, chunkLengths, startedAt: DateTime.formatIso(startedAt) },
		source
	})
	const record: BytesRecord = {
		identity,
		valueLength,
		inForce: bytesChunkLength.value,
		cases
	}
	const outDir = `${repoRoot}/bench/results/bytes`
	const file = recordFile(outDir, startedAt)
	yield* fs.makeDirectory(outDir, { recursive: true })
	yield* fs.writeFileString(file, `${jsonDocument(trusted<Json>(record))}\n`)
	yield* Console.info(`record: ${file}`)
})

NodeRuntime.runMain(
	main.pipe(
		Effect.catchTag("ValueMisread", (e) =>
			Effect.andThen(
				Console.error(e.reason),
				Effect.sync(() => {
					process.exitCode = 1
				})
			)
		),
		Effect.provide([NodeServices.layer, InitializedCluster.layer])
	)
)
