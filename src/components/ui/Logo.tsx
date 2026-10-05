/**
 * open-autoDM logo - four pastel quadrants with an ink chat bubble at the
 * centre. Used in the sidebar, login page, and favicon.
 */

import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('w-8 h-8', className)} fill="none" aria-label="open-autoDM logo">
      <rect x="2" y="2" width="30" height="30" fill="var(--sage)" />
      <rect x="32" y="2" width="30" height="30" fill="var(--lilac)" />
      <rect x="2" y="32" width="30" height="30" fill="var(--mist)" />
      <rect x="32" y="32" width="30" height="30" fill="var(--peach)" />
      <rect x="2" y="2" width="60" height="60" rx="3" stroke="var(--foreground)" strokeWidth="3" />
      <path
        d="M20 21h24a3 3 0 0 1 3 3v13a3 3 0 0 1-3 3H31l-7 6v-6h-4a3 3 0 0 1-3-3V24a3 3 0 0 1 3-3Z"
        fill="var(--card)"
        stroke="var(--foreground)"
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LogoWordmark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('font-heading font-extrabold tracking-tight', className)}>
      {compact ? 'autoDM' : 'open-autoDM'}
    </span>
  );
}
