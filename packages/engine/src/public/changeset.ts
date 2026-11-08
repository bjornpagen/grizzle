import { canonicalEquals, withoutSourceLocs } from "#compiler/core/canonical.ts"
import { identifierOf, identity, parseDeclaredName } from "#compiler/core/identity.ts"
import { malformed } from "#compiler/schema/protocol.ts"
import type {
	ChangeSetConstructor,
	ChangeSet as ChangeSetOf,
	Law
} from "#compiler/types/changeset/changeset.ts"
import { ChangeSet as changeSets } from "#compiler/write/changeset/value.ts"

/**
 * Public barrel: ChangeSet, Delta, the rows a caller writes (Written, Addition, AdditionIn), outcomes, witnesses, the
 * laws an outcome names and a row check's installed name. packages/grizzle/src/index.ts re-exports it.
 *
 * ChangeSet is the sealed canonical value of packages/engine/src/write/changeset, built under its public signature
 * (types/changeset ChangeSetConstructor): the runtime records the Description and the inputs and holds the builders'
 * brand and the decoder of its read-backs (reads), and the phantoms (params, paramsInvariant, writes and schema as an
 * invariant function) are optional members under core/phantom.ts's key, which no runtime value holds. The value and
 * the type share the name. WriteListOf and RefreshListOf, a role's lists, are the schema barrel's; Compiled and
 * ApplyOutcome, what db.compile and db.apply return, are the shell's (packages/grizzle/src/adapter/public/db.ts).
 */
export const ChangeSet: ChangeSetConstructor = changeSets
export type ChangeSet<
	S,
	Params = unknown,
	Writes extends string = never,
	Reads = unknown
> = ChangeSetOf<S, Params, Writes, Reads>

export type {
	Addition,
	AdditionIn,
	AnyChangeSet,
	Delta,
	DeltaSource,
	InsertableNameOf,
	InsertAllRowsOf,
	KeyHost,
	Law,
	LawSide,
	Member,
	Refused,
	Witness,
	WritableOf,
	Written
} from "#compiler/types/changeset/changeset.ts"

/**
 * sameLaw(a, b): whether two laws, as an `invariant-rejected` outcome or lawsOf names them, are one law of a schema:
 * their descriptions are canonically equal, as the engine compares owned values (core/canonical.ts canonicalEquals),
 * source locations aside. A schema's two laws are described alike exactly when they are one law.
 */
export const sameLaw = (a: Law, b: Law): boolean => canonicalEquals(a, b, withoutSourceLocs)

/**
 * constraintNameOf(law): the name PostgreSQL holds a row check's CHECK constraint under, which a direct SQL writer's
 * refusal by it names (SQLSTATE 23514): the installation's own, minted at the naming door from the check's relation and
 * declared name (core/identity.ts identity.check), the name's segments lowercased and joined by single underscores, so
 * `E1_derived` installs as `e_1_derived`. A law as an `invariant-rejected` outcome or lawsOf names it carries a declared
 * name; a law whose name no check is declared under (parseDeclaredName) throws CompileError, MalformedDescription.
 */
export const constraintNameOf = (law: Extract<Law, { readonly kind: "check" }>): string => {
	const name = parseDeclaredName(law.name)
	if (!name.ok) {
		throw malformed(
			"constraintNameOf",
			`the declared check name ${JSON.stringify(law.name)} as ${name.error}`
		)
	}
	return identifierOf(identity.check(law.relation, name.value))
}
