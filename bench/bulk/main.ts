#!/usr/bin/env -S node
import { GCProfiler } from "node:v8"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
	Array as Arr,
	Console,
	Data,
	DateTime,
	Effect,
	FileSystem,
	Layer,
	pipe,
	Record as Rec,
	String as Str,
	Struct
} from "effect"
import { runIdentity, sourceIdentity, writeRunRecord } from "#bench/cold/identity.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, Bit, bit, closedId, date, drawn, natural } from "#compiler/public/fields.ts"
import {
	check,
	closed,
	contained,
	fin,
	insertableNamesOf,
	key,
	mirrors,
	on,
	ordered,
	relation,
	schema,
	select,
	tree
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { InitializedCluster } from "#test/support/cluster.ts"
import { Id, idKey, toId } from "#test/support/ids.ts"
import { installFullWorld } from "#test/support/installed.ts"
import { applicationOf, member, openServedDb } from "#test/support/served-db.ts"
import { sweep } from "#test/support/substrate/shared.ts"
import { dropRole, Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * The bulk insert benchmark, `pnpm bench bulk`: one ChangeSet call that inserts a release of a standards hierarchy
 * whole, the shape and size of Learning Commons' standards core (edullm's load of v1.17.0), as one transaction. In a
 * database of its own, the schema below is installed and its full world's served Db opened; then one `insertAll` call
 * writes every relation at once: each standard with its ordered family of children nested in it, each standard's
 * framework or item arm, and each framework's outline, a tree nested under its root. Its call is measured from the call
 * to its outcome: its wall time, the main thread's CPU time and the whole process's, every garbage collection's pause
 * and the used heap's peak (v8 GCProfiler: the largest used heap before a collection or at the end), and the CPU the
 * login's PostgreSQL backends spent. The record goes to bench/results/bulk/bulk-<time>.json and a summary is printed.
 * The machine is a virtual one, its timings noisy, and its CPU shared: the record is information, and the exit status
 * reports only whether the call was accepted with every row counted.
 */
const Text = str.regex("^.+$", "su")

const Grade = closed.ordered("Grade", [
	"PK",
	"K",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"10",
	"11",
	"12"
])
const StandardKind = closed.ordered("StandardKind", ["framework", "item"])

/** Every node of the hierarchy, its kind, and its ordered family of children. */
const Standard = relation(
	"Standard",
	{ id: Id, kind: closedId(StandardKind), children: drawn(natural) },
	["id"]
)

/** A parent's `at`-th child. */
const StandardChild = relation(
	"StandardChild",
	{ parent: Id, at: drawn(natural), child: Id, modified: date },
	["parent", "at"]
)

/** A framework, the root of one outline. */
const Framework = relation("Framework", { id: Id, name: Text, modified: date }, ["id"])

/** A standard: its grades and the day it was last modified. */
const Item = relation("Item", { id: Id, grades: bit(Grade), modified: date }, ["id"])

/** Each framework's outline, the hierarchy below it as a tree keyed by its framework and pre-order start. */
const Outline = relation(
	"Outline",
	{
		framework: Id,
		start: drawn(natural),
		end: drawn(natural),
		parent: drawn(natural),
		at: drawn(natural),
		children: drawn(natural),
		standard: Id,
		parentStandard: accumulated(Id, toId("00000000-0000-0000-0000-000000000000"), idKey)
	},
	["framework", "start"]
)

/** The frameworks a crosswalk targets. */
const CrosswalkHub = relation("CrosswalkHub", { framework: Id }, ["framework"])

const outlineMembers = select(Outline, (o) => o.gt(o.start, 0n))
const items = select(Standard, (s) => s.eq(s.kind, "item"))
const frameworks = select(Standard, (s) => s.eq(s.kind, "framework"))

const build = (name: string) =>
	schema(
		name,
		[Grade, StandardKind, Standard, StandardChild, Framework, Item, Outline, CrosswalkHub],
		[
			mirrors(on(Framework, "id"), on(frameworks, "id")),
			mirrors(on(Item, "id"), on(items, "id")),
			ordered(on(StandardChild, "parent", "at"), fin(Standard, "children")),
			key(on(StandardChild, "parent", "child")),
			contained(on(StandardChild, "child"), on(items, "id")),
			tree(on(Outline, "parent", "at"), fin(Outline, "children"), { root: ["framework"] }),
			contained(on(Outline, "framework"), on(frameworks, "id")),
			check("OutlineRoot", Outline, (o) =>
				o.or([o.gt(o.start, 0n), o.eq(o.standard, o.framework)])
			),
			contained(on(Outline, "standard", "children"), on(Standard, "id", "children")),
			contained(
				on(outlineMembers, "framework", "parent", "parentStandard"),
				on(Outline, "framework", "start", "standard")
			),
			contained(
				on(outlineMembers, "parentStandard", "at", "standard"),
				on(StandardChild, "parent", "at", "child")
			),
			contained(on(CrosswalkHub, "framework"), on(Framework, "id"))
		]
	)

/** How large a release the run writes: its frameworks and items, Learning Commons' v1.17.0 at full scale. */
interface Scale {
	readonly frameworks: number
	readonly items: number
}

const scales: Readonly<Record<"full" | "quick", Scale>> = {
	full: { frameworks: 266, items: 276818 },
	quick: { frameworks: 17, items: 17300 }
}

/** A mix of 32 bits, MurmurHash3's finalizer: a bijection of the 32-bit words. */
const mixed = (word: number): number => {
	const a = Math.imul(word ^ (word >>> 16), 0x85eb_ca6b)
	const b = Math.imul(a ^ (a >>> 13), 0xc2b2_ae35)
	return (b ^ (b >>> 16)) >>> 0
}

/**
 * The UUID the release names its `n`-th node of `kind` by: name-based and random-looking, as the export's identifiers
 * are, so no relation's rows come in their identities' order. Each of its words is a bijection of `n`, so no two nodes
 * of one kind share one.
 */
const uuidOf = (kind: number, n: number): string => {
	const hex = Arr.join(
		Arr.makeBy(4, (w) => pipe(mixed(mixed(kind * 4 + w) ^ n).toString(16), Str.padStart(8, "0"))),
		""
	)
	const variant = ((Number.parseInt(Str.slice(16, 17)(hex), 16) & 0x3) | 0x8).toString(16)
	return `${Str.slice(0, 8)(hex)}-${Str.slice(8, 12)(hex)}-5${Str.slice(13, 16)(hex)}-${variant}${Str.slice(17, 20)(hex)}-${Str.slice(20, 32)(hex)}`
}

/** The day the `n`-th row was last modified: one of a release's few hundred days. */
const dayOf = (n: number): string => {
	const day = DateTime.makeUnsafe(Date.UTC(2023, 0, 1) + (n % 600) * 86_400_000)
	return Str.slice(0, 10)(DateTime.formatIso(day))
}

/** A node of a framework's outline: its standard and its children, in order. */
interface OutlineNode {
	readonly standard: string
	readonly children: ReadonlyArray<OutlineNode>
}

/**
 * The release's rows: `scale.frameworks` frameworks sharing `scale.items` items, each framework's items a tree below it
 * whose branching is the framework's own, 3 to 14, each node's children in order. Every item has one parent, so the
 * outline unfolds each standard once.
 */
const releaseOf = (scale: Scale) => {
	const standards: Array<{
		readonly id: string
		readonly kind: "framework" | "item"
		readonly children: ReadonlyArray<{ readonly child: string; readonly modified: string }>
	}> = []
	const frameworkRows: Array<{
		readonly id: string
		readonly name: string
		readonly modified: string
	}> = []
	const itemRows: Array<{
		readonly id: string
		readonly grades: ReadonlySet<string>
		readonly modified: string
	}> = []
	const outlines: Array<OutlineNode & { readonly framework: string }> = []
	const per = Math.floor(scale.items / scale.frameworks)
	let next = 0
	for (let f = 0; f < scale.frameworks; f += 1) {
		const root = uuidOf(0, f)
		const count = f === scale.frameworks - 1 ? scale.items - next : per
		const branching = 3 + (f % 12)
		const ids = [root, ...Array.from({ length: count }, (_, i) => uuidOf(1, next + i))]
		const childrenOf = (at: number): ReadonlyArray<number> =>
			Arr.filter(
				Array.from({ length: branching }, (_, b) => at * branching + b + 1),
				(c) => c < ids.length
			)
		const nodeOf = (at: number): OutlineNode => ({
			standard: ids[at] ?? root,
			children: Arr.map(childrenOf(at), nodeOf)
		})
		for (const [at, id] of ids.entries()) {
			standards.push({
				id,
				kind: at === 0 ? "framework" : "item",
				children: Arr.map(childrenOf(at), (c) => ({
					child: ids[c] ?? root,
					modified: dayOf(next + c)
				}))
			})
			if (at > 0) {
				const n = next + at
				itemRows.push({
					id,
					grades: Bit.of(
						Grade,
						Array.from({ length: 1 + (n % 3) }, (_, g) => Grade.handles[(n + g) % 14] ?? "K")
					),
					modified: dayOf(n)
				})
			}
		}
		frameworkRows.push({ id: root, name: `Framework ${f}`, modified: dayOf(f) })
		outlines.push({ framework: root, ...nodeOf(0) })
		next += count
	}
	return {
		Standard: standards,
		Framework: frameworkRows,
		Item: itemRows,
		Outline: outlines,
		CrosswalkHub: Arr.map(Arr.take(frameworkRows, 2), (r) => ({ framework: r.id }))
	}
}

/** The rows a release of `scale` writes, by relation, the members nested in their owners counted apart. */
const expectedCounts = (scale: Scale): Readonly<Record<string, bigint>> => ({
	Standard: BigInt(scale.frameworks + scale.items),
	StandardChild: BigInt(scale.items),
	Framework: BigInt(scale.frameworks),
	Item: BigInt(scale.items),
	Outline: BigInt(scale.frameworks + scale.items),
	CrosswalkHub: 2n
})

/** A call answered otherwise than accepted with every row counted: the run is no evidence. */
class BulkMisrun extends Data.TaggedError("BulkMisrun")<{ readonly reason: string }> {}

/**
 * The CPU a process has spent, from its stat file: user and system time, in clock ticks.
 *
 * @limitKind published
 * @owner Linux
 * @unit clock ticks a second
 * @scope /proc/<pid>/stat utime and stime, which Linux reports in USER_HZ, fixed at 100 on every architecture
 * @source proc_pid_stat(5)
 */
const ticksPerSecond = 100

/** A process's CPU from its stat file's text: after its parenthesized name, utime and stime are its 12th and 13th fields. */
const processCpuMs = (stat: string): number => {
	const fields = Str.split(Arr.lastNonEmpty(Str.split(Str.trim(stat), ") ")), " ")
	const user = Number(fields[11] ?? "0")
	const system = Number(fields[12] ?? "0")
	return ((user + system) * 1000) / ticksPerSecond
}

/** One collection as GCProfiler reports it: its kind, its pause and the used heap before it. */
interface Collection {
	readonly gcType: string
	readonly cost: number
	readonly beforeGC: { readonly heapStatistics: { readonly usedHeapSize: number } }
}

interface Measured {
	readonly wallMs: number
	readonly mainThreadCpuMs: number
	readonly processCpuMs: number
	readonly gcPauseMs: number
	readonly collections: Readonly<Record<string, number>>
	readonly peakHeapMiB: number
	readonly backendCpuMs: number
	readonly maxRssMiB: number
}

const mib = (bytes: number): number => Math.round(bytes / (1024 * 1024))

const bench = (scale: Scale) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const fs = yield* FileSystem.FileSystem
		const declared = build("Bulk")
		const done = yield* installFullWorld(declared, {}, [], {
			ambient: ordinarySession,
			label: "bulk"
		})
		const world = build(done.declared)
		const served = fullWorld(world, {}, [])
		const login = done.as(served.server).role
		const db = yield* openServedDb(done, served.server.roles.app, {})
		const changes = ChangeSet.empty(world).insertAll(
			Rec.map(Struct.pick(world.relations, insertableNamesOf(world)), () => [])
		)
		const loaded = yield* db.load({ release: changes })
		const apply = applicationOf(db.ctx, member(loaded, "release"))
		const rows = releaseOf(scale)
		const backends = Effect.flatMap(
			s.admin.queryValues(
				"SELECT pid FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND usename = $1",
				[login]
			),
			(pids) =>
				Effect.forEach(pids, (row) =>
					Effect.map(
						Effect.orElseSucceed(fs.readFileString(`/proc/${String(row[0])}/stat`), () => ""),
						(stat) => [String(row[0]), stat === "" ? 0 : processCpuMs(stat)] as const
					)
				)
		)
		const backendsBefore = yield* backends
		const before = new Map(backendsBefore)
		const profiler = new GCProfiler()
		const start = yield* Effect.sync(() => {
			profiler.start()
			return {
				wall: performance.now(),
				thread: process.threadCpuUsage(),
				cpu: process.cpuUsage()
			}
		})
		const outcome = yield* apply({ params: {}, facts: { insert: rows } })
		const end = yield* Effect.sync(() => ({
			wall: performance.now(),
			thread: process.threadCpuUsage(start.thread),
			cpu: process.cpuUsage(start.cpu),
			gc: profiler.stop(),
			heap: process.memoryUsage().heapUsed,
			rss: process.resourceUsage().maxRSS
		}))
		const after = yield* backends
		if (outcome.kind !== "accepted") {
			return yield* new BulkMisrun({ reason: `the release was ${outcome.kind}` })
		}
		const counts = Rec.fromEntries(Arr.map(outcome.counts, (c) => [c.relation, c.added] as const))
		const expected = expectedCounts(scale)
		const misCounted = Arr.filter(Rec.keys(expected), (name) => counts[name] !== expected[name])
		if (Arr.isReadonlyArrayNonEmpty(misCounted)) {
			return yield* new BulkMisrun({
				reason: `added ${Arr.join(
					Arr.map(
						misCounted,
						(name) => `${name} ${String(counts[name])} of ${String(expected[name])}`
					),
					", "
				)}`
			})
		}
		const collections: ReadonlyArray<Collection> = end.gc.statistics
		const measured: Measured = {
			wallMs: Math.round(end.wall - start.wall),
			mainThreadCpuMs: Math.round((end.thread.user + end.thread.system) / 1000),
			processCpuMs: Math.round((end.cpu.user + end.cpu.system) / 1000),
			gcPauseMs: Math.round(Arr.reduce(collections, 0, (sum, c) => sum + c.cost) / 1000),
			collections: Arr.reduce(collections, Rec.empty<string, number>(), (by, c) => ({
				...by,
				[c.gcType]: (by[c.gcType] ?? 0) + 1
			})),
			peakHeapMiB: mib(
				Arr.reduce(collections, end.heap, (peak, c) =>
					Math.max(peak, c.beforeGC.heapStatistics.usedHeapSize)
				)
			),
			backendCpuMs: Math.round(
				Arr.reduce(after, 0, (sum, [pid, ms]) => sum + ms - (before.get(pid) ?? 0))
			),
			maxRssMiB: Math.round(end.rss / 1024)
		}
		return { counts: Rec.map(counts, String), measured }
	})

