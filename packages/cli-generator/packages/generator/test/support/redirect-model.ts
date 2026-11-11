import { regex } from "arkregex"
import { Array as Arr, Duration, Option, String as Str } from "effect"
import { maxRedirects } from "#runtime/client.ts"
import type { Script, ScriptedResponse } from "#test/support/capture-server.ts"

/** The statuses a generated CLI's redirect loop follows. */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308

/** One redirect a server answers: its status, the origin its Location names, and whether a same-origin one is relative. */
export type Redirect<O extends string> = Readonly<{
	status: RedirectStatus
	to: O
	relative: boolean
}>

/** The most redirects one request follows, the runtime's declared limit: the response to the last followed hop may not redirect again. */
export const MAX_REDIRECTS = maxRedirects

/** One hop the loop sends: the origin, the method, and whether it carries the first request's body. */
export type ModelHop<O extends string> = Readonly<{ origin: O; method: string; withBody: boolean }>

/** The loop's run of a chain: the hops it sends in order, and whether it lands or refuses the next hop. */
export type ModelRun<O extends string> = Readonly<{
	hops: Arr.NonEmptyReadonlyArray<ModelHop<O>>
	end: "landed" | "crossOriginBody" | "hopLimit"
}>

/** Whether a redirect turns the request into a body-less GET: a 301 or 302 POST, and a 303 of anything but GET or HEAD. */
const becomesGet = (status: RedirectStatus, method: string): boolean =>
	((status === 301 || status === 302) && method === "POST") ||
	(status === 303 && method !== "GET" && method !== "HEAD")

/**
 * The redirect loop's specification over a chain, as a model: from the first hop, each redirect is followed until the
 * chain runs out (landed); an eleventh redirect is refused (hopLimit), and so is a hop that would carry a body to
 * another origin (crossOriginBody). A followed redirect keeps the method and body, or turns them into a body-less GET.
 */
export const followChain = <O extends string>(
	first: ModelHop<O>,
	redirects: ReadonlyArray<Redirect<O>>
): ModelRun<O> => {
	const step = (index: number, hops: Arr.NonEmptyReadonlyArray<ModelHop<O>>): ModelRun<O> =>
		Option.match(Arr.get(redirects, index), {
			onNone: () => ({ hops, end: "landed" }),
			onSome: (next) => {
				const from = Arr.lastNonEmpty(hops)
				if (index >= MAX_REDIRECTS) {
					return { hops, end: "hopLimit" }
				}
				const turns = becomesGet(next.status, from.method)
				const hop: ModelHop<O> = {
					origin: next.to,
					method: turns ? "GET" : from.method,
					withBody: turns ? false : from.withBody
				}
				return hop.withBody && next.to !== from.origin
					? { hops, end: "crossOriginBody" }
					: step(index + 1, Arr.append(hops, hop))
			}
		})
	return step(0, [first])
}

/** The path of the request after `index` redirects: the operation's own path first, then one path per redirect. */
export const pathAt = (index: number): string => (index === 0 ? "/hop" : `/chain/${String(index)}`)

const REDIRECT_PATH = regex("^/chain/([0-9]+)$", "u")

/** How many redirects led to a request, read off its target's path. */
const indexOf = (target: string): number =>
	Option.match(Option.fromNullishOr(REDIRECT_PATH.exec(Arr.headNonEmpty(Str.split("?")(target)))), {
		onNone: () => 0,
		onSome: ([, index]) => Number(index)
	})

/**
 * A capture server's script for a chain: each request is answered with the chain's next redirect, its Location
 * relative when the redirect allows it and stays on the request's origin, absolute otherwise; once the chain runs out,
 * with the landing.
 */
export const chainScript =
	<O extends string>(
		redirects: ReadonlyArray<Redirect<O>>,
		origins: Readonly<Record<O, string>>,
		landing: ScriptedResponse
	): Script<O> =>
	(request) => {
		const index = indexOf(request.target)
		return Option.match(Arr.get(redirects, index), {
			onNone: () => landing,
			onSome: (next) => ({
				status: next.status,
				headers: [
					[
						"Location",
						next.relative && next.to === request.origin
							? pathAt(index + 1)
							: `${origins[next.to]}${pathAt(index + 1)}`
					]
				],
				delay: Duration.zero,
				body: { kind: "complete", bytes: new Uint8Array(0) }
			})
		})
	}
