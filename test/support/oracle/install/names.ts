import { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * The oracle installer's identifier claims.
 *
 * The oracle installs what the real installer will install for the same schema, so it takes every identifier from the
 * naming door (core/identity.ts): a declared name by its conversion, and every derived name (a key, a foreign key, a
 * sequence, a CHECK) hashed from its identity. What the oracle predicts on its own is the collision: two names that
 * derive one identifier in one PostgreSQL namespace are an IdentifierCollision naming both source locations. Every
 * identifier is quoted when printed, so reserved words need nothing here.
 *
 * The identifiers claimed in one PostgreSQL namespace, each with the source location that claimed it. A second claim
 * of an identifier is an IdentifierCollision carrying both locations.
 */
export class IdentifierScope {
	readonly #claims = new Map<string, string>()

	readonly label: string

	constructor(label: string) {
		this.label = label
	}

	claim(identifier: string, location: string): Result.Result<string, CompileError> {
		const previous = this.#claims.get(identifier)
		if (previous !== undefined) {
			return Result.err(
				CompileError.make({
					_tag: "IdentifierCollision",
					at: SourceLoc(location, []),
					other: SourceLoc(previous, []),
					identifier,
					what: this.label,
					declaration: location,
					otherDeclaration: previous
				})
			)
		}
		this.#claims.set(identifier, location)
		return Result.ok(identifier)
	}
}
