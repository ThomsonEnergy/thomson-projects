// Builds an RFC 2822 message and base64url-encodes it, the shape Gmail's
// users.messages.send endpoint wants ({ raw: <that> }). With bodyHtml it
// sends multipart/alternative (plain text + HTML, so clients that can't or
// won't render HTML still get a readable version); without, plain text.

function encodeHeaderWord(text) {
  // Only the display name portion of From ever needs this - subjects with
  // non-ASCII are rare for this app's use (client names/subjects are
  // almost always plain English) but this keeps a stray apostrophe-heavy
  // name from producing a malformed header.
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf-8').toString('base64')}?=`;
}

// RFC 2045 wants base64 body lines wrapped at 76 chars - Gmail's own
// parser is lenient, but other clients aren't guaranteed to be.
function base64Body(text) {
  return Buffer.from(text || '', 'utf-8').toString('base64').replace(/.{76}/g, '$&\r\n');
}

function buildMimeMessage({ fromName, fromAddress, to, cc, subject, bodyText, bodyHtml, inReplyTo, references }) {
  const headers = [
    `From: ${encodeHeaderWord(fromName)} <${fromAddress}>`,
    `To: ${(Array.isArray(to) ? to : [to]).join(', ')}`,
  ];
  if (cc && cc.length) headers.push(`Cc: ${(Array.isArray(cc) ? cc : [cc]).join(', ')}`);
  headers.push(`Subject: ${encodeHeaderWord(subject || '')}`);
  headers.push('MIME-Version: 1.0');
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  let message;
  if (bodyHtml) {
    const boundary = `te_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    message = [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(bodyText),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(bodyHtml),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: base64'); // safe for any UTF-8 body, not just ASCII
    message = `${headers.join('\r\n')}\r\n\r\n${base64Body(bodyText)}`;
  }

  return Buffer.from(message, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

module.exports = { buildMimeMessage };
