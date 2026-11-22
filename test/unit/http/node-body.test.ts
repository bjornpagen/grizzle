/**
 * nodeListener hands its handler a request whose body is the Node request's chunks as ReadableStream.from delivers
 * them (packages/grizzle/src/http/node.ts bodyOf), now that it builds the body with the constructor every lib
 * declares, so a consumer typechecking grizzle's http sources under the DOM's lib finds nothing missing
 * (packages/grizzle/tsconfig.dom.json).
 *
 * - **Property:** over drawn bodies of zero to four chunks of zero to six bytes, each a POST through nodeListener to a
 *   handler that answers with the bytes it read of the request's body, the answer's bytes are the bytes
 *   ReadableStream.from of the same chunks delivers, and the response is ended, never destroyed.
 * - **Oracle:** second-implementation: Node's own ReadableStream.from over the same chunks.
 * - **Features:** an empty body, an empty chunk, several chunks.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { type NodeRequest, type NodeResponse, nodeListener } from "#http/node.ts"

type BodyFeature = "an empty body" | "an empty chunk" | "several chunks"

const chunksGen: Gen<ReadonlyArray<ReadonlyArray<number>>> = array(
	array(int(0, 255), { min: 0, max: 6 }),
	{
		min: 0,
		max: 4
	}
)

/** Every byte a stream delivers, in order. */
const bytesOf = (stream: ReadableStream<Uint8Array>): Promise<ReadonlyArray<number>> =>
	new Response(stream).arrayBuffer().then((buffer) => Arr.fromIterable(new Uint8Array(buffer)))

/** A Node request of `chunks`, a POST, as node:http's request iterates its body. */
const requestOf = (chunks: ReadonlyArray<ReadonlyArray<number>>): NodeRequest => ({
	method: "POST",
	url: "/echo",
	rawHeaders: ["host", "localhost"],
	[Symbol.asyncIterator]: () => {
		let at = 0
		return {
			next: (): Promise<IteratorResult<Uint8Array, undefined>> => {
				const chunk = chunks[at]
				at += 1
				return Promise.resolve(
					chunk === undefined
						? { done: true, value: undefined }
						: { done: false, value: Uint8Array.from(chunk) }
				)
			}
		}
	}
})

/** What a response was written: its bytes, and whether it ended or was destroyed, once it has done either. */
const answered = (request: NodeRequest) =>
	Effect.callback<{ readonly bytes: ReadonlyArray<number>; readonly end: "ended" | "destroyed" }>(
		(resume) => {
			const bytes: Array<number> = []
			const response: NodeResponse = {
				writeHead: () => undefined,
				write: (chunk) => {
					for (const byte of chunk) {
						bytes.push(byte)
					}
					return true
				},
				end: () => resume(Effect.succeed({ bytes, end: "ended" })),
				destroy: () => resume(Effect.succeed({ bytes, end: "destroyed" })),
				once: () => undefined
			}
			nodeListener((r) =>
				(r.body === null ? Promise.resolve([]) : bytesOf(r.body)).then(
					(read) => new Response(Uint8Array.from(read))
				)
			)(request, response)
		}
	)

/** nodeListener's request body delivers the Node request's chunks as ReadableStream.from does. */
export const aNodeRequestsBodyReachesItsHandlerAsReadableStreamFromDeliversIt = property.explore(
	chunksGen,
	{
		needs: {},
		situations: ["an empty body", "an empty chunk", "several chunks"] satisfies ReadonlyArray<
			Reached<BodyFeature>
		>,
		budget: { runs: 200, steered: 50 },
		check: (_, c: Case<BodyFeature>) => (chunks) =>
			Effect.gen(function* () {
				c.note(
					chunks.length === 0
						? "an empty body"
						: Arr.some(chunks, (chunk) => chunk.length === 0)
							? "an empty chunk"
							: "several chunks"
				)
				const expected = yield* Effect.promise(() =>
					bytesOf(ReadableStream.from(Arr.map(chunks, (chunk) => Uint8Array.from(chunk))))
				)
				const answer = yield* answered(requestOf(chunks))
				assert.equal(answer.end, "ended", "the response is ended")
				assert.deepEqual(
					answer.bytes,
					expected,
					"the handler read the body ReadableStream.from delivers"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "Node's ReadableStream.from over the same chunks"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/http/node.ts",
				original: "\t\t\t\t\t\tcontroller.enqueue(next.value)",
				replacement: "\t\t\t\t\t\tcontroller.enqueue(next.value.subarray(1))",
				why: "Each chunk loses its first byte on its way into the body; a body of a non-empty chunk reaches its handler short."
			}
		]
	}
)
