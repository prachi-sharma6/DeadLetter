import type { EmailMessage } from './mailer';

// Plain-text emails: they render everywhere, are hard to get wrong, and contain nothing but the link.

export const verifyEmailMessage = (to: string, name: string, link: string): EmailMessage => ({
  to,
  subject: 'Verify your DeadLetter email',
  text: `Hi ${name},\n\nConfirm your email address to finish setting up DeadLetter:\n\n${link}\n\nThis link expires in 24 hours. If you did not sign up, ignore this email.\n`,
});

export const resetPasswordMessage = (to: string, link: string): EmailMessage => ({
  to,
  subject: 'Reset your DeadLetter password',
  text: `Someone asked to reset the password for this DeadLetter account.\n\nChoose a new password here:\n\n${link}\n\nThis link expires in 1 hour and works once. If it was not you, ignore this email; your password is unchanged.\n`,
});

export const inviteMessage = (to: string, orgName: string, inviterName: string, link: string): EmailMessage => ({
  to,
  subject: `${inviterName} invited you to ${orgName} on DeadLetter`,
  text: `${inviterName} invited you to join "${orgName}" on DeadLetter.\n\nAccept the invitation:\n\n${link}\n\nThis invitation expires in 7 days.\n`,
});
