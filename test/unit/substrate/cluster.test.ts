/**
 * The local cluster a name selects (test/support/env.ts selectCluster), which every script reads through
 * scripts/pg/cluster.ts and every test through env.ts, over every name GRIZZLE_PG_CLUSTER can hold in a box:
 *
 * - unset, it selects today's cluster exactly, as pin.env spelled it before clusters were named: port 5433 and the
 *   state directory `$HOME/.local/var/grizzle/pg$PG_PIN_VERSION` with its data, tls, log and socket directories and
 *   the owner's password file;
 * - a port spelled in canonical decimal selects the cluster of that port, whose state directory sits beside the
 *   default's and reads back as that port alone: the read-back is a left inverse, so no two ports share a directory,
 *   and none's lies inside another's, which init.sh --force and destroy remove whole;
 * - a misspelled port, each by name, is refused, never read as some port or as the default.
 *
 * The oracle is the specification: today's pin.env values, and the read-back from a state directory to its port.
 * Features: the variable unset, the default port named, a port beside it, the least and the greatest port, any other
 * port, and each misspelling refused.
 *
 * Plants (~/.cache/grizzle-release/PRIVATECLUSTER/plants): cluster-port-truncated.patch (a state directory suffixed
 * with the port's last four digits, so 5440 and 15440 share one) and cluster-default-suffixed.patch (the default's
 * state directory suffixed like every other's) turn it red, and so does cluster-misspelling-admitted.patch (a name
 * read by Config.Port alone, which admits 05440 and 5e3).
 */
