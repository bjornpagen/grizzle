/** What response-headers.test.ts's property reads: drawn required-header tables, answers, and the runs they make. */

import {
	type Aimed,
	aimed,
	constant,
	element,
	type Gen,
	map,
	subarray,
	uniqueArray
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Exit, Option, Record, String as Str } from "effect"
import { HttpClientRequest } from "effect/http"
import type * as Output from "#runtime-src/runtime/output.ts"
import { plainWorld, type Sent, sendIn } from "#test/support/send.ts"

/** Header names an operation may require, in no particular case. */
const NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"X-Required",
	"X-Second",
	"X-Trace",
	"ETag",
	"x-rate-limit"
]

/** A drawn exchange: each response key's required headers in document order, the status, and the headers the answer carries. */
export type Exchange = Readonly<{
	required: Readonly<Record<string, ReadonlyArray<string>>>
	status: number
	present: ReadonlyArray<readonly [string, "as declared" | "upper case" | "lower case"]>
}>

/** The operation's declared response keys, which the status is matched against and the required headers name. */
const KEYS: Arr.NonEmptyReadonlyArray<string> = ["200", "201", "4XX"]

const requiredGen: Gen<Readonly<Record<string, ReadonlyArray<string>>>> = map(
	uniqueArray(element(KEYS), (key) => map(subarray(NAMES), (names) => [key, names] as const), {
		min: 0,
		max: 3
	}),
	(entries) => Record.fromEntries(entries)
)

const presentGen: Gen<Exchange["present"]> = map(subarray(NAMES), (names) =>
	Arr.map(
		names,
		(name, at) =>
			[
				name,
				(["as declared", "upper case", "lower case"] as const)[at % 3] ?? "as declared"
			] as const
	)
)

const exchangeOf =
	(statuses: Gen<number>, present: Gen<Exchange["present"]>): Gen<Exchange> =>
	(s) => ({
		required: s.draw(requiredGen),
		status: s.draw(statuses),
		present: s.draw(present)
	})

/** Statuses the run neither retries nor follows: a success, and client errors. */
const STATUSES: Arr.NonEmptyReadonlyArray<number> = [200, 201, 400, 404, 409]

const exchanges: Gen<Exchange> = exchangeOf(element(STATUSES), presentGen)

/** The key the status matches among the operation's declared response keys: its code, then its range, then default. */
const matchedOf = (exchange: Exchange): Option.Option<string> => {
	const code = String(exchange.status)
	const range = `${Math.floor(exchange.status / 100)}XX`
	return Arr.findFirst([code, range, "default"], (key) => Arr.contains(KEYS, key))
}

/** The required headers of the matched key the answer leaves out, compared without case, in document order. */
const missingOf = (exchange: Exchange): ReadonlyArray<string> =>
	Option.match(matchedOf(exchange), {
		onNone: () => [],
		onSome: (key) =>
			Arr.filter(
				exchange.required[key] ?? [],
				(name) =>
					!Arr.some(
						exchange.present,
						([present]) => Str.toLowerCase(present) === Str.toLowerCase(name)
					)
			)
	})

const operation = (required: Exchange["required"] | undefined): Output.OperationMeta => ({
	media: {
		request: [],
		responses: Record.fromEntries(
			Arr.map(KEYS, (key) => [key, key === "4XX" ? [] : ["text/plain"]] as const)
		)
	},
	method: "GET",
	operationId: "typed-get",
	pathTemplate: "/typed",
	requiredHeaders: required,
	security: []
})

const headersOf = (exchange: Exchange): Readonly<Record<string, string>> =>
	Record.fromEntries(
		Arr.map(
			exchange.present,
			([name, spelled]) =>
				[
					spelled === "upper case"
						? Str.toUpperCase(name)
						: spelled === "lower case"
							? Str.toLowerCase(name)
							: name,
					"present"
				] as const
		)
	)

