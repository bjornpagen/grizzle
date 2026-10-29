/**
 * The characters a backslash escapes outside a class, and the ones ArkRegex wants escaped inside one. `/` and `}` are
 * not among them: ArkRegex calls their escapes unnecessary, and reads either alone as the literal.
 */
type SyntaxChar = "^" | "$" | "\\" | "." | "*" | "+" | "?" | "(" | ")" | "[" | "]" | "{" | "|"
type ClassSyntaxChar = "]" | "\\" | "^" | "-"

/** `\t`, `\n`, `\v`, `\f` and `\r`. */
interface ControlEscape {
	t: "\t"
	n: "\n"
	v: "\v"
	f: "\f"
	r: "\r"
}

/** `\cA` to `\cZ`, and in lowercase the same code points. */
interface ControlLetter {
	A: "\u0001"
	B: "\u0002"
	C: "\u0003"
	D: "\u0004"
	E: "\u0005"
	F: "\u0006"
	G: "\u0007"
	H: "\u0008"
	I: "\u0009"
	J: "\u000A"
	K: "\u000B"
	L: "\u000C"
	M: "\u000D"
	N: "\u000E"
	O: "\u000F"
	P: "\u0010"
	Q: "\u0011"
	R: "\u0012"
	S: "\u0013"
	T: "\u0014"
	U: "\u0015"
	V: "\u0016"
	W: "\u0017"
	X: "\u0018"
	Y: "\u0019"
	Z: "\u001A"
}

