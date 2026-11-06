import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	fold,
	Monoid,
	on,
	ordered,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/**
 * Monoid.concat, text's free monoid, as the public types type a fold by it: over an ordered family, a text step and its
 * named (before, after) pair, into a text end. Its combine depends on the members' order, so a counted family, whose
 * order is hidden, is refused it, and so is a fold that hides its pair, since its law reads each member's running
 * value; and its step value is text. Every `@ts-expect-error -- TSnnnn` names the diagnostic the type-test batch
 * requires on its next line.
 */
const text = str.regex("^.*$", "su")

/** An attribute's tokens, in order, each preceded by its separator past the first, their concatenation its value. */
export const Attribute = relation(
	"Attribute",
	{ id: uuid, n: drawn(natural), joined: accumulated(text, ""), k: drawn(natural) },
	["id"]
)
export const Token = relation(
	"Token",
	{
		attribute: uuid,
		at: drawn(natural),
		piece: text,
		width: pg.bigint,
		before: accumulated(text, ""),
		after: accumulated(text, "")
	},
	["attribute", "at"]
)
export const Tag = relation("Tag", { attribute: uuid, piece: text }, ["attribute", "piece"])

export const tokens = ordered(on(Token, "attribute", "at"), fin(Attribute, "n"))
export const tags = counted(on(Tag, "attribute"), fin(Attribute, "k"))

export const joined = fold(
	tokens,
	Monoid.concat,
	on(Token, "attribute", "piece", "before", "after"),
	on(Attribute, "id", "joined")
)

export const Tokens = schema("Tokens", { Attribute, Token, Tag }, [tokens, tags, joined])

/** A counted family's order is hidden: no concat folds it. */
export const countedConcat = fold(
	tags,
	Monoid.concat,
	// @ts-expect-error -- TS2345 refusal: a fold over a counted family combines in a commutative monoid: concat folds an ordered family or a tree
	on(Tag, "attribute", "piece"),
	on(Attribute, "id", "joined")
)

/** A concat fold names its pair: its law reads each member's running value. */
export const hiddenConcat = fold(
	tokens,
	Monoid.concat,
	// @ts-expect-error -- TS2345 refusal: a concat fold names its (before, after) pair after its value: its law reads each member's running value
	on(Token, "attribute", "piece"),
	on(Attribute, "id", "joined")
)

/** concat folds text. */
export const concatOfNumbers = fold(
	tokens,
	Monoid.concat,
	// @ts-expect-error -- TS2345 refusal: the monoid admits the step value's type: sum an exact number, or and twos a set, max an ordered value with a least one, concat a text
	on(Token, "attribute", "width", "before", "after"),
	on(Attribute, "id", "joined")
)
