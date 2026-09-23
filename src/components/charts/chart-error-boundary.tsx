"use client";

import { Component, type ReactNode } from "react";

/**
 * Chart rendering must never take down the result: if a chart throws (bad data shape, a Recharts edge case, …) fall
 * back to whatever `fallback` renders (the data table) instead of a blank/broken page. React error boundaries must
 * be class components — there is no hook equivalent.
 */
export class ChartErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[chart] rendering failed, falling back to table:", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