/** `\xHH`, keyed by the uppercase hex digits. */
interface HexByte {
	"00": "\u0000"
	"01": "\u0001"
	"02": "\u0002"
	"03": "\u0003"
	"04": "\u0004"
	"05": "\u0005"
	"06": "\u0006"
	"07": "\u0007"
	"08": "\u0008"
	"09": "\u0009"
	"0A": "\u000A"
	"0B": "\u000B"
	"0C": "\u000C"
	"0D": "\u000D"
	"0E": "\u000E"
	"0F": "\u000F"
	"10": "\u0010"
	"11": "\u0011"
	"12": "\u0012"
	"13": "\u0013"
	"14": "\u0014"
	"15": "\u0015"
	"16": "\u0016"
	"17": "\u0017"
	"18": "\u0018"
	"19": "\u0019"
	"1A": "\u001A"
	"1B": "\u001B"
	"1C": "\u001C"
	"1D": "\u001D"
	"1E": "\u001E"
	"1F": "\u001F"
	"20": "\u0020"
	"21": "\u0021"
	"22": "\u0022"
	"23": "\u0023"
	"24": "\u0024"
	"25": "\u0025"
	"26": "\u0026"
	"27": "\u0027"
	"28": "\u0028"
	"29": "\u0029"
	"2A": "\u002A"
	"2B": "\u002B"
	"2C": "\u002C"
	"2D": "\u002D"
	"2E": "\u002E"
	"2F": "\u002F"
	"30": "\u0030"
	"31": "\u0031"
	"32": "\u0032"
	"33": "\u0033"
	"34": "\u0034"
	"35": "\u0035"
	"36": "\u0036"
	"37": "\u0037"
	"38": "\u0038"
	"39": "\u0039"
	"3A": "\u003A"
	"3B": "\u003B"
	"3C": "\u003C"
	"3D": "\u003D"
	"3E": "\u003E"
	"3F": "\u003F"
	"40": "\u0040"
	"41": "\u0041"
	"42": "\u0042"
	"43": "\u0043"
	"44": "\u0044"
	"45": "\u0045"
	"46": "\u0046"
	"47": "\u0047"
	"48": "\u0048"
	"49": "\u0049"
	"4A": "\u004A"
	"4B": "\u004B"
	"4C": "\u004C"
	"4D": "\u004D"
	"4E": "\u004E"
	"4F": "\u004F"
	"50": "\u0050"
	"51": "\u0051"
	"52": "\u0052"
	"53": "\u0053"
	"54": "\u0054"
	"55": "\u0055"
	"56": "\u0056"
	"57": "\u0057"
	"58": "\u0058"
	"59": "\u0059"
	"5A": "\u005A"
	"5B": "\u005B"
	"5C": "\u005C"
	"5D": "\u005D"
	"5E": "\u005E"
	"5F": "\u005F"
	"60": "\u0060"
	"61": "\u0061"
	"62": "\u0062"
	"63": "\u0063"
	"64": "\u0064"
	"65": "\u0065"
	"66": "\u0066"
	"67": "\u0067"
	"68": "\u0068"
	"69": "\u0069"
	"6A": "\u006A"
	"6B": "\u006B"
	"6C": "\u006C"
	"6D": "\u006D"
	"6E": "\u006E"
	"6F": "\u006F"
	"70": "\u0070"
	"71": "\u0071"
	"72": "\u0072"
	"73": "\u0073"
	"74": "\u0074"
	"75": "\u0075"
	"76": "\u0076"
	"77": "\u0077"
	"78": "\u0078"
	"79": "\u0079"
	"7A": "\u007A"
	"7B": "\u007B"
	"7C": "\u007C"
	"7D": "\u007D"
	"7E": "\u007E"
	"7F": "\u007F"
	"80": "\u0080"
	"81": "\u0081"
	"82": "\u0082"
	"83": "\u0083"
	"84": "\u0084"
	"85": "\u0085"
	"86": "\u0086"
	"87": "\u0087"
	"88": "\u0088"
	"89": "\u0089"
	"8A": "\u008A"
	"8B": "\u008B"
	"8C": "\u008C"
	"8D": "\u008D"
	"8E": "\u008E"
	"8F": "\u008F"
	"90": "\u0090"
	"91": "\u0091"
	"92": "\u0092"
	"93": "\u0093"
	"94": "\u0094"
	"95": "\u0095"
	"96": "\u0096"
	"97": "\u0097"
	"98": "\u0098"
	"99": "\u0099"
	"9A": "\u009A"
	"9B": "\u009B"
	"9C": "\u009C"
	"9D": "\u009D"
	"9E": "\u009E"
	"9F": "\u009F"
	A0: "\u00A0"
	A1: "\u00A1"
	A2: "\u00A2"
	A3: "\u00A3"
	A4: "\u00A4"
	A5: "\u00A5"
	A6: "\u00A6"
	A7: "\u00A7"
	A8: "\u00A8"
	A9: "\u00A9"
	AA: "\u00AA"
	AB: "\u00AB"
	AC: "\u00AC"
	AD: "\u00AD"
	AE: "\u00AE"
	AF: "\u00AF"
	B0: "\u00B0"
	B1: "\u00B1"
	B2: "\u00B2"
	B3: "\u00B3"
	B4: "\u00B4"
	B5: "\u00B5"
	B6: "\u00B6"
	B7: "\u00B7"
	B8: "\u00B8"
	B9: "\u00B9"
	BA: "\u00BA"
	BB: "\u00BB"
	BC: "\u00BC"
	BD: "\u00BD"
	BE: "\u00BE"
	BF: "\u00BF"
	C0: "\u00C0"
	C1: "\u00C1"
	C2: "\u00C2"
	C3: "\u00C3"
	C4: "\u00C4"
	C5: "\u00C5"
	C6: "\u00C6"
	C7: "\u00C7"
	C8: "\u00C8"
	C9: "\u00C9"
	CA: "\u00CA"
	CB: "\u00CB"
	CC: "\u00CC"
	CD: "\u00CD"
	CE: "\u00CE"
	CF: "\u00CF"
	D0: "\u00D0"
	D1: "\u00D1"
	D2: "\u00D2"
	D3: "\u00D3"
	D4: "\u00D4"
	D5: "\u00D5"
	D6: "\u00D6"
	D7: "\u00D7"
	D8: "\u00D8"
	D9: "\u00D9"
	DA: "\u00DA"
	DB: "\u00DB"
	DC: "\u00DC"
	DD: "\u00DD"
	DE: "\u00DE"
	DF: "\u00DF"
	E0: "\u00E0"
	E1: "\u00E1"
	E2: "\u00E2"
	E3: "\u00E3"
	E4: "\u00E4"
	E5: "\u00E5"
	E6: "\u00E6"
	E7: "\u00E7"
	E8: "\u00E8"
	E9: "\u00E9"
	EA: "\u00EA"
	EB: "\u00EB"
	EC: "\u00EC"
	ED: "\u00ED"
	EE: "\u00EE"
	EF: "\u00EF"
	F0: "\u00F0"
	F1: "\u00F1"
	F2: "\u00F2"
	F3: "\u00F3"
	F4: "\u00F4"
	F5: "\u00F5"
	F6: "\u00F6"
	F7: "\u00F7"
	F8: "\u00F8"
	F9: "\u00F9"
	FA: "\u00FA"
	FB: "\u00FB"
	FC: "\u00FC"
	FD: "\u00FD"
	FE: "\u00FE"
	FF: "\u00FF"
}

