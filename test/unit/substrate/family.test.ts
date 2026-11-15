/**
 * The cluster family's three facts every reader of it relies on (packages/pg/src/family.ts), each over drawn cases:
 *
 * - the worker map: in a family of K members serving W workers, every worker reaches exactly one member (memberOf),
 *   the global setup clones that worker's shared database on that member alone (workersOf), and no member serves more
 *   workers than its share, ceil(W / K), which init.sh sizes it for (size.ts over memberShare); a process outside a
 *   worker reaches the first;
 * - the family file: a family's text reads back as that family (familyText, parseFamily), and a text that is no family
 *   of its first member is refused, each corruption by name: a port listed twice, a first that is not the family's
 *   name, a port misspelled, a member too many or too few;
 * - member ports: each further member's port, found as init.sh finds it (ports.ts freePort, given the ports the family
 *   already has), is new to the family and free on every address localhost names when found, so its postmaster can
 *   listen there, whatever holds the ports beside the family's name: the case holds some of them first with
 *   listeners of its own, foreign postmasters as far as the family can tell.
 *
 * The oracles are the specification: the map (w − 1) mod K, the share ceil(W / K), the file's line format, and a port's
 * freedom as a listener of the test's own finds it.
 *
 * @plant test/plants/unit/substrate/family-one-member.patch Every worker is mapped to the first member; the map property fails.
 * @plant test/plants/unit/substrate/member-port-arithmetic.patch A member's port is the one after the family's last, derived by arithmetic,
 * not found free; the port property fails.
 */
import { lookup } from "node:dns/promises"
import { createServer, type Server } from "node:net"
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, Scope } from "effect"
import { type ClusterFamily, familyText, memberOf, parseFamily, workersOf } from "#pg/family.ts"
import { clusterAt } from "#pg/local-cluster.ts"
import { freePort } from "#pg/ports.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"

/** The greatest TCP port: a port is sixteen bits, and zero is no port to listen on. */
const greatestPort = 2 ** 16 - 1

/** A family of `size` members on the ports from `first` up, each a member's identity alone. */
const familyAt = (first: number, size: number): ClusterFamily => ({
	members: [clusterAt(first), ...upTo(size - 1, (i) => clusterAt(first + i + 1))]
})

interface MapCase {
	readonly workers: number
	readonly members: number
}

const mapGen: Gen<MapCase> = (source) => {
	const workers = source.draw(int(1, 160))
	return { workers, members: source.draw(int(1, workers)) }
}

type MapFeature =
	| "one member"
	| "several members"
	| "workers spread evenly"
	| "a member serving one worker fewer"
	| "a member for every worker"

/** How a family file's text is spoiled, or not. */
type Corruption =
	| "none"
	| "a port twice"
	| "another first member"
	| "a port misspelled"
	| "a member too many"
	| "a member too few"

const corruptions: Arr.NonEmptyReadonlyArray<Corruption> = [
	"none",
	"a port twice",
	"another first member",
	"a port misspelled",
	"a member too many",
	"a member too few"
]

interface FileCase {
	readonly members: number
	readonly first: number
	readonly corruption: Corruption
	/** Where a misspelling goes: a leading zero, a sign, past the greatest port, or no digits. */
	readonly misspelling: "leading zero" | "sign" | "past the greatest port" | "no digits"
}

const fileGen: Gen<FileCase> = (source) => ({
	members: source.draw(int(1, 6)),
	first: source.draw(int(1, greatestPort - 8)),
	corruption: source.draw(element(corruptions)),
	misspelling: source.draw(
		element(["leading zero", "sign", "past the greatest port", "no digits"] as const)
	)
})

type FileFeature =
	| "a family of one member read back"
	| "a family of several read back"
	| `${Corruption} refused`

