import { Hero } from '@/components/hero';
import { AboutSnippet } from '@/components/about-snippet';
import { FeaturedWork } from '@/components/featured-work';
import { BuildingTeaser } from '@/components/building-teaser';
import { Snapshot } from '@/components/snapshot';
import { CtaSection } from '@/components/cta-section';

export default function Home() {
  return (
    <>
      <Hero />
      <AboutSnippet />
      <FeaturedWork />
      <BuildingTeaser />
      <Snapshot />
      <CtaSection />
    </>
  );
}