/** A literal code point, re-escaped for where it lands. */
type Literal<C extends string, Classed extends boolean> = Classed extends true
	? C extends ClassSyntaxChar
		? `\\${C}`
		: C
	: C extends SyntaxChar
		? `\\${C}`
		: C

/** What follows `\u`: four hex digits, or a braced code point. A surrogate pair is two such escapes. */
type SkipUnicode<R extends string> = R extends `{${string}}${infer Rest}`
	? Rest
	: R extends `${string}${string}${string}${string}${infer Rest}`
		? Rest
		: R

/**
 * The rewritten literal escape `\` E, with R what follows E: the replacement, what remains, and whether to widen; or
 * never when the escape is not a literal escape this scan rewrites, which then passes through unchanged.
 */
type LiteralEscape<
	E extends string,
	R extends string,
	Classed extends boolean
> = E extends keyof ControlEscape
	? [ControlEscape[E], R, false]
	: E extends "/"
		? ["/", R, false]
		: E extends "c"
			? R extends `${infer L}${infer Rest}`
				? Uppercase<L> extends keyof ControlLetter
					? [Literal<ControlLetter[Uppercase<L>], Classed>, Rest, false]
					: never
				: never
			: E extends "x"
				? R extends `${infer H1}${infer H2}${infer Rest}`
					? Uppercase<`${H1}${H2}`> extends keyof HexByte
						? [Literal<HexByte[Uppercase<`${H1}${H2}`>], Classed>, Rest, false]
						: never
					: never
				: E extends "u"
					? ["_", SkipUnicode<R>, true]
					: Classed extends true
						? E extends "b"
							? ["\b", R, false]
							: never
						: never

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
type QuantifierChar = "*" | "+" | "?" | "{"

/**
 * The scan's state is held in unions of flag names, which TypeScript evaluates eagerly, so a long source does not
 * build a chain of deferred object types.
 *
 * Facts (F), about the whole source and the current position:
 * - "atArm": the current top-level alternative has just begun; "lastEnd": the last thing read was a `$` closing it;
 * - "widen": a construct already forces the inference to widen;
 * - "digit": a digit construct; "stringy": a member ArkRegex infers as string (dot, `\D`, `\w`, `\W`, a negated or
 *   wide class); "openEdge": a top-level alternative not anchored at both ends. These decide at the end whether
 *   ArkRegex's `${number}` shortcut can lose members.
 */
type Fact = "atArm" | "lastEnd" | "widen" | "digit" | "stringy" | "openEdge"
/**
 * An open group (Depth holds one per group): "digit" if it holds a digit construct, "alt" if it has an alternation of
 * its own; "group" always, so that no group is the empty union.
 */
type GroupFlag = "group" | "digit" | "alt"
/**
 * The open class (K), or "none": "open" always; "negated"; "digit", a digit construct (`\d` or a range between
 * digits); "wide", a member ArkRegex infers as string (a range between other characters, `\D`, `\w`, `\W`); "other",
 * any member besides a digit construct; "started", a member has been read; "prevDigit", the last member read was a
 * digit, which `-` and a digit make a range.
 */
type ClassFlag = "open" | "negated" | "digit" | "wide" | "other" | "started" | "prevDigit"

type Has<Flags extends string, Flag extends string> = Flag extends Flags ? true : false

