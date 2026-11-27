/**
 * A node's logical properties decide as the reference's do.
 *
 * The analysis's properties of a node (logical/props.ts logicalPropsOf) are built for speed: their dependencies interned
 * and packed, a node's facts carried from its inputs' closures, its keys searched from what its inputs proved. The
 * reference (test/support/reference-props) is the slice as it stood before that work, every closure fresh over its node's
 * whole table and every key searched from scratch. Over generated queries, every node's properties by each, each
 * implementation reading its own properties of the node's inputs, decide alike: their keys with their factors,
 * alternatives, members and derivations, their classes and the forest of their equalities, their fixed columns with
 * every name and derivation in their order, their distinctness, cardinality, fact fields, provenance, evidence
 * context, heading groups, the whole heading's proof, and the proof each gives of each column alone, the heading, each
 * key and each key short of one of its columns. Oracle: the reference, a second implementation.
 *
 * Features: a key of several factors, a factor with another minimal key, a class of several columns, a fixed column
 * named, a node of several heading groups and a node reading columns from outside it.
 */

import { defaultGenConfig, soundnessGenConfig } from "#test/support/oracle/gen/case.ts"
import { decidesAsTheReferenceOn } from "#test/unit/analysis/logical/props-oracle.fixtures.ts"

/** A node's logical properties decide as the reference's do over generated queries. */
export const aNodesLogicalPropertiesDecideAsTheReferencesDoOverGeneratedQueries =
	decidesAsTheReferenceOn(defaultGenConfig, {
		situations: [
			"a key of several factors",
			"a factor with another minimal key",
			"a class of several columns",
			"a fixed column named",
			"a node of several heading groups"
		],
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/attributes.ts",
				original: "\t\tconst last = wordAt(bits, bits.length - 1)\n",
				replacement: "\t\tconst last = 0\n",
				why: "A set of attributes is held by its words but its last (logical/attributes.ts BitsSet add): a node's determinants that differ only there are one, and a parent carries the first one's dependencies alone."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\t\tadd(a.determines.from, bitsOf(attributes, a.determines.from))\n",
				replacement: "",
				why: "A node's key alternatives are no determinants a parent carries (logical/props.ts determinantsOf)."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\t\tappendAll(deps, pairedDependencies(reading.on, right))\n",
				replacement: "",
				why: "A semi-join keeps none of its right side's dependencies (logical/props.ts pairedDependencies), where the reference keeps those among its paired columns."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\tif (from.length < d.columns.length) {\n\t\t\treturn []\n\t\t}\n",
				replacement:
					"\t\tif (from.length === 0 || from.length < d.columns.length) {\n\t\t\treturn []\n\t\t}\n",
				why: "A semi-join keeps its right side's dependencies but its fixings: a left column paired with a column its right side fixes is fixed no more, where the reference fixes it."
			}
		]
	})

/** A node's logical properties decide as the reference's do over queries with lateral sources, shared nodes and windows. */
export const aNodesLogicalPropertiesDecideAsTheReferencesDoOverQueriesWithLateralSourcesSharedNodesAndWindows =
	decidesAsTheReferenceOn(soundnessGenConfig, {
		situations: [
			"a key of several factors",
			"a class of several columns",
			"a fixed column named",
			"a node reading columns from outside it"
		],
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original:
					"\t\tif (lateral.length === 0) {\n\t\t\tappendAll(equal, sourceEqualities(src, o.id, varsAt))\n",
				replacement:
					"\t\tif (true) {\n\t\t\tappendAll(equal, sourceEqualities(src, o.id, varsAt))\n",
				why: "A region reading a lateral source takes the source's equalities of its columns as its own (logical/props.ts regionProps), which a source read per outer row holds only per evaluation."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\touter: env.scope(node).outer,\n",
				replacement: "\t\touter: new Map(),\n",
				why: "A node's properties name no column it reads from outside it (logical/props.ts logicalPropsOf), so a fixed column's outer name names no value of the node."
			}
		]
	})
