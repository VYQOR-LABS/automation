import type { MemoryRecord } from '../memory/memory.service.js';

export type IntentCategory =
  | 'calendar_lookup'
  | 'calendar_event_details'
  | 'birthday_lookup'
  | 'gmail_search'
  | 'memory_search'
  | 'direct_conversation'
  | 'follow_up';

export type ExtractedEntity = {
  original: string;
  kind: 'person' | 'organization' | 'event' | 'date' | 'location' | 'unknown';
  candidates: Array<{ value: string; confidence: number; evidence: string }>;
  resolved?: string;
  confidence: number;
  confirmationRequired: boolean;
};

export type IntelligenceDecision = {
  normalizedMessage: string;
  intent: IntentCategory;
  tools: string[];
  entities: ExtractedEntity[];
  timeExpressions: string[];
  searchTerms: string[];
  confidence: number;
  clarificationRequired: boolean;
  clarification?: string;
  reasoning: string;
};

export type RetrievalCandidate = {
  value: unknown;
  score: number;
  evidence: string[];
};

const ALIASES: Record<string, string[]> = {
  mary: ['maryam', 'mariam', 'marriam', 'meryam'],
  maryam: ['maryam', 'mariam', 'marriam', 'mary', 'meryam'],
  madam: ['maryam', 'mariam', 'marriam', 'mary'],
};

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(bday|birth day)\b/g, 'birthday')
    .replace(/\b(paymant|peyment)\b/g, 'payment')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string) {
  const rows = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = rows[0];
    rows[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = rows[j];
      rows[j] = Math.min(rows[j] + 1, rows[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return rows[b.length];
}

export function fuzzySimilarity(a: string, b: string) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const knownVariantPairs = [
    ['marriam', 'maryam'], ['mariam', 'maryam'], ['meryam', 'maryam'],
    ['mary', 'maryam'], ['madam', 'maryam'],
  ];
  if (knownVariantPairs.some(([a, b]) => (left === a && right === b) || (left === b && right === a))) {
    return 0.91;
  }
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

export class IntelligenceService {
  understand(message: string, memory: MemoryRecord[] = []): IntelligenceDecision {
    const normalizedMessage = normalize(message);
    const lower = normalizedMessage;
    const timeExpressions = ['today', 'tomorrow', 'next week', 'this week', 'tonight', 'yesterday']
      .filter((expression) => lower.includes(expression));

    const tools: string[] = [];
    let intent: IntentCategory = 'direct_conversation';
    const emailSource = /\b(in my|from my|on my)?\s*(email|gmail|inbox|messages?)\b/.test(lower) ||
      /\bemail invitation(s)?\b|\binvitations?\b|\bdid anyone (send|email)\b/.test(lower);
    const calendarSource = /\b(on my|in my)?\s*calendar\b/.test(lower);
    const asksPersonalSchedule = /\b(what|which|do i have|am i)\b.*\b(meetings?|appointments?|events?|schedule)\b/.test(lower);
    const explicitBirthday = /\bbirthday\b|\bbday\b/.test(lower);

    if (emailSource) {
      intent = 'gmail_search';
      tools.push('gmail_search');
      if (calendarSource) tools.push('calendar_lookup');
    } else if (explicitBirthday) {
      intent = 'birthday_lookup';
      tools.push('calendar_lookup');
    } else if (calendarSource || asksPersonalSchedule) {
      intent = 'calendar_lookup';
      tools.push('calendar_lookup');
    } else if (/\bremember\b|\bmemory\b|what do you know about/.test(lower)) {
      intent = 'memory_search';
      tools.push('memory_search');
    }

    const entities = this.extractEntities(lower, memory);
    const searchTerms = this.buildSearchTerms(lower, entities);

    let confidence = intent === 'direct_conversation' ? 0.99 : intent === 'calendar_lookup' || intent === 'gmail_search' || intent === 'birthday_lookup' || intent === 'memory_search' ? 0.92 : 0.72;
    if (entities.length > 0) {
      confidence = Math.max(confidence, 0.74 + entities.reduce((sum, entity) => sum + entity.confidence, 0) / 20);
    }
    confidence = Math.min(confidence, 0.99);

    const ambiguous = entities.filter((entity) => entity.confirmationRequired);
    const clarificationRequired = ambiguous.length > 0 && ambiguous.some((entity) => entity.candidates.length > 1);
    const clarification = clarificationRequired
      ? `Did you mean ${ambiguous[0].candidates.slice(0, 3).map((candidate) => candidate.value).join(' or ')}?`
      : undefined;

    return {
      normalizedMessage,
      intent,
      tools,
      entities,
      timeExpressions,
      searchTerms,
      confidence,
      clarificationRequired,
      clarification,
      reasoning: intent === 'direct_conversation'
        ? 'No external integration appears necessary.'
        : `Detected ${intent} with bounded backend retrieval.`,
    };
  }

  private extractEntities(message: string, memory: MemoryRecord[]) {
    const entities: ExtractedEntity[] = [];
    const knownNames = new Set<string>();
    for (const record of memory) {
      for (const match of record.factText.matchAll(/\b([A-Z][a-z]+(?:[- ][A-Z][a-z]+)*)\b/g)) {
        knownNames.add(match[1]);
      }
    }

    const words = message.split(' ').filter((word) => word.length >= 3);
    const stop = new Set(['about', 'have', 'that', 'email', 'gmail', 'what', 'when', 'with', 'from', 'sent', 'birthday', 'calendar', 'please', 'find']);
    for (const word of words) {
      if (stop.has(word) || /^\d/.test(word)) continue;

      const candidates: Array<{ value: string; confidence: number; evidence: string }> = [];
      for (const [alias, names] of Object.entries(ALIASES)) {
        if (word === alias || fuzzySimilarity(word, alias) >= 0.72) {
          for (const name of names) candidates.push({ value: name, confidence: fuzzySimilarity(word, name), evidence: `name or alias match for ${word}` });
        }
      }
      for (const known of knownNames) {
        const score = fuzzySimilarity(word, known.toLowerCase());
        if (score >= 0.72) candidates.push({ value: known, confidence: score, evidence: 'matches established memory context' });
      }

      candidates.sort((a, b) => b.confidence - a.confidence);
      const unique = candidates.filter((candidate, index) => candidates.findIndex((item) => item.value === candidate.value) === index);
      if (unique.length > 0) {
        const strong = unique[0];
        entities.push({
          original: word,
          kind: 'person',
          candidates: unique.slice(0, 5),
          resolved: unique.length === 1 || strong.confidence >= 0.9 ? strong.value : undefined,
          confidence: strong.confidence,
          confirmationRequired: unique.length > 1 && strong.confidence < 0.92,
        });
      }
    }

    return entities;
  }

  private buildSearchTerms(message: string, entities: ExtractedEntity[]) {
    const terms = new Set<string>();
    if (/birthday/.test(message)) {
      terms.add('birthday');
      for (const entity of entities) {
        terms.add(entity.original);
        for (const candidate of entity.candidates) terms.add(candidate.value);
      }
    }

    const words = message.split(' ').filter((word) => word.length >= 4);
    for (const word of words) {
      if (!/^(about|with|from|that|what|when|where|which|please|find|email|gmail|calendar|birthday|sent|have)$/.test(word)) {
        terms.add(word);
      }
    }
    return [...terms].slice(0, 12);
  }

  rankCalendarEvents(events: unknown[], decision: IntelligenceDecision): RetrievalCandidate[] {
    return this.rankResults(events, [
      ...decision.searchTerms,
      ...decision.entities.flatMap((entity) => entity.candidates.map((candidate) => candidate.value)),
    ]);
  }

  rankGmailResults(messages: unknown[], decision: IntelligenceDecision): RetrievalCandidate[] {
    return this.rankResults(messages, decision.searchTerms)
      .map((candidate) => {
        const interpretation = candidate.value &&
          typeof candidate.value === 'object' &&
          'interpretation' in candidate.value
          ? candidate.value.interpretation
          : undefined;
        const explicitlyUrgent = interpretation &&
          typeof interpretation === 'object' &&
          'urgency' in interpretation &&
          interpretation.urgency === 'explicitly_urgent';
        return explicitlyUrgent
          ? {
              ...candidate,
              score: candidate.score + 1,
              evidence: [...candidate.evidence, 'explicitly urgent'],
            }
          : candidate;
      })
      .sort((left, right) => right.score - left.score);
  }

  private rankResults(values: unknown[], terms: string[]): RetrievalCandidate[] {
    const candidates = values.map((value) => {
      const text = JSON.stringify(value).toLowerCase();
      let score = 0;
      const evidence: string[] = [];
      for (const term of new Set(terms.map(normalize).filter(Boolean))) {
        if (text.includes(term)) {
          score += 1;
          evidence.push(`contains ${term}`);
        }
        const fragments = term.split(' ');
        for (const fragment of fragments) {
          if (fragment.length >= 4 && text.includes(fragment)) {
            score += 0.25;
          }
        }
      }
      return { value, score, evidence };
    });
    return candidates.sort((a, b) => b.score - a.score);
  }
}
