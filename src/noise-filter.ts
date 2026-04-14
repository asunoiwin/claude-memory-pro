/**
 * Noise Filter - filters out low-quality memories
 */

const DENIAL_PATTERNS = [
  /i don'?t have (any )?(information|data|memory|record)/i,
  /i'?m not sure about/i,
  /i don'?t recall/i,
  /no (relevant )?memories found/i,
];

const META_QUESTION_PATTERNS = [
  /\bdo you (remember|recall|know about)\b/i,
  /\bcan you (remember|recall)\b/i,
  /\bdid i (tell|mention|say|share)\b/i,
];

const BOILERPLATE_PATTERNS = [
  /^(hi|hello|hey|good morning|good evening|greetings)/i,
  /^fresh session/i,
  /^new session/i,
];

export function isNoise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 5) return true;

  if (DENIAL_PATTERNS.some(p => p.test(trimmed))) return true;
  if (META_QUESTION_PATTERNS.some(p => p.test(trimmed))) return true;
  if (BOILERPLATE_PATTERNS.some(p => p.test(trimmed))) return true;

  return false;
}

export function filterNoise<T>(items: T[], getText: (item: T) => string): T[] {
  return items.filter(item => !isNoise(getText(item)));
}
