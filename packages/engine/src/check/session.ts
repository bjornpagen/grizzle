import type { Carrying, CarryingMemo } from "#compiler/check/carry.ts"
import type { ClosedImport, QueryRead } from "#compiler/check/checker.ts"
import type { Resolved, ResolvedQuery } from "#compiler/check/params.ts"
import type { SchemaReading } from "#compiler/check/schema.ts"
import { unwrap } from "#compiler/core/canonical.ts"
import type { IdentityDigest } from "#compiler/core/fingerprint.ts"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { deepFreeze } from "#compiler/core/record.ts"
import {
	descIdentities,
	type ImportedWalks,
	type InferredQuery,
	type ParamTyping
} from "#compiler/ir/desc.ts"
import type { Heading, RelNode } from "#compiler/ir/rel.ts"
import { checkerEvidence, SharedAnalyses } from "#compiler/logical/annotate.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { AnalyzedPatterns } from "#compiler/text/refinement.ts"

/**
 * How a query is entered, the one thing of its reader's context its rules read (check/description.ts): as a query of
 * its own (the root, an import, a navigation's step, a call's rows), whose scope is its own, or as an attachment's
 * child, whose rules may read the parent's variables. A query is never entered inside a recursive step.
 */
export type QueryEntry = "query" | "attachment"

/** No query validated under either entry. */
const entries = (): Readonly<Record<QueryEntry, WeakSet<InferredQuery>>> => ({
	query: new WeakSet(),
	attachment: new WeakSet()
})

/**
 * Each imported query resolved once for its identity (check/params.ts resolveQuery): an imported query is its own
 * namespace, its resolution its Description's alone, so every import of one identity reads one resolved query, one
 * place among the objects an import's key names (CheckSession `place`), and so one key and one node (check/checker.ts
 * importedKey), where each Description object was a query of its own: the 162 imports of the graded attempts'
 * latest-attempt fold in edullm's decideStage read-back, one per argument of the grade, were 162 nodes.
 *
 * A query's identity is its Description's (ir/desc.ts descIdentity), its canonical text without source locations, each
 * variable spelled by its scope's name and field and each interior stage by its place in its rule, so it names no label
 * a build allocated, frozen before it is digested, as every Description is (core/record.ts deepFreeze, which walks only
 * what is not frozen yet). Two Descriptions of one identity are one query, one object or two: a factory that builds a
 * query anew at every place it is read (edullm's ledger reads `gradableOf(gradedSitting).bind(bySession(r))` in each
 * argument of its grade, a Description of its own each time) builds one query. Two consequences of reading one query for
 * all of them, each the identity's own: a Logic.when branch's parameter is a stand-in its subject's identity is (ir/desc.ts
 * GuardedDesc), so a Description that reads the captured subject where another reads the parameter is checked as
 * whichever of them the compile met first, the rows they compute one, a refusal of the subject's weaker type the one
 * thing that can go unmet, as navigation, which keys its queries by the same identity, reads them already; and a refusal
 * or a node's location inside such a query names the first Description of its identity the compile met, source
 * locations being no part of it.
 *
 * The compile's digests are scoped to it (`#digests`, core/fingerprint.ts IdentityDigests scoped): they read every
 * identity the process's (ir/desc.ts descIdentities) keep, a ChangeSet's members' parts among them, and keep each part
 * they digest past those for as long as the compile lives, adding none to the process's, which keep each frozen part's
 * identity for as long as the part lives: an import is a Description its program holds for the whole run, so every
 * part of every query any compile imported held an entry of one table for the process, which grows with every
 * Description a program keeps and has a hard ceiling, V8's largest hash table, past which the process aborts (metis's
 * generate reached it at 16.8 million parts, through ChangeSet renames, write/changeset/value.ts canonicalParts).
 */
class ResolvedImports implements ImportedWalks<Resolved["param"], ParamTyping> {
	readonly #resolved = new Map<IdentityDigest, ResolvedQuery>()
	/** The identity digests of the compile's imported Descriptions: the process's read, the compile's own kept apart. */
	readonly #digests = descIdentities.scoped()

	get(q: InferredQuery): ResolvedQuery | undefined {
		return this.#resolved.get(this.#identityOf(q))
	}

	set(q: InferredQuery, walked: ResolvedQuery): void {
		this.#resolved.set(this.#identityOf(q), walked)
	}

	#identityOf(q: InferredQuery): IdentityDigest {
		return unwrap(this.#digests.of(deepFreeze(q)))
	}
}

