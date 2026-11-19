/**
 * A law's judgement and a cast a proof completes name no check PostgreSQL must make of a computed text. A law's own
 * judgement, a violation probe or a rule's region, delivers no claim of its outputs' refinements and types a text
 * refinement no stored field declares by its base (lower/conservative/types.ts judgesLaw), so a containment of a stored
 * text into a derived relation's computed text, whose sides the law relabels to their common type, installs; and a
 * cast whose value a proof made its target's, a relabel (scalar/compute/registry.ts binaryCoercion) or a domain cast the
 * typing completed (scalar/compute/typing.ts domainCast), prints as its base text in a persistent expression where its
 * target is a refinement no stored field declares (ir/physical.ts provedCastType), so a generated field that casts a
 * computed text into such a type installs, each for every text map.
 *
 * Oracle: the specification: every case installs.
 *
 * Features: each site, each text map.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { succeeded } from "#test/support/assert.ts"
import {
	installed,
	type ProvedCastCase,
	provedCastCaseGen,
	type Site,
	type TextMap
} from "#test/unit/lower/proved-cast.fixtures.ts"

type ProvedCastFeature = `a ${Site} over ${TextMap}`

/**
 * A containment into a computed text and a generated cast into an undeclared text type install, for every text map.
 * Each case compiles a fresh installation, so its budget is the runner's own 150 runs, which reach its 8 situations.
 */
export const aCastAProofMakesItsTargetsInstallsWhereNoStoredFieldDeclaresItsRefinement =
	property.explore(provedCastCaseGen, {
		needs: {},
		situations: [
			"a containment over collapse",
			"a containment over replaceWhitespace",
			"a containment over lowerAscii",
			"a containment over translate",
			"a generated cast over collapse",
			"a generated cast over replaceWhitespace",
			"a generated cast over lowerAscii",
			"a generated cast over translate"
		] satisfies ReadonlyArray<Reached<ProvedCastFeature>>,
		check: (_, k: Case<ProvedCastFeature>) => (c: ProvedCastCase) =>
			Effect.sync(() => {
				succeeded(installed(c), `a ${c.site} over ${c.map} of ${c.operand.name}`)
				k.note(`a ${c.site} over ${c.map}`)
			}),
		oracle: { kind: "specification", name: "every case installs" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/expr.ts",
				original:
					"\t\t\tisProvedCast(expr) ? provedCastType(names, type) : fieldColumnType(names, type).type,",
				replacement: "\t\t\tfieldColumnType(names, type).type,",
				why: "A generated field's domain cast into a refinement no stored field declares names its domain, which the installation lacks, so the installation is refused at physical names; the property fails."
			},
			{
				file: "packages/engine/src/lower/conservative/types.ts",
				original: '\t\tcase "violationProbe":\n\t\tcase "ruleRegion":\n\t\t\treturn true',
				replacement: '\t\tcase "violationProbe":\n\t\t\treturn true\n\t\tcase "ruleRegion":',
				why: "A rule's region claims its outputs' refinements as a query's head does, so the containment's judge must check a computed text by a domain the installation lacks and is refused; the property fails."
			}
		]
	})
