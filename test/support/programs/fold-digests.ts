/**
 * The names the fold-digests program reads (test/types/schema/fold-digests.ts), its prelude (test/support/prelude.ts):
 * the program imports these alone, each through this module.
 */
export { Crypto } from "#compiler/public/compute.ts"
export {
	accumulated,
	drawn,
	generated,
	int4,
	int8,
	natural,
	sha256
} from "#compiler/public/fields.ts"
export { fin, fold, Monoid, on, ordered, relation, schema } from "#compiler/public/schema.ts"
export { str } from "#compiler/public/text.ts"
