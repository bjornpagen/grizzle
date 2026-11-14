/**
 * The names the decoder agreement's generated program reads (test/types/api/decoder.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export { roleNameOf } from "#index.ts"
export type { AnyLogin, DecoderLogin, NoDecoder, ServedLogin } from "#index.ts"
export {
	Bare,
	Clocked,
	Defers,
	Keys,
	Mixed,
	Pages,
	Reads,
	Writes,
	WritesTwice
} from "#test/support/agreement/decoder-logins.ts"
