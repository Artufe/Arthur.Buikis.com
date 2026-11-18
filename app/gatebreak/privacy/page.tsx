import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { site } from '@/content/site';

const title = 'Gatebreak privacy policy';
const description =
  'What the mobile game Gatebreak stores on your device, and what Google AdMob and the app stores collect when it shows ads or takes a purchase.';
const path = '/gatebreak/privacy/';
const updated = '18 November 2026';

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: path },
};

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="mt-12 border-t border-[var(--border)] pt-8">
      <h2 className="font-display text-2xl tracking-tight">{heading}</h2>
      <div className="mt-4 space-y-4 text-[var(--muted)] leading-relaxed">{children}</div>
    </section>
  );
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} rel="noopener noreferrer" className="text-[var(--fg)] underline">
      {children}
    </a>
  );
}

export default function GatebreakPrivacyPage() {
  const mail = <Ext href={`mailto:${site.email}`}>{site.email}</Ext>;
  return (
    <div className="mx-auto max-w-[720px] px-6 py-16 lg:py-24">
      <p className="lbl">Gatebreak</p>
      <h1 className="mt-4 font-display text-[clamp(36px,5vw,56px)] leading-[1.02] tracking-tight">
        Privacy policy
      </h1>
      <p className="mt-4 text-[var(--muted)]">Last updated: {updated}</p>

      <div className="mt-8 space-y-4 text-[var(--muted)] leading-relaxed">
        <p>
          Gatebreak is a mobile game for Android and iOS made by {site.name}, an individual developer
          based in Riga, Latvia. This policy explains what data the game handles.
        </p>
        <p>
          <strong className="text-[var(--fg)]">In short:</strong> the game has no accounts and I run
          no servers for it, so I do not collect, receive or store any personal data. The game shows
          ads through Google AdMob and offers one purchase through your app store. Those services
          collect some data themselves, as described below.
        </p>
      </div>

      <Section heading="Data stored on your device">
        <p>
          Your progress, settings and whether you have removed ads are saved on your device only.
          They are never sent to me. Uninstalling the game deletes them. If device backup is turned
          on, your phone&apos;s backup service may copy this save to your own Google or Apple
          account.
        </p>
      </Section>

      <Section heading="Advertising">
        <p>
          The game shows ads using Google AdMob. To deliver ads, limit how often you see them,
          measure them and prevent fraud, Google collects data directly from your device. This can
          include:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>your device&apos;s advertising ID and other device identifiers;</li>
          <li>your IP address, which shows your approximate location;</li>
          <li>device and app information, such as model, operating system and language;</li>
          <li>how you interact with ads, and diagnostic data.</li>
        </ul>
        <p>
          Google is responsible for this data. See{' '}
          <Ext href="https://policies.google.com/technologies/partner-sites">
            how Google uses information from apps that use its services
          </Ext>{' '}
          and the <Ext href="https://policies.google.com/privacy">Google Privacy Policy</Ext>.
        </p>
        <p>
          <strong className="text-[var(--fg)]">Your choices.</strong> Where the law requires it
          (including the EEA, the UK and Switzerland), the game asks for your consent before any ad
          is requested, and you can change your answer at any time under Ad privacy in the
          game&apos;s settings. On iOS the game asks for permission to track; if you decline, ads
          are not personalised. You can also reset or delete your advertising ID in your
          device&apos;s settings. Buying Remove ads turns the advertising software off entirely.
        </p>
      </Section>

      <Section heading="Purchases">
        <p>
          The game offers one optional purchase, Remove ads. Payment is handled by Google Play or the
          Apple App Store under their own privacy policies. I never see your payment details. The
          game only asks the store on your device whether the purchase is owned.
        </p>
      </Section>

      <Section heading="Children">
        <p>
          Gatebreak is not directed at children under 13, and I do not knowingly collect personal
          data from children. Ads are requested with a general-audience content rating.
        </p>
      </Section>

      <Section heading="Your rights">
        <p>
          Because I hold no personal data about you, there is nothing I can provide, correct or
          delete. For data collected by Google or Apple, use the controls and contacts in their
          privacy policies. If you are in the EU, you also have the right to complain to your local
          data protection authority.
        </p>
      </Section>

      <Section heading="Changes to this policy">
        <p>
          If the game starts handling data differently, I will update this page and the date at the
          top.
        </p>
      </Section>

      <Section heading="Contact">
        <p>Questions about this policy: {mail}.</p>
      </Section>
    </div>
  );
}
