/**
 * Decide whether a later speech segment continues the request that produced a
 * pending prepare_workspace_action, or starts a genuinely new request.
 *
 * Speakers often finish a command across breaths ("generate an image" … "of a
 * kitten" … "on a train from C1"). Those clauses should run against the joined
 * transcript. A new question or command must not execute the stale call.
 */

const NEW_REQUEST = /^(?:what|what's|whats|who|where|when|why|how|which|hello|hi|hey|thanks|thank you|never mind|nevermind|cancel|stop|wait|hold on|actually|instead|now\s+(?:generate|make|create|show|list|delete|open|draw)|show me|list\b|delete\b|rename\b|open\b|close\b|play\b|pause\b|generate\b|make\b|create\b|draw\b|write\b|search\b|find\b|apply\b|run\b)\b/iu;

const CONTINUATION_PREFIX = /^(?:of|on|in|with|from|to|at|for|about|like|as|by|into|onto|over|under|and|or|but|then|also|plus|a|an|the|using|make it|make the|that's|that is|here|there|please)\b/iu;

function isNewVoiceRequest(text: string): boolean {
  return NEW_REQUEST.test(text.trim());
}

function isContinuationFragment(text: string): boolean {
  const incoming = text.trim();
  if (!incoming) return false;
  if (isNewVoiceRequest(incoming)) return false;
  if (CONTINUATION_PREFIX.test(incoming)) return true;
  if (/^@?[a-z]{1,2}\d+\b/iu.test(incoming)) return true;
  const words = incoming.split(/\s+/u);
  return words.length <= 8 && !/[.?!]$/u.test(incoming);
}

export function isVoiceTurnContinuation(previous: string, next: string): boolean {
  const incoming = next.trim();
  if (!incoming) return false;
  if (isNewVoiceRequest(incoming)) return false;
  const prior = previous.trim();
  if (!prior) return isContinuationFragment(incoming);
  if (incoming.toLowerCase() === prior.toLowerCase()) return true;
  return isContinuationFragment(incoming);
}

export function joinVoiceTranscripts(previous: string, next: string): string {
  const prior = previous.trim();
  const incoming = next.trim();
  if (!prior) return incoming;
  if (!incoming) return prior;
  const priorLower = prior.toLowerCase();
  const incomingLower = incoming.toLowerCase();
  if (incomingLower.startsWith(priorLower)) return incoming;
  if (priorLower.endsWith(incomingLower) && incoming.length >= 4) return prior;
  return `${prior} ${incoming}`;
}
