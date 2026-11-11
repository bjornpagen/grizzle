import Image from "next/image"
import type { ImageProps } from "next/image"
export const Photo = () => <Image src="/a.png" alt="a" width={1} height={1} unoptimized /> // violation
export const props = { src: "/a.png", alt: "a", unoptimized: true } satisfies ImageProps // violation
export const Raw = () => <img src="/a.png" alt="a" />
export const settings = { unoptimized: true }
