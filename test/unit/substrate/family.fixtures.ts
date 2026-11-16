/** What the properties of family.test.ts read: its spaces, models and helpers. */

import { lookup } from "node:dns/promises"
import { createServer, type Server } from "node:net"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Scope } from "effect"
import { type ClusterFamily } from "#pg/family.ts"
import { clusterAt } from "#pg/local-cluster.ts"
import { upTo } from "#test/support/up-to.ts"

/** The greatest TCP port: a port is sixteen bits, and zero is no port to listen on. */
export const greatestPort = 2 ** 16 - 1

/** A family of `size` members on the ports from `first` up, each a member's identity alone. */
export const familyAt = (first: number, size: number): ClusterFamily => ({
	members: [clusterAt(first), ...upTo(size - 1, (i) => clusterAt(first + i + 1))]
})

interface MapCase {
	readonly workers: number
	readonly members: number
}

export const mapGen: Gen<MapCase> = (source) => {
	const workers = source.draw(int(1, 160))
	return { workers, members: source.draw(int(1, workers)) }
}

export type MapFeature =
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

export const corruptions: Arr.NonEmptyReadonlyArray<Corruption> = [
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

export const fileGen: Gen<FileCase> = (source) => ({
	members: source.draw(int(1, 6)),
	first: source.draw(int(1, greatestPort - 8)),
	corruption: source.draw(element(corruptions)),
	misspelling: source.draw(
		element(["leading zero", "sign", "past the greatest port", "no digits"] as const)
	)
})

export type FileFeature =
	| "a family of one member read back"
	| "a family of several read back"
	| `${Corruption} refused`

/** The family file's text of `c`, spoiled as it says. */
export const fileText = (c: FileCase): string => {
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

export const portGen: Gen<PortCase> = (source) => {
	const further = source.draw(int(1, 4))
	return { further, held: source.draw(int(0, further)) }
}

export type PortFeature =
	| "the port after the family's name held"
	| "every port after the family's name held"
	| "several members found"

/**
 * A listener of the test's own on `port` at `address`, held for the scope, or none when something else holds the port
 * there already, which holds it as well as this would.
 */
export const hold = (
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
export const listenable = (address: string, port: number): Effect.Effect<boolean> =>
	Effect.scoped(Effect.map(hold(address, port), Option.isSome))

/**
 * A port the system chooses for a listener of the test's own at localhost's first address, closed again: the family's
 * name, chosen apart from the code under test.
 */
export const systemPort = (addresses: Arr.NonEmptyReadonlyArray<string>): Effect.Effect<number> =>
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

export const localhostAddresses: Effect.Effect<Arr.NonEmptyReadonlyArray<string>> = Effect.flatMap(
	Effect.promise(() => lookup("localhost", { all: true })),
	(found) => {
		const addresses = Arr.map(found, ({ address }) => address)
		return Arr.isReadonlyArrayNonEmpty(addresses)
			? Effect.succeed(addresses)
			: Effect.die(new Error("localhost names no address"))
	}
)
