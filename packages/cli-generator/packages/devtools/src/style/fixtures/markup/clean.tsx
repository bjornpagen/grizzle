import localFont from "next/font/local"
import { coverMotion } from "#style/fixtures/support/motion.ts"

const box = { width: 10 }

const inter = localFont({
	src: [{ path: "./inter.woff2", style: "normal" }],
	variable: "--font-inter"
})

export function MeasuredFixture({ share }: Readonly<{ share: number }>) {
	return (
		<div style={{ width: box.width, transform: coverMotion.transform }}>
			<span className={inter.variable} />
			<span style={{ width: `${share}%` }} />
		</div>
	)
}

export function mergeSurfaceProps(
	baseProps: Readonly<{ style: object }>,
	props: Readonly<{ style: object }>
) {
	return { style: { ...baseProps.style, ...props.style } }
}

export const bootstrap = (sheet: CSSStyleSheet) => {
	const constructed = new CSSStyleSheet()
	constructed.replaceSync("a{}")
	return [sheet, constructed]
}

export const tag = (id: string) => `<script src="${id}"></script>`
