import {
  Utensils, Car, Heart, Home, Plane, Shirt, CreditCard, Wine, Receipt,
  Users, Activity, Sparkles, Gift, Briefcase, Smartphone, Pencil, Palette,
  Landmark, Trophy, AlertTriangle, Zap, User, Cake, Banknote, CircleSlash,
  Building2, Star, Gamepad2, BookOpen, Dumbbell, TrendingUp, Tag, Wallet,
  Building, type LucideIcon,
} from 'lucide-react';

// ── Institution (bank/fintech) icons ───────────────────────────────────────
// Uses Simple Icons CDN: https://cdn.simpleicons.org/{slug}/white
// slug must match exactly what Simple Icons uses; listed below per brand.

export interface InstitutionIcon {
  /** Simple Icons slug for CDN lookup, or null */
  simpleIconsSlug: string | null;
  /** Path to local badge image in /public/icons/ (full styled badge, no bg needed) */
  localBadge: string | null;
  /** Brand background color */
  color: string;
  /** 1-3 uppercase chars shown as last fallback */
  initials: string;
}

export const INSTITUTION_ICONS: Record<string, InstitutionIcon> = {
  nubank:        { simpleIconsSlug: 'nubank',       localBadge: null,                    color: '#820AD1', initials: 'Nu'  },
  itau:          { simpleIconsSlug: null,            localBadge: '/icons/itau.png',       color: '#EC7000', initials: 'It'  },
  wise:          { simpleIconsSlug: 'wise',          localBadge: null,                    color: '#163300', initials: 'Wi'  },
  bancodobrasil: { simpleIconsSlug: 'bancodobrasil', localBadge: null,                    color: '#FFCC00', initials: 'BB'  },
  inter:         { simpleIconsSlug: null,            localBadge: '/icons/inter.png',      color: '#FF7A00', initials: 'In'  },
  picpay:        { simpleIconsSlug: 'picpay',        localBadge: null,                    color: '#11C76F', initials: 'PP'  },
  binance:       { simpleIconsSlug: 'binance',       localBadge: null,                    color: '#F0B90B', initials: 'Bi'  },
  xp:            { simpleIconsSlug: null,            localBadge: null,                    color: '#000000', initials: 'XP'  },
  rico:          { simpleIconsSlug: null,            localBadge: '/icons/rico.png',       color: '#00C65E', initials: 'Ri'  },
  brb:           { simpleIconsSlug: null,            localBadge: '/icons/brb.png',        color: '#004B8D', initials: 'BRB' },
  infinitepay:   { simpleIconsSlug: null,            localBadge: '/icons/infinitepay.png',color: '#00D4AA', initials: 'IP'  },
  nomad:         { simpleIconsSlug: null,            localBadge: null,                    color: '#FFCE00', initials: 'No'  },
  ifood:         { simpleIconsSlug: 'ifood',         localBadge: null,                    color: '#EA1D2C', initials: 'iF'  },
};

// Keyword → institution key (checked against the leaf account name slug)
const INSTITUTION_KEYWORDS: Array<[string, string]> = [
  ['nubank', 'nubank'],
  ['nu', 'nubank'],
  ['itau', 'itau'],
  ['wise', 'wise'],
  ['bb', 'bancodobrasil'],
  ['bancodobrasil', 'bancodobrasil'],
  ['inter', 'inter'],
  ['picpay', 'picpay'],
  ['binance', 'binance'],
  ['xp', 'xp'],
  ['rico', 'rico'],
  ['brb', 'brb'],
  ['infinitepay', 'infinitepay'],
  ['nomad', 'nomad'],
  ['ifood', 'ifood'],
];

// ── Category (expense/income) icons ────────────────────────────────────────
// Matched against the first-level slug of the expense/income path.

export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  alimentacao:          Utensils,
  transportes:          Car,
  saude:                Heart,
  carro:                Car,
  casa:                 Home,
  viagens:              Plane,
  vestuario:            Shirt,
  assinaturas:          CreditCard,
  bebidas:              Wine,
  impostos:             Receipt,
  'contribuicao-social': Users,
  esportes:             Activity,
  'higiene-beleza':     Sparkles,
  presentes:            Gift,
  escritorio:           Briefcase,
  telefone:             Smartphone,
  papelaria:            Pencil,
  cultura:              Palette,
  casamento:            Heart,
  emprestimos:          Landmark,
  concursos:            Trophy,
  fraude:               AlertTriangle,
  'gastos-eventuais':   Zap,
  'gastos-pessoais':    User,
  aniversario:          Cake,
  mesada:               Banknote,
  'sem-categoria':      CircleSlash,
  territorial:          Building2,
  recompensas:          Star,
  visitas:              Users,
  lazer:                Gamepad2,
  estudos:              BookOpen,
  'academia-do-hugo':   Dumbbell,
  receitas:             TrendingUp,
};

