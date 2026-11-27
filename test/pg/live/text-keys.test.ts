/**
 * A stored text reaches its live readers byte for byte: a subscription bound to a text is marked by exactly the commit
 * that writes a row holding that text, whatever its characters, a leading U+FEFF among them, and its value then is the
 * served read's. The leader keys a change by the text pgoutput sends for each routed column (adapter/live/pgoutput.ts),
 * so a decoder that dropped a leading byte order mark would route `\uFEFFa` as `a`, and the subscription of `\uFEFFa`
 * would never hear the row it now holds.
 *
 * Each case installs, as generate drafts it, a schema of `Note { id, tag }`, `tag` an unbounded text, served by a login
 * whose role reads `tagged` (the notes of the text `tag`, routed by `tag`), `all` (every note's id and tag), and
 * `probeAt` (the fence's Probe row of `id`), and writes `add`; its live source made to stand first by a watch of `all`,
 * which answers once the leader has made the slot (test/support/live/standing.ts standingOn).
 * Each drawn text's subscription to `tagged` is registered in process and read to its first ready, empty; then one
 * grizzle call of `add` stores a note of each text, and a fence (routing.test.ts): a Probe row committed after it, its
 * own probe registered before and awaited until the row's change marks it, by when every notification of the call's
 * commit has been routed, since the one listener routes them in commit order.
 *
 * Properties, for each drawn text:
 * - its subscription is marked by the call's commit;
 * - turned, its value is the served read's of `tagged` with that text, a once after the commit (live/keyed.ts values,
 *   test/support/live/values.ts sameKeyed), the note stored with it;
 * - the served read of `all` holds each note's text exactly as drawn.
 *
 * The oracle is the drawn texts themselves and the served reads, which read the stored row over a query's own text
 * protocol, never pgoutput.
 *
 * Features: a text that begins with U+FEFF, a text holding U+FEFF after its start, a text of U+FEFF alone, a text with
 * no U+FEFF, several texts in one commit.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { served } from "#adapter/public/layer.ts"
import {
	BYTE_ORDER_MARK,
	caseGen,
	type Feature,
	login,
	marked,
	notebook
} from "#test/pg/live/text-keys.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { liveRegistrations, liveSurfaces } from "#test/support/live/calls.ts"
import { commitDirectly, fenceStatement } from "#test/support/live/direct.ts"
import { standingOn } from "#test/support/live/standing.ts"
import { printKeyed, sameKeyed } from "#test/support/live/values.ts"
import { probeAtMember } from "#test/support/live/world.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import {
	baseSubstrate,
	claimsOfNoFact,
	Substrate,
	worldSession
} from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/**
 * A stored text's live readers hear the commit that writes it, byte for byte, a leading U+FEFF among its characters, over drawn sets of texts.
 */
export const aStoredTextsLiveReadersHearTheCommitThatWritesItByteForByteALeadingUFEFFAmongItsCharactersOverCasesDrawnSetsOfTexts =
	property.explore(caseGen, {
		needs: { substrate2: Substrate.fresh(baseSubstrate) },
		situations: [
			"a text that begins with U+FEFF",
			"a text holding U+FEFF after its start",
			"a text of U+FEFF alone",
			"a text with no U+FEFF",
			"several texts in one commit"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate2 }, notes: Case<Feature>) =>
			(drawnTexts) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const texts = Arr.dedupe(Arr.map(drawnTexts, (scalars) => Arr.join(scalars, "")))
						for (const scalars of drawnTexts) {
							const at = Arr.findFirstIndex(scalars, (s) => s === BYTE_ORDER_MARK)
							notes.note(
								Option.match(at, {
									onNone: () => "a text with no U+FEFF",
									onSome: (i) =>
										i > 0
											? "a text holding U+FEFF after its start"
											: scalars.length === 1
												? "a text of U+FEFF alone"
												: "a text that begins with U+FEFF"
								})
							)
						}
						if (texts.length > 1) {
							notes.note("several texts in one commit")
						}
						const substrate = yield* Substrate
						const generated = yield* installGenerated(
							(name) => {
								const book = notebook(name)
								return { schema: book.schema, logins: [book.world.server] }
							},
							{ label: "live_text_keys", ambient: ordinarySession }
						)
						const installed = generated.installed
						const book = notebook(installed.declared)
						const file = served(
							defined(generated.served.get(login), `the served file of ${login}`),
							login
						)
						const writer = yield* substrate.session(
							worldSession(installed.world(book.world.app), claimsOfNoFact)
						)
						const layerOf = sourcedDbLayer(installed, {
							...clusterConnection(
								installed.cluster,
								installed.database,
								installed.as(book.world.server).password
							),
							pool: clusterPool,
							login: file,
							verify: testVerify
						})
						yield* Effect.gen(function* () {
							const surfaces = yield* liveSurfaces(file, "app", tokenOf({}))
							const register = yield* liveRegistrations(file, "app", tokenOf({}))
							yield* standingOn(surfaces.inProcess, "all", { params: {}, facts: {} })
							const subscriptions = yield* Effect.forEach(texts, (tag) =>
								Effect.map(register("tagged", { params: { tag }, facts: {} }), (registration) => ({
									tag,
									registration
								}))
							)
							yield* surfaces.inProcess.write("add", {
								params: {},
								facts: { insert: { Note: Arr.map(texts, (tag, id) => ({ id, tag })) } }
							})
							const probe = yield* register(probeAtMember, { params: { id: 1 }, facts: {} })
							yield* commitDirectly(writer, [fenceStatement(installed.plan, 1)])
							yield* marked(probe)
							for (const { tag, registration } of subscriptions) {
								const state = yield* registration.state
								assert.equal(
									state,
									"marked",
									`the subscription of ${Formatter.format(tag)} after the commit of its note`
								)
								const turn = yield* registration.turn
								const turned = defined(
									Option.getOrUndefined(turn),
									`the subscription of ${Formatter.format(tag)} turned to a value`
								)
								const once = yield* surfaces.inProcess.once("tagged", {
									params: { tag },
									facts: {}
								})
								assert.ok(
									sameKeyed(turned, once),
									`the subscription of ${Formatter.format(tag)} holds ${printKeyed(turned)}, the served read ${printKeyed(once)}`
								)
							}
							const all = yield* surfaces.inProcess.once("all", { params: {}, facts: {} })
							const stored = Arr.flatMap(Arr.fromIterable(all), (row) =>
								"tag" in row && typeof row.tag === "string" ? [row.tag] : []
							)
							assert.deepEqual(
								Arr.sort(stored, Order.String),
								Arr.sort(texts, Order.String),
								`the served read of every note, ${printKeyed(all)}, holds each text as drawn`
							)
						}).pipe(withLayer(layerOf))
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate2, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the drawn texts themselves and the served reads of the stored rows"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/live/text-keys.test.ts#aStoredTextsLiveReadersHearTheCommitThatWritesItByteForByteALeadingUFEFFAmongItsCharactersOverCasesDrawnSetsOfTexts:-:2.2.0.1.1.1"
				),
				reason: "a after a byte order mark, which a TextDecoder's defaults route as a",
				since: "2026-11-19"
			}
		],
		kills: [
			{
				file: "packages/text/src/utf8.ts",
				original: "{ fatal: true, ignoreBOM: true }",
				replacement: "{ fatal: true, ignoreBOM: false }",
				why: "The one decoder strips a leading U+FEFF, as a TextDecoder's defaults do, so a stored text that starts with a byte order mark reaches its live readers without it: the fidelity defect 6a2e40b29 fixed, which the kept case is."
			}
		]
	})
