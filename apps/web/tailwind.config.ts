import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1320px" },
    },
    extend: {
      colors: {
        // ── /agentd palette ──────────────────────────────────────────
        // Paper: warm parchment, distinct from brae's cream.
        paper: {
          DEFAULT: "#F4EFE5",
          50: "#FBF8F1",
          100: "#F4EFE5",
          200: "#ECE5D5",
          300: "#E1D9C4",
          400: "#CCC2A8",
        },
        // Ink: warm near-black with a touch of sepia depth.
        ink: {
          50: "#FAFAF7",
          100: "#F0EEE8",
          200: "#DEDBD3",
          300: "#BFBBB1",
          400: "#85807A",
          500: "#5A5650",
          600: "#3D3933",
          700: "#231F1A",
          800: "#15110D",
          900: "#0A0805",
        },
        // Ember: matches the logo's #DC2626 red. The agentd accent.
        ember: {
          50: "#FEF2F2",
          100: "#FEE2E2",
          200: "#FECACA",
          300: "#FCA5A5",
          400: "#F87171",
          500: "#DC2626",
          600: "#B91C1C",
          700: "#991B1B",
          800: "#7F1D1D",
          900: "#450A0A",
        },

        // ── shadcn semantic tokens (mapped per-mode in index.css) ────
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: "hsl(var(--success))",
        warn: "hsl(var(--warn))",
        info: "hsl(var(--info))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        display: ['"Fraunces"', "ui-serif", "Georgia", "serif"],
        sans: ['"Geist"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "Menlo", "monospace"],
      },
      letterSpacing: {
        "tightest-2": "-0.04em",
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        edit: "0 1px 0 rgba(10, 8, 5, 0.06), 0 12px 30px -16px rgba(10, 8, 5, 0.2)",
        deep: "0 30px 80px -30px rgba(10, 8, 5, 0.35)",
        glow: "0 0 0 3px rgba(220, 38, 38, 0.18)",
      },
      backgroundImage: {
        noise:
          "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.06 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        // Horizontal swipe for `<TransitioningText>`. The exiting
        // line slides off to the left as a single block; the incoming
        // line swipes in letter-by-letter from the right with an
        // index-based delay. No blur — kept clean at 11-12.5px.
        "letter-in": {
          "0%": { opacity: "0", transform: "translateX(0.5em)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "label-out": {
          "0%": { opacity: "1", transform: "translateX(0)" },
          "100%": { opacity: "0", transform: "translateX(-0.5em)" },
        },
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        rise: {
          "0%": { opacity: "0", transform: "translateY(14px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        pulse_ring: {
          "0%": { transform: "scale(0.8)", opacity: "0.6" },
          "100%": { transform: "scale(2.2)", opacity: "0" },
        },
        ticker_in: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // Soft green flash when a todo flips to done — settles in ~700ms.
        "done-flash": {
          "0%": { backgroundColor: "rgba(16, 185, 129, 0.18)" },
          "100%": { backgroundColor: "rgba(16, 185, 129, 0)" },
        },
        // Pop the check mark in when status hits done.
        "check-pop": {
          "0%": { transform: "scale(0)", opacity: "0" },
          "60%": { transform: "scale(1.25)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        // Draw the strikethrough across — paired with line-through on text.
        "strike-in": {
          "0%": { transform: "scaleX(0)", transformOrigin: "left" },
          "100%": { transform: "scaleX(1)", transformOrigin: "left" },
        },
        // Slide-in for new queue/timeline rows.
        "slide-in": {
          "0%": { opacity: "0", transform: "translateX(-6px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        // Soft glow on currently active row (ember pulse).
        "active-glow": {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(247, 127, 0, 0.25)" },
          "50%": { boxShadow: "0 0 0 4px rgba(247, 127, 0, 0)" },
        },
        // Multi-color "playing colors" gradient sweep for the active
        // brainstorm card. Drifts a wide multi-stop gradient across
        // the element while the agent is reading the repo.
        "aurora-sweep": {
          "0%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
          "100%": { backgroundPosition: "0% 50%" },
        },
        // Indeterminate progress sweep — used as a 1px ember bar
        // along the bottom of an actively-running tool row to convey
        // "the agent is working on this NOW". Sweeps left to right
        // beyond the container so the leading edge is always moving.
        "progress-sweep": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
        // Soft ember background pulse for a running tool row — the
        // row gently breathes in/out so it reads as "alive" without
        // being distracting.
        "running-bg": {
          "0%, 100%": { backgroundColor: "rgba(247, 127, 0, 0.04)" },
          "50%": { backgroundColor: "rgba(247, 127, 0, 0.11)" },
        },
        // Three-dot loading cycle. Each dot animates with the same
        // keyframe but staggered via `animation-delay` so the dots
        // light up in sequence: . .. ...
        "dot-cycle": {
          "0%, 80%, 100%": { opacity: "0.25", transform: "translateY(0)" },
          "40%": { opacity: "1", transform: "translateY(-1px)" },
        },
        // Idea card lands with a small lift + ember-tinted flash that
        // fades in under a second. Pairs with `fade-in` for the row.
        "idea-pop": {
          "0%": {
            opacity: "0",
            transform: "translateY(6px) scale(0.985)",
            backgroundColor: "rgba(247, 127, 0, 0.10)",
          },
          "60%": {
            opacity: "1",
            transform: "translateY(0) scale(1)",
            backgroundColor: "rgba(247, 127, 0, 0.06)",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0) scale(1)",
            backgroundColor: "rgba(247, 127, 0, 0)",
          },
        },
        // Slow opacity wave for the "agent is thinking" label. Drops
        // to 60% mid-cycle so the line clearly reads as alive without
        // ever fading enough to feel like it's loading.
        "thinking-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
      },
      animation: {
        shimmer: "shimmer 2s linear infinite",
        "thinking-pulse": "thinking-pulse 2.4s ease-in-out infinite",
        "fade-in": "fade-in 0.25s ease-out both",
        "letter-in": "letter-in 0.42s cubic-bezier(0.22, 1, 0.36, 1) both",
        "label-out": "label-out 0.22s cubic-bezier(0.4, 0, 0.7, 0) both",
        rise: "rise 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) both",
        blink: "blink 1.6s ease-in-out infinite",
        "pulse-ring": "pulse_ring 1.6s cubic-bezier(0.2, 0.7, 0.2, 1) infinite",
        "ticker-in": "ticker_in 0.4s ease-out both",
        "done-flash": "done-flash 0.8s ease-out both",
        "check-pop": "check-pop 0.4s cubic-bezier(0.2, 0.7, 0.2, 1) both",
        "strike-in": "strike-in 0.35s cubic-bezier(0.4, 0, 0.2, 1) both",
        "slide-in": "slide-in 0.25s ease-out both",
        "active-glow": "active-glow 2.4s ease-in-out infinite",
        "aurora-sweep": "aurora-sweep 6s ease-in-out infinite",
        "idea-pop": "idea-pop 0.85s cubic-bezier(0.2, 0.7, 0.2, 1) both",
        "progress-sweep": "progress-sweep 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        "running-bg": "running-bg 2.4s ease-in-out infinite",
        "dot-cycle": "dot-cycle 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [animate],
};

export default config;