// ── Special asset keywords → Lucide icon ───────────────────────────────────
const ASSET_SPECIAL: Array<[string, LucideIcon]> = [
  ['carteira', Wallet],
  ['caucao', Building],
  ['financiamento', Car],
];

// ── Result types ────────────────────────────────────────────────────────────

export type AccountIconInfo =
  | { type: 'institution'; institution: InstitutionIcon }
  | { type: 'lucide'; icon: LucideIcon; color?: string }
  | { type: 'initials'; initials: string; color: string };

/**
 * Derive icon info from an account's full hierarchical name plus optional
 * DB-stored icon/color overrides.
 *
 * Handles both full paths (`assets:checking:nubank`) and bare leaf names
 * (`nubank`) — the latter occurs when account_name comes from entries view.
 *
 * Priority:
 *   1. DB-stored `icon` slug → INSTITUTION_ICONS or CATEGORY_ICONS
 *   2. Institution keyword match on the leaf segment
 *   3. Category slug match on first-level or bare name
 *   4. Initials fallback
 */
export function getAccountIconInfo(
  accountFullName: string,
  storedIcon?: string | null,
  storedColor?: string | null,
): AccountIconInfo {
  const segments = accountFullName.split(':');
  const rootType = segments[0]; // 'assets', 'liabilities', 'expenses', 'income', 'equity', or bare name
  const leaf = segments[segments.length - 1];

  // 1. Stored icon override (from DB)
  if (storedIcon) {
    const inst = INSTITUTION_ICONS[storedIcon];
    if (inst) {
      const resolved: InstitutionIcon = storedColor
        ? { ...inst, color: storedColor }
        : inst;
      return { type: 'institution', institution: resolved };
    }
    const lucideIcon = CATEGORY_ICONS[storedIcon];
    if (lucideIcon) {
      return { type: 'lucide', icon: lucideIcon };
    }
  }

  const isAssetLiability =
    rootType === 'assets' || rootType === 'liabilities';
  const isExpenseIncome =
    rootType === 'expenses' || rootType === 'income';
  // bare leaf (no root type prefix) → try institution first, then category
  const isBare = !isAssetLiability && !isExpenseIncome;

  // 2. Institution keyword match on the leaf
  if (isAssetLiability || isBare) {
    // Special asset keywords
    for (const [keyword, icon] of ASSET_SPECIAL) {
      if (leaf.includes(keyword)) {
        return { type: 'lucide', icon, color: storedColor || '#6B7280' };
      }
    }

    for (const [keyword, instKey] of INSTITUTION_KEYWORDS) {
      if (
        leaf === keyword ||
        leaf.startsWith(keyword + '-') ||
        leaf.includes('-' + keyword + '-') ||
        leaf.endsWith('-' + keyword)
      ) {
        const inst = INSTITUTION_ICONS[instKey];
        if (inst) {
          const resolved: InstitutionIcon = storedColor
            ? { ...inst, color: storedColor }
            : inst;
          return { type: 'institution', institution: resolved };
        }
      }
    }
  }

  // 3. Category slug match
  if (isExpenseIncome || isBare) {
    // Full path: use the first-level category slug (segments[1])
    // Bare name: the name itself is the slug to try
    const categorySlug = isExpenseIncome ? (segments[1] || leaf) : leaf;
    const lucideIcon = CATEGORY_ICONS[categorySlug];
    if (lucideIcon) {
      return { type: 'lucide', icon: lucideIcon };
    }
    if (isExpenseIncome) {
      // Fallback for any expense/income with no matched slug
      return { type: 'lucide', icon: Tag };
    }
  }

  // 4. Initials fallback
  const initials = segments
    .slice(-2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');

  const color = storedColor || hashColor(accountFullName);
  return { type: 'initials', initials: initials.slice(0, 2), color };
}

/** Deterministic color from a string (for fallback initials). */
function hashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    '#6366F1', '#8B5CF6', '#EC4899', '#14B8A6',
    '#F59E0B', '#10B981', '#3B82F6', '#EF4444',
  ];
  return colors[Math.abs(hash) % colors.length];
}
