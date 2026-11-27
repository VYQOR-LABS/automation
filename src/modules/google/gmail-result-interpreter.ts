export type InterpretedGmailMessage = {
  id?: string | null;
  threadId?: string | null;
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  date?: string | null;
  snippet?: string | null;
  body?: string | null;
  interpretation: {
    eventOrInvitation: boolean;
    eventEvidence: string[];
    dateExpressions: string[];
    requestedAction: boolean;
    actionEvidence: string[];
    expectsResponse: boolean;
    responseEvidence: string[];
    urgency: 'explicitly_urgent' | 'not_marked_urgent';
    urgencyEvidence: string[];
  };
};

function matchingSentences(text: string, pattern: RegExp) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && pattern.test(sentence))
    .slice(0, 5);
}

export function interpretGmailMessage(
  message: Omit<InterpretedGmailMessage, 'interpretation'>,
): InterpretedGmailMessage {
  const content = [message.subject, message.snippet, message.body]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n');
  const eventPattern = /\b(meeting|appointment|event|invitation|invite|conference|webinar)\b/i;
  const actionPattern = /\b(please|kindly|action required|you need to|you should|could you|would you|confirm|respond|reply|register|submit|complete|review|approve|send|sign)\b/i;
  const responsePattern = /\b(please reply|please respond|let me know|confirm (?:your )?(?:attendance|availability|receipt)|RSVP|reply by|respond by)\b/i;
  const urgencyPattern = /\b(urgent|asap|immediately|action required|time[- ]sensitive|overdue|final notice)\b/i;
  const datePattern = /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?|\b\d{4}-\d{2}-\d{2}\b|\b(?:today|tomorrow|tonight|next week)\b/gi;

  const eventEvidence = matchingSentences(content, eventPattern);
  const actionEvidence = matchingSentences(content, actionPattern);
  const responseEvidence = matchingSentences(content, responsePattern);
  const urgencyEvidence = matchingSentences(content, urgencyPattern);
  const dateExpressions = [...new Set(content.match(datePattern) ?? [])].slice(0, 10);

  return {
    ...message,
    interpretation: {
      eventOrInvitation: eventEvidence.length > 0,
      eventEvidence,
      dateExpressions,
      requestedAction: actionEvidence.length > 0,
      actionEvidence,
      expectsResponse: responseEvidence.length > 0,
      responseEvidence,
      urgency: urgencyEvidence.length > 0 ? 'explicitly_urgent' : 'not_marked_urgent',
      urgencyEvidence,
    },
  };
}
