import Link from 'next/link';
import { BrandLockup } from '@/components/brand/brand-mark';
import { SetPasswordForm } from './set-password-form';
import { Suspense } from 'react';

export default function SetPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-8 flex items-center justify-center">
          <BrandLockup size="lg" wordmark="OpenFrame" />
        </Link>
        <Suspense>
          <SetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
