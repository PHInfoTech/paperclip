export function navigateTopLevel(target: string) {
  window.location.assign(target);
}

/**
 * Navigate a window opened via `window.open`. Once the popup has moved to a
 * cross-origin page, reading or assigning `location` throws a SecurityError, so
 * fall back to re-opening by window name, which navigates the existing window.
 * Returns the window that is showing the target, or null if the browser blocked it.
 */
export function navigatePopup(popup: Window, target: string, name: string): Window | null {
  try {
    popup.location.assign(target);
    return popup;
  } catch {
    return window.open(target, name);
  }
}
