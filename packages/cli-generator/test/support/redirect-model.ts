import {
	boolean,
	constant,
	element,
	type Gen,
	int,
	type Size,
	span,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Duration, Option, String as Str } from "effect"
import type { Script, ScriptedResponse } from "#test/support/capture-server.ts"

/** The statuses a generated CLI's redirect loop follows. */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308

/**
 * One redirect a server answers: its status, the origin and path its Location names, and whether a same-origin one is
 * relative. The path is a fresh one or the path of an earlier request of the chain, so a Location can name a URL the
 * chain already sent.
 */
export type Redirect<O extends string> = Readonly<{
	status: RedirectStatus
	to: O
	path: string
	relative: boolean
}>

/** One hop the loop sends: the origin, the path, the method, and whether it carries the first request's body. */
export type ModelHop<O extends string> = Readonly<{
	origin: O
	path: string
	method: string
	withBody: boolean
}>

/** The loop's run of a chain: the hops it sends in order, and whether it lands or refuses the next hop. */
export type ModelRun<O extends string> = Readonly<{
	hops: Arr.NonEmptyReadonlyArray<ModelHop<O>>
	end: "landed" | "crossOriginBody" | "loop"
}>

/** Whether a redirect turns the request into a body-less GET: a 301 or 302 POST, and a 303 of anything but GET or HEAD. */
const becomesGet = (status: RedirectStatus, method: string): boolean =>
	((status === 301 || status === 302) && method === "POST") ||
	(status === 303 && method !== "GET" && method !== "HEAD")

/** The path of the first request, the operation's own. */
const FIRST_PATH = "/hop"

/**
 * Whether a hop sends a request the chain already sent: the same method to the same origin and path. The fragment never
 * reaches the model, as the runtime never sends it.
 */
const sentBefore = <O extends string>(
	hops: ReadonlyArray<ModelHop<O>>,
	hop: ModelHop<O>
): boolean =>
	Arr.some(
		hops,
		(sent) => sent.origin === hop.origin && sent.path === hop.path && sent.method === hop.method
	)

/**
 * The redirect loop's specification over a chain, as a model: from the first hop, sent to the operation's own path,
 * each redirect is followed until the chain runs out (landed). A hop that would carry a body to another origin is
 * refused (crossOriginBody), and so is a hop that would send a request the chain already sent (loop); a revisit under
 * another method or at another origin is a different request and is followed, and no count of hops ends a chain. A
 * followed redirect keeps the method and body, or turns them into a body-less GET.
 */
export const followChain = <O extends string>(
	first: Readonly<{ origin: O; method: string; withBody: boolean }>,
	redirects: ReadonlyArray<Redirect<O>>
): ModelRun<O> => {
	const step = (index: number, hops: Arr.NonEmptyReadonlyArray<ModelHop<O>>): ModelRun<O> =>
		Option.match(Arr.get(redirects, index), {
			onNone: () => ({ hops, end: "landed" }),
			onSome: (next) => {
				const from = Arr.lastNonEmpty(hops)
				const turns = becomesGet(next.status, from.method)
				const hop: ModelHop<O> = {
					origin: next.to,
					path: next.path,
					method: turns ? "GET" : from.method,
					withBody: turns ? false : from.withBody
				}
				if (hop.withBody && next.to !== from.origin) {
					return { hops, end: "crossOriginBody" }
				}
				return sentBefore(hops, hop)
					? { hops, end: "loop" }
					: step(index + 1, Arr.append(hops, hop))
			}
		})
	return step(0, [{ ...first, path: FIRST_PATH }])
}

/** The fresh path a Location names for the request after `index` redirects: no other request of a chain has it. */
const freshPath = (index: number): string => `/chain/${String(index)}`

/**
 * The redirect after `paths`, the paths of the chain's requests so far. In a chain that never revisits, the path is
 * fresh. In a revisiting chain it is fresh three times in five, the first request's path one in five, and the path of
 * any earlier request one in five, so the chain sends URLs it already sent, under the same method or another, at the
 * same origin or another. The first request's path has its own arm because it is the one sent under the chain's first
 * method, before a redirect can turn it into a GET.
 */
const redirectAfter =
	<O extends string>(
		origin: Gen<O>,
		revisiting: boolean,
		paths: Arr.NonEmptyReadonlyArray<string>
	): Gen<Redirect<O>> =>
	(source) => ({
		status: element<RedirectStatus>([307, 308, 301, 302, 303])(source),
		to: origin(source),
		path: revisiting
			? weighted<string>([
					[3, constant(freshPath(paths.length))],
					[1, constant(FIRST_PATH)],
					[1, element(paths)]
				])(source)
			: freshPath(paths.length),
		relative: boolean(source)
	})

/**
 * A chain of redirects of a drawn length, each drawn knowing the paths of the requests before it: as often as not a
 * chain that never revisits, which a loop refusal cannot cut short, otherwise one that revisits.
 */
export const redirectsOf =
	<O extends string>(origin: Gen<O>, size: Size): Gen<ReadonlyArray<Redirect<O>>> =>
	(source) => {
		const revisiting = boolean(source)
		const grow = (
			paths: Arr.NonEmptyReadonlyArray<string>,
			redirects: ReadonlyArray<Redirect<O>>,
			left: number
		): ReadonlyArray<Redirect<O>> => {
			if (left === 0) {
				return redirects
			}
			const next = span("redirect", redirectAfter(origin, revisiting, paths))(source)
			return grow(Arr.append(paths, next.path), Arr.append(redirects, next), left - 1)
		}
		return grow([FIRST_PATH], [], int(size.min, size.max)(source))
	}

/**
 * A capture server's script for a chain: the request at each position is answered with the chain's redirect from that
 * position, its Location relative when the redirect allows it and stays on the request's origin, absolute otherwise;
 * once the chain runs out, with the landing. A request's position is the `attempt`-th of the positions sent to its
 * path, since a revisit sends one path more than once.
 */
export const chainScript =
	<O extends string>(
		redirects: ReadonlyArray<Redirect<O>>,
		origins: Readonly<Record<O, string>>,
		landing: ScriptedResponse
	): Script<O> =>
	(request, attempt) => {
		const path = Arr.headNonEmpty(Str.split("?")(request.target))
		const position = Arr.get(
			Arr.getSomes(
				Arr.map(
					Arr.prepend(
						Arr.map(redirects, (redirect) => redirect.path),
						FIRST_PATH
					),
					(sent, index) => (sent === path ? Option.some(index) : Option.none())
				)
			),
			attempt
		)
		return Option.match(
			Option.flatMap(position, (index) => Arr.get(redirects, index)),
			{
				onNone: () => landing,
				onSome: (next) => ({
					status: next.status,
					headers: [
						[
							"Location",
							next.relative && next.to === request.origin
								? next.path
								: `${origins[next.to]}${next.path}`
						]
					],
					delay: Duration.zero,
					body: { kind: "complete", bytes: new Uint8Array(0) }
				})
			}
		)
	}
