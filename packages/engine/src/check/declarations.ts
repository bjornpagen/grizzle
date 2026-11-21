import { failWith } from "#compiler/check/fail.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"

/** What a query declares once by name (DuplicateIdentity): a contract a descriptor it carries states, a context it matches. */
type DeclarationKind = "contract" | "context"

/** A name's declaration: its descriptor's canonical text, and where it stands. */
interface Declaration {
	readonly text: string
	readonly loc: SourceLoc
}

/** One declaration as `declare` took it: what a journal holds (DeclarationTable `journaled`) and `replay` declares again. */
export interface Declared {
	readonly kind: DeclarationKind
	readonly name: string
	readonly declaration: Declaration
}

/**
 * The names one query declares once, a table of each kind (DuplicateIdentity): a name's first declaration holds it, an
 * equal one again is nothing, and another text is DuplicateIdentity at the later declaration, naming the first. A
 * query's check declares its contracts (analysis/schema.ts queryFieldType) and its contexts (check/checker.ts) in one,
 * as a generated field's typing declares its contracts in one of its own.
 */
export class DeclarationTable {
	readonly #declared: Readonly<Record<DeclarationKind, Map<string, Declaration>>> = {
		contract: new Map(),
		context: new Map()
	}
	/** The journals open on the table (`journaled`), innermost last: each takes every declaration made while it is open. */
	readonly #journals: Array<Array<Declared>> = []

	declare(kind: DeclarationKind, name: string, declaration: Declaration): void {
		const table = this.#declared[kind]
		const prior = table.get(name)
		if (prior === undefined) {
			table.set(name, declaration)
		} else if (prior.text !== declaration.text) {
			failWith({
				_tag: "DuplicateIdentity",
				at: declaration.loc,
				duplicate: { kind, name, earlier: prior.loc }
			})
		}
		for (const journal of this.#journals) {
			journal.push({ kind, name, declaration })
		}
	}

	/**
	 * `run`'s value, with every declaration made while it ran, in order, an equal one again among them: what a closed
	 * import's check declares (check/checker.ts ClosedImport), which every query that reads the import declares again
	 * (`replay`), as its own check of the import would. A refusal `run` throws ends the check that owns the table, so
	 * the journal it leaves open is never read.
	 */
	journaled<A>(run: () => A): { readonly value: A; readonly declared: ReadonlyArray<Declared> } {
		const journal: Array<Declared> = []
		this.#journals.push(journal)
		const value = run()
		this.#journals.pop()
		return { value, declared: journal }
	}

	/** Declares each of `declared` again, in order, as its first declaration did. */
	replay(declared: ReadonlyArray<Declared>): void {
		for (const d of declared) {
			this.declare(d.kind, d.name, d.declaration)
		}
	}
}
