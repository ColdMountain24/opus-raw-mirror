import { describe, expect, it } from 'vitest';
import { createClaimStreamParser } from '../../../src/agents/loop2/claimstream.js';

// The incremental partial-JSON parser that drives progressive claim rendering. It is
// fed token deltas (as they arrive from dispatch onToken) and emits open/field/close
// events the moment each piece parses - never re-parsing the accumulated string.

function recorder() {
  const events = [];
  const parser = createClaimStreamParser({
    onClaimOpen: (i, partial) => events.push({ t: 'open', i, id: partial.claim_id }),
    onClaimField: (i, key, value) => events.push({ t: 'field', i, key, value }),
    onClaimClose: (i, claim) => events.push({ t: 'close', i, claim }),
  });
  return { events, parser };
}

const ONE = '{"claims":[{"claim_id":"c1","text":"Fasting aids memory","claim_type":["causal"],"supporting_paper_dois":["10.1/a","10.1/b"]}]}';

describe('createClaimStreamParser', () => {
  it('emits open, fields, then close for a single claim fed in one push', () => {
    const { events, parser } = recorder();
    parser.push(ONE);
    parser.end();

    expect(events[0]).toEqual({ t: 'open', i: 0, id: 'c1' });
    const fields = events.filter((e) => e.t === 'field' && e.i === 0);
    expect(fields.map((f) => f.key)).toEqual(['claim_id', 'text', 'claim_type', 'supporting_paper_dois']);
    expect(fields.find((f) => f.key === 'claim_type').value).toEqual(['causal']);
    expect(fields.find((f) => f.key === 'supporting_paper_dois').value).toEqual(['10.1/a', '10.1/b']);

    const close = events.find((e) => e.t === 'close');
    expect(close.i).toBe(0);
    expect(close.claim).toEqual({
      claim_id: 'c1',
      text: 'Fasting aids memory',
      claim_type: ['causal'],
      supporting_paper_dois: ['10.1/a', '10.1/b'],
    });
  });

  it('survives deltas that split tokens mid-key and mid-value', () => {
    const { events, parser } = recorder();
    // Deliberately ugly chunk boundaries: inside a key, inside a string value, inside an array.
    const chunks = ['{"cla', 'ims":[{"claim_', 'id":"c', '1","te', 'xt":"Hel', 'lo","claim_type":["des', 'criptive"]}]}'];
    for (const c of chunks) parser.push(c);
    parser.end();

    expect(events.find((e) => e.t === 'open')).toEqual({ t: 'open', i: 0, id: 'c1' });
    const close = events.find((e) => e.t === 'close');
    expect(close.claim).toEqual({ claim_id: 'c1', text: 'Hello', claim_type: ['descriptive'] });
  });

  it('handles multiple claims with correct indices, incrementally', () => {
    const { events, parser } = recorder();
    // Push only through the first claim's closing brace: claim 0 must already be closed.
    parser.push('{"claims":[{"claim_id":"c1","text":"A"}');
    expect(events.filter((e) => e.t === 'close').map((e) => e.i)).toEqual([0]);
    expect(events.find((e) => e.t === 'open' && e.i === 1)).toBeUndefined();

    // Now the second claim arrives.
    parser.push(',{"claim_id":"c2","text":"B"}]}');
    parser.end();
    expect(events.filter((e) => e.t === 'open').map((e) => e.id)).toEqual(['c1', 'c2']);
    expect(events.filter((e) => e.t === 'close').map((e) => e.i)).toEqual([0, 1]);
  });

  it('opens a claim only once, even when claim_id is not the first field', () => {
    const { events, parser } = recorder();
    parser.push('{"claims":[{"text":"first","claim_id":"late","claim_type":["x"]}]}');
    parser.end();
    const opens = events.filter((e) => e.t === 'open');
    expect(opens).toHaveLength(1);
    expect(opens[0].id).toBe('late');
    // open fires when claim_id arrives - after the text field event.
    const order = events
      .filter((e) => e.i === 0 && e.t !== 'close')
      .map((e) => (e.t === 'field' ? `field:${e.key}` : e.t));
    expect(order).toEqual(['field:text', 'open', 'field:claim_id', 'field:claim_type']);
  });

  it('parses escaped strings and literal values (null, number, boolean)', () => {
    const { events, parser } = recorder();
    parser.push('{"claims":[{"claim_id":"c1","text":"a \\"quote\\" and \\u0041","confidence":null,"n":12,"ok":true}]}');
    parser.end();
    const close = events.find((e) => e.t === 'close');
    expect(close.claim.text).toBe('a "quote" and A');
    expect(close.claim.confidence).toBeNull();
    expect(close.claim.n).toBe(12);
    expect(close.claim.ok).toBe(true);
  });

  it('exposes the fully parsed result via getResult after end', () => {
    const { parser } = recorder();
    parser.push(ONE);
    parser.end();
    expect(parser.getResult()).toEqual({
      claims: [
        {
          claim_id: 'c1',
          text: 'Fasting aids memory',
          claim_type: ['causal'],
          supporting_paper_dois: ['10.1/a', '10.1/b'],
        },
      ],
    });
  });

  it('ignores prose around the JSON object (leading/trailing noise)', () => {
    const { events, parser } = recorder();
    parser.push('Here are the claims:\n{"claims":[{"claim_id":"c1","text":"A"}]}\nDone.');
    parser.end();
    expect(events.find((e) => e.t === 'open').id).toBe('c1');
    expect(events.find((e) => e.t === 'close').claim).toEqual({ claim_id: 'c1', text: 'A' });
  });

  it('handles nested objects inside a claim without emitting them as claims', () => {
    const { events, parser } = recorder();
    parser.push('{"claims":[{"claim_id":"c1","meta":{"k":"v"},"text":"A"}]}');
    parser.end();
    expect(events.filter((e) => e.t === 'open')).toHaveLength(1); // only the claim, not meta
    const close = events.find((e) => e.t === 'close');
    expect(close.claim).toEqual({ claim_id: 'c1', meta: { k: 'v' }, text: 'A' });
  });
});
