/**
 * The naming door's byte limit on declared names (core/identity.ts parseDeclaredName): a declared name is admitted
 * exactly when its conversion, its segments lowercased and joined by single underscores, fits maxIdentifierBytes, and
 * an admitted name names its table by exactly that conversion, never cut. The oracle is the generator's own segments:
 * a name is spelled from words, acronyms and digit runs, each run of them joined so the door's boundary rule splits it
 * back into them (a capital after a lowercase letter, an acronym's last capital before a lowercase letter, a digit run
 * against a letter, an underscore), so the conversion is known before the door reads it. Lengths are steered to the
 * limit: a name's conversion ends at a drawn target byte count around 63, the last word sized to meet it.
 *
 * Features: a conversion under the limit, at it, one byte past and far past, and two names at the limit apart.
 */

import { maxIdentifierBytes } from "@bjornpagen/grizzle-engine/core/identity"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { conversionOf, identity, parseDeclaredName } from "#compiler/core/identity.ts"
import { assert } from "#test/support/assert.ts"
import {
	type LimitFeature,
	nameOf,
	situationOf,
	targetGen
} from "#test/unit/kernel/declared-names.fixtures.ts"

/**
 * The naming door's byte limit admits a declared name exactly when its conversion fits, and names its table by that
 * conversion, whole.
 *
 * Budget: its suite's count before the conversion (unit/kernel/declared-name-limit: 400 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const theNamingDoorsByteLimitAdmitsADeclaredNameExactlyWhenItsConversionFitsAndNamesItsTableByThatConversionWhole =
	property.explore(
		(source) =>
			[
				source.draw(nameOf(source.draw(targetGen))),
				source.draw(nameOf(source.draw(targetGen)))
			] as const,
		{
			needs: {},
			situations: [
				"under the limit",
				"at the limit",
				"one byte past",
				"far past",
				"two at the limit apart"
			] satisfies ReadonlyArray<Reached<LimitFeature>>,
			check: (_, c: Case<LimitFeature>) => (names) =>
				Effect.sync(() => {
					const identifiers = Arr.map(names, ({ declared, converted }) => {
						assert.equal(conversionOf(declared), converted, declared)
						const bytes = Buffer.byteLength(converted)
						c.note(situationOf(bytes))
						const parsed = parseDeclaredName(declared)
						assert.equal(parsed.ok, bytes <= maxIdentifierBytes, declared)
						if (!parsed.ok) {
							return undefined
						}
						const table = identity.table(parsed.value)
						assert.equal(table.form, "readable", declared)
						assert.equal<string>(table.identifier, converted, declared)
						return table.identifier
					})
					const [[a, b], [x, y]] = [names, identifiers]
					if (x !== undefined && y !== undefined) {
						assert.equal(x === y, a.converted === b.converted, `${a.declared} beside ${b.declared}`)
						if (
							x !== y &&
							Buffer.byteLength(x) === maxIdentifierBytes &&
							Buffer.byteLength(y) === maxIdentifierBytes
						) {
							c.note("two at the limit apart")
						}
					}
				}),
			oracle: {
				kind: "specification",
				name: "the generator's own segments, lowercased and joined by underscores, and the limit on their bytes"
			},
			budget: { runs: 400, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/identity.ts",
					original: "\t\treturn bytes > maxIdentifierBytes",
					replacement: "\t\treturn bytes >= maxIdentifierBytes",
					why: "A conversion of exactly maxIdentifierBytes is refused; the byte-limit property fails."
				},
				{
					file: "packages/engine/src/core/identity.ts",
					original:
						"\t\t\t\t(isUpper(ch) && isLower(prev)) ||\n\t\t\t\t(isUpper(ch) && isUpper(prev) && isLower(next)))",
					replacement: "\t\t\t\t(isUpper(ch) && isLower(prev)))",
					why: "An acronym's last capital stays with it before a lowercase letter (HTTPRoute one segment), so a conversion is not the generator's segments; the byte-limit property fails."
				}
			]
		}
	)
