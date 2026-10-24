/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./public/**/*.html",
    "./public/**/*.js"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'sans-serif'],
        grunge: ['"Plus Jakarta Sans"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace']
      },
      colors: {
        obsidian: {
          950: '#030407',
          900: '#07090e',
          850: '#0d1017',
          800: '#131722',
          700: '#1e2436',
          600: '#333c54'
        },
        brand: {
          cyan: '#00f0ff',
          indigo: '#6366f1',
          purple: '#a855f7',
          amber: '#f59e0b',
          emerald: '#10b981'
        }
      },
      animation: {
        'beam-glow': 'beamGlow 8s ease-in-out infinite alternate',
        'spin-slow': 'spin 20s linear infinite',
        'pulse-subtle': 'pulseSubtle 3s cubic-bezier(0.4, 0, 0.6, 1) infinite'
      },
      keyframes: {
        beamGlow: {
          '0%': { transform: 'scale(0.9) translate(-50%, -50%)', opacity: '0.4' },
          '100%': { transform: 'scale(1.15) translate(-45%, -52%)', opacity: '0.75' }
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' }
        }
      }
    }
  },
  plugins: []
};
