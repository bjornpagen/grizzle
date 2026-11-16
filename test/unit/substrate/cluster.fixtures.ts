/** What the properties of cluster.test.ts read: its spaces, models and helpers. */

import { homedir } from "node:os"
import { constant, element, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Option, String as Str } from "effect"
import { clusterVariable, type LocalCluster } from "#pg/local-cluster.ts"
import { pgPin } from "#test/support/env.ts"

/** The greatest TCP port: a port is sixteen bits, and zero is no port to listen on. */
const greatestPort = 2 ** 16 - 1

/** Today's cluster, every value as pin.env spelled it before clusters were named. */
export const todaysPort = 5433

const todaysState = `${homedir()}/.local/var/grizzle/pg${pgPin.version}`

export const today: LocalCluster = {
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
export const portOfState = (state: string): Option.Option<number> => {
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

export const misspellings: Arr.NonEmptyReadonlyArray<Misspelling> = [
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

export const misspelled = (port: number, misspelling: Misspelling): string => {
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
export const nameGen: Gen<Name> = oneOf<Name>([
	constant<Name>({ kind: "unset" }),
	map(int(1, greatestPort), (port): Name => ({ kind: "port", port })),
	(source) => ({
		kind: "misspelled",
		port: source.draw(element([1, todaysPort, greatestPort])),
		misspelling: source.draw(element(misspellings))
	})
])

/** The environment a name is: the variable absent, or holding its spelling. */
export const environmentOf = (name: Name): Readonly<Record<string, string>> => {
	switch (name.kind) {
		case "unset":
			return {}
		case "port":
			return { [clusterVariable]: `${name.port}` }
		case "misspelled":
			return { [clusterVariable]: misspelled(name.port, name.misspelling) }
	}
}

export type NameFeature =
	| "unset, today's cluster"
	| "today's port named"
	| "a port beside today's"
	| "the least port"
	| "the greatest port"
	| "another port"
	| `${Misspelling} refused`

export const portFeature = (port: number): NameFeature =>
	port === todaysPort
		? "today's port named"
		: Math.abs(port - todaysPort) === 1
			? "a port beside today's"
			: port === 1
				? "the least port"
				: port === greatestPort
					? "the greatest port"
					: "another port"
