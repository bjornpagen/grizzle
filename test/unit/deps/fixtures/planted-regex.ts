/**
 * The runtime probe's negative control (deps.test.ts): it builds and runs RegExps as it loads, the three ways production
 * code could slip one in, each statement on a line of its own, which the probe must attribute to this file and line.
 * The first goes through the global RegExp, never a literal; the third is String.prototype.match, native on purpose.
 */
export const constructed = new RegExp("^x$", "u").test("x")
export const literal = /^y$/u.test("y")

export const matched = "abc".match("b") !== null
