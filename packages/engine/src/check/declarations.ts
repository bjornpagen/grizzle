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
	/**
	 * The journals open on the table (`journaled`), innermost last: the innermost takes every declaration made while it
	 * is open, and every closed import's declarations read inside it (`entered`), each once, in the order of its first.
	 */
	readonly #journals: Array<Set<Declared>> = []

	/** Declares `name` (`#held`), journaled for the innermost journal open, if any. */
	declare(kind: DeclarationKind, name: string, declaration: Declaration): void {
		this.#held(kind, name, declaration)
		this.#journals.at(-1)?.add({ kind, name, declaration })
	}

	/**
	 * Holds `name`'s declaration: its first holds it, an equal one again is nothing, and another text is
	 * DuplicateIdentity at the later declaration, naming the first.
	 */
	#held(kind: DeclarationKind, name: string, declaration: Declaration): void {
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
	}

	/**
	 * `run`'s value, with every declaration made while it ran, in order, an equal one again among them, and those of every
	 * closed import read while it ran (`entered`): what a closed import's check declares (check/checker.ts ClosedImport),
	 * which every query that reads the import declares again (`replay`), as its own check of the import would. A refusal
	 * `run` throws ends the check that owns the table, so the journal it leaves open is never read.
	 */
	journaled<A>(run: () => A): { readonly value: A; readonly declared: ReadonlyArray<Declared> } {
		const journal = new Set<Declared>()
		this.#journals.push(journal)
		const value = run()
		this.#journals.pop()
		return { value, declared: [...journal] }
	}

	/** Holds each of `declared` again, in order, as its first declaration did (`#held`), journaling none (`entered`). */
	replay(declared: ReadonlyArray<Declared>): void {
		for (const d of declared) {
			this.#held(d.kind, d.name, d.declaration)
		}
	}

	/** Journals each of `declared`, a closed import's read inside the innermost journal open, if any, for it. */
	entered(declared: ReadonlyArray<Declared>): void {
		const journal = this.#journals.at(-1)
		if (journal !== undefined) {
			for (const d of declared) {
				journal.add(d)
			}
		}
	}
}
