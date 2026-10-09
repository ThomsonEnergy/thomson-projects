// Builds an RFC 2822 message for Gmail's users.messages.send. With bodyHtml it is
// multipart/alternative (plain text + HTML, so clients that can't or won't render HTML
// still get a readable version); with attachments the whole thing is wrapped in
// multipart/mixed, one part per file.
//
//   buildRfc822(...)       the message as a string (Gmail's upload endpoint takes this)
//   buildMimeMessage(...)  the same, base64url-encoded: the { raw } shape the JSON
//                          endpoint wants (used when there are no attachments)

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

// Header-safe filename: a plain ASCII fallback plus the real UTF-8 name (RFC 2231).
function fileNameParams(name) {
  const ascii = String(name || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const params = `filename="${ascii}"`;
  return /^[\x20-\x7e]*$/.test(name) ? params : `${params}; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const newBoundary = () => `te_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

// attachments: [{ filename, mime, content: Buffer }]
function buildRfc822({ fromName, fromAddress, to, cc, subject, bodyText, bodyHtml, inReplyTo, references, attachments }) {
  const headers = [
    `From: ${encodeHeaderWord(fromName)} <${fromAddress}>`,
    `To: ${(Array.isArray(to) ? to : [to]).join(', ')}`,
  ];
  if (cc && cc.length) headers.push(`Cc: ${(Array.isArray(cc) ? cc : [cc]).join(', ')}`);
  headers.push(`Subject: ${encodeHeaderWord(subject || '')}`);
  headers.push('MIME-Version: 1.0');
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  // The readable part as { headerLine, lines } so it can sit at the top level or inside multipart/mixed.
  const readable = () => {
    if (bodyHtml) {
      const b = newBoundary();
      return {
        headerLine: `Content-Type: multipart/alternative; boundary="${b}"`,
        lines: [
          `--${b}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Body(bodyText),
          `--${b}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Body(bodyHtml),
          `--${b}--`,
        ],
      };
    }
    return { headerLine: 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64', lines: [base64Body(bodyText)] };
  };

  const body = readable();

  if (attachments && attachments.length) {
    const mixed = newBoundary();
    const out = [`--${mixed}`, body.headerLine, '', ...body.lines];
    for (const a of attachments) {
      out.push(
        `--${mixed}`,
        `Content-Type: ${a.mime || 'application/octet-stream'}; name="${String(a.filename).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_')}"`,
        `Content-Disposition: attachment; ${fileNameParams(a.filename)}`,
        'Content-Transfer-Encoding: base64',
        '',
        a.content.toString('base64').replace(/.{76}/g, '$&\r\n'),
      );
    }
    out.push(`--${mixed}--`, '');
    headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
    return [headers.join('\r\n'), '', ...out].join('\r\n');
  }

  headers.push(body.headerLine);
  return [headers.join('\r\n'), '', ...body.lines, ''].join('\r\n');
}

function buildMimeMessage(opts) {
  return Buffer.from(buildRfc822(opts), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

module.exports = { buildMimeMessage, buildRfc822 };
