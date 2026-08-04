/** Temporary probe used to exercise comment-triggered review. */
export function renderProfile(input: string): string {
  // Deliberate flaw: interpolates untrusted input straight into markup.
  return `<div class="profile">${input}</div>`;
}
