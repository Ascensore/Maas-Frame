import { cn } from '@/lib/utils';

const SIZE = {
  sm: { box: 26, icon: 13, radius: 8 },
  md: { box: 30, icon: 15, radius: 9 },
  lg: { box: 36, icon: 18, radius: 10 },
} as const;

export function BrandMark({
  className,
  size = 'md',
}: {
  className?: string;
  size?: keyof typeof SIZE;
}) {
  const dim = SIZE[size];

  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center bg-[#14161A]', className)}
      style={{ width: dim.box, height: dim.box, borderRadius: dim.radius }}
      aria-hidden
    >
      <svg width={dim.icon} height={dim.icon} viewBox="0 0 16 16" fill="none">
        <path d="M2 12V4l3.4 4L8.8 4v8" stroke="#F4F4F2" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M11.6 4v8" stroke="#C6F24E" strokeWidth="1.7" />
      </svg>
    </span>
  );
}

export function BrandLockup({
  className,
  wordmark = 'OpenFrame',
  subtitle,
  size = 'md',
}: {
  className?: string;
  wordmark?: string;
  subtitle?: string;
  size?: keyof typeof SIZE;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark size={size} />
      <span className="min-w-0">
        <span
          className={cn(
            'block font-extrabold tracking-[-0.02em] text-foreground',
            size === 'lg' ? 'text-lg' : 'text-[13px] leading-tight'
          )}
        >
          {wordmark}
        </span>
        {subtitle ? (
          <span className="block text-[10px] font-medium leading-tight text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}
