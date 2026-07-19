import { describe, expect, it } from 'vitest';
import { extractXMentions } from './x-mentions';

describe('extractXMentions (frontend mirror)', () => {
  it('extracts handles and dedupes case-insensitively', () => {
    expect(extractXMentions('shoutout @JackMunro and @jackmunro plus @OtherOne'))
      .toEqual(['JackMunro', 'OtherOne']);
  });

  it('ignores asset slugs, emails, and over-long tokens', () => {
    expect(extractXMentions('render @vid-outro-combo-final now')).toEqual([]);
    expect(extractXMentions('mail me jwt@hey.com')).toEqual([]);
    expect(extractXMentions('@a_very_long_handle_over_limit')).toEqual([]);
  });

  it('accepts handles at start, mid-sentence, and before punctuation', () => {
    expect(extractXMentions('@Lead kicks off')).toEqual(['Lead']);
    expect(extractXMentions('word (@Paren) and @Comma, done.')).toEqual(['Paren', 'Comma']);
  });

  it('returns empty for text without mentions', () => {
    expect(extractXMentions('multicultural revolution')).toEqual([]);
  });
});
