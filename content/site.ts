export const site = {
  name: 'Arthur Buikis',
  email: 'arthur@buikis.com',
  url: 'https://arthur.buikis.com',
  brand: 'ab.',
  description: 'Senior full-stack engineer. Ships systems that hold up.',
  formspreeEndpoint: 'https://formspree.io/f/xaqadvlz',
  // Newsletter provider form-submit URL. Anything that accepts a POST
  // with form-encoded `email` works — components/subscribe-form.tsx is
  // service-agnostic. Recommended: Buttondown (free <100 subs, no
  // branding, one-click unsubscribe baked in). Drop in one of:
  //   Buttondown:   https://buttondown.email/api/emails/embed-subscribe/<username>
  //   Formspree:    https://formspree.io/f/<form-id>
  //   ConvertKit:   https://app.convertkit.com/forms/<form-id>/subscriptions
  //   MailerLite:   https://assets.mailerlite.com/jsonp/<account>/forms/<id>/subscribe
  // Leave empty to render a "coming soon" CTA instead of a live form.
  // After updating: `node scripts/test-live-subscribe.mjs` against prod
  // confirms a real round-trip.
  subscribeEndpoint: '',
  nav: [
    { label: 'Work', href: '/#work' },
    { label: 'Notes', href: '/notes' },
    { label: 'Building', href: '/building' },
    { label: 'About', href: '/about' },
    { label: 'CV', href: '/cv' },
    { label: 'Contact', href: '/contact' },
  ],
  socials: [
    { label: 'GitHub', href: 'https://github.com/Artufe' },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/arthur-buikis-002145151/' },
  ],
  bio: {
    jobTitle: 'Senior software engineer',
    location: { city: 'Riga', country: 'LV', timezone: 'Europe/Riga' },
    summary:
      'Backend and platform engineer based in Riga. Around twelve years in Python with Rust (PyO3) for hot paths. Currently working on a media-processing platform.',
    knowsAbout: [
      'Python',
      'Rust',
      'PyO3',
      'Celery',
      'Kubernetes',
      'Postgres',
      'Backend engineering',
      'Platform engineering',
      'Performance engineering',
      'Data infrastructure',
      'Web scraping',
      'Machine learning systems',
    ],
  },
};
