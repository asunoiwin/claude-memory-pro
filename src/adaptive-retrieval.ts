/**
 * Adaptive Retrieval
 * Determines whether a query needs memory retrieval.
 * Skips retrieval for greetings, commands, simple instructions.
 */

const SKIP_PATTERNS = [
  /^(hi|hello|hey|good\s*(morning|afternoon|evening|night)|greetings|yo|sup|howdy)\b/i,
  /^\//,
  /^(run|build|test|ls|cd|git|npm|pip|docker|curl|cat|grep|find|make|sudo)\b/i,
  /^(yes|no|yep|nope|ok|okay|sure|fine|thanks|thank you|thx|ty|got it|understood|cool|nice|great|good|perfect|awesome)\s*[.!]?$/i,
  /^(go ahead|continue|proceed|do it|start|begin|next)\s*[.!]?$/i,
  /^[\p{Emoji}\s]+$/u,
  /^HEARTBEAT/i,
  /^\[System/i,
];

const FORCE_RETRIEVE_PATTERNS = [
  /\b(remember|recall|forgot|memory|memories)\b/i,
  /\b(last time|before|previously|earlier|yesterday|ago)\b/i,
  /\b(my (name|email|phone|address|birthday|preference))\b/i,
  /\b(what did (i|we)|did i (tell|say|mention))\b/i,
  /(你记得|之前|上次|以前|还记得|提到过|说过)/i,
];

export function shouldSkipRetrieval(query: string): boolean {
  const trimmed = query.trim();
  if (FORCE_RETRIEVE_PATTERNS.some(p => p.test(trimmed))) return false;
  if (trimmed.length < 5) return true;
  if (SKIP_PATTERNS.some(p => p.test(trimmed))) return true;
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(trimmed);
  const minLength = hasCJK ? 6 : 15;
  if (trimmed.length < minLength && !trimmed.includes('?')) return true;
  return false;
}
