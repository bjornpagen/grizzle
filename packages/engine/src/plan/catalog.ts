/**
 * The expected catalog: what admission and drift compare a live database against — the roles and grants a snapshot
 * expects, the catalog reads, and the names the installation gives its objects. The manifest it records is
 * plan/migration.ts's, which a login's runtime never loads.
 */
export {
	databaseSettings,
	type DefaultGrant,
	type DefaultPrivilegesExpectation,
	defaultPrivilegesExpectations,
	type ExpectedPolicy,
	installedExpectation,
	judgedSchemas,
	manifestRoles,
	privilegeFamilies,
	type PrivilegeFamily,
	privilegeFamilyNames,
	roleExpectation,
	type RoleExpectation
} from "#compiler/deploy/admission/roles.ts"
export { missing } from "#compiler/ir/physical.ts"
export { paramDomainsOf, structuralRegex } from "#compiler/physical/ddl/domains.ts"
export type { InstallNames } from "#compiler/physical/ddl/names.ts"
export { loginStartupOptions } from "#compiler/physical/ddl/roles.ts"
export { refreshStatement } from "#compiler/physical/derived/objects.ts"
export { vectorExtension } from "#compiler/physical/vector/storage.ts"
export { admitSchemaDesc } from "#compiler/schema/admit.ts"
export * as C from "#compiler/sql/catalog.ts"
export { databasePrivilegeLock, type UninstallStatement } from "#compiler/sql/catalog.ts"
export { isDecimal } from "#compiler/core/text.ts"
export { emptyNameMap } from "#compiler/sql/naming.ts"
export {
	type AstHooks,
	identityHooks,
	transformCreateIndex,
	transformStatement
} from "#compiler/sql/transform.ts"
