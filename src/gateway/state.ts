/**
 * Gateway startup state tracker.
 *
 * Tracks the state of gateway startup attempts so that
 * the /api/status endpoint can report errors to the loading page
 * instead of silently failing.
 */

export type StartupState = {
  /** Whether a startup attempt is currently in progress */
  inProgress: boolean;
  /** The last startup error message, or null if last attempt succeeded */
  lastError: string | null;
  /** Timestamp of the last error */
  lastErrorAt: number | null;
  /** Number of failed startup attempts */
  failureCount: number;
};

const state: StartupState = {
  inProgress: false,
  lastError: null,
  lastErrorAt: null,
  failureCount: 0,
};

export function markStartupInProgress(): void {
  state.inProgress = true;
}

export function markStartupSuccess(): void {
  state.inProgress = false;
  state.lastError = null;
  state.lastErrorAt = null;
  state.failureCount = 0;
}

export function markStartupFailed(error: string): void {
  state.inProgress = false;
  state.lastError = error;
  state.lastErrorAt = Date.now();
  state.failureCount++;
}

export function getStartupState(): Readonly<StartupState> {
  return state;
}
