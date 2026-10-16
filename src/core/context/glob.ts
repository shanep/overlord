import picomatch from 'picomatch';

const OPTIONS: picomatch.PicomatchOptions = { dot: true };

function safeMatcher(pattern: string): picomatch.Matcher | null {
  try {
    return picomatch(pattern, OPTIONS);
  } catch {
    // An empty or malformed pattern matches nothing, like Claude Code.
    return null;
  }
}

/** The first pattern that matches `target`, or null. */
export function firstMatch(patterns: readonly string[], target: string): string | null {
  for (const pattern of patterns) {
    if (safeMatcher(pattern)?.(target) === true) {
      return pattern;
    }
  }
  return null;
}
