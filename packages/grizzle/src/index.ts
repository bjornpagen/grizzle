/**
 * @bjornpagen/grizzle, read as g: the authoring entry, what a schema, its logins and its workloads are written with,
 * and the configuration that names them (defineConfig, and CredentialError, which a connection's password Effect fails
 * with). It loads the description builders alone, no compiler, installer or runtime: a schema module and a
 * grizzle.config.ts evaluate their declarations and nothing else: .fallowrc.json's dsl-* zones hold every module it
 * loads to that, and test/unit/entry/dsl.test.ts holds a program over it to them. What compiles or runs a schema is
 * another entry's: the served workload, its layer, a Db and every runtime error are @bjornpagen/grizzle/runtime's; the
 * compiles an application's tests read on the host (lawsOf, rowEvaluator, insertPreview, compileServed and their kin)
 * are @bjornpagen/grizzle/compile's.
 */
export * from "#adapter/public/config.ts"
export { CredentialError } from "#adapter/errors/credential.ts"
export * from "@bjornpagen/grizzle-engine"
