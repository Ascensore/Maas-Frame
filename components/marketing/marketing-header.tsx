import Link from 'next/link';
import { MoveRight } from 'lucide-react';
import { BrandLockup } from '@/components/brand/brand-mark';
import { seoConfig } from '@/lib/seo';

const controlButtonClass =
  'inline-flex h-9 items-center justify-center rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/85';

interface MarketingHeaderProps {
  isLoggedIn: boolean;
}

export function MarketingHeader({ isLoggedIn }: MarketingHeaderProps) {
  const hostedCtaHref = isLoggedIn ? '/dashboard' : '/register';

  return (
    <header className="border-b border-border bg-sidebar/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center justify-between px-4 sm:h-16 sm:px-6 lg:px-10">
        <Link href="/" className="flex items-center">
          <BrandLockup wordmark="OpenFrame" />
        </Link>

        <nav className="hidden items-center gap-6 text-[13px] font-medium md:flex">
          <Link
            className="text-muted-foreground transition-colors hover:text-foreground"
            href="/#features"
          >
            Features
          </Link>
          <Link
            className="text-muted-foreground transition-colors hover:text-foreground"
            href="/#pricing"
          >
            Pricing
          </Link>
          <a
            className="text-muted-foreground transition-colors hover:text-foreground"
            href={seoConfig.githubUrl}
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </nav>

        <div className="flex items-center gap-3">
          {isLoggedIn ? (
            <Link href="/dashboard" className={controlButtonClass}>
              Dashboard
              <MoveRight className="ml-2 h-3.5 w-3.5" />
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="mr-1 hidden text-[13px] font-medium text-muted-foreground hover:text-foreground sm:block"
              >
                Log in
              </Link>
              <Link href={hostedCtaHref} className={controlButtonClass}>
                Start free trial
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
