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
 * called again while it is refused for a slot the leader has not made yet (test/support/live/standing.ts standingOn).
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
import { drawn, explore } from "@bjornpagen/testing/explore"
import { awaitFact } from "@bjornpagen/testing/fact"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { served } from "#adapter/public/layer.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { liveRegistrations, liveSurfaces } from "#test/support/live/calls.ts"
import { commitDirectly, fenceStatement } from "#test/support/live/direct.ts"
import { standingOn } from "#test/support/live/standing.ts"
import type { Registration } from "#test/support/live/system.ts"
import { printKeyed, sameKeyed } from "#test/support/live/values.ts"
import { probeAtMember, probeRelation } from "#test/support/live/world.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { fullWorld, testVerify, tokenOf } from "#test/support/worlds.ts"

const BYTE_ORDER_MARK = "\uFEFF"

/** The scalars a drawn text is made of: the byte order mark, one of each UTF-8 length. */
const palette = [BYTE_ORDER_MARK, "a", "é", "€", "😀"] as const

/** A case: each text's scalars. */
type TextsCase = ReadonlyArray<ReadonlyArray<string>>

const caseGen: Gen<TextsCase> = array(array(element(palette), { min: 1, max: 3 }), {
	min: 1,
	max: 3
})

type Feature =
	| "a text that begins with U+FEFF"
	| "a text holding U+FEFF after its start"
	| "a text of U+FEFF alone"
	| "a text with no U+FEFF"
	| "several texts in one commit"

const cases = 12

/** The login every case serves. */
const login = "server"

/**
 * A text of up to eight of any scalar PostgreSQL stores (every one but NUL, which no text holds): a drawn text has at
 * most three, and a bound on its length lets `tagged` look a note up by its text through an index.
 */
const Text = str.regex("^.{0,8}$", "su")

/** The schema of a case and its login: notes by a text, the fence's probe, and the reads and the write above. */
const notebook = (name: string) => {
	const Note = relation("Note", { id: pg.integer, tag: Text }, ["id"])
	const Probe = relation(probeRelation, { id: pg.integer }, ["id"])
	const base = schema(name, [Note, Probe], [])
	const world = fullWorld(base, {
		tagged: query(base).rule((r) => {
			const { id } = v(Note, "note")
			return r.match(Note, { id, tag: r.param("tag", Text) }).find({ id })
		}),
		all: query(base).rule((r) => {
			const { id, tag } = v(Note, "note")
			return r.match(Note, { id, tag }).find({ id, tag })
		}),
		[probeAtMember]: query(base).rule((r) => {
			const id = r.param("id", pg.integer)
			return r.match(Probe, { id }).find({ id })
		}),
		add: ChangeSet.empty(base).insert(Note, [])
	})
	return { schema: base, world }
}

/** Whether a registration's subscription is marked, none until it is. */
const marked = (registration: Registration) =>
	awaitFact(
		Effect.map(registration.state, (state) =>
			state === "marked" ? Option.some(undefined) : Option.none()
		)
	)

layer(Substrate.layer)("a stored text's live readers", (it) => {
	it.effect(
		`hear the commit that writes it, byte for byte, a leading U+FEFF among its characters, over ${cases} drawn sets of texts`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the drawn texts themselves and the served reads of the stored rows"
						},
						suite: "pg/live/text-keys",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a text that begins with U+FEFF",
								"a text holding U+FEFF after its start",
								"a text of U+FEFF alone",
								"a text with no U+FEFF",
								"several texts in one commit"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [
							{
								note: "a after a byte order mark, which a TextDecoder's defaults route as a",
								sketch: [[BYTE_ORDER_MARK, "a"], ["a"]],
								draws: "",
								reaches: ["a text that begins with U+FEFF", "several texts in one commit"]
							}
						],
						runs: cases,
						shrink: { kind: "bounded", candidates: 20 },
						steerEvery: 4,
						caseHang
					},
					(drawnTexts, notes) =>
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
							const writer = yield* substrate.session(worldSession(installed.world(book.world.app)))
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
									Effect.map(
										register("tagged", { params: { tag }, facts: {} }),
										(registration) => ({ tag, registration })
									)
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
						}).pipe(Effect.scoped)
				)
			)
	)
})