import { homedir } from "node:os"
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { constant, element, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { assert } from "#test/support/assert.ts"
import { clusterVariable, type LocalCluster, pgPin, selectCluster } from "#test/support/env.ts"
import { caseHang } from "#test/support/limits.ts"

import { regex } from "arkregex"

/** The greatest TCP port: a port is sixteen bits, and zero is no port to listen on. */
const greatestPort = 2 ** 16 - 1

/** Today's cluster, every value as pin.env spelled it before clusters were named. */
const todaysPort = 5433
const todaysState = `${homedir()}/.local/var/grizzle/pg${pgPin.version}`
const today: LocalCluster = {
	port: todaysPort,
	state: todaysState,
	data: `${todaysState}/data`,
	tls: `${todaysState}/tls`,
	log: `${todaysState}/log`,
	socket: `${todaysState}/socket`,
	passwordFile: `${todaysState}/${pgPin.devRole}.password`
}

/**
 * The port a state directory belongs to, read back from its path alone: today's directory is today's port, and a
 * directory beside it named `<today's>-<digits>` the port the digits spell in canonical decimal; anything else, a
 * directory inside another's among them, none.
 */
const portOfState = (state: string): Option.Option<number> => {
	if (state === todaysState) {
		return Option.some(todaysPort)
	}
	const suffix = regex("^-([1-9][0-9]*)$").exec(Str.slice(todaysState.length)(state))
	return Str.startsWith(todaysState)(state) && suffix !== null
		? Option.some(Number(suffix[1]))
		: Option.none()
}

/** A way to misspell a port, which the name rule refuses. */
type Misspelling =
	| "empty"
	| "a leading zero"
	| "a sign"
	| "an exponent"
	| "a fraction"
	| "a space"
	| "a letter"
	| "zero"
	| "past the greatest port"

const misspellings: Arr.NonEmptyReadonlyArray<Misspelling> = [
	"empty",
	"a leading zero",
	"a sign",
	"an exponent",
	"a fraction",
	"a space",
	"a letter",
	"zero",
	"past the greatest port"
]

const misspelled = (port: number, misspelling: Misspelling): string => {
	switch (misspelling) {
		case "empty":
			return ""
		case "a leading zero":
			return `0${port}`
		case "a sign":
			return `+${port}`
		case "an exponent":
			return `${port}e0`
		case "a fraction":
			return `${port}.0`
		case "a space":
			return ` ${port}`
		case "a letter":
			return `${port}a`
		case "zero":
			return "0"
		case "past the greatest port":
			return `${greatestPort + port}`
	}
}

/** What GRIZZLE_PG_CLUSTER holds: nothing, a port in canonical decimal, or a port misspelled. */
type Name =
	| { readonly kind: "unset" }
	| { readonly kind: "port"; readonly port: number }
	| { readonly kind: "misspelled"; readonly port: number; readonly misspelling: Misspelling }

/** Every name in the box: unset, every port, and each misspelling of the least, today's and the greatest port. */
const nameGen: Gen<Name> = oneOf<Name>([
	constant<Name>({ kind: "unset" }),
	map(int(1, greatestPort), (port): Name => ({ kind: "port", port })),
	(source) => ({
		kind: "misspelled",
		port: source.draw(element([1, todaysPort, greatestPort])),
		misspelling: source.draw(element(misspellings))
	})
])

/** The environment a name is: the variable absent, or holding its spelling. */
const environmentOf = (name: Name): Readonly<Record<string, string>> => {
	switch (name.kind) {
		case "unset":
			return {}
		case "port":
			return { [clusterVariable]: `${name.port}` }
		case "misspelled":
			return { [clusterVariable]: misspelled(name.port, name.misspelling) }
	}
}

type NameFeature =
	| "unset, today's cluster"
	| "today's port named"
	| "a port beside today's"
	| "the least port"
	| "the greatest port"
	| "another port"
	| `${Misspelling} refused`

const portFeature = (port: number): NameFeature =>
	port === todaysPort
		? "today's port named"
		: Math.abs(port - todaysPort) === 1
			? "a port beside today's"
			: port === 1
				? "the least port"
				: port === greatestPort
					? "the greatest port"
					: "another port"

describe("local cluster names", () => {
	it.effect(
		"select today's cluster unset, the cluster of a canonical port beside it otherwise, its directory reading back as that port alone, and refuse every misspelling",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/substrate/cluster-names",
						generator: nameGen,
						literal: Formatter.format,
						box: "GRIZZLE_PG_CLUSTER unset, every port from 1 to 65535 in canonical decimal, and each named misspelling of ports 1, 5433 and 65535",
						oracle: {
							kind: "specification",
							name: "today's pin.env values, and the read-back from a state directory to its port"
						},
						coverage: requiredInSpace<NameFeature>([
							"unset, today's cluster",
							"today's port named",
							"a port beside today's",
							"the least port",
							"the greatest port",
							"another port",
							...Arr.map(misspellings, (misspelling): NameFeature => `${misspelling} refused`)
						]),
						caseHang,
						concurrency: 1
					},
					(name, c) =>
						Effect.map(Effect.result(selectCluster(environmentOf(name))), (selected) => {
							switch (name.kind) {
								case "unset": {
									assert.ok(Result.isSuccess(selected), "an unset name selects a cluster")
									assert.deepEqual(selected.success, today)
									c.note("unset, today's cluster")
									return
								}
								case "port": {
									assert.ok(Result.isSuccess(selected), `port ${name.port} names a cluster`)
									const cluster = selected.success
									assert.equal(cluster.port, name.port)
									assert.deepEqual(
										portOfState(cluster.state),
										Option.some(name.port),
										cluster.state
									)
									assert.deepEqual(
										[cluster.data, cluster.tls, cluster.log, cluster.socket, cluster.passwordFile],
										[
											`${cluster.state}/data`,
											`${cluster.state}/tls`,
											`${cluster.state}/log`,
											`${cluster.state}/socket`,
											`${cluster.state}/${pgPin.devRole}.password`
										]
									)
									if (name.port === todaysPort) {
										assert.deepEqual(cluster, today)
									}
									c.note(portFeature(name.port))
									return
								}
								case "misspelled": {
									const spelling = misspelled(name.port, name.misspelling)
									assert.ok(Result.isFailure(selected), `${Formatter.format(spelling)} is refused`)
									c.note(`${name.misspelling} refused`)
									return
								}
							}
						})
				)
			)
	)
})
