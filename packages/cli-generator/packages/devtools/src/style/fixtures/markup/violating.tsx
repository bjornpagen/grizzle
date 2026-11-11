import { coverMotion } from "#style/fixtures/support/motion.ts"

const Tag = "section"

const box = { width: 10, height: 10 }

const localMotion = { transform: "none" }

export const inlineStyle = <div style={{ color: "red" }} /> // violation
export const injected = <div dangerouslySetInnerHTML={{ __html: "x" }} /> // violation
export const clickable = <div onClick={() => undefined} /> // violation
export const rawButton = <button type="button" /> // violation
export const handwritten = <svg viewBox="0 0 1 1" /> // violation
export const sheet = <style>{"a{}"}</style> // violation
export const selected = <Tag /> // violation
export const composed = <section className="flex" onClick={() => undefined} />

export function build(element: HTMLElement, documentRef: Document, cache: Map<string, string>) {
	const created = documentRef.createElement("div") // violation
	element.innerHTML = "x" // violation
	documentRef.write("x") // violation
	element.style.color = "red" // violation
	const escaped = element.style // violation
	element.setAttribute("style", "color: red") // violation
	element.setAttribute("aria-label", "x")
	Object.defineProperty(element, "innerHTML", { value: "x" }) // violation
	cache.set("key", "value")
	const parser = new DOMParser() // violation
	const constructed = new CSSStyleSheet() // violation
	constructed.replaceSync("a{}") // violation
	const html = `<p>${created.id}</p>` // violation
	const sentence = `${created.id} < 3 and 4 > 2`
	const { innerHTML } = element // violation
	return { created, escaped, parser, constructed, html, sentence, innerHTML }
}

export const props = { style: { color: "red" } } // violation

export function MeasuredFixture({ share, other }: Readonly<{ share: number; other: number }>) {
	return (
		<section>
			<div style={{ width: box.height }} /> {/* // violation */}
			<div style={{ height: box.width }} /> {/* // violation */}
			<div style={{ width: `${other}%` }} /> {/* // violation */}
			<div style={{ width: `${share}px` }} /> {/* // violation */}
			<div style={{ transform: localMotion.transform }} /> {/* // violation */}
			<div style={{ width: box.width, color: "red" }} /> {/* // violation */}
			<div style={{ ...coverMotion }} /> {/* // violation */}
			<div style={{}} /> {/* // violation */}
		</section>
	)
}

export function mergeSurfaceProps(
	baseProps: Readonly<{ style: object }>,
	props: Readonly<{ style: object }>
) {
	return { style: { ...props.style, ...baseProps.style } } // violation
}

export function mergeOtherProps(
	baseProps: Readonly<{ style: object }>,
	props: Readonly<{ style: object }>
) {
	return { style: { ...baseProps.style, ...props.style } } // violation
}
