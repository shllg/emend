import { useEffect, useRef } from "react";

/**
 * Detect wall-clock adjustments or sleeps that pause the monotonic clock.
 * The optional tick callback shares the interval with relative-time updates.
 */
export function useClockJump(onJump: () => void, onTick?: (now: number) => void) {
  const latest = useRef({ onJump, onTick });
  latest.current = { onJump, onTick };
  useEffect(() => {
    let wall = Date.now();
    let monotonic = performance.now();
    const timer = setInterval(() => {
      const nextWall = Date.now();
      const nextMonotonic = performance.now();
      const jumped = Math.abs(nextWall - wall - (nextMonotonic - monotonic)) > 5_000;
      wall = nextWall;
      monotonic = nextMonotonic;
      latest.current.onTick?.(nextWall);
      if (jumped) latest.current.onJump();
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
}
