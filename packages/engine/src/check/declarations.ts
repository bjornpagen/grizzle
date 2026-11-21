import { failWith } from "#compiler/check/fail.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"

/** What a query declares once by name (DuplicateIdentity): a contract a descriptor it carries states, a context it matches. */
type DeclarationKind = "contract" | "context"

/** A name's declaration: its descriptor's canonical text, and where it stands. */
interface Declaration {
	readonly text: string
	readonly loc: SourceLoc
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
	}
}
