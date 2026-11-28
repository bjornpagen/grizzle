/**
 * The names the term-is-no-field program reads (test/types/api/fields.ts), its prelude (test/support/prelude.ts): the
 * program imports these alone, each through this module, each public reader through the package's root, as a caller
 * imports it.
 */
export {
	accumulated,
	domain,
	generated,
	int8,
	lexical,
	lexicalForm,
	Logic,
	relation,
	Type,
	uuid
} from "#index.ts"
export { codecText } from "@bjornpagen/grizzle/compile"
export { Id } from "#test/support/ids.ts"
