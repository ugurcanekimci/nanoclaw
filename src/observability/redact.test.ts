import { describe, it, expect } from 'vitest';
import { redactString, redactMetadata } from './redact.js';

describe('redactString', () => {
  it('redacts AWS access key IDs', () => {
    expect(redactString('key is AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]');
    expect(redactString('key is AKIAIOSFODNN7EXAMPLE')).not.toContain(
      'AKIAIOSFODNN7EXAMPLE',
    );
  });

  it('redacts GitHub tokens', () => {
    expect(
      redactString('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'),
    ).toContain('[REDACTED]');
    expect(
      redactString('ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl'),
    ).toContain('[REDACTED]');
  });

  it('redacts Slack tokens', () => {
    expect(redactString('xoxb-123456789-abcdef')).toContain('[REDACTED]');
  });

  it('redacts Anthropic API keys', () => {
    expect(
      redactString('sk-ant-api03-ABCDEFGHIJKLMNOPQRST'),
    ).toContain('[REDACTED]');
  });

  it('redacts OpenAI API keys', () => {
    expect(
      redactString('sk-ABCDEFGHIJKLMNOPQRSTuvwx'),
    ).toContain('[REDACTED]');
  });

  it('redacts xAI API keys', () => {
    expect(
      redactString('xai-ABCDEFGHIJKLMNOPQRSTuvwx'),
    ).toContain('[REDACTED]');
  });

  it('redacts private key headers', () => {
    expect(redactString('-----BEGIN RSA PRIVATE KEY-----')).toContain(
      '[REDACTED]',
    );
    expect(redactString('-----BEGIN PRIVATE KEY-----')).toContain(
      '[REDACTED]',
    );
  });

  it('redacts OAuth tokens (Google ya29)', () => {
    expect(redactString('ya29.a0AfH6SMB-example_token')).toContain(
      '[REDACTED]',
    );
  });

  it('redacts connection strings', () => {
    expect(
      redactString('postgres://user:pass@host:5432/db'),
    ).toContain('[REDACTED]');
    expect(
      redactString('mongodb://admin:secret@cluster.example.com/mydb'),
    ).toContain('[REDACTED]');
  });

  it('redacts 1Password references', () => {
    expect(redactString('op://Swarm/Anthropic/api-key')).toContain(
      '[REDACTED]',
    );
  });

  it('redacts generic API key patterns', () => {
    expect(
      redactString('api_key = "sk_live_ABCDEFGHIJKLMNOPQRSTuvwx"'),
    ).toContain('[REDACTED]');
  });

  it('replaces home directory with ~', () => {
    const home = process.env.HOME || '/Users/unknown';
    expect(redactString(`path is ${home}/Documents/secret`)).toBe(
      'path is ~/Documents/secret',
    );
  });

  it('leaves clean strings unchanged', () => {
    expect(redactString('hello world')).toBe('hello world');
    expect(redactString('/workspace/group/data.json')).toBe(
      '/workspace/group/data.json',
    );
  });
});

describe('redactMetadata', () => {
  it('redacts string values in flat objects', () => {
    const result = redactMetadata({
      key: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRST',
      count: 42,
    });
    expect(result.key).toContain('[REDACTED]');
    expect(result.count).toBe(42);
  });

  it('deep-walks nested objects', () => {
    const result = redactMetadata({
      outer: {
        inner: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
      },
    });
    expect(
      (result.outer as Record<string, unknown>).inner,
    ).toContain('[REDACTED]');
  });

  it('redacts strings in arrays', () => {
    const result = redactMetadata({
      tokens: ['clean', 'xoxb-123-abc', 'also-clean'],
    });
    const arr = result.tokens as string[];
    expect(arr[0]).toBe('clean');
    expect(arr[1]).toContain('[REDACTED]');
    expect(arr[2]).toBe('also-clean');
  });

  it('handles nested objects in arrays', () => {
    const result = redactMetadata({
      items: [{ secret: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRST' }],
    });
    const items = result.items as Array<Record<string, unknown>>;
    expect(items[0]!.secret).toContain('[REDACTED]');
  });

  it('preserves non-string/non-object values', () => {
    const result = redactMetadata({
      num: 123,
      bool: true,
      nil: null,
    });
    expect(result.num).toBe(123);
    expect(result.bool).toBe(true);
    expect(result.nil).toBeNull();
  });

  it('does not mutate the original object', () => {
    const original = { key: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRST' };
    const result = redactMetadata(original);
    expect(original.key).toBe('sk-ant-api03-ABCDEFGHIJKLMNOPQRST');
    expect(result.key).toContain('[REDACTED]');
  });
});
