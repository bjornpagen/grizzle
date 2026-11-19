/**
 * A cast whose value a proof made its target's, a relabel (scalar/compute/registry.ts binaryCoercion) or a domain cast
 * the typing completed (scalar/compute/typing.ts domainCast), names no check PostgreSQL must make of a computed text: in
 * a persistent expression it prints as its base text where its target is a refinement no stored field declares
 * (ir/physical.ts provedCastType), so a generated field that casts a computed text into such a type installs, for every
 * text map.
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
 * A generated cast of a computed text into an undeclared text type installs, for every text map. Each case compiles a
 * fresh installation, so its budget is the runner's own 150 runs, which reach its 4 situations.
 */
export const aCastAProofMakesItsTargetsInstallsWhereNoStoredFieldDeclaresItsRefinement =
	property.explore(provedCastCaseGen, {
		needs: {},
		situations: [
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
			}
		]
	})