/** The family file's text of `c`, spoiled as it says. */
const fileText = (c: FileCase): string => {
	const ports = upTo(c.members, (i) => c.first + i)
	const lines = Arr.map(ports, (port) => `${port}`)
	const [head = `${c.first}`, ...rest] = lines
	switch (c.corruption) {
		case "none":
			return Arr.join(
				Arr.map(lines, (line) => `${line}\n`),
				""
			)
		case "a port twice":
			return Arr.join(
				Arr.map([...lines, head], (line) => `${line}\n`),
				""
			)
		case "another first member":
			return Arr.join(
				Arr.map([`${c.first + 7}`, ...rest], (line) => `${line}\n`),
				""
			)
		case "a port misspelled": {
			const spoiled = {
				"leading zero": `0${head}`,
				sign: `+${head}`,
				"past the greatest port": `${greatestPort + 1}`,
				"no digits": "port"
			}[c.misspelling]
			return Arr.join(
				Arr.map([spoiled, ...rest], (line) => `${line}\n`),
				""
			)
		}
		case "a member too many":
			return Arr.join(
				Arr.map([...lines, `${c.first + c.members}`], (line) => `${line}\n`),
				""
			)
		case "a member too few":
			return Arr.join(
				Arr.map(Arr.dropRight(lines, 1), (line) => `${line}\n`),
				""
			)
	}
}

interface PortCase {
	/** The members found after the first, as init.sh finds them. */
	readonly further: number
	/** How many of the ports right after the family's name foreign listeners hold first. */
	readonly held: number
}

const portGen: Gen<PortCase> = (source) => {
	const further = source.draw(int(1, 4))
	return { further, held: source.draw(int(0, further)) }
}

type PortFeature =
	| "the port after the family's name held"
	| "every port after the family's name held"
	| "several members found"

/**
 * A listener of the test's own on `port` at `address`, held for the scope, or none when something else holds the port
 * there already, which holds it as well as this would.
 */
const hold = (
	address: string,
	port: number
): Effect.Effect<Option.Option<Server>, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.callback<Option.Option<Server>>((resume) => {
			const server = createServer()
			server.once("error", () => resume(Effect.succeedNone))
			server.listen({ port, host: address, exclusive: true }, () =>
				resume(Effect.succeedSome(server))
			)
		}),
		(held) =>
			Option.match(held, {
				onNone: () => Effect.void,
				onSome: (server) =>
					Effect.callback<void>((resume) => {
						server.close(() => resume(Effect.void))
					})
			})
	)

/** Whether a listener of the test's own can listen on `port` at `address`, closed again at once. */
const listenable = (address: string, port: number): Effect.Effect<boolean> =>
	Effect.scoped(Effect.map(hold(address, port), Option.isSome))

/**
 * A port the system chooses for a listener of the test's own at localhost's first address, closed again: the family's
 * name, chosen apart from the code under test.
 */
const systemPort = (addresses: Arr.NonEmptyReadonlyArray<string>): Effect.Effect<number> =>
	Effect.callback<number>((resume) => {
		const server = createServer()
		server.listen({ port: 0, host: Arr.headNonEmpty(addresses), exclusive: true }, () => {
			const bound = server.address()
			server.close(() => {
				resume(
					bound === null || typeof bound === "string"
						? Effect.die(new Error("a TCP listener reported no port"))
						: Effect.succeed(bound.port)
				)
			})
		})
	})

const localhostAddresses: Effect.Effect<Arr.NonEmptyReadonlyArray<string>> = Effect.flatMap(
	Effect.promise(() => lookup("localhost", { all: true })),
	(found) => {
		const addresses = Arr.map(found, ({ address }) => address)
		return Arr.isReadonlyArrayNonEmpty(addresses)
			? Effect.succeed(addresses)
			: Effect.die(new Error("localhost names no address"))
	}
)

