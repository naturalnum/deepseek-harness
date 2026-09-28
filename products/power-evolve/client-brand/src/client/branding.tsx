import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Mark retained from PowerEvolve Desktop's main branch. */
export const POWER_EVOLVE_MARK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='2' y='2' width='60' height='60' rx='15' fill='%2317191c'/%3E%3Crect x='2.5' y='2.5' width='59' height='59' rx='14.5' fill='none' stroke='white' stroke-opacity='.1'/%3E%3Cpath d='M36.2 10 18 34.5h14.1L28.6 54 46 30.5H32.8L36.2 10Z' fill='%23ffd23f'/%3E%3C/svg%3E")`

/** Use the native DSH brand slots, keeping its sidebar controls and layout. */
export function PowerEvolveBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: size, height: size,
    flex: 'none', background: `${POWER_EVOLVE_MARK} center / contain no-repeat` }} />
}

export function PowerEvolveBrandName() {
  return <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.5px',
    whiteSpace: 'nowrap' }}>PowerEvolve</span>
}

export function PowerEvolveHeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <span aria-hidden="true" className={className} style={{ display: 'inline-block',
    width: size, height: size, background: `${POWER_EVOLVE_MARK} center / contain no-repeat` }} />
}
