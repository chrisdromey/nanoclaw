import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#18181B',
        raised: '#27272A',
        overlay: '#3F3F46',
        accent: {
          DEFAULT: '#8B5CF6',
          hover: '#7C3AED',
          muted: 'rgba(139, 92, 246, 0.1)',
        },
        success: {
          DEFAULT: '#22C55E',
          muted: 'rgba(34, 197, 94, 0.1)',
        },
        warning: {
          DEFAULT: '#EAB308',
          muted: 'rgba(234, 179, 8, 0.1)',
        },
        danger: {
          DEFAULT: '#EF4444',
          muted: 'rgba(239, 68, 68, 0.1)',
        },
        info: {
          DEFAULT: '#3B82F6',
          muted: 'rgba(59, 130, 246, 0.1)',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'Fira Code',
          'Cascadia Code',
          'ui-monospace',
          'monospace',
        ],
      },
      fontSize: {
        'page-title': [
          '1.5rem',
          { lineHeight: '2rem', fontWeight: '600' },
        ],
        'section-title': [
          '1.125rem',
          { lineHeight: '1.75rem', fontWeight: '600' },
        ],
        heading: [
          '0.875rem',
          { lineHeight: '1.25rem', fontWeight: '600' },
        ],
        tiny: [
          '0.6875rem',
          { lineHeight: '0.875rem', fontWeight: '500' },
        ],
      },
      keyframes: {
        'flash-success': {
          '0%': { backgroundColor: 'rgba(34, 197, 94, 0.1)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'flash-danger': {
          '0%': { backgroundColor: 'rgba(239, 68, 68, 0.1)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'stale-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        'feed-in': {
          '0%': { opacity: '0', transform: 'translateY(-4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'flash-success':
          'flash-success 1.5s cubic-bezier(0.4, 0, 0.2, 1)',
        'flash-danger':
          'flash-danger 1.5s cubic-bezier(0.4, 0, 0.2, 1)',
        'stale-pulse': 'stale-pulse 2s ease-in-out infinite',
        'feed-in': 'feed-in 300ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
