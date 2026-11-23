/**
 * A stored derived relation's head names are its table's declared column names: two whose conversions agree
 * (core/identity.ts conversionOf, a name's segments lowercased and joined by single underscores) are one column
 * identifier, refused as IdentifierCollision naming that identifier, and two whose conversions differ install as two
 * columns.
 *
 * Property: over drawn pairs of head names, each a spelling (snake_case, camelCase or PascalCase) of a drawn
 * sequence of words, a derived relation whose head binds one field under both names is refused with
 * IdentifierCollision, naming its words joined by underscores, exactly when the two names spell one sequence of
 * words; otherwise it installs two columns whose identifiers differ.
 *
 * Oracle: the conversion's specification restated over the words a name is spelled from: a name's segments are its
 * words, so two names convert alike exactly when they spell one sequence. A word is two or three of the letters a
 * and b, so every capital a spelling writes is followed by a lower-case letter and starts a segment of its own (a
 * capital beside a capital would read as one acronym segment, which the model does not state).
 *
 * Inputs, constructed: a collision is one sequence of words under two of its spellings that differ as text (a head
 * is a record, so two equal names would be one field); names apart are a sequence and that sequence with one word
 * changed to another or one word appended, each spelled any way. The three are drawn equally often.
 *
 * Features: a collision of one word's spellings, a collision of several words' spellings, names apart by a changed
 * word, names apart by an appended word, names apart in one spelling.
 *
 * What a stored derived relation installs, each column's type, typmod and collation, and its rows against its
 * definition, is PostgreSQL's to judge, in the database suites.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { withDerivedRelations } from "#compiler/physical/derived/objects.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { own } from "#compiler/schema/own.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { decodedSchema } from "#test/support/fixtures/ir/desc.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { type Feature, pairGen, pairs, spell } from "#test/unit/derived/install.fixtures.ts"

/**
 * Derived relation view columns refuse two head names converting to one column identifier, and install names
 * converting apart.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/derived/install.test.ts:185 at 8cad5bce, its runs and its coverage's cases).
 */
export const derivedRelationViewColumnsRefuseTwoHeadNamesConvertingToOneColumnIdentifierAndInstallNamesConvertingApart =
	property.explore(pairGen, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"a collision of one word's spellings",
			"a collision of several words' spellings",
			"names apart by a changed word",
			"names apart by an appended word",
			"names apart in one spelling"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (p) =>
			Effect.sync(() => {
				const a = spell(p.left, p.spelled[0])
				const b = spell(p.right, p.spelled[1])
				const installed = Result.flatMap(own(decodedSchema(pairs(a, b))), (owned) =>
					compileInstallation(owned, withDerivedRelations(installOptions(owned)))
				)
				if (Arr.makeEquivalence(Str.Equivalence)(p.left, p.right)) {
					c.note(
						p.left.length === 1
							? "a collision of one word's spellings"
							: "a collision of several words' spellings"
					)
					const reason = refused(installed, "IdentifierCollision").reason
					if (reason._tag !== "IdentifierCollision") {
						return assert.fail(`an IdentifierCollision, not ${reason._tag}`)
					}
					assert.equal(
						reason.identifier,
						Arr.join(p.left, "_"),
						"the identifier both head names convert to"
					)
					return
				}
				c.note(
					p.kind === "an appended word"
						? "names apart by an appended word"
						: "names apart by a changed word"
				)
				if (p.spelled[0] === p.spelled[1]) {
					c.note("names apart in one spelling")
				}
				const N = installationNamesOf(succeeded(installed))
				assert.notEqual(
					N.columnIdent({ name: "Pairs" }, a),
					N.columnIdent({ name: "Pairs" }, b),
					"two names converting apart are two view columns"
				)
			}),
		oracle: {
			kind: "specification",
			name: "two names convert alike exactly when they spell one sequence of words, to the words joined by underscores"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/derived/analyze.ts",
				original: `\t\tconst columns = DeclaredNamespace.columns(\`relation \${relation}'s field\`)\n\t\treturn mapNonEmpty(heading, (c): DeclaredColumn => {\n\t\t\tconst name = unwrap(\n`,
				replacement: `\t\treturn mapNonEmpty(heading, (c): DeclaredColumn => {\n\t\t\tconst columns = DeclaredNamespace.columns(\`relation \${relation}'s field\`)\n\t\t\tconst name = unwrap(\n`,
				why: "analysis/derived/analyze.ts declaredHeading declares each head column in a namespace of its own, so no two ever collide; a collision installs as two columns."
			}
		]
	})