/** The run with the operation's required headers, and the same run with none declared. */
export const runsOf = (exchange: Exchange) =>
	Effect.gen(function* () {
		const world = (required: Exchange["required"] | undefined) => ({
			...plainWorld(operation(required), HttpClientRequest.get("/typed")),
			reply: () =>
				new Response("body", {
					headers: { "content-type": "text/plain", ...headersOf(exchange) },
					status: exchange.status
				})
		})
		const checked = yield* sendIn(world(exchange.required))
		const plain = yield* sendIn(world(undefined))
		return { checked, plain }
	})

const warning = (name: string) => `Warning: the response is missing the required header ${name}\n`

/**
 * What HDR-03 says of the two runs: the checked run's stderr is one warning per missing required header of the matched
 * key, in document order, then the plain run's stderr; every warning is written before the body; stdout and the exit
 * are the plain run's.
 */
export const judged = (exchange: Exchange, runs: Readonly<{ checked: Sent; plain: Sent }>) => {
	const missing = missingOf(exchange)
	return {
		actual: {
			stderr: runs.checked.stderr,
			stdout: runs.checked.stdout,
			exit: Exit.isSuccess(runs.checked.exit),
			warningsFirst: Arr.take(runs.checked.writes, missing.length)
		},
		expected: {
			stderr: `${Arr.join(Arr.map(missing, warning), "")}${runs.plain.stderr}`,
			stdout: runs.plain.stdout,
			exit: Exit.isSuccess(runs.plain.exit),
			warningsFirst: Arr.map(missing, () => "stderr")
		}
	}
}

export type ExchangeFeature =
	| "a required header missing"
	| "two required headers missing"
	| "a required header present in another case"
	| "a non-2xx key checked"
	| "a key that requires nothing"
	| "an operation without required headers"

export const exchangeFeatures = (exchange: Exchange): ReadonlyArray<ExchangeFeature> => {
	const missing = missingOf(exchange)
	const matched = matchedOf(exchange)
	const required = Option.match(matched, {
		onNone: () => [],
		onSome: (key) => exchange.required[key] ?? []
	})
	const when = (holds: boolean, feature: ExchangeFeature): ReadonlyArray<ExchangeFeature> =>
		holds ? [feature] : []
	return [
		...when(missing.length >= 1, "a required header missing"),
		...when(missing.length >= 2, "two required headers missing"),
		...when(
			Arr.some(
				exchange.present,
				([name, spelled]) => spelled !== "as declared" && Arr.contains(required, name)
			),
			"a required header present in another case"
		),
		...when(exchange.status >= 300 && missing.length >= 1, "a non-2xx key checked"),
		...when(
			Option.exists(matched, (key) => !Record.has(exchange.required, key)) &&
				Arr.isReadonlyArrayNonEmpty(Record.keys(exchange.required)),
			"a key that requires nothing"
		),
		...when(
			Arr.isReadonlyArrayEmpty(Record.keys(exchange.required)),
			"an operation without required headers"
		)
	]
}

const fixed = (
	required: Exchange["required"],
	status: number,
	present: Exchange["present"]
): Gen<Exchange> => constant<Exchange>({ required, status, present })

/** Exchanges, aimed at each pending situation by one built to reach it. */
export const aimedExchanges: Aimed<Exchange, ExchangeFeature> = aimed(exchanges, [
	["a required header missing", fixed({ "200": ["X-Required"] }, 200, [])],
	[
		"two required headers missing",
		fixed({ "200": ["X-Required", "X-Second"], "4XX": ["X-Trace"] }, 200, [])
	],
	[
		"a required header present in another case",
		fixed({ "200": ["X-Required", "X-Second"] }, 200, [
			["X-Second", "upper case"],
			["X-Required", "lower case"]
		])
	],
	["a non-2xx key checked", fixed({ "200": ["X-Required"], "4XX": ["X-Trace"] }, 400, [])],
	["a key that requires nothing", fixed({ "200": ["X-Required"] }, 409, [])],
	[
		"an operation without required headers",
		map(element(STATUSES), (status): Exchange => ({ required: {}, status, present: [] }))
	]
])