/** The innermost open group with a flag added; at top level, unchanged. */
type MarkGroup<
	Depth extends ReadonlyArray<GroupFlag>,
	Flag extends GroupFlag
> = Depth extends readonly [
	...infer Outer extends ReadonlyArray<GroupFlag>,
	infer Inner extends GroupFlag
]
	? [...Outer, Inner | Flag]
	: Depth

/**
 * A class member read: a digit, a `-` that makes a range (between digits or not), a literal `-`, or anything else. R
 * is what follows the member.
 */
type ReadMember<K extends ClassFlag, Lit extends string, R extends string> = Lit extends Digit
	? K | "started" | "prevDigit"
	: Lit extends "-"
		? "started" extends K
			? R extends "" | `]${string}`
				? Exclude<K, "prevDigit"> | "other"
				: "prevDigit" extends K
					? R extends `${Digit}${string}`
						? Exclude<K, "prevDigit"> | "digit"
						: Exclude<K, "prevDigit"> | "wide" | "other"
					: Exclude<K, "prevDigit"> | "wide" | "other"
			: Exclude<K, "prevDigit"> | "other" | "started"
		: Exclude<K, "prevDigit"> | "other" | "started"

/** The scan: [rewritten source, widen], or "too long". Out is the rewritten source so far. */
type Scan<
	S extends string,
	Out extends string,
	K extends ClassFlag | "none",
	Depth extends ReadonlyArray<GroupFlag>,
	F extends Fact,
	Spent extends ReadonlyArray<0>
> = Spent["length"] extends 40
	? S extends ""
		? [Out, Widened<"lastEnd" extends F ? F : F | "openEdge">]
		: "too long"
	: S extends `${infer C}${infer R}`
		? [K] extends [ClassFlag]
			? InClass<C, R, Out, K, Depth, F, [...Spent, 0]>
			: "atArm" extends F
				? C extends "^"
					? Outside<C, R, Out, Depth, F, [...Spent, 0]>
					: Outside<C, R, Out, Depth, Exclude<F, "atArm"> | "openEdge", [...Spent, 0]>
				: Outside<C, R, Out, Depth, F, [...Spent, 0]>
		: [Out, Widened<"lastEnd" extends F ? F : F | "openEdge">]

/** Whether the inference widens, from the facts at the end of the source. */
type Widened<F extends Fact> = "widen" extends F
	? true
	: "digit" extends F
		? Has<F, "openEdge" | "stringy">
		: false

/**
 * One step of the scan outside a class. ArkRegex calls `\}` an unnecessary escape; a lone `}` is the same literal to
 * it. `[]` matches nothing and ArkRegex refuses it, so it reads any code point and the inference widens.
 */
type Outside<
	C extends string,
	R extends string,
	Out extends string,
	Depth extends ReadonlyArray<GroupFlag>,
	F extends Fact,
	Spent extends ReadonlyArray<0>
