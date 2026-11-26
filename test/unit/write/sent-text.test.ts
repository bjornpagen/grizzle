/**
 * A served single statement's text, as @bjornpagen/grizzle/compile's `assembled` gives it over its served units, is the
 * text the runtime sends, byte for byte, with as many placeholders in the same order: the export is the runtime's own
 * assembly (runtime/write/parted.ts assembled, through plan/serve.ts), never a copy of it. A copy drifts: qti-pie's
 * plan budget kept one, which joined each arm as a string after the arms became cut texts, so it printed
 * `[object Object]` for every arm and measured none of a student action's largest statements.
 *
 * Box: an insert of a fact into each of two to four relations, each keyed again, so the write's statement holds a part
 * per relation, every part sent.
 *
 * Oracle: second implementation, the runtime's loaded write (runtime/write/flight.ts partedFlight), whose form's text is
 * the one a Db prepares and sends as it stands.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { relations, sentPairs } from "#test/unit/write/sent-text.fixtures.ts"

/** A served single statement's exported assembly is the text and placeholders the runtime sends, byte for byte. */
export const aServedSingleStatementsExportedAssemblyIsTheTextAndPlaceholdersTheRuntimeSendsByteForByte =
	property.exhaust(
		finite((source) => source.draw(relations)),
		{
			needs: {},
			situations: [],
			check: () => (n) =>
				Effect.sync(() => {
					const pairs = sentPairs(n)
					assert.ok(
						pairs.length > 0,
						`an insert into ${n} relations sends a single statement by its parts`
					)
					for (const p of pairs) {
						assert.equal(
							p.exported.text,
							p.runtime.text,
							`statement ${p.index}: the exported assembly's text is the runtime's`
						)
						assert.equal(
							p.exported.params,
							p.runtime.params,
							`statement ${p.index}: the exported assembly's placeholders are the runtime's`
						)
					}
				}),
			oracle: {
				kind: "second-implementation",
				name: "the runtime's loaded write, the form a Db prepares and sends"
			},
			box: "an insert into two to four relations, each a part of one statement",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/plan/serve.ts",
					original: "\tassembled,\n\ttype AssembledText,",
					replacement:
						'\ttype AssembledText,\n} from "#compiler/runtime/write/parted.ts"\nexport const assembled = (units: ReadonlyArray<{ readonly kind: string; readonly ctes: { readonly head: string }; readonly arm?: unknown; readonly arms?: ReadonlyArray<unknown> }>) => ({ text: "WITH " + units.map((u) => u.ctes.head).join(",\\n") + "\\n" + units.flatMap((u) => (u.kind === "part" ? [u.arm] : (u.arms ?? []))).join("\\nUNION ALL\\n"), params: [] })\nexport {',
					why: "The export routed through a reimplementation of the assembly, as qti-pie's plan budget kept one: it joins the arms as strings, so each cut text prints as [object Object] and no placeholder is numbered."
				}
			]
		}
	)
