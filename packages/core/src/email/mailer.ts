export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** `false` when no provider is configured: callers must tell the user instead of pretending an email was sent. */
  readonly configured: boolean;
  send(message: EmailMessage): Promise<void>;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super('Email delivery is not configured on this server');
    this.name = 'EmailNotConfiguredError';
  }
}

/** Sends through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendMailer implements Mailer {
  readonly configured = true;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(m: EmailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      // The response body may echo the address; keep only the status in the error.
      throw new Error(`email provider responded ${res.status}`);
    }
  }
}

/** Keeps messages in memory. Used by tests, and in development where emails are printed to the log instead. */
export class MemoryMailer implements Mailer {
  readonly configured = true;
  readonly sent: EmailMessage[] = [];
  constructor(private readonly onSend?: (m: EmailMessage) => void) {}
  send(m: EmailMessage): Promise<void> {
    this.sent.push(m);
    this.onSend?.(m);
    return Promise.resolve();
  }
  /** The first https/http link in the most recent email to `to` (tests use it to follow verification links). */
  lastLinkTo(to: string): string | undefined {
    const msg = [...this.sent].reverse().find((m) => m.to === to);
    return msg?.text.match(/https?:\/\/\S+/)?.[0];
  }
}

export class DisabledMailer implements Mailer {
  readonly configured = false;
  send(): Promise<void> {
    return Promise.reject(new EmailNotConfiguredError());
  }
}
