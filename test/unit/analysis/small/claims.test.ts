import { coreGrammar, extendedGrammar } from "#test/support/unit/analysis/small/plans.ts"
import { variants } from "#test/support/unit/analysis/small/universe.ts"
/**
 * The analyses' claims against the truth of a small closed universe, exhaustively.
 *
 * Every query of a grammar (plans.ts) of up to two operators (the scan counted as one) over the small universe, under every key and containment variant and every execution context it can be read in
 * (universe.ts), is checked by the checker, annotated by the logical analysis and analyzed by the physical analysis
 * exactly as a compiled template is, unplaced and with a DISTINCT placed on its root, and then evaluated by the
 * reference on every database of at most two facts per relation the context may see, under every binding of the
 * parameters it reads. The core grammar reads R and S; the extended one adds the closed relation C, the relation
 * parameter P, the recursive closure of R, casts and computed columns, sums and unions of different headings.
 *
 * Soundness: on every database, every claim holds on every relation a node denotes: logical keys and cardinality,
 * determinism, an attachment's delivered type and its child's claims per parent (logical/support.ts logicalUnsound);
 * physical keys, maximum cardinality, every node said to owe nothing and every discharged obligation, on the rows the
 * realized SQL delivers (physical/support.ts soundness).
 *
 * Precision: what the universe proves, the analysis claims, where a claim decides what the user gets.
 * - get eligibility: a root that has at most one row on every database is claimed atMostOne or one, so get reads it;
 * - delivered types: an attachment whose every parent receives at most one child delivers an Option, and one whose every
 *   parent receives exactly one delivers the bare child;
 * - elision: a root whose realized rows are a set on every database is proved unique, so no DISTINCT is placed on it;
 * - obligations: an obligation left outstanding, which places a DISTINCT, is one whose input repeats on its heading on
 *   some database.
 * Precision is owed only where the universe is faithful: no varied source read twice by the root (two facts per
 * relation then bound one side of a self-join only), no computed column the universe's two values collapse to one, no
 * union for get eligibility, nor, for any of the four, a negation: excluding one of the universe's two values leaves
 * one, where a third value shows a second row, a second child or a repeated row (precise states a witness of each);
 * and for the bare child a scanned child relation the root does not read (reading it proves existence by itself, which
 * no containment states; C's declared facts cover the universe's values by accident), or the root's ordinal, whose
 * group its own fact keeps nonempty. A root or a child no database gives a row owes nothing.
 *
 * The bare child is judged over every shape a rule proves it by: a containment of one field, of two fields into a
 * whole-heading key (correlated by both, an attachment by both fields), and of a selected source (the scan of S's facts
 * whose a is 1, where a scan of every fact of S owes an Option); and the root's ordinal, inclusive and with no further
 * conjunct, where a strict ordinal or one beside a conjunct owes an Option, so a claim of one there is unsound.
 *
 * Shared children: each plan whose attachment scans a source is annotated again with that child read twice, as the
 * attachment's child and as a root of its own, and the child claims exactly the universe's minimal keys of its own
 * rows: the column sets of its heading no two of its rows agree on on any database, neither a sound superset nor the
 * attachment's relative evidence.
 *
 * Features: every claim checked, every precision situation each grammar must reach, and each elision reason
 * (ClaimFeature).
 */
import {
	coreRequired,
	exhaustUpTo,
	extendedRequired,
	extendedVariants
} from "#test/unit/analysis/small/claims.fixtures.ts"

/** The analyses over a small closed universe every core query of up to two operators: sound on every database, precise where the universe proves. */
export const theAnalysesOverASmallClosedUniverseEveryCoreQueryOfUpToTwoOperatorsSoundOnEveryDatabasePreciseWhereTheUniverseProves =
	exhaustUpTo(coreGrammar, variants, 2, {
		situations: coreRequired,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/attach.ts",
				original:
					"\t\tconst selected = scans.some((s) =>\n\t\t\tfact.from.selection.every((sel) => scanSelects(parent.view, s, sel.column, sel.value))\n\t\t)",
				replacement: "\t\tconst selected = scans.length > 0",
				why: "A bare child proved from a containment whose source selection the parent's fact need not satisfy (logical/attach.ts); unsound for the scan of every fact of S under the selected containment."
			},
			{
				file: "packages/engine/src/logical/attach.ts",
				original: "\t\tif (correlated === undefined) {",
				replacement: "\t\tif (correlated === undefined || correlated.length > 1) {",
				why: "A containment of two fields proves no child (logical/attach.ts); imprecise for the attachment by both fields."
			},
			{
				file: "packages/engine/src/logical/attach.ts",
				original: "\treturn throughScan(parent, found.region).some((props) =>",
				replacement: "\treturn [found.region].some((props) =>",
				why: "A source selection satisfied only by the scan's region, never by the filter above it, as the selected scan of S states it (logical/attach.ts scanSelects); imprecise for the bare child of a selected source."
			},
			{
				file: "packages/engine/src/logical/attach.ts",
				original:
					"\t\t\tfilters.every((f) => evaluate(f.pred, (name) => sym.get(name), f.input.id) === true)",
				replacement:
					"\t\t\tfilters.every((f) => evaluate(f.pred, (name) => sym.get(name), f.input.id) !== false)",
				why: "A filter the root's own fact leaves unknown counts as satisfied (logical/attach.ts reflexiveOne); unsound for an ordinal beside a conjunct."
			},
			{
				file: "packages/engine/src/logical/annotate.ts",
				original: "\t\t\t\t\tnode: rebuilt(node, inputs, false, claimsOf(props)),",
				replacement:
					"\t\t\t\t\tnode: rebuilt(node, inputs, false, claimsOf(count(node) > 1 ? { ...props, keys: props.keys.filter((k) => k.key.length === node.heading.length) } : props)),",
				why: "A child read twice claims only proofs of its whole heading as its keys (logical/annotate.ts); inexact for every shared child."
			}
		]
	})

/** The analyses over a small closed universe every extended query of up to two operators over single keys, with a containment and without. */
export const theAnalysesOverASmallClosedUniverseEveryExtendedQueryOfUpToTwoOperatorsOverSingleKeysWithAContainmentAndWithout =
	exhaustUpTo(extendedGrammar, extendedVariants, 2, {
		situations: extendedRequired,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/rules.ts",
				original: "\t\tif (new Set(values).size === values.length && rows.length > 0) {",
				replacement:
					"\t\tif ((new Set(values).size === values.length || new Set(values).size === 1) && rows.length > 0) {",
				why: "A closed relation's column of one repeated value claimed a key; unsound on some database of the universe."
			}
		]
	})
