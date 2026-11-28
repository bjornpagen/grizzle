/**
 * The names the decoder agreement's generated program reads (test/types/api/decoder.ts), its prelude
 * (test/support/prelude.ts): the program imports these alone, each through this module.
 */
export { roleNameOf } from "#adapter/served/served.ts"
export type { AnyLogin } from "#index.ts"
export type { DecoderLogin, LiveOf, NoDecoder, ServedLogin } from "#adapter/types/layer.ts"
export {
	Answered,
	AnsweredBeside,
	AnsweredKeys,
	AnsweredPages,
	Bare,
	Clocked,
	Keys,
	Mixed,
	Pages,
	Reads,
	Writes,
	WritesTwice
} from "#test/support/agreement/decoder-logins.ts"
