import { useEffect, useState } from "react";
import { useNavigation } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * Thin top-of-page progress bar driven by react-router's navigation state.
 * Slides in while a route is loading (most relevant for our lazy() chunks)
 * and fades out smoothly when navigation settles.
 *
 * Sits absolute-positioned at the very top of the main content column so it
 * appears underneath the topbar's bottom border when the user navigates.
 */
export function RouteProgress() {
  const navigation = useNavigation();
  const isLoading =
    navigation.state === "loading" || navigation.state === "submitting";
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (isLoading) {
      setVisible(true);
      setProgress(8);
      // Trickle progress upward — not deterministic, just feedback.
      const steps = [
        { delay: 80, to: 28 },
        { delay: 200, to: 56 },
        { delay: 600, to: 78 },
        { delay: 1500, to: 90 },
      ];
      const timers = steps.map((s) =>
        window.setTimeout(() => setProgress(s.to), s.delay),
      );
      return () => timers.forEach(window.clearTimeout);
    }
    // Finish: rush to 100, then fade out.
    setProgress(100);
    const t = window.setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 220);
    return () => window.clearTimeout(t);
  }, [isLoading]);

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 h-0.5 z-40 transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        className="h-full bg-ember-500 shadow-[0_0_8px_rgba(220,38,38,0.55)] transition-[width] duration-200 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
