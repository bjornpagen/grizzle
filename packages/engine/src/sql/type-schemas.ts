/**
 * The schemas a type is named in, as the installer names them, its door of TypeSchema (the drift check's scratch
 * schemas are its own): an installation's own, the vector extension's, and none, the one an identity reads a definition
 * in (digestedHooks).
 */

import { nominal } from "#compiler/core/brand.ts"
import { type Identity, identifierOf } from "#compiler/core/identity.ts"
import type { TypeSchema } from "#compiler/sql/ast.ts"
import { type AstHooks, identityHooks } from "#compiler/sql/transform.ts"

const typeSchema = nominal<string, TypeSchema>()

/**
 * The schema of the types an installation holds, its domains, by its installed identifier: what grizzle's bookkeeping
 * tables, which know their schema by it, type a digest column in (deploy/ledger/ledger.ts digestColumn).
 */
export const installedTypes = (schema: string): TypeSchema => typeSchema(schema)

/** The schema of the types an installation holds, its domains: its own, by its identity. */
export const installationTypes = (installation: Identity<"schema">): TypeSchema =>
	installedTypes(identifierOf(installation))

/** The schema of the vector extension's types, the one the installation was given for the extension. */
export const vectorTypes = (schema: string): TypeSchema => typeSchema(schema)

/** No schema: the one a definition is read under to be digested, so its digest names it in every installation
 * (digestedHooks; physical/ddl/domains.ts paramDomainIdentity, defined in it outright). */
export const digestedTypes: TypeSchema = typeSchema("")

/**
 * A definition read in no schema, as its identity digests it: each function and type in one of `installed`, the
 * installation's schemas (ir/physical.ts PhysicalNames installed), in none (digestedTypes), and a name in any other
 * schema, pg_catalog's or an extension's, which is the environment's, as it stands. So one definition digests alike in
 * every installation, whatever its schemas are named, as a constant's content does: a fresh install of a migrated
 * history under another name names its objects as the history did. It is the one way a definition built over the
 * installation's names is read for its identity: a contract's domain's (physical/ddl/domains.ts contractDigest) and a
 * row function's (physical/ddl/row-functions.ts identified). A parameter's pattern domain is defined in no schema
 * outright (physical/ddl/domains.ts paramDomainIdentity), since its identity is minted before any installation's
 * names.
 */
export const digestedHooks = (installed: ReadonlySet<string>): AstHooks => ({
	...identityHooks,
	functionRef: (f) => (installed.has(f.schema) ? { ...f, schema: digestedTypes } : f),
	typeRef: (t) =>
		t.kind === "named" && installed.has(t.schema) ? { ...t, schema: digestedTypes } : t
})