> = C extends "\\"
	? R extends `${infer E}${infer R2}`
		? E extends "d"
			? Scan<
					R2,
					`${Out}\\d`,
					"none",
					MarkGroup<Depth, "digit">,
					Exclude<F, "lastEnd"> | "digit",
					Spent
				>
			: E extends "D" | "w" | "W"
				? Scan<R2, `${Out}\\${E}`, "none", Depth, Exclude<F, "lastEnd"> | "stringy", Spent>
				: E extends "}"
					? Scan<R2, `${Out}}`, "none", Depth, Exclude<F, "lastEnd">, Spent>
					: LiteralEscape<E, R2, false> extends infer Rewritten
						? [Rewritten] extends [never]
							? Scan<R2, `${Out}\\${E}`, "none", Depth, Exclude<F, "lastEnd">, Spent>
							: Rewritten extends [
										infer Lit extends string,
										infer Rest extends string,
										infer W extends boolean
								  ]
								? Scan<
										Rest,
										`${Out}${Lit}`,
										"none",
										Depth,
										Exclude<F, "lastEnd"> | (W extends true ? "widen" : never),
										Spent
									>
								: never
						: never
		: [`${Out}\\`, Has<F, "widen">]
	: C extends "["
		? R extends `]${infer R2}`
			? Scan<R2, `${Out}[^]`, "none", Depth, Exclude<F, "lastEnd"> | "widen", Spent>
			: R extends `^${infer R2}`
				? Scan<R2, `${Out}[^`, "open" | "negated", Depth, Exclude<F, "lastEnd"> | "stringy", Spent>
				: Scan<R, `${Out}[`, "open", Depth, Exclude<F, "lastEnd">, Spent>
		: C extends "("
			? Scan<R, `${Out}(`, "none", [...Depth, "group"], Exclude<F, "lastEnd">, Spent>
			: C extends ")"
				? Depth extends readonly [
						...infer Outer extends ReadonlyArray<GroupFlag>,
						infer Inner extends GroupFlag
					]
					? Scan<
							R,
							`${Out})`,
							"none",
							MarkGroup<Outer, Extract<Inner, "digit">>,
							/**
							 * A group holding a digit construct is a union that may hold `${number}` with other members
							 * when it has an alternation or a quantifier applies to it.
							 */
							| Exclude<F, "lastEnd">
							| ("digit" extends Inner
									? "alt" extends Inner
										? "widen"
										: R extends `${QuantifierChar}${string}`
											? "widen"
											: never
									: never),
							Spent
						>
					: Scan<R, `${Out})`, "none", Depth, Exclude<F, "lastEnd">, Spent>
				: C extends "|"
					? Depth extends readonly []
						? Scan<
								R,
								`${Out}|`,
								"none",
								Depth,
								Exclude<F, "lastEnd"> | "atArm" | ("lastEnd" extends F ? never : "openEdge"),
								Spent
							>
						: Scan<R, `${Out}|`, "none", MarkGroup<Depth, "alt">, Exclude<F, "lastEnd">, Spent>
					: C extends "^"
						? Depth extends readonly []
							? "atArm" extends F
								? Scan<R, `${Out}^`, "none", Depth, Exclude<F, "atArm" | "lastEnd">, Spent>
								: Scan<R, `${Out}(?:)`, "none", Depth, Exclude<F, "lastEnd"> | "widen", Spent>
							: Scan<R, `${Out}(?:)`, "none", Depth, Exclude<F, "lastEnd"> | "widen", Spent>
						: C extends "$"
							? Depth extends readonly []
								? R extends "" | `|${string}`
									? Scan<R, `${Out}$`, "none", Depth, F | "lastEnd", Spent>
									: Scan<R, `${Out}(?:)`, "none", Depth, Exclude<F, "lastEnd"> | "widen", Spent>
								: Scan<R, `${Out}(?:)`, "none", Depth, Exclude<F, "lastEnd"> | "widen", Spent>
							: C extends "."
								? Scan<R, `${Out}.`, "none", Depth, Exclude<F, "lastEnd"> | "stringy", Spent>
								: Scan<R, `${Out}${C}`, "none", Depth, Exclude<F, "lastEnd">, Spent>

type InClass<
	C extends string,
	R extends string,
	Out extends string,
	K extends ClassFlag,
	Depth extends ReadonlyArray<GroupFlag>,
	F extends Fact,
	Spent extends ReadonlyArray<0>
> = C extends "]"
	? "negated" extends K
		? Scan<R, `${Out}]`, "none", Depth, Exclude<F, "lastEnd">, Spent>
		: Scan<
				R,
				`${Out}]`,
				"none",
				MarkGroup<Depth, "digit" extends K ? "digit" : never>,
				/**
				 * A class holding a digit construct and another member is a union holding `${number}`; a wide class is
				 * inferred as string.
				 */
				| Exclude<F, "lastEnd">
				| ("digit" extends K ? "digit" | ("other" extends K ? "widen" : never) : never)
				| ("wide" extends K ? "stringy" : never),
				Spent
			>
	: C extends "\\"
		? R extends `${infer E}${infer R2}`
			? E extends "d"
				? Scan<R2, `${Out}\\d`, Exclude<K, "prevDigit"> | "digit" | "started", Depth, F, Spent>
				: E extends "D" | "w" | "W"
					? Scan<
							R2,
							`${Out}\\${E}`,
							Exclude<K, "prevDigit"> | "wide" | "other" | "started",
							Depth,
							F,
							Spent
						>
					: LiteralEscape<E, R2, true> extends infer Rewritten
						? [Rewritten] extends [never]
							? Scan<R2, `${Out}\\${E}`, ReadMember<K, "\\", R2>, Depth, F, Spent>
							: Rewritten extends [
										infer Lit extends string,
										infer Rest extends string,
										infer W extends boolean
								  ]
								? Scan<
										Rest,
										`${Out}${Lit}`,
										ReadMember<K, Lit, Rest>,
										Depth,
										F | (W extends true ? "widen" : never),
										Spent
									>
								: never
						: never
			: [`${Out}\\`, Has<F, "widen">]
		: Scan<R, `${Out}${C}`, ReadMember<K, C, R>, Depth, F, Spent>

