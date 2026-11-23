import type { ClosedImport, QueryRead } from "#compiler/check/checker.ts"
import type { ResolvedQuery } from "#compiler/check/params.ts"
import type { SchemaReading } from "#compiler/check/schema.ts"
import { makeIdSupply } from "#compiler/core/ids.ts"
import type { Inferred, InferredQuery, Located, QueryDesc } from "#compiler/ir/desc.ts"
import type { Heading, RelNode } from "#compiler/ir/rel.ts"
import { checkerEvidence, SharedAnalyses } from "#compiler/logical/annotate.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"

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
 * What the checks of one compile share, owned by that compile and passed to every check it runs, never held by a
 * module: a ChangeSet's members, read-backs and fills (write/frontend/compile.ts), or the one query of a query's
 * compile.
 *
 * - Each imported query resolved once (check/params.ts resolveQuery): an imported query is its own namespace, so its
 *   resolution is the query's alone, and one resolution of it serves every import of it in every query the compile
 *   checks, whose imports of one query then share one resolved query.
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
 * - The admitted patterns the checks read (scalar/regex/patterns.ts CompilePatterns), each parsed, and minimized where
 *   a proof compares it, once for the compile: a pattern is its source and flags alone, so every check of the compile
 *   that types a text of it, admits a literal of it or proves a cast into it reads one parse and one minimal DFA.
 */
export class CheckSession {
	/** Each imported query, resolved. */
	readonly resolved = new WeakMap<QueryDesc<Located, Inferred>, ResolvedQuery>()
	/** The admitted patterns the checks read, each parsed and minimized once. */
	readonly patterns = new CompilePatterns()
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
	 * before its first stratum (write/frontend/compile.ts, ChangeSetDesc `boundRows`), by name, each with the heading
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
}
