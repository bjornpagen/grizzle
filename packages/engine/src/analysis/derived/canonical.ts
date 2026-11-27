/**
 * A canonical relation: a closed relational sub-expression a schema's definitions read, named or anonymous, as the
 * installation infers its storage. A relation is a relation whether or not its author named it: every derived
 * relation's definition and every query a definition imports under an empty bind map, at any depth, is one, and its
 * identity is its canonical form, the digest of the rows form of the closed import the checker builds of it
 * (check/index.ts checkClosedImport; ir/dag.ts CanonicalDigests), alpha-equivalent and free of every key a relation
 * claims, so two sub-queries built alike, one named and one not, or neither, are one canonical relation and hold one
 * table where it is stored, and a key added to a relation it reads re-indexes its table and never fills it again. Its
 * definition is that very node, checked once: the relation its readers import is the relation the installation stores.
 * A derived relation's name is the API's alias of its canonical relation. The checker reads an anonymous import as the
 * sub-query it is and a named relation as a relation (analysis/schema.ts CheckedSchema), so no verdict reads where rows
 * live; the lowering reads a stored canonical relation's table wherever its form stands in a program (ir/derived.ts
 * servedDag), and the theory, every upkeep's and the judge's statement, reads one a definition imports by its name, as
 * it reads a named one (analysis/theory/query.ts LiveReading `stored`), never its definition spelled in place.
 */
import type { DerivedDefinition, DerivedSubject } from "#compiler/analysis/derived/analyze.ts"
import type { DerivedHolding } from "#compiler/analysis/derived/storage.ts"
import type { DagDigest } from "#compiler/ir/dag.ts"

/**
 * A canonical relation of a schema (the header), decided once for every name and import that reads it: its form's
 * digest; its subject, whose name is the first derived relation's in level and name order whose definition it is, or
 * its canonical name where no derived relation's is (`canonicalName`); its definition as every reader reads it; where
 * its rows live (analysis/derived/storage.ts DerivedHolding); and the ordinary relations its definition reads at any
 * depth, whose writes in a statement's own transaction keep its table from serving that statement.
 */
export interface CanonicalRelation {
	readonly digest: DagDigest
	/** Its form's root's form shape (ir/derived.ts formShape), by which a reader's node is digested only where it may
	 * be it. */
	readonly shape: string
	readonly subject: DerivedSubject
	readonly definition: DerivedDefinition
	readonly holding: DerivedHolding
	readonly holders: ReadonlyArray<string>
}

/**
 * The name of a canonical relation no derived relation's definition is: its form's digest under a lead no declared name
 * takes, so it names one relation of the schema and no other, a stored one's upkeep and key indexes among its readers.
 */
export const canonicalName = (digest: DagDigest): string => `${canonicalLead}${digest.slice(0, 16)}`

/** The lead of every canonical relation's name (`canonicalName`), which no declared name takes. */
const canonicalLead = "__canonical_"

/** Whether `name` is a canonical relation's (`canonicalName`): what a snapshot records an anonymous one under, beside the
 * declared names of every other relation. */
export const isCanonicalName = (name: string): boolean => name.startsWith(canonicalLead)
