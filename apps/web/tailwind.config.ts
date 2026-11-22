import type { Config } from 'tailwindcss';

/**
 * Design tokens: "Soft Graphite x Ember Orange".
 *
 * The app's existing components use Tailwind's slate / sky / indigo / violet /
 * emerald / rose / amber scales. Rather than touching every call site we remap
 * those scales onto the ICE palette, so the whole product is re-themed from one
 * place. Prefer the semantic names (`ink`, `ember`, `text`) in new code.
 */
const graphite = {
  50: '#FAF8F5',
  100: '#F5F3EF', // primary text (warm white)
  200: '#E2DFDA',
  300: '#C6C3BE',
  400: '#A7A5A2', // secondary text
  500: '#8A8886', // muted text (AA on #141414 / #1C1C1C)
  600: '#5A5957',
  700: '#343434', // subtle borders
  800: '#2A2A2A', // hairlines / hover fills
  900: '#1C1C1C', // secondary background
  950: '#141414', // main background
};

const ember = {
  50: '#FFF3EC',
  100: '#FFE3D4',
  200: '#FFC7A9',
  300: '#FFA882',
  400: '#FF8959', // accent hover
  500: '#FF7139', // primary accent
  600: '#E85F2B',
  700: '#B94A20',
  800: '#7A3418',
  900: '#33231D', // subtle accent background
  950: '#241812',
};

const mint = {
  300: '#A3DEC3',
  400: '#79C9A4',
  500: '#5FB38D',
  600: '#4A9573',
};
const coral = {
  300: '#F0A39D',
  400: '#E47B74',
  500: '#D4605A',
  600: '#B84D48',
};
const amber = {
  300: '#F0CE9A',
  400: '#E6B56C',
  500: '#D49C4E',
  600: '#B07F38',
};
const lavender = {
  300: '#C9BFE8',
  400: '#B1A4DD',
  500: '#9A8BCF',
  600: '#7F6FB8',
};

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        slate: graphite,
        gray: graphite,
        // Primary accent. `sky` and `indigo` are what existing buttons use.
        sky: ember,
        indigo: ember,
        ember,
        emerald: mint,
        green: mint,
        rose: coral,
        red: coral,
        amber,
        yellow: amber,
        violet: lavender,
        purple: lavender,
        ink: graphite,
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['"Space Grotesk"', 'Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
        label: ['"Geist Mono"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        control: '10px',
        panel: '14px',
        card: '16px',
      },
      boxShadow: {
        soft: '0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)',
        pop: '0 12px 40px -12px rgba(0,0,0,0.7)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'pop-in': {
          '0%': { opacity: '0', transform: 'scale(0.94)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'dot-bounce': {
          '0%, 80%, 100%': { opacity: '0.25', transform: 'translateY(0)' },
          '40%': { opacity: '1', transform: 'translateY(-2px)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 320ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 240ms ease-out both',
        'pop-in': 'pop-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'dot-bounce': 'dot-bounce 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
