import type { IconProps } from './icons/props.ts'

/**
 * Render a solid lightning mark in the surrounding text color.
 * @param props - Requested icon size and optional layout class.
 * @returns Decorative vector lightning artwork.
 */
export const LightningMark = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M13.5 1.5 4 13h6.5l-1 9.5L20 10h-7l.5-8.5Z" />
  </svg>
)
