'use client';

import Link from 'next/link';
import { trackCtaClick } from '@/lib/client/track';

interface CtaLinkProps {
  href: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * A marketing call to action that reports the click.
 *
 * Only the signup CTA counts. The same button reads "Start free trial" and
 * points at `/dashboard` once you are signed in, and an existing customer
 * clicking through to their own dashboard is not a step in the acquisition
 * funnel.
 */
export function CtaLink({ href, className, children }: CtaLinkProps) {
  return (
    <Link
      href={href}
      className={className}
      onClick={href === '/register' ? trackCtaClick : undefined}
    >
      {children}
    </Link>
  );
}