/**
 * What the checks of one compile share, owned by that compile and passed to every check it runs, never held by a
 * module: a ChangeSet's members, read-backs and fills (write/frontend/compile.ts), or the one query of a query's
 * compile.
 *
 * - Each imported query resolved once for its identity (ResolvedImports): an imported query is its own
 *   namespace, so its resolution is its Description's alone, and one resolution of it serves every import of it in
 *   every query the compile checks, whose imports of one query, one Description object or several of one identity,
 *   then share one resolved query.
 * - The place of each object an import's key names (check/checker.ts importedKey), in the order the checks met it.
 * - One label space (`ids`): every check of the compile draws its labels from it, so a node one check built stands in
 *   another check's DAG under labels no other node of it holds.
 * - Each closed import the checks built, by the schema and the reading it was checked under and its key, checked and
 *   completed once (check/checker.ts ClosedImport): an import bound to parameters and constants alone reads the same
 *   rows wherever it stands in the compile's queries, whose parameters are one namespace, so every check that reads it
 *   at its key reads that one node, adopting what its check recorded, where each check built the import again and
 *   completed it again over its own DAG (a ChangeSet of a hundred members reading one call's six hundred imports); and a
 *   write's DAG merges the imports of one key as one node (write/frontend/dag.ts QueryMerger).
 * - The logical analyses of its closed imports (logical/annotate.ts SharedAnalyses), under the checker's evidence: a
 *   completion that reads a closed import another completion analyzed reads its annotations, so an import read inside
 *   others is analyzed once for the compile, where every importer's completion analyzed it again, up its nesting.
 * - Each query whose structure the checks have validated (check/description.ts validateQueryStructure), by how the
 *   check reads its query and how the query was entered: a query is one value every reader of it shares
 *   (query/build/state.ts publicDesc), so the compile's descriptions are one DAG of queries, and a query's structure
 *   under one reading and one entry is the query's alone, so one validation of it serves every reader of it in every
 *   query the compile checks, where each path to it was walked again.
 * - The admitted patterns the checks read, with the text analysis of each conjunction they type (text/refinement.ts
 *   AnalyzedPatterns), each parsed, minimized and analyzed once for the compile: a pattern is its source and flags
 *   alone, and a conjunction's language its patterns' alone, so every check of the compile that types a text of it,
 *   admits a literal of it or proves a cast into it reads one parse, one minimal DFA and one analysis. A check inside a
 *   checked schema's own compile, a derived definition's, a rule's or a column's, reads the schema's table
 *   (SchemaReading `patterns`); a query's, a write's or a workload's compile holds a table of its own (`own`), so no
 *   compile's patterns outlive it in a schema a server keeps.
 */
export class CheckSession {
	/** Each imported query, resolved once for its identity. */
	readonly resolved = new ResolvedImports()
	/** The admitted patterns the checks read, each parsed, minimized and analyzed once. */
	readonly patterns: PatternAutomata

	/** The session of checks that read `patterns`, the table of the compile they serve. */
	constructor(patterns: PatternAutomata) {
		this.patterns = patterns
	}

	/** The session of a compile of its own, a query's, a write's or a workload's, over a table of its own. */
	static own(): CheckSession {
		return new CheckSession(new AnalyzedPatterns())
	}

	/** Each query whose structure was validated, by the reading of the check that validated it and by its entry. */
	readonly validated: Readonly<
		Record<QueryRead, Readonly<Record<QueryEntry, WeakSet<InferredQuery>>>>
	> = {
		rows: entries(),
		page: entries(),
		readBack: entries(),
		membership: entries(),
		region: entries()
	}
	/** The compile's one label space, every check's. */
	readonly ids = makeIdSupply()
	/**
	 * The relation parameters a write's ChangeSet binds to queries whose readers read one evaluation of each, carried
	 * before the first stratum of the part that bound it (write/frontend/compile.ts, ChangeSetDesc `boundRows`), by
	 * name, each with the heading
	 * that evaluation delivers: a use of one, in any check of the compile, reads it as the InputSet of that evaluation
	 * (Checker `#paramSource`, ir/rel.ts InputSetInput `bound`). Its compile records each before it checks a reader.
	 */
	readonly bound = new Map<string, Heading>()
	readonly #places = new WeakMap<object, number>()
	#placed = 0
	readonly #closed = new WeakMap<RelNode, string>()
	readonly #imports = new WeakMap<SchemaReading, Map<string, ClosedImport>>()
	/** The analyses of the closed imports the checks built (`closed`), each read by every completion that reads it. */
	readonly analyses = new SharedAnalyses(
		checkerEvidence,
		(node) => this.closedKey(node) !== undefined
	)

	/**
	 * The closed imports the checks of the compile built over `schema`, by their reading and key (Checker
	 * `#closedImport`): one table for each schema, a ChangeSet's base and its role's world apart.
	 */
	closedImports(schema: SchemaReading): Map<string, ClosedImport> {
		const known = this.#imports.get(schema)
		if (known !== undefined) {
			return known
		}
		const imports = new Map<string, ClosedImport>()
		this.#imports.set(schema, imports)
		return imports
	}

	readonly #carried = new WeakMap<ResolvedQuery, Map<string, Carrying>>()

	/**
	 * The query `query` carrying the digest of its column `column` (check/carry.ts CarryingMemo), `build`'s at the
	 * compile's first reader of it, the same object at every other, so the carried query has one place among the objects
	 * import keys name (`place`), and so one key and one node, as the query it carries the digest of has.
	 */
	readonly carrying: CarryingMemo = (query, column, build) => {
		const known = this.#carried.get(query)
		const found = known?.get(column)
		if (found !== undefined) {
			return found
		}
		const built = build()
		const at = known ?? new Map<string, Carrying>()
		at.set(column, built)
		this.#carried.set(query, at)
		return built
	}

	/** `o`'s place among the objects import keys name. */
	place(o: object): number {
		const known = this.#places.get(o)
		if (known !== undefined) {
			return known
		}
		const place = this.#placed
		this.#placed += 1
		this.#places.set(o, place)
		return place
	}

	/** Records `node`, a node of a checked query's DAG, as the closed import of `key`. */
	closed(node: RelNode, key: string): void {
		this.#closed.set(node, key)
	}

	/** The key `node` was built under as a closed import, none for any other node. */
	closedKey(node: RelNode): string | undefined {
		return this.#closed.get(node)
	}

	/**
	 * Whether a node is a closed import the checks built (`closed`): a predicate that holds the session's table of them
	 * alone and never the session, so analyses a compile keeps past its checks share the imports' annotations
	 * (logical/annotate.ts SharedAnalyses) and keep none of the records and analyses the session holds.
	 */
	closedRoots(): (node: RelNode) => boolean {
		const closed = this.#closed
		return (node) => closed.has(node)
	}
}