const scope =
	"one served insertAll call of a whole release on the full world's Db of the bench's own database, from the call to its outcome: wall time by performance.now, the main thread's and the process's CPU, every collection's pause and the used heap's peak by v8 GCProfiler (the largest used heap before a collection, or at the end), and the CPU of the login's backends from /proc; the rows are built before the call, the counts checked after it"

const line = (m: Measured): string =>
	Arr.join(
		[
			`wall ${pipe(String(m.wallMs), Str.padStart(7))} ms`,
			`main thread ${pipe(String(m.mainThreadCpuMs), Str.padStart(7))} ms`,
			`process ${pipe(String(m.processCpuMs), Str.padStart(7))} ms`,
			`gc ${pipe(String(m.gcPauseMs), Str.padStart(6))} ms`,
			`peak heap ${pipe(String(m.peakHeapMiB), Str.padStart(5))} MiB`,
			`max rss ${pipe(String(m.maxRssMiB), Str.padStart(5))} MiB`,
			`backends ${pipe(String(m.backendCpuMs), Str.padStart(7))} ms`
		],
		"  "
	)

const main = Effect.gen(function* () {
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const quick = Arr.contains(args, "--quick")
	const scale = quick ? scales.quick : scales.full
	const source = yield* sourceIdentity
	const startedAt = yield* DateTime.now
	const result = yield* Effect.scoped(
		Effect.flatMap(Layer.build(Substrate.isolatedLayer), (context) =>
			Effect.provideContext(bench(scale), context)
		)
	).pipe(Effect.ensuring(Effect.orDie(sweep(dropRole))))
	yield* Console.info(line(result.measured))
	const identity = yield* runIdentity({
		benchmark: "bulk",
		phases: ["call"],
		scope,
		options: { ...scale, startedAt: DateTime.formatIso(startedAt) },
		source
	})
	yield* writeRunRecord(startedAt, { identity, ...result })
})

NodeRuntime.runMain(
	main.pipe(
		Effect.catchTag("BulkMisrun", (e) =>
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
