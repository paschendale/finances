import { cn } from '@/lib/utils';
import { getAccountIconInfo } from '@/lib/account-icons';

const SIZE_MAP = {
  xs: { outer: 16, radius: 4, fontSize: 7, iconSize: 10 },
  sm: { outer: 20, radius: 5, fontSize: 8, iconSize: 12 },
  md: { outer: 28, radius: 7, fontSize: 10, iconSize: 16 },
  lg: { outer: 40, radius: 10, fontSize: 14, iconSize: 22 },
} as const;

type Size = keyof typeof SIZE_MAP;

interface AccountIconProps {
  accountName: string;
  icon?: string | null;
  color?: string | null;
  size?: Size;
  className?: string;
}

const CDN_BASE = 'https://cdn.simpleicons.org';

export function AccountIcon({
  accountName,
  icon,
  color,
  size = 'sm',
  className,
}: AccountIconProps) {
  const { outer, radius, fontSize, iconSize } = SIZE_MAP[size];
  const info = getAccountIconInfo(accountName, icon, color);

  const baseStyle: React.CSSProperties = {
    width: outer,
    height: outer,
    minWidth: outer,
    borderRadius: radius,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  };

  if (info.type === 'institution') {
    const { simpleIconsSlug, color: bgColor, initials } = info.institution;

    if (simpleIconsSlug) {
      // CDN SVG with white logo
      const src = `${CDN_BASE}/${simpleIconsSlug}/ffffff`;
      return (
        <span
          className={cn('shrink-0', className)}
          style={{ ...baseStyle, backgroundColor: bgColor }}
          title={accountName}
        >
          <img
            src={src}
            alt=""
            width={iconSize}
            height={iconSize}
            style={{ width: iconSize, height: iconSize, objectFit: 'contain' }}
          />
        </span>
      );
    }

    // Initials fallback with brand color
    return (
      <span
        className={cn('shrink-0 font-bold tracking-tight text-white', className)}
        style={{ ...baseStyle, backgroundColor: bgColor, fontSize, lineHeight: 1 }}
        title={accountName}
      >
        {initials}
      </span>
    );
  }

  if (info.type === 'lucide') {
    const LucideIcon = info.icon;
    const iconColor = info.color;
    return (
      <span
        className={cn('shrink-0 bg-white/[0.06]', className)}
        style={{ ...baseStyle }}
        title={accountName}
      >
        <LucideIcon
          style={{
            width: iconSize,
            height: iconSize,
            color: iconColor || 'currentColor',
            opacity: iconColor ? 1 : 0.5,
          }}
        />
      </span>
    );
  }

  // Initials fallback
  return (
    <span
      className={cn('shrink-0 font-bold tracking-tight text-white', className)}
      style={{ ...baseStyle, backgroundColor: info.color, fontSize, lineHeight: 1 }}
      title={accountName}
    >
      {info.initials}
    </span>
  );
}
