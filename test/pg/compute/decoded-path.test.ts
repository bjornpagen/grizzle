/**
 * A text's decoded path, r.decodedPath (ir/rel.ts TextSplit `decodedPath`, the library's decodedPath,
 * physical/ddl/library.ts), served reads on PostgreSQL 19 against the host's strict UTF-8 decoder
 * (decoded-path.fixtures.ts): over one transaction's written paths of literal characters (a slash, a dot, é and a
 * character beyond the BMP among them), escapes of one- to four-octet UTF-8 in either case, ill-formed octets (lone
 * continuations, truncated leads, overlong forms, a surrogate, past U+10FFFF), escapes of `/` and of U+0000, segments of
 * dots written `%2E`, and stray `%`s, each path's decoded path is the host's, none where RFC 3986 gives it none, and
 * the paths that spell none are a negation of it. The read casting a decoded path into its text's own 256-byte type
 * compiles only where the checker types it within its text's byte bound.
 *
 * Oracle: the host's strict UTF-8 decoder over the octets each path writes, its refusals as RFC 3986 §2.1, §2.2 and
 * §2.5 state them (test/support/oracle/reference/evaluate.ts decodedPathOf).
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	casesGen,
	decodedModel,
	decodedText,
	factsOf,
	idsOf,
	type PathFeature,
	type PathsCase,
	pathFeatures,
	Paths,
	pathsInstall,
	pathsTemplate,
	undecodableModel
} from "#test/pg/compute/decoded-path.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A text's decoded path is the path its escapes spell as UTF-8, none where a `%` begins no escape, the octets are no
 * UTF-8, an escape spells `/` or U+0000, or a dot segment is written `%2E`.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aTextsDecodedPathIsThePathItsEscapesSpellAsUTF8NoneWhereRFC3986GivesItNone =
	property.explore(casesGen, {
		needs: { fixture: Substrate.fresh(pathsTemplate) },
		situations: [
			"the empty path",
			"a path decoded",
			"an escape beyond the BMP decoded",
			"an escape run broken by a literal",
			"ill-formed UTF-8 refused",
			"an escaped slash refused",
			"an escaped NUL refused",
			"a written dot segment refused",
			"a stray percent refused"
		] satisfies ReadonlyArray<Reached<PathFeature>>,
		check:
			({ fixture }, k: Case<PathFeature>) =>
			(c: PathsCase) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Paths, {}, pathsInstall, taken)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									yield* db.workload.load.once({ params: {}, facts: { insert: factsOf(c) } })
									const none = { params: {}, facts: {} }
									const where = Formatter.format(c)
									const decoded = yield* db.workload.decoded.once(none)
									assert.deepEqual(
										decodedText(decoded),
										decodedModel(c),
										`each path's decoded path, of ${where}`
									)
									const undecodable = yield* db.workload.undecodable.once(none)
									assert.deepEqual(
										idsOf(undecodable),
										undecodableModel(c),
										`the paths that spell none, of ${where}`
									)
									for (const feature of pathFeatures(c)) {
										k.note(feature)
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the host's strict UTF-8 decoder over the octets each path writes, each %HH its octet, none where a % begins no escape, an escape spells / or U+0000, or a segment of dots holds a %2E (RFC 3986 §2.1, §2.2, §2.5)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original:
					'\t\t\t\tresult: and([continuation(x("a1")), continuation(x("a2")), continuation(x("a3"))])',
				replacement: '\t\t\t\tresult: and([continuation(x("a1")), continuation(x("a2"))])',
				why: "A four-octet lead stands with two continuations after it, so `%F0%9F%98` and a literal decode where the host refuses the truncated sequence."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: "\t\tand([eq(b1, integer(0xe0)), within(b, 0xa0, 0xbf)]),",
				replacement: "\t\teq(b1, integer(0xe0)),",
				why: "An overlong three-octet form, E0 and a second octet below A0, stands, so `%E0%80%80` decodes where the host refuses it."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original:
					"\t\t\t{ when: or([eq(b, integer(0)), eq(b, integer(0x2f))]), result: lit.bool(false) },",
				replacement: "\t\t\t{ when: eq(b, integer(0)), result: lit.bool(false) },",
				why: "An escaped slash stands, so `a%2Fb` decodes to `a/b`, a path of two segments, where the host refuses its one segment holding `/`."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: '\t\t\t\t\tw("ok"),\n\t\t\t\t\tnotExists(',
				replacement: '\t\t\t\t\tw("ok"),\n\t\t\t\t\tlit.bool(true) ?? notExists(',
				why: "A segment of dots written `%2E` decodes to a dot segment the written path does not hold, where the host refuses it."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original:
					'\t\t\t\twhen(or([eq(s("n"), integer(1)), gt(length(s("p")), integer(2))]), integer(1), integer(0))\n',
				replacement: "\t\t\t\tinteger(0)\n",
				why: "No literal ends a run of escapes, so a lead escape, a literal and a continuation escape read as one sequence, which the host refuses."
			}
		]
	})
