// The app's addresses.
//
// publicBaseUrl(): what a client may see (emails, PDF links, review links, the Gmail connection). It is
//   Netlify's primary domain, projects.thomsonenergy.com.au.
// selfBaseUrl(): where a function calls the app itself (renders a quote or invoice page into a PDF, starts a
//   background job). It prefers this deploy's own thomsonprojects.netlify.app address, so those jobs keep
//   working even if the custom domain's DNS ever stops working. The pages it loads still hand out the
//   projects.thomsonenergy.com.au address in their links.
const PUBLIC_FALLBACK = 'https://projects.thomsonenergy.com.au';

function clean(u) { return String(u || '').replace(/\/+$/, ''); }

function publicBaseUrl() {
  return clean(process.env.URL) || PUBLIC_FALLBACK;
}

function selfBaseUrl() {
  return clean(process.env.DEPLOY_URL) || clean(process.env.URL) || PUBLIC_FALLBACK;
}

module.exports = { publicBaseUrl, selfBaseUrl, PUBLIC_FALLBACK };
