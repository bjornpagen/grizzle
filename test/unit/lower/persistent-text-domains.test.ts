/**
 * A computed text a law reads or a persistent expression casts installs with the domain of every refinement it is typed
 * by, and with every library function it calls, whatever stored field, check or domain names them, and none need. One rule holds: the installation holds the domain
 * of every refinement any artifact over it types a value by (physical/install/plan.ts artifactDomains), so a
 * containment of a stored text into a derived relation's computed text, whose sides the law relabels to their common
 * type, and a generated field that casts a computed text into a text type no stored field declares (a domain cast the
 * typing completed, scalar/compute/typing.ts domainCast) each name an installed domain, as every other cast does
 * (ir/physical.ts fieldColumnType), for every text map; and a check over a derived relation's computed text that holds
 * it to be an XML Schema pattern (Xml.isPattern), pantry's Pattern_language, whose judge alone calls the library
 * function isXsdPattern, installs it. No cast is typed by its base for want of a domain, and no call is refused for
 * want of a function.
 *
 * Oracle: the specification: every case installs, its plan naming a domain only where its set holds it, so every text
 * domain its statements name is one it creates (physical/install/plan.ts installedTextNamed).
 *
 * Features: each site, each text map.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { succeeded } from "#test/support/assert.ts"
import {
	installed,
	type PersistentTextCase,
	persistentTextCaseGen,
	type Site,
	type TextMap
} from "#test/unit/lower/persistent-text-domains.fixtures.ts"

type PersistentTextFeature = `a ${Site} over ${TextMap}`

/**
 * A containment into a computed text, a generated cast into an undeclared text type and a pattern check over a computed
 * text install, each with every text domain it names and every library function it calls, for every text map. Each case compiles a fresh installation, so its budget is the runner's own 150
 * runs, which reach its 12 situations.
 */
export const aComputedTextALawReadsOrAPersistentExpressionCastsInstallsWithItsDomainsAndFunctions =
	property.explore(persistentTextCaseGen, {
		needs: {},
		situations: [
			"a containment over collapse",
			"a containment over replaceWhitespace",
			"a containment over lowerAscii",
			"a containment over translate",
			"a generated cast over collapse",
			"a generated cast over replaceWhitespace",
			"a generated cast over lowerAscii",
			"a generated cast over translate",
			"a pattern check over collapse",
			"a pattern check over replaceWhitespace",
			"a pattern check over lowerAscii",
			"a pattern check over translate"
		] satisfies ReadonlyArray<Reached<PersistentTextFeature>>,
		check: (_, k: Case<PersistentTextFeature>) => (c: PersistentTextCase) =>
			Effect.sync(() => {
				succeeded(installed(c), `a ${c.site} over ${c.map} of ${c.operand.name}`)
				k.note(`a ${c.site} over ${c.map}`)
			}),
		oracle: {
			kind: "specification",
			name: "every case installs, naming a text domain only where its installation holds it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/install/plan.ts",
				original:
					'\t\t...persistentTerms.flatMap((e) =>\n\t\t\te.kind === "cast" || e.kind === "domainCast" ? [{ type: e.type, loc: persistent }] : []\n\t\t),\n',
				replacement: "",
				why: "A persistent expression is no place the installation types a refinement by: the generated cast names the domain of a text type no stored field declares, which the installation does not create."
			},
			{
				file: "packages/engine/src/physical/install/plan.ts",
				original:
					"\t\tlibrary: distinctLibrary([\n\t\t\t...closedLibrary(owned),\n\t\t\t...libraryCalls(model),\n\t\t\t...held.flatMap((h) => h.library),\n\t\t\t...dagObjects(lawsLoc, [], violations.dag.roots).library\n\t\t])\n",
				replacement:
					"\t\tlibrary: distinctLibrary([...closedLibrary(owned), ...libraryCalls(model)])\n",
				why: "The library functions a law's checked DAG calls are not installed, the old collector of persistent expressions alone: the pattern check's judge calls isXsdPattern, which the installation does not install, and the installation is refused as UninstalledFunction."
			},
			{
				file: "packages/engine/src/physical/install/plan.ts",
				original: "\t\tdagObjects(lawsLoc, [], lowered)\n",
				replacement: "\t\tdagObjects(lawsLoc, [], [])\n",
				why: "A law's violation query is no place the installation types a refinement by: the containment's judge relabels its sides to the live derived relation's computed text, whose domain the installation does not create."
			}
		]
	})
