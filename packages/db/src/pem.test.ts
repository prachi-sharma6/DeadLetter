import { describe, expect, it } from 'vitest';
import { normalizePem } from './index';

describe('normalizePem', () => {
  it('turns literal \n sequences from single-line env fields into newlines', () => {
    expect(normalizePem('-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----')).toBe(
      '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----',
    );
  });

  it('leaves a real multi-line PEM unchanged', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----';
    expect(normalizePem(pem)).toBe(pem);
  });
});
