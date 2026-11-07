/**
 * The expected catalog: what admission and drift compare a live database against — the manifest, the roles and grants a
 * snapshot expects, the catalog reads, and the names the installation gives its objects.
 */
export { type ManifestStatement, manifestStatements } from "#compiler/deploy/admission/manifest.ts"
export {
	databaseSettings,
	type DefaultGrant,
	type DefaultPrivilegesExpectation,
	defaultPrivilegesExpectations,
	type ExpectedPolicy,
	judgedSchemas,
	manifestRoles,
	privilegeFamilies,
	type PrivilegeFamily,
	privilegeFamilyNames,
	roleExpectation,
	type RoleExpectation
} from "#compiler/deploy/admission/roles.ts"
export { snapshotMismatch } from "#compiler/deploy/admission/target.ts"
export { structuralRegex } from "#compiler/physical/ddl/domains.ts"
export {
	fittedLogin,
	type InstallNames,
	loginIdentity,
	missing
} from "#compiler/physical/ddl/names.ts"
export { loginStartupOptions } from "#compiler/physical/ddl/roles.ts"
export { refreshStatement } from "#compiler/physical/derived/objects.ts"
export { vectorExpectations } from "#compiler/physical/vector/admission.ts"
export { vectorExtension } from "#compiler/physical/vector/storage.ts"
export { admitSchemaDesc } from "#compiler/schema/admit.ts"
export * as C from "#compiler/sql/catalog.ts"
export { emptyNameMap, isDecimal } from "#compiler/sql/naming.ts"
export {
	type AstHooks,
	identityHooks,
	transformCreateIndex,
	transformStatement
} from "#compiler/sql/transform.ts"
