import { Hero } from '@/components/hero';
import { AboutSnippet } from '@/components/about-snippet';
import { FeaturedWork } from '@/components/featured-work';
import { BuildingTeaser } from '@/components/building-teaser';

export default function Home() {
  return (
    <>
      <Hero />
      <AboutSnippet />
      <FeaturedWork />
      <BuildingTeaser />
    </>
  );
}