describe("the cluster family", () => {
	it.effect(
		"maps every worker to exactly the member that clones its database, none past its share, and the first outside a worker",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/substrate/family-map",
						draw: drawn(mapGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "worker w on member (w − 1) mod K, none serving past ceil(W / K)"
						},
						coverage: required<MapFeature>(
							[
								"one member",
								"several members",
								"workers spread evenly",
								"a member serving one worker fewer",
								"a member for every worker"
							],
							{ cases: 48, sense: notesOnly }
						),
						kept: [],
						runs: 48,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 12,
						caseHang
					},
					(x, c) =>
						Effect.sync(() => {
							const family = familyAt(30_000, x.members)
							const share = Math.ceil(x.workers / x.members)
							const loads = upTo(x.members, (i) => workersOf(x.members, i, x.workers))
							for (let w = 1; w <= x.workers; w++) {
								const reached = memberOf(family, Option.some(w))
								const index = family.members.indexOf(reached)
								assert.ok(index >= 0, `worker ${w} reaches a member of the family`)
								const cloning = Arr.filter(
									upTo(x.members, (i) => i),
									(i) => (loads[i] ?? []).includes(w)
								)
								assert.deepEqual(
									cloning,
									[index],
									`worker ${w}'s database is cloned on the member it reaches, and on no other`
								)
							}
							for (const [i, load] of loads.entries()) {
								assert.ok(
									load.length >= 1 && load.length <= share,
									`member ${i} serves ${load.length} workers of ${x.workers}, its share ${share}`
								)
							}
							assert.equal(
								memberOf(family, Option.none()),
								family.members[0],
								"a process outside a worker reaches the first member"
							)
							c.note(x.members === 1 ? "one member" : "several members")
							c.note(
								x.workers % x.members === 0
									? "workers spread evenly"
									: "a member serving one worker fewer"
							)
							if (x.members === x.workers) {
								c.note("a member for every worker")
							}
						})
				)
			)
	)

	it.effect(
		"reads a family file back as its family, and refuses every text that is no family of its first member",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/substrate/family-file",
						draw: drawn(fileGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "one port a line in canonical decimal, none twice, the family's name first, as many as its members"
						},
						coverage: required<FileFeature>(
							[
								"a family of one member read back",
								"a family of several read back",
								...Arr.map(
									Arr.drop(corruptions, 1),
									(corruption): FileFeature => `${corruption} refused`
								)
							],
							{ cases: 48, sense: notesOnly }
						),
						kept: [],
						runs: 48,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 12,
						caseHang
					},
					(x, c) =>
						Effect.sync(() => {
							const first = clusterAt(x.first)
							const text = fileText(x)
							const read = parseFamily(first, x.members, text)
							if (x.corruption === "none") {
								assert.ok(
									Result.isSuccess(read),
									`${Formatter.format(text)} reads back: ${Formatter.format(read)}`
								)
								if (Result.isSuccess(read)) {
									assert.equal(
										familyText(read.success),
										text,
										"the family's text is the text it was read from"
									)
									const readPorts: ReadonlyArray<number> = Arr.map(
										read.success.members,
										(member) => member.port
									)
									assert.deepEqual(
										readPorts,
										upTo(x.members, (i) => x.first + i)
									)
								}
								c.note(
									x.members === 1
										? "a family of one member read back"
										: "a family of several read back"
								)
								return
							}
							assert.ok(
								Result.isFailure(read),
								`${Formatter.format(text)} is refused: ${Formatter.format(read)}`
							)
							c.note(`${x.corruption} refused`)
						})
				)
			)
	)

	it.effect(
		"finds each further member a port new to the family and free on every localhost address, whatever holds the ports beside its name",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/substrate/family-ports",
						draw: drawn(portGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a port is free where a listener of the test's own can listen on it at every address localhost names"
						},
						coverage: required<PortFeature>(
							[
								"the port after the family's name held",
								"every port after the family's name held",
								"several members found"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 24,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(x, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								const addresses = yield* localhostAddresses
								const name = yield* systemPort(addresses)
								for (const offset of upTo(x.held, (i) => i + 1)) {
									if (name + offset <= greatestPort) {
										yield* Effect.forEach(addresses, (address) => hold(address, name + offset), {
											discard: true
										})
									}
								}
								let members: ReadonlyArray<number> = [name]
								for (let n = 0; n < x.further; n++) {
									const port = yield* Effect.orDie(freePort(members))
									assert.ok(
										!members.includes(port),
										`port ${port} is new to the family ${Arr.join(
											Arr.map(members, (m) => `${m}`),
											", "
										)}`
									)
									const free = yield* Effect.forEach(addresses, (address) =>
										listenable(address, port)
									)
									assert.ok(
										Arr.every(free, (f) => f),
										`port ${port}, found for a member of ${Arr.join(
											Arr.map(members, (m) => `${m}`),
											", "
										)} with ${x.held} port(s) after ${name} held, is free at every address`
									)
									members = Arr.append(members, port)
								}
								if (x.held >= 1) {
									c.note("the port after the family's name held")
								}
								if (x.held === x.further) {
									c.note("every port after the family's name held")
								}
								if (x.further > 1) {
									c.note("several members found")
								}
							})
						)
				)
			)
	)
})