/**
 * The typed source of a str.regex pattern, rewritten for ArkRegex.
 *
 * ArkRegex 0.0.13 expects a JavaScript string's own escapes for control characters: its validate refuses the pattern
 * spellings `\t`, `\n`, `\v`, `\f`, `\r`, `\cX`, `\xHH`, `\uHHHH`, `\u{H...}` and `\/`, all of which the admitted
 * grammar accepts, and typed authoring must accept the admitted grammar from a literal source.
 * Its inference is also unsound on shapes the compiler admits, where every accepted value must lie in the inferred
 * type:
 *
 * - `[\b]` infers "" rather than U+0008;
 * - an anchor away from the edges of a top-level alternative infers never: `$^` admits "" and `^(?:a$)?b` admits "b";
 * - its quantifier and concatenation shortcuts collapse any union that holds `${number}` to `${number}` alone
 *   (quantify.d.ts tryFastPath tests `${number} extends pattern`): `^[\d_]{1,3}$` admits "_1", `^(?:\d?){2}$` admits
 *   "", yet both infer `${number}`;
 * - it writes adjacent placeholders, the first of which TypeScript makes match exactly one code point: `^a+` infers
 *   `a${string}${string}` yet admits "a". RegexInfer (text/field.ts) writes every run of them as one, so the scan
 *   leaves them be.
 *
 * `RewriteSource` scans the source once, tail-recursively, and rewrites it into a pattern ArkRegex reads as the same
 * language: every admitted literal escape whose code point is known becomes that literal, re-escaped where it would
 * otherwise be syntax. Where the rewritten source cannot carry the language soundly into the inference, the scan sets
 * the widen flag and the inferred host type is `string`, which is always sound:
 *
 * - a `\u` escape, whose code point the type system cannot compute; a placeholder literal keeps the source well formed
 *   for validation;
 * - a `^` that does not open a top-level alternative, or a `$` that does not close one; ArkRegex refuses some of these
 *   as mid-pattern, so the rewrite reads each as an empty group;
 * - a union that can hold `${number}` with other members: a class holding a digit construct (`\d` or a range between
 *   digits) with any other member, and a group holding a digit construct that is quantified or has an alternation;
 * - a digit construct in a source that also has a member ArkRegex infers as string (dot, `\D`, `\w`, `\W`, a negated
 *   class, a range between non-digits) or a top-level alternative not anchored at both ends: ArkRegex then
 *   concatenates `${number}` with a supertype, which collapses to `${number}` (`\d` alone infers `${number}` yet
 *   admits "a1");
 * - `[]`, which ArkRegex refuses; it reads `[^]` instead;
 * - a source longer than ArkRegex can parse at a call site, which is too long to infer;
 *   ArkRegex does not validate it either, and the compiler's grammar check decides its admission.
 *
 * Validation is ArkRegex's own check on the rewritten source, and what it refuses there is a type error at the call
 * site. The rewrite changes only literal spellings and placeholders, so it never makes a malformed pattern well formed
 * except where a placeholder hides a bad code point (a NUL, a reversed range); the compiler's grammar check, not the
 * type, decides admission.
 *
 * The rewritten source: [rewritten source, widen], or "too long".
 */
export type RewriteSource<S extends string> = Scan<S, "", "none", [], "atArm", []>
